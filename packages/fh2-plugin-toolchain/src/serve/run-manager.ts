// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import type { Dirent } from 'node:fs'
import { basename, resolve } from 'node:path'
import { tryDiscoverCommandContext } from '../capability/discovery.js'
import type { TaskEvent, WorkspaceKind } from '../contracts/index.js'
import { supportsWorkspaceOperation } from '../contracts/index.js'
import type { IdeRunEvent, IdeRunLogEvent, IdeRunLogsData, IdeRunMode, IdeRunStartData, IdeRunStatus, IdeRunStatusData, IdeRunStopData, IdeRunTarget, IdeRunTargetsData } from '../contracts/ide.js'
import { IdeRequestError } from '../contracts/ide.js'
import { resolvePreviewTarget } from '../services/application/preview.js'
import type { IdeTaskBridge } from './task-bridge.js'
import { inspectPort, sameProcesses, stopPortProcesses } from './port-processes.js'
import type { PortProcess } from './port-processes.js'

export interface IdeRunManagerOptions {
  readonly resolveRoot: () => string;
  readonly tasks: IdeTaskBridge;
  readonly onEvent: (event: IdeRunEvent) => void;
  readonly onLog: (event: IdeRunLogEvent) => void;
}
interface RunningTask {
  mode: IdeRunMode;
  taskId: string;
  status: IdeRunStatus;
  since: number;
  url?: string;
  projectPath: string;
  detail?: string;
}

interface ResolvedRunTarget extends IdeRunTarget {
  readonly absolutePath: string;
}

const RUN_LOG_LIMIT = 500

/** 兼容 IDE run 接口的薄适配：所有生命周期由公共 TaskService 持有。 */
export class IdeRunManager {
  private readonly processes = new Map<IdeRunMode, RunningTask>()
  private readonly starting = new Set<IdeRunMode>()
  private readonly logTail: IdeRunLogEvent[] = []
  private logSequence = 0
  private portConfirmation: { token: string; port: number; root: string; target: string; processes: readonly PortProcess[] } | undefined
  constructor (private readonly options: IdeRunManagerOptions) {
    options.tasks.subscribe(event => this.onTask(event))
  }

  async start (body: Record<string, unknown>): Promise<IdeRunStartData> {
    const mode = parseMode(body.mode)
    const existing = this.processes.get(mode)
    if (this.starting.has(mode) || (existing && existing.status !== 'stopped' && existing.status !== 'failed')) {
      throw new IdeRequestError('FH2_IDE_PROCESS_RUNNING', `${mode} 已在运行，请先停止。`)
    }
    const target = this.resolveTarget(mode, body.projectPath)
    const port = parsePort(body.port) || (mode === 'dev' ? 5175 : 4317)
    const params = { port, ...(mode === 'preview' ? { target: previewTarget(body.target) } : {}) }
    this.starting.add(mode)
    try {
      if (mode === 'dev') {
        let inspection = await inspectPort(port)
        if (inspection.occupied) {
          const confirmed = this.portConfirmation
          this.portConfirmation = undefined
          if (confirmed && body.portConfirmation === confirmed.token && confirmed.port === port && confirmed.root === this.options.resolveRoot() && confirmed.target === target.absolutePath && sameProcesses(confirmed.processes, inspection.processes)) {
            await stopPortProcesses(port, confirmed.processes)
            inspection = await inspectPort(port)
          }
          if (inspection.occupied) {
            const stoppable = inspection.processes.length > 0 && inspection.processes.every(item => item.pid !== process.pid && item.pid !== process.ppid)
            const token = stoppable ? randomUUID() : undefined
            if (token) this.portConfirmation = { token, port, root: this.options.resolveRoot(), target: target.absolutePath, processes: inspection.processes }
            const message = `端口 ${port} 被占用${stoppable ? '，是否停止占用进程后启动 dev？' : '，无法自动停止，请手动释放端口后重试。'}`
            this.log(mode, 'stderr', message)
            return { mode, status: 'failed', projectPath: target.projectPath, portConflict: { port, processes: inspection.processes.map(({ pid, command }) => ({ pid, command })), ...(token ? { confirmationToken: token } : {}), message } }
          }
        }
        this.portConfirmation = undefined
      }
      const task = await this.options.tasks.start(target.absolutePath, mode, params)
      const running: RunningTask = { mode, taskId: task.taskId, status: 'starting', since: task.createdAt, projectPath: target.projectPath }
      this.processes.set(mode, running)
      this.log(mode, 'stdout', `启动目标：${target.projectPath}（${target.kind}）`)
      this.emit(running)
      const current = this.options.tasks.get(task.taskId)
      if (current.state === 'failed' || current.state === 'cancelled') {
        running.status = current.state === 'failed' ? 'failed' : 'stopped'
        this.emit(running)
      }
      return { mode, status: 'starting', projectPath: target.projectPath }
    } finally {
      this.starting.delete(mode)
    }
  }

  async stop (body: Record<string, unknown>): Promise<IdeRunStopData> {
    const mode = parseMode(body.mode)
    const running = this.processes.get(mode)
    if (running) {
      const task = this.options.tasks.get(running.taskId)
      if (task.state === 'queued' || task.state === 'running') await this.options.tasks.cancel(running.taskId)
      this.processes.delete(mode)
    }
    return { mode, status: 'stopped' }
  }

