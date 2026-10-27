// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { countStore, deleteStoreRecords } from '../../shared/store'
import { fail, requireText, routeFor, text } from '../../shared/teach'
import type { Input } from '../../shared/teach'

export function h_teach_deleteRoute (input: Input): { readonly id: string; readonly deleted_waypoints: number } {
  const routeId = requireText(input, 'teach_route_id')
  const route = routeFor(routeId)
  const waypointCount = countStore('teach_waypoint', { teach_route_id: { eq: routeId } })
  const deletedRoute = deleteStoreRecords('teach_route', { id: { eq: routeId } })
  if (deletedRoute === 0) fail('NOT_FOUND', `航线不存在或已被删除(teach_route_id=${routeId})`)

  log.info('删除示教航线', {
    teach_route_id: routeId,
    name: text(route.name),
    status: text(route.status),
    flight_id: text(route.flight_id),
    deleted_waypoints: waypointCount,
    orphan_wayline_uuid: text(route.wayline_uuid),
    orphan_wayline_file_id: text(route.wayline_file_id),
    orphan_kmz_object_key: text(route.kmz_object_key),
  })
  const screenshotBytes = text(route.screenshot_bytes)
  if (screenshotBytes !== '' && screenshotBytes !== '0') {
    log.warn('删除示教航线:名下截图未对账(级联删拿不到航点的 screenshot_key)', {
      teach_route_id: routeId,
      screenshot_bytes: screenshotBytes,
      deleted_waypoints: waypointCount,
    })
  }
  return { id: routeId, deleted_waypoints: waypointCount }
}
