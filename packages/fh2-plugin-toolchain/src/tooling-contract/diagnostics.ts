// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 人工诊断分类表：family / commands / phase / classification 都是工具分类标签，
 * 不是执行 phase 的事实源。旧 v1 的 phase 字段保留为人工 stage label（Bundle 兼容）；
 * exporter 的 runtime-policy.json 单独 source-scan 真实 phase，不用本表覆盖执行值。
 *
 * 不逐码手写 ~200 条记录，而是两层：
 * 1. DIAGNOSTIC_FAMILY_BY_MODULE —— 源文件路径（相对 src/，支持目录前缀）到模块级规则的映射；
 * 2. DIAGNOSTIC_EXCEPTIONS —— 个别码的真实归类与所在模块主流不同时的逐码覆盖（全局生效）。
 *
 * 守卫使用 scanDiagnosticSources 的 AST 字面量/文本诊断扫描做双向校验。
 * 环境变量或纯引用不会单独登记成诊断码；helper/caller phase 不可解析时保留 unresolved。
 *
 * 字段语义：
 * - family：诊断族（机器事实按族聚合生成知识分片）；
 * - commands：该模块诊断码以原码面给作者看的 CLI 命令；
 * - phase：legacy 字段名，人工 stage label；同码可在多个消费者中获得不同运行 phase；
 * - classification：validation=作者可修复，argument=CLI 用法，internal=工具链/环境异常，signal=进程信号。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { BUILD_PHASES } from '../build/policy.js'
import { deepFreeze, serializeContract } from './shared.js'

export type DiagnosticFamily =
  | 'manifest'
  | 'context'
  | 'source-policy'
  | 'build'
  | 'pack'
  | 'sign'
  | 'capability-workspace'
  | 'dist-verify'
  | 'code-consistency'

export type DiagnosticClassification = 'validation' | 'argument' | 'internal' | 'signal'

export type DiagnosticPhase =
  | 'parse'
  | 'schema'
  | 'semantic'
  | 'contract'
  | 'code'
  | 'discovery'
  | 'config'
  | 'generate'
  | 'resolve'
  | 'compile'
  | 'dist'
  | 'commit'
  | 'pack'

export interface DiagnosticModuleRule {
  readonly family: DiagnosticFamily;
  readonly commands: readonly string[];
  readonly phase: DiagnosticPhase;
  readonly classification: DiagnosticClassification;
}

export type DiagnosticModuleRuleTable = Readonly<Record<string, DiagnosticModuleRule>>
export type DiagnosticExceptionTable = Readonly<Record<string, DiagnosticModuleRule>>

/** classifyDiagnostic 的返回记录（module 为命中的注册表键；exception 命中时为 'exception'）。 */
export interface DiagnosticRecord {
  readonly code: string;
  readonly family: DiagnosticFamily;
  readonly commands: readonly string[];
  readonly phase: DiagnosticPhase;
  readonly classification: DiagnosticClassification;
  readonly module: string;
}

/**
 * 模块级规则表。键为相对 src/ 的源文件路径；以 '/' 结尾的键是目录前缀，
 * 精确文件路径优先于目录前缀，目录前缀按更长者优先。
 */
