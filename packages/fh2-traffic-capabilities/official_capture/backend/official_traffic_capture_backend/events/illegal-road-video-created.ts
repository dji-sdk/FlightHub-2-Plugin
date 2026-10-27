// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createStoreRecord } from '../shared/store'
import { StoredMediaType } from '../shared/media'
import {
  archiveMediaToFolder,
  isUsableVideoSubType,
  matchVideoTrackings,
  mediaKeyOf,
  notifyMediaAdded,
} from '../shared/illegal-road'
import { msText } from '../shared/time'
import type { EventCtx } from 'fh2-plugin-sdk/backend'

interface IllegalRoadVideoCreatedPayload {
  readonly file_id?: unknown
  readonly device_sn?: unknown
  readonly workspace_id?: unknown
  readonly flight_id?: unknown
  readonly sub_file_type?: unknown
  readonly video_create_time_ms?: unknown
  readonly duration_sec?: unknown
  readonly [key: string]: unknown
}

export function onIllegalRoadVideoCreated (input: IllegalRoadVideoCreatedPayload, ctx: EventCtx) {
  const fileId = String(input.file_id || '').trim()
  const dockSn = String(input.device_sn || '').trim()
  const projectId = String(input.workspace_id || '').trim()
  const flightId = String(input.flight_id || '').trim()
  const subType = String(input.sub_file_type === undefined || input.sub_file_type === null ? '' : input.sub_file_type)
  log.info('收到视频事件(行人上路)', {
    file_id: fileId,
    sub_file_type: subType,
    device_sn: dockSn,
    workspace_id: projectId,
    flight_id: flightId,
  })
  // This consumer must not reject a shared event that the lane-change consumer can process.
  if (!fileId || !dockSn || !projectId) return {}
  if (!isUsableVideoSubType(subType)) {
    log.warn('视频子类型不是普通视频，跳过行人上路关联', { file_id: fileId, sub_file_type: subType })
    return {}
  }
  const startMs = Math.floor(Number(input.video_create_time_ms) || 0)
  if (startMs <= 0) {
    log.warn('视频没有拍摄时刻(video_create_time_ms=0)，放弃关联', { file_id: fileId, device_sn: dockSn })
    return {}
  }
  let durationMs = Math.floor((Number(input.duration_sec) || 0) * 1000)
  if (durationMs < 0) durationMs = 0
  const trackings = matchVideoTrackings(projectId, dockSn, flightId, startMs, durationMs)
  if (!trackings.length) return {}
  const nowMs = msText(Date.parse(ctx.now))
  let bound = 0
  const trackingIds: string[] = []
  let archived = false
  for (let index = 0; index < trackings.length; index++) {
    const tracking = trackings[index]!
    const result = createStoreRecord('illegal_road_media', {
      media_key: mediaKeyOf(tracking.id, fileId),
      tracking_id: tracking.id,
      session_id: tracking.session_id || '',
      project_id: projectId,
      file_id: fileId,
      media_type: StoredMediaType.Video,
      sub_file_type: subType,
      shot_at_ms: msText(startMs),
      bound_at_ms: nowMs,
    }, ['media_key'])
    if (!result.created) continue
    bound++
    trackingIds.push(tracking.id)
    if (!archived) {
      archived = true
      archiveMediaToFolder(projectId, tracking, fileId, StoredMediaType.Video, '', startMs)
    }
    notifyMediaAdded(projectId, tracking, fileId, dockSn, StoredMediaType.Video, result.record.id, '')
  }
  return { bound, tracking_ids: trackingIds }
}
