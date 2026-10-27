// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import * as esbuild from 'esbuild'
import ts from 'typescript'
import { PluginBuildError } from '../build/types.js'
import type { BuildDiagnostic } from '../build/types.js'
import { BACKEND_SOURCE_DIRECTORIES, PROJECT_PATHS } from '../project-policy.js'
import { BUILD_PHASES } from '../build/policy.js'
import { BACKEND_BUNDLE_GLOBALS, BACKEND_BUNDLE_OUTPUTS, BACKEND_COMPILE_OPTIONS, isNodeBuiltinSpecifier, isRelativeSpecifier } from './policy.js'
import type { WorkerBackendPluginManifest } from './contract.js'
import { wrapperNameForHandlerExport } from './handler-names.js'
import type { BackendSourceValidationResult } from './source-contract.js'

/**
 * Backend Bundler：把作者侧 JavaScript ESM 源码打成 Goja 可执行的普通 JS。
 *
 * 输出三份 Bundle（分别对应三种调用形态，Host 注入面不同，不能共享 Chunk）：
 * - scripts/handlers.js：顶层 h_* Wrapper，由 Worker 扫描发现。
 * - scripts/events.js：按 Manifest consumer entry 生成稳定序号 Wrapper。
 * - scripts/adapter.js：按 Manifest scripts[] entry 生成稳定序号 Wrapper。
 *
 * 最终产物结构（Wrapper 在 IIFE 之前，兼容 Worker 顶层函数扫描器）：
 *
 *   function h_example(input, ctx) {
 *     return (0, __fh2_handlers.h_example)(input, ctx)
 *   }
 *   var __fh2_handlers = (() => { /* esbuild IIFE *\/ })()
 *
 * 注意：
 * - 不注入 "use strict"（兼容当前 Worker goja.Compile(..., false) 宽松语义）。
 * - (0, ns.fn)(...) 是 detached call，避免 namespace 对象成为 this。
 */

export const HANDLERS_GLOBAL = BACKEND_BUNDLE_GLOBALS.handlers
export const EVENTS_GLOBAL = BACKEND_BUNDLE_GLOBALS.events
export const ADAPTERS_GLOBAL = BACKEND_BUNDLE_GLOBALS.adapters
export const PACKED_DIR = BACKEND_SOURCE_DIRECTORIES.scripts
export const HANDLERS_OUTPUT = BACKEND_BUNDLE_OUTPUTS.handlers
export const EVENTS_OUTPUT = BACKEND_BUNDLE_OUTPUTS.events
export const ADAPTER_OUTPUT = BACKEND_BUNDLE_OUTPUTS.adapter

export interface CompileBackendOptions {
  /** 插件源码根目录（绝对路径）。 */
  readonly pluginRoot: string;
  /** 候选输出目录（绝对路径），Bundle 写入这里。 */
  readonly candidateRoot: string;
  /** Source 校验结果（manifest + 原始 JSON）。 */
  readonly source: BackendSourceValidationResult;
}

export interface CompiledEntryMapping {
  readonly kind: 'handler' | 'event' | 'adapter';
  readonly sourcePath: string;
  readonly sourceEntry: string;
  readonly runtimePath: string;
  readonly runtimeEntry: string;
}

export interface CompiledBackendAsset {
  readonly kind: 'handler' | 'event' | 'adapter';
  readonly path: string;
  readonly entries: readonly string[];
  readonly sha256: string;
  readonly bytes: number;
}

export interface CompileBackendResult {
  /** Runtime Manifest（基于 Source 原始 JSON 值级改写，不丢字段）。 */
  readonly runtimeManifest: Readonly<Record<string, unknown>>;
  readonly assets: readonly CompiledBackendAsset[];
  readonly entryMappings: readonly CompiledEntryMapping[];
  readonly watchDependencies: readonly string[];
}

