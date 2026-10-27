// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { classifyBboxPolygonOverlap, polygonToTurfFeature } from './bbox-polygon-overlap'
import { type CoreRegion, DEFAULT_DETECTOR_PARAMS, createDetectorCore } from './detector-core'

const HORIZONTAL_LINE: CoreRegion = {
  id: 'line',
  kind: 'line',
  valid: true,
  points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }],
}
const VERTICAL_LINE: CoreRegion = {
  id: 'line',
  kind: 'line',
  valid: true,
  points: [{ x: 0.5, y: 0.1 }, { x: 0.5, y: 0.9 }],
}
const DIAGONAL_LINE: CoreRegion = {
  id: 'line',
  kind: 'line',
  valid: true,
  points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }],
}
const REVERSE_DIAGONAL_LINE: CoreRegion = {
  id: 'line',
  kind: 'line',
  valid: true,
  points: [{ x: 0.1, y: 0.9 }, { x: 0.9, y: 0.1 }],
}
const POLYGON = [
  { x: 0.4, y: 0.4 },
  { x: 0.6, y: 0.4 },
  { x: 0.6, y: 0.6 },
  { x: 0.4, y: 0.6 },
]
const POLYGON_REGION: CoreRegion = { id: 'area', kind: 'polygon', valid: true, points: POLYGON }

function carRect (cx: number, cy: number, w = 0.04, h = 0.04) {
  return { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 }
}

function frame (
  core: ReturnType<typeof createDetectorCore>,
  sequence: number,
  regions: readonly CoreRegion[],
  boxes: ReadonlyArray<{ objId: number; rect: ReturnType<typeof carRect> }>,
  options: { now?: number; continuous?: boolean } = {},
) {
  return core.processFrame({
    now: options.now ?? sequence * 100,
    sequence,
    continuous: options.continuous ?? true,
    regions,
    bboxes: boxes,
  })
}

