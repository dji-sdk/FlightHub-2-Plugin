// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { commitCandidateDirectory, createCandidateDirectory, removeCandidateDirectory } from '../build/transaction.js'
import type { TransactionFileOperations } from '../build/transaction.js'
import { PluginBuildError } from '../build/types.js'
import type { BuildDiagnostic } from '../build/types.js'
import { TOOLCHAIN_VERSION } from '../manifest.js'
import {
  SOURCE_BUILD_RULES,
  buildOutputDirectory,
  sourceDirectoryOf,
} from '../source-build-rules.js'
import { PROJECT_PATHS } from '../project-policy.js'
import type { WorkerBackendPluginManifest } from './contract.js'
import { BACKEND_SOURCE_MANIFEST_FILE } from './contract.js'
import { compileBackendPlugin } from './compiler.js'
import type { BackendSourceValidationResult } from './source-contract.js'
import { validateBackendSourcePlugin } from './source-contract.js'
import { SOURCE_POLICY_PATTERNS, hasModuleSyntax } from './policy.js'

export interface BackendBuildAsset {
  readonly kind: 'manifest' | 'workflow' | 'handler' | 'event' | 'adapter' | 'evaluator' | 'script' | 'bundle';
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface BackendPluginBuildOptions {
  /** false 时保留候选目录，调用方负责 Capability 级提交。 */
  readonly commit?: boolean;
  readonly operations?: TransactionFileOperations;
  /** 跳过 esbuild Bundle，强制走散文件复制（用于无 ESM 的旧包）。 */
  readonly legacyCopyMode?: boolean;
}

export interface BackendPluginBuildResult {
  readonly pluginId: string;
  readonly version: string;
  readonly distRoot: string;
  readonly candidateRoot?: string;
  readonly assets: readonly BackendBuildAsset[];
  readonly watchDependencies: readonly string[];
  readonly diagnostics: readonly BuildDiagnostic[];
}

/**
 * 构建后端插件。
 *
 * Bundle 模式（检测到 ESM 源码时自动启用）：
 *   Source Validate -> Bundle（handlers/events/adapter）-> Runtime Manifest 改写 -> build-info -> 原子提交
 *
 * legacyCopyMode（无 ESM 的旧包，行为与改造前一致）：
 *   Runtime Validate -> 复制散文件 -> build-info -> 原子提交
 */
export async function buildBackendPlugin (
  pluginRoot: string,
  options: BackendPluginBuildOptions = {},
): Promise<BackendPluginBuildResult> {
  const root = resolve(pluginRoot)
  const sourceValidation = validateBackendSourcePlugin(root)

  if (!sourceValidation.ok && sourceValidation.diagnostics.some(diagnostic =>
    diagnostic.code === 'FH2_SCHEMA_SQL_INVALID' || diagnostic.code === 'FH2_SCHEMA_SQL_READ_FAILED')) {
    throw new PluginBuildError(sourceValidation.diagnostics.map(diagnostic => ({
      code: diagnostic.code,
      phase: 'config' as const,
      file: diagnostic.file,
      message: diagnostic.message,
    })))
  }

  if (!options.legacyCopyMode && sourceValidation.ok && hasAnyEsm(root, sourceValidation.manifest!)) {
    return buildWithBundle(root, sourceValidation, options)
  }
  return buildLegacyCopy(root, options, sourceValidation)
}

// ─── Bundle 模式 ─────────────────────────────────────────────────────

async function buildWithBundle (
  root: string,
  source: ReturnType<typeof validateBackendSourcePlugin>,
  options: BackendPluginBuildOptions,
): Promise<BackendPluginBuildResult> {
  const manifest = source.manifest!
  const distRoot = resolve(root, buildOutputDirectory(SOURCE_BUILD_RULES, 'backend', 'backend-dist'))
  const candidateRoot = createCandidateDirectory(distRoot, options.operations)
  const assets: BackendBuildAsset[] = []
  const dependencies = new Set<string>()
  const ctx: CopyContext = { root, candidateRoot, dependencies, assets }

  try {
    // 1. Bundle 三类脚本（handlers/events/adapter）。
    const compileResult = await compileBackendPlugin({
      pluginRoot: root,
      candidateRoot,
      source,
    })
    for (const asset of compileResult.assets) {
      assets.push(Object.freeze({
        kind: 'bundle',
        path: asset.path,
        sha256: asset.sha256,
        bytes: asset.bytes,
      }))
    }
    for (const dep of compileResult.watchDependencies) dependencies.add(dep)

    // 2. Evaluator 普通 JS 原样复制（Phase 1 策略，ESM 已在 Source Validate 拦截）。
    for (const evaluator of manifest.evaluators ?? []) {
      if (evaluator.path !== undefined && existsSync(resolve(root, evaluator.path))) {
        copyAsset(ctx, evaluator.path, 'evaluator')
      }
    }

    // 3. 复制 Workflow、schema.sql 等非脚本资产。
    if (existsSync(resolve(root, PROJECT_PATHS.schemaSql))) {
      copyAsset(ctx, PROJECT_PATHS.schemaSql, 'manifest')
    }
    for (const flow of manifest.flows ?? []) {
      copyAsset(ctx, flow, 'workflow')
    }

    // 4. 写 Runtime Manifest（值级改写后的，覆盖 candidate 里的 plugin.json 占位）。
    writeFileSync(
      resolve(candidateRoot, PROJECT_PATHS.runtimeManifest),
      `${JSON.stringify(compileResult.runtimeManifest, null, 2)}\n`,
      'utf8',
    )
    assets.push(Object.freeze({
      kind: 'manifest',
      path: PROJECT_PATHS.runtimeManifest,
      sha256: createHash('sha256').update(JSON.stringify(compileResult.runtimeManifest, null, 2)).digest('hex'),
      bytes: JSON.stringify(compileResult.runtimeManifest, null, 2).length,
    }))

    // 5. 写 build-info.json（仅本地诊断，Pack 时排除）。
    writeBuildInfo(candidateRoot, manifest, 'esm-bundle')

    // 6. Runtime 自检：产物无模块语法残留。
    validateBundledOutput(candidateRoot, compileResult.assets.map(a => a.path))

    const commitDiagnostics = options.commit === false
      ? []
      : commitCandidateDirectory(candidateRoot, distRoot, options.operations)
    return {
      pluginId: manifest.pluginId,
      version: manifest.version,
      distRoot,
      ...(options.commit === false ? { candidateRoot } : {}),
      assets: Object.freeze(assets),
      watchDependencies: Object.freeze([...dependencies].sort(compareText)),
      diagnostics: Object.freeze(commitDiagnostics),
    }
  } catch (error) {
    removeCandidateDirectory(candidateRoot, options.operations)
    if (error instanceof PluginBuildError) throw error
    throw new PluginBuildError([{
      code: 'FH2_BACKEND_BUILD_FAILED',
      phase: 'commit',
      file: root,
      message: message(error),
    }])
  }
}

// ─── Legacy 复制模式（与改造前行为一致） ─────────────────────────────

async function buildLegacyCopy (
  root: string,
  options: BackendPluginBuildOptions,
  source: BackendSourceValidationResult,
): Promise<BackendPluginBuildResult> {
  const { validateBackendPlugin } = await import('./contract.js')
  const sourceManifest = source.ok ? source.manifestJson : undefined
  const validation = sourceManifest === undefined
    ? validateBackendPlugin(root, undefined, BACKEND_SOURCE_MANIFEST_FILE)
    : validateBackendPlugin(root, sourceManifest, BACKEND_SOURCE_MANIFEST_FILE)
  if (!validation.ok) {
    throw new PluginBuildError(validation.diagnostics.map(diagnostic => ({
      code: diagnostic.code,
      phase: 'config' as const,
      file: diagnostic.file,
      message: diagnostic.message,
    })))
  }

  const manifest = validation.manifest
  const distRoot = resolve(root, buildOutputDirectory(SOURCE_BUILD_RULES, 'backend', 'backend-dist'))
  const candidateRoot = createCandidateDirectory(distRoot, options.operations)
  const assets: BackendBuildAsset[] = []
  const dependencies = new Set<string>()
  const ctx: CopyContext = { root, candidateRoot, dependencies, assets }

  try {
    if (source.generatedEntities === true && sourceManifest !== undefined) {
      writeEffectiveManifest(ctx, sourceManifest)
    } else {
      copyManifestAsset(ctx, BACKEND_SOURCE_MANIFEST_FILE)
    }
    if (existsSync(resolve(root, PROJECT_PATHS.schemaSql))) {
      copyAsset(ctx, PROJECT_PATHS.schemaSql, 'manifest')
    }
    for (const path of manifest.flows ?? []) {
      copyAsset(ctx, path, 'workflow')
    }

    // 声明过的 JS 资产。
    for (const script of manifest.scripts ?? []) {
      if (script.path !== undefined && existsSync(resolve(root, script.path))) {
        copyAsset(ctx, script.path, 'adapter')
      }
    }
    for (const event of manifest.events ?? []) {
      for (const consumer of event.consumer) {
        if (consumer.handler !== undefined && existsSync(resolve(root, consumer.handler))) {
          copyAsset(ctx, consumer.handler, 'event')
        }
      }
    }
    for (const evaluator of manifest.evaluators ?? []) {
      if (evaluator.path !== undefined && existsSync(resolve(root, evaluator.path))) {
        copyAsset(ctx, evaluator.path, 'evaluator')
      }
    }

    // 运行时目录：目录约定来自结构化规则对象；kind 标签是 Worker Manifest 语义
    // （由 Worker 提供，Toolchain 不重新定义），故保持代码内映射。
    for (const [directory, kind] of [
      [sourceDirectoryOf(SOURCE_BUILD_RULES, 'backend-handlers'), 'handler'],
      [sourceDirectoryOf(SOURCE_BUILD_RULES, 'backend-events'), 'event'],
      [sourceDirectoryOf(SOURCE_BUILD_RULES, 'backend-adapters'), 'adapter'],
      [sourceDirectoryOf(SOURCE_BUILD_RULES, 'backend-evaluators'), 'evaluator'],
      [sourceDirectoryOf(SOURCE_BUILD_RULES, 'backend-packed-scripts'), 'script'],
    ] as const) {
      const sourceRoot = resolve(root, directory)
      if (!existsSync(sourceRoot)) continue
      copyDirectoryFiles(ctx, sourceRoot, directory, kind)
    }

    writeBuildInfo(candidateRoot, manifest, 'legacy-copy')

    const commitDiagnostics = options.commit === false
      ? []
      : commitCandidateDirectory(candidateRoot, distRoot, options.operations)
    return {
      pluginId: manifest.pluginId,
      version: manifest.version,
      distRoot,
      ...(options.commit === false ? { candidateRoot } : {}),
      assets: Object.freeze(assets),
      watchDependencies: Object.freeze([...dependencies].sort(compareText)),
      diagnostics: Object.freeze(commitDiagnostics),
    }
  } catch (error) {
    removeCandidateDirectory(candidateRoot, options.operations)
    if (error instanceof PluginBuildError) throw error
    throw new PluginBuildError([{
      code: 'FH2_BACKEND_BUILD_FAILED',
      phase: 'commit',
      file: root,
      message: message(error),
    }])
  }
}

// ─── 共用工具 ────────────────────────────────────────────────────────

interface CopyContext {
  readonly root: string;
  readonly candidateRoot: string;
  readonly dependencies: Set<string>;
  readonly assets: BackendBuildAsset[];
}

function copyAsset (ctx: CopyContext, path: string, kind: BackendBuildAsset['kind']): void {
  if (ctx.dependencies.has(`copied:${path}`)) return
  const sourcePath = resolveContainedFile(ctx.root, path)
  const targetPath = resolve(ctx.candidateRoot, path)
  mkdirSync(dirname(targetPath), { recursive: true })
  copyFileSync(sourcePath, targetPath)
  const source = readFileSync(sourcePath)
  ctx.dependencies.add(`copied:${path}`)
  ctx.dependencies.add(sourcePath)
  ctx.assets.push(Object.freeze({
    kind,
    path,
    sha256: createHash('sha256').update(source).digest('hex'),
    bytes: source.byteLength,
  }))
}

function copyManifestAsset (ctx: CopyContext, sourceManifestFile: string): void {
  const sourcePath = resolveContainedFile(ctx.root, sourceManifestFile)
  const targetPath = resolve(ctx.candidateRoot, PROJECT_PATHS.runtimeManifest)
  mkdirSync(dirname(targetPath), { recursive: true })
  copyFileSync(sourcePath, targetPath)
  const source = readFileSync(sourcePath)
  ctx.dependencies.add(sourcePath)
  ctx.assets.push(Object.freeze({
    kind: 'manifest',
    path: PROJECT_PATHS.runtimeManifest,
    sha256: createHash('sha256').update(source).digest('hex'),
    bytes: source.byteLength,
  }))
}

function writeEffectiveManifest (ctx: CopyContext, manifest: Readonly<Record<string, unknown>>): void {
  const path = PROJECT_PATHS.runtimeManifest
  const content = `${JSON.stringify(manifest, null, 2)}\n`
  const targetPath = resolve(ctx.candidateRoot, path)
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, content, 'utf8')
  ctx.dependencies.add(resolve(ctx.root, BACKEND_SOURCE_MANIFEST_FILE))
  ctx.assets.push(Object.freeze({
    kind: 'manifest',
    path,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
  }))
}

