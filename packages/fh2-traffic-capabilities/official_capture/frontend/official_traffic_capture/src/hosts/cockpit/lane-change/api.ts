// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { JsonValue } from 'fh2-plugin-sdk'
import type { PluginInvoke } from '../../../shared/api/invoke'
import { recordOf, requiredList, requiredNumber, requiredString, text } from '../../../shared/api/api-response'

export type LaneChangeCollisionType = 'solid_line' | 'guide_area'
export type LaneChangePostStatus = 'pending_video' | 'waiting_artifacts' | 'processing' | 'verified' | 'rejected' | 'failed'

export interface AnnotationSnapshotDto {
  readonly name: string;
  readonly kind: 'line' | 'polygon';
  readonly normalized_points: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  readonly geo_points: ReadonlyArray<{ readonly lng: number; readonly lat: number; readonly height: number }>;
}

export interface LaneChangeEvent {
  readonly eventId: string;
  readonly eventKey: string;
  readonly projectId: string;
  readonly dockSn: string;
  readonly flightId: string;
  readonly objId: string;
  readonly collisionType: LaneChangeCollisionType;
  readonly crossedAt: number;
  readonly postStatus: LaneChangePostStatus;
  readonly rejectReason: string;
  readonly failureReason: string;
  readonly createdAt: string;
}

export interface LaneChangeApi {
  startMode(input: { projectId: string; dockSn: string; flightId: string }): Promise<{ isActive: true; flightId: string }>;
  stopMode(input: { projectId: string; dockSn: string }): Promise<{ isActive: false; flightId: string }>;
  getMode(input: { projectId: string; dockSn: string }): Promise<{ isActive: boolean; flightId: string }>;
  createEvent(input: {
    projectId: string;
    dockSn: string;
    flightId: string;
    eventKey: string;
    crossedAt: number;
    collisionType: LaneChangeCollisionType;
    objId: string;
    regionId: string;
    annotationId: string;
    annotationSnapshot: AnnotationSnapshotDto;
  }): Promise<{ eventId: string; eventKey: string; postStatus: LaneChangePostStatus; createdAt: string; created: boolean }>;
  listEvents(input: { projectId: string; flightId: string; page: number; pageSize: number }): Promise<{ total: number; events: readonly LaneChangeEvent[] }>;
}

export function createLaneChangeApi (invoke: PluginInvoke): LaneChangeApi {
  return {
    async startMode ({ projectId, dockSn, flightId }) {
      const mode = parseMode(await invoke('h_laneChange_startMode', { project_id: projectId, dock_sn: dockSn, flight_id: flightId }))
      if (!mode.isActive) throw new Error('start-mode 响应状态非法')
      return { ...mode, isActive: true }
    },
    async stopMode ({ projectId, dockSn }) {
      const mode = parseMode(await invoke('h_laneChange_stopMode', { project_id: projectId, dock_sn: dockSn }))
      if (mode.isActive) throw new Error('stop-mode 响应状态非法')
      return { ...mode, isActive: false }
    },
    async getMode ({ projectId, dockSn }) {
      return parseMode(await invoke('h_laneChange_getMode', { project_id: projectId, dock_sn: dockSn }))
    },
    async createEvent (input) {
      const payload = recordOf(await invoke('h_laneChange_createEvent', {
        project_id: input.projectId,
        dock_sn: input.dockSn,
        flight_id: input.flightId,
        event_key: input.eventKey,
        crossed_at: input.crossedAt,
        collision_type: input.collisionType,
        obj_id: input.objId,
        region_id: input.regionId,
        annotation_id: input.annotationId,
        annotation_snapshot: input.annotationSnapshot as unknown as JsonValue,
      }))
      return {
        eventId: requiredString(payload.event_id, 'event_id'),
        eventKey: requiredString(payload.event_key, 'event_key'),
        postStatus: postStatusOf(payload.post_status),
        createdAt: requiredString(payload.created_at, 'created_at'),
        created: requiredBoolean(payload.created, 'created'),
      }
    },
    async listEvents ({ projectId, flightId, page, pageSize }) {
      const payload = recordOf(await invoke('h_laneChange_listEvents', {
        project_id: projectId,
        flight_id: flightId,
        page,
        page_size: pageSize,
      }))
      requiredNumber(payload.page, 'page')
      requiredNumber(payload.page_size, 'page_size')
      return {
        total: requiredNumber(payload.total, 'total'),
        events: requiredList(payload.events, 'events').map(parseLaneChangeEvent),
      }
    },
  }
}

function requiredBoolean (value: JsonValue | undefined, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`接口字段缺失：${field}`)
  return value
}

function parseMode (value: JsonValue): { isActive: boolean; flightId: string } {
  const payload = recordOf(value)
  requiredString(payload.project_id, 'project_id')
  requiredString(payload.dock_sn, 'dock_sn')
  requiredNumber(payload.is_active ? payload.started_at : (payload.stopped_at ?? payload.started_at), 'mode timestamp')
  return { isActive: requiredBoolean(payload.is_active, 'is_active'), flightId: text(payload.flight_id) }
}

function postStatusOf (value: JsonValue | undefined): LaneChangePostStatus {
  const status = requiredString(value, 'post_status')
  if (!['pending_video', 'waiting_artifacts', 'processing', 'verified', 'rejected', 'failed'].includes(status)) {
    throw new Error(`post_status 非法：${status}`)
  }
  return status as LaneChangePostStatus
}

function collisionTypeOf (value: JsonValue | undefined): LaneChangeCollisionType {
  const type = requiredString(value, 'collision_type')
  if (type !== 'solid_line' && type !== 'guide_area') throw new Error(`collision_type 非法：${type}`)
  return type
}

function parseLaneChangeEvent (value: JsonValue): LaneChangeEvent {
  const payload = recordOf(value)
  return {
    eventId: requiredString(payload.event_id, 'event_id'),
    eventKey: requiredString(payload.event_key, 'event_key'),
    projectId: requiredString(payload.project_id, 'project_id'),
    dockSn: requiredString(payload.dock_sn, 'dock_sn'),
    flightId: requiredString(payload.flight_id, 'flight_id'),
    objId: requiredString(payload.obj_id, 'obj_id'),
    collisionType: collisionTypeOf(payload.collision_type),
    crossedAt: requiredNumber(payload.crossed_at, 'crossed_at'),
    postStatus: postStatusOf(payload.post_status),
    rejectReason: text(payload.reject_reason),
    failureReason: text(payload.failure_reason),
    createdAt: requiredString(payload.created_at, 'created_at'),
  }
}
