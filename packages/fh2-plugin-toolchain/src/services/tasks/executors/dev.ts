// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { tryDiscoverCommandContext } from '../../../capability/discovery.js'
import type { TaskExecutor } from '../task-service.js'
import { TaskCancelledError } from '../task-service.js'
import { ensureDependenciesInstalled } from './dependencies.js'

export interface DevExecutorOptions {
  readonly workerEntry?: string;
  readonly killGraceMs?: number;
}

export function resolveRunWorker (): string {
  const directory = dirname(fileURLToPath(import.meta.url))
  const candidates = ['tasks/run-worker.js', '../tasks/run-worker.js', '../../../../dist/tasks/run-worker.js']
    .map(path => resolve(directory, path))
  const entry = candidates.find(path => existsSync(path))
  if (!entry) throw new Error('内部运行 worker 缺失，请重新构建 Toolchain。')
  return entry
}

/** Dev/Preview 共用内部 worker；控制消息不从日志推断。 */
export function createRunExecutor (kind: 'dev' | 'preview', options: DevExecutorOptions = {}): TaskExecutor {
  return {
    async start (context) {
      const project = tryDiscoverCommandContext(context.root)
      if (!project || project.kind === 'industry-capability-workspace') throw new Error('请打开具体 Capability 或插件目录运行。')
      if (context.signal.aborted) throw new TaskCancelledError()
      // 前置依赖保障：缺 node_modules 时先自动 install（日志流入任务/运行面板）
      await ensureDependenciesInstalled(context.root, {
        emitLog: (stream, line) => context.emitLog(stream, line),
        signal: context.signal,
      })
      if (context.signal.aborted) throw new TaskCancelledError()
      const child = fork(options.workerEntry ?? resolveRunWorker(), [], {
        cwd: context.root,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        detached: process.platform !== 'win32',
      })
      const readers = (['stdout', 'stderr'] as const).map((stream) => {
        let pending = ''
        const emit = (line: string): void => {
          if (line) context.emitLog(stream, line.slice(0, 4096))
        }
        child[stream]?.setEncoding('utf8').on('data', (chunk: string) => {
          pending += chunk
          let end = pending.indexOf('\n')
          while (end >= 0) {
            emit(pending.slice(0, end).replace(/\r$/, ''))
            pending = pending.slice(end + 1)
            end = pending.indexOf('\n')
          }
        })
        return () => emit(pending)
      })
      child.on('message', (message: unknown) => {
        if (message && typeof message === 'object' && 'type' in message && message.type === 'ready'
          && 'url' in message && typeof message.url === 'string') {
          context.emitUrl(message.url)
        }
      })
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const kill = (signal: NodeJS.Signals): void => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal)
          else child.kill(signal)
        } catch { /* 已退出 */ }
      }
      const stop = (): void => {
        if (killTimer) return
        kill('SIGTERM')
        killTimer = setTimeout(() => kill('SIGKILL'), options.killGraceMs ?? 5000)
        killTimer.unref()
      }
      context.signal.addEventListener('abort', stop, { once: true })
      try {
        let processError: Error | undefined
        let sendError: Error | undefined
        let closed = false
        const exited = new Promise<number | null>((resolveExit) => {
          // 后代可能仍持有输出管道，worker退出时先回收进程组，才能等到close。
          child.once('exit', () => kill('SIGKILL'))
          // close 在 exit/error 后且输出管道已关闭时触发，终态前收齐日志。
          child.once('close', (code) => {
            closed = true
            resolveExit(code)
          })
          child.once('error', (error) => {
            processError = error
          })
        })
        child.send({ kind, root: context.root, params: context.params }, (error) => {
          if (!error) return
          // worker 快速退出会使启动消息发送失败；由 close 报告退出事实，
          // 不让 EPIPE 抢先结束任务。仍存活的 worker 需回收，防止挂住。
          sendError = error
          if (!closed && child.exitCode === null && child.signalCode === null) stop()
        })
        if (context.signal.aborted) stop()
        const code = await exited
        if (context.signal.aborted) throw new TaskCancelledError()
        if (processError) throw processError
        if (code !== 0) throw new Error(`${kind} 进程异常退出：${code ?? '信号中断'}`)
        if (sendError) throw sendError
        throw new TaskCancelledError(`${kind} 已停止`)
      } finally {
        if (killTimer) clearTimeout(killTimer)
        // worker 先退出时仍可能留下不响应 SIGTERM 的构建子进程。
        // 结束任务前清理整个进程组，不能随 worker 的 exit 撤销回收。
        kill('SIGKILL')
        context.signal.removeEventListener('abort', stop)
        for (const flush of readers) flush()
      }
    },
  }
}

export function createDevExecutor (options: DevExecutorOptions = {}): TaskExecutor {
  return createRunExecutor('dev', options)
}
