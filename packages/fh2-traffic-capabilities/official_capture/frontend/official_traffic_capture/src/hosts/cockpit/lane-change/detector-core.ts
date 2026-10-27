// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/** 变道抓拍检测核心：纯同步状态机，不包含截图、回调或候选确认流程。 */
import type { BBoxRect, OverlapState } from './bbox-polygon-overlap'
import { classifyBboxPolygonOverlap, polygonToTurfFeature } from './bbox-polygon-overlap'
import { type BottomEdge, type Interval, clipLinearInterval, sweepBottomEdge } from './bottom-edge-sweep'

export type ObjId = number | string

export interface Point2D {
  readonly x: number;
  readonly y: number;
}

export type LaneChangeRule = 'line-enter' | 'line-occupy' | 'polygon-enter' | 'polygon-fully-inside'

export interface LaneChangeTriggerEvent {
  readonly objId: ObjId;
  readonly regionId: string;
  readonly rule: LaneChangeRule;
  readonly crossedAt: number;
}

export type ValidCoreRegion = {
  readonly id: string;
  readonly valid: true;
  readonly points: readonly Point2D[];
} & ({ readonly kind: 'line' } | { readonly kind: 'polygon' })

export type CoreRegion = ValidCoreRegion | {
  readonly id: string;
  readonly kind: 'line' | 'polygon';
  readonly valid: false;
}

export interface CoreBBox {
  readonly objId: ObjId;
  readonly rect: BBoxRect;
}

export interface FrameInput {
  readonly now: number;
  readonly sequence: number;
  readonly continuous: boolean;
  readonly regions: readonly CoreRegion[];
  readonly bboxes: readonly CoreBBox[];
}

export interface DetectorCoreInstance {
  processFrame (input: FrameInput): readonly LaneChangeTriggerEvent[];
  reset (): void;
}

/** 可调参数集合；默认值见 DEFAULT_DETECTOR_PARAMS，算法测试页经 paramsOverride 覆盖。 */
export interface DetectorCoreParams {
  /** tracker 老化：N ms 未出现即销毁，并按需落 tombstone。 */
  readonly TRACKER_TIMEOUT_MS: number;
  /** tracker 至少累计 N 帧后才参与规则判断。 */
  readonly MIN_TRACKER_AGE_FRAMES: number;
  /** polygon：bbox 与 polygon 重叠面积 / bbox 面积 ≥ 此值判为 fully-inside。 */
  readonly POLYGON_OVERLAP_T_FULL: number;
  /** polygon：从相交回到 disjoint 的离开去抖窗口。 */
  readonly POLYGON_OVERLAP_DEBOUNCE_MS: number;
  /** 实线：footprint 持续压线达到 N ms 触发 line-occupy。 */
  readonly LINE_OCCUPY_MS: number;
  /** 实线：footprint 从 bbox 的此 y 比例开始截取，只看车辆下半部接地区域。 */
  readonly LINE_OCCUPY_FOOTPRINT_MIN_Y_SHARE: number;
  /** 实线：静态 footprint 近线与 episode 接触清除容差；不参与动态跨线确认。 */
  readonly LINE_OCCUPY_DISTANCE_TOLERANCE: number;
  /** 实线：占线确认要求投影线本身足够稳定，避免线漂移扫过车辆造成误报。 */
  readonly LINE_OCCUPY_MAX_LINE_DRIFT: number;
  /** 实线：占线累计窗口内 bbox 中心总位移上限。 */
  readonly LINE_OCCUPY_MAX_TOTAL_MOVE: number;
  /** 实线：相邻帧 bbox 中心位移上限，过滤缓慢沿线行驶的持续压框。 */
  readonly LINE_OCCUPY_MAX_FRAME_MOVE: number;
  /** 实线：底边中央带到线的距离需小于车辆短边的此比例。 */
  readonly LINE_OCCUPY_CENTER_DISTANCE_RATIO: number;
  /** 实线：底边中央带到线的绝对距离上限。 */
  readonly LINE_OCCUPY_CENTER_DISTANCE_MAX: number;
  /** 实线：跨前累计的最小主动法向位移；进入此接近范围后冻结运动基准。 */
  readonly LINE_MIN_NORMAL_MOVE: number;
  /** 实线：确认要求车辆主动法线位移至少解释 signed-distance 变化的比例。 */
  readonly LINE_MIN_ACTIVE_MOVE_SHARE: number;
  /** 已上报 episode 需连续明确清除 N ms 后才允许重新上报。 */
  readonly EPISODE_CLEAR_MS: number;
  /** tracker prune 时为已上报 (objId × region) 落 tombstone 的时长。 */
  readonly REPORTED_TOMBSTONE_MS: number;
}

