// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { Point2D, ValidCoreRegion } from '../../../src/hosts/cockpit/lane-change/detector-core'
import type { BBoxTrack, KeyframeBBox, Scenario } from '../sim/types'

// =============================================================================
// 真实道路透视模型
// =============================================================================
//
// 模拟驾驶舱直播常见的斜下俯拍视角：画面顶部为远端，底部为近端。
// 所有线、导流区和车辆轨迹从同一组车道边界派生，避免为触发算法构造不成立的拓扑。
// 语义对齐当前插件 detector 契约：
// - LINE 硬触发 = 底边 40%～60% 中央带边界穿过有限线段，或中央带静态压线满 LINE_OCCUPY_MS。
// - POLYGON 硬触发 = bbox 几何中心进入区域，或重叠面积比达到 POLYGON_OVERLAP_T_FULL。

const ROAD_TOP_Y = 0.06
const ROAD_BOTTOM_Y = 0.98
const ROAD_MID_Y = 0.52
const HORIZONTAL_ROAD_LEFT_X = 0.16
const HORIZONTAL_ROAD_RIGHT_X = 0.92

type PathX = (cy: number) => number
type PathY = (cx: number) => number

function clamp01 (v: number): number {
  return Math.max(0, Math.min(1, v))
}

function lerp (a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function yToRoadT (cy: number): number {
  return clamp01((cy - ROAD_TOP_Y) / (ROAD_BOTTOM_Y - ROAD_TOP_Y))
}

function xToHorizontalRoadT (cx: number): number {
  return clamp01((cx - HORIZONTAL_ROAD_LEFT_X) / (HORIZONTAL_ROAD_RIGHT_X - HORIZONTAL_ROAD_LEFT_X))
}

function pathFromTopBottom (topX: number, bottomX: number): PathX {
  return (cy: number) => lerp(topX, bottomX, yToRoadT(cy))
}

function pathYFromLeftRight (leftY: number, rightY: number): PathY {
  return (cx: number) => lerp(leftY, rightY, xToHorizontalRoadT(cx))
}

function offsetPath (path: PathX, dx: number): PathX {
  return (cy: number) => clamp01(path(cy) + dx)
}

function makeLineRegion (id: string, path: PathX): ValidCoreRegion {
  return {
    id,
    kind: 'line',
    valid: true,
    points: [
      { x: path(ROAD_TOP_Y), y: ROAD_TOP_Y },
      { x: path(ROAD_MID_Y), y: ROAD_MID_Y },
      { x: path(ROAD_BOTTOM_Y), y: ROAD_BOTTOM_Y },
    ],
  }
}

/**
 * 横向道路的出口段实线：只覆盖 x ∈ [xStart, HORIZONTAL_ROAD_RIGHT_X]。
 * 十字路口里纵向车道的车会正常穿过横向道路，若横线横跨整幅画面，
 * 纵向背景车也会穿线触发；把横线收缩到出口段即可保持拓扑真实。
 */
function makeHorizontalExitLineRegion (id: string, path: PathY, xStart: number): ValidCoreRegion {
  const xMid = (xStart + HORIZONTAL_ROAD_RIGHT_X) / 2
  return {
    id,
    kind: 'line',
    valid: true,
    points: [
      { x: xStart, y: path(xStart) },
      { x: xMid, y: path(xMid) },
      { x: HORIZONTAL_ROAD_RIGHT_X, y: path(HORIZONTAL_ROAD_RIGHT_X) },
    ],
  }
}

function makeDiagonalLineRegion (id: string, intercept: number): ValidCoreRegion {
  const xStart = Math.max(0.05, intercept - 0.95)
  const xEnd = Math.min(0.95, intercept - 0.05)
  return {
    id,
    kind: 'line',
    valid: true,
    points: [xStart, xEnd].map(x => ({ x, y: intercept - x })),
  }
}

/** 纵向实线的进口段版本：只覆盖 y ∈ [ROAD_TOP_Y, yEnd]，避开路口交叉区。 */
function makeVerticalApproachLineRegion (id: string, path: PathX, yEnd: number): ValidCoreRegion {
  const yMid = (ROAD_TOP_Y + yEnd) / 2
  return {
    id,
    kind: 'line',
    valid: true,
    points: [
      { x: path(ROAD_TOP_Y), y: ROAD_TOP_Y },
      { x: path(yMid), y: yMid },
      { x: path(yEnd), y: yEnd },
    ],
  }
}

/** cubic ease-in-out: t^2 * (3 - 2t) */
function easeInOut (t: number): number {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

/** smoothstep 平滑窗口：t < t0 返回 0，t > t1 返回 1，否则 ease-in-out 过渡。 */
function smoothstepWindow (t: number, t0: number, t1: number): number {
  if (t <= t0) return 0
  if (t >= t1) return 1
  if (Math.abs(t1 - t0) < 1e-6) return t >= t1 ? 1 : 0
  return easeInOut((t - t0) / (t1 - t0))
}

/** cy ∈ [0,1] -> bbox 宽度。近端车辆更大，制造强透视。 */
function perspectiveScale (cy: number, sizeFar = 0.034, sizeNear = 0.108): number {
  return sizeFar + (sizeNear - sizeFar) * clamp01(cy)
}

function makeRect (cx: number, cy: number, size: number) {
  const w = size
  const h = size * 1.72
  return {
    x1: cx - w / 2,
    y1: cy - h / 2,
    x2: cx + w / 2,
    y2: cy + h / 2,
  }
}

function makeHorizontalTrafficRect (cx: number, cy: number, size: number) {
  const w = size * 1.72
  const h = size
  return {
    x1: cx - w / 2,
    y1: cy - h / 2,
    x2: cx + w / 2,
    y2: cy + h / 2,
  }
}

function makeDiagonalTrafficRect (cx: number, cy: number, width: number, height: number) {
  return {
    x1: cx - width / 2,
    y1: cy - height / 2,
    x2: cx + width / 2,
    y2: cy + height / 2,
  }
}

/** y 向下；左→右看右下角上→下，右→左看左下角下→上。 */
function makeDiagonalLaneChangeTrack (
  objId: string,
  lineIntercept: number,
  startTime: number,
  width: number,
  height: number,
  laneChangeDirection: 'left-to-right' | 'right-to-left',
  changeWindow: [number, number],
): BBoxTrack {
  const duration = 4800
  const steps = 96
  const toRight = laneChangeDirection === 'left-to-right'
  const clearance = 0.018
  const startOffset = toRight ? -(width + height) / 2 - clearance : (width - height) / 2 + clearance
  const departure = (toRight ? 1 : -1) * (width + 0.04)
  // 同条线的两辆车沿道路错开，不能靠反向横移互相穿模。
  const xStart = 0.10 + (lineIntercept - 0.66) / 2 + (toRight ? 0 : 0.25)
  return {
    objId,
    laneChange: {
      direction: laneChangeDirection,
      startTime: startTime + duration * changeWindow[0],
      endTime: startTime + duration * changeWindow[1],
    },
    keyframes: Array.from({ length: steps + 1 }, (_, index) => {
      const ratio = index / steps
      const shift = departure * smoothstepWindow(ratio, changeWindow[0], changeWindow[1])
      // (1,-1) 为前进方向，(1,1) 为横向；变道前后恢复平行直行。
      const cx = xStart + 0.23 * ratio + shift / 2
      const cy = lineIntercept + startOffset - xStart - 0.23 * ratio + shift / 2
      return {
        time: startTime + ratio * duration,
        rect: makeDiagonalTrafficRect(cx, cy, width, height),
      }
    }),
  }
}

function makeDiagonalTrafficSchedules (count: number, seed: number): Array<{ startTime: number; changeWindow: [number, number] }> {
  let state = seed >>> 0
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
  return Array.from({ length: count }, () => {
    const start = 0.20 + random() * 0.04
    return {
      startTime: Math.round(random() * 260),
      changeWindow: [start, start + 0.68 + random() * 0.02],
    }
  })
}

const DIAGONAL_TRAFFIC_SCHEDULES = makeDiagonalTrafficSchedules(6, 45)

/** 纵向车道（车辆从画面顶部驶向底部）。 */
const LEFT_OUTER_LANE = pathFromTopBottom(0.348, 0.198)
const LEFT_LANE = pathFromTopBottom(0.448, 0.400)
const RIGHT_LANE = pathFromTopBottom(0.548, 0.620)
const RIGHT_OUTER_LANE = pathFromTopBottom(0.648, 0.820)
/** 中央实线（违章判定线）。 */
const CENTER_SOLID_LINE = makeLineRegion('MAIN_SOLID_LINE', pathFromTopBottom(0.500, 0.515))

interface TrackOptions {
  /** 变道窗口占全程比例 */
  window?: [number, number];
  cyStart?: number;
  cyEnd?: number;
  sizeFar?: number;
  sizeNear?: number;
  steps?: number;
  timeOffset?: number;
}

function makeLaneChangeTrack (
  objId: string | number,
  duration: number,
  fromLane: PathX,
  toLane: PathX,
  options: TrackOptions = {},
): BBoxTrack {
  const {
    window = [0.30, 0.65],
    cyStart = 0.07,
    cyEnd = 0.96,
    sizeFar = 0.034,
    sizeNear = 0.108,
    steps = 72,
    timeOffset = 0,
  } = options
  const keyframes: KeyframeBBox[] = []
  for (let i = 0; i <= steps; i++) {
    const ratio = i / steps
    const time = timeOffset + ratio * (duration - timeOffset)
    const cy = lerp(cyStart, cyEnd, ratio)
    const mix = smoothstepWindow(ratio, window[0], window[1])
    const fromX = fromLane(cy)
    const toX = toLane(cy)
    const cx = lerp(fromX, toX, mix)
    keyframes.push({ time, rect: makeRect(cx, cy, perspectiveScale(cy, sizeFar, sizeNear)) })
  }
  return { objId, keyframes }
}

/** 沿车道直行（无横向偏移），用于背景车与“直行不触发”场景。 */
function makeStraightTrack (
  objId: string | number,
  duration: number,
  lane: PathX,
  options: TrackOptions = {},
): BBoxTrack {
  return makeLaneChangeTrack(objId, duration, lane, lane, options)
}

/** 变道过去再变道回来（半压回正 / 往返场景）。 */
function makeRoundTripTrack (
  objId: string | number,
  duration: number,
  fromLane: PathX,
  toLane: PathX,
  goWindow: [number, number],
  returnWindow: [number, number],
  options: TrackOptions = {},
): BBoxTrack {
  const {
    cyStart = 0.07,
    cyEnd = 0.96,
    sizeFar = 0.034,
    sizeNear = 0.108,
    steps = 80,
  } = options
  const keyframes: KeyframeBBox[] = []
  for (let i = 0; i <= steps; i++) {
    const ratio = i / steps
    const time = ratio * duration
    const cy = lerp(cyStart, cyEnd, ratio)
    const goMix = smoothstepWindow(ratio, goWindow[0], goWindow[1])
    const returnMix = smoothstepWindow(ratio, returnWindow[0], returnWindow[1])
    const fromX = fromLane(cy)
    const toX = toLane(cy)
    const cx = lerp(lerp(fromX, toX, goMix), fromX, returnMix)
    keyframes.push({ time, rect: makeRect(cx, cy, perspectiveScale(cy, sizeFar, sizeNear)) })
  }
  return { objId, keyframes }
}

interface StationaryOptions {
  cy?: number;
  size?: number;
  startTime?: number;
  duration?: number;
  steps?: number;
}

/** 静止车辆（静止压线 / 占用导流区场景）。 */
function makeStationaryTrack (objId: string | number, cx: number, options: StationaryOptions = {}): BBoxTrack {
  const {
    cy = 0.6,
    size = 0.08,
    startTime = 0,
    duration = 3000,
    steps = 12,
  } = options
  const keyframes: KeyframeBBox[] = []
  for (let i = 0; i <= steps; i++) {
    keyframes.push({ time: startTime + (i / steps) * duration, rect: makeRect(cx, cy, size) })
  }
  return { objId, keyframes }
}

/** 默认 4 辆背景车：3 辆在指定车道排成队列，1 辆在邻车道。 */
function makeBackgroundTraffic (
  idPrefix: string,
  duration: number,
  queueLane: PathX,
  neighborLane: PathX,
): BBoxTrack[] {
  return [
    makeStraightTrack(`${idPrefix}_traffic_q1`, duration, queueLane, { cyStart: 0.09, cyEnd: 0.55, steps: 60 }),
    makeStraightTrack(`${idPrefix}_traffic_q2`, duration, queueLane, { cyStart: 0.32, cyEnd: 0.78, steps: 60 }),
    makeStraightTrack(`${idPrefix}_traffic_q3`, duration, queueLane, { cyStart: 0.55, cyEnd: 0.95, steps: 60 }),
    makeStraightTrack(`${idPrefix}_traffic_n1`, duration, neighborLane, { cyStart: 0.18, cyEnd: 0.88, steps: 60 }),
  ]
}

/**
 * 真实 SEI 启发的离散帧序列：约 3-4 FPS 基础间隔（同 ID 最长 1500ms 稀疏续接），
 * 并在指定时间附近插入一次 400-700ms 长间隔，模拟低帧率、突发间隔与 backlog。
 */
function makeDiscreteFrameTimes (duration: number, longGapAtMs?: number): number[] {
  const times: number[] = []
  let t = 0
  while (t <= duration) {
    times.push(t)
    const interval = longGapAtMs !== undefined && Math.abs(t - longGapAtMs) < 1
      ? 640
      : 280
    t += interval
  }
  return times
}

interface PolygonShape {
  region: ValidCoreRegion;
  centerInsidePath: (cy: number) => number;
}

/** 主路右侧出口导流区（斜纹禁行区），位于主路右车道与出口之间。 */
function makeGuideArea (id: string): PolygonShape {
  const points: Point2D[] = [
    { x: 0.660, y: 0.30 },
    { x: 0.860, y: 0.30 },
    { x: 0.900, y: 0.98 },
    { x: 0.740, y: 0.98 },
  ]
  return {
    region: { id, kind: 'polygon', valid: true, points },
    centerInsidePath: (cy: number) => lerp(0.680, 0.800, yToRoadT(cy)),
  }
}

// =============================================================================
// 场景预设
// =============================================================================

function baseScenario (id: string, name: string, description: string, duration: number): Pick<Scenario, 'id' | 'name' | 'description' | 'duration'> {
  return { id, name, description, duration }
}

const SCENARIOS: Scenario[] = [
  {
    ...baseScenario(
      'line-straight-left',
      '单实线·左外车道直行',
      '主车全程在左侧外车道直行，远离中央实线；预期无任何触发（背景车同样不触发）。',
      3200,
    ),
    regions: [CENTER_SOLID_LINE],
    tracks: [
      makeStraightTrack('car_straight_left', 3200, LEFT_OUTER_LANE),
      ...makeBackgroundTraffic('lsl', 3200, LEFT_LANE, RIGHT_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3200),
  },
  {
    ...baseScenario(
      'line-slow-cross',
      '单实线·慢速左→右变道',
      '主车在变道窗口内缓慢从左车道跨中央实线进入右车道；预期触发一次 line-enter。',
      3200,
    ),
    regions: [CENTER_SOLID_LINE],
    tracks: [
      makeLaneChangeTrack('car_slow_cross', 3200, LEFT_LANE, RIGHT_LANE, { window: [0.30, 0.65] }),
      ...makeBackgroundTraffic('lsc', 3200, LEFT_OUTER_LANE, RIGHT_OUTER_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3200),
  },
  {
    ...baseScenario(
      'line-late-cross',
      '单实线·近端急变道',
      '主车行驶到近端（画面下方）才急速跨线；验证短时间快速穿线不漏检，预期一次 line-enter。',
      3200,
    ),
    regions: [CENTER_SOLID_LINE],
    tracks: [
      makeLaneChangeTrack('car_late_cross', 3200, LEFT_LANE, RIGHT_LANE, { window: [0.78, 0.92] }),
      ...makeBackgroundTraffic('llc', 3200, LEFT_OUTER_LANE, RIGHT_OUTER_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3200),
  },
  {
    ...baseScenario(
      'line-half-press',
      '单实线·半压后回正',
      '主车先跨中央实线（穿线即触发一次 line-enter），随后又跨回本车道；回正不撤销已触发事件，预期合计一次触发。',
      3400,
    ),
    regions: [CENTER_SOLID_LINE],
    tracks: [
      makeRoundTripTrack('car_half_press', 3400, LEFT_LANE, RIGHT_LANE, [0.25, 0.45], [0.55, 0.75]),
      ...makeBackgroundTraffic('lhp', 3400, LEFT_OUTER_LANE, RIGHT_OUTER_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3400),
  },
  {
    ...baseScenario(
      'line-hug-truck',
      '单实线·大车贴线直行',
      '大车 bbox 边缘贴近/压过中央实线行驶，但底边中央带始终未穿线且持续移动；预期不触发（移动压框不算静态压线）。',
      3400,
    ),
    regions: [CENTER_SOLID_LINE],
    tracks: [
      makeLaneChangeTrack('car_hug_truck', 3400, offsetPath(LEFT_LANE, 0.045), offsetPath(LEFT_LANE, 0.045), { sizeFar: 0.05, sizeNear: 0.16 }),
      ...makeBackgroundTraffic('lht', 3400, LEFT_OUTER_LANE, RIGHT_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3400),
  },
  {
    ...baseScenario(
      'line-occupy-stationary',
      '单实线·静止车辆压线',
      '车辆静止停压在中央实线上（footprint 持续压线、中心静止、线稳定）；持续超过 LINE_OCCUPY_MS 后预期触发一次 line-occupy。',
      3000,
    ),
    regions: [CENTER_SOLID_LINE],
    tracks: [
      makeStationaryTrack('car_occupy_stationary', CENTER_SOLID_LINE.points[1]!.x, { cy: 0.6, size: 0.08, duration: 3000, steps: 12 }),
      ...makeBackgroundTraffic('los', 3000, LEFT_OUTER_LANE, RIGHT_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3000),
  },
  {
    ...baseScenario(
      'line-occupy-slow-ride',
      '单实线·缓慢沿线行驶',
      '车辆沿中央实线走向缓慢行驶（纵向位移明显超过帧位移上限，横向与线同步）；预期移动压框不触发 line-occupy，也不触发穿线。',
      3200,
    ),
    regions: [CENTER_SOLID_LINE],
    tracks: [
      makeStraightTrack('car_slow_ride_line', 3200, pathFromTopBottom(0.500, 0.515), { cyStart: 0.2, cyEnd: 0.9, steps: 60 }),
      ...makeBackgroundTraffic('lsr', 3200, LEFT_OUTER_LANE, RIGHT_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3200),
  },
  {
    ...baseScenario(
      'line-horizontal-center-cross',
      '路口横向道路·上下变道',
      '横向道路车辆从左往右行驶，在出口段横线处从上方车道变到下方车道；底边扫过实际出口横线预期一次 line-enter。纵向背景车走左侧车道不穿出口段横线。',
      3600,
    ),
    regions: [makeHorizontalExitLineRegion('HORIZONTAL_SOLID_LINE', pathYFromLeftRight(0.44, 0.48), 0.62)],
    tracks: [
      {
        objId: 'car_horizontal_cross',
        keyframes: Array.from({ length: 60 }, (_, i) => {
          const ratio = i / 59
          const cx = lerp(0.20, 0.88, ratio)
          const cy = lerp(0.38, 0.56, smoothstepWindow(ratio, 0.55, 0.78))
          return { time: ratio * 3600, rect: makeHorizontalTrafficRect(cx, cy, 0.05) }
        }),
      },
      ...makeBackgroundTraffic('lhc', 3600, LEFT_OUTER_LANE, LEFT_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3600),
  },
  {
    ...baseScenario(
      'line-intersection-dual-cross',
      '十字路口·竖向与横向实线同时跨线',
      '竖线只画路口上方进口段、横线只画右侧出口段（保持进口/出口段拓扑真实）：纵向道路车辆在进口段左右变道跨竖线，横向道路车辆在出口段上下变道跨横线；两条线各触发一次 line-enter。',
      3600,
    ),
    regions: [
      makeVerticalApproachLineRegion('INTERSECTION_VERTICAL_SOLID_LINE', pathFromTopBottom(0.450, 0.470), 0.34),
      makeHorizontalExitLineRegion('INTERSECTION_HORIZONTAL_SOLID_LINE', pathYFromLeftRight(0.44, 0.48), 0.70),
    ],
    tracks: [
      makeLaneChangeTrack('car_intersection_vertical_cross', 3600, pathFromTopBottom(0.380, 0.390), pathFromTopBottom(0.520, 0.550), { window: [0.35, 0.6], cyStart: 0.08, cyEnd: 0.4 }),
      {
        objId: 'car_intersection_horizontal_cross',
        keyframes: Array.from({ length: 60 }, (_, i) => {
          const ratio = i / 59
          const cx = lerp(0.20, 0.88, ratio)
          const cy = lerp(0.38, 0.56, smoothstepWindow(ratio, 0.65, 0.85))
          return { time: ratio * 3600, rect: makeHorizontalTrafficRect(cx, cy, 0.05) }
        }),
      },
      ...makeBackgroundTraffic('idc', 3600, LEFT_OUTER_LANE, RIGHT_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3600),
  },
  {
    ...baseScenario(
      'line-multi-parallel',
      '多车·多实线同时违规',
      '三条车道边界实线同时存在，三辆主车分别跨相邻车道边界；预期 3 次 line-enter，背景车不触发。',
      3600,
    ),
    regions: [
      makeLineRegion('SOLID_LINE_A', pathFromTopBottom(0.398, 0.299)),
      makeLineRegion('SOLID_LINE_B', pathFromTopBottom(0.500, 0.515)),
      makeLineRegion('SOLID_LINE_C', pathFromTopBottom(0.598, 0.720)),
    ],
    tracks: [
      makeLaneChangeTrack('car_cross_a', 3600, LEFT_LANE, LEFT_OUTER_LANE, { window: [0.3, 0.6] }),
      makeLaneChangeTrack('car_cross_b', 3600, LEFT_LANE, RIGHT_LANE, { window: [0.4, 0.7] }),
      makeLaneChangeTrack('car_cross_c', 3600, RIGHT_LANE, RIGHT_OUTER_LANE, { window: [0.5, 0.8] }),
      ...makeBackgroundTraffic('lmp', 3600, LEFT_OUTER_LANE, RIGHT_OUTER_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3600),
  },
  {
    ...baseScenario(
      'line-diagonal-concurrent-traffic',
      '斜拍道路·贴线大小车并发变道',
      '三条实线从左下向右上延伸；六辆大小车单向上行。两侧车辆均先由角点接触，再让底边中央带边界跨线。先贴线直行、随机并发变道、再沿目标车道直行；默认无噪声，预期 6 次 line-enter。',
      5200,
    ),
    roadLayout: 'diagonal',
    regions: [
      makeDiagonalLineRegion('DIAGONAL_SOLID_LINE_A', 0.66),
      makeDiagonalLineRegion('DIAGONAL_SOLID_LINE_B', 1.00),
      makeDiagonalLineRegion('DIAGONAL_SOLID_LINE_C', 1.34),
    ],
    tracks: [
      makeDiagonalLaneChangeTrack('truck_diagonal_a', 0.66, DIAGONAL_TRAFFIC_SCHEDULES[0]!.startTime, 0.16, 0.13, 'left-to-right', DIAGONAL_TRAFFIC_SCHEDULES[0]!.changeWindow),
      makeDiagonalLaneChangeTrack('car_diagonal_a', 0.66, DIAGONAL_TRAFFIC_SCHEDULES[1]!.startTime, 0.09, 0.07, 'right-to-left', DIAGONAL_TRAFFIC_SCHEDULES[1]!.changeWindow),
      makeDiagonalLaneChangeTrack('truck_diagonal_b', 1.00, DIAGONAL_TRAFFIC_SCHEDULES[2]!.startTime, 0.16, 0.13, 'right-to-left', DIAGONAL_TRAFFIC_SCHEDULES[2]!.changeWindow),
      makeDiagonalLaneChangeTrack('car_diagonal_b', 1.00, DIAGONAL_TRAFFIC_SCHEDULES[3]!.startTime, 0.09, 0.07, 'left-to-right', DIAGONAL_TRAFFIC_SCHEDULES[3]!.changeWindow),
      makeDiagonalLaneChangeTrack('truck_diagonal_c', 1.34, DIAGONAL_TRAFFIC_SCHEDULES[4]!.startTime, 0.16, 0.13, 'left-to-right', DIAGONAL_TRAFFIC_SCHEDULES[4]!.changeWindow),
      makeDiagonalLaneChangeTrack('car_diagonal_c', 1.34, DIAGONAL_TRAFFIC_SCHEDULES[5]!.startTime, 0.09, 0.07, 'right-to-left', DIAGONAL_TRAFFIC_SCHEDULES[5]!.changeWindow),
    ],
    frameTimes: makeDiscreteFrameTimes(5200),
  },
  {
    ...baseScenario(
      'line-multi-same-time',
      '多车·车流中单车变道',
      '左右车道满背景车流，只有主车跨中央实线；预期仅主车触发一次 line-enter。',
      3600,
    ),
    regions: [CENTER_SOLID_LINE],
    tracks: [
      makeLaneChangeTrack('car_single_violate', 3600, LEFT_LANE, RIGHT_LANE, { window: [0.35, 0.6] }),
      ...makeBackgroundTraffic('lms', 3600, LEFT_OUTER_LANE, RIGHT_OUTER_LANE),
      makeStraightTrack('lms_traffic_l1', 3600, offsetPath(LEFT_LANE, -0.05), { cyStart: 0.1, cyEnd: 0.5, steps: 50 }),
      makeStraightTrack('lms_traffic_r1', 3600, offsetPath(RIGHT_LANE, 0.05), { cyStart: 0.4, cyEnd: 0.9, steps: 50 }),
    ],
    frameTimes: makeDiscreteFrameTimes(3600),
  },
  {
    ...baseScenario(
      'poly-avoid',
      '单导流区·主路正常绕行',
      '主车沿导流区外侧主路直行，远离禁行区；预期无触发。',
      3200,
    ),
    regions: [makeGuideArea('EXIT_GUIDE_AREA').region],
    tracks: [
      makeStraightTrack('car_guide_avoid', 3200, LEFT_LANE),
      ...makeBackgroundTraffic('pga', 3200, LEFT_OUTER_LANE, LEFT_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3200),
  },
  {
    ...baseScenario(
      'poly-corner',
      '单导流区·压角进入',
      '主车从主路向导流区偏移，bbox 中心进入导流区；预期一次 polygon-enter。',
      3200,
    ),
    regions: [makeGuideArea('EXIT_GUIDE_AREA').region],
    tracks: [
      makeLaneChangeTrack('car_guide_enter', 3200, LEFT_LANE, cy => makeGuideArea('EXIT_GUIDE_AREA').centerInsidePath(cy), { window: [0.3, 0.55] }),
      ...makeBackgroundTraffic('pgc', 3200, LEFT_OUTER_LANE, LEFT_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3200),
  },
  {
    ...baseScenario(
      'poly-edge-overlap',
      '单导流区·边缘重叠中心未进入',
      '主车 bbox 边缘与导流区部分重叠（重叠面积比低于 fully-inside 阈值），几何中心始终在外；预期不触发。',
      3200,
    ),
    regions: [makeGuideArea('EXIT_GUIDE_AREA').region],
    tracks: [
      makeLaneChangeTrack('car_guide_edge', 3200, LEFT_LANE, offsetPath(cy => makeGuideArea('EXIT_GUIDE_AREA').centerInsidePath(cy), -0.08), { window: [0.3, 0.55] }),
      ...makeBackgroundTraffic('pge', 3200, LEFT_OUTER_LANE, LEFT_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3200),
  },
  {
    ...baseScenario(
      'poly-cross',
      '单导流区·误入穿越',
      '主车从主路一侧穿越整个导流区再驶离；中心首次进入触发一次 polygon-enter，快速离开不产生第二次。',
      3400,
    ),
    regions: [makeGuideArea('EXIT_GUIDE_AREA').region],
    tracks: [
      makeLaneChangeTrack('car_guide_cross', 3400, LEFT_LANE, offsetPath(cy => makeGuideArea('EXIT_GUIDE_AREA').centerInsidePath(cy), 0.14), { window: [0.25, 0.5] }),
      ...makeBackgroundTraffic('pgx', 3400, LEFT_OUTER_LANE, LEFT_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3400),
  },
  {
    ...baseScenario(
      'poly-stay',
      '单导流区·驶入并停留',
      '主车驶入导流区后原地停留；进入触发一次 polygon-enter，持续占用期间不重复上报。',
      3600,
    ),
    regions: [makeGuideArea('EXIT_GUIDE_AREA').region],
    tracks: [
      {
        objId: 'car_guide_stay',
        keyframes: (() => {
          const frames: KeyframeBBox[] = []
          const driveSteps = 30
          for (let i = 0; i <= driveSteps; i++) {
            const ratio = i / driveSteps
            const cy = lerp(0.2, 0.6, ratio)
            const cx = lerp(LEFT_LANE(cy), makeGuideArea('EXIT_GUIDE_AREA').centerInsidePath(cy), smoothstepWindow(ratio, 0.2, 0.8))
            frames.push({ time: ratio * 1600, rect: makeRect(cx, cy, perspectiveScale(cy)) })
          }
          const staySteps = 14
          for (let i = 1; i <= staySteps; i++) {
            frames.push({ time: 1600 + i * 140, rect: makeRect(makeGuideArea('EXIT_GUIDE_AREA').centerInsidePath(0.6), 0.6, perspectiveScale(0.6)) })
          }
          return frames
        })(),
      },
      ...makeBackgroundTraffic('pgs', 3600, LEFT_OUTER_LANE, LEFT_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3600),
  },
  {
    ...baseScenario(
      'poly-stutter',
      '单导流区·压角丢帧',
      '主车接近导流区过程中出现短时丢帧（间隔小于 tracker 超时），随后中心进入；tracker 不被破坏，预期一次 polygon-enter。',
      3200,
    ),
    regions: [makeGuideArea('EXIT_GUIDE_AREA').region],
    tracks: [
      makeLaneChangeTrack('car_guide_stutter', 3200, LEFT_LANE, cy => makeGuideArea('EXIT_GUIDE_AREA').centerInsidePath(cy), { window: [0.3, 0.55] }),
      ...makeBackgroundTraffic('pgt', 3200, LEFT_OUTER_LANE, LEFT_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3200),
  },
  {
    ...baseScenario(
      'real-low-fps-line-cross',
      '真实启发·低帧率实线穿越',
      '低帧率长间隔后仍以同 ID 首尾有效 bbox 连接稀疏轨迹；穿线发生在间隔之后，预期一次 line-enter。',
      3600,
    ),
    regions: [CENTER_SOLID_LINE],
    tracks: [
      makeLaneChangeTrack('car_real_lowfps_cross', 3600, LEFT_LANE, RIGHT_LANE, { window: [0.35, 0.6] }),
      ...makeBackgroundTraffic('rlf', 3600, LEFT_OUTER_LANE, RIGHT_OUTER_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3600, 1200),
  },
  {
    ...baseScenario(
      'real-burst-gap-prune',
      '真实启发·长间隔 prune 后重新穿线',
      '主车跨线触发一次后遭遇超时丢失（tracker prune + 已上报 tombstone），重新出现并再次跨线；tombstone 在 5s 内阻止重复上报，预期仍只有一次触发。',
      5200,
    ),
    regions: [CENTER_SOLID_LINE],
    tracks: [
      makeLaneChangeTrack('car_burst_gap', 5200, LEFT_LANE, RIGHT_LANE, { window: [0.1, 0.3] }),
      ...makeBackgroundTraffic('rbg', 5200, LEFT_OUTER_LANE, RIGHT_OUTER_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(5200, 1400),
  },
  {
    ...baseScenario(
      'real-id-fragment-ghosts',
      '真实启发·短生命周期 ghost',
      '中央实线附近出现多个只存活 1-2 帧的 ghost 目标；未达到 MIN_TRACKER_AGE_FRAMES 预热即消失，预期不触发。',
      3200,
    ),
    regions: [CENTER_SOLID_LINE],
    tracks: [
      ...makeGhostTracks('ghost_line', CENTER_SOLID_LINE.points[1]!.x, 5),
      ...makeBackgroundTraffic('gif', 3200, LEFT_OUTER_LANE, RIGHT_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(3200),
  },
  {
    ...baseScenario(
      'real-dense-traffic-single-violation',
      '真实启发·密集车流中单车违规',
      '约 20 辆背景车同场，只有主车跨中央实线；预期仅主车触发一次 line-enter。',
      3600,
    ),
    regions: [CENTER_SOLID_LINE],
    tracks: [
      makeLaneChangeTrack('car_dense_violate', 3600, LEFT_LANE, RIGHT_LANE, { window: [0.35, 0.6] }),
      ...makeDenseBackgroundTraffic('rdt', 3600),
    ],
    frameTimes: makeDiscreteFrameTimes(3600),
  },
  {
    ...baseScenario(
      'mixed-realistic-main-road-exit',
      '混合·主路实线 + 右侧导流区 + 多车',
      '主路中央实线与右侧出口导流区同场：一辆车跨实线、一辆车误入导流区；预期各触发一次，标注拓扑真实互不重叠。',
      4000,
    ),
    regions: [
      CENTER_SOLID_LINE,
      makeGuideArea('EXIT_GUIDE_AREA').region,
    ],
    tracks: [
      makeLaneChangeTrack('car_mixed_line', 4000, LEFT_LANE, RIGHT_LANE, { window: [0.3, 0.6] }),
      makeLaneChangeTrack('car_mixed_guide', 4000, RIGHT_OUTER_LANE, cy => makeGuideArea('EXIT_GUIDE_AREA').centerInsidePath(cy), { window: [0.4, 0.7], cyStart: 0.3, cyEnd: 0.8 }),
      ...makeBackgroundTraffic('mre', 4000, LEFT_OUTER_LANE, LEFT_LANE),
    ],
    frameTimes: makeDiscreteFrameTimes(4000),
  },
]

function makeGhostTracks (prefix: string, lineX: number, count: number): BBoxTrack[] {
  const tracks: BBoxTrack[] = []
  for (let i = 0; i < count; i++) {
    const cy = 0.35 + i * 0.08
    const startTime = 400 + i * 420
    tracks.push({
      objId: `${prefix}_${i}`,
      keyframes: [
        { time: startTime, rect: makeRect(lineX - 0.05, cy, perspectiveScale(cy)) },
        { time: startTime + 560, rect: makeRect(lineX + 0.02, cy, perspectiveScale(cy)) },
      ],
    })
  }
  return tracks
}

function makeDenseBackgroundTraffic (idPrefix: string, duration: number): BBoxTrack[] {
  const lanes = [LEFT_OUTER_LANE, offsetPath(LEFT_OUTER_LANE, 0.05), LEFT_LANE, RIGHT_LANE, RIGHT_OUTER_LANE, offsetPath(RIGHT_OUTER_LANE, -0.05)]
  const tracks: BBoxTrack[] = []
  lanes.forEach((lane, laneIndex) => {
    for (let i = 0; i < 3; i++) {
      const cyStart = 0.08 + i * 0.3 + laneIndex * 0.04
      const cyEnd = Math.min(0.95, cyStart + 0.5)
      tracks.push(makeStraightTrack(`${idPrefix}_traffic_${laneIndex}_${i}`, duration, lane, { cyStart, cyEnd, steps: 50 }))
    }
  })
  return tracks
}

export { SCENARIOS }
