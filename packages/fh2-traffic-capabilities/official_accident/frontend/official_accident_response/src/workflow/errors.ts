// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { JsonValue } from 'fh2-plugin-sdk'

export function errorMessage (error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function errorLogDetail (
  error: unknown,
  fallback: string,
): Readonly<Record<string, JsonValue>> {
  const source = typeof error === 'object' && error !== null
    ? error as { readonly code?: unknown }
    : undefined
  const code = source?.code
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: errorMessage(error, fallback),
    ...(error instanceof Error && error.stack ? { errorStack: error.stack } : {}),
    ...(typeof code === 'string' || typeof code === 'number' ? { errorCode: code } : {}),
  }
}
