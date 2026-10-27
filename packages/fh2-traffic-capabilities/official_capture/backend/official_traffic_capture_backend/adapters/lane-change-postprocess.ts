// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createStoreRecord, queryStore, updateStoreRecord } from '../shared/store'
import { msNum, pad2, stampText, tzOffsetHours } from '../shared/time'
import {
  EVIDENCE_FRAME_INTERVAL_MS,
  EVIDENCE_FRAME_ROLES,
  EVIDENCE_ROLE_TEXT,
  evidenceOverlays,
  pickEvidenceFrames,
  usableSampleCount,
  type TrackSample,
} from '../shared/lane-change-evidence'
import type { AnnotationSnapshot } from '../shared/lane-change'
import type { BusinessError } from '../shared/validation'
import type { AdapterCtx, MediaFileView, MediaOwner, StoreRecord, VideoRef } from 'fh2-plugin-sdk/backend'

interface PostprocessInput {
  readonly event_id?: unknown
  readonly video_file_id?: unknown
  readonly video_object_key?: unknown
  readonly [key: string]: unknown
}

interface PostprocessResult {
  readonly event_id: string
  readonly post_status: string
  readonly reason: string
  readonly evidence_count: number
}

interface Point {
  readonly x: number
  readonly y: number
}

type VerifyResult =
  | { readonly verified: false, readonly reason: string }
  | { readonly verified: true, readonly reason: string, readonly crossedOffsetMs: number }

type LaneChangeEventRecord = StoreRecord
type MediaGetResult = MediaFileView & { readonly skipped?: boolean }

function hostProbe (ref: VideoRef) {
  return video.probe(ref)
}

function hostInspect (ref: VideoRef, window: { readonly rawStartMs: number, readonly rawEndMs: number }) {
  return objectTrack.inspect(ref, window)
}

function hostTrack (ref: VideoRef, objectId: string, fromMs: number, toMs: number, fps: number) {
  return objectTrack.getTrack({ fileId: ref.fileId, objectKey: ref.objectKey, objectId, fromMs, toMs, fps })
}

function segmentsIntersect (a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const cross = (origin: Point, p: Point, q: Point): number =>
    (p.x - origin.x) * (q.y - origin.y) - (p.y - origin.y) * (q.x - origin.x)
  const d1 = cross(b1, b2, a1)
  const d2 = cross(b1, b2, a2)
  const d3 = cross(a1, a2, b1)
  const d4 = cross(a1, a2, b2)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

function pointInPolygon (point: Point, polygon: readonly Point[]): boolean {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const current = polygon[index]!
    const before = polygon[previous]!
    if (((current.y > point.y) !== (before.y > point.y))
      && point.x < (before.x - current.x) * (point.y - current.y) / (before.y - current.y) + current.x) {
      inside = !inside
    }
  }
  return inside
}

// 违法复核:用目标的轨迹中心(归一化)对标注快照做几何判定 —— line 判跨线,
// polygon 判入区。它回答"这算不算违法",与"三张证据图怎么画"是两件事
// (后者见 shared/lane-change-evidence.ts)。
function verifyLaneChange (snapshot: AnnotationSnapshot, samples: readonly TrackSample[]): VerifyResult {
  if (samples.length < 2 || snapshot.normalized_points.length < 2) {
    return { verified: false, reason: '轨迹样本或标注坐标不足，无法判定' }
  }
  const centers = samples.map(sample => ({
    x: sample.x + sample.w / 2,
    y: sample.y + sample.h / 2,
    offsetMs: sample.offsetMs,
  }))
  let crossed = -1
  if (snapshot.kind === 'line') {
    for (let index = 1; index < centers.length && crossed < 0; index++) {
      for (let pointIndex = 1; pointIndex < snapshot.normalized_points.length; pointIndex++) {
        if (segmentsIntersect(centers[index - 1]!, centers[index]!, snapshot.normalized_points[pointIndex - 1]!, snapshot.normalized_points[pointIndex]!)) {
          crossed = centers[index]!.offsetMs
          break
        }
      }
    }
    if (crossed < 0) return { verified: false, reason: '轨迹未跨越标注实线' }
  } else {
    for (let index = 0; index < centers.length && crossed < 0; index++) {
      if (pointInPolygon(centers[index]!, snapshot.normalized_points)) crossed = centers[index]!.offsetMs
    }
    if (crossed < 0) return { verified: false, reason: '轨迹未进入导流区' }
  }
  return {
    verified: true,
    reason: snapshot.kind === 'line' ? '轨迹跨越标注实线' : '轨迹进入导流区',
    crossedOffsetMs: crossed,
  }
}

