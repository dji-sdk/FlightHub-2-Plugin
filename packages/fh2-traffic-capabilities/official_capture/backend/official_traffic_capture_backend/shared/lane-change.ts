// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { msNum } from './time'
import type { BusinessError } from './validation'
import type { StoreRecord } from 'fh2-plugin-sdk/backend'

export interface AnnotationSnapshot {
  readonly kind: 'line' | 'polygon'
  readonly normalized_points: ReadonlyArray<{ readonly x: number, readonly y: number }>
  readonly [key: string]: unknown
}

type LaneChangeEventRecord = StoreRecord

export interface LaneChangeEventView {
  readonly event_id: string
  readonly event_key: string
  readonly project_id: string
  readonly dock_sn: string
  readonly flight_id: string
  readonly obj_id: string
  readonly collision_type: string
  readonly crossed_at: number
  readonly post_status: string
  readonly reject_reason: string
  readonly failure_reason: string
  readonly created_at: string
}

export function modeKeyOf (projectId: string, dockSn: string): string {
  return projectId + ':' + dockSn
}

export function snapshotText (snapshot: unknown): string {
  const value = snapshot as AnnotationSnapshot | null | undefined
  if (value === null || value === undefined || typeof value !== 'object') {
    throw { code: 'INVALID_ARGUMENT', message: 'annotation_snapshot 必须是对象' } satisfies BusinessError
  }
  if (value.kind !== 'line' && value.kind !== 'polygon') {
    throw { code: 'INVALID_ARGUMENT', message: 'annotation_snapshot.kind 只能是 line 或 polygon' } satisfies BusinessError
  }
  const points = value.normalized_points
  if (!points || !points.length) {
    throw { code: 'INVALID_ARGUMENT', message: 'annotation_snapshot.normalized_points 不能为空(后处理必需)' } satisfies BusinessError
  }
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!
    if (!(point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)) {
      throw { code: 'INVALID_ARGUMENT', message: 'normalized_points[' + index + '] 超出 [0,1]' } satisfies BusinessError
    }
  }
  const text = JSON.stringify(value)
  if (text.length > 32768) {
    throw { code: 'INVALID_ARGUMENT', message: 'annotation_snapshot 过大(' + text.length + ' 字节)，请减少 geo_points' } satisfies BusinessError
  }
  return text
}

export function eventView (record: LaneChangeEventRecord): LaneChangeEventView {
  return {
    event_id: record.id,
    event_key: record.event_key || '',
    project_id: record.project_id || '',
    dock_sn: record.dock_sn || '',
    flight_id: record.flight_id || '',
    obj_id: record.obj_id || '',
    collision_type: record.collision_type || '',
    crossed_at: msNum(record.crossed_at_ms),
    post_status: record.post_status || '',
    reject_reason: record.reject_reason || '',
    failure_reason: record.failure_reason || '',
    created_at: record.createdAt || '',
  }
}
