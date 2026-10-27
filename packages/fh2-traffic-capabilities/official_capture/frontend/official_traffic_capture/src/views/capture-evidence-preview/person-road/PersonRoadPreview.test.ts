// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// @vitest-environment happy-dom
import { createApp, nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import PersonRoadPreview from './PersonRoadPreview.vue'

describe('personRoadPreview', () => {
  it('shows only the name, time and media-library action above the original image', async () => {
    const root = document.createElement('div')
    const onSelectPhoto = vi.fn()
    const onOpenMediaLibrary = vi.fn()
    createApp(PersonRoadPreview, { state: { record: { trackingId: 't-1', folderId: 42, title: '行人上路', startedAt: 1, endedAt: 2, previewPhotoUrl: '/preview.jpg', originalPhotoUrl: '/original.jpg', closeReason: 'manual', position: null, pending: false }, photos: [{ url: '/original-1.jpg' }, { url: '/original-2.jpg' }], activeIndex: 0, loading: false, loadError: null }, onSelectPhoto, onOpenMediaLibrary }).mount(root)
    await nextTick()
    ;(root.querySelector('.pager button:last-of-type') as HTMLButtonElement).click()
    expect(onSelectPhoto).toHaveBeenCalledWith(1)
    expect(root.querySelector('video')).toBeNull()
    const mediaLibrary = root.querySelector('.media-library') as HTMLButtonElement
    expect(mediaLibrary.textContent).toBe('查看全部')
    mediaLibrary.click()
    expect(onOpenMediaLibrary).toHaveBeenCalledOnce()
    expect(root.textContent).toContain('行人上路')
    expect(root.textContent).not.toContain('#t-1')
    expect(root.textContent).not.toContain('远景')
    expect(root.textContent).not.toContain('近景')
  })

  it('hides the media-library action when no folder URL is available', async () => {
    const root = document.createElement('div')
    createApp(PersonRoadPreview, { state: { record: { trackingId: 't-1', folderId: 0, title: '行人上路', startedAt: 1, endedAt: null, previewPhotoUrl: null, originalPhotoUrl: null, closeReason: '', position: null, pending: true }, photos: [], activeIndex: 0, loading: false, loadError: null } }).mount(root)
    await nextTick()

    expect(root.querySelector('.media-library')).toBeNull()
    expect(root.querySelector('video')).toBeNull()
  })
})