function collisionLabel (collisionType: string): string {
  return collisionType === 'guide_area' ? '导流区' : '实线变道'
}

function evidenceName (collisionType: string, role: string, crossedAtMs: number, extension: string): string {
  return collisionLabel(collisionType) + '-' + role + '-' + stampText(crossedAtMs) + extension
}

function evidenceFolderName (record: LaneChangeEventRecord): string {
  return collisionLabel(record.collision_type || '') + '-' + stampText(record.crossed_at_ms || '')
    + ' (UTC+' + pad2(tzOffsetHours()) + ') #' + record.id
}

function archiveEvidenceToFolder (record: LaneChangeEventRecord, fileIds: string[]): void {
  if (!fileIds.length) return
  try {
    const projectId = record.project_id || ''
    let folderId = record.folder_id || ''
    if (!folderId) {
      const source = media.get(fileIds[0]!, projectId) as MediaGetResult
      if (source.skipped) return
      const parentFolderId = String(source.parentId || '').trim()
      if (!parentFolderId || parentFolderId === '0') {
        log.warn('证据文件没有父目录，放弃归档', { event_id: record.id, file_id: fileIds[0]! })
        return
      }
      const ensured = media.ensureFolder('lane_change_event', record.id, evidenceFolderName(record), parentFolderId, projectId)
      if (ensured.skipped) return
      folderId = String(ensured.folderId || '').trim()
      if (!folderId) {
        log.warn('建目录没拿到 folderId，放弃归档', { event_id: record.id })
        return
      }
      updateStoreRecord('lane_change_event', {
        id: { eq: record.id }, folder_id: { isNull: true },
      }, { folder_id: folderId, parent_folder_id: parentFolderId })
    }
    let moved = 0
    for (let index = 0; index < fileIds.length; index++) {
      const result = media.move(fileIds[index]!, folderId, projectId)
      if (result.skipped) return
      if (result.moved) moved++
    }
    log.info('证据已归档', { event_id: record.id, folder_id: folderId, moved })
  } catch (error) {
    log.warn('归档失败(证据已生成，不影响数据)', {
      event_id: record.id,
      reason: String((error as { message?: unknown })?.message || error),
    })
  }
}

function fail (eventId: string, reason: string): PostprocessResult {
  // 失败也要留痕:worker 容器日志是测试环境唯一的排障入口(此前失败路径静默,
  // 表现是"流程 2 秒 succeeded、无任何日志、没有证据",无从定位)。
  log.error('变道后处理失败', { event_id: eventId, reason })
  updateStoreRecord('lane_change_event', { id: { eq: eventId } }, { post_status: 'failed', failure_reason: reason })
  return { event_id: eventId, post_status: 'failed', reason, evidence_count: 0 }
}

/**
 * 异常文案脱敏:上层异常可能带着请求体/响应体里的明文凭据(上游常把令牌回显在
 * msg 里),而 failure_reason 会随事件落库、被管理面看到。只留有限长度的摘要,
 * Bearer 令牌与常见凭据键值一律打码,控制字符与换行压成空格。
 */
