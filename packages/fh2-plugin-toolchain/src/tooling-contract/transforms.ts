// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 源码到运行产物转换契约（source-runtime-transforms）：Source 侧输入如何变成
 * Runtime 侧产物的机械事实。
 *
 * 输出路径、编译选项、平台列与命名 regex 来自生产 policy；behavior/conditions/
 * notes 的中文解释仍为 manual，不冒充可执行规则（见 runtime-policy.json）。
 *
 * 事实纪律：每条 behavior/conditions 均逐条对照源码；未在源码中出现的语义不写。
 */

import { BACKEND_BUNDLE_GLOBALS, BACKEND_BUNDLE_OUTPUTS, BACKEND_COMPILE_OPTIONS, HANDLER_NAME_PATTERNS, PLATFORM_COLUMN_NAMES, SCHEMA_FIELD_TYPES, SCHEMA_SQL_TYPES } from '../backend/policy.js'
import { FRONTEND_OUTPUT_POLICY } from '../build/policy.js'
import { PROJECT_PATHS } from '../project-policy.js'
import { deepFreeze, serializeContract } from './shared.js'

export type TransformSide = 'frontend' | 'backend'

export interface TransformDescriptor {
  readonly id: string;
  readonly side: TransformSide;
  /** 转换的输入（作者侧源码/清单形态）。 */
  readonly inputs: readonly string[];
  /** 转换的输出（产物路径/形态；路径常量与源码导出一致）。 */
  readonly outputs: readonly string[];
  /** 转换行为事实（逐条来自源码）。 */
  readonly behavior: readonly string[];
  /** 模式选择/触发条件（可选）。 */
  readonly conditions?: readonly string[];
  /** 诊断 message / 源码注释原文摘录。 */
  readonly notes?: readonly string[];
  /** 权威模块与 symbol，不含易漂移行号。 */
  readonly source: string;
}

export interface TransformsContract {
  readonly schemaVersion: number;
  readonly transforms: readonly TransformDescriptor[];
}

