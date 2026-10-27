// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin-toolchain typegen 生成,勿手改。
// 来源契约: 平台契约 backend catalog 与 errors（contractsVersion 1.1.0）。
// 重新生成: WRITE_BACKEND_TYPES=1 pnpm --filter fh2-plugin-toolchain test -- src/backend/typegen
// 返回形状未经 fixture 验证(coverage 缺口),来自对 cachehost.go 的核实。

import type { CacheErrorCode } from './codes.js'

/** cache 全局的返回信封:失败不抛异常(与 store 同一通道语义)。 */
export type CacheResult<T> = { ok: true; data: T } | { ok: false; error: { code: CacheErrorCode; message: string } }

/** 插件高速缓存(共享 key 空间,平台不加 pluginId 前缀,唯一性由插件自己保证)。读(cache:read)/写(cache:write)是两种权限。 */
export interface CacheApi {
  get(key: string): CacheResult<unknown>

  exists(key: string): CacheResult<boolean>

  ttl(key: string): CacheResult<{ ttl: number | null }>

  mget(keys: readonly string[]): CacheResult<{ values: unknown[] }>

  hget(key: string, field: string): CacheResult<unknown>

  hgetAll(key: string): CacheResult<{ fields: Record<string, unknown> }>

  lrange(key: string, start: number, stop: number): CacheResult<{ items: unknown[] }>

  llen(key: string): CacheResult<{ length: number }>

  smembers(key: string): CacheResult<{ members: unknown[] }>

  sismember(key: string, member: unknown): CacheResult<boolean>

  scard(key: string): CacheResult<{ count: number }>

  zrange(key: string, start: number, stop: number, opts?: { rev?: boolean }): CacheResult<{ members: unknown[] }>

  zrangeByScore(key: string, min: number, max: number, limit?: number): CacheResult<{ members: unknown[] }>

  zscore(key: string, member: unknown): CacheResult<unknown>

  zcard(key: string): CacheResult<{ count: number }>

  set(key: string, value: unknown, ttlSec: number): CacheResult<Record<string, never>>

  del(key: string): CacheResult<Record<string, never>>

  expire(key: string, ttlSec: number): CacheResult<Record<string, never>>

  expireAt(key: string, atEpochSec: number): CacheResult<Record<string, never>>

  incr(key: string, delta: number, ttlSec?: number): CacheResult<{ value: number }>

  setnx(key: string, value: unknown, ttlSec: number): CacheResult<{ set: boolean; current: unknown }>

  getdel(key: string): CacheResult<unknown>

  unlock(key: string, token: unknown): CacheResult<{ unlocked: boolean }>

  hset(key: string, field: string, value: unknown, ttlSec: number): CacheResult<Record<string, never>>

  hdel(key: string, field: string | readonly string[]): CacheResult<Record<string, never>>

  rpush(key: string, value: unknown | readonly unknown[], ttlSec: number, opts?: { maxLen?: number }): CacheResult<{ length: number }>

  lpop(key: string): CacheResult<unknown>

  sadd(key: string, member: unknown | readonly unknown[], ttlSec: number): CacheResult<{ added: number }>

  srem(key: string, member: unknown | readonly unknown[]): CacheResult<Record<string, never>>

  zadd(key: string, member: { member: unknown; score: number } | readonly { member: unknown; score: number }[], ttlSec: number): CacheResult<{ added: number }>

  zrem(key: string, member: unknown | readonly unknown[]): CacheResult<Record<string, never>>

  zremByScore(key: string, min: number, max: number): CacheResult<{ removed: number }>

}
