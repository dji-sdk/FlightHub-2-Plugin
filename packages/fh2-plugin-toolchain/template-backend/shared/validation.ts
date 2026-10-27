// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// shared/validation.ts —— 入参校验助手:三种入口共用的第一道闸。
//
// ⚠️ 平台的 required 只判"键在不在",判不了"是不是空白串" —— 而空白 record_key 会写进库、
//   之后按它查什么都查不到,且没有任何报错。故业务侧再判一次。

/** 业务错误信封:throw 出去后由平台原样转成 HTTP/消息的错误回执,code 是稳定值域。 */
export interface BusinessError {
  readonly code: string
  readonly message: string
}

// requireText 取一个必填的非空字符串,缺了/空了就抛 INVALID_ARGUMENT(400 档)。
export function requireText (input: Record<string, unknown>, key: string): string {
  const value = String(input[key] === undefined || input[key] === null ? '' : input[key]).trim()
  if (value === '') {
    throw { code: 'INVALID_ARGUMENT', message: key + ' 不能为空' } satisfies BusinessError
  }
  return value
}

// optionalText 取一个可选字符串:没给就是空串,不抛错。
export function optionalText (input: Record<string, unknown>, key: string): string {
  return String(input[key] === undefined || input[key] === null ? '' : input[key]).trim()
}
