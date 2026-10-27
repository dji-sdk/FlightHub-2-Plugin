// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { ArtifactDescriptor } from './artifact.js'
import { parseArtifactDescriptor } from './artifact.js'
import type { Diagnostic } from './diagnostic.js'
import { parseDiagnostic } from './diagnostic.js'

/**
 * 统一任务契约（实施计划 §3.1）。
 *
 * - 各客户端只允许不同等待策略，不允许另建任务实现：
 *   Web IDE 立即拿 taskId + SSE；MCP 拿 taskId + get_task/cancel_task 轮询；CLI 等终态。
 * - `TaskOwner` 是进程内权限边界：get/cancel/subscribe/stopOwned 都检查 owner；
 *   `ownerId` 不进入公开快照；不同 owner 的冲突只返回忙碌错误，不泄露不可访问的 taskId。
 * - Validate/Generate/Create 首版保持同步 Application Service，不进入任务模型。
 */

export type CoreTaskKind = 'build' | 'pack' | 'dev'
export type TaskKind = CoreTaskKind | 'preview' | 'install'
export type McpTaskKind = CoreTaskKind

export const TASK_KINDS: readonly TaskKind[] = ['build', 'pack', 'dev', 'preview', 'install']
export const CORE_TASK_KINDS: readonly CoreTaskKind[] = ['build', 'pack', 'dev']

export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export const TASK_STATES: readonly TaskState[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled']

export const TERMINAL_TASK_STATES: readonly TaskState[] = ['succeeded', 'failed', 'cancelled']

export function isTerminalTaskState (state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state)
}

export interface TaskSnapshot<K extends TaskKind = TaskKind> {
  readonly taskId: string;
  readonly workspaceSessionId?: string;
  readonly kind: K;
  readonly state: TaskState;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  /** 持锁并完成准备后计算的 initialRevision；未进入执行的 queued/取消任务允许缺失，不伪造空 hash。 */
  readonly sourceRevision?: string;
  readonly finalRevision?: string;
  readonly stale?: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly artifacts: readonly ArtifactDescriptor[];
  /** 快照携带最后 sequence；SSE 重连先取快照再消费新事件，缺口重新取快照。 */
  readonly lastSequence: number;
}

/** 进程内任务所有者；具体实现各自生成唯一 id，不进入公开快照。 */
export interface TaskOwner {
  readonly ownerId: string;
}

/** kind 专属的规范化参数由各 executor 定义；此处的 params 已是规范化结果，不做二次解释。 */
export interface TaskRequest {
  readonly kind: TaskKind;
  /** 执行目标根；TaskService 另行计算互斥的 operation root，不改变成员目标。 */
  readonly root: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
}

/**
 * 任务错误码（HTTP/MCP 协议映射由各 Adapter 完成）：
 * - 跨 owner 的 get/cancel 视为 `FH2_TASK_NOT_FOUND`，不泄露其他 owner 的任务存在性；
 * - 重复 start 参数不同返回 `FH2_TASK_IN_PROGRESS`；
 * - 已终态 cancel 返回 `FH2_TASK_NOT_CANCELLABLE`；
 * - 取消失败不得伪报成功，返回 `FH2_TASK_CANCEL_FAILED`。
 */
export type TaskErrorCode =
  | 'FH2_TASK_NOT_FOUND'
  | 'FH2_TASK_IN_PROGRESS'
  | 'FH2_TASK_NOT_CANCELLABLE'
  | 'FH2_TASK_CANCEL_FAILED'

export const TASK_ERROR_CODES: readonly TaskErrorCode[] = [
  'FH2_TASK_NOT_FOUND',
  'FH2_TASK_IN_PROGRESS',
  'FH2_TASK_NOT_CANCELLABLE',
  'FH2_TASK_CANCEL_FAILED',
]

export interface TaskService {
  start(owner: TaskOwner, request: TaskRequest): Promise<TaskSnapshot>;
  get(owner: TaskOwner, taskId: string): TaskSnapshot;
  cancel(owner: TaskOwner, taskId: string): Promise<TaskSnapshot>;
  subscribe(owner: TaskOwner, listener: (event: TaskEvent) => void): () => void;
  stopOwned(owner: TaskOwner): Promise<void>;
}

// ── TaskEvent：按 taskId 单调递增 sequence，覆盖状态、日志、URL、Diagnostic、Artifact 和终态 ──

export interface TaskStateEvent {
  readonly type: 'state';
  readonly taskId: string;
  readonly sequence: number;
  readonly state: TaskState;
}

export interface TaskLogEvent {
  readonly type: 'log';
  readonly taskId: string;
  readonly sequence: number;
  readonly stream: 'stdout' | 'stderr';
  readonly line: string;
}

export interface TaskUrlEvent {
  readonly type: 'url';
  readonly taskId: string;
  readonly sequence: number;
  readonly url: string;
}

export interface TaskDiagnosticEvent {
  readonly type: 'diagnostic';
  readonly taskId: string;
  readonly sequence: number;
  readonly diagnostic: Diagnostic;
}

export interface TaskArtifactEvent {
  readonly type: 'artifact';
  readonly taskId: string;
  readonly sequence: number;
  readonly artifact: ArtifactDescriptor;
}

export type TaskEvent = (
  | TaskStateEvent
  | TaskLogEvent
  | TaskUrlEvent
  | TaskDiagnosticEvent
  | TaskArtifactEvent
) & { readonly workspaceSessionId?: string; readonly kind?: TaskKind }

/** 严格解析任务事件；sequence 必须是非负整数，嵌套 diagnostic/artifact 结构不符时整体拒绝。 */
export function parseTaskEvent (value: unknown): TaskEvent | null {
  const parsed = parseTaskEventValue(value)
  if (!parsed) return null
  const session = (value as Record<string, unknown>).workspaceSessionId
  const kind = (value as Record<string, unknown>).kind
  if (session !== undefined && typeof session !== 'string') return null
  if (kind !== undefined && !TASK_KINDS.includes(kind as TaskKind)) return null
  return { ...parsed, ...(session === undefined ? {} : { workspaceSessionId: session as string }), ...(kind === undefined ? {} : { kind: kind as TaskKind }) }
}

function parseTaskEventValue (value: unknown): TaskEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.taskId !== 'string' || record.taskId === '') return null
  const sequence = record.sequence
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0) return null
  switch (record.type) {
    case 'state': {
      if (!(TASK_STATES as readonly string[]).includes(record.state as string)) return null
      return { type: 'state', taskId: record.taskId, sequence, state: record.state as TaskState }
    }
    case 'log': {
      if (record.stream !== 'stdout' && record.stream !== 'stderr') return null
      if (typeof record.line !== 'string') return null
      return { type: 'log', taskId: record.taskId, sequence, stream: record.stream, line: record.line }
    }
    case 'url': {
      if (typeof record.url !== 'string' || record.url === '') return null
      return { type: 'url', taskId: record.taskId, sequence, url: record.url }
    }
    case 'diagnostic': {
      const diagnostic = parseDiagnostic(record.diagnostic)
      if (diagnostic === null) return null
      return { type: 'diagnostic', taskId: record.taskId, sequence, diagnostic }
    }
    case 'artifact': {
      const artifact = parseArtifactDescriptor(record.artifact)
      if (artifact === null) return null
      return { type: 'artifact', taskId: record.taskId, sequence, artifact }
    }
    default:
      return null
  }
}
