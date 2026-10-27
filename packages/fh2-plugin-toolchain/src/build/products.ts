// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Rspack } from '@rsbuild/core'
import type { PluginManifest } from 'fh2-plugin-sdk'
import type { ResolvedPluginEntries } from '../rsbuild/context.js'
import type { BuildDiagnostic } from './types.js'
import { PluginBuildError } from './types.js'
import { PLUGIN_MODULE_POLICY } from './policy.js'

export interface ViewBuildProduct {
  readonly viewId: string;
  readonly entryFile: string;
  readonly cssFiles: readonly string[];
}

export interface BuildProducts {
  readonly pluginEntryFile: string;
  readonly views: readonly ViewBuildProduct[];
  readonly assets: readonly string[];
  readonly watchDependencies: readonly string[];
  readonly warnings: readonly BuildDiagnostic[];
}

interface EntrypointLike {
  getEntrypointChunk: () => { files: Iterable<string> } | undefined;
  getFiles: () => string[];
}

interface ModuleLike {
  readonly type?: string;
  readonly resource?: string;
  readonly modules?: Iterable<ModuleLike>;
  nameForCondition?: () => string | null;
}

interface CompilationLike {
  readonly assets: Record<string, unknown>;
  readonly entrypoints: Map<string, EntrypointLike>;
  readonly contextDependencies: Iterable<string>;
  readonly fileDependencies: Iterable<string>;
  readonly missingDependencies: Iterable<string>;
  readonly modules: Iterable<ModuleLike>;
}

export function collectBuildProducts (
  statsByEnvironment: ReadonlyMap<string, Rspack.Stats>,
  manifest: PluginManifest,
  entries: ResolvedPluginEntries,
): BuildProducts {
  const expectedEnvironments = Object.keys(entries.views).length === 0 ? ['plugin'] : ['plugin', 'views']
  const watchDependencies = collectWatchDependencies(statsByEnvironment)
  const unexpectedEnvironments = [...statsByEnvironment.keys()]
    .filter(environment => !expectedEnvironments.includes(environment))
  if (unexpectedEnvironments.length > 0) {
    throw new PluginBuildError([{
      code: 'FH2_UNEXPECTED_ENVIRONMENT_STATS',
      phase: 'compile',
      message: `Rsbuild 返回了未声明的 environment stats：${unexpectedEnvironments.sort().join(', ')}。`,
    }], watchDependencies)
  }
  for (const environment of expectedEnvironments) {
    if (!statsByEnvironment.has(environment)) {
      throw new PluginBuildError([{
        code: 'FH2_ENVIRONMENT_STATS_MISSING',
        phase: 'compile',
        message: `Rsbuild 未返回 ${environment} environment 的 compilation stats。`,
      }], watchDependencies)
    }
  }

  const warnings: BuildDiagnostic[] = []
  for (const [environment, stats] of statsByEnvironment) {
    const json = stats.toJson({ all: false, errors: true, warnings: true })
    if (stats.hasErrors()) {
      throw new PluginBuildError((json.errors ?? []).map(error => ({
        code: 'FH2_RSPACK_COMPILE_ERROR',
        phase: 'compile' as const,
        message: `[${environment}] ${formatStatsMessage(error)}`,
      })), watchDependencies)
    }
    warnings.push(...(json.warnings ?? []).map(warning => ({
      code: 'FH2_RSPACK_COMPILE_WARNING',
      phase: 'compile' as const,
      message: `[${environment}] ${formatStatsMessage(warning)}`,
    })))
  }

  const pluginStats = statsByEnvironment.get('plugin')!
  const pluginCompilation = pluginStats.compilation as unknown as CompilationLike
  const pluginEntryName = outputPathToEntryName(manifest.entry)
  requireExactEntrypoints(pluginCompilation, [pluginEntryName], 'plugin')
  const pluginEntrypoint = requireEntrypoint(pluginCompilation, pluginEntryName, 'Plugin')
  const pluginEntryFile = requireSingleEntryJs(pluginEntrypoint, 'Plugin')
  const pluginFiles = pluginEntrypoint.getFiles().map(normalizeAssetPath)
  if (pluginFiles.some(file => file.endsWith('.css'))) {
    throw new PluginBuildError([{
      code: 'FH2_PLUGIN_CSS_FORBIDDEN',
      phase: 'compile',
      message: 'Plugin Entry 模块图不得生成 CSS。',
    }])
  }
  validatePluginModules(pluginCompilation.modules, entries)

  const views: ViewBuildProduct[] = []
  const viewStats = statsByEnvironment.get('views')
  if (viewStats !== undefined) {
    const compilation = viewStats.compilation as unknown as CompilationLike
    requireExactEntrypoints(
      compilation,
      Object.keys(entries.views).map(viewId => `views/${viewId}`),
      'views',
    )
    for (const viewId of Object.keys(entries.views)) {
      const entrypoint = requireEntrypoint(compilation, `views/${viewId}`, `View ${viewId}`)
      views.push(Object.freeze({
        viewId,
        entryFile: requireSingleEntryJs(entrypoint, `View ${viewId}`),
        cssFiles: Object.freeze(entrypoint.getFiles().map(normalizeAssetPath).filter(file => file.endsWith('.css'))),
      }))
    }
  }

  const assets = new Set<string>()
  for (const stats of statsByEnvironment.values()) {
    const compilation = stats.compilation as unknown as CompilationLike
    for (const asset of Object.keys(compilation.assets)) assets.add(normalizeAssetPath(asset))
  }
  return Object.freeze({
    pluginEntryFile,
    views: Object.freeze(views),
    assets: Object.freeze([...assets].sort()),
    watchDependencies,
    warnings: Object.freeze(warnings),
  })
}

