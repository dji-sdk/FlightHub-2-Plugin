// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import type { RecordsState } from '../../views/patrol-records/contract'
import type { PatrolTaskState } from '../../workflow/patrol-session'
import { createInitialPatrolState } from '../../workflow/patrol-session'
import {
  completionText,
  createTaskViewUpdater,
  rejectText,
  toTaskPanelState,
} from './task-view'

function taskState (overrides: Partial<PatrolTaskState> = {}): PatrolTaskState {
  return { ...createInitialPatrolState(), ...overrides }
}

function target (): PatrolTaskState['targets'][number] {
  return {
    target_id: 't-1',
    status: 'pending',
    display_name: '粤B·12345',
    vehicle_class: 'car',
    lat: 22.5,
    lng: 113.9,
    best_frame_thumb_url: 'https://thumb',
    photo_taken_at_ms: 1756542962000,
    fail_reason: '',
  }
}

describe('rejectText', () => {
  it('映射已知原因并为未知值提供可诊断文案', () => {
    expect(rejectText('route_not_patrol')).toBe('该航线不支持违停抓拍，飞行任务仍会正常执行')
    expect(rejectText('custom_reason')).toBe('custom_reason')
    expect(rejectText('')).toBe('巡逻流程未能启动')
  })
})

describe('completionText', () => {
  it('映射已知原因码为中文文案', () => {
    expect(completionText('')).toBe('已完成')
    expect(completionText('user_abort')).toBe('已终止')
    expect(completionText('return_home_failed')).toBe('返航失败')
    expect(completionText('flight_ended')).toBe('架次已结束')
    expect(completionText('startup_cleanup_stuck')).toBe('启动清理未完成')
    expect(completionText('all_done')).toBe('已完成')
    expect(completionText('mode_code_return_home')).toBe('飞机已返航')
    expect(completionText('timeout_60min')).toBe('任务超时')
    expect(completionText('aborted')).toBe('已中止')
  })

  it('未知原因码兜底为异常结束', () => {
    expect(completionText('battery_low')).toBe('异常结束')
    expect(completionText('电池低电量')).toBe('异常结束')
  })
})

describe('toTaskPanelState', () => {
  it('将 waiting 和 rejected 任务转换为对应面板状态', () => {
    expect(toTaskPanelState(taskState({ taskUuid: 'task-1' }))).toMatchObject({
      preparing: true,
      showProgress: false,
      showEndButton: false,
    })
    expect(toTaskPanelState(taskState({
      taskUuid: 'task-1',
      linkState: 'rejected',
      rejectReason: 'dock_mismatch',
    }))).toMatchObject({ rejected: true, rejectText: '机场与航线不匹配' })
  })

  it('拒绝态即使残留 completed 阶段也不显示任务完成', () => {
    expect(toTaskPanelState(taskState({
      taskUuid: 'task-1',
      linkState: 'rejected',
      rejectReason: 'notify_lost',
      phase: 'completed',
    }))).toMatchObject({
      phase: null,
      preparing: false,
      rejected: true,
      rejectText: '巡逻未接管，服务异常',
      showProgress: false,
      showEndButton: false,
      isReview: false,
      reviewText: '',
    })
  })

  it('将活跃任务转换为进度和操作状态', () => {
    const panel = toTaskPanelState(taskState({
      taskUuid: 'task-1',
      linkState: 'active',
      phase: 'phase1',
      initialDone: 3,
      initialTotal: 12,
      targetStats: { total: 2, pending: 2, processing: 0, completed: 0, failed: 0, skipped: 0 },
      allowedActions: ['abort'],
    }))
    expect(panel).toMatchObject({
      initialLabel: '初检 — 已执行航点（3/12）',
      recheckLabel: '复检 — 已处理车辆（0/2）',
      initialActive: true,
      showEndButton: true,
      endButtonDisabled: false,
    })
  })

  it('将终态转换为明确的回顾结论', () => {
    const base = { taskUuid: 'task-1', linkState: 'active' as const, phase: 'completed' as const }
    expect(toTaskPanelState(taskState(base)).reviewText).toBe('任务完成')
    expect(toTaskPanelState(taskState({ ...base, completionReason: 'user_abort' })).reviewText).toBe('任务已终止')
    expect(toTaskPanelState(taskState({ ...base, phase: 'manual_control' })).reviewText).toBe('已转人工控制')
    expect(toTaskPanelState(taskState({ ...base, phase: 'failed', completionReason: '电池低电量' })).reviewText).toBe('任务失败：异常结束')
    expect(toTaskPanelState(taskState({ ...base, phase: 'failed', completionReason: 'return_home_failed' })).reviewText).toBe('任务失败：返航失败')
    expect(toTaskPanelState(taskState({ ...base, phase: 'failed', completionReason: 'startup_cleanup_stuck' })).reviewText).toBe('任务失败：启动清理未完成')
    expect(toTaskPanelState(taskState({ ...base, phase: 'failed', completionReason: '' })).reviewText).toBe('任务失败')
  })
})

describe('createTaskViewUpdater', () => {
  function setup () {
    const recordsUpdates: RecordsState[] = []
    const overlayUpdates: Array<{ visible: boolean }> = []
    const viewUpdater = createTaskViewUpdater({
      recordsState: {
        update: (updater) => {
          recordsUpdates.push(updater({ group: null, activeTargetId: '' }))
        },
      },
      taskOverlay: {
        update: async (patch) => {
          overlayUpdates.push(patch)
        },
      },
    })
    return { recordsUpdates, overlayUpdates, viewUpdater }
  }

  it('按任务阶段更新面板可见性', async () => {
    const { viewUpdater, overlayUpdates } = setup()
    await viewUpdater.updateTaskOverlay(taskState({ taskUuid: 'task-1' }))
    await viewUpdater.updateTaskOverlay(taskState({ taskUuid: 'task-1', phase: 'phase1' }))
    await viewUpdater.updateTaskOverlay(taskState({ taskUuid: 'task-1', phase: 'phase1', patrolDismissed: true }))
    expect(overlayUpdates).toEqual([
      { visible: true },
      { visible: true },
      { visible: false },
    ])
  })

  it('根据任务目标更新记录面板', () => {
    const { viewUpdater, recordsUpdates } = setup()
    viewUpdater.updateRecordsPanel(taskState({
      taskUuid: 'task-1',
      routeName: '福华路南段',
      phase: 'phase1',
      targetStats: { total: 1, pending: 1, processing: 0, completed: 0, failed: 0, skipped: 0 },
      targets: [target()],
    }))
    viewUpdater.updateRecordsPanel(taskState({ taskUuid: 'task-1' }))
    expect(recordsUpdates[0]!.group).toMatchObject({ id: 'task-1', routeName: '福华路南段', statText: '0/1' })
    expect(recordsUpdates[1]!.group).toBeNull()
  })
})
