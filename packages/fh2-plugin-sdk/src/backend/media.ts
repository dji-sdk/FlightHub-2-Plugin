// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin-toolchain typegen 生成,勿手改。
// 来源契约: 平台契约 backend catalog 与 errors（contractsVersion 1.1.0）。
// 重新生成: WRITE_BACKEND_TYPES=1 pnpm --filter fh2-plugin-toolchain test -- src/backend/typegen

export interface MediaFileView {
  fileId: string
  fileName: string
  fileType: number
  originalUrl: string
  parentId: string
  previewUrl: string
  shotAtMs: number
  subFileType: number
  urlExpiresInSec: number
}

/** 媒体能力:读侧(get/list)与写侧(attach/ensureFolder/move/rename)是两种权限(media:read / media:write)。 */
export interface MediaApi {
  get(fileId: string, workspace?: string): MediaFileView

  list(ownerType: string, ownerID: string): MediaFileView[]

  attach(ownerType: string, ownerID: string, fileID: string, role: string): {
    attached: boolean
    skipReason: string
    skipped: boolean
  }

  ensureFolder(ownerType: string, ownerID: string, displayName: string, parentID?: string, workspace?: string): {
    created: boolean
    folderId: string
    parentId: string
    skipReason: string
    skipped: boolean
  }

  move(fileID: string, folderID: string, workspace?: string): {
    moved: boolean
    skipReason: string
    skipped: boolean
  }

  rename(fileID: string, name: string, workspace?: string): {
    renamed: boolean
    skipReason: string
    skipped: boolean
  }

}
