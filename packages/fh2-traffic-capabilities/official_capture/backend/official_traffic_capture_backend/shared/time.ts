// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// Store 以字符串保存业务字段；13 位毫秒字符串可以安全用于排序和范围条件。
export function msText (ms: number | string): string {
  let value = Math.floor(Number(ms) || 0)
  if (value < 0) value = 0
  let text = String(value)
  if (text.length > 13) {
    throw { code: 'INVALID_ARGUMENT', message: '时间戳看起来不是毫秒(位数 ' + text.length + ')' }
  }
  while (text.length < 13) text = '0' + text
  return text
}

export function msNum (text: string | undefined | null): number {
  return Number(text ?? 0) || 0
}

export function pad2 (value: number): string {
  const text = String(value)
  return text.length < 2 ? '0' + text : text
}

export function tzOffsetHours (): number {
  return 8
}

export function stampText (ms: number | string): string {
  const value = Math.floor(Number(ms) || 0)
  if (value <= 0) return '时刻未知'
  const date = new Date(value + tzOffsetHours() * 3600 * 1000)
  return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate())
    + ' ' + pad2(date.getUTCHours()) + ':' + pad2(date.getUTCMinutes()) + ':' + pad2(date.getUTCSeconds())
}
