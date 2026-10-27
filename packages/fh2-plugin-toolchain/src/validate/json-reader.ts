// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import {
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser'
import type { Node, ParseError } from 'jsonc-parser'
import type { ValidationDiagnostic, ValidationPhase } from './diagnostics.js'

export type ManifestPath = readonly (string | number)[]

export interface ParsedManifest {
  readonly text: string;
  readonly root: Node;
  readonly value: unknown;
  readonly file: string;
}

export type StrictJsonResult =
  | { readonly ok: true; readonly parsed: ParsedManifest }
  | { readonly ok: false; readonly diagnostics: readonly ValidationDiagnostic[] }

export function parseStrictJson (text: string, file: string): StrictJsonResult {
  const parseErrors: ParseError[] = []
  const root = parseTree(text, parseErrors, {
    allowTrailingComma: false,
    disallowComments: true,
    allowEmptyContent: false,
  })
  const diagnostics: ValidationDiagnostic[] = parseErrors.map((error) => {
    const location = offsetLocation(text, error.offset)
    return {
      code: 'FH2_MANIFEST_JSON_INVALID',
      phase: 'parse',
      file,
      ...location,
      message: `Manifest 不是严格 JSON：${printParseErrorCode(error.error)}。`,
    }
  })

  if (root !== undefined) collectDuplicateKeys(root, [], text, file, diagnostics)
  if (root === undefined && diagnostics.length === 0) {
    diagnostics.push({
      code: 'FH2_MANIFEST_JSON_INVALID',
      phase: 'parse',
      file,
      line: 1,
      column: 1,
      message: 'Manifest 不是有效 JSON。',
    })
  }

  if (diagnostics.length > 0 || root === undefined) return { ok: false, diagnostics }
  return { ok: true, parsed: { text, root, value: getNodeValue(root), file } }
}

export function diagnosticAt (
  parsed: ParsedManifest,
  path: ManifestPath,
  diagnostic: {
    readonly code: string;
    readonly phase: ValidationPhase;
    readonly message: string;
    readonly hint?: string;
  },
): ValidationDiagnostic {
  const node = findNodeAtLocation(parsed.root, [...path])
  return {
    ...diagnostic,
    file: parsed.file,
    path: pathToString(path),
    ...(node === undefined ? {} : offsetLocation(parsed.text, node.offset)),
  }
}

export function pathToString (path: ManifestPath): string {
  return path.map((segment, index) => {
    if (typeof segment === 'number') return `[${segment}]`
    if (/^[A-Za-z_$][\w$]*$/.test(segment)) return index === 0 ? segment : `.${segment}`
    return `[${JSON.stringify(segment)}]`
  }).join('')
}

export function jsonPointerPath (pointer: string, root?: Node): Array<string | number> {
  if (pointer === '') return []
  const path: Array<string | number> = []
  let current = root
  for (const segment of pointer.slice(1).split('/')) {
    const decoded = segment.replace(/~1/g, '/').replace(/~0/g, '~')
    const value = current?.type === 'array' && /^\d+$/.test(decoded) ? Number(decoded) : decoded
    path.push(value)
    current = current === undefined ? undefined : findNodeAtLocation(current, [value])
  }
  return path
}

function collectDuplicateKeys (
  node: Node,
  path: Array<string | number>,
  text: string,
  file: string,
  diagnostics: ValidationDiagnostic[],
): void {
  if (node.type === 'object') {
    const seen = new Set<string>()
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0]
      const valueNode = property.children?.[1]
      const key = keyNode?.value
      if (typeof key !== 'string') continue
      if (seen.has(key) && keyNode !== undefined) {
        diagnostics.push({
          code: 'FH2_MANIFEST_DUPLICATE_KEY',
          phase: 'parse',
          file,
          path: pathToString([...path, key]),
          ...offsetLocation(text, keyNode.offset),
          message: `JSON 对象中的 key ${JSON.stringify(key)} 重复。`,
        })
      }
      seen.add(key)
      if (valueNode !== undefined) collectDuplicateKeys(valueNode, [...path, key], text, file, diagnostics)
    }
    return
  }

  if (node.type === 'array') {
    for (const [index, child] of (node.children ?? []).entries())
      collectDuplicateKeys(child, [...path, index], text, file, diagnostics)
  }
}

function offsetLocation (text: string, offset: number): { readonly line: number; readonly column: number } {
  const before = text.slice(0, offset)
  const lastLineFeed = before.lastIndexOf('\n')
  return {
    line: before.split('\n').length,
    column: offset - lastLineFeed,
  }
}
