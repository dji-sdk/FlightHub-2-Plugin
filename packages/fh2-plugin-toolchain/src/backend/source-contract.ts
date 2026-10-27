// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { parseStrictJson } from '../validate/json-reader.js'
import { BACKEND_SOURCE_DIRECTORIES, PROJECT_PATHS } from '../project-policy.js'
import { FORBIDDEN_GLOBALS, SOURCE_POLICY_PATTERNS, forbiddenGlobalPattern, hasModuleSyntax, isNodeBuiltinSpecifier, isRelativeSpecifier } from './policy.js'
import type {
  BackendContractDiagnostic,
  WorkerBackendPluginManifest,
} from './contract.js'
import { BACKEND_SOURCE_MANIFEST_FILE, validateBackendPlugin } from './contract.js'
import { discoverBackendHandlerFiles } from './discovery.js'
import { SchemaFactsError, readSchemaFacts, renderWorkerEntities } from './schema-facts.js'

export { hasModuleSyntax } from './policy.js'

/**
 * Source 阶段校验：面向作者 ESM 源码目录。
 *
 * 与 Runtime 阶段（validateBackendPlugin）的分工：
 * - Source 允许 import/export（不交给 node:vm.Script，语法合法性由 esbuild 在 Bundle 阶段裁决）。
 * - Source 校验匹配到的说明符与语法；相对 import 越界只由 Bundle 的 esbuild onResolve 检查。
 * - Runtime 阶段校验 Bundle 后普通 JS，继续使用现有 validateBackendPlugin。
 */

export interface BackendSourceValidationResult {
  readonly ok: boolean;
  readonly diagnostics: readonly BackendContractDiagnostic[];
  readonly manifest?: WorkerBackendPluginManifest;
  /** 有效 plugin.json，供 Bundle 阶段做值级改写，禁止经 TS 类型重建。 */
  readonly manifestJson?: Readonly<Record<string, unknown>>;
  /** entities 由根目录 schema.sql 推导而来。 */
  readonly generatedEntities?: boolean;
}

export interface SourceModulePolicyOptions {
  readonly pluginRoot: string;
  readonly manifest: WorkerBackendPluginManifest;
}

export function validateBackendSourcePlugin (pluginRoot: string): BackendSourceValidationResult {
  const base = validateBackendPluginManifestOnly(pluginRoot)
  if (!base.ok) return { ok: false, diagnostics: base.diagnostics }

  const diagnostics: BackendContractDiagnostic[] = []
  validateSourceModulePolicy(pluginRoot, base.manifest!, diagnostics)

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics }
  }
  return {
    ok: true,
    diagnostics: [],
    manifest: base.manifest,
    manifestJson: base.manifestJson,
    ...(base.generatedEntities ? { generatedEntities: true } : {}),
  }
}

/** 只做 Manifest/资产名/Workflow 校验，跳过对 JS 的 node:vm.Script 校验（那一路在 validateSourceModulePolicy 中用 esbuild 策略替代）。 */
function validateBackendPluginManifestOnly (pluginRoot: string): {
  ok: true;
  manifest: WorkerBackendPluginManifest;
  manifestJson: Readonly<Record<string, unknown>>;
  generatedEntities: boolean;
} | {
  ok: false;
  diagnostics: readonly BackendContractDiagnostic[];
} {
  // 先严格读取源 JSON；在未声明 entities 时以 schema.sql 派生有效 Manifest，
  // 再复用 Runtime 的 Worker-like 校验。ESM 语法诊断仍由本模块的策略校验替代。
  const sourceManifest = readManifestJson(pluginRoot)
  if (!sourceManifest.ok) return sourceManifest
  if (!isRecord(sourceManifest.manifestJson)) {
    const result = validateBackendPlugin(
      pluginRoot,
      sourceManifest.manifestJson,
      BACKEND_SOURCE_MANIFEST_FILE,
    )
    return result.ok
      ? { ok: false, diagnostics: [{
          code: 'FH2_BACKEND_MANIFEST_INVALID',
          file: BACKEND_SOURCE_MANIFEST_FILE,
          message: `后端 ${BACKEND_SOURCE_MANIFEST_FILE} 必须是对象。`,
        }] }
      : { ok: false, diagnostics: result.diagnostics }
  }

  const effective = injectSchemaEntities(pluginRoot, sourceManifest.manifestJson)
  if (!effective.ok) return effective
  const result = validateBackendPlugin(
    pluginRoot,
    effective.manifestJson,
    BACKEND_SOURCE_MANIFEST_FILE,
  )

  if (result.ok) {
    return {
      ok: true,
      manifest: result.manifest,
      manifestJson: effective.manifestJson,
      generatedEntities: effective.generatedEntities,
    }
  }

  // 区分「ESM 语法错」与「其他结构错」：
  // node:vm.Script 在遇到 import/export 时报 SyntaxError，其诊断文案以 "JavaScript 语法错误" 开头。
  // 这些项在 Source 阶段被移除，交给后续 esbuild Bundle 判断。
  const nonEsmDiagnostics = result.diagnostics.filter(item =>
    !(item.message.includes('JavaScript 语法错误') && looksLikeModuleSyntaxMessage(item.message)))
  if (nonEsmDiagnostics.length > 0) {
    return { ok: false, diagnostics: nonEsmDiagnostics }
  }
  return {
    ok: true,
    manifest: unsafeCastManifest(effective.manifestJson),
    manifestJson: effective.manifestJson,
    generatedEntities: effective.generatedEntities,
  }
}

