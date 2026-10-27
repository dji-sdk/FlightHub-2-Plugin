// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 源码限制契约（source-restrictions）：作者源码中禁止的 import 形态与语法结构。
 *
 * regex、全局名单与模块清单投影自生产 policy；中文 scope/reason/alternatives/notes
 * 是 manual 说明，不声称 runtime 执行中文对象。机器字段见 runtime-policy.json。
 *
 * 事实纪律：
 * - reason / alternatives 只从 src/backend/source-contract.ts 等诊断 message 原文提取；
 *   源码 message 未给出原因的条目 reason 为 null（禁止臆造）；
 * - Node 内置模块禁入清单本体不在此复制：唯一事实源是
 *   backend/policy.ts 的 NODE_BUILTIN_MODULES；SourceBuildRules v1 只投影同一清单。
 * - notes 只引用诊断 message / 源码注释原文，不添加推断。
 */

import { FORBIDDEN_GLOBALS, NODE_BUILTIN_PREFIX, SOURCE_POLICY_PATTERNS } from '../backend/policy.js'
import { PLUGIN_MODULE_POLICY } from '../build/policy.js'
import { deepFreeze, serializeContract } from './shared.js'

export type RestrictionSide = 'frontend' | 'backend'

export interface RestrictionDescriptor {
  readonly id: string;
  readonly side: RestrictionSide;
  /** 限制作用的源码范围（哪些入口/目录会被校验）。 */
  readonly scope: readonly string[];
  /** 禁止形态的描述；清单本体不复制时写引用说明。 */
  readonly forbidden: readonly string[];
  /** 源码策略显式放行的例外形态（import-type-exception 等放行说明）。 */
  readonly allowedExceptions?: readonly string[];
  /** 违反时产生的 FH2_* 诊断码（放行说明为空数组）。 */
  readonly diagnosticCodes: readonly string[];
  /** 诊断 message 原文给出的原因；源码未给出原因时为 null。 */
  readonly reason: string | null;
  /** 诊断 message 原文给出的替代方案。 */
  readonly alternatives: readonly string[];
  /** 诊断 message / 源码注释原文摘录，辅助理解但不替代事实。 */
  readonly notes?: readonly string[];
  /** 权威模块与 symbol，不含易漂移行号。 */
  readonly source: string;
}

export interface SourceRestrictionsContract {
  readonly schemaVersion: number;
  readonly restrictions: readonly RestrictionDescriptor[];
}

