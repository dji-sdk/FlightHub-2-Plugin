// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { queryStore } from '../../shared/store'
import { eventView } from '../../shared/lane-change'
import type { LaneChangeEventView } from '../../shared/lane-change'
import { pageBounds } from '../../shared/pagination'
import { requireText } from '../../shared/validation'
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'

export interface ListEventsInput {
  readonly [key: string]: unknown
  readonly project_id?: string
  readonly flight_id?: string | number | null
  readonly collision_type?: string | number | null
  readonly post_status?: string | number | null
  readonly page?: number
  readonly page_size?: number
}

export interface ListEventsResult {
  readonly total: number
  readonly page: number
  readonly page_size: number
  readonly events: LaneChangeEventView[]
}

export function listEvents (input: ListEventsInput, _ctx: HandlerCtx): ListEventsResult {
  const projectId = requireText(input, 'project_id')
  const bounds = pageBounds(input, 20, 200)
  const filter = {
    project_id: { eq: projectId },
    ...(input.flight_id ? { flight_id: { eq: String(input.flight_id) } } : {}),
    ...(input.collision_type ? { collision_type: { eq: String(input.collision_type) } } : {}),
    ...(input.post_status ? { post_status: { eq: String(input.post_status) } } : {}),
  }
  const result = queryStore('lane_change_event', filter, {
    limit: bounds.size,
    offset: bounds.offset,
    orderBy: [{ field: 'crossed_at_ms', dir: 'desc' }],
  })
  const events: LaneChangeEventView[] = []
  for (let index = 0; index < result.list.length; index++) events.push(eventView(result.list[index]!))
  return { total: result.total, page: bounds.page, page_size: bounds.size, events }
}
