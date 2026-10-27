// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { queryStore } from '../../shared/store'
import {
  MAX_WAYPOINT_PAGES,
  STATUS_RECORDING,
  WAYPOINT_PAGE_SIZE,
  fetchWaypoints,
  requireText,
  routeView,
  text,
} from '../../shared/teach'
import type { Input } from '../../shared/teach'

export function h_teach_getRouteStatus (input: Input): { readonly teach_route: Record<string, unknown> | null } {
  const flightId = requireText(input, 'flight_id')
  const page = queryStore('teach_route', { recording_flight_id: { eq: flightId } }, { limit: 1 })
  const route = page.list[0]
  if (route === undefined) {
    log.info('示教状态查询:该架次没有录制中的航线', { flight_id: flightId })
    return { teach_route: null }
  }
  if (route.status !== STATUS_RECORDING) {
    log.warn('示教状态查询:锁列命中但 status 不是 recording', {
      flight_id: flightId,
      teach_route_id: route.id,
      status: text(route.status),
    })
  }
  const waypoints = fetchWaypoints(route.id)
  if (waypoints.truncated) {
    log.warn('示教状态查询:航点数超过上限,已截断', {
      teach_route_id: route.id,
      returned: waypoints.list.length,
      max_pages: MAX_WAYPOINT_PAGES,
      page_size: WAYPOINT_PAGE_SIZE,
    })
  }
  log.info('示教状态查询:命中录制中的航线', {
    flight_id: flightId,
    teach_route_id: route.id,
    waypoint_count: waypoints.list.length,
    truncated: waypoints.truncated,
  })
  return { teach_route: routeView(route, waypoints.list, waypoints.truncated) }
}
