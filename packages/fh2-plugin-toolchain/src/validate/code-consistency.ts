// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import {
  getCapabilityDescriptor,
  isCapabilityId,
  isPluginCapabilityId,
} from 'fh2-plugin-sdk'
import type { PluginManifest } from 'fh2-plugin-sdk'
import {
  resolveBuildDescriptor,
  resolvePluginSourceEntry,
  resolveViewSourceEntry,
} from '../build/paths.js'
import type { ResolvedBuildDescriptor } from '../build/paths.js'
import { PluginBuildError } from '../build/types.js'
import { sortValidationDiagnostics } from './diagnostics.js'
import type { ValidationDiagnostic } from './diagnostics.js'

export interface CodeConsistencyOptions {
  readonly manifest: PluginManifest;
  readonly manifestPath: string;
  readonly descriptor?: ResolvedBuildDescriptor;
}

const CONTRIBUTE_PATTERN = /\bcontribute\s*\(\s*['"]([^'"]+)['"]/g
const VIEWS_GET_PATTERN = /\bviews\.get\s*\(\s*['"]([^'"]+)['"]/g
const VUE_IMPORT_PATTERN = /(?:\bfrom\s*['"]vue['"]|\bimport\s*['"]vue['"])/g
const DOM_ACCESS_PATTERN = /\b(?:document|window)\s*\./g
const HANDWRITTEN_CONTEXT_PATTERN = /\b(?:Cockpit)?PluginContext\s*<[\s\S]{0,2048}?,\s*\{/g
const GENERATED_TYPES_IMPORT_PATTERN = /(?:from\s*['"][^'"]*generated\/plugin-types['"]|import\s*['"][^'"]*generated\/plugin-types['"])/g
const codePositionCache = new Map<string, readonly boolean[]>()

/** 这两类错误会让 Manifest 与源码类型映射脱钩，validate/build 必须阻断。 */
export function isBlockingCodeConsistencyDiagnostic (diagnostic: ValidationDiagnostic): boolean {
  return diagnostic.code === 'FH2_CODE_CONTEXT_HANDWRITTEN'
    || diagnostic.code === 'FH2_CODE_GENERATED_TYPES_UNUSED'
}

/** Manifest 合法后调用；除显式标记的类型映射错误外，其余结果均为不阻断构建的双语 warning。 */
export function checkSourceCodeConsistency (
  options: CodeConsistencyOptions,
): readonly ValidationDiagnostic[] {
  codePositionCache.clear()
  const projectRoot = dirname(resolve(options.manifestPath))
  const descriptor = options.descriptor ?? resolveBuildDescriptor(projectRoot, {
    manifestPath: options.manifestPath,
  })
  const warnings: ValidationDiagnostic[] = []
  const entryFile = resolveEntry(descriptor, warnings)
  const viewFiles = resolveViews(descriptor, options.manifest, warnings)
  const hostFiles = listSourceFiles(join(projectRoot, 'src', 'hosts'))
  const runtimeFiles = uniqueFiles([
    ...(entryFile === undefined ? [] : [entryFile]),
    ...hostFiles,
  ])
  const sourceFiles = uniqueFiles([
    ...runtimeFiles,
    ...viewFiles,
  ])
  const sources = new Map(sourceFiles.map(file => [file, readText(file)]))
  const runtimeSources = new Map(runtimeFiles.map(file => [file, sources.get(file) ?? '']))
  const allSourceFiles = listSourceFiles(join(projectRoot, 'src'))
  const allSources = new Map(allSourceFiles.map(file => [file, readText(file)]))

  checkEntryShape(projectRoot, entryFile, entryFile === undefined ? undefined : sources.get(entryFile), warnings)
  checkDeclaredExtensions(projectRoot, options.manifest, runtimeSources, warnings)
  checkSourceReferences(projectRoot, options.manifest, sources, warnings)
  checkCapabilities(projectRoot, options.manifest, sources, warnings)
  checkEntryVueOrDom(projectRoot, entryFile, entryFile === undefined ? undefined : sources.get(entryFile), warnings)
  checkPackageName(projectRoot, options.manifest, warnings)
  checkGeneratedTypeUsage(projectRoot, options.manifest, allSources, warnings)

  return sortValidationDiagnostics(warnings)
}

function checkGeneratedTypeUsage (
  projectRoot: string,
  manifest: PluginManifest,
  sources: ReadonlyMap<string, string>,
  warnings: ValidationDiagnostic[],
): void {
  if (manifest.extensions.length === 0) return
  let importsGeneratedTypes = false
  for (const [file, text] of sources) {
    if (hasCodeMatch(text, GENERATED_TYPES_IMPORT_PATTERN)) importsGeneratedTypes = true
    for (const match of codeMatches(text, HANDWRITTEN_CONTEXT_PATTERN)) {
      warnings.push(warning(
        'FH2_CODE_CONTEXT_HANDWRITTEN',
        relative(projectRoot, file),
        '源码不得手写 PluginContext<Config, {Extension: Point}> 映射，请使用 src/generated/plugin-types.ts 导出的 App*Context。Source must use App*Context exported by src/generated/plugin-types.ts instead of a handwritten extension-to-point map.',
        lineAt(text, match.index),
      ))
    }
  }
  if (importsGeneratedTypes) return
  warnings.push(warning(
    'FH2_CODE_GENERATED_TYPES_UNUSED',
    'src/plugin.ts',
    '插件声明了 Extension，但源码未导入 generated/plugin-types；Manifest 的扩展 ID、Point 和 Config 变更无法参与类型检查。Plugin declares extensions but does not import generated/plugin-types, so Manifest changes cannot participate in type checking.',
  ))
}

function resolveEntry (
  descriptor: ResolvedBuildDescriptor,
  warnings: ValidationDiagnostic[],
): string | undefined {
  try {
    return resolvePluginSourceEntry(descriptor)
  } catch (error) {
    warnings.push(layoutWarning(error, descriptor.projectRoot, 'FH2_CODE_ENTRY_DEFINE_PLUGIN'))
    return undefined
  }
}

function resolveViews (
  descriptor: ResolvedBuildDescriptor,
  manifest: PluginManifest,
  warnings: ValidationDiagnostic[],
): readonly string[] {
  const files: string[] = []
  for (const viewId of Object.keys(manifest.views ?? {})) {
    try {
      const entry = resolveViewSourceEntry(descriptor, viewId)
      const isFlatEntry = dirname(entry) === join(descriptor.projectRoot, 'src', 'views')
      files.push(...(isFlatEntry ? [entry] : listSourceFiles(dirname(entry))))
    } catch (error) {
      const code = error instanceof PluginBuildError
        && error.diagnostics.some(diagnostic => diagnostic.code === 'FH2_VIEW_ENTRY_AMBIGUOUS')
        ? 'FH2_CODE_VIEW_SOURCE_AMBIGUOUS'
        : 'FH2_CODE_VIEW_SOURCE_MISSING'
      warnings.push(layoutWarning(error, descriptor.projectRoot, code))
    }
  }
  return uniqueFiles(files)
}

function checkEntryShape (
  projectRoot: string,
  entryFile: string | undefined,
  entryText: string | undefined,
  warnings: ValidationDiagnostic[],
): void {
  const file = entryFile === undefined ? 'src/plugin.ts' : relative(projectRoot, entryFile)
  if (entryText === undefined) return
  if (!hasCodeMatch(entryText, /\bexport\s+default\b/g)) {
    warnings.push(warning(
      'FH2_CODE_ENTRY_DEFINE_PLUGIN',
      file,
      'Entry 源码缺少默认导出。Entry source has no default export.',
    ))
    return
  }
  if (!hasDefinePluginDefaultExport(entryText)) {
    warnings.push(warning(
      'FH2_CODE_ENTRY_DEFINE_PLUGIN',
      file,
      'Entry 源码未调用 definePlugin()。Entry source does not call definePlugin().',
    ))
  }
}

function hasDefinePluginDefaultExport (text: string): boolean {
  if (hasCodeMatch(text, /\bexport\s+default\s+definePlugin\s*\(/g)) return true
  for (const match of codeMatches(text, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*definePlugin\s*\(/g)) {
    const name = match[1]!
    if (hasCodeMatch(text, new RegExp(`\\bexport\\s+default\\s+${escapeRegExp(name)}\\b`, 'g'))) return true
  }
  return false
}

function checkDeclaredExtensions (
  projectRoot: string,
  manifest: PluginManifest,
  sources: ReadonlyMap<string, string>,
  warnings: ValidationDiagnostic[],
): void {
  const contributed = new Set<string>()
  for (const text of sources.values()) {
    for (const match of codeMatches(text, CONTRIBUTE_PATTERN)) contributed.add(match[1]!)
  }
  for (const extension of manifest.extensions) {
    if (contributed.has(extension.id)) continue
    warnings.push(warning(
      'FH2_CODE_EXTENSION_NOT_CONTRIBUTED',
      relative(projectRoot, join(projectRoot, 'src', 'plugin.ts')),
      `Manifest 声明的 extension "${extension.id}" 未在源码中找到 contribute 调用。No contribute call found for declared extension "${extension.id}".`,
    ))
  }
}

function checkSourceReferences (
  projectRoot: string,
  manifest: PluginManifest,
  sources: ReadonlyMap<string, string>,
  warnings: ValidationDiagnostic[],
): void {
  const extensionIds = new Set(manifest.extensions.map(extension => extension.id))
  const viewIds = new Set(Object.keys(manifest.views ?? {}))
  const configKeys = new Set(Object.keys(manifest.config ?? {}))
  for (const [file, text] of sources) {
    collectLiteralReferences(projectRoot, file, text, CONTRIBUTE_PATTERN, extensionIds, 'extension', warnings)
    collectLiteralReferences(projectRoot, file, text, VIEWS_GET_PATTERN, viewIds, 'view', warnings)
    collectConfigReferences(projectRoot, file, text, configKeys, warnings)
  }
}

function collectLiteralReferences (
  projectRoot: string,
  file: string,
  text: string,
  pattern: RegExp,
  declared: ReadonlySet<string>,
  kind: 'extension' | 'view',
  warnings: ValidationDiagnostic[],
): void {
  const seen = new Set<string>()
  for (const match of codeMatches(text, pattern)) {
    const id = match[1]!
    if (declared.has(id) || seen.has(id)) continue
    seen.add(id)
    warnings.push(warning(
      'FH2_CODE_REFERENCE_NOT_DECLARED',
      relative(projectRoot, file),
      `源码引用了 Manifest 未声明的 ${kind} ID "${id}"。Source references ${kind} ID "${id}" not declared in Manifest.`,
      lineAt(text, match.index),
    ))
  }
}

function collectConfigReferences (
  projectRoot: string,
  file: string,
  text: string,
  declared: ReadonlySet<string>,
  warnings: ValidationDiagnostic[],
): void {
  const aliases = collectContextAliases(text, 'config')
  aliases.add('ctx.config')
  const seen = new Set<string>()
  for (const alias of aliases) {
    const pattern = new RegExp(`\\b${escapeRegExp(alias)}(?:\\.([A-Za-z_$][\\w$]*)|\\s*\\[\\s*['"]([^'"]+)['"]\\s*\\])`, 'g')
    for (const match of codeMatches(text, pattern)) {
      const key = match[1] ?? match[2]
      if (key === undefined || declared.has(key) || seen.has(key)) continue
      seen.add(key)
      warnings.push(warning(
        'FH2_CODE_REFERENCE_NOT_DECLARED',
        relative(projectRoot, file),
        `源码引用了 Manifest 未声明的 config key "${key}"。Source references config key "${key}" not declared in Manifest.`,
        lineAt(text, match.index),
      ))
    }
  }
}

function checkCapabilities (
  projectRoot: string,
  manifest: PluginManifest,
  sources: ReadonlyMap<string, string>,
  warnings: ValidationDiagnostic[],
): void {
  const granted = new Set(manifest.permissions ?? [])
  for (const [file, text] of sources) {
    const aliases = collectContextAliases(text, 'capabilities')
    aliases.add('ctx.capabilities')
    const seen = new Set<string>()
    for (const alias of aliases) {
      const pattern = new RegExp(`\\b${escapeRegExp(alias)}\\.get\\s*\\(\\s*['"]([^'"]+)['"]`, 'g')
      for (const match of codeMatches(text, pattern)) {
        const id = match[1]!
        if (seen.has(id)) continue
        seen.add(id)
        if (!isCapabilityId(id)) {
          warnings.push(warning(
            'FH2_CODE_CAPABILITY_NOT_IN_CATALOG',
            relative(projectRoot, file),
            `Capability "${id}" 不在当前 SDK Catalog 中。Capability "${id}" is not in the current SDK Catalog.`,
            lineAt(text, match.index),
          ))
          continue
        }
        if (!isPluginCapabilityId(id)) {
          warnings.push(warning(
            'FH2_CODE_CAPABILITY_NOT_PLUGIN_ACCESSIBLE',
            relative(projectRoot, file),
            `Capability "${id}" 应使用 PluginContext 顶层 facade，而不是 ctx.capabilities。Capability "${id}" must use its top-level PluginContext facade instead of ctx.capabilities.`,
            lineAt(text, match.index),
          ))
          continue
        }
        const descriptor = getCapabilityDescriptor(id)!
        const sourceHost = sourceHostId(projectRoot, file)
        const capabilityHost = capabilityHostId(id)
        if (sourceHost !== undefined && capabilityHost !== undefined && sourceHost !== capabilityHost) {
          warnings.push(warning(
            'FH2_CODE_CAPABILITY_HOST_MISMATCH',
            relative(projectRoot, file),
            `Capability "${id}" 属于 ${capabilityHost} Host，当前源码位于 ${sourceHost} Host。Capability "${id}" belongs to the ${capabilityHost} Host, but this source belongs to the ${sourceHost} Host.`,
            lineAt(text, match.index),
          ))
        }
        if (!granted.has(descriptor.permission)) {
          warnings.push(warning(
            'FH2_CODE_CAPABILITY_PERMISSION_MISSING',
            relative(projectRoot, file),
            `Capability "${id}" 需要 Manifest permission "${descriptor.permission}"。Capability "${id}" requires Manifest permission "${descriptor.permission}".`,
            lineAt(text, match.index),
          ))
        }
      }
    }
  }
}

function sourceHostId (projectRoot: string, file: string): string | undefined {
  const normalized = relative(projectRoot, file).replaceAll('\\', '/')
  return /^src\/hosts\/([^/]+)\//.exec(normalized)?.[1]
}

function capabilityHostId (capabilityId: string): string | undefined {
  const domain = capabilityId.split(':', 1)[0]
  return domain === 'cockpit' || domain === 'message' || domain === 'project' ? domain : undefined
}

function checkEntryVueOrDom (
  projectRoot: string,
  entryFile: string | undefined,
  entryText: string | undefined,
  warnings: ValidationDiagnostic[],
): void {
  if (entryFile === undefined || entryText === undefined) return
  const file = relative(projectRoot, entryFile)
  const vueMatch = codeMatches(entryText, VUE_IMPORT_PATTERN)[0]
  if (vueMatch !== undefined) {
    warnings.push(warning(
      'FH2_CODE_ENTRY_VUE_OR_DOM',
      file,
      'Entry 不应直接 import Vue。Entry must not import Vue.',
      lineAt(entryText, vueMatch.index),
    ))
  }
  const domMatch = codeMatches(entryText, DOM_ACCESS_PATTERN)[0]
  if (domMatch !== undefined) {
    warnings.push(warning(
      'FH2_CODE_ENTRY_VUE_OR_DOM',
      file,
      'Entry 不应直接访问 DOM（document/window）。Entry must not access DOM (document/window).',
      lineAt(entryText, domMatch.index),
    ))
  }
}

function checkPackageName (
  projectRoot: string,
  manifest: PluginManifest,
  warnings: ValidationDiagnostic[],
): void {
  const packageFile = join(projectRoot, 'package.json')
  if (!existsSync(packageFile)) return
  let packageJson: { readonly name?: unknown }
  try {
    packageJson = JSON.parse(readText(packageFile)) as { readonly name?: unknown }
  } catch {
    return
  }
  if (typeof packageJson.name !== 'string' || packageJson.name === '') return
  const id = normalizePackageIdentity(manifest.id.replace(/^(?:official|exp)_/, ''))
  const normalizedName = normalizePackageIdentity(packageJson.name.replace(/^@[^/]+\//, ''))
  if (normalizedName !== id && !normalizedName.includes(id) && !id.includes(normalizedName)) {
    warnings.push(warning(
      'FH2_CODE_PACKAGE_NAME_MISMATCH',
      'package.json',
      `Manifest id "${manifest.id}" 与 package.json name "${packageJson.name}" 不一致。Manifest id does not match package.json name.`,
    ))
  }
}

function normalizePackageIdentity (value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, '')
}

function collectContextAliases (text: string, property: 'capabilities' | 'config' | 'extensions'): Set<string> {
  const aliases = new Set<string>()
  const pattern = /\b(?:const|let)\s*{([^}]+)}\s*=\s*ctx\b/g
  for (const match of codeMatches(text, pattern)) {
    for (const part of match[1]!.split(',')) {
      const aliasMatch = new RegExp(`^\\s*${property}(?:\\s*:\\s*([A-Za-z_$][\\w$]*))?\\s*$`).exec(part)
      if (aliasMatch !== null) aliases.add(aliasMatch[1] ?? property)
    }
  }
  return aliases
}

function codeMatches (text: string, pattern: RegExp): RegExpExecArray[] {
  const matches: RegExpExecArray[] = []
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (isCodePosition(text, match.index)) matches.push(match)
    if (match[0].length === 0) pattern.lastIndex++
  }
  return matches
}

function hasCodeMatch (text: string, pattern: RegExp): boolean {
  return codeMatches(text, pattern).length > 0
}

function isCodePosition (text: string, index: number): boolean {
  return codePositions(text)[index] === true
}

function codePositions (text: string): readonly boolean[] {
  const cached = codePositionCache.get(text)
  if (cached !== undefined) return cached
  const positions = Array.from({ length: text.length }, () => true)
  let state: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' = 'code'
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    const next = text[index + 1]
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line-comment'
        positions[index + 1] = false
      } else if (char === '/' && next === '*') {
        state = 'block-comment'
        positions[index + 1] = false
      } else if (char === '\'') {
        state = 'single'
      } else if (char === '"') {
        state = 'double'
      } else if (char === '`') {
        state = 'template'
      }
      continue
    }
    positions[index] = false
    if (state === 'line-comment' && char === '\n') {
      state = 'code'
    } else if (state === 'block-comment' && char === '*' && next === '/') {
      positions[index + 1] = false
      index++
      state = 'code'
    } else if (state === 'single' || state === 'double' || state === 'template') {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if ((state === 'single' && char === '\'')
        || (state === 'double' && char === '"')
        || (state === 'template' && char === '`')) {
        state = 'code'
      }
    }
  }
  codePositionCache.set(text, positions)
  return positions
}

function layoutWarning (error: unknown, projectRoot: string, fallbackCode: string): ValidationDiagnostic {
  const diagnostic = error instanceof PluginBuildError ? error.diagnostics[0] : undefined
  const message = diagnostic?.message ?? (error instanceof Error ? error.message : String(error))
  return warning(
    fallbackCode,
    diagnostic?.file === undefined ? 'fh2-plugin.json' : relative(projectRoot, diagnostic.file),
    `无法按 Build 规则解析源码布局：${message}。Source layout could not be resolved with Build rules: ${message}.`,
  )
}

function listSourceFiles (path: string): readonly string[] {
  if (!existsSync(path)) return []
  try {
    if (statSync(path).isFile()) return /\.(ts|tsx)$/.test(path) ? [path] : []
  } catch {
    return []
  }
  const result: string[] = []
  const visit = (current: string): void => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const entryPath = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'generated' || entry.name === 'node_modules' || entry.name === 'dist') continue
        visit(entryPath)
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        result.push(entryPath)
      }
    }
  }
  visit(path)
  return result.sort(compareStrings)
}

function uniqueFiles (files: readonly string[]): readonly string[] {
  return [...new Set(files)].sort(compareStrings)
}

function readText (file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function warning (code: string, file: string, message: string, line?: number): ValidationDiagnostic {
  return { code, phase: 'code', file, message, ...(line === undefined ? {} : { line }) }
}

function lineAt (text: string, index: number): number {
  return text.slice(0, Math.max(0, index)).split('\n').length
}

function escapeRegExp (value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compareStrings (left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