function maskedErrorText (error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : (error !== null && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : '未知异常')
  return raw
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\b(Bearer)\s+\S+/gi, '$1 [已隐藏]')
    .replace(/((?:authorization|token|password|secret|api[-_]?key|credential)\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]')
    .replace(/([?&](?:authorization|token|password|secret|api[-_]?key|credential)=)[^&#\s]*/gi, '$1[已隐藏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
}

/**
 * 判异常是不是「sidecar 还没落桶」的暂态失败。
 *
 * 平台侧 objectTrack 对检测产物不存在固定抛「找不到 sidecar(候选:...)」。
 * MOT sidecar 由检测管线在视频回调**之后**才写出(2026-10-10 实测晚 41~97s,
 * 2026-10-08 实录晚约 5 分钟),所以这里按"等一等就会好"处理:原样抛出走作业
 * 重试,由 postprocess.json 声明的 maxAttempts 覆盖该窗口。收敛成 failed 会把
 * 一条本可成功的证据链错杀在产物落地前(2026-10-13 失败实录即此)。
 * 绑定侧已由 media-video-created 的 isVisibleLight 保证只绑 _V —— 检测管线
 * 对 _V 必产 sidecar,故"永远等不到"只剩检测彻底失败一种,届时重试耗尽、
 * 事件停在 processing 由人工介入,与 worker 参考实现口径一致。
 */
function isSidecarNotReady (error: unknown): boolean {
  const raw = error instanceof Error
    ? error.message
    : (error !== null && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : '')
  return raw.includes('找不到 sidecar')
}

/**
 * 异常兜底:后处理中途抛错时把事件收敛成 failed,并注明失败环节 —— 否则事件会永远
 * 卡在 processing,而视频回调不会再触发第二次。收敛本身再失败(比如存储也挂了)
 * 就重新抛出原始异常,让 Job 以错误结束、交给重试机制,而不是吞掉装成功。
 *
 * ⚠️ 边界:sidecar 未就绪(isSidecarNotReady)是暂态,不在此收敛 —— 见调用处。
 */
function settleFailure (eventId: string, stage: string, error: unknown): PostprocessResult {
  const reason = '后处理在' + stage + '阶段异常：' + maskedErrorText(error)
  try {
    const result = fail(eventId, reason)
    log.error('变道后处理异常，事件已标记失败', { event_id: eventId, reason })
    return result
  } catch (settleError) {
    log.error('变道后处理异常且状态收敛失败', {
      event_id: eventId,
      reason,
      settle_reason: maskedErrorText(settleError),
    })
    throw error
  }
}

function snapshotOf (text: string): AnnotationSnapshot | undefined {
  try {
    const value: unknown = JSON.parse(text || '{}')
    if (value === null || typeof value !== 'object') return undefined
    const candidate = value as { kind?: unknown, normalized_points?: unknown }
    if ((candidate.kind !== 'line' && candidate.kind !== 'polygon') || !Array.isArray(candidate.normalized_points)) return undefined
    return {
      kind: candidate.kind,
      normalized_points: candidate.normalized_points as ReadonlyArray<{ readonly x: number, readonly y: number }>,
    }
  } catch {
    return undefined
  }
}

export function handle (input: PostprocessInput, _ctx: AdapterCtx): PostprocessResult {
  const eventId = String(input.event_id || '')
  const videoFileId = String(input.video_file_id || '')
  const objectKey = String(input.video_object_key || '')
  const page = queryStore('lane_change_event', { id: { eq: eventId } }, { limit: 1 })
  if (!page.list.length) {
    throw { code: 'NOT_FOUND', message: '没有这条变道事件' } satisfies BusinessError
  }
  const record = page.list[0]!
  if (record.post_status === 'verified' || record.post_status === 'rejected' || record.post_status === 'failed') {
    log.info('变道事件已处理过，跳过', { event_id: eventId, post_status: record.post_status || '' })
    return { event_id: eventId, post_status: record.post_status || '', reason: '已处理过', evidence_count: 0 }
  }
  const moved = updateStoreRecord('lane_change_event', {
    id: { eq: eventId }, post_status: { eq: 'waiting_artifacts' },
  }, { post_status: 'processing' })
  if (moved === 0 && record.post_status !== 'processing') {
    return { event_id: eventId, post_status: record.post_status || '', reason: '状态已被推进', evidence_count: 0 }
  }
  try {
    return run(eventId, videoFileId, objectKey, record)
  } catch (error) {
    // 暂态放行、其余收敛:sidecar 未就绪抛回给作业重试(maxAttempts 覆盖落地窗口),
    // 非暂态失败才值得落终态 —— 两条路的理由分别见 isSidecarNotReady / settleFailure。
    if (isSidecarNotReady(error)) throw error
    return settleFailure(eventId, '证据生成', error)
  }
}

// run 是拿稳了事件状态之后的主体:从这里抛出的一切异常都由 handle 收敛为 failed。
// 各阶段的可预期失败(标注缺失、复核不过、选帧不足)直接落终态,不走异常。
function run (eventId: string, videoFileId: string, objectKey: string, record: LaneChangeEventRecord): PostprocessResult {
  const snapshot = snapshotOf(record.snapshot_json || '')
  if (snapshot === undefined || !snapshot.normalized_points.length) {
    return fail(eventId, '标注快照缺少归一化坐标')
  }

  const rawStart = msNum(record.video_start_ms)
  if (rawStart <= 0) return fail(eventId, '缺录制起点(video_start_ms)，无法把帧号换成墙钟')
  const ref: VideoRef = { fileId: videoFileId, objectKey }
  const info = hostProbe(ref)
  if (info.durationMs <= 0) return fail(eventId, 'probe 未解出视频时长，无法确定录制窗口')
  const timeline = hostInspect(ref, { rawStartMs: rawStart, rawEndMs: rawStart + info.durationMs })
  if (!timeline.startWallClockMs) return fail(eventId, 'sidecar 未解出视频起点时间，无法换算违法时刻')
  const center = msNum(record.crossed_at_ms) - timeline.startWallClockMs
  if (center < 0 || (timeline.durationMs > 0 && center > timeline.durationMs)) {
    log.warn('违法时刻落在视频之外，退回等待下一段视频', {
      event_id: eventId, crossed_at_ms: msNum(record.crossed_at_ms),
      video_start: timeline.startWallClockMs, video_duration_ms: timeline.durationMs,
    })
    updateStoreRecord('lane_change_event', { id: { eq: eventId } }, {
      post_status: 'pending_video',
      video_file_id: '',
      video_object_key: '',
      video_start_ms: '',
      video_end_ms: '',
      failure_reason: '违法时刻落在这段视频之外，已退回等待下一段视频',
    })
    return { event_id: eventId, post_status: 'pending_video', reason: '违法时刻落在这段视频之外', evidence_count: 0 }
  }

  // 轨迹搜索窗 ±15s 是"找越线点"的范围,与证据片窗口是两件事:轨迹窗窄了会把真违法
  // 漏判成 rejected,证据片窄了只是片子短。别当成同一个常量一起改。
  const track = hostTrack(ref, record.obj_id || '', Math.max(0, center - 15000), center + 15000, info.fps)
  const verified = verifyLaneChange(snapshot, track.samples)
  if (!verified.verified) {
    // rejected 是业务判定不是错误,但必须留痕 —— 此前静默,现场无从区分"没跑"与"判否"。
    log.warn('变道复核未通过，事件标记 rejected', {
      event_id: eventId, reason: verified.reason,
      samples: track.samples.length, usable: usableSampleCount(track.samples),
    })
    updateStoreRecord('lane_change_event', { id: { eq: eventId } }, { post_status: 'rejected', reject_reason: verified.reason })
    return { event_id: eventId, post_status: 'rejected', reason: verified.reason, evidence_count: 0 }
  }
  const frames = pickEvidenceFrames(verified.crossedOffsetMs, track.samples)
  if (frames === undefined) {
    // 诊断数字进日志不进 reason:管理面只需要结论,排障需要的是轨迹样本量与可用量。
    log.error('证据帧选择失败：轨迹中凑不齐前/中/后三个可用样本', {
      event_id: eventId, obj_id: record.obj_id || '',
      crossed_offset_ms: verified.crossedOffsetMs,
      samples: track.samples.length, usable: usableSampleCount(track.samples),
    })
    return fail(eventId, '目标轨迹不足，无法生成完整标注证据')
  }

  // 短轨迹允许偏离目标间隔,留实际时刻帮助现场区分选帧回退与抽帧错位。
  log.info('变道证据帧已选择', {
    event_id: eventId,
    target_interval_ms: EVIDENCE_FRAME_INTERVAL_MS,
    before_offset_ms: frames.before.offsetMs,
    violation_offset_ms: frames.violation.offsetMs,
    after_offset_ms: frames.after.offsetMs,
    before_interval_ms: frames.violation.offsetMs - frames.before.offsetMs,
    after_interval_ms: frames.after.offsetMs - frames.violation.offsetMs,
  })

  const owner: MediaOwner = {
    projectId: record.project_id || '',
    dockSn: record.dock_sn || '',
    flightId: record.flight_id || '',
  }
  const stamp = msNum(record.crossed_at_ms || '')
  // 三张图的抽帧时刻 = 各自选中样本的 offsetMs,与 overlay 数组严格等长 —— Worker 按
  // 下标把 overlay 烧进对应帧,错一位就是框画到别的帧上。
  const framePlan = EVIDENCE_FRAME_ROLES.map(role => frames[role].offsetMs)
  const frameNames = EVIDENCE_FRAME_ROLES.map(role => evidenceName(record.collision_type || '', EVIDENCE_ROLE_TEXT[role], stamp, '.jpeg'))
  const overlays = evidenceOverlays(snapshot, frames, timeline.startWallClockMs, record.obj_id || '')
  const extracted = video.extractFrames(ref, framePlan, owner, frameNames, overlays)
  // 证据片:违法时刻前后各 7.5 秒(共 15 秒,2026-09-16 规格定稿,见 worker 参考版
  // 58a12f7)。抽帧已经覆盖了前后证据,片子给人工复核看完整过程。
  const clip = video.createClip(
    ref,
    Math.max(0, verified.crossedOffsetMs - 7500),
    verified.crossedOffsetMs + 7500,
    owner,
    evidenceName(record.collision_type || '', '视频', stamp, '.mp4'),
  )

  const fileIds: string[] = []
  let saved = 0
  let skipped = 0
  EVIDENCE_FRAME_ROLES.forEach((role, index) => {
    const frame = extracted[index]
    if (frame === undefined || frame.skipped || !frame.fileId) {
      skipped++
      return
    }
    createStoreRecord('lane_change_evidence', {
      evidence_key: eventId + ':' + role,
      event_id: eventId,
      role,
      file_id: String(frame.fileId),
      at_ms: String(frame.atMs || 0),
    }, ['evidence_key'])
    fileIds.push(String(frame.fileId))
    saved++
  })
  if (clip.skipped || !clip.fileId) {
    skipped++
  } else {
    createStoreRecord('lane_change_evidence', {
      evidence_key: eventId + ':clip',
      event_id: eventId,
      role: 'clip',
      file_id: String(clip.fileId),
      at_ms: String(clip.actualStartMs || 0),
    }, ['evidence_key'])
    fileIds.push(String(clip.fileId))
    saved++
  }
  if (skipped > 0) return fail(eventId, '证据生成不完整(缺 ' + skipped + ' 份)')
  archiveEvidenceToFolder(record, fileIds)
  updateStoreRecord('lane_change_event', { id: { eq: eventId } }, {
    post_status: 'verified', reject_reason: '', failure_reason: '',
  })
  return { event_id: eventId, post_status: 'verified', reason: verified.reason, evidence_count: saved }
}
