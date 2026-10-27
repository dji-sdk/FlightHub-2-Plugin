// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { mergeRecords } from './model'

describe('mergeRecords', () => {
  it('只按 eventKey 精确合并本地截图，不按 crossedAt 猜测', () => {
    const local = [{ eventId: null, eventKey: 'key-a', collisionType: 'solid_line' as const, crossedAt: 100, title: '', screenshotUrl: 'blob:a', position: null, postStatus: 'submitting' as const, failureReason: '' }]
    const merged = mergeRecords([{ eventId: 'event-1', eventKey: 'key-b', crossedAt: 100, collisionType: 'guide_area', screenshotUrl: null, position: null, postStatus: 'verified', failureReason: '' }], local)
    expect(merged).toHaveLength(2)
    expect(merged.find(item => item.eventKey === 'key-b')?.screenshotUrl).toBeNull()
    expect(merged.find(item => item.eventKey === 'key-a')?.screenshotUrl).toBe('blob:a')
  })

  it('后端同 eventKey 合并本地截图并更新状态', () => {
    const local = [{ eventId: null, eventKey: 'key-a', collisionType: 'solid_line' as const, crossedAt: 100, title: '', screenshotUrl: 'blob:a', position: null, postStatus: 'submitting' as const, failureReason: '' }]
    const [record] = mergeRecords([{ eventId: 'event-1', eventKey: 'key-a', crossedAt: 100, collisionType: 'solid_line', screenshotUrl: null, position: null, postStatus: 'processing', failureReason: '' }], local)
    expect(record).toMatchObject({ eventId: 'event-1', eventKey: 'key-a', screenshotUrl: 'blob:a', postStatus: 'processing' })
  })

  it('追加实时截图时保留其他事件的上报状态', () => {
    const records = [
      { eventId: null, eventKey: 'key-a', collisionType: 'solid_line' as const, crossedAt: 100, title: '', screenshotUrl: 'blob:a', position: null, postStatus: 'submitting' as const, failureReason: '' },
      { eventId: null, eventKey: 'key-b', collisionType: 'guide_area' as const, crossedAt: 200, title: '', screenshotUrl: 'blob:b', position: null, postStatus: 'submitting' as const, failureReason: '' },
    ]
    const merged = mergeRecords([], records)
    expect(merged.map(record => record.postStatus)).toEqual(['submitting', 'submitting'])
  })
})
