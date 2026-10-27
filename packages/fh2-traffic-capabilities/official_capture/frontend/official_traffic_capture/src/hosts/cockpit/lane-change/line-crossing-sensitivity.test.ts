// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseLaneChangeReplayNdjson, replayFrameBBoxes } from '../../../../test-pages/lane-change-sim/sim/replay-source'
import { type CoreRegion, createDetectorCore } from './detector-core'

const vertical: CoreRegion = {
  id: 'line',
  kind: 'line',
  valid: true,
  points: [{ x: 0.5, y: 0.1 }, { x: 0.5, y: 0.9 }],
}
const widths = [0.008, 0.013, 0.04, 0.16, 0.30]

function runTrajectory (times: number[], cxAt: (time: number) => number, width: number) {
  const core = createDetectorCore()
  return times.flatMap((now, sequence) => {
    const cx = cxAt(now)
    const bottom = 0.3 + now * 0.00003
    return core.processFrame({
      now,
      sequence,
      continuous: true,
      regions: [vertical],
      bboxes: [{ objId: 1, rect: { x1: cx - width / 2, x2: cx + width / 2, y1: bottom - 0.12, y2: bottom } }],
    })
  })
}

describe('中央带即时触发与跨前运动累计', () => {
  it.each(widths)('框宽 %s：双向浅穿、末帧穿线及浅穿回退不等待额外深入', (width) => {
    for (const direction of [-1, 1]) {
      const crossingCx = 0.5 - direction * width * 0.1
      const times = [0, 100, 200, 300]
      const cxAt = (t: number) => crossingCx + direction * (t < 300 || t >= 400 ? -0.002 : 0.0001)
      const expected = [{ objId: 1, regionId: 'line', rule: 'line-enter', crossedAt: 300 }]
      expect(runTrajectory(times, cxAt, width)).toEqual(expected)
      expect(runTrajectory([...times, 400, 500], cxAt, width)).toEqual(expected)
    }
  })

  it.each([4, 33, 100, 280])('同一慢速轨迹按 %s ms 采样，大小框双向均在首次到达中央带时触发', (interval) => {
    const times = Array.from({ length: Math.floor(4000 / interval) + 1 }, (_, i) => i * interval)
    for (const width of widths) {
      for (const direction of [-1, 1]) {
        const cxAt = (t: number) => 0.5 - direction * (width * 0.1 + 0.001) + direction * t * 0.0000005
        // 连续轨迹在 2000ms 到达中央带，期望只取决于实际采样时间。
        expect(runTrajectory(times, cxAt, width), JSON.stringify({ interval, width, direction })).toEqual([
          { objId: 1, regionId: 'line', rule: 'line-enter', crossedAt: times.find(t => t >= 2000)! },
        ])
      }
    }
  })

  it('不均匀采样与不同抽帧起点保留跨线，当前帧无需仍压在线上', () => {
    const times = [0, 100, 200, 500, 850, 1200, 1400, 1800, 1900, 2000, 2100, 2300, 2400, 2600, 2800]
    for (const stride of [1, 2, 3]) {
      for (let phase = 0; phase < stride; phase++) {
        const samples = times.filter((_, i) => i % stride === phase)
        const cxAt = (t: number) => 0.5 - 0.03 + (t - 1950) * 0.0001
        expect(runTrajectory(samples, cxAt, 0.30)).toEqual([
          { objId: 1, regionId: 'line', rule: 'line-enter', crossedAt: samples.find(t => t >= 1950)! },
        ])
      }
    }
    expect(runTrajectory([0, 100, 200, 1200], t => t < 1200 ? 0.3 : 0.7, 0.30)).toEqual([
      { objId: 1, regionId: 'line', rule: 'line-enter', crossedAt: 1200 },
    ])
  })

  it('同侧退开后尺寸变化扫过中央带，不得借用旧主动位移补报', () => {
    const core = createDetectorCore()
    const frames = [
      [0.468, 0.30],
      [0.468, 0.30],
      [0.4697, 0.30],
      [0.468, 0.30],
      [0.468, 0.34],
      [0.468, 0.34],
      [0.468, 0.34],
    ]
    expect(frames.flatMap(([cx, width], sequence) => core.processFrame({
      now: sequence * 100,
      sequence,
      continuous: true,
      regions: [vertical],
      bboxes: [{ objId: 1, rect: { x1: cx! - width! / 2, x2: cx! + width! / 2, y1: 0.2 + sequence * 0.03, y2: 0.32 + sequence * 0.03 } }],
    }))).toEqual([])
  })
})

describe('20m 接近两倍变焦原始录制', () => {
  const replay = parseLaneChangeReplayNdjson(readFileSync(new URL(
    '../../../../test-pages/lane-change-sim/public/20m俯拍-接近2倍变焦.ndjson',
    import.meta.url,
  ), 'utf8'))
  const region: CoreRegion = {
    id: 'user-line',
    kind: 'line',
    valid: true,
    points: [
      { x: 0.5103810743395379, y: 0.5044658806716684 },
      { x: 0.5569912181148382, y: 0.2015005359056806 },
      { x: 0.5569912181148382, y: 0.2015005359056806 },
    ],
  }

  it.each([0, 0.006, 0.02])('静态距离容差 %s 不改变 ID 168/423 的动态触发时刻', (tolerance) => {
    const core = createDetectorCore({ paramsOverride: { LINE_OCCUPY_DISTANCE_TOLERANCE: tolerance } })
    const events = replay.frames.flatMap(frame => core.processFrame({
      now: frame.elapsedMs!,
      sequence: frame.seq,
      continuous: true,
      regions: [region],
      bboxes: replayFrameBBoxes(frame),
    }))
    expect(events.filter(event => event.objId === 168 || event.objId === 423)).toEqual([
      { objId: 168, regionId: 'user-line', rule: 'line-enter', crossedAt: 5835 },
      { objId: 423, regionId: 'user-line', rule: 'line-enter', crossedAt: 26773 },
    ])
    expect(replay.frames.filter(frame => frame.elapsedMs! > 26773).some(frame =>
      frame.rawTargets?.some(target => target.id === 423))).toBe(false)
  })

  it('录制 ID 168 中央带附近连续缺失五帧，仍连接 1377ms 首尾有效轨迹', () => {
    const core = createDetectorCore()
    const events = replay.frames.flatMap((frame) => {
      const missing = frame.elapsedMs! >= 5540 && frame.elapsedMs! <= 6241
      return core.processFrame({
        now: frame.elapsedMs!,
        sequence: frame.seq,
        continuous: true,
        regions: [region],
        bboxes: replayFrameBBoxes(frame).filter(bbox => !missing || bbox.objId !== 168),
      })
    })
    expect(events.filter(event => event.objId === 168)).toEqual([
      { objId: 168, regionId: 'user-line', rule: 'line-enter', crossedAt: 6651 },
    ])
  })
})
