// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 构建流程契约（build-flows）：四种工程上下文的 build 可观察阶段、参数能力、
 * 输出与失败行为，加上 --no-build 新鲜度规则与 dist 事务事实。
 *
 * 事务命名、watch 目录及复用条件的机器字段来自运行 policy。中文阶段/条件/失败说明
 * 为 manual；supports* 与 CLI 既有 gate 共用 BUILD_CONTEXT_OPTIONS，不驱动 Application dispatch。
 *
 * 事实纪律：
 * - observablePhases 只记录用户可观察阶段（validate/compile/verify/commit），
 *   不记录私有函数名；
 * - supportsWatch/Config/Filters 与 commands/build-command.ts 的上下文限制逐条一致；
 * - freshnessRules/transaction 的条件与诊断码逐条来自 capability/pack.ts 与
 *   build/transaction.ts。
 */

import { BUILD_CONTEXT_OPTIONS, FRONTEND_BACKEND_WATCH_DIRECTORIES, FRONTEND_WATCH_DIRECTORIES, distTransactionPrefix } from '../build/policy.js'
import { PROJECT_PATHS } from '../project-policy.js'
import { BACKEND_WATCH_TRANSACTION_PREFIX, BUILD_REPORT_MATCH_CHECKS, BUILD_REPORT_REUSE_CHECKS, SOURCE_DIGEST_IGNORED_AT_ROOT } from '../capability/policy.js'
import { BACKEND_BUNDLE_OUTPUTS } from '../backend/policy.js'
import { deepFreeze, serializeContract } from './shared.js'

/** 流程上下文（与 CONTEXT_DISCOVERY_CONTRACT 的上下文 ID 一致）。 */
export type BuildFlowContextId = keyof typeof BUILD_CONTEXT_OPTIONS

export interface BuildFlowDescriptor {
  readonly id: string;
  readonly context: BuildFlowContextId;
  readonly sides: readonly ('frontend' | 'backend')[];
  /** 进入构建前必须满足的条件。 */
  readonly preconditions: readonly string[];
  /** 用户可观察阶段（validate/compile/verify/commit），不含私有函数名。 */
  readonly observablePhases: readonly string[];
  /** build --watch 是否受支持。 */
  readonly supportsWatch: boolean;
  /** build --config 是否受支持（含附带约束）。 */
  readonly supportsConfig: boolean;
  /** build --frontend/--backend 过滤是否受支持。 */
  readonly supportsFilters: boolean;
  /** 构建产物（布局细节见 ARTIFACT_LAYOUTS_CONTRACT）。 */
  readonly outputs: readonly string[];
  /** 失败与中断行为（含退出码语义）。 */
  readonly failureBehavior: readonly string[];
  /** 诊断 message / 源码注释原文摘录。 */
  readonly notes?: readonly string[];
  /** 权威模块与 symbol，不含易漂移行号。 */
  readonly source: string;
}

export interface FreshnessRuleDescriptor {
  readonly id: string;
  /** 适用的命令形态。 */
  readonly command: string;
  readonly scope: string;
  /** Build Report 允许复用（不重新构建）的全部条件。 */
  readonly reuseConditions: readonly string[];
  /** 任一命中即拒绝复用的条件。 */
  readonly rejectionConditions: readonly string[];
  /** 拒绝时使用的诊断码。 */
  readonly rejectionCode: string;
  readonly source: string;
}

export interface BuildTransactionDescriptor {
  readonly id: string;
  /** 候选目录命名模式（相对 dist 父目录）。 */
  readonly candidateDirectory: string;
  /** 备份目录命名模式（相对 dist 父目录）。 */
  readonly backupDirectory: string;
  /** 事务步骤（用户可观察语义）。 */
  readonly steps: readonly string[];
  /** 事务诊断码。 */
  readonly diagnostics: readonly string[];
  readonly notes?: readonly string[];
  readonly source: string;
}

export interface BuildFlowsContract {
  readonly schemaVersion: number;
  readonly flows: readonly BuildFlowDescriptor[];
  readonly freshnessRules: readonly FreshnessRuleDescriptor[];
  readonly transaction: BuildTransactionDescriptor;
}

