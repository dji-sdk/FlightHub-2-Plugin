// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { basename, dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv'
import type { ErrorObject } from 'ajv'
import { manifestSchema, points } from 'fh2-plugin-sdk'
import type { PluginManifest } from 'fh2-plugin-sdk'
import {
  sortValidationDiagnostics,
} from './diagnostics.js'
import type {
  ValidateSourceManifestOptions,
  ValidationDiagnostic,
  ValidationResult,
} from './diagnostics.js'
import { diagnosticAt, jsonPointerPath, parseStrictJson } from './json-reader.js'
import type { ParsedManifest } from './json-reader.js'
import { validateManifestPaths } from './path-validator.js'
import { validatePointContracts } from './point-contract-validator.js'
import type { StaticPointCatalog } from './point-contract-validator.js'
import {
  SdkResolutionError,
  SdkRuntimeContractError,
  TOOLCHAIN_SDK_VERSION,
  resolveProjectSdkContext,
} from './sdk-resolver.js'
import type { ProjectSdkContext } from './sdk-resolver.js'
import { validateManifestSemantics } from './semantic-validator.js'

const ajv = new Ajv({ allErrors: true })
const validateSchema = ajv.compile(manifestSchema)

export interface SdkValidationContext {
  readonly projectSdkVersion: string;
  readonly toolchainSdkVersion: string;
  readonly runtimeContract: ProjectSdkContext['runtimeContract'];
}

export type SourceManifestSnapshot = {
  readonly ok: true;
  readonly manifest: PluginManifest;
  readonly sdkContext: SdkValidationContext;
  readonly diagnostics: readonly [];
} | {
  readonly ok: false;
  readonly diagnostics: readonly ValidationDiagnostic[];
}

export interface ValidationDependencies {
  readonly resolveProjectSdkContext: (projectRoot: string) => ProjectSdkContext;
  readonly toolchainSdkVersion: string;
  readonly pointCatalog: StaticPointCatalog;
}

const DEFAULT_DEPENDENCIES: ValidationDependencies = {
  resolveProjectSdkContext,
  toolchainSdkVersion: TOOLCHAIN_SDK_VERSION,
  pointCatalog: points,
}

export function validateSourceManifest (options: ValidateSourceManifestOptions): ValidationResult {
  const snapshot = validateSourceManifestSnapshot(options)
  if (!snapshot.ok) return snapshot
  return { ok: true, manifest: snapshot.manifest, diagnostics: [], warnings: [] }
}

export function validateSourceManifestSnapshot (
  options: ValidateSourceManifestOptions,
  dependencies: ValidationDependencies = DEFAULT_DEPENDENCIES,
): SourceManifestSnapshot {
  const manifestPath = resolve(options.manifestPath)
  const projectRoot = dirname(manifestPath)
  const file = basename(manifestPath)
  let text: string
  try {
    text = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    return invalid([{
      code: 'FH2_MANIFEST_READ_FAILED',
      phase: 'parse',
      file,
      message: `无法读取 Manifest：${error instanceof Error ? error.message : String(error)}`,
    }])
  }

  const json = parseStrictJson(text, file)
  if (!json.ok) return invalid(json.diagnostics)

  let projectSdkContext: ProjectSdkContext
  try {
    projectSdkContext = dependencies.resolveProjectSdkContext(projectRoot)
  } catch (error) {
    if (!(error instanceof SdkResolutionError)) throw error
    const runtimeContractError = error instanceof SdkRuntimeContractError
    return invalid([{
      code: runtimeContractError ? 'FH2_SDK_RUNTIME_CONTRACT_INVALID' : 'FH2_SDK_VERSION_MISMATCH',
      phase: 'contract',
      file,
      message: error.message,
      hint: runtimeContractError
        ? `重新安装完整的 fh2-plugin-sdk@${dependencies.toolchainSdkVersion} 发布包。`
        : `安装精确版本 fh2-plugin-sdk@${dependencies.toolchainSdkVersion}。`,
    }])
  }
  if (projectSdkContext.projectSdkVersion !== dependencies.toolchainSdkVersion) {
    return invalid([{
      code: 'FH2_SDK_VERSION_MISMATCH',
      phase: 'contract',
      file,
      message: `项目 SDK ${projectSdkContext.projectSdkVersion} 与 Toolchain SDK ${dependencies.toolchainSdkVersion} 不一致。`,
      hint: `安装精确版本 fh2-plugin-sdk@${dependencies.toolchainSdkVersion}。`,
    }])
  }

  const schemaDiagnostics = validateManifestSchema(json.parsed)
  if (schemaDiagnostics.length > 0) return invalid(schemaDiagnostics)

  const manifest = deepFreeze(json.parsed.value as PluginManifest)
  const diagnostics = [
    ...validateManifestSemantics(manifest, json.parsed),
    ...validateManifestPaths(manifest, json.parsed),
    ...validatePointContracts(manifest, json.parsed, dependencies.pointCatalog),
  ]
  if (diagnostics.length > 0) return invalid(diagnostics)

  return {
    ok: true,
    manifest,
    sdkContext: Object.freeze({
      projectSdkVersion: projectSdkContext.projectSdkVersion,
      toolchainSdkVersion: dependencies.toolchainSdkVersion,
      runtimeContract: projectSdkContext.runtimeContract,
    }),
    diagnostics: [],
  }
}

