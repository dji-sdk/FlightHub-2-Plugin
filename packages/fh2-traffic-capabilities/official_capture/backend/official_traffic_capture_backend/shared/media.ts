// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
export interface MediaLinks {
  readonly preview_url: string
  readonly original_url: string
  readonly links_unavailable: boolean
}

export interface MediaDetail extends MediaLinks {
  readonly file_name: string
}

// Regular TS enum is intentionally used by this schema-driven example.
export enum StoredMediaType {
  Photo = '1',
  Video = '2',
}

export function mediaLinks (fileId: string, workspace: string): MediaLinks {
  try {
    const result = media.get(String(fileId), String(workspace ?? ''))
    return {
      preview_url: result.previewUrl ?? '',
      original_url: result.originalUrl ?? '',
      links_unavailable: false,
    }
  } catch (error) {
    log.warn('取证据链接失败，按降级返回空串', {
      file_id: String(fileId),
      reason: String((error as { message?: string })?.message ?? error),
    })
    return { preview_url: '', original_url: '', links_unavailable: true }
  }
}

export function coverLinks (fileId: string, workspace: string): MediaLinks {
  try {
    const result = media.get(String(fileId), String(workspace ?? ''))
    return {
      preview_url: result.previewUrl ?? '',
      original_url: result.originalUrl ?? '',
      links_unavailable: false,
    }
  } catch {
    log.warn('取封面链接失败，按降级返回空串', { file_id: String(fileId) })
    return { preview_url: '', original_url: '', links_unavailable: true }
  }
}

export function mediaDetail (fileId: string, workspace: string): MediaDetail {
  try {
    const result = media.get(String(fileId), String(workspace ?? ''))
    return {
      file_name: result.fileName ?? '',
      preview_url: result.previewUrl ?? '',
      original_url: result.originalUrl ?? '',
      links_unavailable: false,
    }
  } catch {
    log.warn('取媒体信息失败，按降级返回空串', { file_id: String(fileId) })
    return { file_name: '', preview_url: '', original_url: '', links_unavailable: true }
  }
}

export function linkBudget (): number {
  return 20
}

export function photoSubTypesForCover (): string[] {
  return ['2', '3']
}

export type MediaTypeLabel = 'photo' | 'video' | 'unknown'

export function mediaTypeLabel (mediaType: string | number | undefined | null): MediaTypeLabel {
  const value = String(mediaType === undefined || mediaType === null ? '' : mediaType)
  if (value === StoredMediaType.Photo) return 'photo'
  if (value === StoredMediaType.Video) return 'video'
  return 'unknown'
}

export type LensLabel = 'wide' | 'zoom' | 'unknown'

export function lensLabel (subType: string | number | undefined | null): LensLabel {
  const value = String(subType === undefined || subType === null ? '' : subType)
  if (value === '2') return 'wide'
  if (value === '3') return 'zoom'
  return 'unknown'
}
