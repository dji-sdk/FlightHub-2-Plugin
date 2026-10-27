// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PluginManifest } from 'fh2-plugin-sdk'

export type ValidationPhase = 'parse' | 'schema' | 'semantic' | 'contract' | 'code'

export interface ValidateSourceManifestOptions {
  readonly manifestPath: string;
}

export interface ValidationDiagnostic {
  readonly code: string;
  readonly phase: ValidationPhase;
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
  readonly path?: string;
  readonly message: string;
  readonly hint?: string;
}

export type ValidationResult = {
  readonly ok: true;
  readonly manifest: PluginManifest;
  readonly diagnostics: readonly [];
  readonly warnings: readonly ValidationDiagnostic[];
} | {
  readonly ok: false;
  readonly diagnostics: readonly ValidationDiagnostic[];
}

const PHASE_ORDER: Readonly<Record<ValidationPhase, number>> = {
  parse: 0,
  schema: 1,
  semantic: 2,
  contract: 3,
  code: 4,
}

export function sortValidationDiagnostics (
  diagnostics: readonly ValidationDiagnostic[],
): readonly ValidationDiagnostic[] {
  return [...diagnostics].sort((left, right) =>
    PHASE_ORDER[left.phase] - PHASE_ORDER[right.phase]
    || compareStrings(left.file, right.file)
    || compareStrings(left.path ?? '', right.path ?? '')
    || (left.line ?? 0) - (right.line ?? 0)
    || (left.column ?? 0) - (right.column ?? 0)
    || compareStrings(left.code, right.code),
  )
}

export function formatValidationIssue (diagnostic: ValidationDiagnostic): string {
  const position = diagnostic.line === undefined
    ? diagnostic.file
    : `${diagnostic.file}:${diagnostic.line}:${diagnostic.column ?? 1}`
  const location = diagnostic.path === undefined ? position : `${position}: ${diagnostic.path}`
  return `${diagnostic.code} ${location} - ${diagnostic.message}`
}

export function formatValidationResultText (result: ValidationResult, file: string): string {
  if (result.ok) {
    const warnings = sortValidationDiagnostics(result.warnings)
    if (warnings.length === 0) return `✓ ${file} 校验通过\n`
    const lines = [`✓ ${file} 校验通过`, '', ...warnings.map((warning) => {
      const position = warning.line === undefined
        ? warning.file
        : `${warning.file}:${warning.line}:${warning.column ?? 1}`
      const location = warning.path === undefined ? position : `${position}: ${warning.path}`
      const hint = warning.hint === undefined ? '' : `\n建议：${warning.hint}`
      return `[warning] ${warning.code}\n${location}\n\n${warning.message}${hint}`
    })]
    return `${lines.join('\n')}\n`
  }

  return `${sortValidationDiagnostics(result.diagnostics).map((diagnostic) => {
    const position = diagnostic.line === undefined
      ? diagnostic.file
      : `${diagnostic.file}:${diagnostic.line}:${diagnostic.column ?? 1}`
    const location = diagnostic.path === undefined ? position : `${position}: ${diagnostic.path}`
    const hint = diagnostic.hint === undefined ? '' : `\n建议：${diagnostic.hint}`
    return `${diagnostic.code}\n${location}\n\n${diagnostic.message}${hint}`
  }).join('\n\n')}\n`
}

export function formatValidationResultJson (result: ValidationResult): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    ok: result.ok,
    diagnostics: result.ok ? result.diagnostics : sortValidationDiagnostics(result.diagnostics),
    warnings: result.ok ? sortValidationDiagnostics(result.warnings) : [],
  }, null, 2)}\n`
}

function compareStrings (left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