export async function compileBackendPlugin (options: CompileBackendOptions): Promise<CompileBackendResult> {
  const { pluginRoot, candidateRoot, source } = options
  if (!source.ok || source.manifest === undefined || source.manifestJson === undefined) {
    throw new PluginBuildError([{
      code: 'FH2_BACKEND_BUNDLE_FAILED',
      phase: 'config',
      message: 'Source 校验未通过，不能执行 Bundle。',
    }])
  }

  const manifest = source.manifest
  const manifestJson = source.manifestJson
  const assets: CompiledBackendAsset[] = []
  const entryMappings: CompiledEntryMapping[] = []
  const watchDependencies = new Set<string>()
  const schemaPath = resolve(pluginRoot, PROJECT_PATHS.schemaSql)
  if (existsSync(schemaPath)) watchDependencies.add(schemaPath)

  // ─── 1. Handler Bundle ───────────────────────────────────────────────
  const handlerEntries = await collectHandlerEntries(pluginRoot, watchDependencies)
  const hasHandlers = handlerEntries.length > 0

  // ─── 2. Event Bundle ────────────────────────────────────────────────
  const eventEntries = collectEventEntries(manifest)
  const hasEvents = eventEntries.length > 0

  // ─── 3. Adapter Bundle ──────────────────────────────────────────────
  const adapterEntries = collectAdapterEntries(manifest)
  const hasAdapters = adapterEntries.length > 0

  // ─── 4. 生成三份 Bundle ─────────────────────────────────────────────
  const runtimeManifest: Record<string, unknown> = structuredClone(manifestJson as Record<string, unknown>)

  if (hasHandlers) {
    const result = await bundleEntries({
      pluginRoot,
      globalName: HANDLERS_GLOBAL,
      virtualEntrySource: buildHandlerVirtualEntry(handlerEntries),
      virtualEntryFile: 'fh2:handlers-entry.js',
      wrappers: handlerEntries.map(entry => ({
        // Wrapper 名 = 运行时 Handler 名（已有 h_ 保留，新 export 按目录派生稳定 h_ 名）。
        name: entry.name,
        // IIFE namespace 成员名 = Virtual Entry 中的导出名。
        namespaceMember: entry.name,
        sourcePath: entry.sourcePath,
        sourceEntry: entry.sourceExport,
        runtimePath: HANDLERS_OUTPUT,
        runtimeEntry: entry.name,
        kind: 'handler' as const,
      })),
    })
    const handlersContent = writeBundle(candidateRoot, HANDLERS_OUTPUT, result.content, result.map)
    assets.push({
      kind: 'handler',
      path: HANDLERS_OUTPUT,
      entries: handlerEntries.map(e => e.name),
      sha256: hash(handlersContent),
      bytes: handlersContent.length,
    })
    for (const e of handlerEntries) {
      entryMappings.push({
        kind: 'handler',
        sourcePath: e.sourcePath,
        sourceEntry: e.sourceExport,
        runtimePath: HANDLERS_OUTPUT,
        runtimeEntry: e.name,
      })
    }
    for (const dep of result.watchDependencies) watchDependencies.add(dep)
  }

  if (hasEvents) {
    const result = await bundleEntries({
      pluginRoot,
      globalName: EVENTS_GLOBAL,
      virtualEntrySource: buildEventVirtualEntry(eventEntries),
      virtualEntryFile: 'fh2:events-entry.js',
      wrappers: eventEntries.map(entry => ({
        name: `fh2_event_${entry.eventIndex}_${entry.consumerIndex}`,
        namespaceMember: `event_${entry.eventIndex}_${entry.consumerIndex}`,
        sourcePath: entry.sourcePath,
        sourceEntry: entry.sourceEntry,
        runtimePath: EVENTS_OUTPUT,
        runtimeEntry: `fh2_event_${entry.eventIndex}_${entry.consumerIndex}`,
        kind: 'event' as const,
      })),
    })
    const eventsContent = writeBundle(candidateRoot, EVENTS_OUTPUT, result.content, result.map)
    assets.push({
      kind: 'event',
      path: EVENTS_OUTPUT,
      entries: eventEntries.map(e => `fh2_event_${e.eventIndex}_${e.consumerIndex}`),
      sha256: hash(eventsContent),
      bytes: eventsContent.length,
    })
    eventEntries.forEach((entry) => {
      entryMappings.push({
        kind: 'event',
        sourcePath: entry.sourcePath,
        sourceEntry: entry.sourceEntry,
        runtimePath: EVENTS_OUTPUT,
        runtimeEntry: `fh2_event_${entry.eventIndex}_${entry.consumerIndex}`,
      })
    })
    for (const dep of result.watchDependencies) watchDependencies.add(dep)

    // 改写 Runtime Manifest 中的 events[].consumer[].handler/entry。
    rewriteEventsInRuntimeManifest(runtimeManifest, eventEntries)
  }

  if (hasAdapters) {
    const adapterEntryNames = uniqueRuntimeEntryNames(adapterEntries)
    const result = await bundleEntries({
      pluginRoot,
      globalName: ADAPTERS_GLOBAL,
      virtualEntrySource: buildAdapterVirtualEntry(adapterEntries),
      virtualEntryFile: 'fh2:adapters-entry.js',
      wrappers: adapterEntries.map((entry, index) => ({
        name: adapterEntryNames[index]!,
        namespaceMember: `adapter_${index}`,
        sourcePath: entry.sourcePath,
        sourceEntry: entry.sourceEntry,
        runtimePath: ADAPTER_OUTPUT,
        runtimeEntry: adapterEntryNames[index]!,
        kind: 'adapter' as const,
      })),
    })
    const adaptersContent = writeBundle(candidateRoot, ADAPTER_OUTPUT, result.content, result.map)
    assets.push({
      kind: 'adapter',
      path: ADAPTER_OUTPUT,
      entries: adapterEntries.map((_, i) => adapterEntryNames[i]!),
      sha256: hash(adaptersContent),
      bytes: adaptersContent.length,
    })
    adapterEntries.forEach((entry, index) => {
      entryMappings.push({
        kind: 'adapter',
        sourcePath: entry.sourcePath,
        sourceEntry: entry.sourceEntry,
        runtimePath: ADAPTER_OUTPUT,
        runtimeEntry: adapterEntryNames[index]!,
      })
    })
    for (const dep of result.watchDependencies) watchDependencies.add(dep)

    // 改写 Runtime Manifest 中的 scripts[].path/entry。
    rewriteScriptsInRuntimeManifest(runtimeManifest, adapterEntries, adapterEntryNames)
  }

  return {
    runtimeManifest: Object.freeze(runtimeManifest),
    assets: Object.freeze(assets),
    entryMappings: Object.freeze(entryMappings),
    watchDependencies: Object.freeze([...watchDependencies].sort()),
  }
}