describe('classifyBboxPolygonOverlap（精确 Turf）', () => {
  it('处理 disjoint、退化 polygon 和完全包含', () => {
    expect(classifyBboxPolygonOverlap({ x1: 0, y1: 0, x2: 0.1, y2: 0.1 }, polygonToTurfFeature(POLYGON), 0.5))
      .toEqual({ state: 'disjoint', ratio: 0 })
    expect(polygonToTurfFeature([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull()
    expect(classifyBboxPolygonOverlap({ x1: 0.45, y1: 0.45, x2: 0.55, y2: 0.55 }, polygonToTurfFeature(POLYGON), 0.5).state)
      .toBe('fully-inside')
  })

  it('以 0.5 为 fully-inside 边界', () => {
    const half = polygonToTurfFeature([{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }])
    const result = classifyBboxPolygonOverlap({ x1: 0, y1: 0, x2: 1, y2: 1 }, half, 0.5)
    expect(result.ratio).toBeCloseTo(0.5, 8)
    expect(result.state).toBe('fully-inside')
  })

  it('保留凹多边形的 Turf 判定', () => {
    const lShape = polygonToTurfFeature([
      { x: 0.3, y: 0.3 },
      { x: 0.5, y: 0.3 },
      { x: 0.5, y: 0.5 },
      { x: 0.7, y: 0.5 },
      { x: 0.7, y: 0.7 },
      { x: 0.3, y: 0.7 },
    ])
    expect(classifyBboxPolygonOverlap({ x1: 0.5, y1: 0.3, x2: 0.7, y2: 0.5 }, lShape, 0.5).state).toBe('disjoint')
    expect(classifyBboxPolygonOverlap({ x1: 0.3, y1: 0.3, x2: 0.5, y2: 0.5 }, lShape, 0.5).state).toBe('fully-inside')
  })
})

describe('detector-core 实线判定', () => {
  it.each([
    ['水平线', HORIZONTAL_LINE, [[0.3, 0.44], [0.4, 0.44], [0.5, 0.47], [0.6, 0.53]]],
    ['垂直线', VERTICAL_LINE, [[0.44, 0.3], [0.44, 0.4], [0.47, 0.5], [0.53, 0.6]]],
    ['斜线', DIAGONAL_LINE, [[0.32, 0.28], [0.42, 0.38], [0.52, 0.48], [0.58, 0.62]]],
    ['左下到右上斜线', REVERSE_DIAGONAL_LINE, [[0.28, 0.76], [0.38, 0.66], [0.48, 0.54], [0.62, 0.34]]],
  ] as const)('%s：主运动平行线、横向分量跨线时触发', (_name, region, trajectory) => {
    const core = createDetectorCore()
    const events = trajectory.flatMap(([cx, cy], sequence) => frame(core, sequence, [region], [{ objId: 1, rect: carRect(cx, cy) }]))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ objId: 1, regionId: 'line', rule: 'line-enter' })
  })

  it('沿线移动不触发', () => {
    const core = createDetectorCore()
    const events = [0.25, 0.35, 0.45, 0.55, 0.65].flatMap((x, sequence) =>
      frame(core, sequence, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(x, 0.5) }]))
    expect(events).toEqual([])
  })

  it('观察不足 3 帧不触发', () => {
    const core = createDetectorCore()
    frame(core, 0, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.4, 0.44) }])
    expect(frame(core, 1, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.6, 0.56) }])).toEqual([])
  })

  it.each([
    ['左往右：右下角上→下', [-0.158, -0.158, -0.145, -0.128]],
    ['右往左：左下角下→上', [0.038, 0.038, 0.025, 0.008]],
  ] as const)('斜拍 %s，仅下角过线而中央带未过线时不触发', (_name, offsets) => {
    const core = createDetectorCore()
    const events = offsets.flatMap((q, sequence) => {
      const cx = 0.2 + sequence * 0.04
      return frame(core, sequence, [REVERSE_DIAGONAL_LINE], [{ objId: 1, rect: carRect(cx, 1 + q - cx, 0.16, 0.12) }])
    })
    expect(events).toEqual([])
  })

  it.each([
    ['原错误左往右正例：左下角贴线后向下退开', [0.02, 0.02, 0.04, 0.06]],
    ['原错误右往左正例：右下角贴线后向上退开', [-0.14, -0.14, -0.17, -0.20]],
  ] as const)('%s 不得报进入', (_name, offsets) => {
    const core = createDetectorCore()
    const events = offsets.flatMap((q, sequence) => {
      const cx = 0.3 + sequence * 0.1
      return frame(core, sequence, [REVERSE_DIAGONAL_LINE], [{ objId: 1, rect: carRect(cx, 1 + q - cx, 0.16, 0.12) }])
    })
    expect(events).toEqual([])
  })

  it('斜拍 bbox 下角持续压线但沿线行驶不触发', () => {
    const core = createDetectorCore()
    const events = [[0.3, 0.72], [0.4, 0.62], [0.5, 0.52], [0.6, 0.42]].flatMap(([cx, cy], sequence) =>
      frame(core, sequence, [REVERSE_DIAGONAL_LINE], [{ objId: 1, rect: carRect(cx!, cy!, 0.16, 0.12) }]))
    expect(events).toEqual([])
  })

  it('斜拍 bbox 仅尺寸抖动使角点过线时不触发', () => {
    const core = createDetectorCore()
    const events = [
      carRect(0.4, 0.62, 0.16, 0.12),
      carRect(0.4, 0.62, 0.17, 0.11),
      carRect(0.4, 0.62, 0.15, 0.13),
      carRect(0.4, 0.62, 0.16, 0.12),
    ].flatMap((rect, sequence) => frame(core, sequence, [REVERSE_DIAGONAL_LINE], [{ objId: 1, rect }]))
    expect(events).toEqual([])
  })

  it('bbox 接近实线后同侧退开、未跨线时不触发', () => {
    const core = createDetectorCore()
    const events = [[0.2, 0.44], [0.3, 0.44], [0.4, 0.42], [0.5, 0.38]].flatMap(([cx, cy], sequence) =>
      frame(core, sequence, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(cx!, cy!, 0.12, 0.1) }]))
    expect(events).toEqual([])
  })

  it('同侧退开后继续偏移不使用旧接触补报', () => {
    const core = createDetectorCore()
    const fullDiagonal: CoreRegion = {
      id: 'line',
      kind: 'line',
      valid: true,
      points: [{ x: 0, y: 1 }, { x: 1, y: 0 }],
    }
    const trajectory = [
      [0.1, 0.92],
      [0.24, 0.78],
      [0.38, 0.655],
      [0.52, 0.53],
      [0.66, 0.405],
      [0.8, 0.28],
      [0.85, 0.23],
      [0.9, 0.18],
      [0.92, 0.21],
    ]
    const events = trajectory.flatMap(([cx, cy], sequence) =>
      frame(core, sequence, [fullDiagonal], [{ objId: 1, rect: carRect(cx!, cy!, 0.16, 0.12) }]))
    expect(events).toEqual([])
  })

  it.each([4, 33, 280])('浅角慢变道：采样间隔 %i ms 均检出，不要求每帧法向位移达标', (interval) => {
    for (const reversed of [false, true]) {
      const core = createDetectorCore()
      const region: CoreRegion = { id: 'line', kind: 'line', valid: true, points: reversed
        ? [{ x: 0.9, y: 0.1 }, { x: 0.1, y: 0.9 }]
        : [{ x: 0.1, y: 0.9 }, { x: 0.9, y: 0.1 }] }
      const events = []
      for (let sequence = 0, now = 0; now <= 6000; sequence++, now += interval) {
        const cx = 0.15 + now / 6000 * 0.6
        const q = -0.09 + Math.max(0, (now - 1200) / 4800) * 0.03
        events.push(...frame(core, sequence, [region], [{ objId: 1, rect: carRect(cx, 1 + q - cx, 0.16, 0.12) }], { now }))
      }
      expect(events).toHaveLength(1)
      expect(events[0]!.rule).toBe('line-enter')
    }
  })

  it.each([
    ['右下角恰好贴线后跨入', [-0.14, -0.14, -0.14, -0.12], 0],
    ['右下角贴线后退回', [-0.158, -0.158, -0.14, -0.158], 0],
    ['穿线只发生在预热期', [-0.158, -0.128, -0.128, -0.128], 0],
  ] as const)('%s', (_name, offsets, count) => {
    const core = createDetectorCore()
    const events = offsets.flatMap((q, sequence) => {
      const cx = 0.2 + sequence * 0.04
      return frame(core, sequence, [REVERSE_DIAGONAL_LINE], [{ objId: 1, rect: carRect(cx, 1 + q - cx, 0.16, 0.12) }])
    })
    expect(events).toHaveLength(count)
  })

  it('底角沿实线驶过端点后，在延长线上换侧不触发', () => {
    const core = createDetectorCore()
    const region: CoreRegion = { id: 'line', kind: 'line', valid: true, points: [{ x: 0.1, y: 0.9 }, { x: 0.4, y: 0.6 }] }
    const events = [0.15, 0.20, 0.25, 0.4, 0.5, 0.6].flatMap((cx, sequence) =>
      frame(core, sequence, [region], [{ objId: 1, rect: carRect(cx, 1 - (sequence === 5 ? 0.12 : 0.14) - cx, 0.16, 0.12) }]))
    expect(events).toEqual([])
  })

  it('角点因尺寸变化或标线平移而换侧，车辆没有主动法向位移时不触发', () => {
    for (const mode of ['size', 'line'] as const) {
      const core = createDetectorCore()
      const events = Array.from({ length: 8 }, (_, sequence) => {
        const move = sequence < 3 ? 0 : 0.03
        const cx = 0.2 + sequence * 0.04
        const region: CoreRegion = { id: 'line', kind: 'line', valid: true, points: [
          { x: 0.1, y: 0.9 - (mode === 'line' ? move : 0) },
          { x: 0.9, y: 0.1 - (mode === 'line' ? move : 0) },
        ] }
        return frame(core, sequence, [region], [{ objId: 1, rect: carRect(cx, 0.842 - cx, 0.16 + (mode === 'size' ? move * 2 : 0), 0.12) }])
      }).flat()
      expect(events).toEqual([])
    }
  })

  it('静态压线满 1 秒后触发一次', () => {
    const core = createDetectorCore()
    const events = Array.from({ length: 70 }, (_, sequence) =>
      frame(core, sequence, [HORIZONTAL_LINE], [{ objId: 2, rect: carRect(0.5, 0.48, 0.1, 0.04) }])).flat()
    expect(events).toHaveLength(1)
    expect(events[0]?.rule).toBe('line-occupy')
  })

  it('静态仅角点压线不进入底边中央带，不触发', () => {
    const core = createDetectorCore()
    const events = Array.from({ length: 20 }, (_, sequence) =>
      frame(core, sequence, [VERTICAL_LINE], [{ objId: 2, rect: carRect(0.4, 0.5, 0.2, 0.1) }])).flat()
    expect(events).toEqual([])
  })

  it('静态标线到达底边中央带边界，满 1 秒后触发', () => {
    const core = createDetectorCore()
    const events = Array.from({ length: 20 }, (_, sequence) =>
      frame(core, sequence, [VERTICAL_LINE], [{ objId: 2, rect: carRect(0.48, 0.5, 0.2, 0.1) }])).flat()
    expect(events.map(event => event.rule)).toEqual(['line-occupy'])
  })

  it('标线点数变化中断静态占线累计，不把拆段视为零漂移', () => {
    const core = createDetectorCore()
    const splitLine: CoreRegion = { ...HORIZONTAL_LINE, points: [
      { x: 0.1, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.9, y: 0.5 },
    ] }
    const events = []
    for (let sequence = 0; sequence < 8; sequence++) {
      events.push(...frame(core, sequence, [HORIZONTAL_LINE], [{ objId: 2, rect: carRect(0.5, 0.48, 0.1, 0.04) }]))
    }
    for (let sequence = 8; sequence < 14; sequence++) {
      events.push(...frame(core, sequence, [splitLine], [{ objId: 2, rect: carRect(0.5, 0.48, 0.1, 0.04) }]))
    }
    expect(events).toEqual([])
  })

  it('全局帧不连续仍连接同 ID 稀疏轨迹，但中断持续占线计时', () => {
    const crossingCore = createDetectorCore()
    frame(crossingCore, 0, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.3, 0.44) }])
    frame(crossingCore, 1, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.4, 0.44) }])
    frame(crossingCore, 2, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.5, 0.44) }])
    expect(frame(crossingCore, 3, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.6, 0.56) }], { continuous: false }))
      .toMatchObject([{ objId: 1, regionId: 'line', rule: 'line-enter' }])

    const occupyCore = createDetectorCore()
    for (let sequence = 0; sequence < 10; sequence += 1) {
      frame(occupyCore, sequence, [HORIZONTAL_LINE], [{ objId: 2, rect: carRect(0.5, 0.48, 0.1, 0.04) }])
    }
    expect(frame(occupyCore, 10, [HORIZONTAL_LINE], [{ objId: 2, rect: carRect(0.5, 0.48, 0.1, 0.04) }], { continuous: false })).toEqual([])
    expect(frame(occupyCore, 11, [HORIZONTAL_LINE], [{ objId: 2, rect: carRect(0.5, 0.48, 0.1, 0.04) }])).toEqual([])
  })

  it('同 ID 有→无→无→有时在 1.5 秒内连接首尾有效轨迹', () => {
    const core = createDetectorCore()
    frame(core, 0, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.3, 0.44) }])
    frame(core, 1, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.4, 0.44) }])
    frame(core, 2, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.5, 0.44) }])
    frame(core, 3, [HORIZONTAL_LINE], [], { now: 600 })
    frame(core, 4, [HORIZONTAL_LINE], [], { now: 1000 })
    expect(frame(core, 5, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.6, 0.56) }], { now: 1700 }))
      .toMatchObject([{ objId: 1, regionId: 'line', rule: 'line-enter' }])
  })

  it.each([
    ['1500ms', 1700, 1],
    ['1501ms', 1701, 0],
  ] as const)('同 ID 稀疏轨迹边界 %s，事件数为 %i', (_name, reappearAt, count) => {
    const core = createDetectorCore()
    frame(core, 0, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.3, 0.44) }], { now: 0 })
    frame(core, 1, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.4, 0.44) }], { now: 100 })
    frame(core, 2, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.5, 0.44) }], { now: 200 })
    frame(core, 3, [HORIZONTAL_LINE], [], { now: 600 })
    frame(core, 4, [HORIZONTAL_LINE], [], { now: 1000 })
    expect(frame(core, 5, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.6, 0.56) }], { now: reappearAt }))
      .toHaveLength(count)
  })

  it('不同 ID 不连接缺失前后的 bbox', () => {
    const core = createDetectorCore()
    frame(core, 0, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.3, 0.44) }])
    frame(core, 1, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.4, 0.44) }])
    frame(core, 2, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.5, 0.44) }])
    frame(core, 3, [HORIZONTAL_LINE], [])
    expect(frame(core, 4, [HORIZONTAL_LINE], [{ objId: 2, rect: carRect(0.6, 0.56) }])).toEqual([])
  })

  it('单目标短缺失中断持续占线计时，但不影响其他目标', () => {
    const core = createDetectorCore()
    const events = []
    for (let sequence = 0; sequence <= 5; sequence += 1) {
      events.push(...frame(core, sequence, [HORIZONTAL_LINE], [
        { objId: 1, rect: carRect(0.35, 0.48, 0.1, 0.04) },
        { objId: 2, rect: carRect(0.65, 0.48, 0.1, 0.04) },
      ]))
    }
    events.push(...frame(core, 6, [HORIZONTAL_LINE], [{ objId: 2, rect: carRect(0.65, 0.48, 0.1, 0.04) }]))
    events.push(...frame(core, 7, [HORIZONTAL_LINE], [
      { objId: 1, rect: carRect(0.35, 0.48, 0.1, 0.04) },
      { objId: 2, rect: carRect(0.65, 0.48, 0.1, 0.04) },
    ]))
    for (let sequence = 8; sequence <= 12; sequence += 1) {
      events.push(...frame(core, sequence, [HORIZONTAL_LINE], [
        { objId: 1, rect: carRect(0.35, 0.48, 0.1, 0.04) },
        { objId: 2, rect: carRect(0.65, 0.48, 0.1, 0.04) },
      ]))
    }
    expect(events.filter(event => event.objId === 1)).toEqual([])
    expect(events.filter(event => event.objId === 2).map(event => event.rule)).toEqual(['line-occupy'])
  })

  it('目标缺席不能计入 episode 明确清除时间', () => {
    const core = createDetectorCore()
    const events = []
    for (let sequence = 0; sequence < 4; sequence += 1) {
      events.push(...frame(core, sequence, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.3 + sequence * 0.1, sequence < 3 ? 0.44 : 0.56) }]))
    }
    frame(core, 4, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.7, 0.62) }])
    frame(core, 5, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.7, 0.62) }])
    frame(core, 6, [HORIZONTAL_LINE], [])
    for (let sequence = 7; sequence <= 15; sequence += 1) {
      frame(core, sequence, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.7, 0.62) }])
    }
    events.push(...frame(core, 16, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.7, 0.44) }]))
    expect(events.map(event => event.rule)).toEqual(['line-enter'])
  })

  it('目标缺席会中断 polygon disjoint 去抖与 episode 清除计时', () => {
    const core = createDetectorCore()
    const events = []
    for (let sequence = 0; sequence < 3; sequence += 1) {
      frame(core, sequence, [POLYGON_REGION], [{ objId: 1, rect: carRect(0.3, 0.5) }])
    }
    events.push(...frame(core, 3, [POLYGON_REGION], [{ objId: 1, rect: carRect(0.5, 0.5) }]))
    frame(core, 4, [POLYGON_REGION], [{ objId: 1, rect: carRect(0.2, 0.5) }])
    frame(core, 5, [POLYGON_REGION], [])
    for (let sequence = 6; sequence <= 16; sequence += 1) {
      frame(core, sequence, [POLYGON_REGION], [{ objId: 1, rect: carRect(0.2, 0.5) }])
    }
    events.push(...frame(core, 17, [POLYGON_REGION], [{ objId: 1, rect: carRect(0.5, 0.5) }]))
    expect(events.map(event => event.rule)).toEqual(['polygon-enter'])
  })

  it('目标缺席时 region 失效会清除旧跨线历史', () => {
    const core = createDetectorCore()
    frame(core, 0, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.3, 0.44) }])
    frame(core, 1, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.4, 0.44) }])
    frame(core, 2, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.5, 0.44) }])
    frame(core, 3, [{ id: 'line', kind: 'line', valid: false }], [])
    expect(frame(core, 4, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.6, 0.56) }])).toEqual([])
  })

  it('无效 region 重置跨线历史', () => {
    const core = createDetectorCore()
    frame(core, 0, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.3, 0.44) }])
    frame(core, 1, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.4, 0.44) }])
    frame(core, 2, [{ id: 'line', kind: 'line', valid: false }], [{ objId: 1, rect: carRect(0.5, 0.44) }])
    expect(frame(core, 3, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.6, 0.56) }])).toEqual([])
  })

  it('仅连续观察到明确清除 1 秒才重置 episode', () => {
    const core = createDetectorCore()
    const events = []
    for (let sequence = 0; sequence < 4; sequence += 1) {
      events.push(...frame(core, sequence, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.3 + sequence * 0.1, sequence < 3 ? 0.44 : 0.56) }]))
    }
    for (let sequence = 4; sequence <= 14; sequence += 1) {
      events.push(...frame(core, sequence, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.7, 0.62) }]))
    }
    events.push(...frame(core, 15, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.7, 0.44) }]))
    expect(events.map(event => event.rule)).toEqual(['line-enter', 'line-enter'])
  })

  it('短暂目标丢失并 prune 后由 tombstone 阻止重复上报', () => {
    const core = createDetectorCore()
    const events = []
    for (let sequence = 0; sequence < 4; sequence += 1) {
      events.push(...frame(core, sequence, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.3 + sequence * 0.1, sequence < 3 ? 0.44 : 0.56) }]))
    }
    frame(core, 4, [HORIZONTAL_LINE], [], { now: 2000 })
    frame(core, 5, [], [], { now: 2100 })
    frame(core, 6, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.4, 0.44) }], { now: 2200 })
    frame(core, 7, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.5, 0.44) }], { now: 2300 })
    events.push(...frame(core, 8, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.6, 0.56) }], { now: 2400 }))
    expect(events).toHaveLength(1)
  })

  it('空 regions 和空 bboxes 的帧仍会 prune tracker', () => {
    const core = createDetectorCore()
    for (let sequence = 0; sequence < 4; sequence += 1) {
      frame(core, sequence, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.3 + sequence * 0.1, sequence < 3 ? 0.44 : 0.56) }])
    }
    frame(core, 4, [], [], { now: 2000 })
    const events = []
    for (let sequence = 5; sequence < 8; sequence += 1) {
      events.push(...frame(core, sequence, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.4 + (sequence - 5) * 0.1, sequence < 7 ? 0.44 : 0.56) }], { now: 2100 + sequence * 100 }))
    }
    expect(events).toEqual([])
  })

  it('region 暂空时仍更新目标连续性，恢复后重新预热但不误判跨线', () => {
    const core = createDetectorCore()
    frame(core, 0, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.3, 0.44) }])
    frame(core, 1, [], [{ objId: 1, rect: carRect(0.4, 0.44) }])
    frame(core, 2, [], [{ objId: 1, rect: carRect(0.5, 0.44) }])
    expect(frame(core, 3, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.6, 0.56) }])).toEqual([])
  })

  it('同 ID 超时后直接重现也先 prune，并继承已上报 tombstone', () => {
    const core = createDetectorCore()
    const events = []
    for (let sequence = 0; sequence < 4; sequence += 1) {
      events.push(...frame(core, sequence, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.3 + sequence * 0.1, sequence < 3 ? 0.44 : 0.56) }]))
    }
    frame(core, 4, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.4, 0.44) }], { now: 2000 })
    frame(core, 5, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.5, 0.44) }], { now: 2100 })
    events.push(...frame(core, 6, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.6, 0.56) }], { now: 2200 }))
    expect(events).toHaveLength(1)
  })
})

