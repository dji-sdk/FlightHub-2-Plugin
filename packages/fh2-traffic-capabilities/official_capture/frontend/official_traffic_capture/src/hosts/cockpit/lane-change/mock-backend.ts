// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { AnnotationSnapshotDto, LaneChangeApi, LaneChangeEvent, LaneChangePostStatus } from './api'

interface StoredLaneEvent extends LaneChangeEvent {
  readonly annotationSnapshot: AnnotationSnapshotDto;
}

export interface MockLaneChangeBackend {
  readonly api: LaneChangeApi;
  dispose(): void;
}

export function createMockLaneChangeBackend (options: {
  readonly now: () => number;
}): MockLaneChangeBackend {
  const modes = new Map<string, { projectId: string; dockSn: string; flightId: string }>()
  const events = new Map<string, StoredLaneEvent>()
  const eventIdsByKey = new Map<string, string>()
  let eventSequence = 0

  return {
    api: {
      async startMode ({ projectId, dockSn, flightId }) {
        modes.set(`${projectId}:${dockSn}`, { projectId, dockSn, flightId })
        return { isActive: true, flightId }
      },
      async stopMode ({ projectId, dockSn }) {
        const flightId = modes.get(`${projectId}:${dockSn}`)?.flightId ?? ''
        modes.delete(`${projectId}:${dockSn}`)
        return { isActive: false, flightId }
      },
      async getMode ({ projectId, dockSn }) {
        const mode = modes.get(`${projectId}:${dockSn}`)
        return { isActive: mode !== undefined, flightId: mode?.flightId ?? '' }
      },
      async createEvent (input) {
        const existingId = eventIdsByKey.get(input.eventKey)
        if (existingId) {
          const existing = events.get(existingId)!
          return {
            eventId: existing.eventId,
            eventKey: existing.eventKey,
            postStatus: existing.postStatus,
            createdAt: existing.createdAt,
            created: false,
          }
        }
        const eventId = `event-${++eventSequence}`
        const createdAt = new Date(options.now()).toISOString()
        const event: StoredLaneEvent = {
          eventId,
          eventKey: input.eventKey,
          projectId: input.projectId,
          dockSn: input.dockSn,
          flightId: input.flightId,
          objId: input.objId,
          collisionType: input.collisionType,
          crossedAt: input.crossedAt,
          postStatus: 'pending_video' as LaneChangePostStatus,
          rejectReason: '',
          failureReason: '',
          createdAt,
          annotationSnapshot: input.annotationSnapshot,
        }
        events.set(eventId, event)
        eventIdsByKey.set(input.eventKey, eventId)
        return { eventId, eventKey: input.eventKey, postStatus: event.postStatus, createdAt, created: true }
      },
      async listEvents ({ projectId, flightId, page, pageSize }) {
        const matching = [...events.values()]
          .filter(item => item.projectId === projectId && item.flightId === flightId)
          .sort((left, right) => right.crossedAt - left.crossedAt)
        return {
          total: matching.length,
          events: matching.slice((page - 1) * pageSize, page * pageSize),
        }
      },
    },
    dispose () {
      modes.clear()
      events.clear()
      eventIdsByKey.clear()
    },
  }
}
