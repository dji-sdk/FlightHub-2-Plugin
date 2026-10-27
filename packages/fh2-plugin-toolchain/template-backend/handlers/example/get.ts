// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// handlers/example/get.ts —— HTTP Handler 入口:按 record_key 取一条。
//
// ★ 取不到抛 NOT_FOUND 业务错误信封 —— 平台把它转成 404 档回执,前端据 code 分流;
//   "没有"与"出错"是两种展示,别用回空对象表达"没有"(那和调用成功长得一样)。
import { getRecord } from '../../shared/records'
import type { RecordResult, RecordInput } from '../../shared/records'
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'

export function get (input: RecordInput, _ctx: HandlerCtx): RecordResult {
  return getRecord(input)
}
