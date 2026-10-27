// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// @vitest-environment happy-dom
import { createApp, nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import PersonRoadRecordsPanel from './PersonRoadRecordsPanel.vue'

describe('personRoadRecordsPanel', () => {
  it('renders only the list preview URL without media counters', async () => {
    const root = document.createElement('div')
    createApp(PersonRoadRecordsPanel, { state: { selectedTrackingId: '', records: [{ trackingId: 't-1', folderId: 42, title: '行人上路抓拍', startedAt: 1, endedAt: 2, previewPhotoUrl: '/preview.jpg', originalPhotoUrl: '/original.jpg', closeReason: 'timeout', position: null, pending: true }] } }).mount(root)
    await nextTick()
    expect([...root.querySelectorAll('img')].map(image => image.getAttribute('src'))).toEqual(['/preview.jpg'])
    expect(root.querySelector('.record-card__placeholder')).toBeNull()
    expect(root.textContent).toContain('待回传')
    expect(root.textContent).not.toContain('照片')
  })
})
