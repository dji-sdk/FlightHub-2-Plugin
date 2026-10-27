// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { deleteStoreRecords } from '../../shared/store'
import { fail, requireText, text, waypointFor } from '../../shared/teach'
import type { Input } from '../../shared/teach'

export function h_teach_deleteWaypoint (input: Input): { readonly id: string; readonly teach_route_id: string } {
  const waypointId = requireText(input, 'waypoint_id')
  const waypoint = waypointFor(waypointId)
  const routeId = text(waypoint.teach_route_id)
  if (deleteStoreRecords('teach_waypoint', { id: { eq: waypointId } }) === 0) {
    fail('NOT_FOUND', `航点不存在或已被删除(waypoint_id=${waypointId})`)
  }
  if (text(waypoint.screenshot_key) !== '') {
    log.warn('删除航点:截图对象成为孤儿(本插件不删对象存储)', {
      waypoint_id: waypointId,
      teach_route_id: routeId,
      orphan_screenshot_key: text(waypoint.screenshot_key),
    })
  }
  log.info('删除航点', {
    waypoint_id: waypointId,
    teach_route_id: routeId,
  })
  return { id: waypointId, teach_route_id: routeId }
}
