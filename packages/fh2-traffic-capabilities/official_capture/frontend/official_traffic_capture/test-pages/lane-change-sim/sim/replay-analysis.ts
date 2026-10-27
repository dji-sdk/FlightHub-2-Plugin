// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { CoreBBox, ObjId } from '../../../src/hosts/cockpit/lane-change/detector-core'
import { TRACKABLE_TARGET_STATES } from '../../../src/hosts/cockpit/lane-change/target-filter'
import {
  type ParsedLaneChangeReplay,
  getReplayFrameTime,
  mapLegacyStateName,
  replayFrameBBoxes,
} from './replay-source'

export interface ReplayAnalysisSummary {
  frames: number;
  sourcePackets?: number;
  detectorFrames?: number;
  durationMs: number;
  avgFps: number;
  frameIntervalP50Ms: number;
  frameIntervalP90Ms: number;
  frameIntervalP95Ms: number;
  maxFrameIntervalMs: number;
  targetCountMin: number;
  targetCountAvg: number;
  targetCountMax: number;
  validCarCountAvg: number;
  uniqueIds: number;
  shortLivedIds: number;
  stateCounts: Record<string, number>;
  bboxWidthP50: number;
  bboxWidthP90: number;
  offscreenBBoxRatio: number;
  duplicatePairCount: number;
  parseErrors: number;
  height?: unknown;
  aglMeters?: number;
  zoomFactor?: unknown;
  shortLivedIdRatio: number;
  notes: string[];
}

function percentile (values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))
  return sorted[index]!
}

