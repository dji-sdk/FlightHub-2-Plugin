// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { JsonValue } from 'fh2-plugin-sdk'
import type { PluginInvoke } from '../../../shared/api/invoke'
import { recordOf, requiredList, requiredNumber, requiredString, text } from '../../../shared/api/api-response'

export type IllegalRoadCloseReason = '' | 'manual' | 'timeout' | 'superseded' | 'session_stopped'
export type IllegalRoadSessionStatus = 'active' | 'stopped' | 'failed'
export type TrackingMediaLens = 'wide' | 'zoom' | 'unknown'

export interface IllegalRoadOpenTracking {
  readonly trackingId: string;
  readonly startedAt: number;
  readonly matchEndAt: number;
}

export interface IllegalRoadStatus {
  readonly isActive: boolean;
  readonly sessionId: string;
  readonly projectId: string;
  readonly dockSn: string;
  readonly flightId: string;
  readonly startedAt: number;
  readonly trackingCount: number;
  readonly openTracking: IllegalRoadOpenTracking | null;
}

export interface IllegalRoadSessionStart {
  readonly isActive: true;
  readonly sessionId: string;
  readonly projectId: string;
  readonly dockSn: string;
  readonly flightId: string;
  readonly startedAt: number;
  readonly resumed: boolean;
}

export interface IllegalRoadSessionSummary {
  readonly sessionId: string;
  readonly status: IllegalRoadSessionStatus;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly trackingCount: number;
}

export interface IllegalRoadLatestPhoto {
  readonly fileId: number;
  readonly previewUrl: string;
  readonly originalUrl: string;
  readonly photoTimeMs: number;
}

export interface IllegalRoadTracking {
  readonly id: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly dockSn: string;
  readonly flightId: string;
  readonly status: 'open' | 'closed';
  readonly startedAt: number;
  readonly endedAt: number;
  readonly closeReason: IllegalRoadCloseReason;
  readonly folderId: number;
  readonly parentFolderId: number;
  readonly latestPhoto: IllegalRoadLatestPhoto | null;
}

export interface TrackingMedia {
  readonly id: string;
  readonly fileId: number;
  readonly fileName: string;
  readonly previewUrl: string;
  readonly originalUrl: string;
  readonly capturedAtMs: number;
  readonly mediaType: 'photo' | 'video';
  readonly lens: TrackingMediaLens;
  readonly size: number;
  readonly durationMs: number;
}

export interface IllegalRoadApi {
  startSession(input: { projectId: string; dockSn: string; flightId: string }): Promise<IllegalRoadSessionStart>;
  stopSession(input: { sessionId: string; endedAt: number }): Promise<{ sessionId: string; stoppedAt: number; closedTrackingIds: readonly string[] }>;
  getStatus(input: { projectId: string; dockSn: string; flightId?: string }): Promise<IllegalRoadStatus>;
  startTracking(input: { sessionId: string; startedAt: number }): Promise<{ trackingId: string; sessionId: string; startedAt: number; matchEndAt: number; supersededTrackingId: string }>;
  stopTracking(input: { trackingId: string; endedAt: number }): Promise<{ trackingId: string; startedAt: number; endedAt: number; closeReason: Exclude<IllegalRoadCloseReason, ''>; mediaCount: number }>;
  listTrackings(input: { projectId: string; flightId: string; sessionId?: string; page: number; pageSize: number }): Promise<{ total: number; session: IllegalRoadSessionSummary | null; trackings: readonly IllegalRoadTracking[] }>;
  listMedia(input: { trackingId: string; page: number; pageSize: number }): Promise<{ total: number; folderId: number; media: readonly TrackingMedia[] }>;
}