describe('paramsOverride', () => {
  it('覆盖 LINE_OCCUPY_MS 后静态压线按新阈值触发，且默认实例不受影响', () => {
    const run = (frames: number, occupyMs?: number) => {
      const core = createDetectorCore(occupyMs === undefined ? {} : { paramsOverride: { LINE_OCCUPY_MS: occupyMs } })
      return Array.from({ length: frames }, (_, sequence) =>
        frame(core, sequence, [HORIZONTAL_LINE], [{ objId: 2, rect: carRect(0.5, 0.48, 0.1, 0.04) }])).flat()
    }
    // 每帧 100ms，预热 3 帧后开始累计占线：15 帧（累计约 1200ms）默认 LINE_OCCUPY_MS=1000 触发一次；覆盖 2000 时不触发。
    expect(run(15)).toHaveLength(1)
    expect(run(15, 2000)).toEqual([])
  })

  it('覆盖 TRACKER_TIMEOUT_MS 加速老化，prune 后目标重新预热', () => {
    const core = createDetectorCore({ paramsOverride: { TRACKER_TIMEOUT_MS: 100 } })
    frame(core, 0, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.3, 0.44) }])
    // now=800 距上次出现 700ms > 100ms：tracker 已 prune，重新出现需要重新观察满 3 帧。
    expect(frame(core, 1, [HORIZONTAL_LINE], [{ objId: 1, rect: carRect(0.6, 0.56) }], { now: 800 })).toEqual([])
  })

  it('dEFAULT_DETECTOR_PARAMS 保持生产默认值', () => {
    expect(DEFAULT_DETECTOR_PARAMS.TRACKER_TIMEOUT_MS).toBe(1500)
    expect(DEFAULT_DETECTOR_PARAMS.MIN_TRACKER_AGE_FRAMES).toBe(3)
    expect(DEFAULT_DETECTOR_PARAMS.POLYGON_OVERLAP_T_FULL).toBe(0.5)
    expect(DEFAULT_DETECTOR_PARAMS.LINE_OCCUPY_MS).toBe(1000)
    expect(DEFAULT_DETECTOR_PARAMS.EPISODE_CLEAR_MS).toBe(1000)
  })
})

