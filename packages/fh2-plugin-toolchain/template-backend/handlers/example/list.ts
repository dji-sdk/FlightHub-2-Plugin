// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// handlers/example/list.ts —— HTTP Handler 入口:按 source 筛记录(可空 = 全量)。
//
// ★ 筛选字段名就是 store 列名(snake_case) —— 平台按"你写的名字"原样透传给存储,
//   一处写 snake 一处写 camel 会出现"带筛选时某几列静默变空白"的坑,统一 snake 最稳。
import { listRecords } from '../../shared/records'
import type { RecordInput } from '../../shared/records'
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'

export function list (input: RecordInput, _ctx: HandlerCtx): ReturnType<typeof listRecords> {
  return listRecords(input)
}