// ─── 入口发现 ─────────────────────────────────────────────────────────

/**
 * Handler 入口的两种模式：
 *
 * - 'h_'      （历史兼容）：export function h_getEvent → Bundle 顶层 function h_getEvent。
 *
 * - 'derived' （标准写法）：handlers/lane-change/start-mode.js 中的 export function startMode
 *                           → Bundle 顶层 function h_laneChange_startMode。
 *                           h_ 入口保持旧 Worker 可加载；新版 Worker 再为它派生可读别名。
 */
export type HandlerMode = 'h_' | 'derived'

interface HandlerEntry {
  /** Bundle 顶层 Wrapper 名。 */
  readonly name: string;
  /** 源码中的导出名。 */
  readonly sourceExport: string;
  /** 源文件路径。 */
  readonly sourcePath: string;
  /** Wrapper 的命名来源。 */
  readonly mode: HandlerMode;
}

interface EventConsumerEntry {
  readonly eventIndex: number;
  readonly consumerIndex: number;
  readonly sourcePath: string;
  readonly sourceEntry: string;
}

interface AdapterEntry {
  readonly scriptIndex: number;
  readonly sourcePath: string;
  readonly sourceEntry: string;
  readonly scriptName: string;
}

async function collectHandlerEntries (
  pluginRoot: string,
  watchDependencies: Set<string>,
): Promise<readonly HandlerEntry[]> {
  const { discoverBackendHandlerFiles } = await import('./discovery.js')
  const files = discoverBackendHandlerFiles(pluginRoot)
  const entries: HandlerEntry[] = []
  const seen = new Set<string>()

  for (const file of files) {
    if (file.kind !== 'source') continue
    watchDependencies.add(resolve(pluginRoot, file.path))
    const source = readFileSync(resolve(pluginRoot, file.path), 'utf8')
    const discovered = extractHandlerExports(source)

    for (const item of discovered.hPrefixed) {
      if (seen.has(item)) {
        throw duplicateError(file.path, item)
      }
      seen.add(item)
      entries.push({ name: item, sourceExport: item, sourcePath: file.path, mode: 'h_' })
    }
    for (const item of discovered.other) {
      const runtimeName = wrapperNameForHandlerExport(file.path, item)
      if (runtimeName === undefined) {
        throw new PluginBuildError([{
          code: 'FH2_BACKEND_HANDLER_NAME_INVALID',
          phase: 'compile',
          file: file.path,
          message: `Handler export ${item} 无法从路径 ${file.path} 派生公开名称；`
            + '普通 export 必须位于 handlers/<domain>/ 下，目录使用小写 kebab-case，export 使用 lowerCamelCase。',
        }])
      }
      if (seen.has(runtimeName)) {
        throw duplicateError(file.path, runtimeName)
      }
      seen.add(runtimeName)
      entries.push({ name: runtimeName, sourceExport: item, sourcePath: file.path, mode: 'derived' })
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

function duplicateError (file: string, name: string): PluginBuildError {
  return new PluginBuildError([{
    code: 'FH2_BACKEND_ENTRY_DUPLICATE',
    phase: 'compile',
    file,
    message: `Handler 名重复：${name}。`,
  }])
}

export interface DiscoveredHandlerExports {
  /** 以 h_ 开头的导出（Phase 1 兼容模式，保留原名）。 */
  readonly hPrefixed: readonly string[];
  /** 不以 h_ 开头的导出（按目录与 export 派生稳定 h_ 入口）。 */
  readonly other: readonly string[];
}

/**
 * 从 ESM 源码中提取 Handler 导出。使用 TypeScript AST，只识别运行时函数值：
 *
 * - export function h_xxx(...) {}
 * - export function xxx(...) {}          （不带 h_ 前缀）
 * - export const h_xxx = (...) => {}
 * - export const xxx = function(...) {}
 * - export { h_xxx, yyy }                （本地函数绑定）
 * - export { h_xxx as h_alias }
 * - export { xxx as yyy } from '...'
 * - export * from '...'                  （无法静态确定名，由 esbuild 解析后再验证）
 *
 * 注意：export default 不视为 Handler 入口（一个文件只应有一个 default，
 * 且无法保证是函数；如果要用 default，请在文件内同时写 named export）。
 */
export function extractHandlerExports (source: string): DiscoveredHandlerExports {
  const hPrefixed = new Set<string>()
  const other = new Set<string>()
  const sourceFile = ts.createSourceFile(
    'handler.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const functionBindings = collectFunctionBindings(sourceFile)

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)
        && !hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
        && statement.name !== undefined
        && statement.body !== undefined) {
        classify(statement.name.text, hPrefixed, other)
      }
      continue
    }

    if (ts.isVariableStatement(statement)) {
      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && isFunctionValue(declaration.initializer)) {
          classify(declaration.name.text, hPrefixed, other)
        }
      }
      continue
    }

    if (!ts.isExportDeclaration(statement)
      || statement.isTypeOnly
      || statement.exportClause === undefined
      || !ts.isNamedExports(statement.exportClause)) {
      continue
    }

    for (const specifier of statement.exportClause.elements) {
      if (specifier.isTypeOnly || specifier.name.text === 'default') continue
      const localName = (specifier.propertyName ?? specifier.name).text
      if (statement.moduleSpecifier !== undefined || functionBindings.has(localName)) {
        classify(specifier.name.text, hPrefixed, other)
      }
    }
  }

  return {
    hPrefixed: [...hPrefixed],
    other: [...other],
  }
}

