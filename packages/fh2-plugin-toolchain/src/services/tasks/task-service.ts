// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ArtifactDescriptor,
  Diagnostic,
  TaskEvent,
  TaskKind,
  TaskOwner,
  TaskRequest,
  TaskService,
  TaskSnapshot,
  TaskState,
} from '../../contracts/index.js'

/**
 * T1/T2：统一 TaskService（实施计划 §3.1）。
 *
 * - TaskOwner 是进程内权限边界：get/cancel/subscribe/stopOwned 都检查 owner；
 *   跨 owner 的 get/cancel 一律 `FH2_TASK_NOT_FOUND`，不泄露任务存在性；
 * - 同 owner、同 canonical root、同 kind、同规范化参数的重复 start 返回已有 taskId；
 *   参数不同返回 `FH2_TASK_IN_PROGRESS`；不同 owner 冲突只返回忙碌错误；
 * - TaskEvent 按 taskId 单调递增 sequence，覆盖状态、日志、URL、Diagnostic、Artifact；
 *   同一终态只发一次；
 * - 日志保留有界 tail，不做持久化事件回放；
 * - 各进程使用同一实现，但不共享内存实例/任务表（跨进程 get/cancel 不在范围）。
 */

export class TaskError extends Error {
  constructor (
    readonly code: 'FH2_TASK_NOT_FOUND' | 'FH2_TASK_IN_PROGRESS' | 'FH2_TASK_NOT_CANCELLABLE' | 'FH2_TASK_CANCEL_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'TaskError'
  }
}

/** executor 主动停止（响应取消信号）时抛出；服务将其归一为 cancelled 终态。 */
export class TaskCancelledError extends Error {
  constructor (message = '任务已取消。Task cancelled.') {
    super(message)
    this.name = 'TaskCancelledError'
  }
}

export interface TaskExecutorContext {
  readonly taskId: string;
  readonly kind: TaskKind;
  readonly root: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly signal: AbortSignal;
  emitLog (stream: 'stdout' | 'stderr', line: string): void;
  emitUrl (url: string): void;
  emitDiagnostic (diagnostic: Diagnostic): void;
  emitArtifact (artifact: ArtifactDescriptor): void;
  /** 取得 operation lock 并完成准备后调用；未进入执行的任务允许缺失，不伪造空 hash。 */
  reportInitialRevision (revision: string): void;
}

export interface TaskExecutorResult {
  readonly artifacts?: readonly ArtifactDescriptor[];
  /** 任务结束时重新计算的源码 revision；与 initialRevision 不同则 stale。 */
  readonly finalRevision?: string;
}

export interface TaskExecutor {
  start (context: TaskExecutorContext): Promise<TaskExecutorResult>;
}

export interface TaskServiceOptions {
  /** root 归一化（T3 的 canonicalOperationRoot）；默认恒等。 */
  readonly canonicalizeRoot?: (root: string) => string;
  /** 单任务日志 tail 上限；默认 500 行。 */
  readonly logTailLimit?: number;
  /** 每 owner 保留的已终态任务快照上限；默认 50。 */
  readonly historyLimit?: number;
}

interface TaskRecord {
  readonly operationRoot: string;
  readonly taskId: string;
  readonly kind: TaskKind;
  readonly owner: TaskOwner;
  readonly root: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  state: TaskState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  sourceRevision?: string;
  finalRevision?: string;
  stale?: boolean;
  diagnostics: Diagnostic[];
  artifacts: ArtifactDescriptor[];
  logTail: string[];
  lastSequence: number;
  terminalEmitted: boolean;
  /** 取消信号：cancel(running) 先 abort，再等待 executor 清理完成。 */
  controller: AbortController;
  completion: Promise<void>;
}

const LOG_TAIL_LIMIT_DEFAULT = 500
const HISTORY_LIMIT_DEFAULT = 50

