// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin-toolchain typegen 生成,勿手改。
// 来源契约: 平台契约 backend catalog 与 errors（contractsVersion 1.1.0）。
// 重新生成: WRITE_BACKEND_TYPES=1 pnpm --filter fh2-plugin-toolchain test -- src/backend/typegen
// 返回形状未经 fixture 验证(coverage 缺口):来自对 hostapi.go ForWorkflowScript 的核实。

/** 平台内部服务:能力按插件 allowlist 在当前三种 form 注入。提供路段解析、写统一事件模型、读本步连接配置。 */
export interface PlatformApi {
  resolveSegment(lat: number, lng: number): string

  insertEvent(event: Record<string, unknown>): boolean

  getConfig(): Record<string, unknown>

}