function collectFunctionBindings (sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.body !== undefined) {
      names.add(statement.name.text)
      continue
    }
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && isFunctionValue(declaration.initializer)) {
        names.add(declaration.name.text)
      }
    }
  }
  return names
}

function isFunctionValue (initializer: ts.Expression | undefined): boolean {
  if (initializer === undefined) return false
  let value = initializer
  while (ts.isParenthesizedExpression(value)
    || ts.isAsExpression(value)
    || ts.isSatisfiesExpression(value)
    || ts.isTypeAssertionExpression(value)
    || ts.isNonNullExpression(value)) {
    value = value.expression
  }
  return ts.isArrowFunction(value) || ts.isFunctionExpression(value)
}

function hasModifier (node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind) === true
}

function classify (name: string, hPrefixed: Set<string>, other: Set<string>): void {
  if (name.startsWith('h_')) {
    hPrefixed.add(name)
  } else {
    other.add(name)
  }
}

function collectEventEntries (manifest: WorkerBackendPluginManifest): readonly EventConsumerEntry[] {
  const entries: EventConsumerEntry[] = []
  for (const [eventIndex, event] of (manifest.events ?? []).entries()) {
    for (const [consumerIndex, consumer] of event.consumer.entries()) {
      if (consumer.handler === undefined) continue
      entries.push({
        eventIndex,
        consumerIndex,
        sourcePath: consumer.handler,
        sourceEntry: consumer.entry ?? 'handle',
      })
    }
  }
  return entries
}

