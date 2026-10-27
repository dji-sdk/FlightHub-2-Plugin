// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// @vitest-environment happy-dom
import { createApp, nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import CaptureEvidencePreview from './CaptureEvidencePreview.vue'
import type { CaptureEvidencePreviewState } from './contract'

describe('captureEvidencePreview', () => {
  it('only switches child panels and forwards person photo selection', async () => {
    const state: CaptureEvidencePreviewState = {
      activePanel: 'person-road',
      laneChange: { record: null, screenshotUrl: null },
      personRoad: { record: { trackingId: 'tracking-1', folderId: 42, title: '行人上路抓拍', startedAt: 1, endedAt: 2, previewPhotoUrl: '/preview.jpg', originalPhotoUrl: '/original.jpg', closeReason: 'manual', position: null, pending: false }, photos: [{ url: '/original-1.jpg' }, { url: '/original-2.jpg' }], activeIndex: 0, loading: false, loadError: null },
    }
    const subscriptionDispose = vi.fn()
    const client = { state: { subscribe: (listener: (value: CaptureEvidencePreviewState) => void) => {
      listener(state)
      return { dispose: subscriptionDispose }
    } }, selectPersonRoadPhoto: vi.fn(), openPersonRoadMediaLibrary: vi.fn(async () => {}), close: vi.fn() }
    const root = document.createElement('div')
    const app = createApp(CaptureEvidencePreview, { client })
    app.mount(root)
    await nextTick()
    expect(root.querySelector('.person-preview')).not.toBeNull()
    expect(root.querySelector('.lane-preview')).toBeNull()
    ;(root.querySelector('.pager button:last-child') as HTMLButtonElement).click()
    expect(client.selectPersonRoadPhoto).toHaveBeenCalledWith({ index: 1 })
    ;(root.querySelector('.media-library') as HTMLButtonElement).click()
    expect(client.openPersonRoadMediaLibrary).toHaveBeenCalledOnce()
    app.unmount()
    expect(subscriptionDispose).toHaveBeenCalledOnce()
    expect(client.close).toHaveBeenCalledOnce()
  })
})
