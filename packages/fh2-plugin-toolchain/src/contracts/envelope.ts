// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { IdeErrorCode } from './error-codes.js'
import type { FileConflict } from './file.js'
import { SCHEMA_VERSION } from './version.js'

/**
 * Serve/HTTP 回包信封（契约 v1 + v2 增补 + F2 文件冲突）：`{schemaVersion, ok, data}` /
 * `{schemaVersion, ok, error, conflict?}`。`conflict` 仅在 `FH2_FILE_CONFLICT` 时携带，
 * 含当前磁盘快照。
 */
export interface ServeSuccess<T> {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly ok: true;
  readonly data: T;
}

export interface ServeErrorBody {
  readonly code: string;
  readonly message: string;
}

export interface ServeFailure {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly ok: false;
  readonly error: ServeErrorBody;
  readonly conflict?: FileConflict;
}

export type ServeEnvelope<T> = ServeSuccess<T> | ServeFailure

export function serveSuccess<T> (data: T): ServeSuccess<T> {
  return { schemaVersion: SCHEMA_VERSION, ok: true, data }
}

export function serveFailure (code: IdeErrorCode | string, message: string, conflict?: FileConflict): ServeFailure {
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    error: { code, message },
    ...(conflict === undefined ? {} : { conflict }),
  }
}

/**
 * MCP 工具结果信封（实施计划 §3.5）：所有工具统一 `{ok,data}` / `{ok,error}`。
 * 协议层的 structuredContent/文本 content 适配由 MCP Adapter 完成，本信封是其中的 `data` 载荷。
 */
export interface ResultSuccess<T> {
  readonly ok: true;
  readonly data: T;
}

export interface ResultFailure {
  readonly ok: false;
  readonly error: ServeErrorBody;
}

export type ResultEnvelope<T> = ResultSuccess<T> | ResultFailure

export function resultSuccess<T> (data: T): ResultSuccess<T> {
  return { ok: true, data }
}

export function resultFailure (code: string, message: string): ResultFailure {
  return { ok: false, error: { code, message } }
}
