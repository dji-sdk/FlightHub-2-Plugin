// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin-toolchain typegen 生成,勿手改。
// 来源契约: 平台契约 backend catalog 与 errors（contractsVersion 1.1.0）。
// 重新生成: WRITE_BACKEND_TYPES=1 pnpm --filter fh2-plugin-toolchain test -- src/backend/typegen

import type { AdapterCtx, EventCtx, HandlerCtx } from './ctx.js'

/** HTTP Handler 入口:平台对 input/返回值整块透传、不做 IO 校验(类型归插件作者)。 */
export type Handler<I, O = unknown> = (input: I, ctx: HandlerCtx) => O

/** 事件消费方入口:返回值无人消费;payload 类型建议按上游契约手写。 */
export type EventConsumer<P = Record<string, unknown>> = (payload: P, ctx: EventCtx) => unknown

/** Workflow Adapter 入口:出参受 plugin.json scripts[].io 投影约束。 */
export type Adapter<I extends Record<string, unknown>, O = unknown> = (input: I, ctx: AdapterCtx) => O
