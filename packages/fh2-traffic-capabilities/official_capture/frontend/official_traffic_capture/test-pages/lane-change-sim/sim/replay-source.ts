// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * B 模式 SEI NDJSON 录制解析与回放数据源。
 *
 * 录制格式沿用 宿主原生调试面板导出协议（rawTargets 万分比 + 数字
 * state），插件检测协议为字符串 state，这里做一层显式协议映射，保证回放走的
 * 仍是生产 toCoreBBoxes 过滤链路。
 */
import type { CoreBBox, ObjId, Point2D, ValidCoreRegion } from '../../../src/hosts/cockpit/lane-change/detector-core'
import { type CarTargetLike, toCoreBBoxes } from '../../../src/hosts/cockpit/lane-change/target-filter'
import type { Scenario } from './types'
import type { SimFrameSource } from './frame-source'

export interface LaneChangeSeiReplayVideo {
  width: number;
  height: number;
  fps?: number;
  durationMs?: number;
  fileName?: string;
}

export interface LaneChangeSeiReplayMeta {
  kind: 'lane-change-sei-replay-meta';
  formatVersion: number;
  exportedAt: string;
  source: string;
  durationMs?: number;
  regionsSnapshot?: Array<{ id: string; kind: 'line' | 'polygon'; points: Point2D[] }>;
  /** djmd 提取链路写入的录像元信息；页面据此启用视频背景渲染。 */
  video?: LaneChangeSeiReplayVideo;
  [key: string]: unknown;
}

