// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { JsonValue } from 'fh2-plugin-sdk'
import { createPersonRoadEvidenceImageUrl } from '../../../shared/mock/evidence-images'
import type { IllegalRoadApi, IllegalRoadStatus, IllegalRoadTracking, TrackingMedia } from './api'

type MutableTracking = { -readonly [K in keyof IllegalRoadTracking]: IllegalRoadTracking[K] } & {
  media: TrackingMedia[];
  mediaCount: number;
}

export interface MockPersonRoadBackend {
  readonly api: IllegalRoadApi;
  dispose(): void;
}

export function createMockPersonRoadBackend (options: {
  readonly now: () => number;
  readonly mediaDelayMs: number;
  readonly schedule: (delayMs: number, callback: () => void) => void;
  readonly emit: (bizCode: string, subBizCode: string, data: JsonValue) => void;
}): MockPersonRoadBackend {
  const sessions = new Map<string, IllegalRoadStatus>()
  const trackings = new Map<string, MutableTracking>()
  let sessionSequence = 0
  let trackingSequence = 0

  const page = <T>(items: readonly T[], pageNumber: number, pageSize: number): readonly T[] => (
    items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize)
  )

  const attachMedia = (trackingId: string, phase: 'far' | 'near'): void => {
    const tracking = trackings.get(trackingId)
    if (!tracking) return
    const index = Number(trackingId.split('-').at(-1)) || 1
    const capturedAtMs = options.now()
    const url = createPersonRoadEvidenceImageUrl({ phase, index, capturedAt: capturedAtMs })
    const media: TrackingMedia = {
      id: `media-${trackingId}-${tracking.media.length + 1}`,
      fileId: 1_000 + index * 10 + tracking.media.length,
      fileName: `${phase}-${trackingId}.png`,
      previewUrl: url,
      originalUrl: url,
      capturedAtMs,
      mediaType: 'photo',
      lens: phase === 'far' ? 'wide' : 'zoom',
      size: 0,
      durationMs: 0,
    }
    tracking.media.push(media)
    tracking.mediaCount = tracking.media.length
    const latestPhoto = { fileId: media.fileId, previewUrl: url, originalUrl: url, photoTimeMs: capturedAtMs }
    tracking.latestPhoto = latestPhoto
    options.emit('illegal_road_capture', 'media_added', {
      event: 'media_added',
      scene: 'illegal_road',
      session_id: tracking.sessionId,
      tracking_id: trackingId,
      media_id: media.id,
      media_type: media.mediaType,
      lens: media.lens,
      dock_sn: tracking.dockSn,
      flight_id: tracking.flightId,
    })
  }

  return {
    api: {
      async startSession ({ projectId, dockSn, flightId }) {
        const existing = [...sessions.values()].find(item => item.isActive && item.projectId === projectId && item.dockSn === dockSn && item.flightId === flightId)
        if (existing) return { ...existing, isActive: true, resumed: true }
        const sessionId = `session-${++sessionSequence}`
        const session: IllegalRoadStatus = { isActive: true, sessionId, projectId, dockSn, flightId, startedAt: options.now(), trackingCount: 0, openTracking: null }
        sessions.set(sessionId, session)
        return { ...session, isActive: true, resumed: false }
      },
      async stopSession ({ sessionId, endedAt }) {
        const session = sessions.get(sessionId)
        if (!session) throw new Error('Mock: 行人抓拍会话不存在')
        const closedTrackingIds: string[] = []
        for (const tracking of trackings.values()) {
          if (tracking.sessionId === sessionId && tracking.status === 'open') {
            tracking.status = 'closed'
            tracking.endedAt = Math.min(endedAt, tracking.startedAt + 30_000)
            tracking.closeReason = 'session_stopped'
            closedTrackingIds.push(tracking.id)
          }
        }
        sessions.set(sessionId, { ...session, isActive: false, openTracking: null })
        return { sessionId, stoppedAt: endedAt, closedTrackingIds }
      },
      async getStatus ({ projectId, dockSn, flightId }) {
        const session = [...sessions.values()]
          .filter(item => item.projectId === projectId && (flightId ? item.flightId === flightId : item.dockSn === dockSn))
          .sort((left, right) => right.startedAt - left.startedAt)[0]
        if (!session?.isActive) return { isActive: false, sessionId: '', projectId, dockSn, flightId: '', startedAt: 0, trackingCount: 0, openTracking: null }
        const open = [...trackings.values()].find(item => item.sessionId === session.sessionId && item.status === 'open')
        return {
          ...session,
          trackingCount: [...trackings.values()].filter(item => item.sessionId === session.sessionId).length,
          openTracking: open ? { trackingId: open.id, startedAt: open.startedAt, matchEndAt: open.startedAt + 30_000 } : null,
        }
      },
      async startTracking ({ sessionId, startedAt }) {
        const session = sessions.get(sessionId)
        if (!session?.isActive) throw new Error('Mock: 行人抓拍会话不存在')
        let supersededTrackingId = ''
        for (const tracking of trackings.values()) {
          if (tracking.sessionId === sessionId && tracking.status === 'open') {
            tracking.status = 'closed'
            tracking.endedAt = Math.min(startedAt, tracking.startedAt + 30_000)
            tracking.closeReason = 'superseded'
            supersededTrackingId = tracking.id
          }
        }
        const trackingId = `tracking-${++trackingSequence}`
        trackings.set(trackingId, {
          id: trackingId,
          sessionId,
          projectId: session.projectId,
          dockSn: session.dockSn,
          flightId: session.flightId,
          status: 'open',
          startedAt,
          endedAt: 0,
          closeReason: '',
          mediaCount: 0,
          folderId: 2_000 + trackingSequence,
          parentFolderId: 2_000,
          latestPhoto: null,
          media: [],
        })
        sessions.set(sessionId, { ...session, trackingCount: session.trackingCount + 1, openTracking: { trackingId, startedAt, matchEndAt: startedAt + 30_000 } })
        options.schedule(options.mediaDelayMs, () => attachMedia(trackingId, 'far'))
        options.schedule(options.mediaDelayMs * 2, () => attachMedia(trackingId, 'near'))
        options.schedule(30_000, () => {
          const tracking = trackings.get(trackingId)
          if (!tracking || tracking.status !== 'open') return
          tracking.status = 'closed'
          tracking.endedAt = tracking.startedAt + 30_000
          tracking.closeReason = 'timeout'
        })
        return { trackingId, sessionId, startedAt, matchEndAt: startedAt + 30_000, supersededTrackingId }
      },
      async stopTracking ({ trackingId, endedAt }) {
        const tracking = trackings.get(trackingId)
        if (!tracking) throw new Error('Mock: 行人 Tracking 不存在')
        if (tracking.status === 'open') {
          tracking.status = 'closed'
          tracking.endedAt = Math.max(endedAt, tracking.startedAt)
          tracking.closeReason = 'manual'
        }
        return { trackingId, startedAt: tracking.startedAt, endedAt: tracking.endedAt, closeReason: tracking.closeReason || 'manual', mediaCount: tracking.mediaCount }
      },
      async listTrackings ({ projectId, flightId, page: pageNumber, pageSize }) {
        const items = [...trackings.values()]
          .filter(item => item.projectId === projectId && item.flightId === flightId)
          .sort((left, right) => right.startedAt - left.startedAt)
        const session = [...sessions.values()].find(item => item.projectId === projectId && item.flightId === flightId)
        return {
          total: items.length,
          session: session
            ? { sessionId: session.sessionId, status: session.isActive ? 'active' : 'stopped', startedAt: session.startedAt, endedAt: session.isActive ? 0 : options.now(), trackingCount: items.length }
            : null,
          trackings: page(items, pageNumber, pageSize),
        }
      },
      async listMedia ({ trackingId, page: pageNumber, pageSize }) {
        const tracking = trackings.get(trackingId)
        const media = tracking?.media ?? []
        return { total: media.length, folderId: tracking?.folderId ?? 0, media: page(media, pageNumber, pageSize) }
      },
    },
    dispose () {
      sessions.clear()
      trackings.clear()
    },
  }
}
