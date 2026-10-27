// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 产物布局契约（artifact-layouts）：dist、release 目录与上传 zip 的结构事实。
 *
 * 路径、排除清单与压缩级别投影自生产 policy；其余中文说明为 manual，
 * 不作为执行对象。更精确的机器字段见 runtime-policy.json。
 *
 * 事实纪律：
 * - required 只写 Pack/校验必然存在或强制校验的成员；可能缺省的成员写 optional；
 * - excluded 投影各生产排除名单，不合并复制/zip 路径：独立插件与 Capability 后端
 *   dist 复制排除 *.map；Capability 前端复制与最终 zip 收集保留 *.map；
 * - archivePolicy 只记录 capability/zip.ts 真实实现的排序与压缩参数。
 */

import { BACKEND_SOURCE_DIRECTORIES, PROJECT_PATHS } from '../project-policy.js'
import { FRONTEND_OUTPUT_POLICY } from '../build/policy.js'
import { CAPABILITY_BACKEND_COPY_EXCLUSIONS, CAPABILITY_ZIP_EXCLUSIONS, DEVELOPMENT_ONLY_DIRECTORIES, DEVELOPMENT_ONLY_FILES, PLATFORM_OWNED_FILES, STANDALONE_PACK_EXCLUSIONS, WINDOWS_RESERVED_NAMES, ZIP_COMPRESSION_LEVEL } from '../capability/policy.js'
import { BACKEND_BUNDLE_OUTPUTS } from '../backend/policy.js'
import { deepFreeze, serializeContract } from './shared.js'

const standaloneExclusions = [...STANDALONE_PACK_EXCLUSIONS.files, ...STANDALONE_PACK_EXCLUSIONS.directories.map(name => `${name}/`), ...STANDALONE_PACK_EXCLUSIONS.suffixes.map(suffix => `*${suffix}`)].join('、')

/** 布局所属的工程上下文（与 CONTEXT_DISCOVERY_CONTRACT 的上下文 ID 一致）。 */
export type ArtifactContextId =
  | 'frontend-plugin'
  | 'backend-plugin'
  | 'capability-project'
  | 'industry-capability-workspace'

export interface ArtifactLayoutDescriptor {
  readonly id: string;
  readonly context: ArtifactContextId;
  /** 布局根（相对工程根；含并列产物说明）。 */
  readonly root: string;
  /** 必然存在（或被校验强制）的成员。 */
  readonly required: readonly string[];
  /** 视源码声明/存在而定的成员。 */
  readonly optional?: readonly string[];
  /** 工具生成的成员（区别于从源码原样复制的成员）。 */
  readonly generated: readonly string[];
  /** Manual explanation of exclusion/rejection branches; runtime-policy carries executable lists. */
  readonly excluded: readonly string[];
  /** zip 内条目的路径前缀；根平铺（无前缀）为 null。 */
  readonly archivePrefix: string | null;
  /** 诊断 message / 源码注释原文摘录。 */
  readonly notes?: readonly string[];
  /** 权威模块与 symbol，不含易漂移行号。 */
  readonly source: string;
}

export interface ArtifactExclusions {
  /** 平台生成、上传包不得包含的文件（capability/pack.ts PLATFORM_OWNED_FILES）。 */
  readonly platformOwned: readonly string[];
  /** Shared summary of development members; each executing path owns its exclusion/rejection branch. */
  readonly developmentOnly: readonly string[];
  readonly notes: readonly string[];
  readonly source: string;
}

export interface ArchivePolicyDescriptor {
  /** zip 条目顺序规则。 */
  readonly pathOrder: string;
  /** deflate 压缩级别（capability/zip.ts deflateRawSync 参数）。 */
  readonly compressionLevel: number;
  /** 压缩回退策略。 */
  readonly storeFallback: string;
  /** 条目路径的合法性与冲突规则。 */
  readonly pathRules: readonly string[];
  readonly source: string;
}

export interface ArtifactLayoutsContract {
  readonly schemaVersion: number;
  readonly layouts: readonly ArtifactLayoutDescriptor[];
  readonly exclusions: ArtifactExclusions;
  readonly archivePolicy: ArchivePolicyDescriptor;
}

