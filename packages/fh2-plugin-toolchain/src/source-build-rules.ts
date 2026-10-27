// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 持久化 SourceBuildRules v1 投影。路径与模块清单来自生产 policy；此旧结构不是
 * 全部运行行为的模型：pack includes/pathRewrites 是从生产路径派生的只读布局摘要，
 * 不声明 copy allowlist 或通用 rewrite executor；typecheck 只表达缺省配置路径。
 *
 * 值的机械来源（每条规则注明）：
 * - sourceDiscovery：backend/discovery.ts、backend/contract.ts（BACKEND_SOURCE_MANIFEST_FILE）、
 *   backend/build.ts（运行时目录表）、build/paths.ts（缺省入口/类型/视图路径）。
 * - importRestrictions：backend/policy.ts 的 NODE_BUILTIN_MODULES。
 * - buildTargets：build/paths.ts（distRoot）与 backend/build.ts / backend/pack.ts（dist）。
 * - pack：backend/pack.ts（dist → release）与 pack/index.ts（前端 dist 契约）。
 * - pathRewrites：backend/compiler.ts（handlers/events → scripts bundle）与
 *   002 规范 §3.1 的 dist 布局（plugin.json + scripts/ + workflows/）。
 *
 * ⚠️ Worker Runtime Manifest/Workflow 语义（kind 标签、io 声明、trigger 段）由
 * Worker 提供，本对象不重新定义。
 * 行为级语法策略由 source-contract.ts 消费 backend/policy.ts；v1 不增字段，
 * regex/全局名单在独立 runtime-policy.json 中投影。
 */

import { BACKEND_SOURCE_DIRECTORIES, PROJECT_PATHS } from './project-policy.js'
import { NODE_BUILTIN_MODULES, NODE_BUILTIN_PREFIX } from './backend/policy.js'

export type PluginSide = 'frontend' | 'backend'

export interface SourceDiscoveryRule {
  readonly id: string;
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
}

export interface ImportRestrictionRule {
  readonly id: string;
  readonly side: PluginSide;
  readonly forbiddenModules: readonly string[];
}

export interface TypecheckRule {
  readonly id: string;
  readonly side: PluginSide;
  /** Shared default path; this record does not enable or attest execution of Typecheck. */
  readonly tsconfigPath: string;
}

export interface BuildTargetRule {
  readonly id: string;
  readonly side: PluginSide;
  readonly outputDirectory: string;
}

export interface PackRule {
  readonly id: string;
  /** Readonly path-derived layout summary, not the runtime copy allowlist. */
  readonly includes: readonly string[];
}

export interface PathRewriteRule {
  /** Readonly source/runtime layout relation, not an instruction interpreted by the compiler. */
  readonly from: string;
  readonly to: string;
}

export interface SourceBuildRules {
  readonly schemaVersion: number;
  readonly sourceDiscovery: readonly SourceDiscoveryRule[];
  readonly importRestrictions: readonly ImportRestrictionRule[];
  readonly typecheck: readonly TypecheckRule[];
  readonly buildTargets: readonly BuildTargetRule[];
  readonly pack: readonly PackRule[];
  readonly pathRewrites: readonly PathRewriteRule[];
}

const TYPE_DECLARATION_EXCLUDE = ['**/*.d.ts']

