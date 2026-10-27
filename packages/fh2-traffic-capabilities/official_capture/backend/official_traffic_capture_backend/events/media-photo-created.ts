// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createStoreRecord } from '../shared/store'
import { StoredMediaType } from '../shared/media'
import {
  archiveMediaToFolder,
  isKnownPhotoSubType,
  isUsablePhotoSubType,
  matchPhotoTrackings,
  mediaKeyOf,
  notifyMediaAdded,
} from '../shared/illegal-road'
import { msText } from '../shared/time'
import type { EventCtx } from 'fh2-plugin-sdk/backend'

interface PhotoCreatedPayload {
  readonly file_id?: unknown
  readonly device_sn?: unknown
  readonly workspace_id?: unknown
  readonly flight_id?: unknown
  readonly sub_file_type?: unknown
  readonly photo_create_time_ms?: unknown
  readonly [key: string]: unknown
}

export function onPhotoCreated (input: PhotoCreatedPayload, ctx: EventCtx) {
  const fileId = String(input.file_id || '').trim()
  const dockSn = String(input.device_sn || '').trim()
  const projectId = String(input.workspace_id || '').trim()
  const flightId = String(input.flight_id || '').trim()
  const subType = String(input.sub_file_type === undefined || input.sub_file_type === null ? '' : input.sub_file_type)
  log.info('收到照片事件', {
    file_id: fileId,
    sub_file_type: subType,
    device_sn: dockSn,
    workspace_id: projectId,
    flight_id: flightId,
  })
  if (!fileId || !dockSn || !projectId) return {}
  if (!isKnownPhotoSubType(subType)) {
    log.warn('照片子类型不在已知值域(0..7)内，仍按可用处理', { file_id: fileId, sub_file_type: subType })
  }
  if (!isUsablePhotoSubType(subType)) return {}

  let shotMs = Math.floor(Number(input.photo_create_time_ms) || 0)
  if (shotMs < 0) shotMs = 0
  const trackings = matchPhotoTrackings(projectId, dockSn, flightId, shotMs)
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
      media_type: StoredMediaType.Photo,
      sub_file_type: subType,
      shot_at_ms: shotMs > 0 ? msText(shotMs) : '',
      bound_at_ms: nowMs,
    }, ['media_key'])
    if (!result.created) continue
    bound++
    trackingIds.push(tracking.id)
    if (!archived) {
      archived = true
      archiveMediaToFolder(projectId, tracking, fileId, StoredMediaType.Photo, subType, shotMs)
    }
    notifyMediaAdded(projectId, tracking, fileId, dockSn, StoredMediaType.Photo, result.record.id, subType)
  }
  return { bound, tracking_ids: trackingIds }
}