describe('detector-core polygon 判定', () => {
  it('目标首次观察时已在 polygon 内，预热完成后仍触发', () => {
    const core = createDetectorCore()
    const events = [0, 1, 2].flatMap(sequence =>
      frame(core, sequence, [POLYGON_REGION], [{ objId: 1, rect: carRect(0.5, 0.5) }]))
    expect(events).toHaveLength(1)
    expect(events[0]?.rule).toBe('polygon-enter')
  })

  it('中心进入触发且同帧最多一个事件', () => {
    const core = createDetectorCore()
    frame(core, 0, [POLYGON_REGION], [{ objId: 1, rect: carRect(0.2, 0.5) }])
    frame(core, 1, [POLYGON_REGION], [{ objId: 1, rect: carRect(0.25, 0.5) }])
    frame(core, 2, [POLYGON_REGION], [{ objId: 1, rect: carRect(0.3, 0.5) }])
    const events = frame(core, 3, [POLYGON_REGION], [{ objId: 1, rect: carRect(0.5, 0.5) }])
    expect(events).toHaveLength(1)
    expect(events[0]?.rule).toBe('polygon-enter')
  })

  it('中心在凹区外时，partial 到 overlap >= 0.5 仍触发', () => {
    const concave: CoreRegion = {
      id: 'concave',
      kind: 'polygon',
      valid: true,
      points: [
        { x: 0.3, y: 0.3 },
        { x: 0.5, y: 0.3 },
        { x: 0.5, y: 0.5 },
        { x: 0.7, y: 0.5 },
        { x: 0.7, y: 0.7 },
        { x: 0.3, y: 0.7 },
      ],
    }
    const core = createDetectorCore()
    frame(core, 0, [concave], [{ objId: 2, rect: carRect(0.8, 0.2, 0.2, 0.2) }])
    frame(core, 1, [concave], [{ objId: 2, rect: carRect(0.7, 0.3, 0.2, 0.2) }])
    frame(core, 2, [concave], [{ objId: 2, rect: carRect(0.56, 0.44, 0.2, 0.2) }])
    const events = frame(core, 3, [concave], [{ objId: 2, rect: carRect(0.52, 0.48, 0.2, 0.2) }])
    expect(events).toHaveLength(1)
    expect(events[0]?.rule).toBe('polygon-fully-inside')
  })

  it('中心在外时，disjoint 直接跳到 overlap >= 0.5 仍触发', () => {
    const concave: CoreRegion = {
      id: 'concave',
      kind: 'polygon',
      valid: true,
      points: [
        { x: 0.3, y: 0.3 },
        { x: 0.5, y: 0.3 },
        { x: 0.5, y: 0.5 },
        { x: 0.7, y: 0.5 },
        { x: 0.7, y: 0.7 },
        { x: 0.3, y: 0.7 },
      ],
    }
    const core = createDetectorCore()
    frame(core, 0, [concave], [{ objId: 2, rect: carRect(0.8, 0.2, 0.2, 0.2) }])
    frame(core, 1, [concave], [{ objId: 2, rect: carRect(0.8, 0.2, 0.2, 0.2) }])
    frame(core, 2, [concave], [{ objId: 2, rect: carRect(0.8, 0.2, 0.2, 0.2) }])
    const events = frame(core, 3, [concave], [{ objId: 2, rect: carRect(0.52, 0.48, 0.2, 0.2) }])
    expect(events).toHaveLength(1)
    expect(events[0]?.rule).toBe('polygon-fully-inside')
  })

  it('持续 partial 不算明确离开，不会重新武装', () => {
    const core = createDetectorCore()
    const events = []
    for (let sequence = 0; sequence < 3; sequence += 1) {
      frame(core, sequence, [POLYGON_REGION], [{ objId: 3, rect: carRect(0.2, 0.5, 0.1, 0.1) }])
    }
    events.push(...frame(core, 3, [POLYGON_REGION], [{ objId: 3, rect: carRect(0.5, 0.5, 0.1, 0.1) }]))
    for (let sequence = 4; sequence < 20; sequence += 1) {
      frame(core, sequence, [POLYGON_REGION], [{ objId: 3, rect: carRect(0.37, 0.5, 0.1, 0.1) }])
    }
    events.push(...frame(core, 20, [POLYGON_REGION], [{ objId: 3, rect: carRect(0.5, 0.5, 0.1, 0.1) }]))
    expect(events).toHaveLength(1)
  })

  it('持续处于 polygon 违章 episode 不周期重报', () => {
    const core = createDetectorCore()
    const events = Array.from({ length: 80 }, (_, sequence) => {
      const cx = sequence < 3 ? 0.2 : 0.5
      return frame(core, sequence, [POLYGON_REGION], [{ objId: 3, rect: carRect(cx, 0.5) }])
    }).flat()
    expect(events).toHaveLength(1)
  })
})