  status (): IdeRunStatusData {
    return { processes: [...this.processes.values()].map(({ taskId: _taskId, ...value }) => value) }
  }

  targets (): IdeRunTargetsData {
    return { targets: this.discoverTargets().map(({ absolutePath: _absolutePath, ...target }) => target) }
  }

  logs (mode?: IdeRunMode): IdeRunLogsData {
    return { lines: this.logTail.filter(line => mode === undefined || line.mode === mode) }
  }

  async stopAll (): Promise<void> {
    this.portConfirmation = undefined
    await Promise.all([...this.processes.keys()].map(mode => this.stop({ mode })))
  }

  private onTask (event: TaskEvent): void {
    const running = [...this.processes.values()].find(task => task.taskId === event.taskId)
    if (!running) return
    if (event.type === 'log') this.log(running.mode, event.stream, event.line)
    if (event.type === 'diagnostic') {
      running.detail = event.diagnostic.message
      this.log(running.mode, event.diagnostic.severity === 'error' ? 'stderr' : 'stdout', `${event.diagnostic.code}：${event.diagnostic.message}`)
    }
    if (event.type === 'url') {
      running.url = event.url
      running.status = 'running'
      this.emit(running)
    }
    if (event.type === 'state' && ['succeeded', 'failed', 'cancelled'].includes(event.state)) {
      running.status = event.state === 'failed' ? 'failed' : 'stopped'
      this.emit(running)
    }
  }

  private emit (task: RunningTask): void {
    this.options.onEvent({
      schemaVersion: 1,
      mode: task.mode,
      status: task.status,
      projectPath: task.projectPath,
      ...(task.url ? { url: task.url } : {}),
      ...(task.detail ? { detail: task.detail } : {}),
    })
  }

  private log (mode: IdeRunMode, stream: 'stdout' | 'stderr', line: string): void {
    this.logSequence += 1
    const event: IdeRunLogEvent = { schemaVersion: 1, mode, stream, line, sequence: this.logSequence }
    this.logTail.push(event)
    if (this.logTail.length > RUN_LOG_LIMIT) this.logTail.splice(0, this.logTail.length - RUN_LOG_LIMIT)
    this.options.onLog(event)
  }

  private resolveTarget (mode: IdeRunMode, rawProjectPath: unknown): ResolvedRunTarget {
    const targets = this.discoverTargets().filter(target => target.modes.includes(mode))
    if (typeof rawProjectPath === 'string' && rawProjectPath !== '') {
      const target = targets.find(candidate => candidate.projectPath === rawProjectPath)
      if (target !== undefined) return target
      throw new IdeRequestError('FH2_IDE_BAD_REQUEST', `运行目标不可用或不支持 ${mode}：${rawProjectPath}。`)
    }
    if (targets.length === 1) return targets[0]!
    if (targets.length === 0) throw new IdeRequestError('FH2_IDE_BAD_REQUEST', `当前工作区没有支持 ${mode} 的 Capability 或前端插件。`)
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', `当前工作区有多个 ${mode} 目标，请先选择具体项目。`)
  }

  private discoverTargets (): ResolvedRunTarget[] {
    const root = resolve(this.options.resolveRoot())
    const direct = runTarget(root, '.', basename(root))
    if (direct !== null && direct.modes.length > 0) return [direct]
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(root, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return []
    }
    const targets: ResolvedRunTarget[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const target = runTarget(resolve(root, entry.name), entry.name, entry.name)
      if (target !== null && target.modes.length > 0) targets.push(target)
    }
    return targets.sort((left, right) => left.projectPath.localeCompare(right.projectPath))
  }
}

function runTarget (absolutePath: string, projectPath: string, label: string): ResolvedRunTarget | null {
  let kind: WorkspaceKind
  try {
    const context = tryDiscoverCommandContext(absolutePath)
    if (context === undefined) return null
    kind = context.kind
  } catch {
    return null
  }
  const modes = (['dev', 'preview'] as const).filter(mode => supportsWorkspaceOperation(kind, mode))
  return { absolutePath, projectPath, label, kind, modes }
}

function previewTarget (rawTarget: unknown): string {
  if (typeof rawTarget !== 'string' || rawTarget.trim() === '') {
    throw new IdeRequestError(
      'FH2_IDE_BAD_REQUEST',
      'preview 需要 target（司空项目页完整 HTTP URL）。',
    )
  }
  try {
    return resolvePreviewTarget(rawTarget).href
  } catch (error) {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', error instanceof Error ? error.message : String(error))
  }
}

function parseMode (raw: unknown): IdeRunMode {
  if (raw === 'dev' || raw === 'preview') return raw
  throw new IdeRequestError('FH2_IDE_BAD_REQUEST', 'mode 必须是 "dev" 或 "preview"。"mode" must be "dev" or "preview".')
}

function parsePort (raw: unknown): number {
  if (raw === undefined || raw === null) return 0
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 65_535) {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', 'port 必须是 0..65535 的整数。"port" must be an integer in 0..65535.')
  }
  return raw
}
