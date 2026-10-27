// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { queryStore } from '../../shared/store'
import { mediaLinks } from '../../shared/media'
import { msNum } from '../../shared/time'
import { requireText } from '../../shared/validation'
import type { BusinessError } from '../../shared/validation'
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'

export interface GetEventInput {
  readonly [key: string]: unknown
  readonly event_id?: string
}

export interface GetEventEvidenceItem {
  readonly role: string
  readonly file_id: number
  readonly preview_url: string
  readonly original_url: string
  readonly links_unavailable: boolean
}

export interface GetEventResult {
  readonly event_id: string
  readonly event_key: string
  readonly project_id: string
  readonly dock_sn: string
  readonly flight_id: string
  readonly crossed_at: number
  readonly collision_type: string
  readonly obj_id: string
  readonly post_status: string
  readonly reject_reason: string
  readonly failure_reason: string
  readonly annotation_snapshot: Record<string, unknown>
  readonly evidence: GetEventEvidenceItem[]
  readonly links_unavailable: boolean
}

export function getEvent (input: GetEventInput, _ctx: HandlerCtx): GetEventResult {
  const eventId = requireText(input, 'event_id')
  const page = queryStore('lane_change_event', { id: { eq: eventId } }, { limit: 1 })
  if (!page.list.length) {
    throw { code: 'NOT_FOUND', message: '没有这条变道事件' } satisfies BusinessError
  }
  const record = page.list[0]!
  let snapshot: Record<string, unknown> = {}
  if (record.snapshot_json) {
    try { snapshot = JSON.parse(record.snapshot_json) } catch { snapshot = {} }
  }
  const evidencePage = queryStore('lane_change_evidence', { event_id: { eq: eventId } }, {
    limit: 20,
    orderBy: [{ field: 'role', dir: 'asc' }],
  })
  const evidence: GetEventEvidenceItem[] = []
  let linksUnavailable = false
  for (let index = 0; index < evidencePage.list.length; index++) {
    const item = evidencePage.list[index]!
    const links = mediaLinks(item.file_id || '', record.project_id || '')
    if (links.links_unavailable) linksUnavailable = true
    evidence.push({
      role: item.role || '',
      file_id: Number(item.file_id || 0) || 0,
      preview_url: links.preview_url,
      original_url: links.original_url,
      links_unavailable: links.links_unavailable,
    })
  }
  return {
    event_id: record.id,
    event_key: record.event_key || '',
    project_id: record.project_id || '',
    dock_sn: record.dock_sn || '',
    flight_id: record.flight_id || '',
    crossed_at: msNum(record.crossed_at_ms),
    collision_type: record.collision_type || '',
    obj_id: record.obj_id || '',
    post_status: record.post_status || '',
    reject_reason: record.reject_reason || '',
    failure_reason: record.failure_reason || '',
    annotation_snapshot: snapshot,
    evidence,
    links_unavailable: linksUnavailable,
  }
}
