// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { compressScreenshot } from './screenshot-compression'

describe('截图压缩', () => {
  it('小于 2MB 时保持原始 Blob，避免无谓重编码', async () => {
    const blob = new Blob(['frame'], { type: 'image/jpeg' })
    await expect(compressScreenshot(blob)).resolves.toBe(blob)
  })

  it('无图像解码能力时保留原图，由服务端配额返回明确错误', async () => {
    const original = globalThis.createImageBitmap
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: undefined })
    const blob = new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/jpeg' })
    await expect(compressScreenshot(blob)).resolves.toBe(blob)
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: original })
  })
})