function copyDirectoryFiles (
  ctx: CopyContext,
  directory: string,
  prefix: string,
  kind: BackendBuildAsset['kind'],
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue
    const relativePath = `${prefix}/${entry.name}`
    const sourcePath = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      copyDirectoryFiles(ctx, sourcePath, relativePath, kind)
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      copyAsset(ctx, relativePath, kind)
    }
  }
}

function hasAnyEsm (root: string, manifest: WorkerBackendPluginManifest): boolean {
  // 检查 manifest 声明的入口文件。
  const files = new Set<string>()
  for (const script of manifest.scripts ?? []) {
    if (script.path !== undefined) files.add(script.path)
  }
  for (const event of manifest.events ?? []) {
    for (const consumer of event.consumer) {
      if (consumer.handler !== undefined) files.add(consumer.handler)
    }
  }
  for (const file of files) {
    try {
      if (hasModuleSyntax(readFileSync(resolve(root, file), 'utf8'))) return true
    } catch { /* 文件不存在由 Source Validate 报 */ }
  }
  // 检查 handlers/** 目录。.ts 源码本身就是 Bundle 模式的充分条件
  // (esbuild 剥类型后输出普通 JS;散文件复制那条路带不动 TS)。
  const handlerRoot = resolve(root, sourceDirectoryOf(SOURCE_BUILD_RULES, 'backend-handlers'))
  if (!existsSync(handlerRoot)) return false
  const visit = (dir: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.DS_Store' || entry.name.startsWith('_')) continue
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        if (visit(full)) return true
        continue
      }
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.ts')) continue
      if (entry.name.endsWith('.d.ts')) continue
      try {
        if (entry.name.endsWith('.ts') || hasModuleSyntax(readFileSync(full, 'utf8'))) return true
      } catch { /* 忽略读取失败 */ }
    }
    return false
  }
  return visit(handlerRoot)
}

