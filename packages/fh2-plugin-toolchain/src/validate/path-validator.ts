// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PluginManifest } from 'fh2-plugin-sdk'
import type { ValidationDiagnostic } from './diagnostics.js'
import { diagnosticAt } from './json-reader.js'
import type { ManifestPath, ParsedManifest } from './json-reader.js'

export function validateManifestPaths (
  manifest: PluginManifest,
  parsed: ParsedManifest,
): readonly ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = []
  validateResourcePath(manifest.entry, ['entry'], true, undefined, parsed, diagnostics)

  for (const [viewId, view] of Object.entries(manifest.views ?? {})) {
    validateResourcePath(view.entry, ['views', viewId, 'entry'], true, `./views/${viewId}.js`, parsed, diagnostics)
    for (const [index, style] of (view.styles ?? []).entries())
      validateResourcePath(style, ['views', viewId, 'styles', index], false, undefined, parsed, diagnostics)
  }

  for (const [index, icon] of (manifest.contributes?.icons ?? []).entries())
    validateResourcePath(icon.src, ['contributes', 'icons', index, 'src'], false, undefined, parsed, diagnostics)

  return diagnostics
}

function validateResourcePath (
  value: string,
  path: ManifestPath,
  entry: boolean,
  expectedViewEntry: string | undefined,
  parsed: ParsedManifest,
  diagnostics: ValidationDiagnostic[],
): void {
  const pathname = value.split(/[?#]/, 1)[0] ?? ''
  if (!value.startsWith('./') || value.startsWith('.//') || pathname.length <= 2 || pathname.includes('\\')) {
    diagnostics.push(diagnosticAt(parsed, path, {
      code: 'FH2_RESOURCE_PATH_INVALID',
      phase: 'semantic',
      message: `资源路径 ${JSON.stringify(value)} 必须是以 ./ 开头的非空正斜杠相对路径。`,
    }))
    return
  }

  if (hasTraversal(pathname)) {
    diagnostics.push(diagnosticAt(parsed, path, {
      code: 'FH2_RESOURCE_PATH_TRAVERSAL',
      phase: 'semantic',
      message: `资源路径 ${JSON.stringify(value)} 包含路径穿越或编码分隔符。`,
    }))
    return
  }

  if (entry && /[?#]/.test(value)) {
    diagnostics.push(diagnosticAt(parsed, path, {
      code: 'FH2_ENTRY_QUERY_NOT_ALLOWED',
      phase: 'semantic',
      message: `Entry ${JSON.stringify(value)} 不允许 query 或 fragment。`,
    }))
  }
  if (entry && !pathname.endsWith('.js')) {
    diagnostics.push(diagnosticAt(parsed, path, {
      code: 'FH2_ENTRY_EXTENSION_INVALID',
      phase: 'semantic',
      message: `Entry ${JSON.stringify(value)} 必须以 .js 结尾。`,
    }))
  }
  if (expectedViewEntry !== undefined && value !== expectedViewEntry) {
    diagnostics.push(diagnosticAt(parsed, path, {
      code: 'FH2_VIEW_OUTPUT_ENTRY_MISMATCH',
      phase: 'semantic',
      message: `View entry 必须是 ${JSON.stringify(expectedViewEntry)}。`,
    }))
  }
}

function hasTraversal (pathname: string): boolean {
  let decoded = pathname
  for (let iteration = 0; iteration < 3; iteration += 1) {
    if (/%(?:2f|5c)/i.test(decoded)) return true
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      return true
    }
    if (next.split(/[\\/]/).includes('..')) return true
    if (next === decoded) return false
    if (iteration > 0) return true
    decoded = next
  }
  return true
}
