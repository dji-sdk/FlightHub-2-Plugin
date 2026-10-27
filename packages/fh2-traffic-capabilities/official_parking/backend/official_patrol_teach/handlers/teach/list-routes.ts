// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { countStore, queryStore } from '../../shared/store'
import {
  STATUS_GENERATED,
  STATUS_RECORDING,
  fail,
  summaryView,
  text,
} from '../../shared/teach'
import type { Input } from '../../shared/teach'

function pageOf (input: Input): { readonly page: number; readonly size: number; readonly offset: number } {
  const page = Math.max(1, Math.floor(Number(input.page)) || 1)
  const requestedSize = Math.floor(Number(input.page_size))
  const size = Math.min(100, Number.isNaN(requestedSize) || requestedSize < 1 ? 20 : requestedSize)
  return { page, size, offset: (page - 1) * size }
}

export function h_teach_listRoutes (input: Input): Record<string, unknown> {
  const pagination = pageOf(input)
  const projectId = text(input.project_id).trim()
  const flightId = text(input.flight_id).trim()
  const status = text(input.status).trim()
  if (status !== '' && status !== STATUS_RECORDING && status !== STATUS_GENERATED) {
    fail('INVALID_ARGUMENT', `status 只能是 ${STATUS_RECORDING} / ${STATUS_GENERATED}(不传表示不按状态筛)`)
  }
  const filter: {
    project_id?: { readonly eq: string }
    flight_id?: { readonly eq: string }
    status?: { readonly eq: string }
  } = {}
  if (projectId !== '') filter.project_id = { eq: projectId }
  if (flightId !== '') filter.flight_id = { eq: flightId }
  if (status !== '') filter.status = { eq: status }
  const result = queryStore('teach_route', filter, {
    limit: pagination.size,
    offset: pagination.offset,
    orderBy: [{ field: 'id', dir: 'desc' }],
  })
  const list = result.list.map((route) => {
    const waypointCount = countStore('teach_waypoint', { teach_route_id: { eq: route.id } })
    return summaryView(route, waypointCount)
  })
  log.info('示教航线列表', {
    page: pagination.page,
    page_size: pagination.size,
    total: result.total,
    returned: list.length,
    count_queries: list.length,
    filtered_by_project: projectId !== '',
    filtered_by_status: status !== '',
  })
  return {
    pagination: { page: pagination.page, page_size: pagination.size, total: result.total },
    list,
  }
}
