// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { type LaneChangeTriggerEvent, createDetectorCore } from '../../../src/hosts/cockpit/lane-change/detector-core'
import { SyntheticFrameSource } from '../sim/frame-source'
import { SCENARIOS } from './presets'

/**
 * 场景冒烟：所有可视化预设跑在默认生产参数上，锁定事件数与关键规则。
 * 期望值来自场景的业务几何；不能为了匹配 detector 输出而修改跨线预期。
 */

const NO_TRIGGER = new Set([
  'line-straight-left',
  'line-hug-truck',
  'line-occupy-slow-ride',
  'poly-avoid',
  'poly-edge-overlap',
  'real-id-fragment-ghosts',
])

const EXPECTED_TRIGGER_COUNTS: Record<string, number> = {
  'line-slow-cross': 1,
  'line-late-cross': 1,
  'line-half-press': 1,
  'line-occupy-stationary': 1,
  'line-horizontal-center-cross': 1,
  'line-intersection-dual-cross': 2,
  'line-multi-parallel': 3,
  'line-diagonal-concurrent-traffic': 6,
  'line-multi-same-time': 1,
  'poly-corner': 1,
  'poly-cross': 1,
  'poly-stay': 1,
  'poly-stutter': 1,
  'real-low-fps-line-cross': 1,
  'real-burst-gap-prune': 1,
  'real-dense-traffic-single-violation': 1,
  'mixed-realistic-main-road-exit': 2,
}

const DIAGONAL_EXPECTED_PAIRS = [
  ['truck_diagonal_a', 'DIAGONAL_SOLID_LINE_A'],
  ['car_diagonal_a', 'DIAGONAL_SOLID_LINE_A'],
  ['truck_diagonal_b', 'DIAGONAL_SOLID_LINE_B'],
  ['car_diagonal_b', 'DIAGONAL_SOLID_LINE_B'],
  ['truck_diagonal_c', 'DIAGONAL_SOLID_LINE_C'],
  ['car_diagonal_c', 'DIAGONAL_SOLID_LINE_C'],
] as const

const RIGHT_TO_LEFT_IDS = new Set(['car_diagonal_a', 'truck_diagonal_b', 'car_diagonal_c'])

function runScenario (
  scenario: typeof SCENARIOS[number],
  paramsOverride?: Parameters<typeof createDetectorCore>[0],
  noiseProfile = scenario.noiseProfile ?? null,
): LaneChangeTriggerEvent[] {
  const source = new SyntheticFrameSource(scenario.tracks, noiseProfile, scenario.frameTimes)
  const core = createDetectorCore(paramsOverride)
  const events: LaneChangeTriggerEvent[] = []
  const frameTimes = scenario.frameTimes ?? Array.from(
    { length: Math.floor(scenario.duration / 16) + 1 },
    (_, index) => index * 16,
  )
  frameTimes.forEach((t, sequence) => {
    events.push(...core.processFrame({
      now: t,
      sequence,
      continuous: true,
      regions: scenario.regions,
      bboxes: source.getBBoxesAtTime(t),
    }))
  })
  return events
}

