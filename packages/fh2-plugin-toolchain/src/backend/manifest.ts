// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Script } from 'node:vm'
import type { BuildDiagnostic } from '../build/types.js'
import { PluginBuildError } from '../build/types.js'
import { BACKEND_SOURCE_MANIFEST_FILE } from './contract.js'

export interface BackendFieldDeclaration {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'datetime' | 'json';
  readonly required?: boolean;
}

export interface BackendEntityDeclaration {
  readonly name: string;
  readonly description?: string;
  readonly fields: readonly BackendFieldDeclaration[];
  readonly indexes?: readonly { readonly columns: readonly string[]; readonly unique?: boolean }[];
}

export interface BackendHandlerDeclaration {
  readonly name: string;
  readonly description?: string;
  readonly path: string;
  readonly entry?: string;
  readonly allowlist?: readonly string[];
}

export interface BackendEventDeclaration {
  readonly type: string;
  readonly description?: string;
  readonly handler: string;
  readonly entry?: string;
  readonly allowlist?: readonly string[];
}

export interface BackendPluginManifest {
  readonly pluginId: string;
  readonly name: string;
  readonly version: string;
  readonly contractsRange?: string;
  readonly handlers: readonly BackendHandlerDeclaration[];
  readonly events?: readonly BackendEventDeclaration[];
  readonly entities?: readonly BackendEntityDeclaration[];
  readonly flows?: readonly string[];
}

export interface BackendBuildResult {
  readonly manifest: BackendPluginManifest;
  readonly watchDependencies: readonly string[];
}

/** 后端作者源码清单路径（源码侧统一为 fh2-plugin.json；产物侧仍输出 dist/backend/plugin.json）。 */
export function backendManifestPath (projectRoot: string): string {
  return resolve(projectRoot, 'backend', BACKEND_SOURCE_MANIFEST_FILE)
}

export function hasBackendPlugin (projectRoot: string): boolean {
  return existsSync(backendManifestPath(projectRoot))
}

export function readBackendPluginManifest (manifestPath: string): BackendPluginManifest {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
  } catch (error) {
    throw backendError('FH2_BACKEND_MANIFEST_READ_FAILED', `无法读取后端 plugin.json：${message(error)}`, manifestPath)
  }
  const diagnostics = validateBackendManifest(value, manifestPath)
  if (diagnostics.length > 0) throw new PluginBuildError(diagnostics)
  return value as BackendPluginManifest
}

export function buildBackendAssets (options: {
  readonly projectRoot: string;
  readonly candidateRoot: string;
  readonly frontendPluginId: string;
}): BackendBuildResult | undefined {
  const manifestPath = backendManifestPath(options.projectRoot)
  if (!existsSync(manifestPath)) return undefined
  const manifest = readBackendPluginManifest(manifestPath)
  if (manifest.pluginId !== options.frontendPluginId) {
    throw backendError(
      'FH2_BACKEND_PLUGIN_ID_MISMATCH',
      `前后端 pluginId 必须一致：前端=${options.frontendPluginId}，后端=${manifest.pluginId}`,
      manifestPath,
    )
  }

  const backendRoot = resolve(options.projectRoot, 'backend')
  const outputRoot = resolve(options.candidateRoot, 'backend')
  mkdirSync(outputRoot, { recursive: true })
  const files = new Map<string, { kind: 'handler' | 'event' | 'workflow'; source: string; entry?: string }>()
  for (const handler of manifest.handlers) {
    files.set(handler.path, { kind: 'handler', source: requireBackendFile(backendRoot, handler.path), entry: handler.entry ?? 'handle' })
  }
  for (const event of manifest.events ?? []) {
    files.set(event.handler, { kind: 'event', source: requireBackendFile(backendRoot, event.handler), entry: event.entry ?? 'handle' })
  }
  for (const flow of manifest.flows ?? []) {
    files.set(flow, { kind: 'workflow', source: requireBackendFile(backendRoot, flow) })
  }

  const assets: Array<{ kind: string; path: string; sha256: string; bytes: number }> = []
  for (const [path, file] of files) {
    if (file.kind !== 'workflow') validateScript(file.source, file.entry!, resolve(backendRoot, path))
    const target = resolve(outputRoot, path)
    mkdirSync(resolve(target, '..'), { recursive: true })
    copyFileSync(resolve(backendRoot, path), target)
    const bytes = Buffer.byteLength(file.source)
    assets.push({ kind: file.kind, path, sha256: createHash('sha256').update(file.source).digest('hex'), bytes })
  }
  writeFileSync(resolve(outputRoot, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(resolve(outputRoot, 'asset-manifest.json'), `${JSON.stringify({ schemaVersion: 1, assets }, null, 2)}\n`, 'utf8')
  return {
    manifest,
    watchDependencies: [manifestPath, ...[...files.keys()].map(path => resolve(backendRoot, path))],
  }
}

function validateBackendManifest (value: unknown, file: string): BuildDiagnostic[] {
  if (!isRecord(value)) return [diagnostic('FH2_BACKEND_MANIFEST_INVALID', '后端 plugin.json 必须是对象。', file)]
  const diagnostics: BuildDiagnostic[] = []
  for (const field of ['pluginId', 'name', 'version'] as const) {
    if (typeof value[field] !== 'string' || value[field].trim() === '')
      diagnostics.push(diagnostic('FH2_BACKEND_MANIFEST_INVALID', `后端 plugin.json 缺少 ${field}。`, file))
  }
  if (!Array.isArray(value.handlers) || value.handlers.length === 0) {
    diagnostics.push(diagnostic('FH2_BACKEND_MANIFEST_INVALID', '后端 plugin.json 至少声明一个 handlers 入口。', file))
  }
  validateNamedEntries(value.handlers, 'handlers', 'path', diagnostics, file)
  validateNamedEntries(value.events, 'events', 'handler', diagnostics, file, 'type')
  validateEntities(value.entities, diagnostics, file)
  if (value.flows !== undefined && (!Array.isArray(value.flows) || value.flows.some(item => typeof item !== 'string'))) {
    diagnostics.push(diagnostic('FH2_BACKEND_MANIFEST_INVALID', 'flows 必须是字符串路径数组。', file))
  }
  return diagnostics
}

function validateNamedEntries (
  value: unknown,
  label: string,
  pathField: 'path' | 'handler',
  diagnostics: BuildDiagnostic[],
  file: string,
  nameField: 'name' | 'type' = 'name',
): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic('FH2_BACKEND_MANIFEST_INVALID', `${label} 必须是数组。`, file))
    return
  }
  const names = new Set<string>()
  for (const item of value) {
    if (!isRecord(item) || typeof item[nameField] !== 'string' || typeof item[pathField] !== 'string') {
      diagnostics.push(diagnostic('FH2_BACKEND_MANIFEST_INVALID', `${label} 每项必须声明 ${nameField} 和 ${pathField}。`, file))
      continue
    }
    const name = item[nameField] as string
    if (names.has(name)) diagnostics.push(diagnostic('FH2_BACKEND_MANIFEST_INVALID', `${label} 重复声明 ${name}。`, file))
    names.add(name)
    if (!safeBackendRelativePath(item[pathField] as string, pathField === 'path' ? 'handlers/' : 'events/')) {
      diagnostics.push(diagnostic('FH2_BACKEND_ASSET_PATH_INVALID', `${label} 路径不安全：${item[pathField]}`, file))
    }
    if (item.allowlist !== undefined
      && (!Array.isArray(item.allowlist) || item.allowlist.some(permission => typeof permission !== 'string'))) {
      diagnostics.push(diagnostic('FH2_BACKEND_MANIFEST_INVALID', `${label}.${name}.allowlist 必须是字符串数组。`, file))
    }
  }
}