export interface LaneChangeSeiReplayFrame {
  kind?: 'frame';
  now: number;
  elapsedMs?: number;
  seq: number;
  /** 视频原始帧编号；只用于定位，不参与 detector 连续性。 */
  sourceFrameIndex?: number;
  rawTargets?: Array<{
    id: ObjId;
    type: number | string;
    state: number | string;
    box?: { cx: number; cy: number; w: number; h: number };
  }>;
  coreBBoxes?: CoreBBox[];
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ParsedLaneChangeReplay {
  meta: LaneChangeSeiReplayMeta | null;
  frames: LaneChangeSeiReplayFrame[];
  duration: number;
  parseErrors: string[];
}

/** 旧数字 ObjectState → 插件字符串语义状态；未知值映射为不可跟踪状态。 */
const LEGACY_STATE_NAMES: ReadonlyMap<number, string> = new Map([
  [1, 'tracked'],
  [2, 'vision-beacon-fused'],
  [3, 'auxiliary-tracked'],
  [4, 'not-confident'],
  [6, 'lost'],
  [7, 'redetected'],
])

/** 数字 state 映射为生产字符串协议（摘要统计与过滤链路使用同一契约）。 */
export function mapLegacyStateName (state: number | string): string {
  return typeof state === 'number'
    ? LEGACY_STATE_NAMES.get(state) ?? 'unknown-legacy-state'
    : state
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

export function getReplayFrameTime (frame: LaneChangeSeiReplayFrame, firstNow: number): number {
  if (typeof frame.elapsedMs === 'number' && Number.isFinite(frame.elapsedMs)) {
    return Math.max(0, frame.elapsedMs)
  }
  return Math.max(0, frame.now - firstNow)
}

export function parseLaneChangeReplayNdjson (text: string): ParsedLaneChangeReplay {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  let meta: LaneChangeSeiReplayMeta | null = null
  const frames: LaneChangeSeiReplayFrame[] = []
  const parseErrors: string[] = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch (error) {
      parseErrors.push(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (!isRecord(parsed)) continue
    if (parsed.kind === 'lane-change-sei-replay-meta') {
      meta = parsed as unknown as LaneChangeSeiReplayMeta
      continue
    }
    if (typeof parsed.now === 'number' && typeof parsed.seq === 'number') {
      frames.push(parsed as unknown as LaneChangeSeiReplayFrame)
    }
  }

  const firstNow = frames.reduce((min, frame) => Math.min(min, frame.now), frames[0]?.now ?? 0)
  frames.sort((a, b) => getReplayFrameTime(a, firstNow) - getReplayFrameTime(b, firstNow))
  const duration = Math.max(
    meta?.durationMs ?? 0,
    ...frames.map(frame => getReplayFrameTime(frame, firstNow)),
  )

  return { meta, frames, duration, parseErrors }
}

/** 旧协议数字目标 → 插件 CarTargetLike（万分比 → 归一化）。 */
function legacyTargetToCarTarget (target: NonNullable<LaneChangeSeiReplayFrame['rawTargets']>[number]): CarTargetLike | null {
  const box = target.box
  if (!box || !Number.isFinite(box.cx) || !Number.isFinite(box.cy) || !Number.isFinite(box.w) || !Number.isFinite(box.h)) {
    return null
  }
  const state = mapLegacyStateName(target.state)
  const width = box.w / 10000
  const height = box.h / 10000
  return {
    targetId: target.id,
    type: String(target.type),
    state,
    bbox: {
      x: (box.cx - box.w / 2) / 10000,
      y: (box.cy - box.h / 2) / 10000,
      width,
      height,
    },
  }
}

export function replayFrameBBoxes (frame: LaneChangeSeiReplayFrame): CoreBBox[] {
  if (frame.coreBBoxes) return frame.coreBBoxes
  return toCoreBBoxes(replayFrameRawTargets(frame))
}

/** 帧内原始目标（旧数字协议 → CarTargetLike，不做 type/state/尺寸过滤）。 */
export function replayFrameRawTargets (frame: LaneChangeSeiReplayFrame): CarTargetLike[] {
  return (frame.rawTargets ?? [])
    .map(legacyTargetToCarTarget)
    .filter((target): target is CarTargetLike => !!target)
}

export class ReplayFrameSource implements SimFrameSource {
  private readonly firstNow: number

  constructor (private readonly replay: ParsedLaneChangeReplay) {
    this.firstNow = replay.frames[0]?.now ?? 0
  }

  private findFrameAtTime (t: number): LaneChangeSeiReplayFrame | null {
    const frames = this.replay.frames
    if (frames.length === 0) return null

    let selected: LaneChangeSeiReplayFrame | null = null
    for (const frame of frames) {
      if (getReplayFrameTime(frame, this.firstNow) > t) break
      selected = frame
    }
    return selected
  }

  /** 画布展示最近一次 AI 检测结果；有效空结果也必须清空 bbox。 */
  private findDisplayFrameAtTime (t: number): LaneChangeSeiReplayFrame | null {
    return this.findFrameAtTime(t)
  }

  getBBoxesAtTime (t: number): CoreBBox[] {
    const frame = this.findFrameAtTime(t)
    return frame ? replayFrameBBoxes(frame) : []
  }

  getDisplayBBoxesAtTime (t: number): CoreBBox[] {
    const frame = this.findDisplayFrameAtTime(t)
    return frame ? replayFrameBBoxes(frame) : []
  }

  /** 调试用：未经过滤的原始目标（type/state 白名单过滤前）。 */
  getRawTargetsAtTime (t: number): CarTargetLike[] {
    const frame = this.findFrameAtTime(t)
    if (!frame) return []
    return replayFrameRawTargets(frame)
  }

  getDisplayRawTargetsAtTime (t: number): CarTargetLike[] {
    const frame = this.findDisplayFrameAtTime(t)
    if (!frame) return []
    return replayFrameRawTargets(frame)
  }

  getFrameTimes (): number[] {
    return Array.from(new Set(
      this.replay.frames.map(frame => getReplayFrameTime(frame, this.firstNow)),
    )).sort((a, b) => a - b)
  }

  getSequenceAtTime (t: number): number | null {
    return this.findFrameAtTime(t)?.seq ?? null
  }
}

/** 旧录制 regionsSnapshot 无 valid 字段；补齐插件 CoreRegion 契约。 */
function snapshotToRegions (snapshot: LaneChangeSeiReplayMeta['regionsSnapshot']): ValidCoreRegion[] {
  if (!snapshot) return []
  return snapshot
    .filter(region => region.kind === 'line' || region.kind === 'polygon')
    .map(region => region.kind === 'line'
      ? { id: region.id, kind: 'line' as const, valid: true as const, points: region.points }
      : { id: region.id, kind: 'polygon' as const, valid: true as const, points: region.points })
}

export function createReplayScenario (
  fileName: string,
  replay: ParsedLaneChangeReplay,
  options: { id?: string; name?: string; videoUrl?: string } = {},
): Scenario {
  const metaVideo = replay.meta?.video
  const video = metaVideo && options.videoUrl && metaVideo.width > 0 && metaVideo.height > 0
    ? {
        url: options.videoUrl,
        width: metaVideo.width,
        height: metaVideo.height,
        ...(metaVideo.fps !== undefined ? { fps: metaVideo.fps } : {}),
      }
    : undefined

  return {
    id: options.id ?? `replay-${Date.now()}`,
    name: options.name ?? `录制回放·${fileName}`,
    description: 'DebugPanel 导出的 B 模式 SEI bbox 录制。录制默认只含 bbox；如需触发事件，请在画布上手绘 LINE/POLYGON 或加载带 regionsSnapshot 的录制。',
    duration: Math.max(1000, Math.ceil(replay.duration)),
    regions: snapshotToRegions(replay.meta?.regionsSnapshot),
    tracks: [],
    ...(video !== undefined ? { video } : {}),
  }
}
