// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { JsonValue } from 'fh2-plugin-sdk'

/** 解包插件网关 `{code, msg|message, data}` 信封；code !== 0 抛错。 */
export function unwrapApiData (value: JsonValue): JsonValue {
  const response = recordOf(value)
  const code = response.code
  if (typeof code !== 'number') throw new Error('接口响应缺少 code')
  if (code !== 0) {
    const message = text(response.message) || text(response.msg) || '接口请求失败'
    throw new Error(`${message}（code: ${code}）`)
  }
  if (!Object.prototype.hasOwnProperty.call(response, 'data')) throw new Error('接口响应缺少 data')
  return response.data as JsonValue
}

export function recordOf (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : {}
}

export function requiredList (value: JsonValue | undefined, field: string): readonly JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`接口字段缺失：${field}`)
  return value
}

export function text (value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

export function optionalText (value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function numberOr (value: JsonValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function optionalNumber (value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function requiredNumber (value: JsonValue | undefined, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`接口字段缺失：${field}`)
  return value
}

export function requiredString (value: JsonValue | undefined, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`接口字段缺失：${field}`)
  return value
}
