// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin-toolchain typegen 生成,勿手改。
// 来源契约: 平台契约 backend catalog 与 errors（contractsVersion 1.1.0）。
// 重新生成: WRITE_BACKEND_TYPES=1 pnpm --filter fh2-plugin-toolchain test -- src/backend/typegen

import type { MediaOwner, VideoFrameOverlay, VideoRef } from './refs.js'

/** 视频处理:能力按插件 allowlist 在当前三种 form 注入。probe 探测、extractFrames 帧计划抽帧、createClip 关键帧剪片。 */
export interface VideoApi {
  probe(ref: VideoRef): {
    durationMs: number
    fps: number
    height: number
    keyframeIntervalMs: number
    width: number
  }

  /** 新旧调用统一单次最多 8 帧；超过上限必须拆批。overlays 存在时须与 atMs 严格等长。 */
  extractFrames(ref: VideoRef, atMs: readonly number[], owner: MediaOwner, names?: readonly string[], overlays?: readonly VideoFrameOverlay[]): Array<{
    atMs: number
    fileId: string
    skipReason: string
    skipped: boolean
  }>

  createClip(ref: VideoRef, startMs: number, endMs: number, owner: MediaOwner, name?: string): {
    actualEndMs: number
    actualStartMs: number
    durationMs: number
    fileId: string
    skipReason: string
    skipped: boolean
  }

}
