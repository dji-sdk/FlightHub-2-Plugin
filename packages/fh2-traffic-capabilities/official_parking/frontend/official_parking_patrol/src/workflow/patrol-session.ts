// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PatrolLinkState, PatrolTarget, PatrolTargetStats, PatrolTaskSnapshot } from '../api/types'
import type { PatrolPhase } from './phase-machine'
import {
  isPatrolPhase,
  isTerminalPhase,
  shouldDropSnapshotRevision,
  shouldDropWsRevision,
  shouldUpdatePhase,
} from './phase-machine'

/**
 * 违停巡逻任务状态机（纯函数）。权威状态来自 HTTP 快照（applyTaskSnapshot），
 * WS 增量（applyWsMessage）只更新各自承诺的字段；二者共用同一 state_revision
 * 序列防乱序。初检航点进度由前端自取（cockpit:flight-task），不经 WS。
 *
 * 主键 task_uuid；session_id 仅作 WS 过滤。link_state=waiting 时其余字段均无效。
 */

export interface PatrolTaskState {
  /** 巡逻任务 UUID（计划库返回）；'' = 尚未识别到任务 */
  readonly taskUuid: string;
  readonly linkState: PatrolLinkState;
  readonly rejectReason: string;
  /** active 之后才有 phase；此前为 null */
  readonly phase: PatrolPhase | null;
  readonly completionReason: string;
  readonly stateRevision: number;
  /** WS 过滤用；未建立时为 ''（此时按 taskUuid 兜底过滤） */
  readonly sessionId: string;
  readonly allowedActions: readonly string[];
  readonly abortPending: boolean;
  readonly returnHomeState: string;
  readonly returnHomeDueAtMs: number;
  readonly waylineUuid: string;
  readonly targetStats: PatrolTargetStats;
  readonly targets: readonly PatrolTarget[];
  /** 前端自取：初检航点进度（completedWaypointCount / totalWaypointCount） */
  readonly initialDone: number;
  readonly initialTotal: number;
  /** 前端自取：路段名（wayline 服务查询结果，跨快照保留） */
  readonly routeName: string;
  /** 前端自取：任务开始时间（平台任务服务 详情 begin_at；激活时一次性写入，跨快照保留） */
  readonly startedAtMs: number;
  /** UI：用户在回顾态关闭面板 */
  readonly patrolDismissed: boolean;
}

// ── WS 消息（activate 侧解析后传入；meta 为四类消息公共字段） ─────────────

interface PatrolWsMeta {
  readonly dockSn?: string | undefined;
  readonly taskUuid?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly stateRevision?: number | undefined;
}

export type PatrolWsMessage =
  | (PatrolWsMeta & {
    readonly kind: 'progress';
    readonly phase?: string | undefined;
    readonly completionReason?: string | undefined;
    readonly targetStats?: PatrolTargetStats | undefined;
  })
  | (PatrolWsMeta & { readonly kind: 'target_updated'; readonly target: PatrolTarget })
  | (PatrolWsMeta & { readonly kind: 'return_pending'; readonly dueAtMs: number })
  | (PatrolWsMeta & { readonly kind: 'return_state'; readonly returnHomeState: string })

const EMPTY_STATS: PatrolTargetStats = { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, skipped: 0 }

export function createInitialPatrolState (): PatrolTaskState {
  return {
    taskUuid: '',
    linkState: 'waiting',
    rejectReason: '',
    phase: null,
    completionReason: '',
    stateRevision: 0,
    sessionId: '',
    allowedActions: [],
    abortPending: false,
    returnHomeState: 'none',
    returnHomeDueAtMs: 0,
    waylineUuid: '',
    targetStats: EMPTY_STATS,
    targets: [],
    initialDone: 0,
    initialTotal: 0,
    routeName: '',
    startedAtMs: 0,
    patrolDismissed: false,
  }
}

/** 巡逻任务被识别：整体重置（新任务不继承旧任务任何状态）；startedAtMs 来自 平台任务服务 详情。 */
export function activatePatrolTask (state: PatrolTaskState, taskUuid: string, startedAtMs = 0): PatrolTaskState {
  if (state.taskUuid === taskUuid) return state
  return { ...createInitialPatrolState(), taskUuid, startedAtMs }
}

/** 用户在回顾态点关闭；只设 UI 标志，不清任务身份（避免同任务 WS 重新弹面板）。 */
export function dismissPatrol (state: PatrolTaskState): PatrolTaskState {
  return { ...state, patrolDismissed: true }
}

/** 路段名加载完成（wayline 服务异步回填，跨快照保留）。 */
export function applyRouteName (state: PatrolTaskState, routeName: string): PatrolTaskState {
  return { ...state, routeName }
}

/**
 * HTTP 快照（权威全量）：更旧 revision 丢弃；同 revision 允许覆盖。
 * phase 仍受单调保护（服务端保证只进不退，前端兜底）；routeName/初检进度为
 * 前端自取数据，不在快照内，跨快照保留。
 */
export function applyTaskSnapshot (state: PatrolTaskState, snapshot: PatrolTaskSnapshot): PatrolTaskState {
  if (snapshot.task_uuid !== state.taskUuid) return state
  if (snapshot.link_state !== 'active') {
    return { ...state, linkState: snapshot.link_state, rejectReason: snapshot.reject_reason }
  }
  if (shouldDropSnapshotRevision(state.stateRevision, snapshot.state_revision)) return state
  // WS 已推进到终态后，只接受同一终态的 HTTP 全量补齐，避免迟到快照混入旧 actions/统计。
  if (state.phase !== null && isTerminalPhase(state.phase) && snapshot.phase !== state.phase) return state

  let phase = state.phase
  if (isPatrolPhase(snapshot.phase)) {
    if (phase === null || shouldUpdatePhase(phase, snapshot.phase)) phase = snapshot.phase
  }
  return {
    ...state,
    linkState: 'active',
    rejectReason: snapshot.reject_reason,
    phase,
    completionReason: snapshot.completion_reason,
    stateRevision: Math.max(state.stateRevision, snapshot.state_revision),
    sessionId: snapshot.session_id || state.sessionId,
    allowedActions: snapshot.allowed_actions,
    abortPending: snapshot.abort_pending,
    returnHomeState: snapshot.return_home_state,
    returnHomeDueAtMs: snapshot.return_home_due_at_ms,
    waylineUuid: snapshot.wayline_uuid || state.waylineUuid,
    targetStats: snapshot.target_stats,
    targets: snapshot.targets,
  }
}

