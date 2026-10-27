// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { queryStore, updateStoreRecord } from './store'
import { lensLabel, mediaTypeLabel } from './media'
import { msNum, msText, pad2, stampText, tzOffsetHours } from './time'
import type { Filter, MediaFileView, StoreRecord } from 'fh2-plugin-sdk/backend'

type IllegalRoadSessionRecord = StoreRecord
type IllegalRoadTrackingRecord = StoreRecord
type TrackingFilter = Filter<StoreRecord>

export function trackingCapMs (): number {
  return 30000
}

export function sessionKeyOf (projectId: string, flightId: string, salt: string): string {
  return projectId + ':' + flightId + ':' + salt
}

export function trackingKeyOf (projectId: string, sessionId: string, salt: string): string {
  return projectId + ':' + sessionId + ':' + salt
}

export interface IllegalRoadSessionView {
  readonly session_id: string
  readonly project_id: string
  readonly dock_sn: string
  readonly flight_id: string
  readonly is_active: boolean
  readonly started_at: number
}

export function sessionView (record: IllegalRoadSessionRecord): IllegalRoadSessionView {
  return {
    session_id: record.id,
    project_id: record.project_id || '',
    dock_sn: record.dock_sn || '',
    flight_id: record.flight_id || '',
    is_active: record.status === 'active',
    started_at: msNum(record.started_at_ms),
  }
}

export interface IllegalRoadTrackingView {
  readonly id: string
  readonly session_id: string
  readonly project_id: string
  readonly dock_sn: string
  readonly flight_id: string
  readonly scene: string
  readonly status: string
  readonly started_at: number
  readonly ended_at: number
}

export function trackingView (record: IllegalRoadTrackingRecord): IllegalRoadTrackingView {
  return {
    id: record.id,
    session_id: record.session_id || '',
    project_id: record.project_id || '',
    dock_sn: record.dock_sn || '',
    flight_id: record.flight_id || '',
    scene: 'illegal_road',
    status: record.status || '',
    started_at: msNum(record.started_at_ms),
    // Open rows contain a persisted matching-window upper bound, not an actual end time.
    ended_at: record.status === 'open' ? 0 : msNum(record.ended_at_ms),
  }
}

export function clampEnd (endMs: string, startedMs: string, kind: string, id: string): string {
  if (msNum(endMs) >= msNum(startedMs)) return endMs
  log.warn('结束时刻早于开始时刻，已钳到开始时刻', {
    kind: String(kind), id: String(id), ended_at: msNum(endMs), started_at: msNum(startedMs),
  })
  return startedMs
}

export function clampTrackingEnd (endMs: string, startedMs: string, trackingId: string): string {
  const started = msNum(startedMs)
  const cap = started + trackingCapMs()
  const supplied = msNum(endMs)
  if (supplied > started && supplied < cap) return msText(supplied)
  if (supplied > 0) {
    log.warn('结束时刻不在跟踪窗口内，已写成上限', {
      id: String(trackingId), ended_at: supplied, started_at: started, cap_at: cap,
    })
  }
  return msText(cap)
}

export function closeStaleSessions (projectId: string, dockSn: string, keepSessionId: string, nowMs: string): string[] {
  const stale = queryStore('illegal_road_session', {
    project_id: { eq: projectId }, dock_sn: { eq: dockSn }, status: { eq: 'active' },
  }, { orderBy: [{ field: 'started_at_ms', dir: 'asc' }] })
  const closed: string[] = []
  const capCutoff = msText(msNum(nowMs) - trackingCapMs())

  for (let index = 0; index < stale.list.length; index++) {
    const sessionId = stale.list[index]!.id
    if (sessionId === keepSessionId) continue

    updateStoreRecord('illegal_road_tracking', {
      project_id: { eq: projectId }, session_id: { eq: sessionId }, status: { eq: 'open' },
      started_at_ms: { gte: capCutoff },
    }, { status: 'closed', ended_at_ms: nowMs, close_reason: 'session_superseded' })
    updateStoreRecord('illegal_road_tracking', {
      project_id: { eq: projectId }, session_id: { eq: sessionId }, status: { eq: 'open' },
      started_at_ms: { lt: capCutoff },
    }, { status: 'closed', close_reason: 'session_superseded' })
    const affected = updateStoreRecord('illegal_road_session', {
      project_id: { eq: projectId }, id: { eq: sessionId }, status: { eq: 'active' },
    }, { status: 'stopped', stopped_at_ms: nowMs })
    if (affected > 0) closed.push(sessionId)
  }
  return closed
}

export function mediaKeyOf (trackingId: string, fileId: string): string {
  return String(trackingId) + ':' + String(fileId)
}