export const DEFAULT_DETECTOR_PARAMS: Readonly<DetectorCoreParams> = {
  TRACKER_TIMEOUT_MS: 1500,
  MIN_TRACKER_AGE_FRAMES: 3,
  POLYGON_OVERLAP_T_FULL: 0.5,
  POLYGON_OVERLAP_DEBOUNCE_MS: 200,
  LINE_OCCUPY_MS: 1000,
  LINE_OCCUPY_FOOTPRINT_MIN_Y_SHARE: 0.55,
  LINE_OCCUPY_DISTANCE_TOLERANCE: 0.006,
  LINE_OCCUPY_MAX_LINE_DRIFT: 0.001,
  LINE_OCCUPY_MAX_TOTAL_MOVE: 0.006,
  LINE_OCCUPY_MAX_FRAME_MOVE: 0.003,
  LINE_OCCUPY_CENTER_DISTANCE_RATIO: 0.25,
  LINE_OCCUPY_CENTER_DISTANCE_MAX: 0.012,
  LINE_MIN_NORMAL_MOVE: 0.0005,
  LINE_MIN_ACTIVE_MOVE_SHARE: 0.5,
  EPISODE_CLEAR_MS: 1000,
  REPORTED_TOMBSTONE_MS: 5000,
}

export interface DetectorCoreOptions {
  readonly paramsOverride?: Partial<DetectorCoreParams>;
}

interface TrackPoint {
  readonly cx: number;
  readonly cy: number;
  readonly w: number;
  readonly h: number;
}

interface BottomEdgeSource {
  readonly startTrack: TrackPoint;
  readonly a: Point2D;
  readonly b: Point2D;
  readonly side: 1 | -1;
  /** 已经实际扫过线段的位置；不把多帧弯曲轨迹连成一条虚构直线。 */
  contacts: Interval[];
}

interface RegionState {
  kind: CoreRegion['kind'];
  initialized: boolean;
  polygonOverlapState: OverlapState;
  pendingDisjointSinceTs: number | null;
  centerInside: boolean;
  lineOccupySinceTs: number | null;
  lineOccupyStartCenter: Point2D | null;
  bottomBandLeftSources: Array<BottomEdgeSource | null>;
  bottomBandRightSources: Array<BottomEdgeSource | null>;
  lastLinePoints: Point2D[] | null;
  reported: boolean;
  clearSinceTs: number | null;
}

interface TrackerEntry {
  readonly objId: ObjId;
  lastSeen: number;
  framesObserved: number;
  previousTrack: TrackPoint | null;
  perRegion: Map<string, RegionState>;
}

interface Tombstone {
  readonly expiresAt: number;
}

// === 基础几何 ===============================================================

export function segmentsIntersect (a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  const d1 = crossProduct(c, d, a)
  const d2 = crossProduct(c, d, b)
  const d3 = crossProduct(a, b, c)
  const d4 = crossProduct(a, b, d)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  if (d1 === 0 && onSegment(c, d, a)) return true
  if (d2 === 0 && onSegment(c, d, b)) return true
  if (d3 === 0 && onSegment(a, b, c)) return true
  if (d4 === 0 && onSegment(a, b, d)) return true
  return false
}

