// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { type CoreRegion, type Point2D, createDetectorCore, segmentsIntersect } from './detector-core'

const line = (points: Array<{ x: number; y: number }>): CoreRegion => ({ id: 'line', kind: 'line', valid: true, points })
const horizontal = line([{ x: 0.4, y: 0.5 }, { x: 0.6, y: 0.5 }])

function run (region: CoreRegion, boxes: Array<[number, number, number, number]>) {
  const core = createDetectorCore()
  return boxes.flatMap(([cx, cy, w, h], sequence) => core.processFrame({
    now: sequence * 100,
    sequence,
    continuous: true,
    regions: [region],
    bboxes: [{ objId: 1002, rect: { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 } }],
  }))
}

/** 独立 oracle：中央带边界点的弦必须穿过有限线段，并明确到达对侧。 */
function centralBandCrossesFiniteSegment (a: Point2D, b: Point2D, from: Point2D, to: Point2D, w: number, h: number) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  const normal = { x: -dy / length, y: dx / length }
  return [0.4, 0.6].some((position) => {
    const fromPoint = { x: from.x + (position - 0.5) * w, y: from.y + h / 2 }
    const toPoint = { x: to.x + (position - 0.5) * w, y: to.y + h / 2 }
    const fromDistance = (fromPoint.x - a.x) * normal.x + (fromPoint.y - a.y) * normal.y
    const toDistance = (toPoint.x - a.x) * normal.x + (toPoint.y - a.y) * normal.y
    const side = Math.sign(fromDistance)
    return Math.abs(fromDistance) > 1e-10
      && -side * toDistance >= -1e-10
      && segmentsIntersect(fromPoint, toPoint, a, b)
  })
}

const angles = Array.from({ length: 36 }, (_, index) => index * 5)
const sizes = [[0.008, 0.012], [0.013, 0.02], [0.04, 0.06], [0.16, 0.30], [0.30, 0.08]] as const

