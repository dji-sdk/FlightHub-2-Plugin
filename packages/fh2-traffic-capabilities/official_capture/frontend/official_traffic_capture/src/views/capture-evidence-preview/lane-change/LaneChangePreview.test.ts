// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// @vitest-environment happy-dom
import { createApp, nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import LaneChangePreview from './LaneChangePreview.vue'

describe('laneChangePreview', () => {
  it('renders only the local realtime screenshot', async () => {
    const root = document.createElement('div')
    createApp(LaneChangePreview, { state: { record: { eventId: 'e-1', eventKey: 'key', title: '变道抓拍', crossedAt: 1, collisionType: 'solid_line', screenshotUrl: 'data:image/png;base64,AAAA', position: null, postStatus: 'verified', failureReason: '' }, screenshotUrl: 'data:image/png;base64,AAAA' } }).mount(root)
    await nextTick()
    expect(root.querySelector('img')).not.toBeNull()
    expect(root.querySelector('video')).toBeNull()
  })
})