export class InMemoryTaskService implements TaskService {
  private readonly executors = new Map<TaskKind, TaskExecutor>()
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly activeByRootKind = new Map<string, string>()
  private readonly ownerHistory = new Map<string, string[]>()
  private readonly listeners = new Map<TaskOwner, Set<(event: TaskEvent) => void>>()
  private readonly canonicalizeRoot: (root: string) => string
  private readonly logTailLimit: number
  private readonly historyLimit: number

  constructor (options: TaskServiceOptions = {}) {
    this.canonicalizeRoot = options.canonicalizeRoot ?? (root => root)
    this.logTailLimit = options.logTailLimit ?? LOG_TAIL_LIMIT_DEFAULT
    this.historyLimit = options.historyLimit ?? HISTORY_LIMIT_DEFAULT
  }

  registerExecutor (kind: TaskKind, executor: TaskExecutor): void {
    this.executors.set(kind, executor)
  }

  async start (owner: TaskOwner, request: TaskRequest): Promise<TaskSnapshot> {
    const executor = this.executors.get(request.kind)
    if (executor === undefined) {
      throw new TaskError('FH2_TASK_NOT_FOUND', `未注册的任务类型：${request.kind}。No executor registered for kind: ${request.kind}.`)
    }
    const targetRoot = resolve(request.root)
    const canonicalRoot = this.canonicalizeRoot(targetRoot)
    const key = `${canonicalRoot}\0${request.kind}`
    const activeTaskId = this.activeByRootKind.get(key)
    if (activeTaskId !== undefined) {
      const active = this.tasks.get(activeTaskId)
      if (active !== undefined && !isTerminal(active.state)) {
        if (active.owner.ownerId !== owner.ownerId) {
          // 不同 owner 的冲突只返回忙碌错误，不泄露不可访问的 taskId。
          throw new TaskError(
            'FH2_TASK_IN_PROGRESS',
            `目标工程已有同类型任务进行中。Another task of the same kind is in progress for this project.`,
          )
        }
        if (active.root === targetRoot && stableParams(active.params) === stableParams(request.params)) {
          return this.snapshotOf(active)
        }
        throw new TaskError(
          'FH2_TASK_IN_PROGRESS',
          `同工程同类型任务已在进行中且参数不同。A task of the same kind with different parameters is already in progress.`,
        )
      }
    }

    const taskId = `task-${randomUUID()}`
    const controller = new AbortController()
    const record: TaskRecord = {
      taskId,
      operationRoot: canonicalRoot,
      kind: request.kind,
      owner,
      root: targetRoot,
      params: request.params,
      state: 'queued',
      createdAt: Date.now(),
      diagnostics: [],
      artifacts: [],
      logTail: [],
      lastSequence: 0,
      terminalEmitted: false,
      controller,
      completion: Promise.resolve(),
    }
    this.tasks.set(taskId, record)
    this.activeByRootKind.set(key, taskId)
    this.emitState(record, 'queued')

    const context: TaskExecutorContext = {
      taskId,
      kind: request.kind,
      root: targetRoot,
      params: request.params,
      signal: controller.signal,
      emitLog: (stream, line) => this.appendLog(record, stream, line),
      emitUrl: url => this.emitEvent(record, { type: 'url', taskId, sequence: 0, url }),
      emitDiagnostic: diagnostic => this.appendDiagnostic(record, diagnostic),
      emitArtifact: (artifact) => {
        record.artifacts.push(artifact)
        this.emitEvent(record, { type: 'artifact', taskId, sequence: 0, artifact })
      },
      reportInitialRevision: (revision) => {
        if (record.sourceRevision === undefined) record.sourceRevision = revision
      },
    }

    record.completion = this.runExecutor(record, executor, context)
    return this.snapshotOf(record)
  }

  get (owner: TaskOwner, taskId: string): TaskSnapshot {
    const record = this.tasks.get(taskId)
    if (record === undefined || record.owner.ownerId !== owner.ownerId) {
      throw new TaskError('FH2_TASK_NOT_FOUND', `任务不存在：${taskId}。Task not found: ${taskId}.`)
    }
    return this.snapshotOf(record)
  }

