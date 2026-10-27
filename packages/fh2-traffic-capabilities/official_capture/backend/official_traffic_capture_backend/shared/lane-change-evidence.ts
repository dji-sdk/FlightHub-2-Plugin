// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 变道证据图的域逻辑:从复核通过的轨迹里挑出前/中/后三帧,并把它们翻成
// Worker 可烧录的 overlay 计划。与编排(adapters/lane-change-postprocess.ts)分开:
// 这里是纯函数,输入轨迹与标注快照,输出"画谁、画什么、写什么字",不碰存储与宿主。
import { pad2, tzOffsetHours } from './time'
import type { AnnotationSnapshot } from './lane-change'
import type { VideoFrameOverlay, VideoOverlayPath, VideoRGBA } from 'fh2-plugin-sdk/backend'

/** 三张证据图的角色。数组顺序 = overlays/atMs 的下标序 = evidence 表的 role 值域。 */
export const EVIDENCE_FRAME_ROLES = ['before', 'violation', 'after'] as const
export type EvidenceRole = (typeof EVIDENCE_FRAME_ROLES)[number]

// 拥堵慢速场景需要拉开三图的位置变化,相邻检测帧通常只隔几十毫秒。
export const EVIDENCE_FRAME_INTERVAL_MS = 1500

/** 角色的中文文案,进媒体库文件名,也烧进图片标签。 */
export const EVIDENCE_ROLE_TEXT: Readonly<Record<EvidenceRole, string>> = {
  before: '变道前',
  violation: '变道中',
  after: '变道完成',
}

/** MOT sidecar 里一帧目标检测:x/y/w/h 都是归一化画幅坐标,与标注快照同系。 */
export interface TrackSample {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly offsetMs: number
}

/** 一组选定的证据帧:三个角色各自持有一个轨迹样本,互不相同且时间递增。 */
export interface EvidenceFrameSet {
  readonly before: TrackSample
  readonly violation: TrackSample
  readonly after: TrackSample
}

/**
 * 一个样本能不能当证据帧,看的只有 bbox:四个值有限、宽高为正、框与画幅还有交集。
 * 交集口径是刻意放宽的(测试环境教训:此前的"中心在画内"口径会把目标正在进出画面
 * 的帧全部杀掉 —— 俯视相机下目标贴边是常态,中心出画 ≠ 看不见这辆车)。框出画的
 * 部分由 clampedBox 裁掉;只有与画幅毫无交集的样本才真正排除。
 */
export function usableSample (sample: TrackSample): boolean {
  if (![sample.x, sample.y, sample.w, sample.h].every(Number.isFinite)) return false
  if (sample.w <= 0 || sample.h <= 0) return false
  return sample.x < 1 && sample.x + sample.w > 0 && sample.y < 1 && sample.y + sample.h > 0
}

/**
 * 把 bbox 裁到画幅内。worker 契约要求 overlay 的 bbox 在 [0,1] 画幅内,而 MOT 检测框
 * 在目标贴边时天然越界 —— 裁掉出画部分再提交,样本本身不丢(丢样本会让可用帧更少,
 * 这正是测试环境"目标轨迹不足"的来源之一)。
 * 前置条件:已过 usableSample(框与画幅有交集),故裁后宽高恒为正。
 */
