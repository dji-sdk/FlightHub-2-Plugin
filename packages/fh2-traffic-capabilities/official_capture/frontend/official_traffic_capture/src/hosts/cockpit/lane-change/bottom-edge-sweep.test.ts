// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { sweepBottomEdge } from './bottom-edge-sweep'

describe('连续底边 × 有限线段', () => {
  it('检测底边中部，返回真实接触位置和时刻', () => {
    const contact = sweepBottomEdge({ left: 0.3, right: 0.7, y: 0.4 }, { left: 0.3, right: 0.7, y: 0.6 }, { x: 0.42, y: 0.5 }, { x: 0.44, y: 0.5 })!
    expect(contact.time[0]).toBeCloseTo(0.5)
    expect(contact.time[1]).toBeCloseTo(0.5)
    expect(contact.positions[0]).toBeCloseTo(0.3)
    expect(contact.positions[1]).toBeCloseTo(0.35)
  })

  it('底边高度不变、水平移动仍能跨竖线', () => {
    const contact = sweepBottomEdge({ left: 0.1, right: 0.2, y: 0.5 }, { left: 0.6, right: 0.7, y: 0.5 }, { x: 0.4, y: 0.3 }, { x: 0.4, y: 0.7 })!
    expect(contact.time[0]).toBeCloseTo(0.4)
    expect(contact.time[1]).toBeCloseTo(0.6)
    expect(contact.positions[0]).toBeCloseTo(0)
    expect(contact.positions[1]).toBeCloseTo(1)
  })

  it('宽度变化按线性插值求交，不使用前后最大包围框', () => {
    expect(sweepBottomEdge({ left: 0.1, right: 0.2, y: 0.2 }, { left: 0.6, right: 0.9, y: 0.8 }, { x: 0.1, y: 0.7 }, { x: 0.2, y: 0.7 })).toBeNull()
  })

  it('零宽底中心和反向标注使用相同语义', () => {
    const from = { left: 0.5, right: 0.5, y: 0.3 }
    const to = { left: 0.5, right: 0.5, y: 0.7 }
    const a = { x: 0.4, y: 0.4 }
    const b = { x: 0.6, y: 0.6 }
    expect(sweepBottomEdge(from, to, a, b)).toEqual(sweepBottomEdge(from, to, b, a))
    expect(sweepBottomEdge(from, to, a, b)?.positions).toEqual([0.5, 0.5])
  })

  it('共线滑行仅返回接触，零长度标注不产生接触', () => {
    const from = { left: 0.1, right: 0.2, y: 0.5 }
    const to = { left: 0.7, right: 0.8, y: 0.5 }
    expect(sweepBottomEdge(from, to, { x: 0.3, y: 0.5 }, { x: 0.4, y: 0.5 })).not.toBeNull()
    expect(sweepBottomEdge(from, to, { x: 0.3, y: 0.5 }, { x: 0.3, y: 0.5 })).toBeNull()
  })
})
