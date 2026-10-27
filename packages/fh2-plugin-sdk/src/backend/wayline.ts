// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin-toolchain typegen 生成,勿手改。
// 来源契约: 平台契约 backend catalog 与 errors（contractsVersion 1.1.0）。
// 重新生成: WRITE_BACKEND_TYPES=1 pnpm --filter fh2-plugin-toolchain test -- src/backend/typegen
// 返回形状未经 fixture 验证(coverage 缺口):来自对 hostapi.go jsWaylineGenerate 的核实。

import type { WaylineGenerateIntent, WaylineGenerateResult } from './refs.js'

/** 示教航线生成:能力按插件 allowlist 在当前三种 form 注入;调用非幂等。出参只有 id 类字段,无凭据。 */
export interface WaylineApi {
  generate(intent: WaylineGenerateIntent): WaylineGenerateResult

}