export const SOURCE_BUILD_RULES: SourceBuildRules = Object.freeze({
  schemaVersion: 1,
  sourceDiscovery: [
    { id: 'backend-manifest', include: [PROJECT_PATHS.sourceManifest] },
    { id: 'backend-handlers', include: [`${BACKEND_SOURCE_DIRECTORIES.handlers}/**`], exclude: TYPE_DECLARATION_EXCLUDE },
    { id: 'backend-events', include: [`${BACKEND_SOURCE_DIRECTORIES.events}/**`], exclude: TYPE_DECLARATION_EXCLUDE },
    { id: 'backend-adapters', include: [`${BACKEND_SOURCE_DIRECTORIES.adapters}/**`], exclude: TYPE_DECLARATION_EXCLUDE },
    { id: 'backend-evaluators', include: [`${BACKEND_SOURCE_DIRECTORIES.evaluators}/**`], exclude: TYPE_DECLARATION_EXCLUDE },
    { id: 'backend-shared', include: [`${BACKEND_SOURCE_DIRECTORIES.shared}/**`], exclude: TYPE_DECLARATION_EXCLUDE },
    { id: 'backend-workflows', include: [`${BACKEND_SOURCE_DIRECTORIES.workflows}/**`] },
    { id: 'backend-packed-scripts', include: [`${BACKEND_SOURCE_DIRECTORIES.scripts}/**`], exclude: TYPE_DECLARATION_EXCLUDE },
    { id: 'frontend-manifest', include: [PROJECT_PATHS.sourceManifest] },
    { id: 'frontend-plugin-entry', include: [PROJECT_PATHS.pluginEntry] },
    { id: 'frontend-views', include: [`${PROJECT_PATHS.views}/**`] },
    { id: 'frontend-types-generated', include: [`${PROJECT_PATHS.generatedTypes}/**`] },
  ],
  importRestrictions: [
    {
      id: 'backend-esm-static-relative',
      side: 'backend',
      forbiddenModules: [`${NODE_BUILTIN_PREFIX}*`, ...NODE_BUILTIN_MODULES],
    },
  ],
  typecheck: [
    { id: 'frontend-plugin', side: 'frontend', tsconfigPath: PROJECT_PATHS.tsconfig },
    { id: 'backend-sandbox', side: 'backend', tsconfigPath: PROJECT_PATHS.tsconfig },
  ],
  buildTargets: [
    { id: 'frontend-dist', side: 'frontend', outputDirectory: PROJECT_PATHS.dist },
    { id: 'backend-dist', side: 'backend', outputDirectory: PROJECT_PATHS.dist },
  ],
  pack: [
    // dist 根相对：build 产物构成 dist 内容契约（pack 实际复制 dist 全量，内容由 build 决定）。
    { id: 'backend-plugin', includes: [PROJECT_PATHS.runtimeManifest, `${BACKEND_SOURCE_DIRECTORIES.scripts}/**`, `${BACKEND_SOURCE_DIRECTORIES.workflows}/**`] },
    // 前端 pack 要求 dist 内存在 fh2-plugin.json；rsbuild 产物布局归构建器所有。
    { id: 'frontend-plugin', includes: [PROJECT_PATHS.sourceManifest] },
  ],
  pathRewrites: [
    { from: PROJECT_PATHS.sourceManifest, to: `${PROJECT_PATHS.dist}/${PROJECT_PATHS.runtimeManifest}` },
    { from: BACKEND_SOURCE_DIRECTORIES.handlers, to: `${PROJECT_PATHS.dist}/${BACKEND_SOURCE_DIRECTORIES.scripts}` },
    { from: BACKEND_SOURCE_DIRECTORIES.events, to: `${PROJECT_PATHS.dist}/${BACKEND_SOURCE_DIRECTORIES.scripts}` },
    { from: BACKEND_SOURCE_DIRECTORIES.adapters, to: `${PROJECT_PATHS.dist}/${BACKEND_SOURCE_DIRECTORIES.scripts}` },
    { from: BACKEND_SOURCE_DIRECTORIES.workflows, to: `${PROJECT_PATHS.dist}/${BACKEND_SOURCE_DIRECTORIES.workflows}` },
  ],
} as const)

// ---------------------------------------------------------------------------
// 访问器（消费方统一从这里读，不自行解析模式）
// ---------------------------------------------------------------------------

function discoveryRule (rules: SourceBuildRules, id: string): SourceDiscoveryRule {
  const rule = rules.sourceDiscovery.find(item => item.id === id)
  if (rule === undefined) throw new Error(`sourceDiscovery 缺少规则：${id}`)
  return rule
}

