// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createStoreRecord } from '../../shared/store'
import {
  DEFAULT_GLOBAL_SPEED,
  DEFAULT_WAYPOINT_SPEED,
  STATUS_RECORDING,
  buildDefaultRouteName,
  fail,
  requireIdText,
} from '../../shared/teach'
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'
import type { Input } from '../../shared/teach'

export function h_teach_enterRoute (input: Input, ctx: HandlerCtx): Record<string, string> {
  const projectId = requireIdText(input, 'project_id')
  const flightId = requireIdText(input, 'flight_id')
  const dockSn = requireIdText(input, 'dock_sn')
  const droneSn = requireIdText(input, 'drone_sn')
  const result = createStoreRecord('teach_route', {
    project_id: projectId,
    name: buildDefaultRouteName(ctx.now),
    flight_id: flightId,
    dock_sn: dockSn,
    drone_sn: droneSn,
    status: STATUS_RECORDING,
    global_speed: String(DEFAULT_GLOBAL_SPEED),
    waypoint_speed: String(DEFAULT_WAYPOINT_SPEED),
    wayline_uuid: '',
    wayline_file_id: '',
    kmz_object_key: '',
    screenshot_bytes: '0',
    recording_flight_id: flightId,
  }, ['recording_flight_id'])

  if (!result.created) {
    fail(
      'CONFLICT',
      `该架次已有一条录制中的航线(flight_id=${flightId},teach_route_id=${result.record.id},名称「${result.record.name}」)，请调 teach.get-route-status 取回它继续录制`,
    )
  }
  return {
    teach_route_id: result.record.id,
    name: result.record.name || '',
    status: result.record.status || '',
  }
}