export const DIAGNOSTIC_FAMILY_BY_MODULE: DiagnosticModuleRuleTable = deepFreeze({
  'backend/build.ts': { family: 'build', commands: ['build', 'dev', 'pack'], phase: 'compile', classification: 'validation' },
  'backend/compiler.ts': { family: 'build', commands: ['build', 'dev', 'pack'], phase: 'compile', classification: 'validation' },
  // Runtime（Worker 契约）校验：诊断随 validate/create 直接面见作者，也随 build/pack/dev 的后端构建面见。
  'backend/contract.ts': { family: 'manifest', commands: ['build', 'create', 'dev', 'pack', 'validate'], phase: 'contract', classification: 'validation' },
  'backend/manifest.ts': { family: 'manifest', commands: ['build', 'dev', 'pack', 'preview'], phase: 'config', classification: 'validation' },
  'backend/pack.ts': { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'validation' },
  'backend/schema-facts.ts': { family: 'manifest', commands: ['build', 'create', 'dev', 'pack', 'validate'], phase: 'contract', classification: 'validation' },
  // Source 阶段模块策略（import/timer/async 等限制）；import 相关码在 build 的 esbuild 策略插件也会面见，见 exceptions。
  'backend/source-contract.ts': { family: 'source-policy', commands: ['create', 'validate'], phase: 'contract', classification: 'validation' },
  'build/policy.ts': { family: 'build', commands: ['build', 'dev', 'pack', 'preview'], phase: 'compile', classification: 'internal' },
  'build/paths.ts': { family: 'build', commands: ['build', 'dev', 'pack', 'preview'], phase: 'resolve', classification: 'validation' },
  'build/products.ts': { family: 'build', commands: ['build', 'dev', 'pack', 'preview'], phase: 'compile', classification: 'validation' },
  'build/runner.ts': { family: 'build', commands: ['build', 'dev', 'pack', 'preview'], phase: 'config', classification: 'validation' },
  // dist 提交/回滚/备份清理是工具链事务机制，不是作者可修复的校验错误。
  'build/transaction.ts': { family: 'build', commands: ['build', 'dev', 'pack', 'preview'], phase: 'commit', classification: 'internal' },
  'build/verify.ts': { family: 'dist-verify', commands: ['build', 'dev', 'pack', 'preview'], phase: 'dist', classification: 'validation' },
  // Capability/工作区编排以事务与失败包裹为主，个别码见 exceptions。
  'capability/build.ts': { family: 'capability-workspace', commands: ['build', 'dev', 'pack'], phase: 'commit', classification: 'internal' },
  'capability/dev.ts': { family: 'capability-workspace', commands: ['dev'], phase: 'commit', classification: 'internal' },
  'capability/discovery.ts': { family: 'context', commands: ['build', 'dev', 'generate', 'pack', 'preview', 'validate'], phase: 'discovery', classification: 'validation' },
  'capability/lock.ts': { family: 'capability-workspace', commands: ['build', 'pack'], phase: 'config', classification: 'internal' },
  'capability/migration-links.ts': { family: 'capability-workspace', commands: ['build', 'pack'], phase: 'config', classification: 'validation' },
  'capability/pack.ts': { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'validation' },
  'capability/validate.ts': { family: 'context', commands: ['validate'], phase: 'discovery', classification: 'validation' },
  'capability/zip.ts': { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'validation' },
  'commands/build-command.ts': { family: 'context', commands: ['build'], phase: 'discovery', classification: 'validation' },
  'commands/pack-command.ts': { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'validation' },
  'commands/dev-command.ts': { family: 'build', commands: ['dev'], phase: 'compile', classification: 'validation' },
  'commands/validate-command.ts': { family: 'code-consistency', commands: ['validate'], phase: 'code', classification: 'validation' },
  'contracts/': { family: 'context', commands: ['serve', 'mcp'], phase: 'config', classification: 'internal' },
  'dev/static-server.ts': { family: 'build', commands: ['dev'], phase: 'compile', classification: 'validation' },
  'dev/backend-plugin-dev.ts': { family: 'build', commands: ['dev'], phase: 'compile', classification: 'internal' },
  'mcp/': { family: 'context', commands: ['mcp'], phase: 'config', classification: 'internal' },
  // 目录前缀条目：package/ 与 pack/ 是单一职责目录，目录内文件的诊断族一致。
  'package/': { family: 'manifest', commands: ['build', 'dev', 'generate', 'pack', 'validate'], phase: 'discovery', classification: 'validation' },
  'pack/': { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'validation' },
  'serve/': { family: 'context', commands: ['serve'], phase: 'config', classification: 'internal' },
  'services/application/': { family: 'context', commands: ['build', 'create', 'dev', 'generate', 'pack', 'preview', 'serve', 'validate'], phase: 'discovery', classification: 'internal' },
  'services/ide/': { family: 'context', commands: ['serve'], phase: 'config', classification: 'validation' },
  'services/sourcemaps/': { family: 'build', commands: ['build', 'dev', 'preview', 'serve', 'mcp'], phase: 'compile', classification: 'internal' },
  'services/tasks/': { family: 'build', commands: ['build', 'pack', 'dev', 'serve', 'mcp'], phase: 'commit', classification: 'internal' },
  'services/typecheck/': { family: 'build', commands: ['build', 'pack', 'serve', 'mcp'], phase: 'compile', classification: 'validation' },
  'workflow/service/': { family: 'manifest', commands: ['serve'], phase: 'semantic', classification: 'validation' },
  // 签名目录：密钥经环境变量注入、对 pack 产物目录执行；诊断只面见 sign 命令。
  'sign/': { family: 'sign', commands: ['sign'], phase: 'pack', classification: 'validation' },
  'validate/code-consistency.ts': { family: 'code-consistency', commands: ['build', 'validate'], phase: 'code', classification: 'validation' },
  'validate/index.ts': { family: 'manifest', commands: ['generate', 'preview', 'validate'], phase: 'schema', classification: 'validation' },
  'validate/json-reader.ts': { family: 'manifest', commands: ['generate', 'validate'], phase: 'parse', classification: 'validation' },
  'validate/path-validator.ts': { family: 'manifest', commands: ['generate', 'validate'], phase: 'semantic', classification: 'validation' },
  'validate/point-contract-validator.ts': { family: 'manifest', commands: ['generate', 'validate'], phase: 'contract', classification: 'validation' },
  'validate/semantic-validator.ts': { family: 'manifest', commands: ['generate', 'validate'], phase: 'semantic', classification: 'validation' },
})