function deepFreeze<T> (value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value)) deepFreeze(item)
  return value
}

function validateManifestSchema (parsed: ParsedManifest): readonly ValidationDiagnostic[] {
  if (validateSchema(parsed.value)) return []

  return (validateSchema.errors ?? []).map(error => schemaDiagnostic(parsed, error))
}

function schemaDiagnostic (parsed: ParsedManifest, error: ErrorObject): ValidationDiagnostic {
  const path = jsonPointerPath(error.instancePath, parsed.root)
  if (error.keyword === 'required' && typeof error.params.missingProperty === 'string')
    path.push(error.params.missingProperty)
  if (error.keyword === 'additionalProperties' && typeof error.params.additionalProperty === 'string')
    path.push(error.params.additionalProperty)
  if (error.keyword === 'propertyNames' && typeof error.params.propertyName === 'string')
    path.push(error.params.propertyName)

  const rootField = path.length === 1 ? path[0] : undefined
  if (error.keyword === 'additionalProperties'
    && typeof rootField === 'string'
    && ['trusted', 'trustLevel', 'sandbox'].includes(rootField)) {
    return diagnosticAt(parsed, path, {
      code: 'FH2_SOURCE_TRUST_FIELD',
      phase: 'semantic',
      message: `Source Manifest 不得声明安装信任字段 ${JSON.stringify(rootField)}。`,
    })
  }

  if (error.keyword === 'minItems' && path.length >= 3 && path[0] === 'config' && path.at(-1) === 'enum') {
    return diagnosticAt(parsed, path, {
      code: 'FH2_CONFIG_ENUM_INVALID',
      phase: 'semantic',
      message: 'Config enum 必须非空并包含 default。',
    })
  }

  if (error.keyword === 'pattern' && isResourcePath(path)) {
    return diagnosticAt(parsed, path, {
      code: 'FH2_RESOURCE_PATH_INVALID',
      phase: 'semantic',
      message: '资源路径必须是以 ./ 开头的非空正斜杠相对路径。',
    })
  }

  const received = valueAtPath(parsed.value, path)
  const valuePart = received === undefined ? '' : `，收到值 ${summarizeValue(received)}`
  return diagnosticAt(parsed, path, {
    code: 'FH2_MANIFEST_SCHEMA_INVALID',
    phase: 'schema',
    message: `Manifest Schema 校验失败：${error.message ?? error.keyword}（路径 /${path.join('/')}${valuePart}）。`,
  })
}

function valueAtPath (value: unknown, path: readonly (string | number)[]): unknown {
  let current: unknown = value
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string | number, unknown>)[segment]
    if (current === undefined) return undefined
  }
  return current
}

function summarizeValue (value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  const serialized = JSON.stringify(value)
  if (serialized === undefined) return String(value)
  return serialized.length > 80 ? `${serialized.slice(0, 77)}…` : serialized
}

function isResourcePath (path: readonly (string | number)[]): boolean {
  if (path.length === 1 && path[0] === 'entry') return true
  if (path[0] === 'views' && (path.at(-1) === 'entry' || path.includes('styles'))) return true
  return path[0] === 'contributes' && path[1] === 'icons' && path.at(-1) === 'src'
}

function invalid (diagnostics: readonly ValidationDiagnostic[]): SourceManifestSnapshot {
  return { ok: false, diagnostics: sortValidationDiagnostics(diagnostics) }
}

export type {
  ValidateSourceManifestOptions,
  ValidationDiagnostic,
  ValidationPhase,
  ValidationResult,
} from './diagnostics.js'
export {
  formatValidationIssue,
  formatValidationResultJson,
  formatValidationResultText,
  sortValidationDiagnostics,
} from './diagnostics.js'