function requireExactEntrypoints (
  compilation: CompilationLike,
  expectedNames: readonly string[],
  environment: string,
): void {
  const expected = new Set(expectedNames)
  const unexpected = [...compilation.entrypoints.keys()].filter(name => !expected.has(name))
  if (unexpected.length > 0) {
    throw new PluginBuildError([{
      code: 'FH2_UNEXPECTED_ENTRYPOINT',
      phase: 'compile',
      message: `${environment} environment 生成了未声明的 entrypoint：${unexpected.sort().join(', ')}。`,
    }])
  }
}

export function compileFailureFromStats (
  statsByEnvironment: ReadonlyMap<string, Rspack.Stats>,
  error: unknown,
): PluginBuildError {
  const watchDependencies = collectWatchDependencies(statsByEnvironment)
  const diagnostics: BuildDiagnostic[] = []
  for (const [environment, stats] of statsByEnvironment) {
    const json = stats.toJson({ all: false, errors: true })
    diagnostics.push(...(json.errors ?? []).map(item => ({
      code: 'FH2_RSPACK_COMPILE_ERROR',
      phase: 'compile' as const,
      message: `[${environment}] ${formatStatsMessage(item)}`,
    })))
  }
  if (diagnostics.length === 0) {
    diagnostics.push({
      code: 'FH2_RSBUILD_INFRASTRUCTURE_FAILED',
      phase: 'compile',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  return new PluginBuildError(diagnostics, watchDependencies)
}

export function collectWatchDependencies (
  statsByEnvironment: ReadonlyMap<string, Rspack.Stats>,
): readonly string[] {
  const watchDependencies = new Set<string>()
  for (const stats of statsByEnvironment.values()) {
    const compilation = stats.compilation as unknown as CompilationLike
    collectAbsoluteDependencies(watchDependencies, compilation.fileDependencies)
    collectAbsoluteDependencies(watchDependencies, compilation.missingDependencies)
    collectAbsoluteDependencies(watchDependencies, compilation.contextDependencies)
  }
  return Object.freeze([...watchDependencies].sort())
}

function collectAbsoluteDependencies (target: Set<string>, dependencies: Iterable<string>): void {
  for (const dependency of dependencies) {
    if (isAbsolute(dependency)) target.add(dependency)
  }
}

function validatePluginModules (modules: Iterable<ModuleLike>, entries: ResolvedPluginEntries): void {
  const viewEntries = new Set(Object.values(entries.views).map(path => realpathSync(path)))
  for (const module of flattenModules(modules)) {
    const resource = module.resource ?? module.nameForCondition?.() ?? undefined
    const normalized = resource?.split('?', 1)[0]?.replaceAll('\\', '/')
    if (normalized !== undefined && PLUGIN_MODULE_POLICY.vueResource.test(normalized)) {
      throw new PluginBuildError([{
        code: 'FH2_PLUGIN_VUE_FORBIDDEN',
        phase: 'compile',
        file: normalized,
        message: 'Plugin Entry 模块图不得包含 Vue Runtime。',
      }])
    }
    if (normalized !== undefined && viewEntries.has(realpathIfPresent(normalized))) {
      throw new PluginBuildError([{
        code: 'FH2_PLUGIN_VIEW_IMPORT_FORBIDDEN',
        phase: 'compile',
        file: normalized,
        message: 'Plugin Entry 模块图不得包含 View Entry。',
      }])
    }
    if (PLUGIN_MODULE_POLICY.forbiddenTypePrefixes.some(prefix => module.type?.startsWith(prefix))) {
      throw new PluginBuildError([{
        code: 'FH2_PLUGIN_ASSET_FORBIDDEN',
        phase: 'compile',
        ...(normalized === undefined ? {} : { file: normalized }),
        message: 'Plugin Entry 模块图不得包含 CSS、图片、字体或其他旁路资源。',
      }])
    }
  }
}

function * flattenModules (modules: Iterable<ModuleLike>): Iterable<ModuleLike> {
  for (const module of modules) {
    yield module
    if (module.modules !== undefined) yield * flattenModules(module.modules)
  }
}

function requireEntrypoint (
  compilation: CompilationLike,
  name: string,
  label: string,
): EntrypointLike {
  const entrypoint = compilation.entrypoints.get(name)
  if (entrypoint === undefined) {
    throw new PluginBuildError([{
      code: 'FH2_ENTRYPOINT_MISSING',
      phase: 'compile',
      message: `${label} compilation entrypoint ${name} 不存在。`,
    }])
  }
  return entrypoint
}

function requireSingleEntryJs (entrypoint: EntrypointLike, label: string): string {
  const files = [...(entrypoint.getEntrypointChunk()?.files ?? [])]
    .map(normalizeAssetPath)
    .filter(file => file.endsWith('.js'))
  if (files.length !== 1) {
    throw new PluginBuildError([{
      code: 'FH2_ENTRYPOINT_JS_INVALID',
      phase: 'compile',
      message: `${label} 必须恰好生成一个入口 JS，实际为 ${files.length} 个。`,
    }])
  }
  return files[0]!
}

function outputPathToEntryName (outputPath: string): string {
  return outputPath.replace(/^\.\//, '').replace(/\.js$/, '')
}

function normalizeAssetPath (path: string): string {
  return path.replaceAll('\\', '/')
}

function formatStatsMessage (value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && 'message' in value)
    return String((value as { message: unknown }).message)
  return JSON.stringify(value)
}

function realpathIfPresent (path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
