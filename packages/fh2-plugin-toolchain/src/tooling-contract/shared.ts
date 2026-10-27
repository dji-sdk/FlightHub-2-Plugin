// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * Tooling 契约模块共用的规范化序列化与冻结工具。
 *
 * 约定与 src/source-build-rules.ts 一致：键排序的 canonical JSON、2 空格缩进、
 * 结尾换行；数组顺序是规则语义的一部分，保持原样不排序。
 */

/** 递归冻结纯数据契约对象：模块加载后任何消费方都不能改写规则内容。 */
export function deepFreeze<T> (value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

/** 键排序的规范化值；数组顺序保持原样（顺序本身是规则语义）。 */
export function canonicalizeContractValue (value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalizeContractValue(item))
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .filter(key => record[key] !== undefined)
        .sort()
        .map(key => [key, canonicalizeContractValue(record[key])]),
    )
  }
  return value
}

/** 契约唯一使用的序列化器：同输入双跑字节一致。 */
export function serializeContract (value: unknown): string {
  return `${JSON.stringify(canonicalizeContractValue(value), null, 2)}\n`
}
