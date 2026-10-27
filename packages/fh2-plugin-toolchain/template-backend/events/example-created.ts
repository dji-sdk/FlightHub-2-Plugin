// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// events/example-created.ts —— Event 消费方入口:MQ 消息驱动,幂等是入场券。
//
// ★ 运行形态(与 Handler 的两处关键差别):
//   · 触发方:消息队列(example.created);本地 dev 用
//     POST /plugin-api/mock/backend/event 手工投递(见本目录 README 的"跑一圈");
//   · 投递语义:【至少一次】—— 同一条消息可能来两次(生产与本地 dev 都会),
//     于是消费方必须幂等,这不是可选项。
//
// ★ 入参形状:消息信封 { id, type, data },业务字段住在 data 里。
//   ctx 是事件侧的注入上下文(requestId / idempotencyKey 都由消息消费填充)。
//
// ⚠️⚠️ 事件入口的 throw 分两档,处置完全不同:
//   · 业务错误信封(如 INVALID_ARGUMENT)→ 消息进死信,要人来看;
//   · 安静返回 → 消息正常确认。于是【"不是给我的"绝不抛】—— 同一条队列上
//     可能还有别的消费方,自己的契约错会拖累别人的投递。
import { ingestEvent } from '../shared/records'
import type { RecordInput } from '../shared/records'
import type { EventCtx } from 'fh2-plugin-sdk/backend'

export function onExampleCreated (event: RecordInput, ctx: EventCtx): {
  readonly record_key: string
  readonly created: boolean
  readonly status: string
} {
  // ctx.now 是平台给的当前时刻(RFC3339);换算成 13 位定宽毫秒串入库。
  const nowMs = Date.parse(ctx.now)
  return ingestEvent(event, Number.isFinite(nowMs) ? nowMs : 0)
}
