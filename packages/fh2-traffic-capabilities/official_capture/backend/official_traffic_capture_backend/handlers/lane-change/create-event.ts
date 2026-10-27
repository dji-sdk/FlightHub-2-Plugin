// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createStoreRecord } from '../../shared/store'
import { snapshotText } from '../../shared/lane-change'
import { msNum, msText } from '../../shared/time'
import { requireText } from '../../shared/validation'
import type { BusinessError } from '../../shared/validation'
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'

export interface CreateEventInput {
  readonly [key: string]: unknown
  readonly project_id?: string
  readonly dock_sn?: string
  readonly flight_id?: string
  readonly event_key?: string
  readonly collision_type?: string
  readonly obj_id?: string
  readonly region_id?: string
  readonly crossed_at: string | number
  readonly annotation_id?: string | number | null
  readonly annotation_snapshot?: unknown
}

export interface CreateEventResult {
  readonly event_id: string
  readonly event_key: string
  readonly post_status: string
  readonly created_at: string
  readonly created: boolean
}

export function createEvent (input: CreateEventInput, ctx: HandlerCtx): CreateEventResult {
  const projectId = requireText(input, 'project_id')
  const dockSn = requireText(input, 'dock_sn')
  const flightId = requireText(input, 'flight_id')
  const eventKey = requireText(input, 'event_key')
  const collisionType = requireText(input, 'collision_type')
  const objectId = requireText(input, 'obj_id')
  const regionId = requireText(input, 'region_id')
  if (collisionType !== 'solid_line' && collisionType !== 'guide_area') {
    throw { code: 'INVALID_ARGUMENT', message: 'collision_type 只能是 solid_line 或 guide_area' } satisfies BusinessError
  }
  const crossedAt = msText(input.crossed_at)
  if (msNum(crossedAt) <= 0) {
    throw { code: 'INVALID_ARGUMENT', message: 'crossed_at 必须是毫秒时间戳' } satisfies BusinessError
  }
  // Archive IDs stay omitted so the asynchronous archive claim can match SQL NULL.
  const result = createStoreRecord('lane_change_event', {
    event_key: eventKey,
    project_id: projectId,
    dock_sn: dockSn,
    flight_id: flightId,
    obj_id: objectId,
    region_id: regionId,
    annotation_id: String(input.annotation_id || ''),
    collision_type: collisionType,
    post_status: 'pending_video',
    crossed_at_ms: crossedAt,
    snapshot_json: snapshotText(input.annotation_snapshot),
    video_file_id: '',
    video_object_key: '',
    video_start_ms: '',
    video_end_ms: '',
    video_create_raw: '',
    reject_reason: '',
    failure_reason: '',
  }, ['event_key'])
  return {
    event_id: result.record.id,
    event_key: eventKey,
    post_status: result.record.post_status || 'pending_video',
    created_at: result.record.createdAt || ctx.now,
    created: result.created,
  }
}