function crossProduct (a: Point2D, b: Point2D, p: Point2D): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
}

function onSegment (a: Point2D, b: Point2D, p: Point2D): boolean {
  return p.x >= Math.min(a.x, b.x) - 1e-12 && p.x <= Math.max(a.x, b.x) + 1e-12
    && p.y >= Math.min(a.y, b.y) - 1e-12 && p.y <= Math.max(a.y, b.y) + 1e-12
}

export function pointInPolygon (p: Point2D, polygon: readonly Point2D[]): boolean {
  let inside = false
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const a = polygon[current]!
    const b = polygon[previous]!
    const crosses = (a.y > p.y) !== (b.y > p.y)
      && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    if (crosses) inside = !inside
  }
  return inside
}

function distancePointToSegment (p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function pointInPolygonOrBoundary (p: Point2D, polygon: readonly Point2D[]): boolean {
  if (polygon.length < 3) return false
  for (let i = 0; i < polygon.length; i++) {
    if (distancePointToSegment(p, polygon[i]!, polygon[(i + 1) % polygon.length]!) < 1e-10) return true
  }
  return pointInPolygon(p, polygon)
}

function bboxContainsPoint (bbox: BBoxRect, p: Point2D): boolean {
  return p.x >= bbox.x1 && p.x <= bbox.x2 && p.y >= bbox.y1 && p.y <= bbox.y2
}

function bboxIntersectsSegment (bbox: BBoxRect, p1: Point2D, p2: Point2D): boolean {
  if (bboxContainsPoint(bbox, p1) || bboxContainsPoint(bbox, p2)) return true
  const tl = { x: bbox.x1, y: bbox.y1 }
  const tr = { x: bbox.x2, y: bbox.y1 }
  const br = { x: bbox.x2, y: bbox.y2 }
  const bl = { x: bbox.x1, y: bbox.y2 }
  return segmentsIntersect(tl, tr, p1, p2)
    || segmentsIntersect(tr, br, p1, p2)
    || segmentsIntersect(br, bl, p1, p2)
    || segmentsIntersect(bl, tl, p1, p2)
}

function distancePointToRect (p: Point2D, bbox: BBoxRect): number {
  if (bboxContainsPoint(bbox, p)) return 0
  return Math.hypot(Math.max(bbox.x1 - p.x, 0, p.x - bbox.x2), Math.max(bbox.y1 - p.y, 0, p.y - bbox.y2))
}

function distanceSegmentToRect (a: Point2D, b: Point2D, bbox: BBoxRect): number {
  if (bboxIntersectsSegment(bbox, a, b)) return 0
  const corners = [
    { x: bbox.x1, y: bbox.y1 },
    { x: bbox.x2, y: bbox.y1 },
    { x: bbox.x2, y: bbox.y2 },
    { x: bbox.x1, y: bbox.y2 },
  ]
  let best = Math.min(distancePointToRect(a, bbox), distancePointToRect(b, bbox))
  for (const corner of corners) best = Math.min(best, distancePointToSegment(corner, a, b))
  return best
}

function minDistanceBboxToPolyline (bbox: BBoxRect, polyline: readonly Point2D[]): number {
  let minDist = Infinity
  for (let i = 0; i < polyline.length - 1; i++) {
    minDist = Math.min(minDist, distanceSegmentToRect(polyline[i]!, polyline[i + 1]!, bbox))
  }
  return minDist
}

// === 实线几何 ===============================================================

function footprintFromBboxRect (bbox: BBoxRect, minShare: number): BBoxRect {
  return { ...bbox, y1: bbox.y1 + (bbox.y2 - bbox.y1) * minShare }
}

function bboxIntersectsPolyline (bbox: BBoxRect, polyline: readonly Point2D[]): { hit: boolean; segIdx: number } {
  for (let i = 0; i < polyline.length - 1; i++) {
    if (bboxIntersectsSegment(bbox, polyline[i]!, polyline[i + 1]!)) return { hit: true, segIdx: i }
  }
  return { hit: false, segIdx: -1 }
}

function lineOccupyStateFromFootprint (
  bbox: BBoxRect,
  linePoints: readonly Point2D[],
  distanceTolerance: number,
  footprintMinYShare: number,
): { occupying: boolean } {
  const footprint = footprintFromBboxRect(bbox, footprintMinYShare)
  const intersect = bboxIntersectsPolyline(footprint, linePoints)
  return { occupying: intersect.hit || minDistanceBboxToPolyline(footprint, linePoints) <= distanceTolerance }
}

function clonePoints (points: readonly Point2D[]): Point2D[] {
  return points.map(point => ({ x: point.x, y: point.y }))
}

function maxPolylinePointDelta (previous: Point2D[] | null, current: readonly Point2D[]): number {
  if (!previous) return 0
  if (previous.length !== current.length) return Number.POSITIVE_INFINITY
  let maxDelta = 0
  for (let i = 0; i < current.length; i++) {
    maxDelta = Math.max(maxDelta, Math.hypot(current[i]!.x - previous[i]!.x, current[i]!.y - previous[i]!.y))
  }
  return maxDelta
}

function signedDistanceToSegmentNormal (p: Point2D, a: Point2D, b: Point2D): {
  signedDistance: number;
  normal: Point2D;
  projectionT: number;
} | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return null
  const normal = { x: -dy / len, y: dx / len }
  const apx = p.x - a.x
  const apy = p.y - a.y
  return {
    signedDistance: apx * normal.x + apy * normal.y,
    normal,
    projectionT: (apx * dx + apy * dy) / (len * len),
  }
}

