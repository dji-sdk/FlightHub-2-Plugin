// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { countStore, queryStore } from '../../shared/store'
import { coverLinks, linkBudget, photoSubTypesForCover } from '../../shared/media'
import type { MediaLinks } from '../../shared/media'
import { trackingView } from '../../shared/illegal-road'
import type { IllegalRoadTrackingView } from '../../shared/illegal-road'
import { pageBounds } from '../../shared/pagination'
import { msNum } from '../../shared/time'
import { requireText } from '../../shared/validation'
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'

export interface ListTrackingsInput {
  readonly [key: string]: unknown
  readonly project_id?: string
  readonly flight_id?: string | number | null
  readonly session_id?: string | number | null
  readonly page?: number
  readonly page_size?: number
}

export interface ListTrackingsSession {
  readonly session_id: string
  readonly status: string
  readonly started_at: number
  readonly ended_at: number
  readonly tracking_count: number
}

export interface ListTrackingsLatestPhoto {
  readonly file_id: number
  readonly preview_url: string
  readonly original_url: string
  readonly photo_time_ms: number
}

export interface ListTrackingsRow extends IllegalRoadTrackingView {
  close_reason: string
  media_count: number
  photo_count: number
  video_count: number
  folder_id: number
  parent_folder_id: number
  latest_photo: ListTrackingsLatestPhoto | null
  links_unavailable: boolean
}

export interface ListTrackingsResult {
  readonly total: number
  readonly page: number
  readonly page_size: number
  readonly session: ListTrackingsSession | null
  readonly trackings: ListTrackingsRow[]
  readonly links_unavailable: boolean
}

export function listTrackings (input: ListTrackingsInput, _ctx: HandlerCtx): ListTrackingsResult {
  const projectId = requireText(input, 'project_id')
  const flightId = String(input.flight_id === undefined || input.flight_id === null ? '' : input.flight_id).trim()
  const sessionId = String(input.session_id === undefined || input.session_id === null ? '' : input.session_id).trim()
  const bounds = pageBounds(input, 20, 100)
  const filter = {
    project_id: { eq: projectId },
    ...(flightId ? { flight_id: { eq: flightId } } : {}),
    ...(sessionId ? { session_id: { eq: sessionId } } : {}),
  }
  const page = queryStore('illegal_road_tracking', filter, {
    limit: bounds.size,
    offset: bounds.offset,
    orderBy: [{ field: 'started_at_ms', dir: 'desc' }],
  })

  let session: ListTrackingsSession | null = null
  if (flightId || sessionId) {
    const sessionFilter = {
      project_id: { eq: projectId },
      ...(sessionId ? { id: { eq: sessionId } } : { flight_id: { eq: flightId } }),
    }
    const sessions = queryStore('illegal_road_session', sessionFilter, {
      limit: 1,
      orderBy: [{ field: 'started_at_ms', dir: 'desc' }],
    })
    if (sessions.list.length) {
      const record = sessions.list[0]!
      session = {
        session_id: record.id,
        status: record.status || '',
        started_at: msNum(record.started_at_ms),
        ended_at: msNum(record.stopped_at_ms),
        tracking_count: countStore('illegal_road_tracking', {
          project_id: { eq: projectId }, session_id: { eq: record.id },
        }),
      }
    }
  }

  let usedLinks = 0
  let linksUnavailable = false
  const trackings: ListTrackingsRow[] = []
  for (let index = 0; index < page.list.length; index++) {
    const record = page.list[index]!
    const row: ListTrackingsRow = {
      ...trackingView(record),
      close_reason: record.status === 'open' ? '' : record.close_reason || '',
       media_count: countStore('illegal_road_media', { project_id: { eq: projectId }, tracking_id: { eq: record.id } }),
       photo_count: countStore('illegal_road_media', {
        project_id: { eq: projectId }, tracking_id: { eq: record.id }, media_type: { eq: '1' },
      }),
       video_count: countStore('illegal_road_media', {
        project_id: { eq: projectId }, tracking_id: { eq: record.id }, media_type: { eq: '2' },
      }),
      folder_id: Number(record.folder_id || 0) || 0,
      parent_folder_id: Number(record.parent_folder_id || 0) || 0,
      latest_photo: null,
      links_unavailable: false,
    }
    const latest = queryStore('illegal_road_media', {
      project_id: { eq: projectId },
      tracking_id: { eq: record.id },
      media_type: { eq: '1' },
      sub_file_type: { in: photoSubTypesForCover() },
    }, { limit: 1, orderBy: [{ field: 'shot_at_ms', dir: 'desc' }] })
    if (latest.list.length) {
      const mediaRecord = latest.list[0]!
      let links: MediaLinks
      if (usedLinks < linkBudget()) {
        links = coverLinks(mediaRecord.file_id || '', projectId)
        usedLinks++
      } else {
        links = { preview_url: '', original_url: '', links_unavailable: true }
      }
      if (links.links_unavailable) linksUnavailable = true
      row.latest_photo = {
        file_id: Number(mediaRecord.file_id || 0) || 0,
        preview_url: links.preview_url,
        original_url: links.original_url,
        photo_time_ms: msNum(mediaRecord.shot_at_ms),
      }
      row.links_unavailable = links.links_unavailable
    }
    trackings.push(row)
  }
  if (usedLinks >= linkBudget() && page.list.length > usedLinks) {
    log.warn('单请求链接预算耗尽，后面的行不带链接', {
      project_id: projectId,
      rows: page.list.length,
      budget: linkBudget(),
    })
  }
  return {
    total: page.total,
    page: bounds.page,
    page_size: bounds.size,
    session,
    trackings,
    links_unavailable: linksUnavailable,
  }
}
