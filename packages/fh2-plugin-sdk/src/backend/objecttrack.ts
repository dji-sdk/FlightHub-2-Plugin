// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin-toolchain typegen 生成,勿手改。
// 来源契约: 平台契约 backend catalog 与 errors（contractsVersion 1.1.0）。
// 重新生成: WRITE_BACKEND_TYPES=1 pnpm --filter fh2-plugin-toolchain test -- src/backend/typegen

import type { VideoRef } from './refs.js'

/** 目标轨迹:能力按插件 allowlist 在当前三种 form 注入。inspect 取时间基线,getTrack 取归一化轨迹。空 samples 不是错误。 */
export interface ObjectTrackApi {
  inspect(ref: VideoRef, window: { rawStartMs: number; rawEndMs: number }): {
    durationMs: number
    firstFrameNo: number
    fps: number
    lastFrameNo: number
    startWallClockMs: number
  }

  getTrack(query: { fileId: string; objectKey: string; objectId: string; fromMs?: number; toMs?: number; fps: number }): {
    durationMs: number
    samples: Array<{
      frameNo: number
      h: number
      offsetMs: number
      w: number
      x: number
      y: number
    }>
  }

}