function collectAdapterEntries (manifest: WorkerBackendPluginManifest): readonly AdapterEntry[] {
  const entries: AdapterEntry[] = []
  for (const [scriptIndex, script] of (manifest.scripts ?? []).entries()) {
    if (script.path === undefined) continue
    entries.push({
      scriptIndex,
      sourcePath: script.path,
      sourceEntry: script.entry ?? 'handle',
      scriptName: script.name ?? script.path,
    })
  }
  return entries
}

// ─── Virtual Entry 生成 ──────────────────────────────────────────────

function buildHandlerVirtualEntry (entries: readonly HandlerEntry[]): string {
  const lines: string[] = []
  for (const entry of entries) {
    if (entry.mode === 'h_') {
      // h_ 模式：导出名 = 运行时名，直接 re-export。
      lines.push(`export { ${entry.sourceExport} } from ${JSON.stringify(`./${entry.sourcePath}`)}`)
    } else {
      // 标准写法：源码 export 改名为稳定 h_ 入口，供旧 Worker 扫描。
      lines.push(
        `import { ${entry.sourceExport} as ${entry.name} } from ${JSON.stringify(`./${entry.sourcePath}`)}`,
      )
      lines.push(`export { ${entry.name} }`)
    }
  }
  return `${lines.join('\n')}\n`
}

function buildEventVirtualEntry (entries: readonly EventConsumerEntry[]): string {
  const lines: string[] = []
  for (const entry of entries) {
    lines.push(
      `import { ${entry.sourceEntry} as event_${entry.eventIndex}_${entry.consumerIndex} } from ${JSON.stringify(`./${entry.sourcePath}`)}`,
    )
    lines.push(`export { event_${entry.eventIndex}_${entry.consumerIndex} }`)
  }
  return `${lines.join('\n')}\n`
}

