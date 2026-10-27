// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EVIDENCE_FRAME_ROLES,
  clampedBox,
  evidenceOverlays,
  formatFrameClock,
  pickEvidenceFrames,
  usableSample,
  usableSampleCount,
  type TrackSample,
} from '../shared/lane-change-evidence'
import { handle } from '../adapters/lane-change-postprocess'
import type { AdapterCtx } from 'fh2-plugin-sdk/backend'

const lineSnapshot = {
  kind: 'line' as const,
  normalized_points: [{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }],
}
const polygonSnapshot = {
  kind: 'polygon' as const,
  normalized_points: [{ x: 0.4, y: 0.4 }, { x: 0.8, y: 0.4 }, { x: 0.8, y: 0.8 }],
}

function sample (offsetMs: number, x: number, overrides: Partial<TrackSample> = {}): TrackSample {
  return { offsetMs, x, y: 0.4, w: 0.1, h: 0.1, ...overrides }
}

function ok<T> (data: T): { readonly ok: true, readonly data: T } {
  return { ok: true, data }
}

function event (overrides: Record<string, string> = {}): Record<string, string> {
  return {
    id: 'event-1',
    project_id: 'project-1',
    dock_sn: 'dock-1',
    flight_id: 'flight-1',
    obj_id: 'car-7',
    collision_type: 'solid_line',
    crossed_at_ms: '1704067205000',
    snapshot_json: JSON.stringify(lineSnapshot),
    video_start_ms: '1704067200000',
    post_status: 'waiting_artifacts',
    folder_id: '',
    ...overrides,
  }
}

interface HostOptions {
  readonly record?: Record<string, string>
  readonly samples?: readonly TrackSample[]
  readonly skippedFrame?: boolean
  readonly probeError?: Error
  readonly trackError?: Error
  readonly extractFramesError?: Error
  readonly inspectError?: Error
  readonly settleUpdateError?: Error
}

