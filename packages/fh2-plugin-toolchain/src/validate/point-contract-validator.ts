// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { isCssLength } from 'fh2-plugin-sdk'
import type { FieldSpec, PluginManifest } from 'fh2-plugin-sdk'
import type { ValidationDiagnostic } from './diagnostics.js'
import { diagnosticAt } from './json-reader.js'
import type { ParsedManifest } from './json-reader.js'

export interface StaticPointCatalog {
  readonly [pointId: string]: {
    readonly contract: Readonly<Record<string, FieldSpec>>;
  };
}

const LAYOUT_FIELDS = new Set(['layer', 'zIndex', 'slot', 'priority', 'order'])

export function validatePointContracts (
  manifest: PluginManifest,
  parsed: ParsedManifest,
  pointCatalog: StaticPointCatalog,
): readonly ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = []
  const viewIds = new Set(Object.keys(manifest.views ?? {}))
  const iconIds = new Set((manifest.contributes?.icons ?? []).map(icon => icon.id))

  for (const [index, extension] of manifest.extensions.entries()) {
    const contract = pointCatalog[extension.point]?.contract
    if (contract === undefined) continue
    const basePath = ['extensions', index] as const

    for (const field of Object.keys(extension)) {
      if (field === 'id' || field === 'point') continue
      const path = [...basePath, field]
      if (LAYOUT_FIELDS.has(field)) {
        diagnostics.push(diagnosticAt(parsed, path, {
          code: 'FH2_EXTENSION_LAYOUT_FIELD_FORBIDDEN',
          phase: 'contract',
          message: `Extension 不允许声明布局或顺序字段 ${JSON.stringify(field)}。`,
        }))
        continue
      }
      const fieldSpec = contract[field]
      const code = fieldSpec?.kind === 'state'
        ? 'FH2_EXTENSION_STATE_IN_MANIFEST'
        : fieldSpec?.kind === 'method'
          ? 'FH2_EXTENSION_METHOD_IN_MANIFEST'
          : fieldSpec === undefined
            ? 'FH2_EXTENSION_FIELD_UNKNOWN'
            : undefined
      if (code !== undefined) {
        diagnostics.push(diagnosticAt(parsed, path, {
          code,
          phase: 'contract',
          message: `字段 ${JSON.stringify(field)} 不是 Point ${JSON.stringify(extension.point)} 可声明的 static 字段。`,
        }))
      }
    }

    for (const [field, fieldSpec] of Object.entries(contract)) {
      if (fieldSpec.kind !== 'static') continue
      const path = [...basePath, field]
      const hasValue = Object.hasOwn(extension, field)
      if (!hasValue && fieldSpec.optional !== true && !Object.hasOwn(fieldSpec, 'default')) {
        diagnostics.push(diagnosticAt(parsed, path, {
          code: 'FH2_EXTENSION_STATIC_REQUIRED',
          phase: 'contract',
          message: `Point ${JSON.stringify(extension.point)} 要求 static 字段 ${JSON.stringify(field)}。`,
        }))
        continue
      }
      if (!hasValue) continue
      const value = extension[field]
      if (!matchesStaticType(value, fieldSpec)) {
        diagnostics.push(diagnosticAt(parsed, path, {
          code: 'FH2_EXTENSION_STATIC_TYPE',
          phase: 'contract',
          message: `Point ${JSON.stringify(extension.point)} 的 static 字段 ${JSON.stringify(field)} 类型必须是 ${fieldSpec.type}。`,
        }))
        continue
      }
      if (fieldSpec.type === 'enum' && !(fieldSpec.values ?? []).includes(value as string)) {
        diagnostics.push(diagnosticAt(parsed, path, {
          code: 'FH2_EXTENSION_STATIC_ENUM',
          phase: 'contract',
          message: `static 字段 ${JSON.stringify(field)} 不属于 Point 声明的 enum。`,
        }))
      }
      if (fieldSpec.type === 'viewId' && !viewIds.has(value as string)) {
        diagnostics.push(diagnosticAt(parsed, path, {
          code: 'FH2_MANIFEST_VIEW_NOT_FOUND',
          phase: 'contract',
          message: `Extension ${JSON.stringify(extension.id)} 引用了未声明的 View ${JSON.stringify(value)}。`,
          hint: '在 views 中声明该 View，或修正 Extension static 字段。',
        }))
      }
      if (fieldSpec.type === 'iconId' && !iconIds.has(value as string)) {
        diagnostics.push(diagnosticAt(parsed, path, {
          code: 'FH2_MANIFEST_ICON_NOT_FOUND',
          phase: 'contract',
          message: `Extension ${JSON.stringify(extension.id)} 引用了未声明的 Icon ${JSON.stringify(value)}。`,
          hint: '在 contributes.icons 中声明该 Icon，或修正 Extension static 字段。',
        }))
      }
    }

    if (extension.point === 'project.sidebar-actions') {
      const path = extension.path
      if (typeof path === 'string' && (!path.startsWith('/') || path.startsWith('//'))) {
        diagnostics.push(diagnosticAt(parsed, [...basePath, 'path'], {
          code: 'FH2_PROJECT_SIDEBAR_PATH_INVALID',
          phase: 'contract',
          message: 'Project 侧栏 path 必须以单个 / 开头。',
        }))
      }
      const position = extension.position
      if (position !== undefined && (
        typeof position !== 'number' || !Number.isInteger(position) || position < 0
      )) {
        diagnostics.push(diagnosticAt(parsed, [...basePath, 'position'], {
          code: 'FH2_PROJECT_SIDEBAR_POSITION_INVALID',
          phase: 'contract',
          message: 'Project 侧栏 position 必须是非负整数。',
        }))
      }
    }
  }

  return diagnostics
}

function matchesStaticType (value: unknown, fieldSpec: FieldSpec): boolean {
  switch (fieldSpec.type) {
    case 'string':
    case 'enum':
    case 'iconId':
    case 'viewId':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'cssLength':
      return isCssLength(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'method':
      return false
  }
}