function looksLikeModuleSyntaxMessage (message: string): boolean {
  return /import|export|Cannot use (import|export)|Unexpected (token|identifier)/i.test(message)
}

function readManifestJson (pluginRoot: string): {
  ok: true;
  manifestJson: unknown;
} | {
  ok: false;
  diagnostics: readonly BackendContractDiagnostic[];
} {
  let raw: string
  try {
    raw = readFileSync(resolve(pluginRoot, BACKEND_SOURCE_MANIFEST_FILE), 'utf8')
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        code: 'FH2_BACKEND_MANIFEST_INVALID',
        file: BACKEND_SOURCE_MANIFEST_FILE,
        message: `无法读取后端 ${BACKEND_SOURCE_MANIFEST_FILE}：${errorMessage(error)}`,
      }],
    }
  }
  const parsed = parseStrictJson(raw, BACKEND_SOURCE_MANIFEST_FILE)
  if (!parsed.ok) {
    return {
      ok: false,
      diagnostics: parsed.diagnostics.map(item => ({
        code: 'FH2_BACKEND_MANIFEST_INVALID',
        file: BACKEND_SOURCE_MANIFEST_FILE,
        message: item.message,
        ...(item.path === undefined ? {} : { path: item.path }),
      })),
    }
  }
  return { ok: true, manifestJson: parsed.parsed.value }
}

function unsafeCastManifest (value: Readonly<Record<string, unknown>>): WorkerBackendPluginManifest {
  return value as unknown as WorkerBackendPluginManifest
}

function injectSchemaEntities (
  pluginRoot: string,
  manifestJson: Readonly<Record<string, unknown>>,
): {
  ok: true;
  manifestJson: Readonly<Record<string, unknown>>;
  generatedEntities: boolean;
} | {
  ok: false;
  diagnostics: readonly BackendContractDiagnostic[];
} {
  if (Object.prototype.hasOwnProperty.call(manifestJson, 'entities')
    || !existsSync(resolve(pluginRoot, PROJECT_PATHS.schemaSql))) {
    return { ok: true, manifestJson, generatedEntities: false }
  }
  try {
    return {
      ok: true,
      manifestJson: {
        ...manifestJson,
        entities: renderWorkerEntities(readSchemaFacts(pluginRoot)),
      },
      generatedEntities: true,
    }
  } catch (error) {
    return { ok: false, diagnostics: schemaFactsDiagnostics(error) }
  }
}

function schemaFactsDiagnostics (error: unknown): readonly BackendContractDiagnostic[] {
  if (error instanceof SchemaFactsError) {
    return error.diagnostics.map(diagnostic => ({
      code: diagnostic.code,
      file: diagnostic.file,
      message: `schema.sql 第 ${diagnostic.line} 行第 ${diagnostic.column} 列${diagnostic.statement === undefined ? '' : `（第 ${diagnostic.statement} 条语句）`}：${diagnostic.message}`,
    }))
  }
  return [{
    code: 'FH2_SCHEMA_SQL_INVALID',
    file: 'schema.sql',
    message: `无法解析 schema.sql：${errorMessage(error)}`,
  }]
}