export function fanoutCap (): number {
  return 50
}

export function isUsableVideoSubType (subType: string): boolean {
  const value = String(subType)
  return value === '' || value === '0'
}

export function isUsablePhotoSubType (subType: string): boolean {
  return String(subType) !== '6'
}

export function isKnownPhotoSubType (subType: string): boolean {
  const value = String(subType)
  return value === '0' || value === '1' || value === '2' || value === '3'
    || value === '4' || value === '5' || value === '6' || value === '7'
}

export function matchPhotoTrackings (
  projectId: string,
  dockSn: string,
  flightId: string,
  shotMs: number,
): IllegalRoadTrackingRecord[] {
  const base: TrackingFilter = {
    project_id: { eq: projectId },
    dock_sn: { eq: dockSn },
  }
  if (shotMs <= 0) {
    const open = queryStore('illegal_road_tracking', {
      ...base,
      status: { eq: 'open' },
      ...(flightId ? { flight_id: { eq: flightId } } : {}),
    }, { limit: 1, orderBy: [{ field: 'started_at_ms', dir: 'desc' }] })
    if (open.list.length) {
      log.warn('照片没有拍摄时刻，退化为关联当前进行中的跟踪', {
        dock_sn: String(dockSn), tracking_id: open.list[0]!.id,
      })
    }
    return open.list
  }

  const ranged: TrackingFilter = {
    ...base,
    started_at_ms: { lte: msText(shotMs) },
    ended_at_ms: { gt: msText(shotMs) },
  }
  if (flightId) {
    const withFlight = queryStore('illegal_road_tracking', { ...ranged, flight_id: { eq: flightId } }, {
      limit: fanoutCap(), orderBy: [{ field: 'started_at_ms', dir: 'asc' }],
    })
    if (withFlight.list.length) return withFlight.list
  }
  const hit = queryStore('illegal_road_tracking', ranged, {
    limit: fanoutCap(), orderBy: [{ field: 'started_at_ms', dir: 'asc' }],
  })
  if (hit.list.length >= fanoutCap()) {
    log.warn('一张照片命中的跟踪条数撞到上限，可能有未处理重叠记录', { device_sn: dockSn, cap: fanoutCap() })
  }
  return hit.list
}

export function matchVideoTrackings (
  projectId: string,
  dockSn: string,
  flightId: string,
  startMs: number,
  durationMs: number,
): IllegalRoadTrackingRecord[] {
  const base: TrackingFilter = durationMs > 0
    ? {
        project_id: { eq: projectId },
        dock_sn: { eq: dockSn },
        started_at_ms: { lt: msText(startMs + durationMs) },
        ended_at_ms: { gt: msText(startMs) },
      }
    : {
        project_id: { eq: projectId },
        dock_sn: { eq: dockSn },
        started_at_ms: { lte: msText(startMs) },
        ended_at_ms: { gt: msText(startMs) },
      }
  if (flightId) {
    const withFlight = queryStore('illegal_road_tracking', { ...base, flight_id: { eq: flightId } }, {
      limit: fanoutCap(), orderBy: [{ field: 'started_at_ms', dir: 'asc' }],
    })
    if (withFlight.list.length) return withFlight.list
  }
  const hit = queryStore('illegal_road_tracking', base, {
    limit: fanoutCap(), orderBy: [{ field: 'started_at_ms', dir: 'asc' }],
  })
  if (hit.list.length >= fanoutCap()) {
    log.warn('一段视频命中的跟踪条数撞到上限，可能有未处理重叠记录', { device_sn: dockSn, cap: fanoutCap() })
  }
  return hit.list
}

export function notifyMediaAdded (
  projectId: string,
  tracking: IllegalRoadTrackingRecord,
  fileId: string,
  dockSn: string,
  mediaType: string | number,
  mediaId: string,
  subType: string,
): void {
  const result = notify.publish({
    channel: 'project',
    to: [projectId],
    bizCode: 'illegal_road_capture',
    subCode: 'media_added',
    data: {
      event: 'media_added',
      scene: 'illegal_road',
      session_id: tracking.session_id || '',
      tracking_id: tracking.id,
      media_id: String(mediaId || ''),
      file_id: Number(fileId || 0) || 0,
      media_type: mediaTypeLabel(mediaType),
      lens: mediaTypeLabel(mediaType) === 'photo' ? lensLabel(subType) : 'unknown',
      dock_sn: String(dockSn),
      flight_id: tracking.flight_id || '',
    },
  })
  if (result.skipped) log.warn('WS 未配置下游，前端只能靠轮询', { reason: String(result.skipReason || '') })
  else if (!result.delivered) log.warn('WS 投递失败(媒体已关联，不影响数据)', { reason: String(result.failReason || '') })
}

