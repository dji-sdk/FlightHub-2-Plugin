// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { FlightTaskStatus } from 'fh2-plugin-sdk'

/**
 * ★ 状态流转图（控制状态机，纯函数；业务数据在 patrol-session，不在本文件）
 *
 * 外部事件：context-changed（项目/机场）、wayline-task-changed（普通航线通道 taskId/status/flightId）
 * 内部事件：classification-*（识别过程）、task-activated、task-finished、disposed
 *
 *   idle
 *    │ wayline-task-changed(taskId)             ← 观察到新普通航线任务（任何状态下换新任务同理）
 *    ▼
 *   candidate ◀────────────────────────────────────────────────┐
 *    │ classification-started（发起识别，attempts+1）           │
 *    ▼                                                        │
 *   classifying                                               │
 *    │ ├─ biz_ext 含 es-patrol ── task-activated ─▶ tracking  │
 *    │ │                                        │             │
 *    │ │                                   task-finished     │
 *    │ │                                        ▼             │
 *    │ │                                   reviewing          │
 *    │ ├─ 详情存在但非巡逻 ─▶ non-patrol（不再轮询）           │
 *    │ └─ 失败/404                                           │
 *    │      attempts < 3 ─▶ classification-wait ─(2s/4s 退避到点 retry)─┘
 *    │      attempts = 3 ─▶ classification-paused
 *    │                        （挂起：仅显式 refresh / 新任务 / 新项目能唤醒）
 *    ▼
 *   （无 taskId 时停在 idle，通过 /current 发现页面刷新、其他操作员和定时巡逻任务；
 *     连续未命中 2s 快查 10 次后降频 15s）
 *
 * 旁路规则：
 *   · 只消费 cockpit:flight-task 的 wayline 通道；复检即时航线在 inFlightWayline
 *     通道独立承载，不进入本状态机（契约层面已消除压平）。
 *   · epoch：context/task 变化、classification-refresh、换任务激活、disposed 都 +1；
 *     在途请求返回时经 isCurrentRequest 判定为过期直接丢弃。
 *   · 同一 task 的 status/progress 更新不重置 attempts（防无限重试）。
 *   · taskId 清空 ≠ 数据失效：tracking/reviewing 原地保留，等下一个任务。
 *   · flightId 跨航次（含 taskId 尚未变化的窗口）→ 立即释放已确认巡逻任务。
 *   · 飞行任务先宣告终态而快照未跟上 → ignored-terminal，等巡逻后端自己的终态判断。
 *   · 项目切换 → 重新判别观察任务；仅机场切换 → 只作废请求不重新判别。
 *   · disposed 为唯一终态，之后忽略一切事件。
 */

interface RuntimeContext {
  readonly projectId: string;
  readonly gatewaySn: string | null;
  readonly observedTaskId: string;
  /** null = 无普通航线任务快照。 */
  readonly observedTaskStatus: FlightTaskStatus | null;
  readonly observedFlightId: string;
  /** 已通过 biz_ext.es-patrol 验证的父任务所属航次；用于判定跨航次释放。 */
  readonly patrolFlightId: string;
  /** 每次任务或宿主上下文变化都会递增，用来拒绝上一代异步响应。 */
  readonly epoch: number;
}

export type PatrolRuntimeControlState = RuntimeContext & (
  | { readonly kind: 'idle' }
  /** 已拿到飞行任务，但还没有发起 平台任务服务 业务类型判别。 */
  | { readonly kind: 'candidate'; readonly taskUuid: string; readonly attempts: number }
  | { readonly kind: 'classifying'; readonly taskUuid: string; readonly attempts: number }
  /** 一次判别失败后的退避窗口；timer 到期后才能发起下一次请求。 */
  | { readonly kind: 'classification-wait'; readonly taskUuid: string; readonly attempts: number }
  /** 有限重试已耗尽。只接受显式刷新或新的 task/context 唤醒。 */
  | { readonly kind: 'classification-paused'; readonly taskUuid: string; readonly attempts: number }
  | { readonly kind: 'non-patrol'; readonly taskUuid: string }
  | { readonly kind: 'ignored-terminal'; readonly taskUuid: string }
  | { readonly kind: 'tracking'; readonly taskUuid: string }
  /** 巡逻业务已经终止，但本次会话内继续保留 panel 和回顾数据。 */
  | { readonly kind: 'reviewing'; readonly taskUuid: string }
  | { readonly kind: 'disposed' }
)

export type PatrolRuntimeControlEvent =
  | { readonly type: 'context-changed'; readonly projectId: string; readonly gatewaySn: string | null }
  | {
    readonly type: 'wayline-task-changed';
    readonly taskId: string;
    readonly status: FlightTaskStatus | null;
    readonly flightId: string;
  }
  | { readonly type: 'classification-started' }
  | { readonly type: 'classification-failed'; readonly maxAttempts: number }
  | { readonly type: 'classification-retry' }
  | { readonly type: 'classification-refresh' }
  | { readonly type: 'classified-non-patrol' }
  | { readonly type: 'task-activated'; readonly taskUuid: string }
  | { readonly type: 'task-finished' }
  | { readonly type: 'disposed' }

