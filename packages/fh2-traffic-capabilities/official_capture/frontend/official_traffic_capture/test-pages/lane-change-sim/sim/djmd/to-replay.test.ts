// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { type LaneChangeTriggerEvent, createDetectorCore } from '../../../../src/hosts/cockpit/lane-change/detector-core'
import { ReplayFrameSource, createReplayScenario, mapLegacyStateName, parseLaneChangeReplayNdjson, replayFrameBBoxes } from '../replay-source'
import type { DjmdDetection } from './parser'
import { buildDjmdReplayNdjson } from './to-replay'

describe('djmd → detector 闭环', () => {
  it('真机数据格式（万分比 + 数字 state）转 NDJSON 后穿线触发一次 line-enter', () => {
    // 30fps 视频每 3 个视频包出现一次 AI 检测（10fps）；车从 x≈0.44 穿越竖直实线 x=0.5。
    const cxs = [4400, 4450, 4480, 4500, 4520, 4540, 4560, 5200, 5600, 6000]
    const detections: DjmdDetection[] = cxs.map(cx => ({
      objId: 19,
      objType: 0,
      objState: 1,
      cx,
      cy: 5000,
      w: 600,
      h: 800,
      distanceMm: 20000,
    }))

    const ndjson = buildDjmdReplayNdjson(
      {
        frames: detections.map((det, index) => ({
          frameIndex: index * 3,
          aiTimestampMs: index * 100,
          detections: [det],
        })),
        framesWithDetections: detections.length,
        totalDetections: detections.length,
        uniqueObjIds: 1,
      },
      { width: 3840, height: 2160, fps: 30, durationMs: detections.length * 100 },
    )

    const replay = parseLaneChangeReplayNdjson(ndjson)
    expect(replay.parseErrors).toEqual([])
    // djmd objType 0 映射为 cockpit 车辆 type 3；视频元信息进 meta
    expect(replay.frames[1]!.rawTargets?.[0]!.type).toBe(3)
    expect(replay.meta?.video?.width).toBe(3840)
    expect((replay.meta as { djmd?: { rawTypeCounts?: Record<string, number> } }).djmd?.rawTypeCounts)
      .toEqual({ 0: detections.length })
    // 帧时间按 frameIndex / fps 对齐
    expect(replay.frames[1]!.elapsedMs).toBe(100)

    const source = new ReplayFrameSource(replay)
    const core = createDetectorCore()
    const region = {
      id: 'SOLID_LINE',
      kind: 'line' as const,
      valid: true as const,
      points: [{ x: 0.5, y: 0.15 }, { x: 0.5, y: 0.85 }],
    }

    const events: LaneChangeTriggerEvent[] = []
    source.getFrameTimes()!.forEach((t, sequence) => {
      events.push(...core.processFrame({
        now: t,
        sequence,
        continuous: true,
        regions: [region],
        bboxes: source.getBBoxesAtTime(t),
      }))
    })

    expect(events).toHaveLength(1)
    expect(events[0]!).toMatchObject({ objId: 19, regionId: 'SOLID_LINE', rule: 'line-enter' })
  })

  it('未知 objType 不映射，被生产过滤且可经 getRawTargetsAtTime 诊断', () => {
    const ndjson = buildDjmdReplayNdjson(
      {
        frames: [{
          frameIndex: 0,
          aiTimestampMs: 0,
          detections: [
            { objId: 19, objType: 0, objState: 1, cx: 4400, cy: 5000, w: 600, h: 800, distanceMm: 1 },
            { objId: 31, objType: 5, objState: 1, cx: 1000, cy: 2000, w: 300, h: 400, distanceMm: 2 },
          ],
        }],
        framesWithDetections: 1,
        totalDetections: 2,
        uniqueObjIds: 2,
      },
      { width: 3840, height: 2160, fps: 10, durationMs: 1000 },
    )

    const source = new ReplayFrameSource(parseLaneChangeReplayNdjson(ndjson))
    expect(source.getBBoxesAtTime(0).map(bbox => bbox.objId)).toEqual([19])
    expect(source.getRawTargetsAtTime(0).map(target => target.targetId)).toEqual([19, 31])
  })

  it('有效 AI 空结果同时清空 detector 与 display bbox', () => {
    // 30fps 视频、检测只在偶数视频帧出现（模拟 djmd 检测帧率 < 视频帧率）。
    const frames = Array.from({ length: 6 }, (_, index) => ({
      frameIndex: index,
      aiTimestampMs: index * 33,
      detections: index % 2 === 0
        ? [{ objId: 19, objType: 0, objState: 1, cx: 4400, cy: 5000, w: 600, h: 800, distanceMm: 1 }]
        : [],
    }))
    const ndjson = buildDjmdReplayNdjson(
      {
        frames,
        framesWithDetections: 3,
        totalDetections: 3,
        uniqueObjIds: 1,
      },
      { width: 3840, height: 2160, fps: 30, durationMs: 200 },
    )
    const source = new ReplayFrameSource(parseLaneChangeReplayNdjson(ndjson))

    // 空 AI 检测结果必须同时进入 detector 并清空画面，不能 hold 更早的非空结果掩盖数据。
    expect(source.getBBoxesAtTime(49.5)).toEqual([])
    expect(source.getDisplayBBoxesAtTime(49.5)).toEqual([])
    expect(source.getDisplayRawTargetsAtTime(49.5)).toEqual([])
    // 下一个非空帧到达后整体替换
    expect(source.getDisplayBBoxesAtTime(67).map(bbox => bbox.objId)).toEqual([19])
  })

  it('非 AI 视频包不进入回放序列，AI 检测帧保留原视频时间并使用连续检测序号', () => {
    const ndjson = buildDjmdReplayNdjson(
      {
        frames: [
          { frameIndex: 0, aiTimestampMs: 0, detections: [], hasDetectionPayload: false },
          { frameIndex: 1, aiTimestampMs: 33, detections: [{ objId: 19, objType: 'car', objState: 1, cx: 4400, cy: 5000, w: 600, h: 800, distanceMm: 1 }], hasDetectionPayload: true },
          { frameIndex: 2, aiTimestampMs: 66, detections: [], hasDetectionPayload: false },
          { frameIndex: 4, aiTimestampMs: 132, detections: [], hasDetectionPayload: true },
        ],
        framesWithDetections: 1,
        totalDetections: 1,
        uniqueObjIds: 1,
      },
      { width: 3840, height: 2160, fps: 30, durationMs: 200 },
    )
    const replay = parseLaneChangeReplayNdjson(ndjson)
    expect(replay.frames.map(frame => [frame.seq, frame.elapsedMs, frame.sourceFrameIndex]))
      .toEqual([[0, 1000 / 30, 1], [1, 4000 / 30, 4]])
    expect(replay.frames[0]!.rawTargets?.[0]!.type).toBe(3)
    expect((replay.meta as { djmd?: { packets?: number; detectorFrames?: number } }).djmd)
      .toMatchObject({ packets: 4, detectorFrames: 2 })
    const source = new ReplayFrameSource(replay)
    expect(source.getBBoxesAtTime(0)).toEqual([])
    expect(source.getDisplayBBoxesAtTime(0)).toEqual([])
  })

  it('摘要 stateCounts 走数字→字符串映射：数字 tracked 不误报，全 lost 仍告警', async () => {
    const { analyzeLaneChangeReplay } = await import('../replay-analysis')
    const buildNdjson = (state: number) => buildDjmdReplayNdjson(
      {
        frames: [{ frameIndex: 0, aiTimestampMs: 0, detections: [{ objId: 19, objType: 0, objState: state, cx: 4400, cy: 5000, w: 600, h: 800, distanceMm: 1 }] }],
        framesWithDetections: 1,
        totalDetections: 1,
        uniqueObjIds: 1,
      },
      { width: 3840, height: 2160, fps: 30, durationMs: 100 },
    )

    // 数字 state 1 = tracked，在白名单内：不应产生误报 note
    const trackedSummary = analyzeLaneChangeReplay(parseLaneChangeReplayNdjson(buildNdjson(1)))
    expect(trackedSummary.stateCounts).toEqual({ tracked: 1 })
    expect(trackedSummary.notes).not.toContain('录制中没有任何落在可跟踪白名单内的目标状态。')

    // 数字 state 6 = lost，全部不可跟踪：仍应告警
    const lostSummary = analyzeLaneChangeReplay(parseLaneChangeReplayNdjson(buildNdjson(6)))
    expect(lostSummary.stateCounts).toEqual({ lost: 1 })
    expect(lostSummary.notes).toContain('录制中没有任何落在可跟踪白名单内的目标状态。')
  })

  it('数字状态 2/3 与真实宿主映射一致并通过生产过滤', () => {
    expect(mapLegacyStateName(2)).toBe('vision-beacon-fused')
    expect(mapLegacyStateName(3)).toBe('auxiliary-tracked')
    expect(replayFrameBBoxes({
      now: 0,
      seq: 0,
      rawTargets: [2, 3].map(state => ({ id: state, type: 3, state, box: { cx: 5000, cy: 5000, w: 500, h: 500 } })),
    }).map(bbox => bbox.objId)).toEqual([2, 3])
  })

  it('createReplayScenario 携带 videoUrl 时挂上视频源（上传后可播放的回归）', () => {
    const ndjson = buildDjmdReplayNdjson(
      {
        frames: [{ frameIndex: 0, aiTimestampMs: 0, detections: [] }],
        framesWithDetections: 0,
        totalDetections: 0,
        uniqueObjIds: 0,
      },
      { width: 3840, height: 2160, fps: 30, durationMs: 1000 },
    )
    const replay = parseLaneChangeReplayNdjson(ndjson)

    const withVideo = createReplayScenario('a.mp4', replay, { videoUrl: 'blob:mock' })
    expect(withVideo.video).toMatchObject({ url: 'blob:mock', width: 3840, height: 2160, fps: 30 })

    const withoutUrl = createReplayScenario('a.mp4', replay)
    expect(withoutUrl.video).toBeUndefined()
  })
})
