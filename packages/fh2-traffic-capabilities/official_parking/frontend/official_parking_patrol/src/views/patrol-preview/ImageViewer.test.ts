// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// @vitest-environment happy-dom
import { createApp } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import ImageViewer from './ImageViewer.vue'

describe('image viewer', () => {
  it('使用大图弹窗替代 Fullscreen API，并忽略 Esc 关闭', () => {
    const root = document.createElement('div')
    const app = createApp(ImageViewer, { url: '/evidence.jpg' })
    app.mount(root)

    const dialog = root.querySelector('dialog') as HTMLDialogElement
    const showModal = vi.fn(() => dialog.setAttribute('open', ''))
    const close = vi.fn(() => dialog.removeAttribute('open'))
    dialog.showModal = showModal
    dialog.close = close

    ;(root.querySelector('button[aria-label="放大预览"]') as HTMLButtonElement).click()
    expect(showModal).toHaveBeenCalledOnce()
    expect(dialog.open).toBe(true)

    expect(dialog.dispatchEvent(new Event('cancel', { cancelable: true }))).toBe(false)
    expect(close).not.toHaveBeenCalled()
    expect(dialog.open).toBe(true)

    ;(dialog.querySelector('button[aria-label="退出大图"]') as HTMLButtonElement).click()
    expect(close).toHaveBeenCalledOnce()
    expect(dialog.open).toBe(false)

    app.unmount()
  })
})