export function createInitialRuntimeControlState (): PatrolRuntimeControlState {
  return {
    kind: 'idle',
    projectId: '',
    gatewaySn: null,
    observedTaskId: '',
    observedTaskStatus: null,
    observedFlightId: '',
    patrolFlightId: '',
    epoch: 0,
  }
}

function isFlightTaskTerminal (status: FlightTaskStatus | null): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed'
}

function candidateForObservedTask (
  state: RuntimeContext,
  epoch: number,
): PatrolRuntimeControlState {
  const candidate = { ...state, patrolFlightId: '', epoch }
  if (!state.observedTaskId) return { ...candidate, kind: 'idle' }
  if (isFlightTaskTerminal(state.observedTaskStatus)) {
    return { ...candidate, kind: 'ignored-terminal', taskUuid: state.observedTaskId }
  }
  return { ...candidate, kind: 'candidate', taskUuid: state.observedTaskId, attempts: 0 }
}

/**
 * Runtime 控制状态只描述“现在该做什么”，不承载巡逻快照数据。
 * HTTP/WS 的业务字段仍由 patrol-session 纯函数合并，避免两套状态相互污染。
 */
export function reducePatrolRuntimeControl (
  state: PatrolRuntimeControlState,
  event: PatrolRuntimeControlEvent,
): PatrolRuntimeControlState {
  if (state.kind === 'disposed') return state

  switch (event.type) {
    case 'context-changed': {
      if (state.projectId === event.projectId && state.gatewaySn === event.gatewaySn) return state
      const context = { ...state, projectId: event.projectId, gatewaySn: event.gatewaySn }
      // gateway 变化只让旧请求失效；只有 project 变化才需要重新判别任务类型。
      return state.projectId === event.projectId
        ? { ...context, epoch: state.epoch + 1 }
        : candidateForObservedTask(context, state.epoch + 1)
    }
    case 'wayline-task-changed': {
      const taskChanged = event.taskId !== state.observedTaskId
      const crossesPatrolFlight = Boolean(
        state.patrolFlightId
        && event.flightId
        && event.flightId !== state.patrolFlightId,
      )
      const statusChanged = event.status !== state.observedTaskStatus
      const flightChanged = event.flightId !== state.observedFlightId
      if (!taskChanged && !statusChanged && !flightChanged && !crossesPatrolFlight) return state
      const observed = {
        ...state,
        observedTaskId: event.taskId,
        observedTaskStatus: event.status,
        observedFlightId: event.flightId,
      }

      // 新航次开始（flightId 跨航次）时立即释放已激活巡逻任务，旧轮询随之过期。
      if (crossesPatrolFlight) {
        return candidateForObservedTask(observed, state.epoch + 1)
      }
      // 同航次内 wayline 快照暂空不等于父任务失效；保留已确认身份，恢复时不会误判成新任务。
      if (!event.taskId && (state.kind === 'tracking' || state.kind === 'reviewing')) {
        return { ...observed, observedTaskId: state.observedTaskId }
      }
      // 同一个已激活任务的飞行状态变化不替代巡逻后端自己的终态判断。
      if (!taskChanged && (state.kind === 'tracking' || state.kind === 'reviewing')) return observed
      if (!taskChanged) {
        if (isFlightTaskTerminal(event.status)) {
          return { ...observed, kind: 'ignored-terminal', taskUuid: event.taskId, epoch: state.epoch + 1 }
        }
        if (state.kind === 'ignored-terminal') return candidateForObservedTask(observed, state.epoch + 1)
        // progress/status 等普通更新不能重置同一 task/project 已消耗的识别次数。
        return observed
      }
      return candidateForObservedTask(observed, state.epoch + 1)
    }
    case 'classification-started':
      if (state.kind !== 'candidate') return state
      return { ...state, kind: 'classifying', attempts: state.attempts + 1 }
    case 'classification-failed':
      if (state.kind !== 'classifying') return state
      return state.attempts >= event.maxAttempts
        ? { ...state, kind: 'classification-paused' }
        : { ...state, kind: 'classification-wait' }
    case 'classification-retry':
      if (state.kind !== 'classification-wait') return state
      return { ...state, kind: 'candidate' }
    case 'classification-refresh':
      if (state.kind !== 'classification-paused') return state
      return { ...state, kind: 'candidate', attempts: 0, epoch: state.epoch + 1 }
    case 'classified-non-patrol':
      if (state.kind !== 'classifying') return state
      return { ...state, kind: 'non-patrol' }
    case 'task-activated': {
      const taskChanged = state.kind !== 'tracking' || state.taskUuid !== event.taskUuid
      return {
        ...state,
        kind: 'tracking',
        taskUuid: event.taskUuid,
        patrolFlightId: state.observedFlightId,
        epoch: taskChanged && state.observedTaskId !== event.taskUuid ? state.epoch + 1 : state.epoch,
      }
    }
    case 'task-finished':
      if (state.kind !== 'tracking') return state
      return { ...state, kind: 'reviewing' }
    case 'disposed':
      return { ...state, kind: 'disposed', epoch: state.epoch + 1 }
  }
}
