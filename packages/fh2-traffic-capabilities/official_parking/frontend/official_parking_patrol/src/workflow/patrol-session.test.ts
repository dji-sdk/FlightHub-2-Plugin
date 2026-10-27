// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import type { PatrolTarget, PatrolTargetStats } from '../api/types'
import {
  activatePatrolTask,
  applyRouteName,
  applyTaskSnapshot,
  applyWsMessage,
  createInitialPatrolState,
  dismissPatrol,
  initialPercent,
  isPatrolActive,
  isPatrolReview,
  isPollingFinished,
  isTaskVisible,
  recheckPercent,
  recheckProgress,
  setInitialProgress,
} from './patrol-session'
import type { PatrolTaskState } from './patrol-session'

const STATS: PatrolTargetStats = { total: 2, pending: 1, processing: 1, completed: 0, failed: 0, skipped: 0 }

function activeSnapshot (overrides: Partial<Parameters<typeof applyTaskSnapshot>[1]> = {}) {
  return {
    link_state: 'active' as const,
    task_uuid: 'task-1',
    reject_reason: '',
    session_id: '1024',
    wayline_uuid: 'wl-1',
    phase: 'phase1',
    completion_reason: '',
    state_revision: 10,
    allowed_actions: ['abort'],
    abort_pending: false,
    return_home_state: 'none',
    return_home_due_at_ms: 0,
    target_stats: STATS,
    targets: [],
    ...overrides,
  }
}

function target (id: string, status = 'pending'): PatrolTarget {
  return {
    target_id: id,
    status,
    display_name: `车${id}`,
    vehicle_class: 'car',
    lat: 22.5,
    lng: 113.9,
    best_frame_thumb_url: `https://thumb/${id}`,
    photo_taken_at_ms: 1756542962000,
    fail_reason: '',
  }
}

function identifiedState (): PatrolTaskState {
  return applyTaskSnapshot(activatePatrolTask(createInitialPatrolState(), 'task-1'), activeSnapshot())
}

describe('activatePatrolTask', () => {
  it('新任务整体重置；同任务幂等', () => {
    let state = identifiedState()
    state = dismissPatrol(state)
    state = activatePatrolTask(state, 'task-1')
    expect(state.patrolDismissed).toBe(true) // 同任务不重置

    state = activatePatrolTask(state, 'task-2')
    expect(state).toMatchObject({ taskUuid: 'task-2', patrolDismissed: false, phase: null, stateRevision: 0 })
  })

  it('激活时写入 平台任务服务 任务开始时间，跨快照保留', () => {
    let state = activatePatrolTask(createInitialPatrolState(), 'task-1', 1756542962000)
    expect(state.startedAtMs).toBe(1756542962000)

    state = applyTaskSnapshot(state, activeSnapshot({ state_revision: 11 }))
    expect(state.startedAtMs).toBe(1756542962000)
  })

  it('未提供开始时间时保持 0（展示层占位）', () => {
    const state = activatePatrolTask(createInitialPatrolState(), 'task-1')
    expect(state.startedAtMs).toBe(0)
  })
})

describe('applyTaskSnapshot', () => {
  it('非 active 快照只更新 link_state/reject_reason', () => {
    let state = identifiedState()
    state = applyTaskSnapshot(state, { link_state: 'rejected', task_uuid: 'task-1', reject_reason: 'route_not_patrol' })
    expect(state.linkState).toBe('rejected')
    expect(state.rejectReason).toBe('route_not_patrol')
    expect(state.phase).toBe('phase1') // 其余状态保留
  })

  it('active 快照全量覆盖；routeName/初检进度为前端自取数据，跨快照保留', () => {
    let state = identifiedState()
    state = applyRouteName(state, '福华路南段')
    state = setInitialProgress(state, 8, 26)

    state = applyTaskSnapshot(state, activeSnapshot({
      state_revision: 11,
      phase: 'phase2',
      return_home_due_at_ms: 1756543290000,
      allowed_actions: ['return_now', 'cancel_return', 'abort'],
    }))
    expect(state.phase).toBe('phase2')
    expect(state.allowedActions).toEqual(['return_now', 'cancel_return', 'abort'])
    expect(state.returnHomeDueAtMs).toBe(1756543290000)
    expect(state.routeName).toBe('福华路南段')
    expect(state.initialDone).toBe(8)
    expect(state.initialTotal).toBe(26)
  })

  it('更旧 revision 的快照丢弃；同 revision 允许权威覆盖', () => {
    let state = identifiedState() // revision 10, phase1
    state = applyTaskSnapshot(state, activeSnapshot({ state_revision: 9, phase: 'phase2' }))
    expect(state.phase).toBe('phase1') // 旧快照丢弃

    state = applyTaskSnapshot(state, activeSnapshot({ state_revision: 10, phase: 'phase2' }))
    expect(state.phase).toBe('phase2') // 同 revision 覆盖
  })

  it('phase 单调：快照回退阶段被拒绝；终态吸收', () => {
    let state = identifiedState()
    state = applyTaskSnapshot(state, activeSnapshot({ state_revision: 11, phase: 'completed' }))
    expect(state.phase).toBe('completed')

    const completed = state
    state = applyTaskSnapshot(state, activeSnapshot({
      state_revision: 12,
      phase: 'phase2',
      allowed_actions: ['return_now'],
    }))
    expect(state).toBe(completed) // 终态不回退，也不混入迟到快照的其他字段

    // 终态之间不互相覆盖（completed → failed 同序号）
    state = applyTaskSnapshot(state, activeSnapshot({ state_revision: 13, phase: 'failed' }))
    expect(state.phase).toBe('completed')
  })

  it('任务不匹配的快照整体忽略', () => {
    const state = identifiedState()
    const next = applyTaskSnapshot(state, activeSnapshot({ task_uuid: 'task-2' }))
    expect(next).toBe(state)
  })
})

