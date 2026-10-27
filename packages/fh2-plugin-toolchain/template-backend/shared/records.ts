// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// shared/records.ts —— 例行记录的业务生命周期:三种入口共用这一份。
//
// ★★ "shared/ 只放三种调用形态都拿得到的能力"这一纪律由 types/ 的世界划分表达:
//   本文件被 handlers / events / adapters 三路 import,于是它只能用三路注入面的交集
//   (对 data:read/data:write 来说就是 store)。shared 文件被谁 import、能看见哪些全局,
//   是 fh2-plugin types 算出来并钉在 types/*.d.ts 里的,不是口头约定。
//
// shared/store.ts 只统一解 {ok,data}/{ok,error} 信封；实体名仍是这里显式写出的字符串，
// 不从 schema.sql 生成 TypeScript 业务模型。本文件只关心业务语义:
//
//   createRecord  幂等建记录(record_key 唯一键),回 created 标志
//   getRecord     按 record_key 取一条,取不到抛 NOT_FOUND
//   listRecords   按 source 过滤(可空 = 全量,上限 50)
//   markHandled   带条件的状态推进:只有 pending 那条会被改成 handled
//   ingestEvent   消息入口的完整链路:幂等建记录 + 条件推进,重投零副作用

import { createStoreRecord, queryStore, updateStoreRecord } from './store'
import { optionalText, requireText } from './validation'
import type { BusinessError } from './validation'
import { msText } from './time'

/** createRecord 的入参(三种入口同形:record_key / title 必填)。 */
export interface RecordInput {
  readonly [key: string]: unknown
}

/** createRecord 的出参:created=false 表示幂等命中已存在的那条,不是错误。 */
export interface RecordResult {
  readonly id: string
  readonly record_key: string
  readonly title: string
  readonly source: string
  readonly status: string
  readonly created: boolean
}

// createRecord 幂等地建一条记录。
//
// ★★ 幂等靠 createIfAbsent + record_key 的 UNIQUE 索引,不是"先查再写" ——
//   前端在弱网下会重试同一个 record_key,而先查再写在并发下必然产生两条。
//   created=false 是正常返回:调用方靠它区分"新建"与"重试命中"。
//
// ⚠️ status / handled_at_ms 建行时就写全:store 没有"部分列缺省"一说,
//   缺着写就是 NULL,而本地 mock 与真实库对 NULL 的行为不一样。
export function createRecord (input: RecordInput, source: string): RecordResult {
  const recordKey = requireText(input, 'record_key')
  const title = requireText(input, 'title')
  const got = createStoreRecord('example_record', {
    record_key: recordKey,
    title,
    source,
    status: 'pending',
    handled_at_ms: '',
  }, ['record_key'])
  const record = got.record
  return {
    id: String(record.id),
    record_key: recordKey,
    title,
    source,
    status: String(record.status),
    created: got.created === true,
  }
}

// getRecord 按 record_key 取一条。取不到抛 NOT_FOUND(404 档业务错误),
// 而不是回空对象 —— "没有"与"出错"在前端是两种展示。
export function getRecord (input: RecordInput): RecordResult {
  const recordKey = requireText(input, 'record_key')
  const page = queryStore('example_record', { record_key: { eq: recordKey } }, { limit: 1 })
  const record = page.list[0]
  if (record === undefined) {
    throw { code: 'NOT_FOUND', message: '没有这条记录: ' + recordKey } satisfies BusinessError
  }
  return {
    id: String(record.id),
    record_key: recordKey,
    title: String(record.title),
    source: String(record.source),
    status: String(record.status),
    created: false,
  }
}

// listRecords 按来源筛(可空 = 全量),回调用方自定的响应形状而不是 store 的分页信封 ——
// 信封字段(list/total/limit/offset)是平台内部形状,直接透传会把内部契约漏给前端。
export function listRecords (input: RecordInput): {
  readonly items: ReadonlyArray<{ id: string, record_key: string, title: string, source: string, status: string, handled_at_ms: string }>
  readonly total: number
} {
  const source = optionalText(input, 'source')
  const page = queryStore('example_record',
    source === '' ? undefined : { source: { eq: source } },
    { limit: 50 },
  )
  return {
    items: page.list.map(record => ({
      id: String(record.id),
      record_key: String(record.record_key),
      title: String(record.title),
      source: String(record.source),
      status: String(record.status),
      handled_at_ms: String(record.handled_at_ms),
    })),
    total: page.total,
  }
}

// markHandled 把 pending 的那条推进成 handled。
//
// ★★ 状态判据写进 filter 而不是"先查再改":update 是"匹配即改、回 affected 条数",
//   依赖它是原子的。affected === 0 不是错误 —— 要么已是 handled,要么压根没有,
//   两种情况重投这同一个事件都会走到这里,都得无副作用地收场。
export function markHandled (recordKey: string, nowMs: number): number {
  return updateStoreRecord('example_record',
    { record_key: { eq: recordKey }, status: { eq: 'pending' } },
    { status: 'handled', handled_at_ms: msText(nowMs) },
  )
}

// ingestEvent 消息入口的完整链路。
//
// ⚠️⚠️ 消息是【至少一次】投递:同一条消息可能来两次,本地 dev 与线上都会。
//   于是这里有两道闸:① createRecord 幂等(第二次 created=false);
//   ② markHandled 的条件推进(第二次 affected=0)。两道闸都在,重投才真正零副作用。
//
// ★ "这条消息不是给我的"不抛契约错:事件路的契约错会把消息打进死信,而它
//   对同队列的其他消费方可能完全正常 —— 不是自己的就安安静静回空对象。
export function ingestEvent (event: RecordInput, nowMs: number): {
  readonly record_key: string
  readonly created: boolean
  readonly status: string
} {
  const eventID = requireText(event, 'id')
  const data = isRecord(event.data) ? event.data : {}
  const result = createRecord({
    record_key: optionalText(data, 'record_key') || 'event:' + eventID,
    title: optionalText(data, 'title') || ('事件 ' + eventID),
  }, 'event')
  const affected = markHandled(result.record_key, nowMs)
  return {
    record_key: result.record_key,
    created: result.created,
    // affected>0 = 这次真的推进了;0 = 上一次已推进(重投)或建行时就有人改过。
    status: affected > 0 ? 'handled' : result.status,
  }
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
