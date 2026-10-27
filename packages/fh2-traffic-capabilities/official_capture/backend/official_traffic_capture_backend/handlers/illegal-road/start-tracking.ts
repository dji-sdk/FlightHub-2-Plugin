// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createStoreRecord, queryStore, updateStoreRecord } from '../../shared/store'
import { trackingCapMs, trackingKeyOf } from '../../shared/illegal-road'
import { msNum, msText } from '../../shared/time'
import { requireText } from '../../shared/validation'
import type { BusinessError } from '../../shared/validation'
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'

export interface StartTrackingInput {
  readonly [key: string]: unknown
  readonly session_id?: string
  readonly started_at?: string | number
}

export interface StartTrackingResult {
  readonly tracking_id: string
  readonly session_id: string
  readonly status: string
  readonly started_at: number
  readonly match_end_at: number
  readonly superseded_tracking_id: string
}

export function startTracking (input: StartTrackingInput, ctx: HandlerCtx): StartTrackingResult {
  const sessionId = requireText(input, 'session_id')
  const startedMs = msText(requireText(input, 'started_at'))
  const sessionPage = queryStore('illegal_road_session', { id: { eq: sessionId } }, { limit: 1 })
  if (!sessionPage.list.length) {
    throw { code: 'NOT_FOUND', message: '没有这条抓拍会话' } satisfies BusinessError
  }
  const session = sessionPage.list[0]!
  const projectId = session.project_id || ''
  if (session.status !== 'active') {
    throw { code: 'NOT_FOUND', message: '抓拍会话已结束，请重新开启会话' } satisfies BusinessError
  }
  const salt = String(ctx.idempotencyKey || '').trim() || startedMs
  const trackingKey = trackingKeyOf(projectId, sessionId, salt)
  const duplicate = queryStore('illegal_road_tracking', {
    project_id: { eq: projectId }, tracking_key: { eq: trackingKey },
  }, { limit: 1 })
  if (duplicate.list.length) {
    const record = duplicate.list[0]!
    return {
      tracking_id: record.id,
      session_id: record.session_id || sessionId,
      status: record.status || 'open',
      started_at: msNum(record.started_at_ms),
      match_end_at: msNum(record.ended_at_ms),
      superseded_tracking_id: '',
    }
  }

  const capCutoff = msText(msNum(startedMs) - trackingCapMs())
  const open = queryStore('illegal_road_tracking', {
    project_id: { eq: projectId }, session_id: { eq: sessionId }, status: { eq: 'open' },
  }, { limit: 1, orderBy: [{ field: 'started_at_ms', dir: 'desc' }] })
  const supersededId = open.list.length ? open.list[0]!.id : ''
  updateStoreRecord('illegal_road_tracking', {
    project_id: { eq: projectId }, session_id: { eq: sessionId }, status: { eq: 'open' },
    started_at_ms: { gte: capCutoff },
  }, { status: 'closed', ended_at_ms: startedMs, close_reason: 'superseded' })
  updateStoreRecord('illegal_road_tracking', {
    project_id: { eq: projectId }, session_id: { eq: sessionId }, status: { eq: 'open' },
    started_at_ms: { lt: capCutoff },
  }, { status: 'closed', close_reason: 'superseded' })
  // Archive IDs stay omitted so the asynchronous archive claim can match SQL NULL.
  const result = createStoreRecord('illegal_road_tracking', {
    tracking_key: trackingKey,
    session_id: sessionId,
    project_id: projectId,
    dock_sn: session.dock_sn || '',
    flight_id: session.flight_id || '',
    status: 'open',
    started_at_ms: startedMs,
    ended_at_ms: msText(msNum(startedMs) + trackingCapMs()),
    close_reason: '',
  }, ['tracking_key'])
  const record = result.record
  return {
    tracking_id: record.id,
    session_id: sessionId,
    status: record.status || 'open',
    started_at: msNum(record.started_at_ms),
    match_end_at: msNum(record.ended_at_ms),
    superseded_tracking_id: supersededId,
  }
}