function validateEntities (value: unknown, diagnostics: BuildDiagnostic[], file: string): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic('FH2_BACKEND_MANIFEST_INVALID', 'entities 必须是数组。', file))
    return
  }
  const entityNames = new Set<string>()
  for (const entity of value) {
    if (!isRecord(entity) || typeof entity.name !== 'string' || !Array.isArray(entity.fields)) {
      diagnostics.push(diagnostic('FH2_BACKEND_MANIFEST_INVALID', 'entities 每项必须声明 name 和 fields。', file))
      continue
    }
    if (entityNames.has(entity.name)) diagnostics.push(diagnostic('FH2_BACKEND_MANIFEST_INVALID', `entities 重复声明 ${entity.name}。`, file))
    entityNames.add(entity.name)
    const fieldNames = new Set<string>()
    for (const field of entity.fields) {
      if (!isRecord(field) || typeof field.name !== 'string'
        || !['string', 'number', 'boolean', 'datetime', 'json'].includes(String(field.type))) {
        diagnostics.push(diagnostic('FH2_BACKEND_MANIFEST_INVALID', `Entity ${entity.name} 存在非法字段声明。`, file))
        continue
      }
      if (fieldNames.has(field.name)) diagnostics.push(diagnostic('FH2_BACKEND_MANIFEST_INVALID', `Entity ${entity.name} 重复字段 ${field.name}。`, file))
      fieldNames.add(field.name)
    }
  }
}

function requireBackendFile (backendRoot: string, path: string): string {
  if (!safeBackendRelativePath(path)) throw backendError('FH2_BACKEND_ASSET_PATH_INVALID', `后端资产路径不安全：${path}`, path)
  const sourcePath = resolve(backendRoot, path)
  const fromRoot = relative(backendRoot, sourcePath)
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`))
    throw backendError('FH2_BACKEND_ASSET_PATH_INVALID', `后端资产越过 backend 根目录：${path}`, sourcePath)
  try {
    if (!statSync(sourcePath).isFile()) throw new Error('不是普通文件')
    return readFileSync(sourcePath, 'utf8')
  } catch (error) {
    throw backendError('FH2_BACKEND_ASSET_MISSING', `后端资产不存在：${path}（${message(error)}）`, sourcePath)
  }
}

function validateScript (source: string, entry: string, file: string): void {
  try {
    const compiled = new Script(source, { filename: file })
    void compiled
  } catch (error) {
    throw backendError('FH2_BACKEND_SCRIPT_INVALID', `后端脚本语法错误：${message(error)}`, file)
  }
  const escaped = entry.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`(?:function\\s+${escaped}\\s*\\(|(?:var|let|const)\\s+${escaped}\\s*=)`).test(source)) {
    throw backendError('FH2_BACKEND_ENTRY_MISSING', `后端脚本未声明入口函数 ${entry}。`, file)
  }
}

function safeBackendRelativePath (path: string, prefix?: string): boolean {
  return path !== ''
    && !isAbsolute(path)
    && !path.includes('\\')
    && !path.split('/').includes('..')
    && (prefix === undefined || path.startsWith(prefix))
    && (path.endsWith('.js') || path.endsWith('.json'))
}

function backendError (code: string, text: string, file?: string): PluginBuildError {
  return new PluginBuildError([diagnostic(code, text, file)])
}

function diagnostic (code: string, text: string, file?: string): BuildDiagnostic {
  return { code, phase: 'config', message: text, ...(file === undefined ? {} : { file }) }
}

function isRecord (value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
