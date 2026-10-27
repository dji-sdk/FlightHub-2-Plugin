// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { countStore, queryStore, updateStoreRecord } from '../../shared/store'
import { clampTrackingEnd } from '../../shared/illegal-road'
import { msNum, msText } from '../../shared/time'
import { requireText } from '../../shared/validation'
import type { BusinessError } from '../../shared/validation'
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'

export interface StopTrackingInput {
  readonly [key: string]: unknown
  readonly tracking_id?: string
  readonly ended_at?: string | number | null
}

export interface StopTrackingResult {
  readonly tracking_id: string
  readonly status: string
  readonly started_at: number
  readonly ended_at: number
  readonly close_reason: string
  readonly media_count: number
}

export function stopTracking (input: StopTrackingInput, _ctx: HandlerCtx): StopTrackingResult {
  const trackingId = requireText(input, 'tracking_id')
  const page = queryStore('illegal_road_tracking', { id: { eq: trackingId } }, { limit: 1 })
  if (!page.list.length) {
    throw { code: 'NOT_FOUND', message: '没有这条跟踪记录' } satisfies BusinessError
  }
  const tracking = page.list[0]!
  const projectId = tracking.project_id || ''
  let endMs = input.ended_at === undefined || input.ended_at === null || input.ended_at === ''
    ? ''
    : msText(input.ended_at)
  endMs = clampTrackingEnd(endMs, tracking.started_at_ms || '', trackingId)
  const affected = updateStoreRecord('illegal_road_tracking', {
    project_id: { eq: projectId }, id: { eq: trackingId }, status: { eq: 'open' },
  }, { status: 'closed', ended_at_ms: endMs, close_reason: 'manual' })
  let status = 'closed'
  let closeReason = 'manual'
  if (affected === 0) {
    const again = queryStore('illegal_road_tracking', {
      project_id: { eq: projectId }, id: { eq: trackingId },
    }, { limit: 1 })
    if (again.list.length) {
      const record = again.list[0]!
      endMs = record.ended_at_ms || endMs
      status = record.status || status
      closeReason = record.close_reason || closeReason
    }
  }
  return {
    tracking_id: trackingId,
    status,
    started_at: msNum(tracking.started_at_ms),
    ended_at: msNum(endMs),
    close_reason: closeReason,
    media_count: countStore('illegal_road_media', {
      project_id: { eq: projectId }, tracking_id: { eq: trackingId },
    }),
  }
}
