// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { MAX_WAYPOINT_PAGES, WAYPOINT_PAGE_SIZE, fetchWaypoints, requireText, routeFor, routeView } from '../../shared/teach'
import type { Input } from '../../shared/teach'

export function h_teach_getRoute (input: Input): Record<string, unknown> {
  const routeId = requireText(input, 'teach_route_id')
  const route = routeFor(routeId)
  const waypoints = fetchWaypoints(routeId)
  if (waypoints.truncated) {
    log.warn('查航线详情:航点数超过上限,已截断', {
      teach_route_id: routeId,
      returned: waypoints.list.length,
      max_pages: MAX_WAYPOINT_PAGES,
      page_size: WAYPOINT_PAGE_SIZE,
    })
  }
  log.info('查航线详情', {
    teach_route_id: routeId,
    status: String(route.status || ''),
    waypoint_count: waypoints.list.length,
    truncated: waypoints.truncated,
  })
  return routeView(route, waypoints.list, waypoints.truncated)
}
