// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createStoreRecord } from '../../shared/store'
import { closeStaleSessions, sessionKeyOf, sessionView } from '../../shared/illegal-road'
import type { IllegalRoadSessionView } from '../../shared/illegal-road'
import { msText } from '../../shared/time'
import { requireText } from '../../shared/validation'
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'

export interface StartSessionInput {
  readonly [key: string]: unknown
  readonly project_id?: string
  readonly dock_sn?: string
  readonly flight_id?: string
}

export interface StartSessionResult extends IllegalRoadSessionView {
  readonly resumed: boolean
  readonly superseded_session_ids: string[]
}

export function startSession (input: StartSessionInput, ctx: HandlerCtx): StartSessionResult {
  const projectId = requireText(input, 'project_id')
  const dockSn = requireText(input, 'dock_sn')
  const flightId = requireText(input, 'flight_id')
  const nowMs = msText(Date.parse(ctx.now))
  const salt = String(ctx.idempotencyKey || '').trim() || nowMs
  const result = createStoreRecord('illegal_road_session', {
    session_key: sessionKeyOf(projectId, flightId, salt),
    project_id: projectId,
    dock_sn: dockSn,
    flight_id: flightId,
    status: 'active',
    started_at_ms: nowMs,
    stopped_at_ms: '',
  }, ['session_key'])
  const view = sessionView(result.record)
  const superseded = result.created
    ? closeStaleSessions(projectId, dockSn, view.session_id, nowMs)
    : []
  if (superseded.length) {
    log.info('开新会话时收尾了本机场的旧会话', {
      project_id: projectId,
      dock_sn: dockSn,
      flight_id: flightId,
      superseded: superseded.length,
    })
  }
  return { ...view, resumed: !result.created, superseded_session_ids: superseded }
}