describe('applyWsMessage', () => {
  it('progress：只更新 phase/completionReason/targetStats', () => {
    let state = identifiedState()
    state = applyWsMessage(state, {
      kind: 'progress',
      taskUuid: 'task-1',
      sessionId: '1024',
      stateRevision: 12,
      phase: 'phase2',
      completionReason: '',
      targetStats: { total: 3, pending: 0, processing: 1, completed: 2, failed: 0, skipped: 0 },
    })
    expect(state.phase).toBe('phase2')
    expect(state.targetStats.total).toBe(3)
  })

  it('target_updated：按 target_id 替换；未知目标追加', () => {
    let state = applyTaskSnapshot(identifiedState(), activeSnapshot({ state_revision: 11, targets: [target('88')] }))
    state = applyWsMessage(state, { kind: 'target_updated', taskUuid: 'task-1', sessionId: '1024', stateRevision: 12, target: target('88', 'completed') })
    expect(state.targets[0]?.status).toBe('completed')

    state = applyWsMessage(state, { kind: 'target_updated', taskUuid: 'task-1', sessionId: '1024', stateRevision: 13, target: target('99') })
    expect(state.targets.map(item => item.target_id)).toEqual(['88', '99'])
  })

  it('return_pending / return_state：只更新各自字段', () => {
    let state = identifiedState()
    state = applyWsMessage(state, { kind: 'return_pending', taskUuid: 'task-1', sessionId: '1024', stateRevision: 40, dueAtMs: 1756543290000 })
    expect(state.returnHomeDueAtMs).toBe(1756543290000)

    state = applyWsMessage(state, { kind: 'return_state', taskUuid: 'task-1', sessionId: '1024', stateRevision: 41, returnHomeState: 'sent' })
    expect(state.returnHomeState).toBe('sent')
  })

  it('revision <= 当前值整条丢弃（含相等，防重复应用）', () => {
    let state = identifiedState() // revision 10
    state = applyWsMessage(state, { kind: 'return_state', taskUuid: 'task-1', sessionId: '1024', stateRevision: 10, returnHomeState: 'sent' })
    expect(state.returnHomeState).toBe('none') // 相等 revision 丢弃

    state = applyWsMessage(state, { kind: 'return_state', taskUuid: 'task-1', sessionId: '1024', stateRevision: 9, returnHomeState: 'sent' })
    expect(state.returnHomeState).toBe('none') // 更旧丢弃

    state = applyWsMessage(state, { kind: 'return_state', taskUuid: 'task-1', sessionId: '1024', stateRevision: 11, returnHomeState: 'sent' })
    expect(state.returnHomeState).toBe('sent')
  })

  it('身份过滤：sessionId 不匹配丢弃；未建立 session 时按 taskUuid 兜底', () => {
    let state = identifiedState() // sessionId '1024'
    state = applyWsMessage(state, { kind: 'return_state', sessionId: '9999', taskUuid: 'task-1', stateRevision: 11, returnHomeState: 'sent' })
    expect(state.returnHomeState).toBe('none') // 旧 session 消息拒收

    state = applyWsMessage(state, { kind: 'return_state', sessionId: '1024', taskUuid: 'task-1', stateRevision: 12, returnHomeState: 'sent' })
    expect(state.returnHomeState).toBe('sent')

    // 新任务未建立 session：按 taskUuid 过滤
    let fresh = activatePatrolTask(state, 'task-2')
    fresh = applyWsMessage(fresh, { kind: 'return_state', taskUuid: 'task-1', stateRevision: 13, returnHomeState: 'sent' })
    expect(fresh.returnHomeState).toBe('none')
    fresh = applyWsMessage(fresh, { kind: 'return_state', taskUuid: 'task-2', stateRevision: 14, returnHomeState: 'sent' })
    expect(fresh.returnHomeState).toBe('sent')
  })

  it('sessionId 采纳：首条带 session 的消息写回，后续消息据此过滤', () => {
    let state = activatePatrolTask(createInitialPatrolState(), 'task-1')
    state = applyWsMessage(state, { kind: 'progress', taskUuid: 'task-1', sessionId: '1024', stateRevision: 1, phase: 'phase1', targetStats: STATS })
    expect(state.sessionId).toBe('1024')
  })

  it('sessionId=0 视为未建立，必须按 taskUuid 过滤', () => {
    let state = activatePatrolTask(createInitialPatrolState(), 'task-2')
    state = applyWsMessage(state, { kind: 'return_state', sessionId: '0', taskUuid: 'task-1', stateRevision: 1, returnHomeState: 'sent' })
    expect(state.returnHomeState).toBe('none')
    state = applyWsMessage(state, { kind: 'return_state', sessionId: '0', taskUuid: 'task-2', stateRevision: 2, returnHomeState: 'sent' })
    expect(state.returnHomeState).toBe('sent')
    expect(state.sessionId).toBe('')
  })
})

