// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { polygon as turfPolygon } from '@turf/helpers'
import { classifyBboxPolygonOverlap, polygonToTurfFeature } from './bbox-polygon-overlap'
import { createDetectorCore } from './detector-core'

const concave = [
  { x: 0.1, y: 0.1 },
  { x: 0.3, y: 0.1 },
  { x: 0.3, y: 0.7 },
  { x: 0.7, y: 0.7 },
  { x: 0.7, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.9 },
  { x: 0.1, y: 0.9 },
]

describe('导流区面积几何', () => {
  it('凹区与矩形相交产生两个分离区域，正确累计 MultiPolygon 面积', () => {
    const polygon = polygonToTurfFeature(concave)
    const result = classifyBboxPolygonOverlap({ x1: 0.2, y1: 0.2, x2: 0.8, y2: 0.4 }, polygon, 0.5)
    expect(result.state).toBe('partial')
    expect(result.ratio).toBeCloseTo(1 / 3, 10)
  })

  it('交集含内环时从外环面积扣除，不把孔洞算成导流区', () => {
    const polygon = turfPolygon([
      [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
      [[0.1, 0.1], [0.1, 0.9], [0.9, 0.9], [0.9, 0.1], [0.1, 0.1]],
    ])
    const result = classifyBboxPolygonOverlap({ x1: 0, y1: 0, x2: 1, y2: 1 }, polygon, 0.5)
    expect(result.state).toBe('partial')
    expect(result.ratio).toBeCloseTo(0.36, 10)
  })

  it.each([false, true])('凹区分离交集达到 50%%、中心仍在区域外，反转=%s，触发面积规则', (reversed) => {
    const points = reversed ? [...concave].reverse() : concave
    const rect = { x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.4 }
    const overlap = classifyBboxPolygonOverlap(rect, polygonToTurfFeature(points), 0.5)
    expect(overlap.ratio).toBeCloseTo(0.5, 10)
    expect(overlap.state).toBe('fully-inside')
    const core = createDetectorCore()
    const events = Array.from({ length: 5 }, (_, sequence) => core.processFrame({
      now: sequence * 100,
      sequence,
      continuous: true,
      regions: [{ id: 'area', kind: 'polygon', valid: true, points }],
      bboxes: [{ objId: 1, rect }],
    })).flat()
    expect(events.map(event => event.rule)).toEqual(['polygon-fully-inside'])
  })

  it('只接触边界、凹区缺口内及完全包含的面积分类', () => {
    const polygon = polygonToTurfFeature(concave)
    expect(classifyBboxPolygonOverlap({ x1: 0, y1: 0.2, x2: 0.1, y2: 0.4 }, polygon, 0.5).state).toBe('disjoint')
    expect(classifyBboxPolygonOverlap({ x1: 0.4, y1: 0.2, x2: 0.6, y2: 0.4 }, polygon, 0.5).state).toBe('disjoint')
    expect(classifyBboxPolygonOverlap({ x1: 0.15, y1: 0.2, x2: 0.25, y2: 0.4 }, polygon, 0.5).ratio).toBeCloseTo(1)
  })
})
