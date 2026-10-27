// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin-toolchain typegen 生成,勿手改。
// 来源契约: 平台契约 backend catalog 与 errors（contractsVersion 1.1.0）。
// 重新生成: WRITE_BACKEND_TYPES=1 pnpm --filter fh2-plugin-toolchain test -- src/backend/typegen
// 返回载荷字段名/叶子类型来自 host-shapes.json fixture;业务数据面统一为字符串。

import type { StoreErrorCode } from './codes.js'

/** store 全局的返回信封:失败不抛异常,回 {ok:false,error}。
 *  形状依据:host-shapes.json 的 store-error-returns-envelope-not-throws 行为探针。 */
export type StoreResult<T> = { ok: true; data: T } | { ok: false; error: { code: StoreErrorCode; message: string } }

/** 平台三列:每条记录都带,摊平在业务字段外层(createdAt/updatedAt 是 RFC3339Nano 字符串)。 */
export type PlatformColumns = {
  createdAt: string
  id: string
  updatedAt: string
}

/** 业务数据面按字符串存储；schema.sql 仍负责运行时 DDL，不投影为插件 TypeScript 类型。 */
export type StoreFields = Record<string, string>

/** update 的写入面:null 表达「显式置 NULL」(JS null → storehost 导出 nil → datastore 绑 NULL)。 */
export type StorePatch = Record<string, string | null>

/** 一条存储记录:业务字段 + 平台三列。 */
export type StoreRecord = StoreFields & PlatformColumns

/** 单字段多算子支持两种写法:对象式({gte:a,lte:b})与数组式([{gte:a},{lte:b}])。 */
export type FilterCondition<V> =
  | { contains: string }
  | { endsWith: string }
  | { eq: V }
  | { gt: V }
  | { gte: V }
  | { in: readonly V[] }
  | { isNotNull: true }
  | { isNull: true }
  | { lt: V }
  | { lte: V }
  | { neq: V }
  | { nin: readonly V[] }
  | { startsWith: string }

export type Filter<E> = { readonly [K in keyof E]?: FilterCondition<E[K]> | FilterCondition<E[K]>[] }

/** 排序声明的两种写法(keyed / singleKey),平台都接受。 */
export type OrderBy<E> =
  | { readonly field: keyof E & string; dir?: 'asc' | 'desc' }
  | { readonly [K in keyof E & string]?: 'asc' | 'desc' }

export type QueryOptions<E> = {
  readonly limit?: number
  readonly offset?: number
  readonly orderBy?: OrderBy<E>[]
}

/** 分页结果:total/limit/offset 为 fixture 观测形状。 */
export type QueryPage = {
  limit: number
  list: StoreRecord[]
  offset: number
  total: number
}

export interface StoreApi {
  query(entity: string, filter?: Filter<StoreRecord>, options?: QueryOptions<StoreRecord>): StoreResult<QueryPage>
  count(entity: string, filter?: Filter<StoreRecord>): StoreResult<{
    count: number
  }>
  insert(entity: string, record: StoreFields): StoreResult<StoreRecord>
  createIfAbsent(entity: string, record: StoreFields, uniqueBy: readonly string[]): StoreResult<{
    created: boolean
    record: StoreRecord
  }>
  update(entity: string, filter: Filter<StoreRecord>, patch: Partial<StorePatch>): StoreResult<{
    affected: number
  }>
  delete(entity: string, filter: Filter<StoreRecord>): StoreResult<{
    deleted: number
  }>
}