export const TRANSFORMS_CONTRACT: TransformsContract = deepFreeze({
  schemaVersion: 1,
  transforms: [
    {
      id: 'backend-bundle-mode',
      side: 'backend',
      inputs: [
        '插件根 fh2-plugin.json（Source Manifest）',
        'Manifest 声明入口：scripts[].path、events[].consumer[].handler',
        'handlers/** 源码（.ts/.js，排除 *.d.ts）',
      ],
      outputs: [
        `${PROJECT_PATHS.dist}/（esm-bundle 模式：${PROJECT_PATHS.runtimeManifest} + ${Object.values(BACKEND_BUNDLE_OUTPUTS).join(' + ')} + 声明资产 + ${PROJECT_PATHS.schemaSql} + ${PROJECT_PATHS.buildInfo}）`,
        `${PROJECT_PATHS.dist}/（legacy-copy 模式：${PROJECT_PATHS.runtimeManifest} + 声明资产散文件 + 运行时目录复制 + ${PROJECT_PATHS.buildInfo}）`,
      ],
      behavior: [
        'esm-bundle 模式链路：Source Validate → Bundle（handlers/events/adapter 三份单文件）→ Runtime Manifest 值级改写 → build-info.json → 原子提交',
        `legacy-copy 模式链路：Runtime Validate → 复制散文件（Manifest 声明资产 + backend/build.ts#buildLegacyCopy 运行时目录映射内的 .js）→ ${PROJECT_PATHS.buildInfo} → 原子提交（与改造前行为一致）`,
        `Bundle 使用 esbuild：bundle、format ${BACKEND_COMPILE_OPTIONS.format}、platform ${BACKEND_COMPILE_OPTIONS.platform}、target ${BACKEND_COMPILE_OPTIONS.target}、不注入 "use strict"（兼容当前 Worker goja.Compile(..., false) 宽松语义）`,
        'Bundle 产物自检：不允许残留 import/export/require 语法（FH2_BACKEND_BUNDLE_RESIDUAL_MODULE_SYNTAX）',
      ],
      conditions: [
        '非 legacyCopyMode 且 Source 校验通过且 hasAnyEsm() 命中 → esm-bundle 模式',
        'hasAnyEsm：Manifest 声明入口文件含模块语法（import/export 或动态 import()），或 handlers/** 下存在 .ts 源码（.ts 是 Bundle 模式的充分条件——散文件复制带不动 TS；_ 前缀与 .d.ts 不参与判定）',
        '其余情况（无 ESM、显式 legacyCopyMode、或 Source 校验失败的旧包）→ legacy-copy 模式，由 Runtime 校验（validateBackendPlugin）兜底',
      ],
      notes: [
        'schema.sql 读取失败/非法（FH2_SCHEMA_SQL_INVALID / FH2_SCHEMA_SQL_READ_FAILED）在模式选择前即抛出，不进入任何构建模式。',
      ],
      source: 'src/backend/build.ts#buildBackendPlugin、buildWithBundle、buildLegacyCopy、hasAnyEsm、src/backend/compiler.ts#compileBackendPlugin',
    },
    {
      id: 'backend-handlers-bundle',
      side: 'backend',
      inputs: [
        'handlers/** 源码（.ts/.js，排除 *.d.ts 与 .DS_Store；发现范围复现 Worker 的 Handler 发现）',
        '每个文件的运行时函数导出（export function / export const 函数 / export { } 命名导出）',
      ],
      outputs: [`${PROJECT_PATHS.dist}/${BACKEND_BUNDLE_OUTPUTS.handlers}（输出路径 = compiler.ts 导出常量 HANDLERS_OUTPUT）`],
      behavior: [
        'handlers/** 的全部入口聚合为一份单文件 Bundle（Virtual Entry re-export + esbuild IIFE）',
        'Bundle 顶层为每个入口生成 function <name>(input, ctx) Wrapper，Wrapper 位于 IIFE 之前（兼容 Worker 顶层函数扫描器，避免 IIFE 内正则字面量花括号干扰）；(0, ns.fn)(...) 是 detached call，避免 namespace 对象成为 this',
        `IIFE globalName 为 ${BACKEND_BUNDLE_GLOBALS.handlers}（compiler.ts HANDLERS_GLOBAL）；Wrapper 前置于 IIFE 之前`,
        '无 handlers 入口（handlers 目录为空或不存在）时不产出该文件、不写入对应 Runtime Manifest 改写',
      ],
      source: 'src/backend/compiler.ts#compileBackendPlugin、collectHandlerEntries、bundleEntries、buildHandlerVirtualEntry',
    },
    {
      id: 'backend-events-bundle',
      side: 'backend',
      inputs: ['fh2-plugin.json events[].consumer[].handler 声明的入口源码（entry 缺省为 handle）'],
      outputs: [`${PROJECT_PATHS.dist}/${BACKEND_BUNDLE_OUTPUTS.events}（输出路径 = compiler.ts 导出常量 EVENTS_OUTPUT）`],
      behavior: [
        '全部 event consumer 入口聚合为一份单文件 Bundle（与 handlers/adapter 分开，Host 注入面不同，不能共享 Chunk）',
        '每个 consumer 生成稳定序号 Wrapper：fh2_event_<eventIndex>_<consumerIndex>（i 为 events[] 序号、j 为 consumer[] 序号）',
        `IIFE globalName 为 ${BACKEND_BUNDLE_GLOBALS.events}（EVENTS_GLOBAL）；Wrapper 前置于 IIFE 之前`,
        '存在 Event Bundle 时同码改写 Runtime Manifest 的 events[].consumer[].handler/entry',
        '无任何声明 handler 时不产出该文件',
      ],
      source: 'src/backend/compiler.ts#collectEventEntries、buildEventVirtualEntry、rewriteEventsInRuntimeManifest',
    },
    {
      id: 'backend-adapters-bundle',
      side: 'backend',
      inputs: ['fh2-plugin.json scripts[].path 声明的入口源码（entry 缺省为 handle）'],
      outputs: [`${PROJECT_PATHS.dist}/${BACKEND_BUNDLE_OUTPUTS.adapter}（输出路径 = compiler.ts 导出常量 ADAPTER_OUTPUT）`],
      behavior: [
        '全部 scripts[] 入口聚合为一份单文件 Bundle',
        '每个 script 生成稳定序号 Wrapper：fh2_adapter_<scriptIndex>（i 为 scripts[] 序号）',
        `IIFE globalName 为 ${BACKEND_BUNDLE_GLOBALS.adapters}（ADAPTERS_GLOBAL）；Wrapper 前置于 IIFE 之前`,
        '存在 Adapter Bundle 时同码改写 Runtime Manifest 的 scripts[].path/entry',
        '无任何声明 path 时不产出该文件',
      ],
      source: 'src/backend/compiler.ts#collectAdapterEntries、buildAdapterVirtualEntry、rewriteScriptsInRuntimeManifest',
    },
    {
      id: 'backend-entry-naming',
      side: 'backend',
      inputs: [
        'handlers/<domain>/<file>.js|ts 的导出名',
        'fh2-plugin.json events/scripts 声明结构（序号）',
      ],
      outputs: [
        'Bundle 顶层 Wrapper 名（Worker 扫描的真实入口名）',
        'Runtime Manifest 的 entry 值',
      ],
      behavior: [
        'h_ 前缀导出保留原名直接 re-export（Phase 1 兼容模式）',
        '普通 export 由路径派生：handlers/<domain>/<file> + <exportName> → h_<domainCamel>_<exportName>（示例原文：handlers/lane-change/start-mode.js + startMode → h_laneChange_startMode）',
        `派生约束：目录必须小写 kebab-case（转 lowerCamel）、export 必须匹配 ${HANDLER_NAME_PATTERNS.exportName.source} 且文件必须恰在 handlers/<domain>/ 两层之下，否则 FH2_BACKEND_HANDLER_NAME_INVALID`,
        'Handler 名重复（跨文件或派生冲突）→ FH2_BACKEND_ENTRY_DUPLICATE',
        'event consumer 入口名固定 fh2_event_<eventIndex>_<consumerIndex>；adapter 入口名固定 fh2_adapter_<scriptIndex>',
        'HTTP 可读名不作为 Bundle 入口：Worker 以 h_ 名为真实入口；h_<lowerCamel domain>_<lowerCamel action> 形状的入口由 Worker 装载期派生 <domain>_<action> 与 <domain>.<action> 别名（aliasesForHandlerEntry；其余历史 h_ 入口不额外暴露猜测名称）',
        'export default 不视为 Handler 入口（源码注释：一个文件只应有一个 default 且无法保证是函数）',
        'Handler 导出识别使用 TypeScript AST，只认运行时函数值（export function / 函数值 const / 命名 export 中的本地函数绑定）',
      ],
      source: 'src/backend/handler-names.ts#wrapperNameForHandlerExport、aliasesForHandlerEntry、src/backend/compiler.ts#collectHandlerEntries、extractHandlerExports、collectEventEntries、collectAdapterEntries',
    },
    {
      id: 'backend-manifest-rewrite',
      side: 'backend',
      inputs: ['Source fh2-plugin.json 的原始 JSON（manifestJson，值级改写输入）'],
      outputs: [`${PROJECT_PATHS.dist}/${PROJECT_PATHS.runtimeManifest}（Runtime Manifest，Worker 装载格式）`],
      behavior: [
        'structuredClone(Source Manifest JSON) 后只改写具体字段值，对象不重建、不丢字段',
        `存在 Event Bundle 时：events[].consumer[].handler → "${BACKEND_BUNDLE_OUTPUTS.events}"、entry → "fh2_event_<i>_<j>"`,
        `存在 Adapter Bundle 时：scripts[].path → "${BACKEND_BUNDLE_OUTPUTS.adapter}"、entry → "fh2_adapter_<i>"`,
        'esm-bundle 模式：改写后的 Runtime Manifest 以 2 空格缩进 JSON 写入 dist/plugin.json',
        'legacy-copy 模式不改写：直接复制 fh2-plugin.json 为 dist/plugin.json；Source 声明 entities 由 schema.sql 派生时改写为有效 Manifest（writeEffectiveManifest）',
      ],
      notes: [
        'BackendSourceValidationResult.manifestJson 注释原文语义：供 Bundle 阶段做值级改写，禁止经 TS 类型重建。',
      ],
      source: 'src/backend/compiler.ts#compileBackendPlugin、rewriteEventsInRuntimeManifest、rewriteScriptsInRuntimeManifest、src/backend/build.ts#buildWithBundle、buildLegacyCopy、writeEffectiveManifest',
    },
    {
      id: 'backend-schema-entities',
      side: 'backend',
      inputs: ['插件根 schema.sql（存在且 fh2-plugin.json 未声明 entities 时才注入）'],
      outputs: [
        '有效 Manifest 的 entities 字段（Source 校验注入；esm-bundle 与 legacy 模式都会进入 dist/plugin.json）',
        'dist/schema.sql（原样复制）',
      ],
      behavior: [
        '只支持刻意收窄的 SQL 子集：CREATE TABLE / CREATE [UNIQUE] INDEX / ALTER TABLE ADD COLUMN / DROP INDEX / BEGIN / COMMIT；不支持即报 FH2_SCHEMA_SQL_INVALID（fail 而非忽略，保证生成声明与部署 schema 不静默偏离）',
        `列类型只支持 ${SCHEMA_SQL_TYPES.join(' 与 ')}`,
        'plugin_db_ 前缀表映射为逻辑实体名（去前缀，实体名需匹配 ^[a-z][a-z0-9_]*$；非 plugin_db_ 表只进 tables 事实不进 entities）',
        `平台列 ${PLATFORM_COLUMN_NAMES.join('/')}（schema-facts.ts PLATFORM_COLUMN_NAMES）从实体字段中剔除`,
        `renderWorkerEntities 渲染为 Worker entity 形态：${Object.entries(SCHEMA_FIELD_TYPES).map(([sql, field]) => `${sql} → ${field}`).join('、')}；单列唯一索引/UNIQUE 折叠为字段 unique，其余索引折叠为 indexed`,
        'Worker 契约校验（validateEntities）叠加：实体名加 plugin_db_ 前缀后 ≤63 字符；字段名归一（lowerCamelCase → snake_case）后 ≤63 字符且不得撞平台保留字段（清单以 backend/contract.ts#reservedEntityFields 为准，不复制成另一规则表）；最多 32 个 Entity、每 Entity 最多 64 个字段',
        '索引支持 WHERE <列> IS NOT NULL 谓词与 ASC/DESC 方向；CREATE INDEX 引用未知表/未知列即报错',
      ],
      source: 'src/backend/schema-facts.ts#readSchemaFacts、parseSchemaFacts、renderWorkerEntities、PLATFORM_COLUMN_NAMES、src/backend/contract.ts#validateEntities、normalizeFieldName、src/backend/source-contract.ts#injectSchemaEntities',
    },
    {
      id: 'frontend-entry-shaping',
      side: 'frontend',
      inputs: [
        'fh2-plugin.json（entry 与 views 声明）',
        `${PROJECT_PATHS.pluginEntry}（缺省 Plugin Entry，可由 fh2Plugin() 选项覆盖）`,
        `${PROJECT_PATHS.views}/<viewId>.ts 或 ${PROJECT_PATHS.views}/<viewId>/index.ts（每个声明的 View；两者并存报 FH2_VIEW_ENTRY_AMBIGUOUS）`,
        `${PROJECT_PATHS.public}/（可选；存在即复制）`,
      ],
      outputs: [
        `${PROJECT_PATHS.dist}/${PROJECT_PATHS.sourceManifest}（Dist Manifest：含 manifestVersion、engines.platform、buildInfo.sdkVersion/toolchainVersion 与规范化 View JS/CSS 路径）`,
        'dist/<pluginEntryName>.<contenthash:8>.js（Plugin Entry 单文件自包含 ESM）',
        'dist/views/<viewId>.<contenthash:8>.js 与同名 .css（每个唯一 View）',
        'dist 内静态资源与 public/ 复制资产（Dist 校验要求 manifest 引用的图标等资产在 dist 内存在）',
      ],
      behavior: [
        `Plugin Entry 强制单文件：${FRONTEND_OUTPUT_POLICY.chunkStrategy} chunk 策略 + asyncChunks:${FRONTEND_OUTPUT_POLICY.asyncChunks}，任意 import 写法（含动态 import）收敛为自包含 ESM；verifyDist 校验最终 Plugin ESM 无 import 残留且保留 default export（FH2_DIST_PLUGIN_IMPORT_FORBIDDEN / FH2_DIST_DEFAULT_EXPORT_MISSING）`,
        '每个唯一 View entry 构建为独立 bundle（多文件 + 共享 chunk，Vue 3 自带——FH2_PLUGIN_DUTIES 原文）；View ESM 只允许相对 import 且目标必须留在 dist 内（闭包校验）',
        `以 View entry 为边界收集 CSS（injectStyles:${FRONTEND_OUTPUT_POLICY.injectStyles}，不注入 document.head）；Plugin Entry 模块图不得生成 CSS`,
        `文件名模式 ${FRONTEND_OUTPUT_POLICY.filename.js} / .css；产物写入候选目录（事务提交后成为 dist）`,
        'buildDistManifest 写入 manifestVersion 与 engines.platform（读 SDK runtime-contract metadata，不从 SemVer 推导）及 buildInfo',
        'public/ 存在时 publicDir 指向项目 public/ 并 copyOnBuild 复制；不存在时关闭 publicDir',
        'Dist 校验（verifyDist）复验 Manifest 与 compilation entrypoint 的 Entry/View/CSS 路径一致性及资产存在性',
      ],
      conditions: [
        '无 View 声明时只编译 plugin environment；有 View 时 plugin + views 两个 environment（出现未声明 environment stats 即报错）',
      ],
      source: 'src/rsbuild/plugin.ts#fh2Plugin、FH2_PLUGIN_DUTIES、src/build/runner.ts#executeBuildRound、src/manifest.ts#buildDistManifest、src/build/verify.ts#verifyDist、src/build/paths.ts#resolveSourceEntries、src/build/products.ts#collectBuildProducts',
    },
  ],
})

// ---------------------------------------------------------------------------
// 访问器（消费方统一从这里读，不自行解析契约结构）
// ---------------------------------------------------------------------------

/** 按 ID 取转换描述符；未知 ID 直接报错，防止静默漏配。 */
export function transformDescriptor (contract: TransformsContract, id: string): TransformDescriptor {
  const descriptor = contract.transforms.find(transform => transform.id === id)
  if (descriptor === undefined) throw new Error(`TRANSFORMS_CONTRACT 缺少转换：${id}`)
  return descriptor
}

/** 导出器唯一使用的契约序列化器。 */
export function serializeTransformsContract (contract: TransformsContract = TRANSFORMS_CONTRACT): string {
  return serializeContract(contract)
}