function resolveContainedFile (root: string, path: string): string {
  if (path === '' || isAbsolute(path) || path.includes('\\') || path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new PluginBuildError([{
      code: 'FH2_BACKEND_ASSET_PATH_INVALID',
      phase: 'config',
      file: path,
      message: `后端资产路径不安全：${path}。`,
    }])
  }
  const requested = resolve(root, path)
  const realRoot = realpathSync(root)
  let realPath: string
  try {
    realPath = realpathSync(requested)
    if (!statSync(realPath).isFile()) throw new Error('不是普通文件')
  } catch (error) {
    throw new PluginBuildError([{
      code: 'FH2_BACKEND_ASSET_MISSING',
      phase: 'config',
      file: requested,
      message: `后端资产不存在：${path}（${message(error)}）`,
    }])
  }
  const fromRoot = relative(realRoot, realPath)
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new PluginBuildError([{
      code: 'FH2_BACKEND_ASSET_PATH_INVALID',
      phase: 'config',
      file: requested,
      message: `后端资产真实路径越过插件根：${path}。`,
    }])
  }
  return realPath
}

/** Bundle 产物自检：不允许残留模块语法。 */
function validateBundledOutput (candidateRoot: string, paths: readonly string[]): void {
  for (const path of paths) {
    const content = readFileSync(resolve(candidateRoot, path), 'utf8')
    if (SOURCE_POLICY_PATTERNS.residualImport.test(content) || SOURCE_POLICY_PATTERNS.residualExport.test(content) || SOURCE_POLICY_PATTERNS.residualRequire.test(content)) {
      throw new PluginBuildError([{
        code: 'FH2_BACKEND_BUNDLE_RESIDUAL_MODULE_SYNTAX',
        phase: 'compile',
        file: path,
        message: `Bundle 产物残留模块语法：${path}。`,
      }])
    }
  }
}

function writeBuildInfo (
  candidateRoot: string,
  manifest: WorkerBackendPluginManifest,
  mode: 'esm-bundle' | 'legacy-copy',
): void {
  writeFileSync(resolve(candidateRoot, PROJECT_PATHS.buildInfo), `${JSON.stringify({
    schemaVersion: 1,
    pluginId: manifest.pluginId,
    version: manifest.version,
    toolchainVersion: TOOLCHAIN_VERSION,
    bundler: {
      mode,
      compilerVersion: '1.0.0',
    },
    workerVerified: false,
  }, null, 2)}\n`, 'utf8')
}

function compareText (left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
