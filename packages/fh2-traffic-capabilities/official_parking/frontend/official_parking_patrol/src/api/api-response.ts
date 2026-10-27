// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { JsonValue } from 'fh2-plugin-sdk'

/** 解析后端统一信封 `{code, message, data}`，code≠0 抛错并返回内层 data。 */
export function unwrapApiData (value: JsonValue): JsonValue {
  const response = record(value)
  const code = response.code
  if (typeof code !== 'number') throw new Error('接口响应缺少 code')
  if (code !== 0) {
    const message = text(response.message) || text(response.msg) || '接口请求失败'
    throw new Error(`${message}（code: ${code}）`)
  }
  if (!Object.prototype.hasOwnProperty.call(response, 'data')) throw new Error('接口响应缺少 data')
  return response.data as JsonValue
}

function record (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : {}
}

function text (value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}
