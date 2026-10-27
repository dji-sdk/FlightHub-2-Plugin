// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * bbox × polygon 3 态判定（disjoint / partial / fully-inside）。
 *
 * 从原生 宿主原生 lane-change-capture 同名实现
 * 一比一移植（@turf/intersect + @turf/boolean-disjoint + @turf/helpers 实现）。
 *
 * 实现细节：
 * - bbox 当作 4 点 polygon，用 @turf/intersect 算重叠面积比
 * - 不设最低 overlap 阈值过滤 partial；是否把边缘压角升级为硬证据由调用方决定。
 * - 性能优化（必做，热路径每帧调用）：
 *   1. axis-aligned bbox 快速排除（O(1)，不调 turf）
 *   2. annotation polygon 转 turf feature 在 region 级缓存（每 region 一次性 polygonize）
 */
import { booleanDisjoint as turfBooleanDisjoint } from '@turf/boolean-disjoint'
import { featureCollection, polygon as turfPolygon } from '@turf/helpers'
import { intersect as turfIntersect } from '@turf/intersect'
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson'

export type OverlapState = 'disjoint' | 'partial' | 'fully-inside'

export interface BBoxRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface OverlapResult {
  state: OverlapState;
  /** 重叠面积 / bbox 面积，[0,1]；disjoint 时 = 0 */
  ratio: number;
}

/**
 * 把 annotation polygon 的屏幕投影点列表转成 turf Feature<Polygon>。
 * detector 每个 region 一次性调用并缓存结果；不要每帧调。
 *
 * 输入需至少 3 个点。turf polygon 要求首尾闭合（点 N 与点 0 重合），本函数自动闭合。
 */
export function polygonToTurfFeature (points: ReadonlyArray<{ x: number; y: number }>): Feature<Polygon> | null {
  if (points.length < 3) return null
  // 自动闭合：首尾相同则不再 push
  const coords: Array<[number, number]> = points.map(p => [p.x, p.y])
  const first = coords[0]!
  const last = coords[coords.length - 1]!
  if (first[0] !== last[0] || first[1] !== last[1]) {
    coords.push([first[0], first[1]])
  }
  try {
    return turfPolygon([coords])
  } catch {
    // 自相交 / 共线退化等几何错误：返回 null，调用方走 disjoint 兜底
    return null
  }
}

/**
 * bbox 与 annotation polygon 的 3 态分类。
 *
 * @param bbox       屏幕归一化坐标 [0,1] 的矩形
 * @param polygonFeature  缓存好的 annotation polygon turf feature（来自 polygonToTurfFeature）
 * @param tFull      重叠面积比 ≥ 此值视为 fully-inside（默认 0.95）
 * @returns          { state, ratio }；polygonFeature=null 时返回 disjoint
 */
export function classifyBboxPolygonOverlap (
  bbox: BBoxRect,
  polygonFeature: Feature<Polygon> | null,
  tFull = 0.95,
): OverlapResult {
  if (!polygonFeature) return { state: 'disjoint', ratio: 0 }

  // 1) axis-aligned bbox 快速排除（O(1)，避免调 turf）
  //    polygon 的 axis-aligned bbox 可从 feature.geometry.coordinates 算
  const polyBBox = computeAxisAlignedBBox(polygonFeature)
  if (
    bbox.x2 < polyBBox.x1 || bbox.x1 > polyBBox.x2
    || bbox.y2 < polyBBox.y1 || bbox.y1 > polyBBox.y2
  ) {
    return { state: 'disjoint', ratio: 0 }
  }

  // 2) 构造 bbox 的 turf polygon
  const bboxFeature = bboxToTurfPolygon(bbox)
  if (!bboxFeature) return { state: 'disjoint', ratio: 0 }

  // 3) turf boolean-disjoint 二次精确确认
  try {
    if (turfBooleanDisjoint(bboxFeature, polygonFeature)) {
      return { state: 'disjoint', ratio: 0 }
    }
  } catch {
    // turf 在退化几何上偶发抛错；继续走 intersect 兜底
  }

  // 4) 算 intersection 面积
  //    （turf 7 的 intersect 收 FeatureCollection；原生 turf 6 是双参数——语义等价）
  let intersectFeature: Feature<Polygon | MultiPolygon> | null = null
  try {
    // 凹多边形与矩形的交集可能是多个不连通区域，不能强制收窄为 Polygon。
    intersectFeature = turfIntersect(featureCollection([bboxFeature, polygonFeature]))
  } catch {
    // intersect 失败：保守按 partial（已知有重叠但算不出面积）
    return { state: 'partial', ratio: 0.5 }
  }
  if (!intersectFeature) return { state: 'disjoint', ratio: 0 }

  const bboxArea = bboxAxisAlignedArea(bbox)
  if (bboxArea <= 0) return { state: 'disjoint', ratio: 0 }
  const intersectArea = Math.max(0, polygonEuclideanArea(intersectFeature))
  const ratio = Math.min(1, intersectArea / bboxArea)

  if (ratio <= 0) return { state: 'disjoint', ratio: 0 }
  if (ratio >= tFull) return { state: 'fully-inside', ratio }
  return { state: 'partial', ratio }
}

function ringArea (coords: Position[]): number {
  let area = 0
  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i]!
    const p2 = coords[i + 1]!
    area += p1[0]! * p2[1]! - p2[0]! * p1[1]!
  }
  return Math.abs(area / 2)
}

function polygonEuclideanArea (feature: Feature<Polygon | MultiPolygon>): number {
  const polygons = feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates
  return polygons.reduce((sum, rings) => {
    const outer = ringArea(rings[0] ?? [])
    const holes = rings.slice(1).reduce((area, ring) => area + ringArea(ring), 0)
    return sum + Math.max(0, outer - holes)
  }, 0)
}

// ---- 内部 helpers ----

function bboxToTurfPolygon (bbox: BBoxRect): Feature<Polygon> | null {
  // 退化检查：宽或高为 0
  if (bbox.x2 <= bbox.x1 || bbox.y2 <= bbox.y1) return null
  try {
    return turfPolygon([[
      [bbox.x1, bbox.y1],
      [bbox.x2, bbox.y1],
      [bbox.x2, bbox.y2],
      [bbox.x1, bbox.y2],
      [bbox.x1, bbox.y1],
    ]])
  } catch {
    return null
  }
}

function bboxAxisAlignedArea (bbox: BBoxRect): number {
  return Math.max(0, bbox.x2 - bbox.x1) * Math.max(0, bbox.y2 - bbox.y1)
}

interface AABB {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function computeAxisAlignedBBox (feature: Feature<Polygon>): AABB {
  // 复用 feature.bbox 字段（如果调用方提前算好）；否则现场算
  if (feature.bbox && feature.bbox.length >= 4) {
    return { x1: feature.bbox[0]!, y1: feature.bbox[1]!, x2: feature.bbox[2]!, y2: feature.bbox[3]! }
  }
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const ring of feature.geometry.coordinates) {
    for (const point of ring) {
      const x = point[0] ?? Infinity
      const y = point[1] ?? Infinity
      if (x < x1) x1 = x
      if (y < y1) y1 = y
      if (x > x2) x2 = x
      if (y > y2) y2 = y
    }
  }
  // 缓存到 feature 上，下次直接复用（feature 在 region 级 polygonize 时一次性创建，长生命周期）
  feature.bbox = [x1, y1, x2, y2]
  return { x1, y1, x2, y2 }
}