function buildAdapterVirtualEntry (entries: readonly AdapterEntry[]): string {
  const lines: string[] = []
  for (const [index, entry] of entries.entries()) {
    lines.push(
      `import { ${entry.sourceEntry} as adapter_${index} } from ${JSON.stringify(`./${entry.sourcePath}`)}`,
    )
    lines.push(`export { adapter_${index} }`)
  }
  return `${lines.join('\n')}\n`
}

// ─── esbuild Bundle ──────────────────────────────────────────────────

interface BundleWrapperSpec {
  readonly name: string;
  readonly namespaceMember: string;
  readonly sourcePath: string;
  readonly sourceEntry: string;
  readonly runtimePath: string;
  readonly runtimeEntry: string;
  readonly kind: 'handler' | 'event' | 'adapter';
}

interface BundleResult {
  readonly content: string;
  /** B3：外部 sourcemap JSON（已按 wrapper 前缀行数平移）；无映射时 undefined。 */
  readonly map?: string;
  readonly watchDependencies: readonly string[];
}

async function bundleEntries (options: {
  readonly pluginRoot: string;
  readonly globalName: string;
  readonly virtualEntrySource: string;
  readonly virtualEntryFile: string;
  readonly wrappers: readonly BundleWrapperSpec[];
}): Promise<BundleResult> {
  const { pluginRoot, globalName, virtualEntrySource, virtualEntryFile, wrappers } = options

  // esbuild 对 onResolve 拒绝会直接 throw BuildFailure（而非放入 result.errors）：
  // 统一映射为 PluginBuildError，保持 Bundler 的错误契约。
  let result: Awaited<ReturnType<typeof esbuild.build>>
  try {
    result = await esbuild.build({
      stdin: {
        contents: virtualEntrySource,
        resolveDir: pluginRoot,
        sourcefile: virtualEntryFile,
        // ts:virtual entry import 的 .ts 源码按扩展名走 ts loader,类型注解被剥离;
        // .js 源码照旧。声明 ts 使 TS/JS 混合插件都能进同一条 Bundle 链。
        loader: 'ts',
      },
      ...BACKEND_COMPILE_OPTIONS,
      globalName,
      // B3：后端 Bundle 生成外部 sourcemap；Pack 阶段继续排除 .map。
      // write:false + stdin 时 esbuild 需要 outfile 才能命名外部 map。
      outfile: `fh2-bundle-${globalName}.js`,
      plugins: [backendModulePolicyPlugin(pluginRoot)],
    })
  } catch (error) {
    const failures = (error as { errors?: readonly esbuild.Message[] }).errors
    if (Array.isArray(failures)) {
      throw new PluginBuildError(failures.map(failure => esbuildMessageToDiagnostic(failure, 'error')))
    }
    throw error
  }

  if (result.errors.length > 0) {
    throw new PluginBuildError(result.errors.map(error => esbuildMessageToDiagnostic(error, 'error')))
  }
  const warnings = result.warnings.map(error => esbuildMessageToDiagnostic(error, 'warning'))
  if (warnings.length > 0) {
    // Bundle 字节预算未定前只告警，不失败。
    for (const warning of warnings) {
      console.warn(`[fh2-backend-bundler] ${warning.code}: ${warning.message}`)
    }
  }

  const output = result.outputFiles?.find(file => !file.path.endsWith('.map'))
  const mapOutput = result.outputFiles?.find(file => file.path.endsWith('.map'))
  if (output === undefined) {
    throw new PluginBuildError([{
      code: 'FH2_BACKEND_BUNDLE_FAILED',
      phase: 'compile',
      message: `esbuild 未产出任何文件（${virtualEntryFile}）。`,
    }])
  }

  const iife = output.text
  const wrapperCode = wrappers
    .map(w => `function ${w.name}(input, ctx) {\n  return (0, ${globalName}.${w.namespaceMember})(input, ctx)\n}`)
    .join('\n\n')
  // Wrapper 在 IIFE 之前：避免 IIFE 中正则字面量的花括号干扰 Worker 顶层函数扫描。
  // 不注入 "use strict"：兼容当前 Worker 宽松模式（已确认决策 D9）。
  // esbuild format:iife + globalName 输出已自带 "var <globalName> = (...)()"。
  const prefix = `${wrapperCode}\n\n`
  const content = `${prefix}${iife}\n`

  // B3：map 的行号按 wrapper 前缀平移（前缀新增的行在 mappings 前补等量空行）；
  // sourceMappingURL 注释由 writeBundle 按实际输出文件名追加，本地缓存按
  // digest/sourceRevision 建索引（B4 消费）。
  let map: string | undefined
  if (mapOutput !== undefined) {
    const prefixLineCount = prefix.split('\n').length - 1
    const mapJson = JSON.parse(mapOutput.text) as { mappings: string; sources?: readonly string[] }
    map = JSON.stringify({
      ...mapJson,
      mappings: `${';'.repeat(prefixLineCount)}${mapJson.mappings}`,
    })
  }

  // 收集 watch 依赖（排除 virtual entry 自身）。
  const watchDependencies: string[] = []
  for (const inputPath of Object.keys(result.metafile?.inputs ?? {})) {
    if (inputPath === virtualEntryFile) continue
    watchDependencies.push(resolve(pluginRoot, inputPath))
  }

  return { content, ...(map === undefined ? {} : { map }), watchDependencies }
}