export const SOURCE_RESTRICTIONS_CONTRACT: SourceRestrictionsContract = deepFreeze({
  schemaVersion: 1,
  restrictions: [
    {
      id: 'backend-imports',
      side: 'backend',
      scope: [
        'fh2-plugin.json 中 scripts[].path 与 events[].consumer[].handler 声明的入口源码',
        'handlers/** 源码（发现即校验，排除 *.d.ts）',
        'shared/** 源码',
      ],
      forbidden: [
        `${NODE_BUILTIN_PREFIX} 前缀的任何说明符（如 ${NODE_BUILTIN_PREFIX}fs）`,
        'Node 内置模块裸名：生产清单在 backend/policy.ts#NODE_BUILTIN_MODULES；兼容投影见 SOURCE_BUILD_RULES.importRestrictions[id=backend-esm-static-relative].forbiddenModules 与 forbiddenNodeModules(SOURCE_BUILD_RULES)',
      ],
      diagnosticCodes: ['FH2_BACKEND_NODE_IMPORT_FORBIDDEN'],
      reason: null,
      alternatives: [],
      notes: [
        '诊断 message 原文：禁止导入 Node 内置模块：{file} 中 {kind} "{specifier}"。',
        'esbuild Bundle 的模块策略插件（backendModulePolicyPlugin）与 Source 预检共用 isNodeBuiltinSpecifier()。',
      ],
      source: 'src/backend/source-contract.ts#validateSpecifier、src/backend/compiler.ts#backendModulePolicyPlugin、src/source-build-rules.ts#forbiddenNodeModules',
    },
    {
      id: 'backend-bare-imports',
      side: 'backend',
      scope: [
        'fh2-plugin.json 中 scripts[].path 与 events[].consumer[].handler 声明的入口源码',
        'handlers/** 源码（发现即校验，排除 *.d.ts）',
        'shared/** 源码',
      ],
      forbidden: [
        '裸包名（不以 ./ 或 ../ 开头的运行时 import/export from 说明符）',
        'URL import（http:// 或 https:// 协议，同样走非相对说明符分支）',
        'data: 协议说明符（同样走非相对说明符分支）',
      ],
      diagnosticCodes: ['FH2_BACKEND_BARE_IMPORT_FORBIDDEN'],
      reason: 'Phase 1 只允许相对路径 import（诊断 message 原文分句）',
      alternatives: [],
      notes: [
        '诊断 message 原文：Phase 1 只允许相对路径 import，禁止裸包名或 URL。',
        'esbuild 策略分支 message 原文：Phase 1 只允许相对路径 import。',
        '相对路径越界只在 Bundle 的 esbuild onResolve 检查；Source regex 预检不检查目标路径，也不遍历 import 闭包。',
      ],
      source: 'src/backend/source-contract.ts#validateSpecifier、src/backend/compiler.ts#backendModulePolicyPlugin',
    },
    {
      id: 'backend-dynamic-import',
      side: 'backend',
      scope: [
        'fh2-plugin.json 中 scripts[].path 与 events[].consumer[].handler 声明的入口源码',
        'handlers/** 源码（发现即校验，排除 *.d.ts）',
        'shared/** 源码',
      ],
      forbidden: [`动态 import("...") 调用（${SOURCE_POLICY_PATTERNS.dynamicImport.toString()} 检出的字面量形态）`],
      diagnosticCodes: ['FH2_BACKEND_DYNAMIC_IMPORT_FORBIDDEN'],
      reason: null,
      alternatives: [],
      notes: [
        '诊断 message 原文：禁止动态 import()：{file} 中的 "{specifier}"。',
        'hasModuleSyntax 把动态 import() 也视为模块语法（Evaluator 与 Bundle 模式判定同样命中）。',
      ],
      source: 'src/backend/source-contract.ts#validateImportSpecifiers、hasModuleSyntax',
    },
    {
      id: 'backend-require',
      side: 'backend',
      scope: [
        'fh2-plugin.json 中 scripts[].path 与 events[].consumer[].handler 声明的入口源码',
        'handlers/** 源码（发现即校验，排除 *.d.ts）',
        'shared/** 源码',
      ],
      forbidden: [`CommonJS require("...") 调用（${SOURCE_POLICY_PATTERNS.require.toString()} 检出的字面量形态）`],
      diagnosticCodes: ['FH2_BACKEND_REQUIRE_FORBIDDEN'],
      reason: null,
      alternatives: [],
      notes: [
        '诊断 message 原文：禁止 CommonJS require：{file} 中的 "{specifier}"。',
        'Bundle 产物自检同样拒绝 require 语法残留（FH2_BACKEND_BUNDLE_RESIDUAL_MODULE_SYNTAX）。',
      ],
      source: 'src/backend/source-contract.ts#validateForbiddenSyntax、src/backend/build.ts#validateBundledOutput',
    },
    {
      id: 'backend-import-meta',
      side: 'backend',
      scope: [
        'fh2-plugin.json 中 scripts[].path 与 events[].consumer[].handler 声明的入口源码',
        'handlers/** 源码（发现即校验，排除 *.d.ts）',
        'shared/** 源码',
      ],
      forbidden: [`import.meta 属性访问（${SOURCE_POLICY_PATTERNS.importMeta.toString()} 形态）`],
      diagnosticCodes: ['FH2_BACKEND_IMPORT_META_FORBIDDEN'],
      reason: null,
      alternatives: [],
      notes: [
        '诊断 message 原文：禁止使用 import.meta：{file}。',
      ],
      source: 'src/backend/source-contract.ts#validateForbiddenSyntax',
    },
    {
      id: 'backend-eval',
      side: 'backend',
      scope: [
        'fh2-plugin.json 中 scripts[].path 与 events[].consumer[].handler 声明的入口源码',
        'handlers/** 源码（发现即校验，排除 *.d.ts）',
        'shared/** 源码',
      ],
      forbidden: [
        `eval( 调用（${SOURCE_POLICY_PATTERNS.eval.toString()}，字符串/模板字面量剥离后检出）`,
        `new Function( 构造（${SOURCE_POLICY_PATTERNS.functionConstructor.toString()}，与 eval 同码检出）`,
      ],
      diagnosticCodes: ['FH2_BACKEND_EVAL_FORBIDDEN'],
      reason: null,
      alternatives: [],
      notes: [
        '诊断 message 原文：禁止 eval：{file}；禁止 new Function：{file}（同一诊断码）。',
        '字符串与模板字面量内容会被替换为空格后再匹配；该 regex 处理不是 AST 解析。',
      ],
      source: 'src/backend/source-contract.ts#validateForbiddenSyntax、stripStringLiterals',
    },
    {
      id: 'backend-timers',
      side: 'backend',
      scope: [
        'fh2-plugin.json 中 scripts[].path 与 events[].consumer[].handler 声明的入口源码',
        'handlers/** 源码（发现即校验，排除 *.d.ts）',
        'shared/** 源码',
      ],
      forbidden: FORBIDDEN_GLOBALS.map(global => `${global}( 全局调用`),
      diagnosticCodes: ['FH2_BACKEND_TIMER_FORBIDDEN'],
      reason: 'Goja 沙箱没有 Event Loop（诊断 message 原文）',
      alternatives: ['flow.start', 'Workflow Timer'],
      notes: [
        '诊断 message 模板原文（{global}/{file} 为占位符）：Goja 沙箱没有 Event Loop，禁止 {global}：{file}。延迟任务请使用 flow.start 或 Workflow Timer。',
        '检出前同样剥离字符串/模板字面量。',
      ],
      source: 'src/backend/source-contract.ts#validateForbiddenSyntax、FORBIDDEN_GLOBALS',
    },
    {
      id: 'backend-async',
      side: 'backend',
      scope: [
        'fh2-plugin.json 中 scripts[].path 与 events[].consumer[].handler 声明的入口源码',
        'handlers/** 源码（发现即校验，排除 *.d.ts）',
        'shared/** 源码',
      ],
      forbidden: [
        `async function 声明（${SOURCE_POLICY_PATTERNS.asyncFunction.toString()}，独立 message）`,
        `async/await（${[SOURCE_POLICY_PATTERNS.asyncCall, SOURCE_POLICY_PATTERNS.arrowAwait, SOURCE_POLICY_PATTERNS.await].map(pattern => pattern.toString()).join('、')}，独立 message）`,
      ],
      diagnosticCodes: ['FH2_BACKEND_ASYNC_FORBIDDEN'],
      reason: 'Goja 沙箱按同步语义执行（Handler 返回 Promise 不会被等待）（诊断 message 原文）',
      alternatives: ['flow.start', 'Workflow Timer'],
      notes: [
        'async function 形态的 message 原文附替代方案：禁止 async 函数：{file}。Goja 沙箱按同步语义执行(Handler 返回 Promise 不会被等待);延迟任务请使用 flow.start 或 Workflow Timer。',
        'async/await 形态的 message 原文只有同步语义原因：禁止 async/await：{file}。Goja 沙箱按同步语义执行(Handler 返回 Promise 不会被等待)。',
        '源码注释另记载（原文语义）：esbuild 对 es2015 会把 async 降级成 generator 语义，且 HTTP/作业路的重试语义禁 Promise 返回——双重理由，一律拒绝。',
      ],
      source: 'src/backend/source-contract.ts#validateForbiddenSyntax',
    },
    {
      id: 'backend-evaluator-esm',
      side: 'backend',
      scope: ['fh2-plugin.json evaluators[].path 声明的源码（不是整个 evaluators/** 目录扫描）'],
      forbidden: ['import/export 模块语法（含动态 import()，hasModuleSyntax 判定）'],
      diagnosticCodes: ['FH2_BACKEND_EVALUATOR_ESM_UNSUPPORTED'],
      reason: 'Evaluator 在 Phase 1 只支持普通 JavaScript（原样复制）（诊断 message 原文）',
      alternatives: [],
      notes: [
        '诊断 message 原文：Evaluator 在 Phase 1 只支持普通 JavaScript（原样复制），不支持 import/export：{file}。',
        'Build 的 Bundle 模式不处理 evaluators：普通 JS 原样复制进 dist。',
      ],
      source: 'src/backend/source-contract.ts#validateSourceModulePolicy、hasModuleSyntax、src/backend/build.ts#buildWithBundle',
    },
    {
      id: 'frontend-entry-purity',
      side: 'frontend',
      scope: ['Plugin Entry 模块图（缺省 src/plugin.ts 入口的全部编译期依赖）'],
      forbidden: [
        'Vue Runtime（模块路径命中 /node_modules/ 下 vue 或 @vue/* 包）',
        'View Entry 源文件（views 声明的入口）',
        `CSS/图片/字体等旁路资源模块（module.type 以 ${PLUGIN_MODULE_POLICY.forbiddenTypePrefixes.join(' 或 ')} 开头，不要求 /）`,
        'Plugin Entry 入口产物生成 CSS 文件',
      ],
      diagnosticCodes: [
        'FH2_PLUGIN_VUE_FORBIDDEN',
        'FH2_PLUGIN_VIEW_IMPORT_FORBIDDEN',
        'FH2_PLUGIN_ASSET_FORBIDDEN',
        'FH2_PLUGIN_CSS_FORBIDDEN',
      ],
      reason: null,
      alternatives: [],
      notes: [
        '诊断 message 原文：Plugin Entry 模块图不得包含 Vue Runtime / 不得包含 View Entry / 不得包含 CSS、图片、字体或其他旁路资源；入口 CSS 分支为 Plugin Entry 模块图不得生成 CSS。',
        '每个唯一 View entry 独立 bundle（多文件 + 共享 chunk，Vue 3 自带）——FH2_PLUGIN_DUTIES 原文；View 检出按真实路径（realpath）比对。',
      ],
      source: 'src/build/products.ts#validatePluginModules、collectBuildProducts、src/rsbuild/plugin.ts#FH2_PLUGIN_DUTIES',
    },
    {
      id: 'frontend-manifest-source-trust',
      side: 'frontend',
      scope: ['前端 Source Manifest（fh2-plugin.json）顶层字段'],
      forbidden: [
        '安装信任字段：以 validate/index.ts#schemaDiagnostic 的字段判定为准；本说明不另列执行字段清单',
        '构建产物字段：以 validate/semantic-validator.ts#BUILD_OUTPUT_FIELDS 为准；本说明不另列执行字段清单',
      ],
      diagnosticCodes: ['FH2_SOURCE_TRUST_FIELD', 'FH2_SOURCE_BUILD_FIELD'],
      reason: null,
      alternatives: [],
      notes: [
        '诊断 message 原文：Source Manifest 不得声明安装信任字段 {field}；Source Manifest 不得包含构建产物字段 {field}。',
        '构建产物字段由 Build 写入 dist/fh2-plugin.json（manifestVersion/engines.platform/buildInfo），Dist 校验会拒绝缺失或不可解析（FH2_DIST_RUNTIME_METADATA_INVALID / FH2_DIST_BUILD_INFO_INVALID）。',
      ],
      source: 'src/validate/index.ts#schemaDiagnostic、src/validate/semantic-validator.ts#validateManifestSemantics、src/build/verify.ts#verifyPortableMetadata',
    },
    {
      id: 'import-type-exception',
      side: 'backend',
      scope: [
        '与 backend-imports / backend-bare-imports 相同的入口源码范围（类型导入放行说明）',
      ],
      forbidden: [],
      allowedExceptions: [
        'import type { ... } from "裸包"：类型层依赖，esbuild 剥离后零运行时残留，Source 校验放行——SDK 类型消费是后端 TS 的正路（源码注释原文语义）',
      ],
      diagnosticCodes: [],
      reason: null,
      alternatives: [],
      notes: [
        `import/export 校验正则为 ${SOURCE_POLICY_PATTERNS.runtimeImport.toString()} / ${SOURCE_POLICY_PATTERNS.runtimeExport.toString()}；类型导入排除语义由这些运行 regex 决定。`,
        'esbuild 侧注释原文语义：import type 编译期丢弃、不产运行时代码，不会进入模块策略的 import-statement 分支。',
      ],
      source: 'src/backend/source-contract.ts#validateImportSpecifiers、src/backend/compiler.ts#backendModulePolicyPlugin',
    },
  ],
})

// ---------------------------------------------------------------------------
// 访问器（消费方统一从这里读，不自行解析契约结构）
// ---------------------------------------------------------------------------

/** 按 ID 取限制描述符；未知 ID 直接报错，防止静默漏配。 */
export function restrictionDescriptor (contract: SourceRestrictionsContract, id: string): RestrictionDescriptor {
  const descriptor = contract.restrictions.find(restriction => restriction.id === id)
  if (descriptor === undefined) throw new Error(`SOURCE_RESTRICTIONS_CONTRACT 缺少限制：${id}`)
  return descriptor
}

/** 导出器唯一使用的契约序列化器。 */
export function serializeSourceRestrictionsContract (contract: SourceRestrictionsContract = SOURCE_RESTRICTIONS_CONTRACT): string {
  return serializeContract(contract)
}
