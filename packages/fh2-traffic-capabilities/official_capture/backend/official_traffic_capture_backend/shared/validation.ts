// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
export interface BusinessError {
  readonly code: string
  readonly message: string
}

export function requireText (input: Record<string, unknown>, key: string): string {
  const value = String(input[key] === undefined || input[key] === null ? '' : input[key]).trim()
  if (value === '') {
    throw { code: 'INVALID_ARGUMENT', message: key + ' 不能为空' } satisfies BusinessError
  }
  return value
}
