// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { CanvasInteraction, FIT_PADDING, MAX_SCALE, MIN_SCALE } from './interaction.js'
import type { InteractionHost } from './interaction.js'

interface Harness {
  readonly interaction: CanvasInteraction;
  readonly events: {
    viewportChanges: number;
    previews: Array<{ from: string; pointer: { x: number; y: number } | null }>;
    commits: Array<{ from: string; targetId: string | null }>;
    blankPresses: number;
  };
}

function harness (layout: { nodes?: Array<{ id: string; x: number; y: number }> }): Harness {
  const events = {
    viewportChanges: 0,
    previews: [] as Array<{ from: string; pointer: { x: number; y: number } | null }>,
    commits: [] as Array<{ from: string; targetId: string | null }>,
    blankPresses: 0,
  }
  const host: InteractionHost = {
    size: () => ({ width: 1000, height: 600 }),
    hitTest: (x, y) => layout.nodes?.find(node =>
      Math.abs(x - node.x) <= 50 && Math.abs(y - node.y) <= 50)?.id ?? null,
    onViewportChange: () => {
      events.viewportChanges += 1
    },
    onLinkPreview: (from, pointer) => {
      events.previews.push({ from, pointer })
    },
    onLinkCommit: (from, targetId) => {
      events.commits.push({ from, targetId })
    },
    onBlankPress: () => {
      events.blankPresses += 1
    },
  }
  return { interaction: new CanvasInteraction(host), events }
}

describe('canvasInteraction：坐标换算与缩放（Plan §6.1）', () => {
  it('toCanvas：宿主内坐标按视口换算', () => {
    const { interaction } = harness({})
    interaction.setViewport({ x: 100, y: 50, scale: 2 })
    const point = interaction.toCanvas(300, 250)
    expect(point).toEqual({ x: 100, y: 100 })
  })

  it('zoomAt：锚点在画布坐标系里保持不动', () => {
    const { interaction } = harness({})
    interaction.setViewport({ x: 0, y: 0, scale: 1 })
    interaction.zoomAt(500, 300, 2)
    const viewport = interaction.getViewport()
    expect(viewport.scale).toBe(2)
    // 画布点 (500,300) → 屏幕 500*2 + x = 原屏幕 500 → x = -500
    expect(viewport.x).toBe(-500)
    expect(viewport.y).toBe(-300)
    // 锚点换算回画布仍是 (500,300)
    const anchor = interaction.toCanvas(500, 300)
    expect(anchor.x).toBeCloseTo(500)
    expect(anchor.y).toBeCloseTo(300)
  })

  it('缩放被钳在 [MIN_SCALE, MAX_SCALE]', () => {
    const { interaction } = harness({})
    interaction.setViewport({ x: 0, y: 0, scale: 1 })
    interaction.zoomAt(0, 0, 0.0001)
    expect(interaction.getViewport().scale).toBe(MIN_SCALE)
    interaction.zoomAt(0, 0, 100000)
    expect(interaction.getViewport().scale).toBe(MAX_SCALE)
  })

  it('fit：整图可见并留出边距；空内容退回 1:1', () => {
    const { interaction } = harness({})
    interaction.fit(800, 400)
    const viewport = interaction.getViewport()
    expect(viewport.scale).toBeLessThanOrEqual(1)
    expect(viewport.x).toBeGreaterThanOrEqual(FIT_PADDING - 0.01)
    expect(viewport.y).toBeGreaterThanOrEqual(FIT_PADDING - 0.01)
    interaction.fit(0, 0)
    expect(interaction.getViewport().scale).toBe(1)
  })

  it('reveal：目标已在视口内不动视口，不在时居中', () => {
    const { interaction } = harness({})
    interaction.setViewport({ x: 0, y: 0, scale: 1 })
    // (300,200) ± 50 全部落在 1000×600 视口内 → 不动
    interaction.reveal({ x: 300, y: 200 }, { x: 50, y: 50 })
    expect(interaction.getViewport()).toEqual({ x: 0, y: 0, scale: 1 })
    interaction.reveal({ x: 2000, y: 2000 }, { x: 106, y: 52 })
    const viewport = interaction.getViewport()
    expect(viewport.x).toBe(500 - 2000)
    expect(viewport.y).toBe(300 - 2000)
  })
})

describe('canvasInteraction：手势状态机（Plan §5.3）', () => {
  it('空白左键按下 → 拖动平移 → 松手结束；左键同时触发 onBlankPress', () => {
    const { interaction, events } = harness({})
    interaction.pressBlank(100, 100, 0)
    expect(events.blankPresses).toBe(1)
    interaction.move(180, 140)
    const viewport = interaction.getViewport()
    expect(viewport.x).toBe(80)
    expect(viewport.y).toBe(40)
    interaction.release(200, 160)
    interaction.move(300, 300)
    // 松手后不再平移
    expect(interaction.getViewport()).toEqual(viewport)
  })

  it('右键按下不启手势也不清选中', () => {
    const { interaction, events } = harness({})
    interaction.pressBlank(100, 100, 2)
    interaction.move(200, 200)
    expect(events.blankPresses).toBe(0)
    expect(interaction.getViewport().x).toBe(0)
  })

  it('连线：把手按下 → 预览更新 → 命中目标松手提交 onConnect', () => {
    const { interaction, events } = harness({ nodes: [{ id: 'target', x: 500, y: 200 }] })
    interaction.pressLink('source', 100, 100)
    interaction.move(510, 205)
    expect(events.previews.length).toBe(2)
    expect(events.previews[1]!.pointer).toEqual({ x: (510 - 0) / 1, y: 205 })
    interaction.release(505, 200)
    expect(events.commits).toEqual([{ from: 'source', targetId: 'target' }])
    // 提交后预览清除
    expect(events.previews.at(-1)!.pointer).toBeNull()
  })

  it('连线松手在空白上：静默丢弃（不提交）', () => {
    const { interaction, events } = harness({})
    interaction.pressLink('source', 100, 100)
    interaction.release(900, 500)
    expect(events.commits).toEqual([{ from: 'source', targetId: null }])
  })

  it('cancel 丢弃手势且不提交（pointercancel 语义，P2-4）', () => {
    const { interaction, events } = harness({ nodes: [{ id: 'target', x: 500, y: 200 }] })
    interaction.pressLink('source', 100, 100)
    interaction.cancel()
    interaction.release(505, 200)
    expect(events.commits).toHaveLength(0)
    expect(events.previews.at(-1)!.pointer).toBeNull()
  })

  it('wheel 缩放（行滚动 ×16 归一）', () => {
    const { interaction } = harness({})
    interaction.setViewport({ x: 0, y: 0, scale: 1 })
    interaction.wheel(500, 300, -100, 0)
    expect(interaction.getViewport().scale).toBeGreaterThan(1)
    interaction.wheel(500, 300, 10, 1)
    expect(interaction.getViewport().scale).toBeLessThan(2)
  })
})