export const BUILD_FLOWS_CONTRACT: BuildFlowsContract = deepFreeze({
  schemaVersion: 1,
  flows: [
    {
      id: 'frontend-plugin-build',
      context: 'frontend-plugin',
      sides: ['frontend'],
      preconditions: [
        '上下文发现为 frontend-plugin（fh2-plugin.json 前端 side）',
        'Rsbuild config 必须且只能注册一个 fh2Plugin() adapter（FH2_ADAPTER_COUNT_INVALID）',
        'fh2Plugin() 的 Manifest 与调用方期望一致（Capability 编排传入 expectedManifestPath 时校验）',
      ],
      observablePhases: [
        'validate（Source Manifest 快照校验；运行诊断 phase=config）',
        'generate（写入 generated 类型，然后检查阻断级源码一致性；运行诊断 phase=generate）',
        'compile（Rsbuild 编译 plugin/views environment）',
        'verify（dist 自检：Dist Manifest/资产/模块闭包）',
        'commit（候选目录原子提交）',
      ],
      ...BUILD_CONTEXT_OPTIONS['frontend-plugin'],
      outputs: [
        `${PROJECT_PATHS.dist}/（frontend-dist 布局：${PROJECT_PATHS.sourceManifest} + contenthash JS/CSS + ${PROJECT_PATHS.public}/ 资产）`,
      ],
      failureBehavior: [
        '构建失败：候选目录删除、既有 dist 保持不变；诊断输出后退出码 1',
        '参数错误（含 --frontend/--backend 在插件根误用）退出码 2',
        '内部错误退出码 3；SIGINT 退出码 130、SIGTERM 优雅退出 0',
        'watch 模式：非基础设施失败继续监听重建；基础设施失败（Rsbuild 创建/关闭、环境 stats 异常等）转为 fatal 终止',
      ],
      notes: [
        `watch 监听 Manifest、${FRONTEND_WATCH_DIRECTORIES.join('、')}（含后端工程时另监听 ${FRONTEND_BACKEND_WATCH_DIRECTORIES.map(name => `${name}/`).join(' 与 ')}）；忽略 dist、generated 类型产物与事务目录。`,
      ],
      source: 'src/build/runner.ts#executeBuildRound、createPluginBuildRunner、src/commands/build-command.ts#runBuildCommand',
    },
    {
      id: 'backend-plugin-build',
      context: 'backend-plugin',
      sides: ['backend'],
      preconditions: [
        '上下文发现为 backend-plugin（fh2-plugin.json 后端 side）',
        'esm-bundle 路径：Source 校验通过；legacy-copy 路径：Runtime 校验（validateBackendPlugin）通过',
      ],
      observablePhases: [
        'validate（Source Manifest + 模块策略 + schema.sql 派生；或 legacy 的 Runtime 校验）',
        'compile（ESM Bundle 三份单文件，或散文件复制）',
        'verify（仅 esm-bundle 模式做模块语法残留自检，运行诊断 phase=compile；legacy-copy 无此阶段）',
        'commit（原子提交）',
      ],
      ...BUILD_CONTEXT_OPTIONS['backend-plugin'],
      outputs: [
        `${PROJECT_PATHS.dist}/（backend-dist 布局：${PROJECT_PATHS.runtimeManifest} + ${Object.values(BACKEND_BUNDLE_OUTPUTS).join(' / ')} + 声明资产 + ${PROJECT_PATHS.schemaSql} + ${PROJECT_PATHS.buildInfo}）`,
      ],
      failureBehavior: [
        '构建失败：候选目录删除、既有 dist 保持不变；PluginBuildError 诊断退出码 1',
        'watch/直接 Coordinator 路径使用 BUILD_CONTEXT_OPTIONS 校验参数（参数错误退出码 2）；默认非 watch Task 路径保留 Application Service 校验，不据此承诺其配置参数 gate 与直接路径一致',
        '内部错误退出码 3；SIGINT 退出码 130、SIGTERM 优雅退出 0',
      ],
      source: 'src/backend/build.ts#buildBackendPlugin、src/commands/build-command.ts#runBuildCommand',
    },
    {
      id: 'capability-build',
      context: 'capability-project',
      sides: ['frontend', 'backend'],
      preconditions: [
        'Capability 成员发现与校验通过（前端/后端插件目录、ID 一致性、pluginId 唯一）',
        'Capability 操作锁获取成功（同一 Capability 根的构建/Pack 串行化）',
      ],
      observablePhases: [
        'validate（Capability 级校验）',
        'compile（成员插件构建：前端 deferCommit 候选 + 后端 commit:false 候选）',
        'verify（构建后重新校验 Capability + capabilities.json/packages.json 构建期不变断言）',
        'commit（全部候选与 Build Report 统一提升；失败整体回滚）',
      ],
      ...BUILD_CONTEXT_OPTIONS['capability-project'],
      outputs: [
        `各成员插件各自的 ${PROJECT_PATHS.dist}/`,
        `${PROJECT_PATHS.localState}/${PROJECT_PATHS.buildReport}（所选成员数量与当前 Capability 成员数量一致时生成；部分过滤构建不生成，watch 模式先删除）`,
      ],
      failureBehavior: [
        '任一成员失败：全部候选目录清理、Build Report 候选丢弃、返回 ok=false 与诊断（退出码 1）',
        '--config 未选择且仅选择一个前端插件时由 isCapabilityBuildConfigSelection 拒绝（直接 CLI 路径按去重 ID 判定）；默认 Task 路径保留 Application Service 的选择条件',
        '构建期 capabilities.json / packages.json 变更 → FH2_CAPABILITY_BUILD_INPUT_CHANGED（重新构建）',
        '提交失败 → 已提交成员回滚；回滚不完整 → 诊断指明失败成员',
        'watch 模式中断（AbortSignal）→ FH2_CAPABILITY_BUILD_ABORTED；SIGINT 退出码 130、SIGTERM 优雅退出 0',
        'watch 启动阶段后端首次构建失败视为致命错误；稳态期失败只上报并继续监听',
      ],
      notes: [
        'buildCapability 本身不支持 watch（FH2_CAPABILITY_BUILD_WATCH_UNSUPPORTED）；build --watch 走独立的 watchCapability 会话。',
        '过滤语义：--frontend/--backend 未传 = 全量；任一侧显式过滤后，另一侧不再构建；过滤 ID 不存在即报错。',
      ],
      source: 'src/capability/build.ts#buildCapability、buildCapabilityUnlocked、watchCapability、commitPendingBuilds、src/commands/build-command.ts#runBuildCommand',
    },
    {
      id: 'industry-workspace-build',
      context: 'industry-capability-workspace',
      sides: ['frontend', 'backend'],
      preconditions: [
        '工作区成员与 packages.json 的 capabilityIds 双向一致（上下文发现）',
        '行业迁移链接校验通过（validateIndustryMigrationLinks）',
        '工作区操作锁获取成功',
      ],
      observablePhases: [
        'validate（行业迁移链接校验）',
        'compile（按 packages.json 的 capabilityIds 顺序串行构建每个 Capability，成员内部完整执行 capability 流程阶段）',
        'commit（人工流程标签：仅汇总结果，不执行工作区级原子提交；各 Capability 单独提交）',
      ],
      ...BUILD_CONTEXT_OPTIONS['industry-capability-workspace'],
      outputs: [
        `各成员 Capability 的插件 ${PROJECT_PATHS.dist}/ 与 ${PROJECT_PATHS.localState}/${PROJECT_PATHS.buildReport}`,
      ],
      failureBehavior: [
        '任一 Capability 失败：ok=false 并汇总全部成员诊断（退出码 1）',
        '直接 CLI gate 按 BUILD_CONTEXT_OPTIONS 拒绝不支持的参数，返回 2；默认非 watch Task 路径由 Application Service 校验并返回任务结果（请在具体 Capability 根执行）',
        '中断（AbortSignal）→ FH2_INDUSTRY_CAPABILITY_WORKSPACE_BUILD_ABORTED；SIGINT 退出码 130、SIGTERM 优雅退出 0',
      ],
      source: 'src/capability/build.ts#buildIndustryCapabilityWorkspace、src/commands/build-command.ts#runBuildCommand',
    },
  ],
  freshnessRules: [
    {
      id: 'capability-pack-no-build-freshness',
      command: 'pack --no-build',
      scope: 'Capability 根（仅此上下文支持 --no-build）',
      reuseConditions: [
        'Build Report（.fh2/build-report.json）可读取且 capabilityId 与当前 Capability 一致',
        'metadataDigest 与当前 capabilities.json 文件 digest 一致',
        'packageManifestDigest 已记录，且与当前 packages.json（本地或父工作区派生）digest 一致',
        'frontend/backend 条目键与当前成员插件 ID 集合完全一致（不包含已不存在的插件）',
        '每个插件的 digest 与当前 dist 目录 digest 一致（digestBuildDirectory，忽略 .fh2）',
        `每个插件的 sourceDigest 与当前源码 digest 一致（digestSourceDirectory，根层忽略 ${SOURCE_DIGEST_IGNORED_AT_ROOT.join('/')}；任意层忽略 node_modules 与构建候选目录）`,
        '每个插件均无 Capability 外源码依赖（hasExternalSourceDependencies 未标记）',
        '每个插件均无 Capability 外 Rsbuild 配置依赖（hasExternalConfigDependencies 未标记）',
        '构建期间源码未变化（sourceChangedDuringBuild 未标记）',
        '未使用自定义 Rsbuild 配置（configPath/configDigest 未记录）',
      ],
      rejectionConditions: [
        'Build Report 无法读取 / capabilityId 不一致',
        '与 capabilities.json 或 packages.json 不一致（含 Report 未记录 packages.json）',
        '包含当前 Capability 不存在的 frontend/backend 插件',
        '与 dist 产物不一致（dist 缺失或 digest 不匹配）',
        'Build Report 生成后源码已变更',
        '包含 Capability 外源码依赖',
        '使用了 Capability 外的 Rsbuild 配置依赖',
        'Build Report 生成期间源码发生变化',
        '使用了自定义 Rsbuild 配置',
      ],
      rejectionCode: 'FH2_CAPABILITY_BUILD_STALE',
      source: `src/capability/policy.ts#BUILD_REPORT_MATCH_CHECKS（${Object.keys(BUILD_REPORT_MATCH_CHECKS).join('/')}）、BUILD_REPORT_REUSE_CHECKS（${Object.keys(BUILD_REPORT_REUSE_CHECKS).join('/')}）；src/capability/pack.ts#verifyFreshBuild、verifyReportEntry、verifyReportEntries`,
    },
  ],
  transaction: {
    id: 'dist-directory-transaction',
    candidateDirectory: `${distTransactionPrefix(PROJECT_PATHS.dist, 'candidate')}<uuid>`,
    backupDirectory: `${distTransactionPrefix(PROJECT_PATHS.dist, 'backup')}<uuid>`,
    steps: [
      '构建写入候选目录（createCandidateDirectory：mkdir 专用候选目录）',
      '构建失败 → 删除候选目录，既有 dist 保持不变（removeCandidateDirectory）',
      '提交：既有 dist 先重命名为备份目录，候选目录再重命名为 dist（commitCandidateDirectory）',
      '提交失败且已备份 → 回滚：备份目录重命名回 dist；回滚也失败 → FH2_DIST_COMMIT_ROLLBACK_FAILED',
      '提交失败且未备份 → FH2_DIST_COMMIT_FAILED（旧制品已保留）',
      '提交成功后删除备份；清理失败仅产生 FH2_DIST_BACKUP_CLEANUP_FAILED 警告（诊断随结果返回，不回滚）',
    ],
    diagnostics: [
      'FH2_DIST_COMMIT_FAILED',
      'FH2_DIST_COMMIT_ROLLBACK_FAILED',
      'FH2_DIST_BACKUP_CLEANUP_FAILED',
    ],
    notes: [
      `前端 Build watch 忽略 ${distTransactionPrefix(PROJECT_PATHS.dist, 'candidate')}* 与 ${distTransactionPrefix(PROJECT_PATHS.dist, 'backup')}* 目录（isIgnoredWatchPath）；Capability 后端 watch 忽略 ${PROJECT_PATHS.dist} 与 ${BACKEND_WATCH_TRANSACTION_PREFIX}* 前缀目录。`,
      'Capability/工作区层与 Pack 层使用同构 rename+备份事务，但备份目录前缀不同（.fh2-capability-backup-* / .fh2-pack-backup-* / .fh2-zip-next-* 候选 zip）。',
    ],
    source: 'src/build/transaction.ts#createCandidateDirectory、removeCandidateDirectory、commitCandidateDirectory、src/build/runner.ts#isIgnoredWatchPath',
  },
})

// ---------------------------------------------------------------------------
// 访问器（消费方统一从这里读，不自行解析契约结构）
// ---------------------------------------------------------------------------

/** 按 ID 取流程描述符；未知 ID 直接报错，防止静默漏配。 */
export function buildFlowDescriptor (contract: BuildFlowsContract, id: string): BuildFlowDescriptor {
  const descriptor = contract.flows.find(flow => flow.id === id)
  if (descriptor === undefined) throw new Error(`BUILD_FLOWS_CONTRACT 缺少流程：${id}`)
  return descriptor
}

/** 导出器唯一使用的契约序列化器。 */
export function serializeBuildFlowsContract (contract: BuildFlowsContract = BUILD_FLOWS_CONTRACT): string {
  return serializeContract(contract)
}
