// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// @vitest-environment happy-dom
import { createApp, nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import LaneChangeRecordsPanel from './LaneChangeRecordsPanel.vue'

describe('laneChangeRecordsPanel', () => {
  it('owns lane status and realtime screenshot presentation', async () => {
    const root = document.createElement('div')
    createApp(LaneChangeRecordsPanel, { state: { selectedEventKey: '', records: [{ eventId: 'e-1', eventKey: 'event-key-1', title: '变道抓拍', crossedAt: 1, collisionType: 'solid_line', screenshotUrl: null, position: null, postStatus: 'failed', failureReason: '事件上报失败' }] } }).mount(root)
    await nextTick()
    expect(root.textContent).toContain('暂无实时截图')
    expect(root.textContent).toContain('压实线')
    expect(root.textContent).not.toContain('上报失败')
    expect(root.textContent).not.toContain('事件上报失败')
    expect(root.querySelector('[data-event-key="event-key-1"]')).not.toBeNull()
  })
})
