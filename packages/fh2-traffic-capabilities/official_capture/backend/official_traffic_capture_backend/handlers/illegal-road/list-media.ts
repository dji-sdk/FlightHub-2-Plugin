// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { queryStore } from '../../shared/store'
import { lensLabel, linkBudget, mediaDetail, mediaTypeLabel } from '../../shared/media'
import type { LensLabel, MediaDetail, MediaTypeLabel } from '../../shared/media'
import { pageBounds } from '../../shared/pagination'
import { msNum } from '../../shared/time'
import { requireText } from '../../shared/validation'
import type { BusinessError } from '../../shared/validation'
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'

export interface ListMediaInput {
  readonly [key: string]: unknown
  readonly tracking_id?: string
  readonly page?: number
  readonly page_size?: number
}

export interface ListMediaRow {
  readonly id: string
  readonly file_id: number
  readonly media_type: MediaTypeLabel
  readonly lens: LensLabel
  readonly file_name: string
  readonly preview_url: string
  readonly original_url: string
  readonly captured_at_ms: number
  readonly links_unavailable: boolean
}

export interface ListMediaResult {
  readonly total: number
  readonly page: number
  readonly page_size: number
  readonly folder_id: number
  readonly media: ListMediaRow[]
  readonly links_unavailable: boolean
}

export function listMedia (input: ListMediaInput, _ctx: HandlerCtx): ListMediaResult {
  const trackingId = requireText(input, 'tracking_id')
  const bounds = pageBounds(input, 50, 200)
  const trackingPage = queryStore('illegal_road_tracking', { id: { eq: trackingId } }, { limit: 1 })
  if (!trackingPage.list.length) {
    throw { code: 'NOT_FOUND', message: '没有这条跟踪记录' } satisfies BusinessError
  }
  const tracking = trackingPage.list[0]!
  const projectId = tracking.project_id || ''
  const page = queryStore('illegal_road_media', {
    project_id: { eq: projectId }, tracking_id: { eq: trackingId },
  }, {
    limit: bounds.size,
    offset: bounds.offset,
    orderBy: [{ field: 'shot_at_ms', dir: 'asc' }],
  })
  const list: ListMediaRow[] = []
  let usedLinks = 0
  let linksUnavailable = false
  for (let index = 0; index < page.list.length; index++) {
    const record = page.list[index]!
    let detail: MediaDetail
    if (usedLinks < linkBudget()) {
      detail = mediaDetail(record.file_id || '', projectId)
      usedLinks++
    } else {
      detail = { file_name: '', preview_url: '', original_url: '', links_unavailable: true }
    }
    if (detail.links_unavailable) linksUnavailable = true
    const type = mediaTypeLabel(record.media_type)
    list.push({
      id: record.id,
      file_id: Number(record.file_id || 0) || 0,
      media_type: type,
      lens: type === 'photo' ? lensLabel(record.sub_file_type) : 'unknown',
      file_name: detail.file_name,
      preview_url: detail.preview_url,
      original_url: detail.original_url,
      captured_at_ms: msNum(record.shot_at_ms),
      links_unavailable: detail.links_unavailable,
    })
  }
  if (usedLinks >= linkBudget() && page.list.length > usedLinks) {
    log.warn('单请求链接预算耗尽，后面的行不带链接与文件名', {
      tracking_id: trackingId,
      rows: page.list.length,
      budget: linkBudget(),
    })
  }
  return {
    total: page.total,
    page: bounds.page,
    page_size: bounds.size,
    folder_id: Number(tracking.folder_id || 0) || 0,
    media: list,
    links_unavailable: linksUnavailable,
  }
}
