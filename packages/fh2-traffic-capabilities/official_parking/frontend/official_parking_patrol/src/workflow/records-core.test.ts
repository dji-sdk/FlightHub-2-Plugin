// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import type { PatrolTarget, PatrolTargetStats } from '../api/types'
import {
  buildPatrolRecordGroup,
  formatClockTime,
  formatMinute,
  mapTargetBadge,
  recheckDoneCount,
  toPatrolRecordItem,
} from './records-core'

function target (id: string, overrides: Partial<PatrolTarget> = {}): PatrolTarget {
  return {
    target_id: id,
    status: 'pending',
    display_name: `粤B·${id}`,
    vehicle_class: 'car',
    lat: 22.5312,
    lng: 113.9502,
    best_frame_thumb_url: `https://thumb/${id}`,
    photo_taken_at_ms: new Date('2026-08-30T08:36:02Z').getTime(),
    fail_reason: '',
    ...overrides,
  }
}

const STATS: PatrolTargetStats = { total: 3, pending: 1, processing: 1, completed: 1, failed: 0, skipped: 0 }

describe('时间格式化', () => {
  it('formatMinute：YYYY-MM-DD HH:mm', () => {
    expect(formatMinute(new Date('2026-08-30T08:36:02Z').getTime())).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('formatClockTime：HH:mm:ss', () => {
    expect(formatClockTime(new Date('2026-08-30T08:36:02Z').getTime())).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })
})

describe('mapTargetBadge', () => {
  it('六态映射与现网一字不差', () => {
    expect(mapTargetBadge('pending')).toEqual({ text: '待复检', type: 'orange' })
    expect(mapTargetBadge('in_progress')).toEqual({ text: '复检中', type: 'blue' })
    expect(mapTargetBadge('photo_pending')).toEqual({ text: '复检照片回传中', type: 'red' })
    expect(mapTargetBadge('completed')).toEqual({ text: '取证完整', type: 'green' })
    expect(mapTargetBadge('failed')).toEqual({ text: '复检失败', type: 'gray' })
    expect(mapTargetBadge('skipped_no_car')).toEqual({ text: '目标消失', type: 'gray' })
    expect(mapTargetBadge(undefined)).toBeNull()
    expect(mapTargetBadge('unknown')).toBeNull()
  })
})

describe('toPatrolRecordItem', () => {
  it('字段映射：缩略图为初检最佳帧，时间为拍照时间', () => {
    const card = toPatrolRecordItem(target('88', { status: 'completed' }))
    expect(card).toMatchObject({
      id: '88',
      targetId: '88',
      thumbUrl: 'https://thumb/88',
      displayName: '粤B·88',
      badgeText: '取证完整',
      badgeType: 'green',
    })
    expect(card.displayTime).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })

  it('无车牌号时显示待识别车牌；无拍照时间显示空串', () => {
    const card = toPatrolRecordItem(target('88', { status: 'pending', display_name: '', photo_taken_at_ms: 0 }))
    expect(card.displayName).toBe('待识别车牌')
    expect(card.displayTime).toBe('')
  })
})

describe('recheckDoneCount', () => {
  it('completed + failed + skipped（含失败与消失）', () => {
    expect(recheckDoneCount({ total: 12, pending: 3, processing: 1, completed: 7, failed: 1, skipped: 0 })).toBe(8)
    expect(recheckDoneCount({ total: 5, pending: 0, processing: 0, completed: 2, failed: 1, skipped: 2 })).toBe(5)
  })
})

describe('buildPatrolRecordGroup', () => {
  it('尚无目标时返回 null（空态）', () => {
    expect(buildPatrolRecordGroup({
      taskUuid: 'task-1',
      targets: [],
      targetStats: STATS,
      routeName: '福华路南段',
      startedAtMs: 1000,
      isActive: true,
    })).toBeNull()
  })

  it('构建当前任务分组：statText 用已处理口径，时间为任务开始时间（不依赖目标拍照时间）', () => {
    const group = buildPatrolRecordGroup({
      taskUuid: 'task-1',
      targets: [
        target('88', { status: 'completed', photo_taken_at_ms: 2000 }),
        target('99', { status: 'pending', photo_taken_at_ms: 1000 }),
      ],
      targetStats: STATS,
      routeName: '福华路南段',
      startedAtMs: 3000,
      isActive: true,
    })
    expect(group).toMatchObject({
      id: 'task-1',
      routeName: '福华路南段',
      isActive: true,
      statText: '1/3',
    })
    expect(group?.timeText).toBe(formatMinute(3000))
    expect(group?.items.map(item => item.targetId)).toEqual(['88', '99'])
  })

  it('任务开始时间缺失时显示占位 --', () => {
    const group = buildPatrolRecordGroup({
      taskUuid: 'task-1',
      targets: [target('88')],
      targetStats: STATS,
      routeName: '福华路南段',
      startedAtMs: 0,
      isActive: false,
    })
    expect(group?.timeText).toBe('--')
  })

  it('路段名空白时显示占位 --', () => {
    const group = buildPatrolRecordGroup({
      taskUuid: 'task-1',
      targets: [target('88')],
      targetStats: STATS,
      routeName: '  ',
      startedAtMs: 1000,
      isActive: false,
    })
    expect(group?.routeName).toBe('--')
  })
})