export function createIllegalRoadApi (invoke: PluginInvoke): IllegalRoadApi {
  return {
    async startSession ({ projectId, dockSn, flightId }) {
      const payload = recordOf(await invoke('h_illegalRoad_startSession', { project_id: projectId, dock_sn: dockSn, flight_id: flightId }))
      if (!requiredBoolean(payload.is_active, 'is_active')) throw new Error('start-session 响应状态非法')
      return {
        isActive: true,
        sessionId: requiredString(payload.session_id, 'session_id'),
        projectId: requiredString(payload.project_id, 'project_id'),
        dockSn: requiredString(payload.dock_sn, 'dock_sn'),
        flightId: requiredString(payload.flight_id, 'flight_id'),
        startedAt: requiredNumber(payload.started_at, 'started_at'),
        resumed: requiredBoolean(payload.resumed, 'resumed'),
      }
    },
    async stopSession ({ sessionId, endedAt }) {
      const payload = recordOf(await invoke('h_illegalRoad_stopSession', { session_id: sessionId, ended_at: endedAt }))
      if (requiredBoolean(payload.is_active, 'is_active')) throw new Error('stop-session 响应状态非法')
      return {
        sessionId: requiredString(payload.session_id, 'session_id'),
        stoppedAt: requiredNumber(payload.stopped_at, 'stopped_at'),
        closedTrackingIds: requiredList(payload.closed_tracking_ids, 'closed_tracking_ids').map((item, index) => requiredString(item, `closed_tracking_ids[${index}]`)),
      }
    },
    async getStatus ({ projectId, dockSn, flightId }) {
      return parseStatus(await invoke('h_illegalRoad_getStatus', {
        project_id: projectId,
        dock_sn: dockSn,
        ...(flightId ? { flight_id: flightId } : {}),
      }))
    },
    async startTracking ({ sessionId, startedAt }) {
      const payload = recordOf(await invoke('h_illegalRoad_startTracking', { session_id: sessionId, started_at: startedAt }))
      if (requiredString(payload.status, 'status') !== 'open') throw new Error('start-tracking 响应状态非法')
      return {
        trackingId: requiredString(payload.tracking_id, 'tracking_id'),
        sessionId: requiredString(payload.session_id, 'session_id'),
        startedAt: requiredNumber(payload.started_at, 'started_at'),
        matchEndAt: requiredNumber(payload.match_end_at, 'match_end_at'),
        supersededTrackingId: text(payload.superseded_tracking_id),
      }
    },
    async stopTracking ({ trackingId, endedAt }) {
      const payload = recordOf(await invoke('h_illegalRoad_stopTracking', { tracking_id: trackingId, ended_at: endedAt }))
      if (requiredString(payload.status, 'status') !== 'closed') throw new Error('stop-tracking 响应状态非法')
      const closeReason = closeReasonOf(payload.close_reason)
      if (closeReason === '') throw new Error('stop-tracking close_reason 非法')
      return {
        trackingId: requiredString(payload.tracking_id, 'tracking_id'),
        startedAt: requiredNumber(payload.started_at, 'started_at'),
        endedAt: requiredNumber(payload.ended_at, 'ended_at'),
        closeReason,
        mediaCount: requiredNumber(payload.media_count, 'media_count'),
      }
    },
    async listTrackings ({ projectId, flightId, sessionId, page, pageSize }) {
      const payload = recordOf(await invoke('h_illegalRoad_listTrackings', {
        project_id: projectId,
        flight_id: flightId,
        ...(sessionId ? { session_id: sessionId } : {}),
        page,
        page_size: pageSize,
      }))
      requiredNumber(payload.page, 'page')
      requiredNumber(payload.page_size, 'page_size')
      return {
        total: requiredNumber(payload.total, 'total'),
        session: payload.session === null ? null : parseSessionSummary(payload.session),
        trackings: requiredList(payload.trackings, 'trackings').map(parseTracking),
      }
    },
    async listMedia ({ trackingId, page, pageSize }) {
      const payload = recordOf(await invoke('h_illegalRoad_listMedia', { tracking_id: trackingId, page, page_size: pageSize }))
      requiredNumber(payload.page, 'page')
      requiredNumber(payload.page_size, 'page_size')
      return {
        total: requiredNumber(payload.total, 'total'),
        folderId: requiredNumber(payload.folder_id, 'folder_id'),
        media: requiredList(payload.media, 'media').map(parseMedia),
      }
    },
  }
}

function requiredBoolean (value: JsonValue | undefined, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`接口字段缺失：${field}`)
  return value
}

function parseStatus (value: JsonValue): IllegalRoadStatus {
  const payload = recordOf(value)
  return {
    isActive: requiredBoolean(payload.is_active, 'is_active'),
    sessionId: text(payload.session_id),
    projectId: requiredString(payload.project_id, 'project_id'),
    dockSn: requiredString(payload.dock_sn, 'dock_sn'),
    flightId: text(payload.flight_id),
    startedAt: requiredNumber(payload.started_at, 'started_at'),
    trackingCount: requiredNumber(payload.tracking_count, 'tracking_count'),
    openTracking: payload.open_tracking === null ? null : parseOpenTracking(payload.open_tracking),
  }
}

