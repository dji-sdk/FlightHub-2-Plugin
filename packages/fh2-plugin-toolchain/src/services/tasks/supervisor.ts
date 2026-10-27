// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import process from 'node:process'
import type { TaskEvent, TaskKind, TaskSnapshot } from '../../contracts/index.js'

/**
 * T4：ProcessSupervisor —— MCP server 与 worker 之间的进程管理。
 *
 * - worker 是内部执行入口（dist/tasks/service-worker.js），不 spawn 公开 CLI；
 * - 控制事件走 Node IPC；worker 的 stdout/stderr 逐行转发为宿主日志回调
 *   （绝不写入父进程 stdout，保住 stdio 协议纯净）；
 * - 取消升级：SIGTERM → 宽限 → SIGKILL；worker 退出后可再次启动（可重置宿主）；
 * - 父进程退出/关闭时 shutdown worker。
 */
export class ServiceWorkerSupervisor {
  private child: import('node:child_process').ChildProcess | null = null
  private pendingCalls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private nextCallId = 1
  private taskStartHandlers = new Map<string, { resolve: (snapshot: TaskSnapshot) => void; reject: (error: Error) => void }>()
  private taskCancelHandlers = new Map<string, { resolve: (snapshot: TaskSnapshot) => void; reject: (error: Error) => void }>()
  private taskGetHandlers = new Map<string, { resolve: (snapshot: TaskSnapshot) => void; reject: (error: Error) => void }>()
  private onTaskEvent: ((event: TaskEvent) => void) | null = null
  private onLog: ((stream: 'stdout' | 'stderr', line: string) => void) | null = null

  constructor (private readonly workerEntry: string) {}

  setTaskEventListener (listener: (event: TaskEvent) => void): void {
    this.onTaskEvent = listener
  }

  setLogListener (listener: (stream: 'stdout' | 'stderr', line: string) => void): void {
    this.onLog = listener
  }