// ─── esbuild 模块策略 Plugin ─────────────────────────────────────────

function backendModulePolicyPlugin (pluginRoot: string): esbuild.Plugin {
  return {
    name: 'fh2-backend-module-policy',
    setup (build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        // Virtual entry 自身放行。
        if (args.path.startsWith('fh2:')) return null

        if (args.kind === 'entry-point') return null

        // import/export from 的模块
        if (args.kind === 'import-statement') {
          const specifier = args.path

          // 相对路径：解析后必须在插件根内（比较用 realpath 消除 symlink 差异）。
          if (isRelativeSpecifier(specifier)) {
            const resolved = resolve(args.resolveDir, specifier)
            const realRoot = realpathSync(pluginRoot)
            const realResolved = safeRealpath(resolved)
            const rel = relative(realRoot, realResolved)
            if (rel.startsWith('..')) {
              return {
                errors: [{
                  text: `FH2_BACKEND_IMPORT_OUTSIDE_ROOT: import 越过插件根目录：${specifier}。`,
                }],
              }
            }
            return null
          }

          // Node 内置模块。
          if (isNodeBuiltinSpecifier(specifier)) {
            return {
              errors: [{
                text: `FH2_BACKEND_NODE_IMPORT_FORBIDDEN: 禁止导入 Node 内置模块：${specifier}。`,
              }],
            }
          }

          // 裸 npm 包 / URL / data:。
          return {
            errors: [{
              text: `FH2_BACKEND_BARE_IMPORT_FORBIDDEN: Phase 1 只允许相对路径 import：${specifier}。`,
            }],
          }
        }

        // import type(类型导入):esbuild 编译期丢弃,不产运行时代码 —— 不会走到
        // 这里;走到 import-statement 的都是运行时依赖,策略照旧(裸包禁止)。

        return null
      })
    },
  }
}

function safeRealpath (path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // 文件可能不存在（esbuild 解析阶段），退回原路径。
    return path
  }
}

// ─── Runtime Manifest 改写（值级，不重建） ───────────────────────────

function rewriteEventsInRuntimeManifest (
  runtimeManifest: Record<string, unknown>,
  eventEntries: readonly EventConsumerEntry[],
): void {
  const events = runtimeManifest.events
  if (!Array.isArray(events)) return

  for (const entry of eventEntries) {
    const event = events[entry.eventIndex]
    if (event === null || typeof event !== 'object') continue
    const consumers = (event as Record<string, unknown>).consumer
    if (!Array.isArray(consumers)) continue
    const consumer = consumers[entry.consumerIndex]
    if (consumer === null || typeof consumer !== 'object') continue
    const consumerRecord = consumer as Record<string, unknown>
    consumerRecord.handler = EVENTS_OUTPUT
    consumerRecord.entry = `fh2_event_${entry.eventIndex}_${entry.consumerIndex}`
  }
}

