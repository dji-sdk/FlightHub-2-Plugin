// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 文件一致性契约（实施计划 §3.3）。
 *
 * - `revision` 是内容 hash（sha-256 hex），不是 mtime；
 * - 写入携带 `expectedRevision`，服务端在同一路径串行区内校验并做临时文件替换；
 * - 冲突返回当前磁盘快照，禁止退回无条件覆盖。
 */

/** `sha-256` 内容摘要的 hex 表示。 */
export type FileRevision = string

export interface FileSnapshot {
  /** 工作区相对 POSIX 路径。 */
  readonly path: string;
  readonly content: string;
  readonly revision: FileRevision;
  readonly encoding: 'utf-8';
}

export interface FileWriteRequest {
  readonly path: string;
  readonly content: string;
  readonly expectedRevision: FileRevision;
}

/** 冲突错误码；HTTP 状态映射为 409（见 error-codes.ts）。 */
export const FILE_CONFLICT_CODE = 'FH2_FILE_CONFLICT'

/**
 * 冲突载荷：携带当前磁盘快照，供前端提供 Diff、采用磁盘、保留本地、另存副本。
 * 以数据形式跨端传输（Serve 映射为 409 回包），不定义异常类型。
 */
export interface FileConflict {
  readonly code: typeof FILE_CONFLICT_CODE;
  readonly message: string;
  readonly disk: FileSnapshot;
}

/** 严格解析磁盘/回包中的 FileSnapshot。 */
export function parseFileSnapshot (value: unknown): FileSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.path !== 'string' || record.path === '') return null
  if (typeof record.content !== 'string') return null
  if (typeof record.revision !== 'string' || record.revision === '') return null
  if (record.encoding !== undefined && record.encoding !== 'utf-8') return null
  return {
    path: record.path,
    content: record.content,
    revision: record.revision,
    encoding: 'utf-8',
  }
}