export function buildFolderName (startedAtMs: string | number): string {
  const value = Math.floor(Number(startedAtMs) || 0)
  if (value <= 0) return '行人上路-(时刻未知)'
  const date = new Date(value + tzOffsetHours() * 3600 * 1000)
  const stamp = date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate())
    + ' ' + pad2(date.getUTCHours()) + ':' + pad2(date.getUTCMinutes()) + ':' + pad2(date.getUTCSeconds())
    + ' (UTC+' + pad2(tzOffsetHours()) + ')'
  return '行人上路-' + stamp
}

export function mediaKindLabel (mediaType: string | number, subType: string): string {
  if (String(mediaType) === '2') return '视频'
  const lens = lensLabel(subType)
  if (lens === 'wide') return '远景图'
  if (lens === 'zoom') return '近景图'
  return '照片'
}

export function buildMediaFileName (mediaType: string | number, subType: string, stampMs: number): string {
  return '行人上路-' + mediaKindLabel(mediaType, subType) + '-' + stampText(stampMs)
}

export function ensureTrackingFolder (
  projectId: string,
  tracking: IllegalRoadTrackingRecord,
  flightFolderId: string,
): string {
  const name = buildFolderName(tracking.started_at_ms || '')
  const ensured = media.ensureFolder('illegal_road_tracking', tracking.id, name, flightFolderId, projectId)
  if (ensured.skipped) return ''
  let folderId = String(ensured.folderId || '').trim()
  if (ensured.created === false && folderId && isFolderOwnedByOtherTracking(projectId, folderId, tracking.id)) {
    log.warn('证据目录撞名且已被别的跟踪占用，改用带 trackingId 的目录名', {
      tracking_id: tracking.id, folder_id: folderId,
    })
    const retry = media.ensureFolder('illegal_road_tracking', tracking.id, name + ' #' + tracking.id, flightFolderId, projectId)
    if (retry.skipped) return ''
    folderId = String(retry.folderId || '').trim()
  }
  return folderId
}

function isFolderOwnedByOtherTracking (projectId: string, folderId: string, selfTrackingId: string): boolean {
  try {
    const page = queryStore('illegal_road_tracking', {
      project_id: { eq: projectId }, folder_id: { eq: folderId },
    }, { limit: 2 })
    for (let index = 0; index < page.list.length; index++) {
      if (page.list[index]!.id !== selfTrackingId) return true
    }
    return false
  } catch (error) {
    log.warn('查目录占用失败，按已被占用处理', {
      folder_id: folderId,
      tracking_id: selfTrackingId,
      err: String((error as { message?: string })?.message || error),
    })
    return true
  }
}

type MediaGetResult = MediaFileView & { skipped?: boolean }

export function archiveMediaToFolder (
  projectId: string,
  tracking: IllegalRoadTrackingRecord,
  fileId: string,
  mediaType: string | number,
  subType: string,
  stampMs: number,
): void {
  try {
    let folderId = String(tracking.folder_id || '').trim()
    if (!folderId) {
      const file = media.get(fileId, projectId) as MediaGetResult
      if (file.skipped) return
      const remoteControlId = String(file.parentId || '').trim()
      if (!remoteControlId || remoteControlId === '0') {
        log.warn('媒体文件没有父目录，放弃归档', { file_id: fileId, tracking_id: tracking.id })
        return
      }
      const remoteControl = media.get(remoteControlId, projectId) as MediaGetResult
      if (remoteControl.skipped) return
      let flightFolderId = String(remoteControl.parentId || '').trim()
      if (!flightFolderId || flightFolderId === '0') flightFolderId = remoteControlId
      folderId = ensureTrackingFolder(projectId, tracking, flightFolderId)
      if (!folderId) {
        log.warn('建目录没拿到 folderId，放弃归档', { tracking_id: tracking.id, file_id: fileId })
        return
      }
      updateStoreRecord('illegal_road_tracking', {
        id: { eq: tracking.id }, folder_id: { isNull: true },
      }, { folder_id: folderId, parent_folder_id: flightFolderId })
    }
    media.move(fileId, folderId, projectId)
    let stamp = Math.floor(Number(stampMs) || 0)
    if (stamp <= 0) stamp = msNum(tracking.started_at_ms)
    media.rename(fileId, buildMediaFileName(mediaType, subType, stamp), projectId)
  } catch (error) {
    log.warn('归档失败(媒体已关联，不影响数据)', {
      tracking_id: tracking.id,
      file_id: fileId,
      reason: String((error as { message?: string })?.message || error),
    })
  }
}