const BOTTOM_BAND_MIN = 0.4
const BOTTOM_BAND_MAX = 0.6
const LINE_GEOMETRY_EPSILON = 1e-10

function bottomEdgePoint (track: TrackPoint, position: number): BottomEdge {
  const x = track.cx + (position - 0.5) * track.w
  return { left: x, right: x, y: track.cy + track.h / 2 }
}

/** 精确保留实际接触位置的并集，不把两个分离的接触区间中间补成接触。 */
function addContact (contacts: Interval[], contact: Interval): Interval[] {
  const merged: Array<[number, number]> = []
  for (const interval of [...contacts, contact].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1]
    if (last && interval[0] <= last[1] + 1e-10) last[1] = Math.max(last[1], interval[1])
    else merged.push([interval[0], interval[1]])
  }
  return merged
}

/**
 * 中央带边界点有来源侧后，记录相邻有效帧真正扫过有限线段的接触，再累计跨侧证据。
 * u=0.4/0.6 分别覆盖两侧进入中央带；角点或阈值点只穿过延长线都不能触发。
 */
function updateLineCrossingSources (
  sources: Array<BottomEdgeSource | null>,
  previous: TrackPoint | null,
  current: TrackPoint,
  linePoints: readonly Point2D[],
  params: DetectorCoreParams,
  warmup: boolean,
  edgePosition: number,
): boolean {
  const edge = bottomEdgePoint(current, edgePosition)
  let crossed = false
  if (sources.length !== linePoints.length - 1 || warmup) sources.length = 0
  for (let segmentIndex = 0; segmentIndex < linePoints.length - 1; segmentIndex++) {
    const a = linePoints[segmentIndex]!
    const b = linePoints[segmentIndex + 1]!
    const left = signedDistanceToSegmentNormal({ x: edge.left, y: edge.y }, a, b)
    const right = signedDistanceToSegmentNormal({ x: edge.right, y: edge.y }, a, b)
    let source = sources[segmentIndex] ?? null
    if (!left || !right) {
      sources[segmentIndex] = null
      continue
    }
    if (source && previous && !warmup) {
      // 以当前帧标线为固定参考检查车辆运动；线漂移由下方主动位移占比单独约束。
      const contact = sweepBottomEdge(bottomEdgePoint(previous, edgePosition), edge, a, b)
      if (contact) source.contacts = addContact(source.contacts, contact.positions)
      const start = bottomEdgePoint(source.startTrack, edgePosition)
      const startLeft = signedDistanceToSegmentNormal({ x: start.left, y: start.y }, source.a, source.b)!.signedDistance
      const startRight = signedDistanceToSegmentNormal({ x: start.right, y: start.y }, source.a, source.b)!.signedDistance
      const normalMove = (current.cx - source.startTrack.cx) * left.normal.x
        + (current.cy - source.startTrack.cy) * left.normal.y
      let consumed = false
      for (const positions of source.contacts) {
        // 到达中央带边界即判几何成立；只保留浮点误差，不要求跨后再深入。
        let entered = clipLinearInterval(positions, -source.side * left.signedDistance, -source.side * right.signedDistance)
        if (!entered) continue
        consumed = true
        if (normalMove * source.side >= 0 || Math.abs(normalMove) + LINE_GEOMETRY_EPSILON < params.LINE_MIN_NORMAL_MOVE) continue
        if (params.LINE_MIN_ACTIVE_MOVE_SHARE > 0) {
          const budget = Math.abs(normalMove) / params.LINE_MIN_ACTIVE_MOVE_SHARE
          const deltaLeft = left.signedDistance - startLeft
          const deltaRight = right.signedDistance - startRight
          entered = clipLinearInterval(entered, budget - deltaLeft, budget - deltaRight)
          if (entered) entered = clipLinearInterval(entered, budget + deltaLeft, budget + deltaRight)
        }
        if (entered) crossed = true
      }
      // 已跨侧但运动证据不足也消费，不能靠后续沿线行驶补报。
      if (consumed) source = null
      if (source?.contacts.length && distanceSegmentToRect(a, b, {
        x1: edge.left,
        x2: edge.right,
        y1: edge.y,
        y2: edge.y,
      }) > LINE_GEOMETRY_EPSILON) {
        source = null
      }
    }
    const min = Math.min(left.signedDistance, right.signedDistance)
    const max = Math.max(left.signedDistance, right.signedDistance)
    const side = min >= -LINE_GEOMETRY_EPSILON && max > LINE_GEOMETRY_EPSILON ? 1 : max <= LINE_GEOMETRY_EPSILON && min < -LINE_GEOMETRY_EPSILON ? -1 : null
    if (side !== null) {
      const distance = Math.min(Math.abs(min), Math.abs(max))
      // 接近标线后冻结跨前基准，避免慢速移动被逐帧刷新成单帧位移门槛。
      // 同侧退离接近范围或换侧后建立新基准，不把旧运动用于下一次接触。
      if (!source || source.side !== side || distance > params.LINE_MIN_NORMAL_MOVE) {
        source = { startTrack: { ...current }, a: { ...a }, b: { ...b }, side, contacts: [] }
      }
    }
    sources[segmentIndex] = source
  }
  return crossed
}