export function clampedBox (sample: TrackSample): { x: number, y: number, width: number, height: number } {
  const left = Math.max(0, Math.min(sample.x, 1))
  const top = Math.max(0, Math.min(sample.y, 1))
  const right = Math.max(0, Math.min(sample.x + sample.w, 1))
  const bottom = Math.max(0, Math.min(sample.y + sample.h, 1))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** 可用样本计数:只进日志诊断,帮助"目标轨迹不足"时看清楚是轨迹本来就少还是口径杀掉的。 */
export function usableSampleCount (samples: readonly TrackSample[]): number {
  let count = 0
  for (const sample of samples) {
    if (usableSample(sample)) count++
  }
  return count
}

/**
 * 自适应选帧:离违法时刻最近的可用样本当"变道中",以该帧前后各 1.5 秒为目标,
 * 在两侧分别选最接近目标时刻的可用样本当"变道前/变道完成"。
 *
 * 不硬抽目标时刻的裸图:短轨迹或检测丢帧时,目标时刻可能没有车。允许实际间隔偏离
 * 1.5 秒,但抽帧时刻(offsetMs)与红框位置(x/y/w/h)必须都来自同一个选中样本。
 * 这里只选时间,不判断车辆是否完全进入另一车道。
 *
 * 对真实 sidecar 数据的两个宽容(测试环境教训:按"严格递增"先验整组拒绝,会把好轨迹
 * 一起杀掉):① 样本先稳定排序 —— sidecar 不保证输出有序;② 同一 offsetMs 出现多个
 * 检测(同帧重复上报是常态)时取 bbox 面积最大的一个。去重后三个角色必然互不相同且
 * 时间递增;任一角色凑不齐回 undefined,调用方按"证据不完整"失败,不生成缺帧的
 * "完整"证据。
 */
export function pickEvidenceFrames (
  crossedOffsetMs: number,
  samples: readonly TrackSample[],
): EvidenceFrameSet | undefined {
  // 预处理:按 offsetMs 稳定排序,同一时刻只保留 bbox 面积最大的检测。
  const ordered = [...samples]
    .filter(sample => Number.isFinite(sample.offsetMs))
    .sort((a, b) => a.offsetMs - b.offsetMs)
  const frames: TrackSample[] = []
  for (const sample of ordered) {
    const last = frames[frames.length - 1]
    if (last !== undefined && last.offsetMs === sample.offsetMs) {
      if (sample.w * sample.h > last.w * last.h) frames[frames.length - 1] = sample
      continue
    }
    frames.push(sample)
  }
  // 变道中:全程扫一遍,留下离违法时刻最近的可用样本的下标。
  let violation = -1
  for (let i = 0; i < frames.length; i++) {
    if (!usableSample(frames[i]!)) continue
    if (violation < 0
      || Math.abs(frames[i]!.offsetMs - crossedOffsetMs) < Math.abs(frames[violation]!.offsetMs - crossedOffsetMs)) {
      violation = i
    }
  }
  if (violation < 0) return undefined
  // 锚点用实际中图而非原始违法时刻,避免中图因丢帧偏移后前后间隔跟着失准。
  const beforeTarget = frames[violation]!.offsetMs - EVIDENCE_FRAME_INTERVAL_MS
  const afterTarget = frames[violation]!.offsetMs + EVIDENCE_FRAME_INTERVAL_MS
  // 从中图向外扫描,同距时保留靠近中图的样本,不额外拉长过程窗口。
  let before = -1
  for (let i = violation - 1; i >= 0; i--) {
    if (!usableSample(frames[i]!)) continue
    if (before < 0
      || Math.abs(frames[i]!.offsetMs - beforeTarget) < Math.abs(frames[before]!.offsetMs - beforeTarget)) {
      before = i
    }
  }
  let after = -1
  for (let i = violation + 1; i < frames.length; i++) {
    if (!usableSample(frames[i]!)) continue
    if (after < 0
      || Math.abs(frames[i]!.offsetMs - afterTarget) < Math.abs(frames[after]!.offsetMs - afterTarget)) {
      after = i
    }
  }
  if (before < 0 || after < 0) return undefined
  return { before: frames[before]!, violation: frames[violation]!, after: frames[after]! }
}

// ── overlay 计划 ────────────────────────────────────────────────────────────
// 颜色与驾驶舱实时截图(snapshot-overlay.ts)同一口径:标线/导流区黄 #FFD800,
// 导流区叠 15% 半透明填充(a=38≈0.15),违法车红框 #FF3B30。

const YELLOW_STROKE: VideoRGBA = { r: 255, g: 216, b: 0, a: 255 }
const AREA_FILL: VideoRGBA = { r: 255, g: 216, b: 0, a: 38 }
const TARGET_STROKE: VideoRGBA = { r: 255, g: 59, b: 48, a: 255 }

// worker 限单次抽帧请求的 overlay 总点数 ≤256,三帧共用同一份标注 → 每帧最多 84 点
// (84×3=252,留余量)。前端密集采样的导流区多边形可能超出,超了必须抽稀而不是让
// 整批证据被契约上限拒绝 —— 几十个点足以保持标注的视觉形状。
const MAX_POINTS_PER_FRAME = 84

/** 标注点数超限时等距抽稀(保留首尾):线/多边形形状在几十个点内不会失真。 */
function thinnedPoints (points: ReadonlyArray<{ x: number, y: number }>): ReadonlyArray<{ x: number, y: number }> {
  if (points.length <= MAX_POINTS_PER_FRAME) return points
  const out: Array<{ x: number, y: number }> = [points[0]!]
  const step = (points.length - 1) / (MAX_POINTS_PER_FRAME - 1)
  for (let i = 1; i < MAX_POINTS_PER_FRAME - 1; i++) {
    out.push(points[Math.round(i * step)]!)
  }
  out.push(points[points.length - 1]!)
  return out
}

/** 标注快照 → path:实线只描边,导流区(polygon)加半透明填充。 */
function annotationPathOf (snapshot: AnnotationSnapshot): VideoOverlayPath {
  return {
    type: snapshot.kind,
    points: thinnedPoints(snapshot.normalized_points),
    stroke: YELLOW_STROKE,
    ...(snapshot.kind === 'polygon' ? { fill: AREA_FILL } : {}),
  }
}

/** 帧墙钟时刻:毫秒精度 + 显式时区。时间会烧进图片像素,时区必须写在文字里,
 * 否则看图的人只能猜它按哪个时区解释。 */
export function formatFrameClock (wallClockMs: number): string {
  const offsetHours = tzOffsetHours()
  const date = new Date(wallClockMs + offsetHours * 3600 * 1000)
  const pad3 = (value: number): string => String(value).padStart(3, '0')
  return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate())
    + ' ' + pad2(date.getUTCHours()) + ':' + pad2(date.getUTCMinutes()) + ':' + pad2(date.getUTCSeconds())
    + '.' + pad3(date.getUTCMilliseconds()) + ' UTC+' + pad2(offsetHours) + ':00'
}

/**
 * 一组证据帧 → 与抽帧计划等长的 overlay 数组。每帧用自己的 bbox 与自己的时刻,
 * 标签写角色/实际帧墙钟时间/obj_id —— 三张图必须能从标签直接分清先后与目标。
 * bbox 过 clampedBox 裁到画幅内:worker 契约拒绝出画的框,而贴边目标的检测框天然越界。
 */
export function evidenceOverlays (
  snapshot: AnnotationSnapshot,
  frames: EvidenceFrameSet,
  startWallClockMs: number,
  objectId: string,
): readonly VideoFrameOverlay[] {
  return EVIDENCE_FRAME_ROLES.map(role => {
    const sample = frames[role]
    return {
      paths: [annotationPathOf(snapshot)],
      boxes: [{
        ...clampedBox(sample),
        stroke: TARGET_STROKE,
        label: EVIDENCE_ROLE_TEXT[role] + ' | '
          + formatFrameClock(startWallClockMs + sample.offsetMs)
          + ' | obj_id: ' + objectId,
      }],
    }
  })
}
