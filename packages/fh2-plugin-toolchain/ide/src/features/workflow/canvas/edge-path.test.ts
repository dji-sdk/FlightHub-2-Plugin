// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { orthogonalPath, previewPath } from './edge-path.js'

describe('orthogonalPath（Plan §4.5）', () => {
  it('纯直线段只用 L，不出现 Q', () => {
    const d = orthogonalPath([[0, 0], [0, 100]])
    expect(d).toBe('M 0 0 L 0 100')
    expect(d).not.toContain('Q')
  })

  it('拐角用二次曲线 Q，且半径被截取', () => {
    const d = orthogonalPath([[0, 0], [0, 100], [50, 100]])
    expect(d).toContain('Q')
    // 拐角点 (0,100)：前后各截 7 → 直线到 (0,93)，Q 到 (7,100)，再 L (50,100)
    expect(d).toBe('M 0 0 L 0 93 Q 0 100 7 100 L 50 100')
  })

  it('半径不超过前后段长度的一半（短段截半）', () => {
    // 前段长 4：截距 2；后段长 100：截距 7 → 取 2
    const d = orthogonalPath([[0, 0], [0, 4], [104, 4]])
    expect(d).toContain('L 0 2 Q 0 4 2 4')
  })

  it('连续两个拐角各自独立抹圆', () => {
    const d = orthogonalPath([[0, 0], [0, 40], [40, 40], [40, 80]])
    expect((d.match(/Q/g) ?? []).length).toBe(2)
  })

  it('共线中间点不额外产生拐角（只有一个真实拐角）', () => {
    const d = orthogonalPath([[0, 0], [0, 50], [0, 100], [30, 100]])
    expect((d.match(/Q/g) ?? []).length).toBe(1)
    expect(d).not.toContain('Q 0 50')
  })

  it('相邻重复点按直线处理（不产生 Q）', () => {
    const d = orthogonalPath([[0, 0], [0, 0], [0, 100], [30, 100]])
    expect((d.match(/Q/g) ?? []).length).toBe(1)
    expect(d.startsWith('M 0 0 L')).toBe(true)
  })

  it('空与单点输入不抛异常', () => {
    expect(orthogonalPath([])).toBe('')
    expect(orthogonalPath([[5, 5]])).toBe('M 5 5')
  })
})

describe('previewPath（Plan §5.3：连线预览正交两折线）', () => {
  /** 解析 path 里的直线段，断言全部水平或垂直（不允许对角线）。 */
  function assertOrthogonal (d: string): void {
    const commands = d.match(/[MLQ] [^MLQ]+/g) ?? []
    let current: readonly [number, number] | null = null
    for (const command of commands) {
      const [verb, ...args] = command.split(/[\s,]+/)
      if (verb === 'M') {
        current = [Number(args[0]), Number(args[1])]
        continue
      }
      const to: readonly [number, number] = verb === 'L'
        ? [Number(args[0]), Number(args[1])]
        : [Number(args[2]), Number(args[3])]
      if (verb === 'L') {
        expect(current).not.toBeNull()
        const diagonal = current![0] !== to[0] && current![1] !== to[1]
        expect(diagonal, `对角线段：${current} → ${to}`).toBe(false)
      }
      // Q 的端点允许跨轴（曲线本身只存在于拐角局部，Plan §4.5）
      current = to
    }
  }

  it('产出正交路径，不用对角线', () => {
    const d = previewPath([100, 50], [260, 210])
    expect(d).toContain('Q')
    assertOrthogonal(d)
    expect(d.endsWith('L 260 210')).toBe(true)
  })

  it('同 x 时退化为纯垂直线（共线中间点保留为 L）', () => {
    const d = previewPath([100, 50], [100, 210])
    expect(d).not.toContain('Q')
    expect(d.startsWith('M 100 50 L 100')).toBe(true)
    expect(d.endsWith('L 100 210')).toBe(true)
  })

  it('指针在起点上方（反向）时仍是正交路径', () => {
    const d = previewPath([100, 200], [150, 60])
    assertOrthogonal(d)
    expect(d.endsWith('L 150 60')).toBe(true)
  })
})