// === 状态机 =================================================================

function createRegionState (kind: CoreRegion['kind'], reported: boolean): RegionState {
  return {
    kind,
    initialized: false,
    polygonOverlapState: 'disjoint',
    pendingDisjointSinceTs: null,
    centerInside: false,
    lineOccupySinceTs: null,
    lineOccupyStartCenter: null,
    bottomBandLeftSources: [],
    bottomBandRightSources: [],
    lastLinePoints: null,
    reported,
    clearSinceTs: null,
  }
}

function resetTemporalState (state: RegionState): void {
  state.initialized = false
  state.polygonOverlapState = 'disjoint'
  state.pendingDisjointSinceTs = null
  state.centerInside = false
  state.lineOccupySinceTs = null
  state.lineOccupyStartCenter = null
  state.bottomBandLeftSources = []
  state.bottomBandRightSources = []
  state.lastLinePoints = null
  state.clearSinceTs = null
}

/** 目标短暂缺席时只中断需要连续观测的计时，位置轨迹由 objId 在超时窗口内续接。 */
function interruptContinuousEvidence (state: RegionState): void {
  state.lineOccupySinceTs = null
  state.lineOccupyStartCenter = null
  state.pendingDisjointSinceTs = null
  state.clearSinceTs = null
}

function observeEpisode (state: RegionState, violating: boolean, now: number, clearMs: number): void {
  if (violating) {
    state.clearSinceTs = null
    return
  }
  if (!state.reported) return
  if (state.clearSinceTs === null) state.clearSinceTs = now
  if (now - state.clearSinceTs >= clearMs) {
    state.reported = false
    state.clearSinceTs = null
  }
}