describe('lane-change-sim 场景冒烟', () => {
  it.each(SCENARIOS.map(scenario => [scenario.id, scenario]))('%s：满足基础场景约束', (_id, scenario) => {
    expect(scenario.tracks.length).toBeGreaterThanOrEqual(5)
    expect(scenario.frameTimes?.length ?? 0).toBeGreaterThanOrEqual(3)
    const maxFrameGapMs = Math.max(
      ...scenario.frameTimes!.slice(1).map((time, index) => time - scenario.frameTimes![index]!),
    )
    expect(maxFrameGapMs).toBeGreaterThanOrEqual(280)
  })

  it.each(SCENARIOS.map(scenario => [scenario.id, scenario]))('%s：触发数符合当前算法契约', (_id, scenario) => {
    const events = runScenario(scenario)
    const backgroundEvents = events.filter(event => String(event.objId).includes('_traffic_'))
    expect(backgroundEvents).toEqual([])
    if (NO_TRIGGER.has(scenario.id)) {
      expect(events).toEqual([])
    } else {
      expect(events).toHaveLength(EXPECTED_TRIGGER_COUNTS[scenario.id] ?? -1)
    }
  })

  it('line-occupy-stationary 触发规则为 line-occupy 而非 line-enter', () => {
    const scenario = SCENARIOS.find(s => s.id === 'line-occupy-stationary')!
    const events = runScenario(scenario)
    expect(events.filter(event => event.objId === 'car_occupy_stationary').map(event => event.rule)).toEqual(['line-occupy'])
  })

  it('line-slow-cross 触发规则为 line-enter', () => {
    const scenario = SCENARIOS.find(s => s.id === 'line-slow-cross')!
    const events = runScenario(scenario)
    expect(events.filter(event => event.objId === 'car_slow_cross').map(event => event.rule)).toEqual(['line-enter'])
  })

  it('poly-corner 触发规则为 polygon-enter', () => {
    const scenario = SCENARIOS.find(s => s.id === 'poly-corner')!
    const events = runScenario(scenario)
    expect(events.filter(event => event.objId === 'car_guide_enter').map(event => event.rule)).toEqual(['polygon-enter'])
  })

  it('line-intersection-dual-cross 两条实线各确认一次且不交叉误判', () => {
    const scenario = SCENARIOS.find(s => s.id === 'line-intersection-dual-cross')!
    const events = runScenario(scenario)
    expect(events.filter(event => event.objId === 'car_intersection_vertical_cross' && event.regionId === 'INTERSECTION_VERTICAL_SOLID_LINE')).toHaveLength(1)
    expect(events.filter(event => event.objId === 'car_intersection_horizontal_cross' && event.regionId === 'INTERSECTION_HORIZONTAL_SOLID_LINE')).toHaveLength(1)
    expect(events.filter(event => event.objId === 'car_intersection_vertical_cross' && event.regionId === 'INTERSECTION_HORIZONTAL_SOLID_LINE')).toEqual([])
    expect(events.filter(event => event.objId === 'car_intersection_horizontal_cross' && event.regionId === 'INTERSECTION_VERTICAL_SOLID_LINE')).toEqual([])
  })

  it('line-diagonal-concurrent-traffic 单向车流左右并发命中各自斜实线', () => {
    const scenario = SCENARIOS.find(s => s.id === 'line-diagonal-concurrent-traffic')!
    const events = runScenario(scenario, undefined, null)
    expect(events.map(event => [event.objId, event.regionId]).sort()).toEqual([...DIAGONAL_EXPECTED_PAIRS].sort())
    expect(events.every(event => event.rule === 'line-enter')).toBe(true)
    const windows = scenario.tracks.map(track => track.laneChange!)
    expect(Math.max(...windows.map(window => window.startTime))).toBeLessThan(Math.min(...windows.map(window => window.endTime)))
  })

  it('斜拍几何：中央带边界双向跨线，全程可见且单向上行', () => {
    const scenario = SCENARIOS.find(s => s.id === 'line-diagonal-concurrent-traffic')!
    for (const [objId, regionId] of DIAGONAL_EXPECTED_PAIRS) {
      const track = scenario.tracks.find(item => item.objId === objId)!
      const line = scenario.regions.find(region => region.id === regionId)!
      const first = track.keyframes[0]!.rect
      const last = track.keyframes[track.keyframes.length - 1]!.rect
      const lineStart = line.points[0]!
      const lineEnd = line.points[line.points.length - 1]!
      const toLeft = RIGHT_TO_LEFT_IDS.has(objId)
      // 独立使用“同 x 处 y 与线 y 的差”，不复用生产 signed-distance/场景 offset 公式。
      const side = (rect: typeof first) => {
        const x = rect.x1 + (rect.x2 - rect.x1) * (toLeft ? 0.4 : 0.6)
        const lineY = lineStart.y + (lineEnd.y - lineStart.y) * (x - lineStart.x) / (lineEnd.x - lineStart.x)
        return rect.y2 - lineY
      }

      expect(track.keyframes.every((keyframe, index) => index === 0 || keyframe.rect.y1 < track.keyframes[index - 1]!.rect.y1)).toBe(true)
      expect(side(first) * (toLeft ? 1 : -1)).toBeGreaterThan(0.006)
      expect(side(last) * (toLeft ? -1 : 1)).toBeGreaterThan(0.006)
      for (const { rect, time } of track.keyframes) {
        expect(Math.min(rect.x1, rect.y1)).toBeGreaterThanOrEqual(0)
        expect(Math.max(rect.x2, rect.y2)).toBeLessThanOrEqual(1)
        if (time <= track.laneChange!.startTime) expect(side(rect)).toBeCloseTo(side(first))
        if (time >= track.laneChange!.endTime) expect(side(rect)).toBeCloseTo(side(last))
      }
    }
  })

  it('斜拍事件不得先于中央带边界跨线，贴线直行阶段不触发', () => {
    const scenario = SCENARIOS.find(s => s.id === 'line-diagonal-concurrent-traffic')!
    const source = new SyntheticFrameSource(scenario.tracks)
    for (const event of runScenario(scenario)) {
      const track = scenario.tracks.find(item => item.objId === event.objId)!
      const rect = source.getBBoxesAtTime(event.crossedAt).find(bbox => bbox.objId === event.objId)!.rect
      const line = scenario.regions.find(region => region.id === event.regionId)!
      const intercept = line.points[0]!.x + line.points[0]!.y
      const toLeft = RIGHT_TO_LEFT_IDS.has(String(event.objId))
      const x = rect.x1 + (rect.x2 - rect.x1) * (toLeft ? 0.4 : 0.6)
      const q = x + rect.y2 - intercept
      expect(q * (toLeft ? -1 : 1)).toBeGreaterThan(0)
      expect(event.crossedAt).toBeGreaterThan(track.laneChange!.startTime)
      expect(event.crossedAt).toBeLessThanOrEqual(track.laneChange!.endTime + 280)
    }
  })

  it('斜拍六车仅保留切向直行时零事件，不能用沿路行驶冒充变道', () => {
    const scenario = SCENARIOS.find(s => s.id === 'line-diagonal-concurrent-traffic')!
    const tracks = scenario.tracks.map((track) => {
      const first = track.keyframes[0]!
      const last = track.keyframes[track.keyframes.length - 1]!
      return { ...track, keyframes: track.keyframes.map(({ time }) => {
        const move = 0.23 * (time - first.time) / (last.time - first.time)
        return { time, rect: { x1: first.rect.x1 + move, x2: first.rect.x2 + move, y1: first.rect.y1 - move, y2: first.rect.y2 - move } }
      }) }
    })
    expect(runScenario({ ...scenario, tracks })).toEqual([])
  })

  it('斜拍并发车辆沿道路错位，不能互相穿模', () => {
    const scenario = SCENARIOS.find(s => s.id === 'line-diagonal-concurrent-traffic')!
    const source = new SyntheticFrameSource(scenario.tracks)
    for (let t = 0; t <= scenario.duration; t += 50) {
      const boxes = source.getBBoxesAtTime(t)
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!.rect
          const b = boxes[j]!.rect
          const width = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
          const height = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1))
          expect(width * height, `${t}ms: ${boxes[i]!.objId}/${boxes[j]!.objId}`).toBe(0)
        }
      }
    }
  })

  it.each(Array.from({ length: 20 }, (_, index) => index + 1))(
    'line-diagonal-concurrent-traffic seed=%s：位置与尺寸抖动下不漏检',
    (seed) => {
      const scenario = SCENARIOS.find(s => s.id === 'line-diagonal-concurrent-traffic')!
      const events = runScenario(scenario, undefined, {
        seed,
        positionSigma: 0.003,
        sizeSigma: 0.004,
      })
      expect(events.map(event => [event.objId, event.regionId]).sort()).toEqual([...DIAGONAL_EXPECTED_PAIRS].sort())
    },
  )

  it('real-low-fps-line-cross 使用长间隔仍能完成穿线判定', () => {
    const scenario = SCENARIOS.find(s => s.id === 'real-low-fps-line-cross')!
    const events = runScenario(scenario)
    expect(events.filter(event => event.objId === 'car_real_lowfps_cross')).toHaveLength(1)
  })

  it('lINE_OCCUPY_MS 覆盖后静止压线不再触发（参数链路验证）', () => {
    const scenario = SCENARIOS.find(s => s.id === 'line-occupy-stationary')!
    expect(runScenario(scenario, { paramsOverride: { LINE_OCCUPY_MS: 100_000 } })).toEqual([])
  })

  it('mIN_TRACKER_AGE_FRAMES 覆盖为 1 后穿线仍触发且不重复（参数链路验证）', () => {
    const scenario = SCENARIOS.find(s => s.id === 'line-slow-cross')!
    expect(runScenario(scenario, { paramsOverride: { MIN_TRACKER_AGE_FRAMES: 1 } })).toHaveLength(1)
  })
})