export const ARTIFACT_LAYOUTS_CONTRACT: ArtifactLayoutsContract = deepFreeze({
  schemaVersion: 1,
  layouts: [
    {
      id: 'frontend-dist',
      context: 'frontend-plugin',
      root: `${PROJECT_PATHS.dist}/（相对前端插件根；构建事务原子提交）`,
      required: [
        `${PROJECT_PATHS.sourceManifest}（Dist Manifest：manifestVersion/engines.platform/buildInfo，verifyPortableMetadata 强制校验）`,
        `Plugin Entry JS（${FRONTEND_OUTPUT_POLICY.filename.js}，恰好一个入口 JS）`,
      ],
      optional: [
        'views/<viewId>.[contenthash:8].js 与 .css（声明 views 时）',
        'View 共享 chunk 与其他静态资源',
        `${PROJECT_PATHS.public}/ 复制的静态资源（manifest 引用的图标等资产必须在 dist 内存在）`,
      ],
      generated: [
        `${PROJECT_PATHS.sourceManifest}（buildDistManifest 生成）`,
        '全部 JS/CSS 产物（rsbuild 编译生成）',
      ],
      excluded: [],
      archivePrefix: null,
      notes: [
        'Dist 校验：Plugin Entry JS 必须自包含 ESM（无 import 残留）且保留 default export；View ESM 只允许相对 import 闭包。',
      ],
      source: 'src/build/runner.ts#executeBuildRound、src/manifest.ts#buildDistManifest、src/build/verify.ts#verifyDist、src/rsbuild/plugin.ts#fh2Plugin',
    },
    {
      id: 'backend-dist',
      context: 'backend-plugin',
      root: `${PROJECT_PATHS.dist}/（相对后端插件根；构建事务原子提交）`,
      required: [`${PROJECT_PATHS.runtimeManifest}（Runtime Manifest；两种构建模式都会产出）`],
      optional: [
        `${Object.values(BACKEND_BUNDLE_OUTPUTS).join(' / ')}（esm-bundle 模式，对应源码入口存在时）`,
        `${BACKEND_SOURCE_DIRECTORIES.workflows}/**（Manifest 声明 flows 时原样复制）`,
        `${PROJECT_PATHS.schemaSql}（插件根存在时原样复制）`,
        `${BACKEND_SOURCE_DIRECTORIES.evaluators}/**（Manifest 声明时普通 JS 原样复制）`,
        '运行时目录散文件（legacy-copy 模式，实际目录/kind 映射见 backend/build.ts#buildLegacyCopy；按目录复制 .js）',
        `${PROJECT_PATHS.buildInfo}（两种模式都写；仅本地诊断用途，Pack 时排除）`,
      ],
      generated: [
        `${PROJECT_PATHS.runtimeManifest}（esm-bundle 模式为值级改写后的 Runtime Manifest；legacy 模式为复制或 entities 注入后的有效 Manifest）`,
        `${Object.values(BACKEND_BUNDLE_OUTPUTS).join(' / ')}（esbuild Bundle 生成）`,
        `${PROJECT_PATHS.buildInfo}（记录 pluginId/version/toolchainVersion/bundler.mode）`,
      ],
      excluded: [],
      archivePrefix: null,
      notes: [
        'build-info.json 的 bundler.mode 为 esm-bundle 或 legacy-copy；workerVerified 为 false。',
      ],
      source: 'src/backend/build.ts#buildWithBundle、buildLegacyCopy、writeBuildInfo、src/backend/compiler.ts#writeBundle',
    },
    {
      id: 'frontend-plugin-release',
      context: 'frontend-plugin',
      root: `${PROJECT_PATHS.release}/<pluginId>/（+ 并列产物 ${PROJECT_PATHS.release}/<pluginId>.zip；默认 ${PROJECT_PATHS.release}/，--out-dir 可改）`,
      required: [
        `${PROJECT_PATHS.runtimeManifest}（包级 Manifest：pluginId/name/description/version + 内嵌 manifest）`,
        `${PROJECT_PATHS.dist}/${PROJECT_PATHS.sourceManifest}（dist 全量复制后仍需通过 verifyPortableDist）`,
      ],
      optional: ['dist/ 内其余产物（随源 dist 全量复制）'],
      generated: [
        'release/ 目录、plugin.json 与 zip（Pack 生成）',
        '内嵌 manifest 的 Entry/View/Icon 路径重基准为 ./dist/*（toPackageResourcePath）',
      ],
      excluded: [
        '（目录复制）无排除：cpSync 全量复制 dist',
        `（zip 收集）${standaloneExclusions}（backend/pack.ts 的独立交付物排除策略）`,
      ],
      archivePrefix: '<pluginId>/',
      notes: [
        'Pack 前先执行一次默认 build，失败则透传其退出码；Plugin ID 必须使用 official_ 或 exp_ 前缀的小写短名。',
        'plugin.json 校验：pluginId 与目录名及 dist/fh2-plugin.json.id 一致；name/description/version 与 dist/fh2-plugin.json 一致；内嵌 manifest 与 dist/fh2-plugin.json 去除身份字段后完全一致。',
      ],
      source: 'src/backend/pack.ts#packStandaloneFrontendPlugin、writePluginZip、src/pack/index.ts#packFrontendPlugin、verifyFrontendPluginPackage',
    },
    {
      id: 'backend-plugin-release',
      context: 'backend-plugin',
      root: `${PROJECT_PATHS.release}/<pluginId>/（+ 并列产物 ${PROJECT_PATHS.release}/<pluginId>.zip；默认 ${PROJECT_PATHS.release}/，--out-dir 可改）`,
      required: [`${PROJECT_PATHS.runtimeManifest}（dist 先通过 validateBackendPlugin 的 Worker 契约校验）`],
      optional: [
        `${BACKEND_SOURCE_DIRECTORIES.scripts}/**（Bundle 产物或散文件）`,
        `${BACKEND_SOURCE_DIRECTORIES.workflows}/**、${PROJECT_PATHS.schemaSql}、${BACKEND_SOURCE_DIRECTORIES.evaluators}/**（随源 dist 复制）`,
      ],
      generated: [
        'release/ 目录与 zip（Pack 生成；内容从 dist 复制，排除开发产物）',
      ],
      excluded: [
        `${standaloneExclusions}（目录复制与 zip 收集同集排除）`,
      ],
      archivePrefix: '<pluginId>/',
      notes: [
        '插件级交付物：不输出 packages.json，不代表完整平台上传单位；Pack 输出目录不能位于 dist 内。',
      ],
      source: 'src/backend/pack.ts#packBackendPlugin、copyBackendDistDirectory、writePluginZip、collectZipEntries',
    },
    {
      id: 'capability-upload-zip',
      context: 'capability-project',
      root: `${PROJECT_PATHS.release}/<packageId>/（+ 并列产物 ${PROJECT_PATHS.release}/<packageId>.zip；默认 ${PROJECT_PATHS.release}/，--out-dir 可改）`,
      required: [
        `${PROJECT_PATHS.packageManifest}（根平铺上传包清单，Pack 生成）`,
        `<capabilityId>/${PROJECT_PATHS.capabilityMetadata}（Capability 元数据）`,
      ],
      optional: [
        '<capabilityId>/frontend/<pluginId>/（各前端插件包：plugin.json + dist/）',
        '<capabilityId>/backend/<pluginId>/（各后端插件 dist 内容）',
      ],
      generated: [
        `${PROJECT_PATHS.packageManifest}（serializePackageManifest 生成）`,
        `<capabilityId>/${PROJECT_PATHS.capabilityMetadata}（写 Capability 元数据）`,
        `${PROJECT_PATHS.frontend}/${PROJECT_PATHS.backend} 子树（从各插件 dist 组装复制）`,
      ],
      excluded: [
        `${DEVELOPMENT_ONLY_FILES.join('、')}、${CAPABILITY_BACKEND_COPY_EXCLUSIONS.suffixes.map(suffix => `*${suffix}`).join('、')}（后端 dist 复制时静默排除；前端目录复制不排除 *.map）`,
        `${PLATFORM_OWNED_FILES.join('、')}（dist 内出现即报 FH2_CAPABILITY_PACK_PLATFORM_FILE_FORBIDDEN，非静默排除）`,
        `${DEVELOPMENT_ONLY_DIRECTORIES.map(name => `${name}/`).join('、')}（dist 内出现即报 FH2_CAPABILITY_PACK_DEVELOPMENT_FILE_FORBIDDEN）`,
        `（zip 收集）${CAPABILITY_ZIP_EXCLUSIONS.files.join('、')}、非根层 ${CAPABILITY_ZIP_EXCLUSIONS.nestedFiles.filter(name => !CAPABILITY_ZIP_EXCLUSIONS.files.includes(name)).join('、')}、${CAPABILITY_ZIP_EXCLUSIONS.directories.map(name => `${name}/`).join('、')}；根层 ${PROJECT_PATHS.packageManifest} 是 Pack 生成的上传清单，保留`,
        'Capability dist 根与资产不支持符号链接（FH2_CAPABILITY_PACK_PATH_UNSAFE）',
      ],
      archivePrefix: null,
      notes: [
        'zip 根目录直接映射 release/<packageId>/ 目录：packages.json 与 <capabilityId>/ 平铺，不套 <packageId>/ 层。',
        'zip 生成后做 digest 级回读校验：条目集合与内容必须与候选目录一致，且根目录只允许 packages.json 与声明的 Capability 目录（FH2_CAPABILITY_PACK_VERIFY_FAILED）。',
        '--no-build 时先通过 Build Report 新鲜度校验（见 BUILD_FLOWS_CONTRACT.freshnessRules）。',
      ],
      source: 'src/capability/pack.ts#packCapability、stageCapability、copyBackendDist、collectZipEntries、writeCapabilityZip、verifyZipMatchesCandidate、assertNoPlatformOwnedFiles',
    },
    {
      id: 'workspace-upload-zip',
      context: 'industry-capability-workspace',
      root: `${PROJECT_PATHS.release}/<packageId>/（+ 并列产物 ${PROJECT_PATHS.release}/<packageId>.zip；默认 ${PROJECT_PATHS.release}/，--out-dir 可改）`,
      required: [
        `${PROJECT_PATHS.packageManifest}（根平铺上传包清单）`,
        `<capabilityId>/${PROJECT_PATHS.capabilityMetadata}（每个成员 Capability）`,
      ],
      optional: [
        '<capabilityId>/frontend/**、<capabilityId>/backend/**（各 Capability 的插件子树）',
      ],
      generated: [
        `${PROJECT_PATHS.packageManifest}（serializePackageManifest 生成）`,
        '各 Capability 子树（stageCapability 组装；pack 前先构建全部 Capability）',
      ],
      excluded: [
        '与 capability-upload-zip 相同的排除/拒绝集（stageCapability/collectZipEntries 同一实现）',
      ],
      archivePrefix: null,
      notes: [
        'zip 根平铺（同 capability-upload-zip）；Pack 始终先构建全部 Capability，不支持 --no-build。',
        '输出目录必须位于工作区根内且不能覆盖任一 Capability 源码目录。',
      ],
      source: 'src/capability/pack.ts#packIndustryCapabilityWorkspace、stageCapability、writeCapabilityZip、verifyZipMatchesCandidate',
    },
  ],
  exclusions: {
    platformOwned: PLATFORM_OWNED_FILES,
    developmentOnly: [...DEVELOPMENT_ONLY_FILES, ...DEVELOPMENT_ONLY_DIRECTORIES],
    notes: [
      '*.map 在独立插件交付物及 Capability/工作区的后端 dist 复制中排除；Capability 前端目录复制与最终 zip 收集不排除 *.map。',
      `${PLATFORM_OWNED_FILES.join('/')} 出现在 Capability 成员 dist 时直接报错（FH2_CAPABILITY_PACK_PLATFORM_FILE_FORBIDDEN），不是静默排除；独立插件交付物路径则静默跳过。`,
      '各布局的 excluded 是人工解释；实际排除与拒绝由 capability/policy.ts 常量及 Pack 分支执行。',
    ],
    source: 'src/capability/policy.ts#PLATFORM_OWNED_FILES、DEVELOPMENT_ONLY_DIRECTORIES、DEVELOPMENT_ONLY_FILES；src/capability/pack.ts、src/backend/pack.ts',
  },
  archivePolicy: {
    pathOrder: 'zip 条目按路径字符串升序排序（compareArchivePaths 字典序）',
    compressionLevel: ZIP_COMPRESSION_LEVEL,
    storeFallback: `deflateRawSync(level ${ZIP_COMPRESSION_LEVEL}) 压缩后不小于原文时回退 store（method 0）`,
    pathRules: [
      '禁止空路径、以 / 开头的绝对路径、Windows 盘符（x:）、反斜杠、. 与 .. 段',
      `禁止 Windows 保留名：${WINDOWS_RESERVED_NAMES.join('/')}（按段名首个点前的基名大写比对）`,
      '禁止 Windows 禁用字符 <>:"|?* 与 0x20 以下控制字符',
      '段名不得以 . 或空格结尾',
      '路径重复或在 Windows 上文件/目录同名冲突（不区分大小写）→ FH2_CAPABILITY_PACK_PATH_DUPLICATE',
    ],
    source: 'src/capability/zip.ts#createDeterministicZip、validatePath、isPortablePathSegment、assertWindowsPathCompatible、WINDOWS_RESERVED_NAMES',
  },
})

// ---------------------------------------------------------------------------
// 访问器（消费方统一从这里读，不自行解析契约结构）
// ---------------------------------------------------------------------------

/** 按 ID 取布局描述符；未知 ID 直接报错，防止静默漏配。 */
export function artifactLayoutDescriptor (contract: ArtifactLayoutsContract, id: string): ArtifactLayoutDescriptor {
  const descriptor = contract.layouts.find(layout => layout.id === id)
  if (descriptor === undefined) throw new Error(`ARTIFACT_LAYOUTS_CONTRACT 缺少布局：${id}`)
  return descriptor
}

/** 导出器唯一使用的契约序列化器。 */
export function serializeArtifactLayoutsContract (contract: ArtifactLayoutsContract = ARTIFACT_LAYOUTS_CONTRACT): string {
  return serializeContract(contract)
}
