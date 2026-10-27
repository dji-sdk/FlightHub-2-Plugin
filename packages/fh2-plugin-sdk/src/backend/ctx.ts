// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin-toolchain typegen 生成,勿手改。
// 来源契约: 平台契约 backend catalog 与 errors（contractsVersion 1.1.0）。
// 重新生成: WRITE_BACKEND_TYPES=1 pnpm --filter fh2-plugin-toolchain test -- src/backend/typegen

/**
 * 平台注入的调用上下文(handle(input, ctx) 的第二个实参)。
 * 字段与类型来自 worker 的 ctx 探针(host-surface.json),非手写。
 * 本段只声明 ctx 字段面；各入口的填充值见 catalog/entrypoints.json。stableId 依赖幂等键，取不到时抛契约错
 */
export interface BaseCtx {
  readonly idempotencyKey: string
  readonly now: string
  readonly pluginVersion: string
  readonly requestId: string
  readonly scriptId: string
  stableId(scope: string): string
}

/** HTTP Handler 的 ctx(requestId 由 invoke 信封填充,非空)。 */
export type HandlerCtx = BaseCtx

/** 事件消费方的 ctx(requestId 由消息消费填充)。 */
export type EventCtx = BaseCtx

/** Workflow Adapter 的 ctx(requestId 恒为空串;idempotencyKey 来自 run.* 接线)。 */
export type AdapterCtx = BaseCtx