describe('实线连续底边几何回归', () => {
  it('原录像 ID 1002：中心换侧、底边在标注端点外，不触发', () => {
    // DJI_20260916141527_0001_V.mp4，70.370～70.737s 原始 djmd 万分比 bbox。
    const region = line([
      { x: 0.29364390578439165, y: 0.9510057843391176 },
      { x: 0.6688555631755588, y: 0.20232236898903566 },
      { x: 0.6688555631755588, y: 0.20232236898903566 },
    ])
    expect(run(region, [
      [0.4179, 0.6586, 0.3525, 0.6706],
      [0.4266, 0.6542, 0.3457, 0.6779],
      [0.4371, 0.6509, 0.3379, 0.6840],
      [0.4460, 0.6491, 0.3390, 0.6866],
      [0.4494, 0.6473, 0.3352, 0.6921],
    ])).toEqual([])
  })

  it('底边局部穿过短线段，但中央带只穿延长线，不触发', () => {
    const short = line([{ x: 0.42, y: 0.5 }, { x: 0.44, y: 0.5 }])
    expect(run(short, [
      [0.5, 0.35, 0.4, 0.1],
      [0.5, 0.35, 0.4, 0.1],
      [0.5, 0.35, 0.4, 0.1],
      [0.5, 0.55, 0.4, 0.1],
    ])).toEqual([])
  })

  it('底边中央带边界实际穿过短线段时触发', () => {
    const short = line([{ x: 0.42, y: 0.5 }, { x: 0.44, y: 0.5 }])
    expect(run(short, [
      [0.5, 0.35, 0.4, 0.1],
      [0.5, 0.35, 0.4, 0.1],
      [0.5, 0.35, 0.4, 0.1],
      [0.44, 0.55, 0.4, 0.1],
    ])).toMatchObject([{ rule: 'line-enter', crossedAt: 300 }])
  })

  it('右角穿过真实端点附近，但中央带只穿延长线，不触发', () => {
    expect(run(horizontal, [
      [0.45, 0.555, 0.04, 0.06],
      [0.45, 0.555, 0.04, 0.06],
      [0.45, 0.555, 0.04, 0.06],
      [0.37, 0.445, 0.04, 0.06],
    ])).toEqual([])
  })

  it.each([
    ['39.9%', 0.4798, 0],
    ['40%', 0.48, 1],
    ['40.1%', 0.4802, 1],
  ] as const)('默认参数边界：底边越过 %s', (_name, toCx, expected) => {
    const core = createDetectorCore()
    const vertical = line([{ x: 0.5, y: 0.1 }, { x: 0.5, y: 0.9 }])
    const events = [0.4, 0.4, 0.4, toCx].flatMap((cx, sequence) => core.processFrame({
      now: sequence * 100,
      sequence,
      continuous: true,
      regions: [vertical],
      bboxes: [{ objId: 1, rect: { x1: cx - 0.1, x2: cx + 0.1, y1: 0.4, y2: 0.5 } }],
    }))
    expect(events).toHaveLength(expected)
  })

  it('原录像 ID 378：角点越线 8.02%、全轨迹未达中央带，不触发', () => {
    const region = line([
      { x: 0.41016926522264235, y: 0.9841578174911508 },
      { x: 0.7473159718639809, y: 0.01722351722351723 },
    ])
    expect(run(region, [
      [0.6747, 0.0580, 0.0851, 0.1168],
      [0.6757, 0.0541, 0.0853, 0.1162],
      [0.6771, 0.0511, 0.0847, 0.1129],
      [0.6786, 0.0503, 0.0848, 0.1116],
      [0.6804, 0.0493, 0.0849, 0.1080],
      [0.6831, 0.0482, 0.0845, 0.1029],
      [0.7203, 0.0119, 0.0886, 0.0262],
      [0.7223, 0.0100, 0.0907, 0.0234],
    ])).toEqual([])
  })

  it('20m 录制 ID 344：相邻有效 bbox 间隔 952ms 仍连接并检出', () => {
    const region = line([
      { x: 0.5119347457987146, y: 0.4430153626295105 },
      { x: 0.7224572285171541, y: 0.3715612718828153 },
      { x: 0.7224572285171541, y: 0.3715612718828153 },
    ])
    const core = createDetectorCore()
    const frames = [
      [15501, 55, 0.53645, 0.5474, 0.0117, 0.0250],
      [15592, 56, 0.53595, 0.53935, 0.0113, 0.0243],
      [15904, 57, 0.5347, 0.51685, 0.0110, 0.0225],
      [16279, 58, 0.5326, 0.4891, 0.0102, 0.0206],
      [16535, 59, 0.5315, 0.4705, 0.0097, 0.0194],
      [17487, 60, 0.5281, 0.4147, 0.0084, 0.0162],
    ] as const
    const events = frames.flatMap(([now, sequence, cx, cy, w, h]) => core.processFrame({
      now,
      sequence,
      continuous: true,
      regions: [region],
      bboxes: [{ objId: 344, rect: { x1: cx - w / 2, x2: cx + w / 2, y1: cy - h / 2, y2: cy + h / 2 } }],
    }))
    expect(events).toEqual([{ objId: 344, regionId: 'line', rule: 'line-enter', crossedAt: 17487 }])
  })

  it('初见底边已部分压线，中央带边界随后明确跨过仍检出', () => {
    const vertical = line([{ x: 0.5, y: 0.1 }, { x: 0.5, y: 0.9 }])
    expect(run(vertical, [
      [0.45, 0.4, 0.3, 0.1],
      [0.45, 0.42, 0.3, 0.1],
      [0.45, 0.44, 0.3, 0.1],
      [0.56, 0.46, 0.3, 0.1],
    ])).toMatchObject([{ rule: 'line-enter' }])
  })

  it('底边持续移动压线超过清除时间，中央带后来穿线也不重复上报', () => {
    const vertical = line([{ x: 0.5, y: 0.1 }, { x: 0.5, y: 0.9 }])
    const boxes: Array<[number, number, number, number]> = [
      [0.38, 0.3, 0.2, 0.1],
      [0.38, 0.31, 0.2, 0.1],
      [0.38, 0.32, 0.2, 0.1],
      [0.42, 0.33, 0.2, 0.1],
    ]
    for (let i = 0; i < 15; i++) boxes.push([0.45, 0.34 + i * 0.01, 0.2, 0.1])
    boxes.push([0.56, 0.5, 0.2, 0.1])
    expect(run(vertical, boxes)).toHaveLength(1)
  })

  it('在端点外换侧再沿线进入，不把多帧路径连成虚构穿线', () => {
    expect(run(horizontal, [
      [0.3, 0.35, 0.04, 0.06],
      [0.3, 0.35, 0.04, 0.06],
      [0.3, 0.35, 0.04, 0.06],
      [0.3, 0.6, 0.04, 0.06],
      [0.5, 0.6, 0.04, 0.06],
    ])).toEqual([])
  })

  it.each([33, 100, 280])('水平底边主动浅穿后退回，%i ms 在穿线帧触发一次', (interval) => {
    const core = createDetectorCore()
    const events = [0.4, 0.4, 0.4, 0.499, 0.502, 0.501, 0.49, 0.4].flatMap((bottom, sequence) => core.processFrame({
      now: sequence * interval,
      sequence,
      continuous: true,
      regions: [horizontal],
      bboxes: [{ objId: 1, rect: { x1: 0.3, x2: 0.7, y1: bottom - 0.1, y2: bottom } }],
    }))
    expect(events).toEqual([{ objId: 1, regionId: 'line', rule: 'line-enter', crossedAt: 4 * interval }])
  })

  it('尺寸变化使整条底边扫过标线，但中心没有主动位移，不触发', () => {
    expect(run(horizontal, [
      [0.5, 0.4, 0.2, 0.1],
      [0.5, 0.4, 0.2, 0.1],
      [0.5, 0.4, 0.2, 0.1],
      [0.5, 0.4, 0.2, 0.3],
      [0.55, 0.4, 0.2, 0.3],
      [0.6, 0.4, 0.2, 0.3],
    ])).toEqual([])
  })

  it('标线漂移扫过静止 bbox 不触发', () => {
    const core = createDetectorCore()
    const events = [0.6, 0.6, 0.6, 0.5, 0.4].flatMap((y, sequence) => core.processFrame({
      now: sequence * 100,
      sequence,
      continuous: true,
      regions: [line([{ x: 0.3, y }, { x: 0.7, y }])],
      bboxes: [{ objId: 1, rect: { x1: 0.4, x2: 0.6, y1: 0.3, y2: 0.55 } }],
    }))
    expect(events).toEqual([])
  })

  it.each(angles)('%i°：完整端点矩阵与扫掠梯形 oracle 一致', (deg) => {
    const rad = deg * Math.PI / 180
    const tangent = { x: Math.cos(rad), y: Math.sin(rad) }
    const normal = { x: -tangent.y, y: tangent.x }
    const a = { x: 0.5 - 0.1 * tangent.x, y: 0.5 - 0.1 * tangent.y }
    const b = { x: 0.5 + 0.1 * tangent.x, y: 0.5 + 0.1 * tangent.y }
    for (const [w, h] of sizes) {
      const distance = (Math.abs(normal.x) * w + Math.abs(normal.y) * h) / 2 + 0.025
      for (const sign of [-1, 1]) {
        for (let offset = -5; offset <= 5; offset++) {
          for (const shift of [-0.08, 0, 0.08]) {
            const from = {
              x: 0.5 + normal.x * sign * distance + tangent.x * offset * 0.05,
              y: 0.5 + normal.y * sign * distance + tangent.y * offset * 0.05,
            }
            const to = {
              x: 0.5 - normal.x * sign * distance + tangent.x * (offset * 0.05 + shift),
              y: 0.5 - normal.y * sign * distance + tangent.y * (offset * 0.05 + shift),
            }
            const expected = centralBandCrossesFiniteSegment(a, b, from, to, w, h)
            const boxes: Array<[number, number, number, number]> = [
              [from.x, from.y, w, h],
              [from.x, from.y, w, h],
              [from.x, from.y, w, h],
              [to.x, to.y, w, h],
            ]
            const events = run(line([a, b]), boxes)
            const context = JSON.stringify({ deg, w, h, sign, offset, shift })
            expect(events.length, context).toBe(expected ? 1 : 0)
            expect(run(line([b, a]), boxes), `${context} 反向标注`).toEqual(events)
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
            expect(run(line([a, mid, mid, b]), boxes), `${context} 共线拆段/重复点`).toEqual(events)
            const moved = boxes.map(([cx, cy, width, height]): [number, number, number, number] => [cx + 0.02, cy - 0.015, width, height])
            expect(run(line([a, b].map(p => ({ x: p.x + 0.02, y: p.y - 0.015 }))), moved), `${context} 整体平移`).toEqual(events)
          }
        }
      }
    }
  })

  it.each(angles)('%i°：中部双向跨线、同侧直行、不同采样率', (deg) => {
    const rad = deg * Math.PI / 180
    const t = { x: Math.cos(rad), y: Math.sin(rad) }
    const n = { x: -t.y, y: t.x }
    const region = line([{ x: 0.5 - 0.45 * t.x, y: 0.5 - 0.45 * t.y }, { x: 0.5 + 0.45 * t.x, y: 0.5 + 0.45 * t.y }])
    for (const [w, h] of sizes) {
      const distance = (Math.abs(n.x) * w + Math.abs(n.y) * h) / 2 + 0.025
      for (const sign of [-1, 1]) {
        for (const interval of [33, 100, 280]) {
          for (const crossing of [true, false]) {
            const core = createDetectorCore()
            const events = []
            for (let sequence = 0; sequence < 12; sequence++) {
              const u = Math.max(0, (sequence - 2) / 9)
              const d = sign * distance * (crossing ? 1 - 2 * u : 1)
              const along = 0.05 * (u - 0.5)
              const cx = 0.5 + n.x * d + t.x * along
              const cy = 0.5 + n.y * d + t.y * along
              events.push(...core.processFrame({
                now: sequence * interval,
                sequence,
                continuous: true,
                regions: [region],
                bboxes: [{ objId: 1, rect: { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 } }],
              }))
            }
            expect(events.length, JSON.stringify({ deg, w, h, sign, interval, crossing })).toBe(crossing ? 1 : 0)
          }
        }
      }
    }
  })
})