  private ensureChild (): import('node:child_process').ChildProcess {
    if (this.child !== null && this.child.exitCode === null && !this.child.killed) return this.child
    const child = spawn(process.execPath, [this.workerEntry], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: process.env,
    })
    this.child = child
    const consume = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() !== '') this.onLog?.(stream, line)
      }
    }
    child.stdout?.on('data', chunk => consume('stdout', chunk))
    child.stderr?.on('data', chunk => consume('stderr', chunk))
    child.on('message', (raw: unknown) => this.handleMessage(raw))
    child.on('exit', () => {
      const error = new Error('worker 已退出。Worker exited.')
      for (const pending of this.pendingCalls.values()) pending.reject(error)
      this.pendingCalls.clear()
      for (const pending of this.taskStartHandlers.values()) pending.reject(error)
      this.taskStartHandlers.clear()
      for (const pending of this.taskCancelHandlers.values()) pending.reject(error)
      this.taskCancelHandlers.clear()
      for (const pending of this.taskGetHandlers.values()) pending.reject(error)
      this.taskGetHandlers.clear()
    })
    return child
  }

  private handleMessage (raw: unknown): void {
    const message = raw as Record<string, unknown>
    switch (message.type) {
      case 'call-result': {
        const callId = message.callId as number
        const pending = this.pendingCalls.get(callId)
        if (pending === undefined) return
        this.pendingCalls.delete(callId)
        if (message.ok === true) {
          pending.resolve(message.data)
        } else {
          const error = message.error as { code?: string; message?: string } | undefined
          pending.reject(Object.assign(new Error(error?.message ?? 'worker 调用失败'), { code: error?.code ?? 'FH2_MCP_INTERNAL' }))
        }
        return
      }
      case 'task-started': {
        const taskId = message.taskId as string
        const pending = this.taskStartHandlers.get(taskId)
        if (pending === undefined) return
        this.taskStartHandlers.delete(taskId)
        pending.resolve(message.snapshot as TaskSnapshot)
        return
      }
      case 'task-start-failed': {
        const taskId = message.taskId as string
        const pending = this.taskStartHandlers.get(taskId)
        if (pending === undefined) return
        this.taskStartHandlers.delete(taskId)
        const error = message.error as { code?: string; message?: string } | undefined
        pending.reject(Object.assign(new Error(error?.message ?? '任务启动失败'), { code: error?.code ?? 'FH2_TASK_IN_PROGRESS' }))
        return
      }
      case 'task-cancel-result': {
        const taskId = message.taskId as string
        const pending = this.taskCancelHandlers.get(taskId)
        if (pending === undefined) return
        this.taskCancelHandlers.delete(taskId)
        if (message.error !== undefined) {
          const error = message.error as { code?: string; message?: string }
          pending.reject(Object.assign(new Error(error.message ?? '任务取消失败'), { code: error.code ?? 'FH2_TASK_CANCEL_FAILED' }))
          return
        }
        pending.resolve(message.snapshot as TaskSnapshot)
        return
      }
      case 'task-result': {
        const taskId = message.taskId as string
        const pending = this.taskGetHandlers.get(taskId)
        if (pending === undefined) return
        this.taskGetHandlers.delete(taskId)
        if (message.error !== undefined) {
          const error = message.error as { code?: string; message?: string }
          pending.reject(Object.assign(new Error(error.message ?? '任务不存在'), { code: error.code ?? 'FH2_TASK_NOT_FOUND' }))
          return
        }
        pending.resolve(message.snapshot as TaskSnapshot)
        return
      }
      case 'task-event':
        this.onTaskEvent?.(message.event as TaskEvent)
        break
      default:
        break
    }
  }

  call (service: 'inspect' | 'validate' | 'generate' | 'create', root: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.ensureChild()
    const callId = this.nextCallId++
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(callId, { resolve, reject })
      child.send({ type: 'call', callId, service, root, params }, (error) => {
        if (error !== null) {
          this.pendingCalls.delete(callId)
          reject(error)
        }
      })
    })
  }

  taskStart (taskId: string, kind: TaskKind, root: string, params: Record<string, string | number | boolean>): Promise<TaskSnapshot> {
    const child = this.ensureChild()
    return new Promise((resolve, reject) => {
      this.taskStartHandlers.set(taskId, { resolve, reject })
      child.send({ type: 'task-start', taskId, kind, root, params }, (error) => {
        if (error !== null) {
          this.taskStartHandlers.delete(taskId)
          reject(error)
        }
      })
    })
  }

  taskGet (taskId: string): Promise<TaskSnapshot> {
    const child = this.ensureChild()
    return new Promise((resolve, reject) => {
      this.taskGetHandlers.set(taskId, { resolve, reject })
      child.send({ type: 'task-get', taskId }, (error) => {
        if (error !== null) {
          this.taskGetHandlers.delete(taskId)
          reject(error)
        }
      })
    })
  }

  taskCancel (taskId: string): Promise<TaskSnapshot> {
    const child = this.ensureChild()
    return new Promise((resolve, reject) => {
      this.taskCancelHandlers.set(taskId, { resolve, reject })
      child.send({ type: 'task-cancel', taskId }, (error) => {
        if (error !== null) {
          this.taskCancelHandlers.delete(taskId)
          reject(error)
        }
      })
    })
  }

  async shutdown (): Promise<void> {
    const child = this.child
    if (child === null || child.exitCode !== null) return
    child.send({ type: 'shutdown' })
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
        killTimer.unref()
        resolveExit()
      }, 3000)
      timer.unref()
      child.once('exit', () => {
        clearTimeout(timer)
        resolveExit()
      })
    })
    this.child = null
  }
}

/** 解析构建产物中的 worker 入口（与发布布局一致：dist/tasks/service-worker.js）。 */
export function resolveServiceWorkerEntry (): string {
  const require = createRequire(import.meta.url)
  try {
    return require.resolve('../tasks/service-worker.js')
  } catch {
    return resolve(import.meta.dirname, '../../../dist/tasks/service-worker.js')
  }
}