/**
 * 逐码例外（全局生效，优先于模块匹配）。每个键都是扫描结果中真实存在的码；
 * 守卫测试会验证「exceptions 的码必须出现在扫描结果中」，防止删码后注册表残留。
 */
export const DIAGNOSTIC_EXCEPTIONS: DiagnosticExceptionTable = deepFreeze({
  // —— 家族纠偏：真实族与所在模块的主流族不同 ——
  // Source 阶段复用 Runtime 校验的 manifest 诊断码（backend/source-contract.ts 主流族是 source-policy）。
  FH2_BACKEND_MANIFEST_INVALID: { family: 'manifest', commands: ['build', 'create', 'dev', 'pack', 'validate'], phase: 'contract', classification: 'validation' },
  FH2_BACKEND_REFERENCE_MISSING: { family: 'manifest', commands: ['build', 'create', 'dev', 'pack', 'validate'], phase: 'contract', classification: 'validation' },
  // schema.sql 契约事实：manifest 族；在 build/pack/dev 的构建路径也会面见。
  FH2_SCHEMA_SQL_INVALID: { family: 'manifest', commands: ['build', 'create', 'dev', 'pack', 'validate'], phase: 'contract', classification: 'validation' },
  FH2_SCHEMA_SQL_READ_FAILED: { family: 'manifest', commands: ['build', 'create', 'dev', 'pack', 'validate'], phase: 'contract', classification: 'validation' },
  // Capability 成员发现失败：context 族（出现在 capability/build.ts 等编排模块中）。
  FH2_CAPABILITY_PLUGIN_DISCOVERY_FAILED: { family: 'context', commands: ['build', 'dev', 'generate', 'pack', 'preview', 'validate'], phase: 'discovery', classification: 'validation' },
  // packages.json（工作区上传清单）缺失/不可读：manifest 族。
  FH2_PACKAGE_MANIFEST_NOT_FOUND: { family: 'manifest', commands: ['build', 'dev', 'generate', 'pack', 'validate'], phase: 'discovery', classification: 'validation' },
  // import 限制码在 build 的 esbuild 模块策略插件同样面见（source-contract 模块的 commands 不含 build）。
  FH2_BACKEND_NODE_IMPORT_FORBIDDEN: { family: 'source-policy', commands: ['build', 'create', 'dev', 'pack', 'validate'], phase: 'contract', classification: 'validation' },
  FH2_BACKEND_BARE_IMPORT_FORBIDDEN: { family: 'source-policy', commands: ['build', 'create', 'dev', 'pack', 'validate'], phase: 'contract', classification: 'validation' },
  FH2_BACKEND_IMPORT_OUTSIDE_ROOT: { family: 'source-policy', commands: ['build', 'dev', 'pack'], phase: 'compile', classification: 'validation' },
  // Application Service 统一信封诊断跨越多个薄命令适配器，按稳定 code 归类。
  FH2_PROJECT_NOT_RECOGNIZED: { family: 'context', commands: ['build', 'generate', 'pack', 'validate'], phase: 'discovery', classification: 'validation' },
  FH2_PROJECT_DISCOVERY_FAILED: { family: 'context', commands: ['serve', 'mcp'], phase: 'discovery', classification: 'internal' },
  FH2_CREATE_FAILED: { family: 'context', commands: ['create'], phase: 'parse', classification: 'validation' },
  FH2_GENERATE_OUTDATED: { family: 'manifest', commands: ['generate'], phase: 'generate', classification: 'validation' },
  FH2_GENERATE_PATH_INVALID: { family: 'manifest', commands: ['generate'], phase: 'generate', classification: 'validation' },
  FH2_GENERATE_FAILED: { family: 'manifest', commands: ['generate'], phase: 'generate', classification: 'internal' },
  FH2_PACK_MEMBERS_INVALID: { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'argument' },
  FH2_BUILD_FAILED: { family: 'build', commands: ['build', 'dev'], phase: 'compile', classification: 'internal' },
  // —— signal 纠偏：AbortSignal 触发的中断不是失败 ——
  FH2_CAPABILITY_BUILD_ABORTED: { family: 'capability-workspace', commands: ['build', 'dev', 'pack'], phase: 'commit', classification: 'signal' },
  FH2_INDUSTRY_CAPABILITY_WORKSPACE_BUILD_ABORTED: { family: 'capability-workspace', commands: ['build', 'pack'], phase: 'commit', classification: 'signal' },
  // —— 分类纠偏 ——
  // Capability 构建期间输入（packages.json/capabilities.json）变更：作者重新构建即可。
  FH2_CAPABILITY_BUILD_INPUT_CHANGED: { family: 'capability-workspace', commands: ['build', 'pack'], phase: 'commit', classification: 'validation' },
  // 以下均为 catch-all 失败包裹或事务提交/回滚失败：环境或工具链异常，作者不可直接修复。
  FH2_BACKEND_BUILD_FAILED: { family: 'build', commands: ['build', 'dev', 'pack'], phase: 'commit', classification: 'internal' },
  FH2_BACKEND_BUNDLE_FAILED: { family: 'build', commands: ['build', 'dev', 'pack'], phase: 'compile', classification: 'internal' },

  FH2_BACKEND_PACK_FAILED: { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'internal' },
  FH2_BACKEND_PACK_COMMIT_FAILED: { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'internal' },
  FH2_FRONTEND_PACK_FAILED: { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'internal' },
  FH2_PACK_BACKUP_CLEANUP_FAILED: { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'internal' },
  FH2_PACK_COMMIT_FAILED: { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'internal' },
  FH2_PACK_COMMIT_ROLLBACK_FAILED: { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'internal' },
  FH2_PACK_FAILED: { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'internal' },
  FH2_CAPABILITY_PACK_BACKUP_CLEANUP_FAILED: { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'internal' },
  FH2_CAPABILITY_PACK_COMMIT_FAILED: { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'internal' },
  FH2_CAPABILITY_PACK_FAILED: { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'internal' },
  FH2_CAPABILITY_PACK_ROLLBACK_FAILED: { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'internal' },
  FH2_INDUSTRY_CAPABILITY_WORKSPACE_PACK_FAILED: { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'internal' },
  // 签名输出写入失败：输出路径不可写属环境异常，作者改参数无法修复。
  FH2_SIGN_OUTPUT_WRITE_FAILED: { family: 'sign', commands: ['sign'], phase: 'pack', classification: 'internal' },
})

