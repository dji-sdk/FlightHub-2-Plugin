// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { valid as validSemver } from 'semver'
import type { PluginManifest } from 'fh2-plugin-sdk'
import type { ValidationDiagnostic } from './diagnostics.js'
import { diagnosticAt } from './json-reader.js'
import type { ParsedManifest } from './json-reader.js'

const BUILD_OUTPUT_FIELDS = ['manifestVersion', 'engines', 'buildInfo'] as const

export function validateManifestSemantics (
  manifest: PluginManifest,
  parsed: ParsedManifest,
): readonly ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = []

  for (const field of BUILD_OUTPUT_FIELDS) {
    if (Object.hasOwn(manifest, field)) {
      diagnostics.push(diagnosticAt(parsed, [field], {
        code: 'FH2_SOURCE_BUILD_FIELD',
        phase: 'semantic',
        message: `Source Manifest 不得包含构建产物字段 ${JSON.stringify(field)}。`,
      }))
    }
  }

  if (!/^[0-9]/.test(manifest.version)
    || manifest.version.trim() !== manifest.version
    || validSemver(manifest.version, { loose: false }) === null) {
    diagnostics.push(diagnosticAt(parsed, ['version'], {
      code: 'FH2_PLUGIN_VERSION_INVALID',
      phase: 'semantic',
      message: `插件版本 ${JSON.stringify(manifest.version)} 不是严格 SemVer。`,
    }))
  }

  collectDuplicateIds(manifest.extensions, 'FH2_EXTENSION_ID_DUPLICATE', ['extensions'], parsed, diagnostics)
  collectDuplicateIds(manifest.contributes?.icons ?? [], 'FH2_ICON_ID_DUPLICATE', ['contributes', 'icons'], parsed, diagnostics)
  validateConfig(manifest, parsed, diagnostics)
  return diagnostics
}

function collectDuplicateIds (
  values: readonly { readonly id: string }[],
  code: string,
  basePath: readonly string[],
  parsed: ParsedManifest,
  diagnostics: ValidationDiagnostic[],
): void {
  const seen = new Set<string>()
  for (const [index, value] of values.entries()) {
    if (seen.has(value.id)) {
      diagnostics.push(diagnosticAt(parsed, [...basePath, index, 'id'], {
        code,
        phase: 'semantic',
        message: `ID ${JSON.stringify(value.id)} 在插件内重复。`,
      }))
    }
    seen.add(value.id)
  }
}

function validateConfig (
  manifest: PluginManifest,
  parsed: ParsedManifest,
  diagnostics: ValidationDiagnostic[],
): void {
  const config = (manifest.config ?? {}) as Readonly<Record<string, Readonly<Record<string, unknown>>>>
  for (const [name, field] of Object.entries(config)) {
    const path = ['config', name] as const
    const type = field.type
    const defaultValue = field.default
    const defaultMatches = type === 'number'
      ? typeof defaultValue === 'number' && Number.isFinite(defaultValue)
      : type === 'boolean'
        ? typeof defaultValue === 'boolean'
        : typeof defaultValue === 'string'
    if (!defaultMatches) {
      diagnostics.push(diagnosticAt(parsed, [...path, 'default'], {
        code: 'FH2_CONFIG_DEFAULT_TYPE',
        phase: 'semantic',
        message: `Config ${JSON.stringify(name)} 的 default 必须是 ${String(type)}。`,
      }))
    }

    const forbidden = type === 'boolean'
      ? ['min', 'max', 'enum']
      : type === 'number'
        ? ['enum']
        : ['min', 'max']
    for (const option of forbidden) {
      if (Object.hasOwn(field, option)) {
        diagnostics.push(diagnosticAt(parsed, [...path, option], {
          code: 'FH2_CONFIG_OPTION_NOT_ALLOWED',
          phase: 'semantic',
          message: `Config 类型 ${String(type)} 不允许选项 ${JSON.stringify(option)}。`,
        }))
      }
    }

    if (type === 'number') {
      const min = field.min
      const max = field.max
      if (typeof min === 'number' && typeof max === 'number' && min > max) {
        diagnostics.push(diagnosticAt(parsed, path, {
          code: 'FH2_CONFIG_RANGE_INVALID',
          phase: 'semantic',
          message: `Config ${JSON.stringify(name)} 的 min 不能大于 max。`,
        }))
      }
      if (typeof defaultValue === 'number' && Number.isFinite(defaultValue)
        && ((typeof min === 'number' && defaultValue < min) || (typeof max === 'number' && defaultValue > max))) {
        diagnostics.push(diagnosticAt(parsed, [...path, 'default'], {
          code: 'FH2_CONFIG_DEFAULT_OUT_OF_RANGE',
          phase: 'semantic',
          message: `Config ${JSON.stringify(name)} 的 default 不在 min/max 范围内。`,
        }))
      }
    }

    if (type === 'string' && field.enum !== undefined) {
      const values = field.enum as readonly unknown[]
      if (values.length === 0 || (typeof defaultValue === 'string' && !values.includes(defaultValue))) {
        diagnostics.push(diagnosticAt(parsed, [...path, 'enum'], {
          code: 'FH2_CONFIG_ENUM_INVALID',
          phase: 'semantic',
          message: `Config ${JSON.stringify(name)} 的 enum 必须非空并包含 default。`,
        }))
      }
    }
  }
}
