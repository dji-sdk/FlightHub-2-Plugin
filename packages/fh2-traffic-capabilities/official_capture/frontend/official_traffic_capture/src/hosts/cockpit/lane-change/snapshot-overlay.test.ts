// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import {
  type OverlayContext2d,
  type SnapshotOverlay,
  buildOverlayOps,
  composeSnapshotOverlay,
  paintOverlayOps,
} from './snapshot-overlay'

function fakeContext () {
  const calls: string[] = []
  const record = (name: string) => (...args: unknown[]): void => {
    calls.push(`${name}(${args.map(arg => JSON.stringify(arg)).join(', ')})`)
  }
  const context: OverlayContext2d = {
    drawImage: record('drawImage'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    closePath: record('closePath'),
    stroke: record('stroke'),
    fill: record('fill'),
    strokeRect: record('strokeRect'),
    setLineDash: record('setLineDash'),
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    lineJoin: 'bevel',
    lineCap: 'butt',
  }
  return { context, calls }
}

describe('buildOverlayOps', () => {
  it('实线生成黄色 polyline 指令，归一化点乘截图像素，线宽下限 2', () => {
    const overlay: SnapshotOverlay = {
      kind: 'line',
      normalizedPoints: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }],
    }
    expect(buildOverlayOps(overlay, 200, 100)).toEqual([{
      op: 'stroke-polyline',
      points: [{ x: 40, y: 50 }, { x: 160, y: 50 }],
      strokeStyle: '#FFD800',
      lineWidth: 2,
    }])
  })

  it('宽画幅线宽按 width/400 放大', () => {
    const overlay: SnapshotOverlay = {
      kind: 'line',
      normalizedPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    }
    expect(buildOverlayOps(overlay, 1600, 900)[0]).toMatchObject({ lineWidth: 4 })
  })

  it('导流区 3 点生成填充 + 描边指令', () => {
    const overlay: SnapshotOverlay = {
      kind: 'polygon',
      normalizedPoints: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
    }
    expect(buildOverlayOps(overlay, 400, 200)).toEqual([{
      op: 'fill-stroke-polygon',
      points: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 200 }],
      strokeStyle: '#FFD800',
      fillStyle: 'rgba(255, 216, 0, 0.15)',
      lineWidth: 2,
    }])
  })

  it('导流区不足 3 点退化为 polyline（与原生一致）', () => {
    const overlay: SnapshotOverlay = {
      kind: 'polygon',
      normalizedPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    }
    expect(buildOverlayOps(overlay, 400, 200)).toHaveLength(1)
    expect(buildOverlayOps(overlay, 400, 200)[0]).toMatchObject({ op: 'stroke-polyline' })
  })

  it('标线不足 2 点时不生成标线指令', () => {
    expect(buildOverlayOps({ kind: 'line', normalizedPoints: [] }, 400, 200)).toEqual([])
    expect(buildOverlayOps({ kind: 'line', normalizedPoints: [{ x: 0.5, y: 0.5 }] }, 400, 200)).toEqual([])
  })

  it('bbox 生成红框指令：中心换算左上角，宽高乘像素', () => {
    const overlay: SnapshotOverlay = {
      kind: 'line',
      normalizedPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      bbox: { cx: 0.5, cy: 0.5, w: 0.2, h: 0.1 },
    }
    expect(buildOverlayOps(overlay, 400, 200)).toEqual([
      expect.objectContaining({ op: 'stroke-polyline' }),
      {
        op: 'stroke-rect',
        x: 160,
        y: 90,
        width: 80,
        height: 20,
        strokeStyle: '#FF3B30',
        lineWidth: 2,
      },
    ])
  })

  it('bbox 缺省或零宽高不生成红框指令', () => {
    const points = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
    expect(buildOverlayOps({ kind: 'line', normalizedPoints: points }, 400, 200)).toHaveLength(1)
    expect(buildOverlayOps({ kind: 'line', normalizedPoints: points, bbox: { cx: 0.5, cy: 0.5, w: 0, h: 0.1 } }, 400, 200)).toHaveLength(1)
  })
})

describe('paintOverlayOps', () => {
  it('polyline：round 连接 + beginPath/moveTo/lineTo/stroke 序列', () => {
    const { context, calls } = fakeContext()
    paintOverlayOps(context, [{
      op: 'stroke-polyline',
      points: [{ x: 40, y: 50 }, { x: 160, y: 50 }],
      strokeStyle: '#FFD800',
      lineWidth: 3,
    }])
    expect(context.lineJoin).toBe('round')
    expect(context.lineCap).toBe('round')
    expect(context.lineWidth).toBe(3)
    expect(context.strokeStyle).toBe('#FFD800')
    expect(calls).toEqual([
      'beginPath()',
      'moveTo(40, 50)',
      'lineTo(160, 50)',
      'stroke()',
    ])
  })

  it('polygon：closePath 后先 fill 再 stroke', () => {
    const { context, calls } = fakeContext()
    paintOverlayOps(context, [{
      op: 'fill-stroke-polygon',
      points: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 200 }],
      strokeStyle: '#FFD800',
      fillStyle: 'rgba(255, 216, 0, 0.15)',
      lineWidth: 2,
    }])
    expect(context.fillStyle).toBe('rgba(255, 216, 0, 0.15)')
    expect(calls).toEqual([
      'beginPath()',
      'moveTo(0, 0)',
      'lineTo(400, 0)',
      'lineTo(400, 200)',
      'closePath()',
      'fill()',
      'stroke()',
    ])
  })

  it('rect：setLineDash 清空 + strokeRect，不触发路径绘制', () => {
    const { context, calls } = fakeContext()
    paintOverlayOps(context, [{
      op: 'stroke-rect',
      x: 160,
      y: 90,
      width: 80,
      height: 20,
      strokeStyle: '#FF3B30',
      lineWidth: 2,
    }])
    expect(context.strokeStyle).toBe('#FF3B30')
    expect(calls).toEqual([
      'setLineDash([])',
      'strokeRect(160, 90, 80, 20)',
    ])
  })
})

describe('composeSnapshotOverlay', () => {
  it('非浏览器环境（无 Image/canvas）返回 null 不抛错，可安全降级', async () => {
    const result = await composeSnapshotOverlay(new Blob(['frame']), {
      kind: 'line',
      normalizedPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    })
    expect(result).toBeNull()
  })
})