/**
 * Legacy export slot. AST scanning now covers template prefixes and stderr codes;
 * no codes need a separately maintained supplementary inventory.
 */
export const DIAGNOSTIC_SUPPLEMENTARY: DiagnosticExceptionTable = deepFreeze({})

// ---------------------------------------------------------------------------
// 访问器（消费方统一从这里读，不自行解析注册表结构）
// ---------------------------------------------------------------------------

/**
 * 匹配模块级规则：先精确文件路径，再按目录前缀从长到短回退（'a/b/c.ts' → 'a/b/' → 'a/'）。
 * 支持传入自定义表（守卫测试用 fixture 验证前缀语义）。
 */
export function matchDiagnosticModuleRule (
  table: DiagnosticModuleRuleTable,
  sourceModule: string,
): DiagnosticModuleRule | undefined {
  const normalized = sourceModule.replace(/^src\//, '')
  if (Object.hasOwn(table, normalized)) return table[normalized]
  const segments = normalized.split('/')
  for (let end = segments.length - 1; end >= 1; end -= 1) {
    const prefix = `${segments.slice(0, end).join('/')}/`
    if (Object.hasOwn(table, prefix)) return table[prefix]
  }
  return undefined
}

/**
 * 分类单个诊断码：exceptions 优先（按码全局生效），其次 legacy supplementary，
 * 否则按来源模块匹配规则表；全部未命中时抛错（fail closed，强制新模块/新码先登记再发布）。
 * sourceModule 接受相对 src/ 的路径或带 src/ 前缀的路径。
 */
export function classifyDiagnostic (code: string, sourceModule: string): DiagnosticRecord {
  const exception = DIAGNOSTIC_EXCEPTIONS[code]
  if (exception !== undefined) {
    return { code, ...exception, module: 'exception' }
  }
  const supplementary = DIAGNOSTIC_SUPPLEMENTARY[code]
  if (supplementary !== undefined) {
    return { code, ...supplementary, module: 'supplementary' }
  }
  const rule = matchDiagnosticModuleRule(DIAGNOSTIC_FAMILY_BY_MODULE, sourceModule)
  if (rule === undefined) {
    throw new Error(`诊断码 ${code} 的来源模块未登记：${sourceModule}（相对 src/ 的路径或目录前缀）`)
  }
  return { code, ...rule, module: sourceModule.replace(/^src\//, '') }
}

/** 导出器唯一使用的注册表序列化器。 */
export function serializeDiagnosticRegistry (
  modules: DiagnosticModuleRuleTable = DIAGNOSTIC_FAMILY_BY_MODULE,
  exceptions: DiagnosticExceptionTable = DIAGNOSTIC_EXCEPTIONS,
  supplementary: DiagnosticExceptionTable = DIAGNOSTIC_SUPPLEMENTARY,
): string {
  return serializeContract({ schemaVersion: 1, metadataOrigin: 'manual-tool-classification', phaseMeaning: 'manual-stage-label', modules, exceptions, supplementary })
}

export interface DiagnosticSourceOccurrence {
  readonly module: string;
  readonly line: number;
  readonly column: number;
  readonly usage: 'code-field' | 'diagnostic-argument' | 'message-prefix' | 'reference';
  readonly phases: readonly string[];
  readonly phaseOrigin: 'literal' | 'shared-policy' | 'unresolved';
}

/** Source evidence only: unresolved helper/caller phases remain unresolved, never module-inferred. */
export function scanDiagnosticSources (srcRoot: string): readonly {
  readonly code: string;
  readonly occurrences: readonly DiagnosticSourceOccurrence[];
}[] {
  const codes = new Map<string, DiagnosticSourceOccurrence[]>()
  const visitDirectory = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== 'tooling-contract' && entry.name !== 'template-variants') visitDirectory(join(directory, entry.name))
        continue
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.startsWith('template')) continue
      const file = join(directory, entry.name)
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const module = relative(srcRoot, file).split(sep).join('/')
      let checker: ts.TypeChecker | undefined
      const isImportedBuildPhases = (identifier: ts.Identifier): boolean => {
        if (checker === undefined) {
          // Bind only this in-memory source: lexical symbols suffice, no import/type resolution needed.
          const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [] }
          const host = ts.createCompilerHost(options)
          host.getSourceFile = path => path === file ? source : undefined
          host.fileExists = path => path === file
          host.readFile = () => undefined
          checker = ts.createProgram([file], options, host).getTypeChecker()
        }
        const declarations = checker.getSymbolAtLocation(identifier)?.declarations
        if (declarations?.length !== 1) return false
        const declaration = declarations[0]!
        if (!ts.isImportSpecifier(declaration) || declaration.isTypeOnly
          || (declaration.propertyName ?? declaration.name).text !== 'BUILD_PHASES') {
          return false
        }
        const importDeclaration = declaration.parent.parent.parent
        return ts.isImportDeclaration(importDeclaration) && importDeclaration.importClause?.isTypeOnly !== true
          && ts.isStringLiteral(importDeclaration.moduleSpecifier)
          && resolve(dirname(file), importDeclaration.moduleSpecifier.text.replace(/\.js$/, '.ts')) === resolve(srcRoot, 'build/policy.ts')
      }
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          const matches = node.text.match(/\bFH2_[A-Z0-9_]+\b/g) ?? []
          for (const code of matches) {
            const textOutput = ts.isCallExpression(node.parent) && /(?:\.write|console\.(?:warn|error))$/.test(node.parent.expression.getText(source))
            const messagePrefix = new RegExp(`^${code}(?=:|\\s+\\[)`).test(node.text)
              || (textOutput && new RegExp(`${code}(?=[：:\\n]|$)`).test(node.text))
            if (node.text !== code && !messagePrefix) continue
            const position = source.getLineAndCharacterOfPosition(node.getStart(source))
            const parent = node.parent
            let codeField = false
            const diagnosticArgument = ts.isCallExpression(parent) || ts.isNewExpression(parent)
              ? /(?:Error|Diagnostic|diagnostic|buildError|asBuildError)$/.test(parent.expression.getText(source))
              : false
            let phase: ts.Expression | undefined
            for (let ancestor: ts.Node | undefined = parent; ancestor !== undefined; ancestor = ancestor.parent) {
              if (ts.isPropertyAssignment(ancestor) && ['code', 'diagnosticCode'].includes(ancestor.name.getText(source))) codeField = true
              if (ts.isObjectLiteralExpression(ancestor)) {
                const property = ancestor.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(source) === 'phase')
                if (property !== undefined && ts.isPropertyAssignment(property)) {
                  phase = property.initializer
                  break
                }
              }
              if (ts.isCallExpression(ancestor) && ts.isIdentifier(ancestor.expression)) {
                const helper = ancestor.expression.text
                if (helper === 'buildError' || helper === 'buildDiagnostic' || helper === 'asBuildError') {
                  // asBuildError(error, phase, code), unlike buildError/buildDiagnostic(phase, code, ...).
                  const codeIndex = helper === 'asBuildError' ? 2 : 1
                  phase = ancestor.arguments[codeIndex] === node ? ancestor.arguments[codeIndex - 1] : undefined
                  break
                }
              }
              if (ts.isStatement(ancestor)) break
            }
            let phaseOrigin: DiagnosticSourceOccurrence['phaseOrigin'] = 'unresolved'
            const phases: string[] = []
            if (phase !== undefined) {
              if (ts.isAsExpression(phase)) phase = phase.expression
              if (ts.isStringLiteral(phase)) {
                phases.push(phase.text)
                phaseOrigin = 'literal'
              } else if (ts.isPropertyAccessExpression(phase) && ts.isIdentifier(phase.expression)) {
                const key = phase.name.text as keyof typeof BUILD_PHASES
                if (Object.hasOwn(BUILD_PHASES, key) && isImportedBuildPhases(phase.expression)) {
                  phases.push(BUILD_PHASES[key])
                  phaseOrigin = 'shared-policy'
                }
              }
            }
            const occurrence: DiagnosticSourceOccurrence = {
              module,
              line: position.line + 1,
              column: position.character + 1,
              usage: codeField ? 'code-field' : diagnosticArgument ? 'diagnostic-argument' : messagePrefix ? 'message-prefix' : 'reference',
              phases,
              phaseOrigin,
            }
            const occurrences = codes.get(code) ?? []
            occurrences.push(occurrence)
            codes.set(code, occurrences)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  visitDirectory(srcRoot)
  return [...codes].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .filter(([, occurrences]) => occurrences.some(item => item.usage !== 'reference'))
    .map(([code, occurrences]) => ({ code, occurrences: occurrences.sort((left, right) => left.module.localeCompare(right.module) || left.line - right.line || left.column - right.column) }))
}