function validateSourceModulePolicy (
  pluginRoot: string,
  manifest: WorkerBackendPluginManifest,
  diagnostics: BackendContractDiagnostic[],
): void {
  const entryFiles = collectEntryFiles(pluginRoot, manifest)

  // scripts[] / events[] 声明的入口文件：必须存在，且遵守模块策略。
  for (const file of entryFiles.declared) {
    const source = readSourceFile(pluginRoot, file)
    if (source === undefined) {
      diagnostics.push(sourceDiagnostic('FH2_BACKEND_REFERENCE_MISSING', file, `入口文件不存在：${file}。`))
      continue
    }
    validateModuleSyntax(pluginRoot, file, source, diagnostics)
  }

  // handlers/**：发现即校验。
  for (const file of entryFiles.handlers) {
    const source = readSourceFile(pluginRoot, file)
    if (source === undefined) continue
    validateModuleSyntax(pluginRoot, file, source, diagnostics)
  }

  // shared/** is scanned independently; this does not traverse the import dependency graph.
  for (const file of entryFiles.shared) {
    const source = readSourceFile(pluginRoot, file)
    if (source === undefined) continue
    validateModuleSyntax(pluginRoot, file, source, diagnostics)
  }

  // evaluators/**：Phase 1 策略——普通 JS 原样复制，禁止 ESM。
  for (const file of entryFiles.evaluators) {
    const source = readSourceFile(pluginRoot, file)
    if (source === undefined) continue
    if (hasModuleSyntax(source)) {
      diagnostics.push(sourceDiagnostic(
        'FH2_BACKEND_EVALUATOR_ESM_UNSUPPORTED',
        file,
        `Evaluator 在 Phase 1 只支持普通 JavaScript（原样复制），不支持 import/export：${file}。`,
      ))
    }
  }
}

interface SourceEntryFiles {
  readonly declared: readonly string[];
  readonly handlers: readonly string[];
  readonly evaluators: readonly string[];
  /** shared/ 与其他被 import 的模块:策略校验(async/模块规则)同样适用。 */
  readonly shared: readonly string[];
}

function collectEntryFiles (pluginRoot: string, manifest: WorkerBackendPluginManifest): SourceEntryFiles {
  const declared = new Set<string>()
  for (const script of manifest.scripts ?? []) {
    if (script.path !== undefined) declared.add(script.path)
  }
  for (const event of manifest.events ?? []) {
    for (const consumer of event.consumer) {
      if (consumer.handler !== undefined) declared.add(consumer.handler)
    }
  }
  const evaluators = new Set<string>()
  for (const evaluator of manifest.evaluators ?? []) {
    if (evaluator.path !== undefined) evaluators.add(evaluator.path)
  }
  const handlers = discoverBackendHandlerFiles(pluginRoot)
    .filter(item => item.kind === 'source')
    .map(item => item.path)
  const shared = discoverSharedFiles(pluginRoot)
  return {
    declared: [...declared].sort(),
    handlers,
    evaluators: [...evaluators].sort(),
    shared,
  }
}

/** Scan all shared/ .ts/.js files except declarations, whether imported or not. */
function discoverSharedFiles (pluginRoot: string): readonly string[] {
  const sharedRoot = resolve(pluginRoot, BACKEND_SOURCE_DIRECTORIES.shared)
  if (!existsSync(sharedRoot)) return []
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(abs)
        continue
      }
      if (entry.name.endsWith('.d.ts')) continue
      if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
        out.push(relative(pluginRoot, abs).split(sep).join('/'))
      }
    }
  }
  visit(sharedRoot)
  return out.sort()
}

function readSourceFile (pluginRoot: string, file: string): string | undefined {
  try {
    return readFileSync(resolve(pluginRoot, file), 'utf8')
  } catch {
    return undefined
  }
}

/** 检查单份源码的模块语法策略。 */
export function validateModuleSyntax (
  _pluginRoot: string,
  file: string,
  source: string,
  diagnostics: BackendContractDiagnostic[],
): void {
  // ESM import/export：允许（这是 Phase 1 的目标），但只允许静态相对路径。
  validateImportSpecifiers(file, source, diagnostics)

  // 禁止 CommonJS require / 动态 import / import.meta / eval / Function / timer 全局。
  validateForbiddenSyntax(file, source, diagnostics)
}

function validateImportSpecifiers (
  file: string,
  source: string,
  diagnostics: BackendContractDiagnostic[],
): void {
  // import type { ... } from '裸包' 是类型层依赖(esbuild 剥离后零运行时残留),
  // 放行 —— SDK 类型消费是后端 TS 的正路;下方的负向前瞻 (?!type\b) 把它们从
  // 运行时 import 的校验里排除。运行时 import 的裸包照旧禁止。
  for (const match of source.matchAll(SOURCE_POLICY_PATTERNS.runtimeImport)) {
    validateSpecifier(file, match[1]!, 'import', diagnostics)
  }
  for (const match of source.matchAll(SOURCE_POLICY_PATTERNS.runtimeExport)) {
    validateSpecifier(file, match[1]!, 'export from', diagnostics)
  }
  for (const match of source.matchAll(SOURCE_POLICY_PATTERNS.dynamicImport)) {
    diagnostics.push(sourceDiagnostic(
      'FH2_BACKEND_DYNAMIC_IMPORT_FORBIDDEN',
      file,
      `禁止动态 import()：${file} 中的 "${match[1]}"。`,
    ))
  }
}

