// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin-toolchain typegen 生成,勿手改。
// 来源契约: 平台契约 backend catalog 与 errors（contractsVersion 1.1.0）。
// 重新生成: WRITE_BACKEND_TYPES=1 pnpm --filter fh2-plugin-toolchain test -- src/backend/typegen
// 返回形状未经 fixture 验证(coverage 缺口):来自对 hostapi.go jsFetch 的核实。

import type { FetchResponse } from './refs.js'

/** 受管出站:能力按插件 allowlist 在当前三种 form 注入。fetch 打客户系统(有限额与 host 白名单),invoke 走出站连接器。fetch 的响应 body 是字符串,解析归脚本。 */
export interface ConnectorApi {
  fetch(request: { method?: string; url: string; headers?: Record<string, string>; body?: string | Record<string, unknown>; timeoutSec?: number }): FetchResponse

  invoke(id: string, payload: Record<string, unknown>): boolean

}