export function createDetectorCore (options: DetectorCoreOptions = {}): DetectorCoreInstance {
  const params: DetectorCoreParams = { ...DEFAULT_DETECTOR_PARAMS, ...options.paramsOverride }
  const trackerMap = new Map<ObjId, TrackerEntry>()
  const tombstones = new Map<ObjId, Map<string, Tombstone>>()
  let lastSequence: number | null = null

  function hasTombstone (objId: ObjId, regionId: string, now: number): boolean {
    const perRegion = tombstones.get(objId)
    const tombstone = perRegion?.get(regionId)
    if (!tombstone || tombstone.expiresAt <= now) return false
    return true
  }

  function clearTombstone (objId: ObjId, regionId: string): void {
    const perRegion = tombstones.get(objId)
    perRegion?.delete(regionId)
    if (perRegion?.size === 0) tombstones.delete(objId)
  }

  function prune (now: number): void {
    for (const [objId, perRegion] of tombstones) {
      for (const [regionId, tombstone] of perRegion) {
        if (tombstone.expiresAt <= now) perRegion.delete(regionId)
      }
      if (perRegion.size === 0) tombstones.delete(objId)
    }
    for (const [objId, tracker] of trackerMap) {
      if (now - tracker.lastSeen <= params.TRACKER_TIMEOUT_MS) continue
      for (const [regionId, state] of tracker.perRegion) {
        if (!state.reported) continue
        let perRegion = tombstones.get(objId)
        if (!perRegion) {
          perRegion = new Map()
          tombstones.set(objId, perRegion)
        }
        perRegion.set(regionId, { expiresAt: now + params.REPORTED_TOMBSTONE_MS })
      }
      trackerMap.delete(objId)
    }
  }

  function emitIfArmed (
    tracker: TrackerEntry,
    region: ValidCoreRegion,
    state: RegionState,
    rule: LaneChangeRule | null,
    now: number,
    events: LaneChangeTriggerEvent[],
  ): void {
    if (!rule || state.reported) return
    state.reported = true
    state.clearSinceTs = null
    events.push({ objId: tracker.objId, regionId: region.id, rule, crossedAt: now })
  }

  function handleLine (
    tracker: TrackerEntry,
    region: ValidCoreRegion,
    state: RegionState,
    currentTrack: TrackPoint,
    bbox: BBoxRect,
    now: number,
    events: LaneChangeTriggerEvent[],
  ): void {
    const points = region.points.filter((point, index, all) => index === 0
      || Math.hypot(point.x - all[index - 1]!.x, point.y - all[index - 1]!.y) > 1e-10)
    if (points.length < 2) {
      resetTemporalState(state)
      return
    }
    const previousPoints = state.lastLinePoints
    state.lastLinePoints = clonePoints(points)
    const centralBandDistanceLimit = Math.min(
      Math.min(currentTrack.w, currentTrack.h) * params.LINE_OCCUPY_CENTER_DISTANCE_RATIO,
      params.LINE_OCCUPY_CENTER_DISTANCE_MAX,
    )
    const warmingUp = tracker.framesObserved < params.MIN_TRACKER_AGE_FRAMES
    const leftBandCrossing = updateLineCrossingSources(state.bottomBandLeftSources, tracker.previousTrack, currentTrack, points, params, warmingUp, BOTTOM_BAND_MIN)
    const rightBandCrossing = updateLineCrossingSources(state.bottomBandRightSources, tracker.previousTrack, currentTrack, points, params, warmingUp, BOTTOM_BAND_MAX)
    if (!state.initialized) {
      state.initialized = true
      return
    }

    if (warmingUp) return
    const confirmedCrossing = leftBandCrossing || rightBandCrossing
    const center = { x: currentTrack.cx, y: currentTrack.cy }
    const occupy = lineOccupyStateFromFootprint(
      bbox,
      points,
      params.LINE_OCCUPY_DISTANCE_TOLERANCE,
      params.LINE_OCCUPY_FOOTPRINT_MIN_Y_SHARE,
    )
    const centralBottomEdge = {
      x1: bbox.x1 + currentTrack.w * BOTTOM_BAND_MIN,
      x2: bbox.x1 + currentTrack.w * BOTTOM_BAND_MAX,
      y1: bbox.y2,
      y2: bbox.y2,
    }
    const frameMove = tracker.previousTrack
      ? Math.hypot(tracker.previousTrack.cx - currentTrack.cx, tracker.previousTrack.cy - currentTrack.cy)
      : 0
    const occupyStart = state.lineOccupyStartCenter ?? center
    const totalMove = Math.hypot(occupyStart.x - center.x, occupyStart.y - center.y)
    const stationary = frameMove <= params.LINE_OCCUPY_MAX_FRAME_MOVE && totalMove <= params.LINE_OCCUPY_MAX_TOTAL_MOVE
    const centralBandAligned = minDistanceBboxToPolyline(centralBottomEdge, points) <= centralBandDistanceLimit
    const lineStable = maxPolylinePointDelta(previousPoints, points) <= params.LINE_OCCUPY_MAX_LINE_DRIFT
    const occupyingViolation = occupy.occupying && stationary && centralBandAligned && lineStable

    if (confirmedCrossing || !occupyingViolation) {
      state.lineOccupySinceTs = null
      state.lineOccupyStartCenter = null
    } else if (state.lineOccupySinceTs === null) {
      state.lineOccupySinceTs = now
      state.lineOccupyStartCenter = center
    }

    const occupiedLongEnough = state.lineOccupySinceTs !== null
      && now - state.lineOccupySinceTs >= params.LINE_OCCUPY_MS
    const rule: LaneChangeRule | null = confirmedCrossing ? 'line-enter' : occupiedLongEnough ? 'line-occupy' : null
    const bottomContact = minDistanceBboxToPolyline({ ...bbox, y1: bbox.y2 }, points)
      <= params.LINE_OCCUPY_DISTANCE_TOLERANCE
    observeEpisode(state, confirmedCrossing || occupyingViolation || bottomContact, now, params.EPISODE_CLEAR_MS)
    emitIfArmed(tracker, region, state, rule, now, events)
  }

  function handlePolygon (
    tracker: TrackerEntry,
    region: ValidCoreRegion,
    state: RegionState,
    bbox: BBoxRect,
    polygonFeature: ReturnType<typeof polygonToTurfFeature>,
    now: number,
    events: LaneChangeTriggerEvent[],
  ): void {
    if (region.points.length < 3 || !polygonFeature) {
      resetTemporalState(state)
      return
    }
    const { state: rawState } = classifyBboxPolygonOverlap(bbox, polygonFeature, params.POLYGON_OVERLAP_T_FULL)
    let nextState = rawState
    if (rawState === 'disjoint' && state.polygonOverlapState !== 'disjoint') {
      if (state.pendingDisjointSinceTs === null) state.pendingDisjointSinceTs = now
      if (now - state.pendingDisjointSinceTs < params.POLYGON_OVERLAP_DEBOUNCE_MS) nextState = state.polygonOverlapState
    } else {
      state.pendingDisjointSinceTs = null
    }
    const centerInside = pointInPolygonOrBoundary({ x: (bbox.x1 + bbox.x2) / 2, y: (bbox.y1 + bbox.y2) / 2 }, region.points)
    if (tracker.framesObserved < params.MIN_TRACKER_AGE_FRAMES) return
    if (!state.initialized) {
      state.initialized = true
    }

    const centerEntered = !state.centerInside && centerInside
    const overlapEntered = state.polygonOverlapState !== 'fully-inside' && nextState === 'fully-inside'
    state.polygonOverlapState = nextState
    state.centerInside = centerInside
    // 必须明确 disjoint 才算离开；partial 仍是同一次区域接触，不能据此 re-arm。
    const violating = centerInside || nextState !== 'disjoint'
    observeEpisode(state, violating, now, params.EPISODE_CLEAR_MS)
    emitIfArmed(
      tracker,
      region,
      state,
      centerEntered ? 'polygon-enter' : overlapEntered ? 'polygon-fully-inside' : null,
      now,
      events,
    )
  }

  function processFrame (input: FrameInput): readonly LaneChangeTriggerEvent[] {
    const { now, sequence, regions, bboxes } = input
    prune(now)

    const frameContinuous = input.continuous && (lastSequence === null || sequence === lastSequence + 1)
    lastSequence = sequence
    if (!frameContinuous) {
      for (const tracker of trackerMap.values()) {
        for (const state of tracker.perRegion.values()) interruptContinuousEvidence(state)
      }
    }
    const polygonFeatures = new Map<string, ReturnType<typeof polygonToTurfFeature>>()
    const currentRegions = new Map(regions.map(region => [region.id, region]))
    const currentRegionIds = new Set(regions.map(region => region.id))
    for (const region of regions) {
      if (region.valid && region.kind === 'polygon') polygonFeatures.set(region.id, polygonToTurfFeature(region.points))
    }

    const currentObjIds = new Set(bboxes.map(bbox => bbox.objId))
    for (const tracker of trackerMap.values()) {
      for (const [regionId, state] of tracker.perRegion) {
        const region = currentRegions.get(regionId)
        if (!region || !region.valid || region.kind !== state.kind) resetTemporalState(state)
      }
      if (!currentObjIds.has(tracker.objId)) {
        for (const state of tracker.perRegion.values()) interruptContinuousEvidence(state)
      }
    }

    const events: LaneChangeTriggerEvent[] = []
    for (const bbox of bboxes) {
      let tracker = trackerMap.get(bbox.objId)
      if (!tracker) {
        tracker = {
          objId: bbox.objId,
          lastSeen: now,
          framesObserved: 0,
          previousTrack: null,
          perRegion: new Map(),
        }
        trackerMap.set(bbox.objId, tracker)
      }
      tracker.lastSeen = now
      tracker.framesObserved += 1
      const width = bbox.rect.x2 - bbox.rect.x1
      const height = bbox.rect.y2 - bbox.rect.y1
      const currentTrack = {
        cx: bbox.rect.x1 + width / 2,
        cy: bbox.rect.y1 + height / 2,
        w: width,
        h: height,
      }
      for (const [regionId, state] of tracker.perRegion) {
        if (!currentRegionIds.has(regionId)) resetTemporalState(state)
      }

      for (const region of regions) {
        let state = tracker.perRegion.get(region.id)
        if (!state || state.kind !== region.kind) {
          state = createRegionState(region.kind, hasTombstone(bbox.objId, region.id, now))
          tracker.perRegion.set(region.id, state)
        }
        if (!region.valid) {
          resetTemporalState(state)
          continue
        }
        if (region.kind === 'line') {
          handleLine(tracker, region, state, currentTrack, bbox.rect, now, events)
        } else {
          handlePolygon(tracker, region, state, bbox.rect, polygonFeatures.get(region.id) ?? null, now, events)
        }
        if (!state.reported) clearTombstone(bbox.objId, region.id)
      }
      tracker.previousTrack = currentTrack
    }
    return events
  }

  function reset (): void {
    trackerMap.clear()
    tombstones.clear()
    lastSequence = null
  }

  return { processFrame, reset }
}
