// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { parseWorkspaceKind } from './workspace.js'
import type { WorkspaceKind } from './workspace.js'
import { checkSchemaVersion } from './version.js'

/**
 * Serve SSE 事件契约（契约 §6.1/§7.3/§8.4）。
 *
 * 解析器对 schemaVersion 严格校验：缺失、非整数或不受支持的版本一律返回 null
 * （未知版本明确失败，不得静默按 v1 处理）。Serve 端始终携带当前版本。
 */

export const RUN_MODES: readonly string[] = ['dev', 'preview']
export const RUN_STATUSES: readonly string[] = ['running', 'starting', 'stopped', 'failed']
export const FS_EVENT_TYPES: readonly string[] = ['change', 'add', 'unlink', 'addDir', 'unlinkDir']

export type FsEventType = 'change' | 'add' | 'unlink' | 'addDir' | 'unlinkDir'

export interface FsEventPayload {
  readonly schemaVersion: number;
  readonly type: FsEventType;
  readonly path: string;
}

export interface WorkspaceEventPayload {
  readonly schemaVersion: number;
  readonly root: string;
  readonly name: string;
  readonly kind: WorkspaceKind;
}

export type RunMode = 'dev' | 'preview'
export type RunStatus = 'starting' | 'running' | 'stopped' | 'failed'

export interface RunEventPayload {
  readonly schemaVersion: number;
  readonly mode: RunMode;
  readonly status: RunStatus;
  readonly url?: string;
  readonly projectPath?: string;
  readonly detail?: string;
}

export interface RunLogEventPayload {
  readonly schemaVersion: number;
  readonly mode: RunMode;
  readonly stream: 'stdout' | 'stderr';
  readonly line: string;
  readonly sequence?: number;
  /**
   * 发出日志时的工作区会话（IDE serve 层注入）。客户端据此丢弃切根后迟到的
   * 旧会话日志（IDE-017-10：迟到行无根归属混入新标签终端）。
   */
  readonly workspaceSessionId?: string;
}

export function parseFsEvent (value: unknown): FsEventPayload | null {
  const payload = recordWithSupportedVersion(value)
  if (payload === null) return null
  if (typeof payload.type !== 'string' || !(FS_EVENT_TYPES as readonly string[]).includes(payload.type)) return null
  if (typeof payload.path !== 'string') return null
  return { schemaVersion: payload.schemaVersion, type: payload.type as FsEventType, path: payload.path }
}

export function parseWorkspaceEvent (value: unknown): WorkspaceEventPayload | null {
  const payload = recordWithSupportedVersion(value)
  if (payload === null) return null
  if (typeof payload.root !== 'string' || typeof payload.name !== 'string') return null
  return {
    schemaVersion: payload.schemaVersion,
    root: payload.root,
    name: payload.name,
    kind: parseWorkspaceKind(payload.kind),
  }
}

export function parseRunEvent (value: unknown): RunEventPayload | null {
  const payload = recordWithSupportedVersion(value)
  if (payload === null) return null
  if (typeof payload.mode !== 'string' || !(RUN_MODES as readonly string[]).includes(payload.mode)) return null
  if (typeof payload.status !== 'string' || !(RUN_STATUSES as readonly string[]).includes(payload.status)) return null
  return {
    schemaVersion: payload.schemaVersion,
    mode: payload.mode as RunMode,
    status: payload.status as RunStatus,
    ...(typeof payload.url === 'string' ? { url: payload.url } : {}),
    ...(typeof payload.projectPath === 'string' ? { projectPath: payload.projectPath } : {}),
    ...(typeof payload.detail === 'string' ? { detail: payload.detail } : {}),
  }
}

export function parseRunLogEvent (value: unknown): RunLogEventPayload | null {
  const payload = recordWithSupportedVersion(value)
  if (payload === null) return null
  if (typeof payload.mode !== 'string' || !(RUN_MODES as readonly string[]).includes(payload.mode)) return null
  if (payload.stream !== 'stdout' && payload.stream !== 'stderr') return null
  if (typeof payload.line !== 'string') return null
  return {
    schemaVersion: payload.schemaVersion,
    mode: payload.mode as RunMode,
    stream: payload.stream,
    line: payload.line,
    ...(typeof payload.sequence === 'number' && Number.isInteger(payload.sequence) && payload.sequence >= 0
      ? { sequence: payload.sequence }
      : {}),
    ...(typeof payload.workspaceSessionId === 'string' && payload.workspaceSessionId !== ''
      ? { workspaceSessionId: payload.workspaceSessionId }
      : {}),
  }
}

/** 要求 value 是对象且 schemaVersion 受支持；否则返回 null（缺失/未知版本明确失败）。 */
function recordWithSupportedVersion (value: unknown): (Record<string, unknown> & { readonly schemaVersion: number }) | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const check = checkSchemaVersion(record)
  if (!check.ok) return null
  return { ...record, schemaVersion: check.version }
}
