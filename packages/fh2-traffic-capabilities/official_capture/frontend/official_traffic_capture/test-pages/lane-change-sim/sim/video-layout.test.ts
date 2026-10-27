// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { canvasToVideoNorm, computeLetterbox, videoToCanvasNorm } from './video-layout'

describe('video-layout letterbox 映射', () => {
  it('视频坐标 ↔ 画布坐标互为逆映射，角点落在内容区边界上', () => {
    // 1000x1000 视频放入 1600x900 画布：左右黑边 dx=350，内容区 900x900。
    const layout = computeLetterbox(1600, 900, 1000, 1000)
    expect(layout).toMatchObject({ dx: 350, dy: 0, dw: 900, dh: 900 })

    const center = videoToCanvasNorm(0.5, 0.5, layout)
    expect(center.x).toBeCloseTo(0.5, 8)
    expect(center.y).toBeCloseTo(0.5, 8)

    const topLeft = videoToCanvasNorm(0, 0, layout)
    expect(topLeft.x).toBeCloseTo(350 / 1600, 8)
    expect(topLeft.y).toBe(0)

    const back = canvasToVideoNorm(topLeft.x, topLeft.y, layout)
    expect(back?.x).toBeCloseTo(0, 8)
    expect(back?.y).toBeCloseTo(0, 8)
  })

  it('黑边与越界区域返回 null', () => {
    const layout = computeLetterbox(1600, 900, 1000, 1000)
    expect(canvasToVideoNorm(0.1, 0.5, layout)).toBeNull()
    expect(canvasToVideoNorm(0.9, 0.5, layout)).toBeNull()
    expect(canvasToVideoNorm(-0.1, 0.5, layout)).toBeNull()
    expect(canvasToVideoNorm(0.3, 0.5, layout)).not.toBeNull()
  })
})
