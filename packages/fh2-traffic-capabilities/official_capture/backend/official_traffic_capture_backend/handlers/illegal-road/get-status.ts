// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { countStore, queryStore } from '../../shared/store'
import { sessionView } from '../../shared/illegal-road'
import type { IllegalRoadSessionView } from '../../shared/illegal-road'
import { msNum } from '../../shared/time'
import { requireText } from '../../shared/validation'
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'

export interface GetStatusInput {
  readonly [key: string]: unknown
  readonly project_id?: string
  readonly dock_sn?: string
  readonly flight_id?: string | number | null
}

export interface GetStatusOpenTracking {
  readonly tracking_id: string
  readonly started_at: number
  readonly match_end_at: number
}

export interface GetStatusResult extends IllegalRoadSessionView {
  readonly tracking_count: number
  readonly open_tracking: GetStatusOpenTracking | null
}

export function getStatus (input: GetStatusInput, _ctx: HandlerCtx): GetStatusResult {
  const projectId = requireText(input, 'project_id')
  const dockSn = requireText(input, 'dock_sn')
  const flightId = String(input.flight_id === undefined || input.flight_id === null ? '' : input.flight_id).trim()
  const filter = {
    project_id: { eq: projectId },
    dock_sn: { eq: dockSn },
    status: { eq: 'active' },
    ...(flightId ? { flight_id: { eq: flightId } } : {}),
  }
  const sessionPage = queryStore('illegal_road_session', filter, {
    limit: 1,
    orderBy: [{ field: 'started_at_ms', dir: 'desc' }],
  })
  if (!sessionPage.list.length) {
    return {
      is_active: false,
      session_id: '',
      project_id: projectId,
      dock_sn: dockSn,
      flight_id: '',
      started_at: 0,
      tracking_count: 0,
      open_tracking: null,
    }
  }
  const session = sessionPage.list[0]!
  const open = queryStore('illegal_road_tracking', {
    project_id: { eq: projectId }, session_id: { eq: session.id }, status: { eq: 'open' },
  }, { limit: 1, orderBy: [{ field: 'started_at_ms', dir: 'desc' }] })
  const current = open.list.length
    ? {
        tracking_id: open.list[0]!.id,
        started_at: msNum(open.list[0]!.started_at_ms),
        match_end_at: msNum(open.list[0]!.ended_at_ms),
      }
    : null
  return {
    ...sessionView(session),
    tracking_count: countStore('illegal_road_tracking', {
      project_id: { eq: projectId }, session_id: { eq: session.id },
    }),
    open_tracking: current,
  }
}
