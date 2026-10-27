// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * Serve/HTTP 事件与回包的统一 schema 版本。
 *
 * 规则（实施计划 §1.2 / Wave 0）：
 * - 未知的 schemaVersion 必须明确失败，不得静默按 v1 处理；
 * - 缺失版本仅在明确声明的旧数据入口处理（本包的解析器一律拒绝缺失）。
 */
export const SCHEMA_VERSION = 1 as const

export type SchemaVersionCheck =
  | { readonly ok: true; readonly version: number }
  | {
    readonly ok: false;
    readonly reason: 'missing' | 'invalid' | 'unsupported';
    readonly received?: number;
  }

/**
 * 读取并校验 payload 上的 schemaVersion。
 * `supported` 默认只支持当前版本；发现更新协议时在此扩展，消费方按 check 结果拒绝旧/新版本。
 */
export function checkSchemaVersion (
  payload: Record<string, unknown>,
  supported: readonly number[] = [SCHEMA_VERSION],
): SchemaVersionCheck {
  const received: unknown = payload.schemaVersion
  if (received === undefined) return { ok: false, reason: 'missing' }
  if (typeof received !== 'number' || !Number.isInteger(received)) {
    return { ok: false, reason: 'invalid', received: received as number }
  }
  if (!supported.includes(received)) return { ok: false, reason: 'unsupported', received }
  return { ok: true, version: received }
}

/** 便捷判定：schemaVersion 存在、合法且受支持。 */
export function isSupportedSchemaVersion (
  payload: Record<string, unknown>,
  supported: readonly number[] = [SCHEMA_VERSION],
): boolean {
  return checkSchemaVersion(payload, supported).ok
}