/** 源码目录名：'backend-handlers' → 'handlers'（include 模式 'handlers/**' 的目录前缀）。 */
export function sourceDirectoryOf (rules: SourceBuildRules, id: string): string {
  const pattern = discoveryRule(rules, id).include[0] ?? ''
  const directory = pattern.replace(/\/\*\*$/, '')
  if (directory === '' || directory.includes('*')) {
    throw new Error(`规则 ${id} 的 include 模式不是「目录/**」形态：${pattern}`)
  }
  return directory
}

/** 源码发现规则的首个 include 模式（文件入口与目录入口都可读取）。 */
export function sourceIncludeOf (rules: SourceBuildRules, id: string): string {
  const pattern = discoveryRule(rules, id).include[0]
  if (pattern === undefined || pattern === '') throw new Error(`规则 ${id} 缺少 include 模式`)
  return pattern
}

/**
 * 简化排除匹配器：只支持本规则集使用的两种模式（声明文件通配模式与下划线前缀模式）。
 * 出现新模式时此函数会显式报错，防止静默漏匹配。
 */
export function isDiscoveryExcluded (rules: SourceBuildRules, id: string, relativePath: string): boolean {
  const exclude = discoveryRule(rules, id).exclude ?? []
  for (const pattern of exclude) {
    if (pattern === '**/*.d.ts') {
      if (relativePath.endsWith('.d.ts')) return true
      continue
    }
    if (pattern === '**/_*') {
      if (relativePath.split('/').some(segment => segment.startsWith('_'))) return true
      continue
    }
    throw new Error(`不支持的排除模式（需扩展匹配器）：${pattern}`)
  }
  return false
}

/** 后端 import 禁止的 Node 内置模块清单（不含 'node:*' 前缀哨兵）。 */
export function forbiddenNodeModules (rules: SourceBuildRules): readonly string[] {
  const rule = rules.importRestrictions.find(item => item.id === 'backend-esm-static-relative')
  if (rule === undefined) throw new Error('importRestrictions 缺少规则：backend-esm-static-relative')
  return rule.forbiddenModules.filter(module => module !== 'node:*')
}

/** 指定侧的构建输出目录（相对插件根）。 */
export function buildOutputDirectory (rules: SourceBuildRules, side: PluginSide, id: string): string {
  const rule = rules.buildTargets.find(item => item.id === id && item.side === side)
  if (rule === undefined) throw new Error(`buildTargets 缺少规则：${id}（side=${side}）`)
  return rule.outputDirectory
}

/** Readonly source directory conventions; not the legacy runtime-copy directory/kind table. */
export function backendSourceDirectories (rules: SourceBuildRules): readonly string[] {
  return ['backend-manifest', 'backend-handlers', 'backend-events', 'backend-adapters', 'backend-evaluators', 'backend-shared', 'backend-workflows', 'backend-packed-scripts']
    .filter(id => id !== 'backend-manifest')
    .map(id => sourceDirectoryOf(rules, id))
}

/** 键排序的规范化 JSON；数组顺序是规则语义的一部分，保持原样。 */
function sortRuleKeys (value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => sortRuleKeys(item))
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .filter(key => record[key] !== undefined)
        .sort()
        .map(key => [key, sortRuleKeys(record[key])]),
    )
  }
  return value
}

/** 导出器唯一使用的规则序列化器。 */
export function serializeSourceBuildRules (rules: SourceBuildRules = SOURCE_BUILD_RULES): string {
  return `${JSON.stringify(sortRuleKeys(rules), null, 2)}\n`
}

/** path-rewrite-rules.json 的派生文档；不维护第二份 rewrite 清单。 */
export function buildPathRewriteRulesDocument (rules: SourceBuildRules = SOURCE_BUILD_RULES): {
  readonly schemaVersion: number;
  readonly rewrites: readonly PathRewriteRule[];
} {
  return {
    schemaVersion: rules.schemaVersion,
    rewrites: rules.pathRewrites,
  }
}