function validateSpecifier (
  file: string,
  specifier: string,
  kind: 'import' | 'export from',
  diagnostics: BackendContractDiagnostic[],
): void {
  if (isNodeBuiltinSpecifier(specifier)) {
    diagnostics.push(sourceDiagnostic(
      'FH2_BACKEND_NODE_IMPORT_FORBIDDEN',
      file,
      `禁止导入 Node 内置模块：${file} 中 ${kind} "${specifier}"。`,
    ))
    return
  }
  if (!isRelativeSpecifier(specifier)) {
    diagnostics.push(sourceDiagnostic(
      'FH2_BACKEND_BARE_IMPORT_FORBIDDEN',
      file,
      `Phase 1 只允许相对路径 import，禁止裸包名或 URL：${file} 中 ${kind} "${specifier}"。`,
    ))
  }
  // Relative target containment is checked only by esbuild onResolve, not this regex precheck.
}

function validateForbiddenSyntax (file: string, source: string, diagnostics: BackendContractDiagnostic[]): void {
  // import.meta
  if (SOURCE_POLICY_PATTERNS.importMeta.test(source)) {
    diagnostics.push(sourceDiagnostic(
      'FH2_BACKEND_IMPORT_META_FORBIDDEN',
      file,
      `禁止使用 import.meta：${file}。`,
    ))
  }
  // require 调用
  for (const match of source.matchAll(SOURCE_POLICY_PATTERNS.require)) {
    diagnostics.push(sourceDiagnostic(
      'FH2_BACKEND_REQUIRE_FORBIDDEN',
      file,
      `禁止 CommonJS require：${file} 中的 "${match[1]}"。`,
    ))
  }
  // eval / new Function
  if (SOURCE_POLICY_PATTERNS.eval.test(stripStringLiterals(source))) {
    diagnostics.push(sourceDiagnostic('FH2_BACKEND_EVAL_FORBIDDEN', file, `禁止 eval：${file}。`))
  }
  if (SOURCE_POLICY_PATTERNS.functionConstructor.test(stripStringLiterals(source))) {
    diagnostics.push(sourceDiagnostic('FH2_BACKEND_EVAL_FORBIDDEN', file, `禁止 new Function：${file}。`))
  }
  // timer 全局
  for (const global of FORBIDDEN_GLOBALS) {
    if (forbiddenGlobalPattern(global).test(stripStringLiterals(source))) {
      diagnostics.push(sourceDiagnostic(
        'FH2_BACKEND_TIMER_FORBIDDEN',
        file,
        `Goja 沙箱没有 Event Loop，禁止 ${global}：${file}。延迟任务请使用 flow.start 或 Workflow Timer。`,
      ))
    }
  }
  // ── TS 源码策略──────────────────────────────────────────────────────────
  // async:esbuild 对 es2015 会把 async 降级成 generator 语义,且 HTTP/作业路的
  // 重试语义禁 Promise 返回 —— 双重理由,一律拒绝。
  if (SOURCE_POLICY_PATTERNS.asyncFunction.test(stripStringLiterals(source))) {
    diagnostics.push(sourceDiagnostic(
      'FH2_BACKEND_ASYNC_FORBIDDEN',
      file,
      `禁止 async 函数：${file}。Goja 沙箱按同步语义执行(Handler 返回 Promise 不会被等待);延迟任务请使用 flow.start 或 Workflow Timer。`,
    ))
  }
  if (SOURCE_POLICY_PATTERNS.asyncCall.test(stripStringLiterals(source)) || SOURCE_POLICY_PATTERNS.arrowAwait.test(stripStringLiterals(source)) || SOURCE_POLICY_PATTERNS.await.test(stripStringLiterals(source))) {
    diagnostics.push(sourceDiagnostic(
      'FH2_BACKEND_ASYNC_FORBIDDEN',
      file,
      `禁止 async/await：${file}。Goja 沙箱按同步语义执行(Handler 返回 Promise 不会被等待)。`,
    ))
  }
}

/** Strip literal contents before keyword matching; this is not an AST parser. */
function stripStringLiterals (source: string): string {
  return source.replace(SOURCE_POLICY_PATTERNS.stringLiterals, ' ')
}

function sourceDiagnostic (
  code: string,
  file: string,
  message: string,
): BackendContractDiagnostic {
  return { code, file, message }
}

function isRecord (value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
