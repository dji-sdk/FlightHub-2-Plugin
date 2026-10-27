// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 统一 Diagnostic 契约。
 *
 * - `line`/`column` 一律 1-based（实施计划 §3.4）；LSP 0-based 与 esbuild 列偏移
 *   在各自 adapter 转换一次后才进入本契约。
 * - `file` 为工作区相对 POSIX 路径；生成代码无原始位置时填生成文件路径，不猜测源码行。
 * - severity 允许 `info`：现有 Validate/Build 只产生 error/warning，属兼容超集。
 */
export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export const DIAGNOSTIC_SEVERITIES: readonly DiagnosticSeverity[] = ['error', 'warning', 'info']

/**
 * 诊断阶段：parse/schema/semantic/contract/code 来自现有 Validate 契约；
 * typecheck/bundle/goja-verify 来自 Build 诊断（演进计划 §3.3.2）。
 */
export type DiagnosticPhase =
  | 'parse'
  | 'schema'
  | 'semantic'
  | 'contract'
  | 'code'
  | 'typecheck'
  | 'bundle'
  | 'goja-verify'

export const DIAGNOSTIC_PHASES: readonly DiagnosticPhase[] = [
  'parse',
  'schema',
  'semantic',
  'contract',
  'code',
  'typecheck',
  'bundle',
  'goja-verify',
]

export interface Diagnostic {
  readonly code: string;
  readonly phase: DiagnosticPhase;
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
  readonly path?: string;
  readonly message: string;
  readonly hint?: string;
  readonly severity: DiagnosticSeverity;
}

/** 严格解析外部输入的 Diagnostic；结构不符返回 null，调用方决定丢弃或上报。 */
export function parseDiagnostic (value: unknown): Diagnostic | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.code !== 'string' || record.code === '') return null
  if (typeof record.message !== 'string') return null
  if (typeof record.file !== 'string') return null
  if (!isSeverity(record.severity)) return null
  if (!isPhase(record.phase)) return null
  const line = optionalPositiveInteger(record.line)
  if (record.line !== undefined && line === undefined) return null
  const column = optionalPositiveInteger(record.column)
  if (record.column !== undefined && column === undefined) return null
  return {
    code: record.code,
    phase: record.phase,
    file: record.file,
    message: record.message,
    severity: record.severity,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    ...(typeof record.path === 'string' ? { path: record.path } : {}),
    ...(typeof record.hint === 'string' ? { hint: record.hint } : {}),
  }
}

function isSeverity (value: unknown): value is DiagnosticSeverity {
  return DIAGNOSTIC_SEVERITIES.includes(value as DiagnosticSeverity)
}

function isPhase (value: unknown): value is DiagnosticPhase {
  return DIAGNOSTIC_PHASES.includes(value as DiagnosticPhase)
}

function optionalPositiveInteger (value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return undefined
  return value
}
