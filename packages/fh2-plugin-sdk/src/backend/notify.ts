// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin-toolchain typegen 生成,勿手改。
// 来源契约: 平台契约 backend catalog 与 errors（contractsVersion 1.1.0）。
// 重新生成: WRITE_BACKEND_TYPES=1 pnpm --filter fh2-plugin-toolchain test -- src/backend/typegen

import type { NotifyIntent } from './refs.js'

/** 前端通知(es-duplex WebSocket 广播)。best-effort:投递失败回 delivered=false 而不是抛错。 */
export interface NotifyApi {
  publish(intent: NotifyIntent): {
    delivered: boolean
    failReason: string
    skipReason: string
    skipped: boolean
  }

}
