// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { queryStore, updateStoreRecord } from '../../shared/store'
import {
  fail,
  hasField,
  isTrue,
  numOr,
  optionalBoolean,
  requireText,
  waypointView,
} from '../../shared/teach'
import type { Input } from '../../shared/teach'
import type { StoreFields } from 'fh2-plugin-sdk/backend'

export function h_teach_updateWaypoint (input: Input): ReturnType<typeof waypointView> {
  const waypointId = requireText(input, 'waypoint_id')
  const patch: Partial<StoreFields> = {}
  const changed: string[] = []
  if (hasField(input, 'focal_length')) {
    if (typeof input.focal_length === 'boolean') fail('INVALID_ARGUMENT', 'focal_length 不是一个有效数字')
    const focalLength = Number(input.focal_length)
    if (!Number.isFinite(focalLength)) fail('INVALID_ARGUMENT', 'focal_length 不是一个有效数字')
    if (focalLength <= 0) fail('INVALID_ARGUMENT', 'focal_length 必须大于 0')
    patch.focal_length = String(focalLength)
    changed.push('focal_length')
  }
  if (hasField(input, 'selected')) {
    patch.selected = optionalBoolean(input, 'selected') ? 'true' : 'false'
    changed.push('selected')
  }
  if (changed.length === 0) {
    fail('INVALID_ARGUMENT', 'focal_length / selected 至少要传一个(位置与姿态是实测值,不可改;速度是路线级的,走 update-route)')
  }
  if (updateStoreRecord('teach_waypoint', { id: { eq: waypointId } }, patch) === 0) {
    fail('NOT_FOUND', `航点不存在(waypoint_id=${waypointId})`)
  }
  const waypoint = queryStore('teach_waypoint', { id: { eq: waypointId } }, { limit: 1 }).list[0]
  if (waypoint === undefined) fail('NOT_FOUND', `航点已被删除(waypoint_id=${waypointId})`)
  log.info('更新航点', {
    waypoint_id: waypointId,
    teach_route_id: String(waypoint.teach_route_id || ''),
    seq: numOr(waypoint.seq, -1),
    changed: changed.join(','),
    focal_length: numOr(waypoint.focal_length, 0),
    selected: isTrue(waypoint.selected),
  })
  return waypointView(waypoint)
}