function parseOpenTracking (value: JsonValue | undefined): IllegalRoadOpenTracking {
  const payload = recordOf(value)
  return {
    trackingId: requiredString(payload.tracking_id, 'open_tracking.tracking_id'),
    startedAt: requiredNumber(payload.started_at, 'open_tracking.started_at'),
    matchEndAt: requiredNumber(payload.match_end_at, 'open_tracking.match_end_at'),
  }
}

function parseSessionSummary (value: JsonValue | undefined): IllegalRoadSessionSummary {
  const payload = recordOf(value)
  const status = requiredString(payload.status, 'session.status')
  if (status !== 'active' && status !== 'stopped' && status !== 'failed') throw new Error(`session.status 非法：${status}`)
  return {
    sessionId: requiredString(payload.session_id, 'session.session_id'),
    status,
    startedAt: requiredNumber(payload.started_at, 'session.started_at'),
    endedAt: requiredNumber(payload.ended_at, 'session.ended_at'),
    trackingCount: requiredNumber(payload.tracking_count, 'session.tracking_count'),
  }
}

function parseTracking (value: JsonValue): IllegalRoadTracking {
  const payload = recordOf(value)
  const status = requiredString(payload.status, 'trackings.status')
  if (status !== 'open' && status !== 'closed') throw new Error(`trackings.status 非法：${status}`)
  if (requiredString(payload.scene, 'trackings.scene') !== 'illegal_road') throw new Error('trackings.scene 非法')
  return {
    id: requiredString(payload.id, 'trackings.id'),
    sessionId: requiredString(payload.session_id, 'trackings.session_id'),
    projectId: requiredString(payload.project_id, 'trackings.project_id'),
    dockSn: requiredString(payload.dock_sn, 'trackings.dock_sn'),
    flightId: requiredString(payload.flight_id, 'trackings.flight_id'),
    status,
    startedAt: requiredNumber(payload.started_at, 'trackings.started_at'),
    endedAt: requiredNumber(payload.ended_at, 'trackings.ended_at'),
    closeReason: closeReasonOf(payload.close_reason),
    folderId: requiredNumber(payload.folder_id, 'trackings.folder_id'),
    parentFolderId: requiredNumber(payload.parent_folder_id, 'trackings.parent_folder_id'),
    latestPhoto: payload.latest_photo === null ? null : parseLatestPhoto(payload.latest_photo),
  }
}

function parseLatestPhoto (value: JsonValue | undefined): IllegalRoadLatestPhoto {
  const payload = recordOf(value)
  return {
    fileId: requiredNumber(payload.file_id, 'latest_photo.file_id'),
    previewUrl: text(payload.preview_url),
    originalUrl: text(payload.original_url),
    photoTimeMs: requiredNumber(payload.photo_time_ms, 'latest_photo.photo_time_ms'),
  }
}

function parseMedia (value: JsonValue): TrackingMedia {
  const payload = recordOf(value)
  const mediaType = requiredString(payload.media_type, 'media.media_type')
  if (mediaType !== 'photo' && mediaType !== 'video') throw new Error(`media.media_type 非法：${mediaType}`)
  return {
    id: requiredString(payload.id, 'media.id'),
    fileId: requiredNumber(payload.file_id, 'media.file_id'),
    fileName: requiredString(payload.file_name, 'media.file_name'),
    previewUrl: text(payload.preview_url),
    originalUrl: text(payload.original_url),
    capturedAtMs: requiredNumber(payload.captured_at_ms, 'media.captured_at_ms'),
    mediaType,
    lens: mediaLensOf(payload.lens),
    size: requiredNumber(payload.size, 'media.size'),
    durationMs: requiredNumber(payload.duration_ms, 'media.duration_ms'),
  }
}

function closeReasonOf (value: JsonValue | undefined): IllegalRoadCloseReason {
  const reason = text(value)
  if (reason !== '' && reason !== 'manual' && reason !== 'timeout' && reason !== 'superseded' && reason !== 'session_stopped') {
    throw new Error(`close_reason 非法：${reason}`)
  }
  return reason
}

function mediaLensOf (value: JsonValue | undefined): TrackingMediaLens {
  const lens = requiredString(value, 'lens')
  if (lens !== 'wide' && lens !== 'zoom' && lens !== 'unknown') throw new Error(`lens 非法：${lens}`)
  return lens
}
