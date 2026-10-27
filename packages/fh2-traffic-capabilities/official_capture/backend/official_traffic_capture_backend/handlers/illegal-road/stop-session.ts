// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { queryStore, updateStoreRecord } from '../../shared/store'
import { clampEnd, trackingCapMs } from '../../shared/illegal-road'
import { msNum, msText } from '../../shared/time'
import { requireText } from '../../shared/validation'
import type { BusinessError } from '../../shared/validation'
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'

export interface StopSessionInput {
  readonly [key: string]: unknown
  readonly session_id?: string
  readonly ended_at?: string | number | null
}

export interface StopSessionResult {
  readonly session_id: string
  readonly is_active: boolean
  readonly stopped_at: number
  readonly closed_tracking_ids: string[]
}

export function stopSession (input: StopSessionInput, ctx: HandlerCtx): StopSessionResult {
  const sessionId = requireText(input, 'session_id')
  const page = queryStore('illegal_road_session', { id: { eq: sessionId } }, { limit: 1 })
  if (!page.list.length) {
    throw { code: 'NOT_FOUND', message: '没有这条抓拍会话' } satisfies BusinessError
  }
  const session = page.list[0]!
  const projectId = session.project_id || ''
  let endMs = input.ended_at === undefined || input.ended_at === null || input.ended_at === ''
    ? msText(Date.parse(ctx.now))
    : msText(input.ended_at)
  endMs = clampEnd(endMs, session.started_at_ms || '', 'session', sessionId)

  const open = queryStore('illegal_road_tracking', {
    project_id: { eq: projectId }, session_id: { eq: sessionId }, status: { eq: 'open' },
  }, { orderBy: [{ field: 'started_at_ms', dir: 'asc' }] })
  const closedTrackingIds: string[] = []
  for (let index = 0; index < open.list.length; index++) closedTrackingIds.push(open.list[index]!.id)
  const capCutoff = msText(msNum(endMs) - trackingCapMs())
  updateStoreRecord('illegal_road_tracking', {
    project_id: { eq: projectId }, session_id: { eq: sessionId }, status: { eq: 'open' },
    started_at_ms: { gte: capCutoff },
  }, { status: 'closed', ended_at_ms: endMs, close_reason: 'session_stopped' })
  updateStoreRecord('illegal_road_tracking', {
    project_id: { eq: projectId }, session_id: { eq: sessionId }, status: { eq: 'open' },
    started_at_ms: { lt: capCutoff },
  }, { status: 'closed', close_reason: 'session_stopped' })
  const affected = updateStoreRecord('illegal_road_session', {
    project_id: { eq: projectId }, id: { eq: sessionId }, status: { eq: 'active' },
  }, { status: 'stopped', stopped_at_ms: endMs })
  if (affected === 0) {
    const again = queryStore('illegal_road_session', { project_id: { eq: projectId }, id: { eq: sessionId } }, { limit: 1 })
    if (again.list.length) endMs = again.list[0]!.stopped_at_ms || endMs
  }
  return {
    session_id: sessionId,
    is_active: false,
    stopped_at: msNum(endMs),
    closed_tracking_ids: closedTrackingIds,
  }
}