/** 打桩沙箱全局(store/video/objectTrack/media/log)。update 第 2 次调用可注入收敛失败。 */
function stubHost (options: HostOptions = {}) {
  const recordValue = options.record ?? event()
  const samples = options.samples ?? [
    sample(3000, 0.3), sample(3500, 0.35), sample(4967, 0.4),
    sample(5000, 0.55), sample(5033, 0.57), sample(6500, 0.65), sample(7000, 0.7),
  ]
  let updateCount = 0
  const update = vi.fn((_entity: unknown, _filter: unknown, _patch: unknown) => {
    updateCount++
    if (updateCount === 2 && options.settleUpdateError !== undefined) throw options.settleUpdateError
    return ok({ affected: 1 })
  })
  const insert = vi.fn((_entity: unknown, _record: unknown, _uniqueBy?: readonly string[]) => ok({ created: true, record: {} }))
  const extractFrames = vi.fn((
    _ref: unknown,
    atMs: readonly number[],
    _owner: unknown,
    _names?: readonly string[],
    _overlays?: readonly unknown[],
  ) => {
    if (options.extractFramesError !== undefined) throw options.extractFramesError
    return atMs.map((value, index) => ({
      atMs: value,
      fileId: options.skippedFrame === true && index === 1 ? '' : 'frame-' + index,
      skipReason: options.skippedFrame === true && index === 1 ? 'out of range' : '',
      skipped: options.skippedFrame === true && index === 1,
    }))
  })
  const createClip = vi.fn((
    _ref: unknown,
    _startMs: number,
    _endMs: number,
    _owner?: unknown,
    _name?: string,
  ) => ({
    actualStartMs: 0,
    actualEndMs: 20000,
    durationMs: 20000,
    fileId: 'clip-1',
    skipReason: '',
    skipped: false,
  }))
  const probe = vi.fn(() => {
    if (options.probeError !== undefined) throw options.probeError
    return { durationMs: 10000, fps: 30, height: 1080, keyframeIntervalMs: 2000, width: 1920 }
  })
  const getTrack = vi.fn(() => {
    if (options.trackError !== undefined) throw options.trackError
    return { durationMs: 10000, samples }
  })
  vi.stubGlobal('store', {
    query: vi.fn(() => ok({ list: [recordValue], total: 1, limit: 1, offset: 0 })),
    update,
    createIfAbsent: insert,
  })
  vi.stubGlobal('video', { probe, extractFrames, createClip })
  const inspect = vi.fn(() => {
    if (options.inspectError !== undefined) throw options.inspectError
    return {
      durationMs: 10000, firstFrameNo: 0, lastFrameNo: 300, fps: 30, startWallClockMs: 1704067200000,
    }
  })
  vi.stubGlobal('objectTrack', {
    inspect,
    getTrack,
  })
  vi.stubGlobal('media', {
    get: vi.fn(() => ({ id: 'frame-0', parentId: 'parent-1' })),
    ensureFolder: vi.fn(() => ({ folderId: 'folder-1', skipped: false })),
    move: vi.fn(() => ({ moved: true, skipped: false })),
  })
  const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  vi.stubGlobal('log', logMock)
  return { createClip, extractFrames, getTrack, inspect, insert, log: logMock, probe, update }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('证据帧选择(lane-change-evidence)', () => {
  it('usableSample:与画幅有交集就算可用,完全出画或零宽高不可用', () => {
    // 目标正在出画:框大半在画外但仍有交集 → 可用(测试环境教训:中心口径会误杀这种帧)
    expect(usableSample(sample(0, 0.98))).toBe(true)
    expect(usableSample(sample(0, -0.05))).toBe(true) // 左缘探入
    expect(usableSample(sample(0, 1.2))).toBe(false) // 完全出画
    expect(usableSample(sample(0, 0.3, { w: 0 }))).toBe(false)
    expect(usableSample(sample(0, 0.3, { x: Number.NaN }))).toBe(false)
  })

  it('clampedBox:越界 bbox 裁到画幅内,画内部分保留', () => {
    const right = clampedBox(sample(0, 0.95))
    expect(right.x).toBe(0.95)
    expect(Math.abs(right.width - 0.05)).toBeLessThan(1e-9) // 浮点裁剪有尾差,近似比较
    const left = clampedBox(sample(0, -0.05))
    expect(left.x).toBe(0)
    expect(Math.abs(left.width - 0.05)).toBeLessThan(1e-9)
    const inside = clampedBox(sample(0, 0.3))
    expect(inside.x).toBe(0.3)
    expect(Math.abs(inside.width - 0.1)).toBeLessThan(1e-9)
  })

  it('密集轨迹优先选中图前后各 1.5 秒的样本,不再取相邻帧', () => {
    const samples = [
      sample(3400, 0.1), sample(3500, 0.2), sample(4967, 0.4),
      sample(5000, 0.55), sample(5033, 0.57), sample(6500, 0.65), sample(6600, 0.7),
    ]
    expect(pickEvidenceFrames(5000, samples)).toEqual({
      before: samples[1], violation: samples[3], after: samples[5],
    })
  })

  it('中图偏离违法时刻时以实际中图为锚点,前后取最接近目标时刻的样本', () => {
    const samples = [
      sample(3500, 0.1), sample(3633, 0.2), sample(5000, 0.55, { w: 0 }),
      sample(5100, 0.57), sample(6500, 0.65), sample(6633, 0.7),
    ]
    expect(pickEvidenceFrames(5000, samples)).toEqual({
      before: samples[1], violation: samples[3], after: samples[5],
    })
  })

  it('目标时刻的检测框无效时选择附近有效帧,不使用裸图或错时刻的框', () => {
    const samples = [
      sample(3467, 0.1), sample(3500, 1.2), sample(4967, 0.4),
      sample(5000, 0.55), sample(5033, 0.57), sample(6500, 0.65, { w: 0 }), sample(6533, 0.7),
    ]
    expect(pickEvidenceFrames(5000, samples)).toEqual({
      before: samples[0], violation: samples[3], after: samples[6],
    })
  })

  it('目标时刻两侧同距候选优先靠近中图,乱序输入不改变选择', () => {
    const samples = [sample(3400, 0.1), sample(3600, 0.2), sample(5000, 0.55), sample(6400, 0.65), sample(6600, 0.7)]
    const expected = { before: samples[1], violation: samples[2], after: samples[3] }
    expect(pickEvidenceFrames(5000, samples)).toEqual(expected)
    expect(pickEvidenceFrames(5000, [...samples].reverse())).toEqual(expected)
  })

  it('违法时刻靠近视频开头时选择已有前帧,不生成负时间或重复中图', () => {
    const samples = [sample(0, 0.1), sample(300, 0.55), sample(1800, 0.65)]
    expect(pickEvidenceFrames(300, samples)).toEqual({
      before: samples[0], violation: samples[1], after: samples[2],
    })
  })

  it('短轨迹覆盖不了前后各 1.5 秒时取各侧最接近目标时刻的可用帧', () => {
    const samples = [
      sample(12900, 0.17), sample(13000, 0.21), sample(13100, 0.24),
      sample(13266, 0.3), sample(13333, 0.32), sample(13433, 0.35),
      sample(13533, 0.37), sample(14300, 0.52),
    ]
    expect(pickEvidenceFrames(13331, samples)).toEqual({
      before: sample(12900, 0.17), violation: sample(13333, 0.32), after: sample(14300, 0.52),
    })
  })

  it('容忍 sidecar 乱序与同帧重复上报(取 bbox 面积最大),不再整组拒绝', () => {
    // 乱序:sidecar 不保证输出有序
    expect(pickEvidenceFrames(5000, [sample(7000, 0.3), sample(3000, 0.1), sample(5000, 0.55)])).toEqual({
      before: sample(3000, 0.1), violation: sample(5000, 0.55), after: sample(7000, 0.3),
    })
    // 同一 offsetMs 两个检测:保留 bbox 面积大的那个
    expect(pickEvidenceFrames(5000, [
      sample(3000, 0.1),
      sample(5000, 0.5, { w: 0.05, h: 0.05 }),
      sample(5000, 0.55, { w: 0.2, h: 0.2 }),
      sample(7000, 0.3),
    ])).toEqual({
      before: sample(3000, 0.1),
      violation: sample(5000, 0.55, { w: 0.2, h: 0.2 }),
      after: sample(7000, 0.3),
    })
  })

  it('目标贴边的帧可用:出画 bbox 参与选帧,交给 overlay 时再裁剪', () => {
    // 中间样本 x=0.95, w=0.1 → 中心 1.0 在画外但框有交集 → 仍可用
    const frames = pickEvidenceFrames(5000, [
      sample(3000, 0.1),
      sample(5000, 0.95),
      sample(7000, 0.3),
    ])
    expect(frames).toBeDefined()
    expect(frames!.violation.x).toBe(0.95)
    // 同一样本进 overlay 时被裁到画幅内(worker 契约要求画幅内)
    const overlays = evidenceOverlays(lineSnapshot, frames!, 0, '1')
    expect(overlays[1]!.boxes[0]!.x).toBe(0.95)
    expect(Math.abs(overlays[1]!.boxes[0]!.width - 0.05)).toBeLessThan(1e-9)
  })

  it('usableSampleCount 只统计可用样本', () => {
    expect(usableSampleCount([sample(0, 0.3), sample(0, 0.55, { w: 0 }), sample(0, 1.5)])).toBe(1)
  })

  it('任一角色凑不齐可用样本时整组作废', () => {
    // 违法时刻之前没有可用样本:缺"变道前"
    expect(pickEvidenceFrames(3000, [sample(4000, 0.1), sample(5000, 0.2)])).toBeUndefined()
    // 之后没有:缺"变道完成"
    expect(pickEvidenceFrames(6000, [sample(4000, 0.1), sample(5000, 0.2)])).toBeUndefined()
    // 没有任何可用样本
    expect(pickEvidenceFrames(5000, [sample(3000, 0.3), sample(5000, 0.55, { w: 0 })])).toBeUndefined()
  })

  it('formatFrameClock:毫秒精度 + 显式 UTC+08:00', () => {
    expect(formatFrameClock(1704067205000)).toBe('2024-01-01 08:00:05.000 UTC+08:00')
    expect(formatFrameClock(1704067203257)).toBe('2024-01-01 08:00:03.257 UTC+08:00')
  })
})

describe('overlay 计划(lane-change-evidence)', () => {
  const frames = {
    before: sample(3000, 0.1),
    violation: sample(5000, 0.2),
    after: sample(7000, 0.3),
  }

  it('三帧各用自己的 bbox,标签带角色/帧墙钟时间/obj_id', () => {
    const overlays = evidenceOverlays(lineSnapshot, frames, 1704067200000, 'car-7')
    expect(overlays).toHaveLength(3)
    expect(overlays[0]!.paths[0]).toEqual({
      type: 'line', points: lineSnapshot.normalized_points, stroke: { r: 255, g: 216, b: 0, a: 255 },
    })
    const box = overlays[0]!.boxes[0]!
    expect(box.x).toBe(0.1)
    expect(Math.abs(box.width - 0.1)).toBeLessThan(1e-9) // clamp 的浮点尾差
    expect(Math.abs(box.height - 0.1)).toBeLessThan(1e-9)
    expect(box.stroke).toEqual({ r: 255, g: 59, b: 48, a: 255 })
    expect(box.label).toBe('变道前 | 2024-01-01 08:00:03.000 UTC+08:00 | obj_id: car-7')
    expect(overlays[1]!.boxes[0]!.label).toBe('变道中 | 2024-01-01 08:00:05.000 UTC+08:00 | obj_id: car-7')
    expect(overlays[2]!.boxes[0]!.x).toBe(0.3)
  })

  it('polygon 带黄色半透明填充,line 只描边', () => {
    expect(evidenceOverlays(lineSnapshot, frames, 0, '1')[0]!.paths[0]).not.toHaveProperty('fill')
    expect(evidenceOverlays(polygonSnapshot, frames, 0, '1')[0]!.paths[0]).toMatchObject({
      type: 'polygon',
      fill: { r: 255, g: 216, b: 0, a: 38 },
    })
  })

  it('标注点数超上限时等距抽稀,保留首尾(worker 限三帧总点数 ≤256)', () => {
    const dense = {
      kind: 'line' as const,
      normalized_points: Array.from({ length: 200 }, (_, i) => ({ x: i / 199, y: 0.5 })),
    }
    const overlays = evidenceOverlays(dense, frames, 0, '1')
    const points = overlays[0]!.paths[0]!.points
    expect(points.length).toBeLessThanOrEqual(84) // 84×3 帧 = 252 ≤ 256,留余量
    expect(points[0]).toEqual({ x: 0, y: 0.5 }) // 首点保留
    expect(points[points.length - 1]).toEqual({ x: 1, y: 0.5 }) // 尾点保留
    for (const p of points) {
      expect(p.y).toBe(0.5) // 抽稀只减点,不改坐标
    }
    // 未超限的标注原样透传
    expect(evidenceOverlays(lineSnapshot, frames, 0, '1')[0]!.paths[0]!.points)
      .toBe(lineSnapshot.normalized_points)
  })
})

describe('后处理编排(lane-change-postprocess)', () => {
  it('verified 时按选中样本的时刻抽三帧,overlays 与 atMs 严格对齐', () => {
    const host = stubHost()
    const result = handle({ event_id: 'event-1', video_file_id: 'video-1', video_object_key: 'key-1' }, {} as AdapterCtx)

    expect(result).toMatchObject({ post_status: 'verified', evidence_count: 4 })
    expect(host.extractFrames).toHaveBeenCalledTimes(1)
    const call = host.extractFrames.mock.calls[0]!
    expect(call[1]).toEqual([3500, 5000, 6500])
    const overlays = call[4] as readonly { boxes: ReadonlyArray<{ label?: string }> }[]
    expect(overlays).toHaveLength(3)
    expect(overlays[1]!.boxes[0]!.label).toContain('变道中 | 2024-01-01 08:00:05.000 UTC+08:00 | obj_id: car-7')
    expect(host.log.info).toHaveBeenCalledWith('变道证据帧已选择', {
      event_id: 'event-1',
      target_interval_ms: 1500,
      before_offset_ms: 3500,
      violation_offset_ms: 5000,
      after_offset_ms: 6500,
      before_interval_ms: 1500,
      after_interval_ms: 1500,
    })
    expect(host.insert).toHaveBeenCalledTimes(4) // 三张图 + 一段视频
  })

  it('丢帧后抽帧时刻、overlay 框与标签、证据记录及诊断间隔均使用实际样本', () => {
    const host = stubHost({
      samples: [
        sample(3500, 0.2), sample(3633, 0.3), sample(4900, 0.4), sample(5000, 0.4, { w: 0 }),
        sample(5100, 0.57), sample(5133, 0.59), sample(6500, 0.65), sample(6633, 0.7),
      ],
    })
    const result = handle({ event_id: 'event-1', video_file_id: 'video-1', video_object_key: 'key-1' }, {} as AdapterCtx)

    expect(result).toMatchObject({ post_status: 'verified', evidence_count: 4 })
    const call = host.extractFrames.mock.calls[0]!
    expect(call[1]).toEqual([3633, 5100, 6633])
    const overlays = call[4] as readonly { boxes: ReadonlyArray<{ x: number, label: string }> }[]
    expect(overlays.map(overlay => overlay.boxes[0]!.x)).toEqual([0.3, 0.57, 0.7])
    expect(overlays[0]!.boxes[0]!.label).toContain('08:00:03.633 UTC+08:00')
    expect(overlays[1]!.boxes[0]!.label).toContain('08:00:05.100 UTC+08:00')
    expect(overlays[2]!.boxes[0]!.label).toContain('08:00:06.633 UTC+08:00')
    expect(host.insert.mock.calls.slice(0, 3).map(call => (call[1] as { at_ms: string }).at_ms))
      .toEqual(['3633', '5100', '6633'])
    expect(host.log.info).toHaveBeenCalledWith('变道证据帧已选择', expect.objectContaining({
      target_interval_ms: 1500, before_interval_ms: 1467, after_interval_ms: 1533,
    }))
  })

  it('evidence 记录的 role 依序落 before/violation/after/clip', () => {
    const host = stubHost()
    handle({ event_id: 'event-1', video_file_id: 'video-1', video_object_key: 'key-1' }, {} as AdapterCtx)

    const roles = host.insert.mock.calls.map(call => (call[1] as { role: string }).role)
    expect(roles).toEqual([...EVIDENCE_FRAME_ROLES, 'clip'])
    const keys = host.insert.mock.calls.map(call => (call[1] as { evidence_key: string }).evidence_key)
    expect(keys).toEqual(['event-1:before', 'event-1:violation', 'event-1:after', 'event-1:clip'])
  })

  it('证据片以违法时刻为中心取前后各 7.5 秒(共 15 秒)，起点钳 0', () => {
    // 违法时刻 5000ms:-7500 钳 0,+7500 → 12500。规格 2026-09-16 定稿(worker 参考版 58a12f7)
    const host = stubHost()
    handle({ event_id: 'event-1', video_file_id: 'video-1', video_object_key: 'key-1' }, {} as AdapterCtx)

    const [, startMs, endMs] = host.createClip.mock.calls[0]!
    expect([startMs, endMs]).toEqual([0, 12500])
  })

  it('选不出三个可用样本时失败且不抽帧不剪片,失败与选帧诊断都留日志', () => {
    const host = stubHost({
      samples: [
        sample(3000, 0.3),
        sample(5000, 0.55),
        sample(7000, 0.65, { w: 0 }),
        sample(7500, 0.7, { w: 0 }),
      ],
    })
    const result = handle({ event_id: 'event-1', video_file_id: 'video-1', video_object_key: 'key-1' }, {} as AdapterCtx)

    expect(result).toMatchObject({ post_status: 'failed', evidence_count: 0 })
    expect(result.reason).toContain('目标轨迹不足')
    expect(host.extractFrames).not.toHaveBeenCalled()
    expect(host.createClip).not.toHaveBeenCalled()
    // 测试环境的教训:失败路径静默会让"没跑"与"判否"无从区分,日志是唯一排障入口。
    expect(host.log.error).toHaveBeenCalledWith('证据帧选择失败：轨迹中凑不齐前/中/后三个可用样本',
      expect.objectContaining({ event_id: 'event-1', samples: 4, usable: 2 }))
    expect(host.log.error).toHaveBeenCalledWith('变道后处理失败',
      expect.objectContaining({ event_id: 'event-1', reason: result.reason }))
  })

  it('轨迹未跨线时保持 rejected 且不抽帧,rejected 也留日志', () => {
    const host = stubHost({ samples: [sample(3000, 0.1), sample(5000, 0.2), sample(7000, 0.3)] })
    const result = handle({ event_id: 'event-1', video_file_id: 'video-1', video_object_key: 'key-1' }, {} as AdapterCtx)

    expect(result.post_status).toBe('rejected')
    expect(result.reason).toContain('未跨越标注实线')
    expect(host.extractFrames).not.toHaveBeenCalled()
    expect(host.log.warn).toHaveBeenCalledWith('变道复核未通过，事件标记 rejected',
      expect.objectContaining({ event_id: 'event-1', samples: 3, usable: 3 }))
  })

  it('导流区事件按入区判定', () => {
    const host = stubHost({
      record: event({ snapshot_json: JSON.stringify(polygonSnapshot) }),
      samples: [sample(3000, 0.1), sample(5000, 0.5), sample(7000, 0.7)],
    })
    const result = handle({ event_id: 'event-1', video_file_id: 'video-1', video_object_key: 'key-1' }, {} as AdapterCtx)

    expect(result).toMatchObject({ post_status: 'verified', reason: '轨迹进入导流区' })
  })

  it('Worker skip 某帧时按证据不完整失败', () => {
    const host = stubHost({ skippedFrame: true })
    const result = handle({ event_id: 'event-1', video_file_id: 'video-1', video_object_key: 'key-1' }, {} as AdapterCtx)

    expect(result).toMatchObject({ post_status: 'failed', reason: '证据生成不完整(缺 1 份)', evidence_count: 0 })
    expect(host.createClip).toHaveBeenCalledTimes(1)
  })

  it('extractFrames 抛错时收敛为 failed 且 failure_reason 不泄露凭据', () => {
    const host = stubHost({ extractFramesError: new Error('解码失败 token=secret-value') })
    const result = handle({ event_id: 'event-1', video_file_id: 'video-1', video_object_key: 'key-1' }, {} as AdapterCtx)

    expect(result).toMatchObject({ post_status: 'failed', evidence_count: 0 })
    expect(result.reason).toContain('token=[已隐藏]')
    expect(result.reason).not.toContain('secret-value')
    expect(result.reason).toContain('证据生成阶段') // 收敛文案注明失败环节
    expect(host.update).toHaveBeenLastCalledWith('lane_change_event', { id: { eq: 'event-1' } }, {
      post_status: 'failed',
      failure_reason: result.reason,
    })
  })

  it.each([
    ['probe', { probeError: new Error('probe unavailable') }],
    ['getTrack', { trackError: new Error('track unavailable') }],
  ] as const)('%s 抛错时收敛为 failed', (_name, options) => {
    const host = stubHost(options)
    const result = handle({ event_id: 'event-1', video_file_id: 'video-1', video_object_key: 'key-1' }, {} as AdapterCtx)

    expect(result).toMatchObject({ post_status: 'failed', evidence_count: 0 })
    expect(host.update.mock.calls[1]?.[2]).toMatchObject({ post_status: 'failed', failure_reason: result.reason })
  })

  it('inspect 抛「找不到 sidecar」时原样抛出走作业重试，不收敛成 failed', () => {
    // sidecar 晚于视频回调 41~97s 落桶是暂态：收敛成 failed 会错杀本可成功的证据链
    // (2026-10-13 失败实录)。期望异常向上抛，由 postprocess.json 的 maxAttempts 重试。
    const host = stubHost({ inspectError: new Error('objectTrack: 找不到 sidecar(候选:video_ai_process_output/x/y/Remote-Control/DJI_20261013111513_0001_V.json / video_) 绑的不是可见光 _V 变体?') })

    expect(() => handle({ event_id: 'event-1', video_file_id: 'video-1', video_object_key: 'key-1' }, {} as AdapterCtx))
      .toThrow('找不到 sidecar')
    // 只许 CAS 推进 processing 的那一次 update，不得出现收敛 failed 的写
    expect(host.update).toHaveBeenCalledTimes(1)
    expect(host.log.error).not.toHaveBeenCalled()
  })

  it.each(['verified', 'rejected', 'failed'])('已处于终态 %s 时不重复后处理', (postStatus) => {
    const host = stubHost({ record: event({ post_status: postStatus }) })
    const result = handle({ event_id: 'event-1', video_file_id: 'video-1', video_object_key: 'key-1' }, {} as AdapterCtx)

    expect(result).toMatchObject({ post_status: postStatus, reason: '已处理过', evidence_count: 0 })
    expect(host.probe).not.toHaveBeenCalled()
    expect(host.extractFrames).not.toHaveBeenCalled()
  })

  it('违法时刻落在视频外时退回 pending_video 等下一段', () => {
    const host = stubHost({ record: event({ crossed_at_ms: '1704067215000' }) })
    const result = handle({ event_id: 'event-1', video_file_id: 'video-1', video_object_key: 'key-1' }, {} as AdapterCtx)

    expect(result).toMatchObject({ post_status: 'pending_video', evidence_count: 0 })
    expect(host.extractFrames).not.toHaveBeenCalled()
    expect(host.update).toHaveBeenCalledWith('lane_change_event', { id: { eq: 'event-1' } }, expect.objectContaining({
      post_status: 'pending_video', video_file_id: '',
    }))
  })

  it('异常收敛本身也失败时重新抛出原始异常', () => {
    const originalError = new Error('extract failed')
    stubHost({ extractFramesError: originalError, settleUpdateError: new Error('update failed') })

    let caught: unknown
    try {
      handle({ event_id: 'event-1', video_file_id: 'video-1', video_object_key: 'key-1' }, {} as AdapterCtx)
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(originalError)
  })
})