function rewriteScriptsInRuntimeManifest (
  runtimeManifest: Record<string, unknown>,
  adapterEntries: readonly AdapterEntry[],
  entryNames: readonly string[],
): void {
  const scripts = runtimeManifest.scripts
  if (!Array.isArray(scripts)) return

  adapterEntries.forEach((entry, index) => {
    const script = scripts[entry.scriptIndex]
    if (script === null || typeof script !== 'object') return
    const scriptRecord = script as Record<string, unknown>
    scriptRecord.path = ADAPTER_OUTPUT
    scriptRecord.entry = entryNames[index] ?? entry.sourceEntry
  })
}

/**
 * DAG-020-03：runtime manifest 的 scripts[].entry 沿用**源声明的入口名**（打包产物
 * 同名顶层函数，包根可解析）。同一入口（path+entry 全同）被多个 script 声明时共用
 * 一个 wrapper；跨文件同名入口会撞顶层函数名——冲突者退回稳定序号
 * （fh2_adapter_<scriptIndex>），唯一性优先于可读性。
 */
function uniqueRuntimeEntryNames (entries: readonly AdapterEntry[]): string[] {
  const bySignature = new Map<string, string>()
  const takenNames = new Set<string>()
  return entries.map((entry) => {
    const signature = `${entry.sourcePath}:${entry.sourceEntry}`
    const shared = bySignature.get(signature)
    if (shared !== undefined) return shared
    const name = takenNames.has(entry.sourceEntry) ? `fh2_adapter_${entry.scriptIndex}` : entry.sourceEntry
    bySignature.set(signature, name)
    takenNames.add(name)
    return name
  })
}

// ─── 工具函数 ────────────────────────────────────────────────────────

/** B3：写 Bundle 与外部 sourcemap；sourceMappingURL 指向同目录 `<name>.map`。返回落盘最终内容（摘要据此计算，保证与文件一致）。 */
function writeBundle (candidateRoot: string, path: string, content: string, map?: string): string {
  const target = resolve(candidateRoot, path)
  mkdirSync(dirname(target), { recursive: true })
  const mapName = `${basename(path)}.map`
  const finalContent = map === undefined ? content : `${content}//# sourceMappingURL=${mapName}\n`
  writeFileSync(target, finalContent, 'utf8')
  if (map !== undefined) writeFileSync(resolve(candidateRoot, `${path}.map`), map, 'utf8')
  return finalContent
}

function hash (content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function esbuildMessageToDiagnostic (
  message: esbuild.Message,
  severity: 'error' | 'warning',
): BuildDiagnostic {
  const location = message.location
  // 模块策略插件以 "FH2_XXX: 说明" 文本上报错误；优先提取具体诊断码，
  // 避免一律折叠为 FH2_BACKEND_BUNDLE_FAILED（诊断目录需要逐码可路由）。
  const specificCode = /^FH2_[A-Z0-9_]+(?=:)/.exec(message.text)?.[0]
  return {
    code: specificCode ?? (severity === 'error' ? 'FH2_BACKEND_BUNDLE_FAILED' : 'FH2_BACKEND_BUNDLE_WARNING'),
    phase: BUILD_PHASES.compile,
    severity,
    ...(location != null && location.file !== ''
      ? { file: location.file }
      : {}),
    // B1：保留原始 TS file 与 1-based 行列；esbuild 列是 0-based，这里 +1 转换一次。
    ...(location?.line !== undefined && location.line > 0 ? { line: location.line } : {}),
    ...(location?.column !== undefined && location.column >= 0 ? { column: location.column + 1 } : {}),
    message: message.text,
  }
}
