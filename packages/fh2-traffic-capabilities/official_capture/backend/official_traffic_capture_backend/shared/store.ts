// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type {
  Filter,
  QueryOptions,
  QueryPage,
  StoreFields,
  StoreRecord,
  StoreResult,
} from 'fh2-plugin-sdk/backend'

/**
 * 运行时数据面按字符串实体名和字段值工作。这个小封装只统一 StoreResult 错误语义，
 * 不读取 schema.sql，也不提供插件级 EntityMap 或 repository facade。
 */
function unwrapStore<T> (what: string, result: StoreResult<T>): T {
  if (result.ok === true) return result.data
  // eslint-disable-next-line no-throw-literal -- Worker maps this business envelope to the plugin response.
  throw {
    code: 'INTERNAL',
    message: `${what} 失败(${result.error.code}): ${result.error.message}`,
  }
}

export function queryStore (
  entity: string,
  filter: Filter<StoreRecord> = {},
  options: QueryOptions<StoreRecord> = {},
): QueryPage {
  return unwrapStore(`查询 ${entity}`, store.query(entity, filter, options))
}

export function countStore (entity: string, filter: Filter<StoreRecord> = {}): number {
  return Number(unwrapStore(`统计 ${entity}`, store.count(entity, filter)).count || 0) || 0
}

export function insertStoreRecord (entity: string, record: StoreFields): StoreRecord {
  return unwrapStore(`写 ${entity}`, store.insert(entity, record))
}

export function createStoreRecord (
  entity: string,
  record: StoreFields,
  uniqueBy: readonly string[],
): { created: boolean; record: StoreRecord } {
  return unwrapStore(`写 ${entity}`, store.createIfAbsent(entity, record, uniqueBy))
}

export function updateStoreRecord (
  entity: string,
  filter: Filter<StoreRecord>,
  patch: Partial<StoreFields>,
): number {
  return unwrapStore(`更新 ${entity}`, store.update(entity, filter, patch)).affected
}

export function deleteStoreRecords (entity: string, filter: Filter<StoreRecord>): number {
  return unwrapStore(`删除 ${entity}`, store.delete(entity, filter)).deleted
}