  /** 该 owner 的全部任务快照（按创建时间倒序）。 */
  list (owner: TaskOwner): readonly TaskSnapshot[] {
    return [...this.tasks.values()]
      .filter(record => record.owner.ownerId === owner.ownerId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(record => this.snapshotOf(record))
  }

  async cancel (owner: TaskOwner, taskId: string): Promise<TaskSnapshot> {
    const record = this.tasks.get(taskId)
    if (record === undefined || record.owner.ownerId !== owner.ownerId) {
      throw new TaskError('FH2_TASK_NOT_FOUND', `任务不存在：${taskId}。Task not found: ${taskId}.`)
    }
    if (isTerminal(record.state)) {
      throw new TaskError('FH2_TASK_NOT_CANCELLABLE', `任务已处于终态 ${record.state}。Task already finished with state ${record.state}.`)
    }
    if (record.state === 'queued') {
      // 尚未开始执行：直接取消，不进入 executor。
      this.finalize(record, 'cancelled')
      return this.snapshotOf(record)
    }
    // running：先发停止信号并等待 executor 清理完成，再落终态。
    // executor 依约抛 TaskCancelledError → cancelled；其他结果按真实结果记录，不伪报取消成功。
    record.controller.abort()
    await record.completion
    const snapshot = this.snapshotOf(record)
    if (snapshot.state !== 'cancelled') {
      throw new TaskError(
        'FH2_TASK_CANCEL_FAILED',
        `任务未能取消，最终状态为 ${snapshot.state}。Task could not be cancelled; final state: ${snapshot.state}.`,
      )
    }
    return snapshot
  }

  subscribe (owner: TaskOwner, listener: (event: TaskEvent) => void): () => void {
    let set = this.listeners.get(owner)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(owner, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(owner)
    }
  }

  async stopOwned (owner: TaskOwner): Promise<void> {
    const owned = [...this.tasks.values()].filter(record => record.owner.ownerId === owner.ownerId && !isTerminal(record.state))
    await Promise.all(owned.map(record => this.cancel(owner, record.taskId).catch(() => undefined)))
  }

  /** 等待任务到达终态（CLI 等待策略的内部助手，不进入公开契约）。 */
  async settle (owner: TaskOwner, taskId: string): Promise<TaskSnapshot> {
    this.get(owner, taskId)
    const record = this.tasks.get(taskId)!
    await record.completion
    return this.get(owner, taskId)
  }

  /** 等待任务进入 running（测试与取消链路用；终态直接返回）。 */
  async awaitRunning (owner: TaskOwner, taskId: string): Promise<void> {
    this.get(owner, taskId)
    for (let attempt = 0; attempt < 200; attempt++) {
      const state = this.get(owner, taskId).state
      if (state === 'running' || isTerminal(state)) return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  /** 有界日志 tail（调试/排障用，不进入公开快照契约）。 */
  logTail (owner: TaskOwner, taskId: string): readonly string[] {
    const record = this.tasks.get(taskId)
    if (record === undefined || record.owner.ownerId !== owner.ownerId) {
      throw new TaskError('FH2_TASK_NOT_FOUND', `任务不存在：${taskId}。Task not found: ${taskId}.`)
    }
    return [...record.logTail]
  }

  private async runExecutor (
    record: TaskRecord,
    executor: TaskExecutor,
    context: TaskExecutorContext,
  ): Promise<void> {
    // 让 start() 先返回 queued 快照；setImmediate 宏任务边界使 queued 窗口可观察、可取消。
    await new Promise<void>(resolve => setImmediate(resolve))
    if (this.stateOf(record) === 'cancelled') return
    record.startedAt = Date.now()
    this.emitState(record, 'running')
    try {
      const result = await executor.start(context)
      if (this.stateOf(record) === 'cancelled') return
      if (result.artifacts !== undefined) {
        for (const artifact of result.artifacts) {
          if (!record.artifacts.some(existing => existing.id === artifact.id)) {
            record.artifacts.push(artifact)
            this.emitEvent(record, { type: 'artifact', taskId: record.taskId, sequence: 0, artifact })
          }
        }
      }
      if (result.finalRevision !== undefined) {
        record.finalRevision = result.finalRevision
        record.stale = record.sourceRevision !== undefined && result.finalRevision !== record.sourceRevision
      }
      this.finalize(record, 'succeeded')
    } catch (error) {
      if (this.stateOf(record) === 'cancelled') return
      if (error instanceof TaskCancelledError || context.signal.aborted) {
        this.finalize(record, 'cancelled')
        return
      }
      this.appendDiagnostic(record, {
        code: 'FH2_TASK_EXECUTOR_FAILED',
        phase: 'code',
        file: '.',
        message: error instanceof Error ? error.message : String(error),
        severity: 'error',
      })
      this.finalize(record, 'failed')
    }
  }

  private finalize (record: TaskRecord, state: TaskState): void {
    if (isTerminal(record.state)) return
    record.state = state
    record.finishedAt = Date.now()
    this.emitState(record, state)
    this.clearActive(record)
    const history = this.ownerHistory.get(record.owner.ownerId) ?? []
    history.push(record.taskId)
    while (history.length > this.historyLimit) {
      const evicted = history.shift()
      if (evicted !== undefined && this.tasks.get(evicted)?.state !== undefined) {
        const current = this.tasks.get(evicted)
        if (current !== undefined && isTerminal(current.state)) this.tasks.delete(evicted)
      }
    }
    this.ownerHistory.set(record.owner.ownerId, history)
  }

  private clearActive (record: TaskRecord): void {
    const key = `${record.operationRoot}\0${record.kind}`
    if (this.activeByRootKind.get(key) === record.taskId) this.activeByRootKind.delete(key)
  }

  private appendLog (record: TaskRecord, stream: 'stdout' | 'stderr', line: string): void {
    const formatted = `[${stream}] ${line}`
    record.logTail.push(formatted)
    if (record.logTail.length > this.logTailLimit) record.logTail.splice(0, record.logTail.length - this.logTailLimit)
    this.emitEvent(record, { type: 'log', taskId: record.taskId, sequence: 0, stream, line })
  }

  private appendDiagnostic (record: TaskRecord, diagnostic: Diagnostic): void {
    record.diagnostics.push(diagnostic)
    this.emitEvent(record, { type: 'diagnostic', taskId: record.taskId, sequence: 0, diagnostic })
  }

  private emitState (record: TaskRecord, state: TaskState): void {
    // 同一终态只发一次：finalize 的幂等保护之外，再挡一次显式调用。
    if (isTerminal(state)) {
      if (record.terminalEmitted) return
      record.terminalEmitted = true
    }
    record.state = state
    this.emitEvent(record, { type: 'state', taskId: record.taskId, sequence: 0, state })
  }

  private emitEvent (record: TaskRecord, event: TaskEvent & { sequence: number }): void {
    record.lastSequence += 1
    const sequenced = { ...event, kind: record.kind, sequence: record.lastSequence } as TaskEvent
    const listeners = this.listeners.get(record.owner)
    if (listeners === undefined) return
    for (const listener of listeners) listener(sequenced)
  }

  /** 读取 record 当前 state（绕过跨 await 的类型收窄误报）。 */
  private stateOf (record: TaskRecord): TaskState {
    return record.state
  }

  private snapshotOf (record: TaskRecord): TaskSnapshot {
    return {
      taskId: record.taskId,
      kind: record.kind,
      state: record.state,
      createdAt: record.createdAt,
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
      ...(record.sourceRevision === undefined ? {} : { sourceRevision: record.sourceRevision }),
      ...(record.finalRevision === undefined ? {} : { finalRevision: record.finalRevision }),
      ...(record.stale === undefined ? {} : { stale: record.stale }),
      diagnostics: [...record.diagnostics],
      artifacts: [...record.artifacts],
      lastSequence: record.lastSequence,
    }
  }
}

function isTerminal (state: TaskState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}

function stableParams (params: Readonly<Record<string, string | number | boolean>>): string {
  return Object.keys(params).sort().map(key => `${key}=${String(params[key])}`).join('&')
}
