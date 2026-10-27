// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * djmd 解析结果 → sim 既有 SEI NDJSON 格式（replay-source 解析契约）。
 *
 * 帧时间按视频 frameIndex / fps 对齐；只输出 field13 AI 检测 payload，
 * detector seq 按检测回调连续递增，普通视频元数据包不占 detector 帧。
 * rawTargets 保留万分比 box 与数字 state，由 ReplayFrameSource 的 legacy
 * 协议映射走生产 toCoreBBoxes 过滤链。视频元信息放 meta.video，供页面
 * 以录像画面为背景渲染。
 */
import type { ParsedDjmd } from './parser'

export interface DjmdVideoInfo {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationMs: number;
  readonly fileName?: string;
}

/**
 * djmd 机载检测协议 → cockpit 检测协议（target-filter CAR_TARGET_TYPE='3'）的
 * 车辆类型映射。新录像使用字符串 car，旧样本使用数字 0；其他取值按
 * rawTypeCounts 诊断，不能用默认值误映射为车辆。
 */
const DJMD_VEHICLE_TYPE_MAP: ReadonlyMap<number | string, number> = new Map<number | string, number>([
  [0, 3],
  ['car', 3],
])

export interface DjmdReplaySummary {
  readonly packets: number;
  readonly detectorFrames: number;
  readonly framesWithDetections: number;
  readonly totalDetections: number;
  readonly uniqueObjIds: number;
  /** 原始 obj_type 分布（映射前），供诊断未知枚举值。 */
  readonly rawTypeCounts: Readonly<Record<string, number>>;
}

function frameElapsedMs (frameIndex: number, fps: number): number {
  return (frameIndex / fps) * 1000
}

export function buildDjmdReplayNdjson (
  djmd: ParsedDjmd,
  video: DjmdVideoInfo,
): string {
  if (!(video.fps > 0)) throw new Error('视频 fps 无效，无法对齐检测帧时间')

  const rawTypeCounts: Record<string, number> = {}
  for (const frame of djmd.frames) {
    for (const det of frame.detections) {
      const key = String(det.objType)
      rawTypeCounts[key] = (rawTypeCounts[key] ?? 0) + 1
    }
  }

  // 手工构造/旧测试 fixture 没有该字段，仍按检测帧处理；parser 产生的普通包显式为 false。
  const detectorFrames = djmd.frames.filter(frame => frame.hasDetectionPayload !== false)
  const summary: DjmdReplaySummary = {
    packets: djmd.frames.length,
    detectorFrames: detectorFrames.length,
    framesWithDetections: djmd.framesWithDetections,
    totalDetections: djmd.totalDetections,
    uniqueObjIds: djmd.uniqueObjIds,
    rawTypeCounts,
  }

  const meta = {
    kind: 'lane-change-sei-replay-meta',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    source: 'djmd',
    durationMs: Math.max(1000, Math.ceil(video.durationMs)),
    video: {
      width: video.width,
      height: video.height,
      fps: video.fps,
      durationMs: Math.max(1000, Math.ceil(video.durationMs)),
      ...(video.fileName !== undefined ? { fileName: video.fileName } : {}),
    },
    djmd: summary,
  }

  const lines: string[] = [JSON.stringify(meta)]
  for (let detectorSequence = 0; detectorSequence < detectorFrames.length; detectorSequence++) {
    const frame = detectorFrames[detectorSequence]!
    const elapsedMs = frameElapsedMs(frame.frameIndex, video.fps)
    lines.push(JSON.stringify({
      kind: 'frame',
      now: elapsedMs,
      elapsedMs,
      seq: detectorSequence,
      sourceFrameIndex: frame.frameIndex,
      rawTargets: frame.detections.map(det => ({
        id: det.objId,
        type: DJMD_VEHICLE_TYPE_MAP.get(det.objType) ?? det.objType,
        state: det.objState,
        box: { cx: det.cx, cy: det.cy, w: det.w, h: det.h },
      })),
    }))
  }
  return `${lines.join('\n')}\n`
}
