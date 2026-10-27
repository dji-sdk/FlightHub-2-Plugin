// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { JsonValue } from 'fh2-plugin-sdk'

export class ApiBusinessError extends Error {
  readonly code: number

  constructor (code: number, message: string) {
    super(message)
    this.name = 'ApiBusinessError'
    this.code = code
  }
}

export function isApiBusinessError (error: unknown): error is ApiBusinessError {
  return error instanceof ApiBusinessError
}

export function unwrapApiData (value: JsonValue): JsonValue {
  const response = record(value)
  const code = response.code
  if (typeof code !== 'number') throw new Error('接口响应缺少 code')
  if (code !== 0) {
    const message = text(response.message) || text(response.msg) || '接口请求失败'
    throw new ApiBusinessError(code, `${message}（code: ${code}）`)
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