describe('setInitialProgress', () => {
  it('乱序 done 不回退，total<=0 不覆盖已有有效值', () => {
    let state = identifiedState()
    state = setInitialProgress(state, 10, 26)
    state = setInitialProgress(state, 3, 0)
    expect(state).toMatchObject({ initialDone: 10, initialTotal: 26 })
  })

  it('同值不产生新状态引用', () => {
    const state = identifiedState()
    expect(setInitialProgress(state, 0, 0)).toBe(state)
  })
})

describe('派生 getter', () => {
  it('可见性/活跃/回顾/轮询终止', () => {
    const idle = createInitialPatrolState()
    expect(isTaskVisible(idle)).toBe(false)

    const waiting = activatePatrolTask(idle, 'task-1')
    expect(isTaskVisible(waiting)).toBe(true)
    expect(isPatrolActive(waiting)).toBe(false)
    expect(isPollingFinished(waiting)).toBe(false) // waiting 继续轮询

    const active = identifiedState()
    expect(isPatrolActive(active)).toBe(true)
    expect(isPollingFinished(active)).toBe(false)

    let terminal = applyTaskSnapshot(active, activeSnapshot({ state_revision: 11, phase: 'completed', completion_reason: 'user_abort' }))
    expect(isPatrolReview(terminal)).toBe(true)
    expect(isPatrolActive(terminal)).toBe(false)
    expect(isPollingFinished(terminal)).toBe(true)

    // 不返航终态
    terminal = applyTaskSnapshot(identifiedState(), activeSnapshot({ state_revision: 11, phase: 'manual_control' }))
    expect(isPollingFinished(terminal)).toBe(true)

    // rejected 停止轮询
    const rejected = applyTaskSnapshot(terminal, { link_state: 'rejected', task_uuid: 'task-1', reject_reason: 'notify_lost' })
    expect(isPollingFinished(rejected)).toBe(true)
    expect(isPatrolActive(rejected)).toBe(false)
    expect(isPatrolReview(rejected)).toBe(false)

    // dismissed 隐藏面板但轮询语义不变
    const dismissed = dismissPatrol(active)
    expect(isTaskVisible(dismissed)).toBe(false)
  })

  it('复检进度口径：completed + failed + skipped / total', () => {
    const state = applyTaskSnapshot(identifiedState(), activeSnapshot({
      target_stats: { total: 12, pending: 3, processing: 1, completed: 7, failed: 1, skipped: 0 },
    }))
    expect(recheckProgress(state)).toEqual({ done: 8, total: 12 })
    expect(recheckPercent(state)).toBe(67)
  })

  it('初检进度百分比', () => {
    let state = identifiedState()
    state = setInitialProgress(state, 13, 26)
    expect(initialPercent(state)).toBe(50)
    expect(initialPercent(identifiedState())).toBe(0)
  })
})
