// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { TRACKABLE_TARGET_STATES } from '../../../src/hosts/cockpit/lane-change/target-filter'
import { type LaneChangeSeiReplayFrame, parseLaneChangeReplayNdjson, replayFrameBBoxes } from './replay-source'

const NDJSON = [
  '{"kind":"lane-change-sei-replay-meta","formatVersion":1,"exportedAt":"2026-05-22T02:45:45.598Z","source":"cockpit-debug-panel-b-mode-sei","durationMs":3000,"context":{"height":120,"altitudeOfTakeoffPoint":100,"zoomFactor":7}}',
  '{"kind":"frame","now":1779417915597,"elapsedMs":0,"seq":0,"rawTargets":[{"id":419,"type":3,"state":1,"box":{"cx":4693,"cy":2230,"w":81,"h":264}},{"id":435,"type":3,"state":6,"box":{"cx":5151,"cy":2312,"w":50,"h":76}},{"id":999,"type":2,"state":1,"box":{"cx":4000,"cy":4000,"w":80,"h":80}}]}',
  '{"kind":"frame","now":1779417916036,"elapsedMs":439,"seq":1,"rawTargets":[{"id":419,"type":3,"state":7,"box":{"cx":4691,"cy":2282,"w":78,"h":223}}]}',
  'not-a-json-line',
  '{"kind":"frame","now":1779417916200,"elapsedMs":600,"seq":2}',
  '{"kind":"frame","now":1779417916200,"elapsedMs":600,"seq":3,"coreBBoxes":[{"objId":"kept","rect":{"x1":0.1,"y1":0.1,"x2":0.2,"y2":0.2}}]}',
].join('\n')

describe('parseLaneChangeReplayNdjson', () => {
  it('解析 meta 与帧、忽略坏行并排序', () => {
    const replay = parseLaneChangeReplayNdjson(NDJSON)
    expect(replay.parseErrors).toEqual(['line 4: Unexpected token \'o\', "not-a-json-line" is not valid JSON'])
    expect(replay.meta?.durationMs).toBe(3000)
    expect(replay.frames.map(frame => frame.seq)).toEqual([0, 1, 2, 3])
    expect(replay.duration).toBe(3000)
  })

  it('空文本返回零帧且不抛错', () => {
    const replay = parseLaneChangeReplayNdjson('')
    expect(replay.frames).toEqual([])
    expect(replay.meta).toBeNull()
    expect(replay.duration).toBe(0)
  })
})

describe('replayFrameBBoxes（旧数字协议 → 插件字符串协议）', () => {
  it('type 3 且可跟踪状态参与判定，lost 与非车辆类型被过滤', () => {
    const replay = parseLaneChangeReplayNdjson(NDJSON)
    const first = replay.frames[0]! as LaneChangeSeiReplayFrame
    const bboxes = replayFrameBBoxes(first)
    // id 419（tracked）保留；id 435（lost=6）过滤；id 999（type 2 行人）过滤。
    expect(bboxes.map(bbox => bbox.objId)).toEqual([419])
    expect(bboxes[0]!.rect.x1).toBeCloseTo(0.4693 - 81 / 20000, 8)
    expect(bboxes[0]!.rect.y1).toBeCloseTo(0.223 - 264 / 20000, 8)
  })

  it('redetected(7) 也在白名单内', () => {
    const replay = parseLaneChangeReplayNdjson(NDJSON)
    const second = replay.frames[1]! as LaneChangeSeiReplayFrame
    expect(replayFrameBBoxes(second).map(bbox => bbox.objId)).toEqual([419])
  })

  it('coreBBoxes 存在时优先使用', () => {
    const replay = parseLaneChangeReplayNdjson(NDJSON)
    const fourth = replay.frames[3]! as LaneChangeSeiReplayFrame
    expect(replayFrameBBoxes(fourth).map(bbox => bbox.objId)).toEqual(['kept'])
  })

  it('未知旧状态映射为不可跟踪状态并被过滤', () => {
    const frame: LaneChangeSeiReplayFrame = {
      now: 1,
      seq: 0,
      rawTargets: [{ id: 1, type: 3, state: 12, box: { cx: 5000, cy: 5000, w: 100, h: 100 } }],
    }
    expect(replayFrameBBoxes(frame)).toEqual([])
  })

  it('字符串状态目标直接按白名单过滤', () => {
    const frame: LaneChangeSeiReplayFrame = {
      now: 1,
      seq: 0,
      rawTargets: [
        { id: 1, type: '3', state: 'tracked', box: { cx: 5000, cy: 5000, w: 100, h: 100 } },
        { id: 2, type: '3', state: 'lost', box: { cx: 5000, cy: 5000, w: 100, h: 100 } },
      ],
    }
    expect(replayFrameBBoxes(frame).map(bbox => bbox.objId)).toEqual([1])
    expect(TRACKABLE_TARGET_STATES.has('tracked')).toBe(true)
  })
})