function avg (values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function toFiniteNumber (value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function bboxIsOffscreen (bbox: CoreBBox): boolean {
  return bbox.rect.x1 < 0 || bbox.rect.y1 < 0 || bbox.rect.x2 > 1 || bbox.rect.y2 > 1
}

function bboxIou (a: CoreBBox, b: CoreBBox): number {
  const x1 = Math.max(a.rect.x1, b.rect.x1)
  const y1 = Math.max(a.rect.y1, b.rect.y1)
  const x2 = Math.min(a.rect.x2, b.rect.x2)
  const y2 = Math.min(a.rect.y2, b.rect.y2)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const areaA = Math.max(0, a.rect.x2 - a.rect.x1) * Math.max(0, a.rect.y2 - a.rect.y1)
  const areaB = Math.max(0, b.rect.x2 - b.rect.x1) * Math.max(0, b.rect.y2 - b.rect.y1)
  const union = areaA + areaB - inter
  return union > 0 ? inter / union : 0
}

function findContextValue (replay: ParsedLaneChangeReplay, key: string): unknown {
  const metaContext = replay.meta?.context
  if (metaContext && typeof metaContext === 'object' && key in metaContext) {
    return (metaContext as Record<string, unknown>)[key]
  }
  for (const frame of replay.frames) {
    if (frame.context && key in frame.context) {
      return (frame.context as Record<string, unknown>)[key]
    }
  }
  return undefined
}

export function analyzeLaneChangeReplay (replay: ParsedLaneChangeReplay): ReplayAnalysisSummary {
  const firstNow = replay.frames[0]?.now ?? 0
  const frameTimes = replay.frames.map(frame => getReplayFrameTime(frame, firstNow)).sort((a, b) => a - b)
  const intervals = frameTimes.slice(1).map((time, index) => Math.max(0, time - frameTimes[index]!))
  const targetCounts = replay.frames.map(frame => frame.rawTargets?.length ?? frame.coreBBoxes?.length ?? 0)
  const validCarCounts: number[] = []
  const stateCounts: Record<string, number> = {}
  const idCounts = new Map<ObjId, number>()
  const widths: number[] = []
  let offscreenBBoxCount = 0
  let totalBBoxCount = 0
  let duplicatePairCount = 0

  for (const frame of replay.frames) {
    for (const target of frame.rawTargets ?? []) {
      const state = mapLegacyStateName(target.state)
      stateCounts[state] = (stateCounts[state] ?? 0) + 1
      idCounts.set(target.id, (idCounts.get(target.id) ?? 0) + 1)
    }

    const bboxes = replayFrameBBoxes(frame)
    validCarCounts.push(bboxes.length)
    if (!frame.rawTargets) {
      for (const bbox of bboxes) {
        idCounts.set(bbox.objId, (idCounts.get(bbox.objId) ?? 0) + 1)
      }
    }
    for (const bbox of bboxes) {
      widths.push(Math.max(0, bbox.rect.x2 - bbox.rect.x1))
      totalBBoxCount += 1
      if (bboxIsOffscreen(bbox)) offscreenBBoxCount += 1
    }

    for (let i = 0; i < bboxes.length; i++) {
      for (let j = i + 1; j < bboxes.length; j++) {
        if (bboxIou(bboxes[i]!, bboxes[j]!) >= 0.85) duplicatePairCount += 1
      }
    }
  }

  const durationMs = replay.duration || (frameTimes[frameTimes.length - 1] ?? 0)
  const height = findContextValue(replay, 'height')
  const takeoff = toFiniteNumber(findContextValue(replay, 'altitudeOfTakeoffPoint'))
  const heightNumber = toFiniteNumber(height)
  const aglMeters = heightNumber !== undefined && takeoff !== undefined ? heightNumber - takeoff : undefined
  const shortLivedIds = Array.from(idCounts.values()).filter(count => count <= 2).length
  const trackableStates = Object.keys(stateCounts).filter(state => TRACKABLE_TARGET_STATES.has(state))
  const notes: string[] = []
  const djmd = replay.meta?.djmd && typeof replay.meta.djmd === 'object'
    ? replay.meta.djmd as Record<string, unknown>
    : null
  const sourcePackets = toFiniteNumber(djmd?.packets)
  const detectorFrames = toFiniteNumber(djmd?.detectorFrames)
  if (sourcePackets !== undefined && detectorFrames !== undefined && sourcePackets > detectorFrames) {
    notes.push(`仅 ${detectorFrames}/${sourcePackets} 个 djmd 包含 AI 检测 payload；普通视频元数据包不送入 detector。`)
  }
  if (avg(intervals) > 100) {
    notes.push('SEI 识别帧率明显低于视频帧率，回放时 detector 只在录制帧时间点被调用。')
  }
  if (idCounts.size > 0 && shortLivedIds / idCounts.size > 0.3) {
    notes.push('短生命周期 ID 较多，需要覆盖 ghost / re-ID / duplicate bbox 场景。')
  }
  if (trackableStates.length === 0 && Object.keys(stateCounts).length > 0) {
    notes.push('录制中没有任何落在可跟踪白名单内的目标状态。')
  }

  return {
    frames: replay.frames.length,
    ...(sourcePackets !== undefined ? { sourcePackets } : {}),
    ...(detectorFrames !== undefined ? { detectorFrames } : {}),
    durationMs,
    avgFps: durationMs > 0 ? replay.frames.length / (durationMs / 1000) : 0,
    frameIntervalP50Ms: percentile(intervals, 0.50),
    frameIntervalP90Ms: percentile(intervals, 0.90),
    frameIntervalP95Ms: percentile(intervals, 0.95),
    maxFrameIntervalMs: intervals.length > 0 ? Math.max(...intervals) : 0,
    targetCountMin: targetCounts.length > 0 ? Math.min(...targetCounts) : 0,
    targetCountAvg: avg(targetCounts),
    targetCountMax: targetCounts.length > 0 ? Math.max(...targetCounts) : 0,
    validCarCountAvg: avg(validCarCounts),
    uniqueIds: idCounts.size,
    shortLivedIds,
    stateCounts,
    bboxWidthP50: percentile(widths, 0.50),
    bboxWidthP90: percentile(widths, 0.90),
    offscreenBBoxRatio: totalBBoxCount > 0 ? offscreenBBoxCount / totalBBoxCount : 0,
    duplicatePairCount,
    parseErrors: replay.parseErrors.length,
    height,
    ...(aglMeters !== undefined ? { aglMeters } : {}),
    zoomFactor: findContextValue(replay, 'zoomFactor'),
    shortLivedIdRatio: idCounts.size > 0 ? shortLivedIds / idCounts.size : 0,
    notes,
  }
}
