// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// handlers/example/create.ts —— HTTP Handler 入口:前端一次调用,同步回执。
//
// ★ 运行形态(与另两种入口的差别,见本目录 README):
//   · 触发方:前端 invoke(生产)/ curl POST /plugin-api/plugin/invoke(本地 dev);
//   · 幂等:平台按 Idempotency-Key 头去重一次,业务幂等还是靠 record_key 唯一键;
//   · 注入面:httpHandler 世界(types/handler.d.ts):store / log …… 按清单 allowlist 裁剪。
//
// ★ 命名:文件路径 handlers/example/create.ts + export function create
//   → build 生成稳定运行时入口 h_example_create;调用方可用三种名字:
//   h_example_create / example_create / example.create(新 Worker 都认)。
//
// ⚠️ 第二个参数 ctx 由平台注入(now / requestId / idempotencyKey / stableId / pluginVersion)。
//   本例用不上它,但签名要带上 —— ctx 的字段见 types/handler.d.ts。
import { createRecord } from '../../shared/records'
import type { RecordResult, RecordInput } from '../../shared/records'
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'

export function create (input: RecordInput, _ctx: HandlerCtx): RecordResult {
  // source 记录"这条记录从哪种入口来",list 可按它筛 —— 三个入口写不同的值。
  return createRecord(input, 'handler')
}