/**
 * WS 身份过滤：sessionId 已建立时按 session 过滤；未建立（或消息未带）时按
 * task_uuid 兜底比对，防止上一趟 session 积压消息污染新任务。
 */
export function acceptWsMessage (state: PatrolTaskState, message: PatrolWsMeta): boolean {
  const stateHasSession = Boolean(state.sessionId && state.sessionId !== '0')
  const messageHasSession = Boolean(message.sessionId && message.sessionId !== '0')
  if (stateHasSession) {
    if (!messageHasSession || message.sessionId !== state.sessionId) return false
    return !message.taskUuid || message.taskUuid === state.taskUuid
  }
  // session 尚未建立（0/"0"/缺失）时，task_uuid 必须存在且匹配。
  return Boolean(message.taskUuid && message.taskUuid === state.taskUuid)
}

/** WS 增量：revision <= 已见最大值整条丢弃；每类消息只更新自己承诺的字段。 */
export function applyWsMessage (state: PatrolTaskState, message: PatrolWsMessage): PatrolTaskState {
  if (!acceptWsMessage(state, message)) return state
  if (shouldDropWsRevision(state.stateRevision, message.stateRevision ?? 0)) return state

  let next = state
  // sessionId 采纳：消息归属当前任务且携带更完整的 session 标识
  if (message.sessionId && message.sessionId !== '0' && (!state.sessionId || state.sessionId === '0')) {
    next = { ...next, sessionId: message.sessionId }
  }
  if (typeof message.stateRevision === 'number' && message.stateRevision > state.stateRevision) {
    next = { ...next, stateRevision: message.stateRevision }
  }

  switch (message.kind) {
    case 'progress': {
      if (message.phase && isPatrolPhase(message.phase)) {
        if (next.phase === null || shouldUpdatePhase(next.phase, message.phase)) {
          next = { ...next, phase: message.phase }
        }
      }
      if (message.completionReason !== undefined) {
        next = { ...next, completionReason: message.completionReason }
      }
      if (message.targetStats) {
        next = { ...next, targetStats: message.targetStats }
      }
      return next
    }
    case 'target_updated': {
      const index = next.targets.findIndex(item => item.target_id === message.target.target_id)
      const targets = index >= 0
        ? next.targets.map((item, i) => (i === index ? message.target : item))
        : [...next.targets, message.target]
      return { ...next, targets }
    }
    case 'return_pending':
      return { ...next, returnHomeDueAtMs: message.dueAtMs }
    case 'return_state':
      return { ...next, returnHomeState: message.returnHomeState }
  }
}

/** 前端自取初检进度（cockpit:flight-task 航点计数）；total<=0 不覆盖已有有效值。 */
export function setInitialProgress (state: PatrolTaskState, done: number, total: number): PatrolTaskState {
  const nextDone = Math.max(state.initialDone, Math.max(0, done))
  if (nextDone === state.initialDone && (total <= 0 || total === state.initialTotal)) return state
  return {
    ...state,
    initialDone: nextDone,
    initialTotal: total > 0 ? total : state.initialTotal,
  }
}

// ── 派生 getter ──────────────────────────────────────────────────────────

/** 面板可见：已识别任务且未被用户关闭（not_patrol 兜底值不展示）。 */
export function isTaskVisible (state: PatrolTaskState): boolean {
  return state.taskUuid !== '' && !state.patrolDismissed && state.linkState !== 'not_patrol'
}

/** 活跃态：巡逻进行中，显示进度条和终止按钮。 */
export function isPatrolActive (state: PatrolTaskState): boolean {
  return isTaskVisible(state)
    && state.linkState === 'active'
    && state.phase !== null
    && !isTerminalPhase(state.phase)
}

/** 回顾态：任务已到终态，保留进度和照片，隐藏操作按钮。 */
export function isPatrolReview (state: PatrolTaskState): boolean {
  return isTaskVisible(state)
    && state.linkState === 'active'
    && state.phase !== null
    && isTerminalPhase(state.phase)
}

/** 轮询是否可以停止：rejected/not_patrol 或终态 phase。 */
export function isPollingFinished (state: PatrolTaskState): boolean {
  if (state.linkState === 'rejected' || state.linkState === 'not_patrol') return true
  return state.phase !== null && isTerminalPhase(state.phase)
}

/** 复检进度：分子 completed + failed + skipped（含失败与消失，文案用「已处理」）。 */
export function recheckProgress (state: PatrolTaskState): { readonly done: number; readonly total: number } {
  const stats = state.targetStats
  return {
    done: stats.completed + stats.failed + stats.skipped,
    total: stats.total,
  }
}

export function initialPercent (state: PatrolTaskState): number {
  if (state.initialTotal <= 0) return 0
  return Math.min(100, Math.round((state.initialDone / state.initialTotal) * 100))
}

export function recheckPercent (state: PatrolTaskState): number {
  const { done, total } = recheckProgress(state)
  if (total <= 0) return 0
  return Math.min(100, Math.round((done / total) * 100))
}
