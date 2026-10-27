// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 命令上下文投影：precedence/side detection 来自生产 project-policy。
 *
 * 生产代码（src/capability/discovery.ts）与本投影共用 project-policy：
 * - discoverCommandContext / tryDiscoverCommandContext 按 precedence 的标记文件顺序判定；
 * - 前后端同名 fh2-plugin.json 的 side 判别使用 manifestSideDetection 的字段清单与规则。
 * supportedCommands 从 CLI 的运行模块 metadata 投影；metadata 仍是人工支持说明，
 * 不是 dispatch 策略。constraints/membershipRules 为人工行为说明。
 *
 * 事实来源（逐条对照实现，未包含的实现细节仍留在 discovery.ts 代码中）：
 * - src/capability/discovery.ts：判定优先级、side 标志字段、Capability/Workspace 成员规则、
 *   符号链接与越界限制、capabilities.json 字段白名单；
 * - src/backend/discovery.ts、src/backend/handler-names.ts：后端 Handler 发现范围与入口命名约定；
 * - src/pack/index.ts：legacy 行业包 plugins/* 的 pack 兜底发现。
 */

import { BACKEND_SOURCE_DIRECTORIES, CAPABILITY_METADATA_FIELDS, CONTEXT_PRECEDENCE, MANIFEST_SIDE_DETECTION, PROJECT_PATHS, manifestSide } from '../project-policy.js'
import { BUILD_CONTEXT_OPTIONS } from '../build/policy.js'
import { deepFreeze, serializeContract } from './shared.js'
import { CLI_CONTRACT } from './cli.js'

const markerFields = (side: PluginManifestSide) => MANIFEST_SIDE_DETECTION.sides.find(item => item.side === side)!.markerFields.join('/')

/** 稳定的工程上下文 ID（与 capability/types.ts 的 CommandContext kind 对应，legacy 兜底除外）。 */
export type CommandContextId =
  | 'industry-capability-workspace'
  | 'capability-project'
  | 'frontend-plugin'
  | 'backend-plugin'
  | 'legacy-industry-plugins-root'

export type PluginManifestSide = 'frontend' | 'backend'

/** precedence 的一步：标记文件存在即命中，命中后按 contextIds 分派（多值时按清单内容判别 side）。 */
export interface ContextMarkerStep {
  readonly markerFile: string;
  readonly contextIds: readonly CommandContextId[];
}

/** 单个上下文的识别标记；前后端共用 fh2-plugin.json 时用 manifestSide 区分。 */
export interface ContextMarkerDescriptor {
  readonly file: string;
  readonly manifestSide?: PluginManifestSide;
}

export interface ContextDescriptor {
  readonly id: CommandContextId;
  readonly markers: readonly ContextMarkerDescriptor[];
  /** Derived from execution-module CLI metadata, not an execution dispatch table. */
  readonly supportedCommands: readonly string[];
  readonly constraints: readonly string[];
  /** 权威模块与 symbol，不记录易漂移行号。 */
  readonly source: string;
}

/** 前后端同名 fh2-plugin.json 的内容判别规则与字段清单。 */
export interface ManifestSideDetection {
  /**
   * 判定规则：backend 标志字段存在且 frontend 标志字段不存在 → backend；
   * 其余情况（含两者并存、两者皆缺）→ fallbackSide。
   */
  readonly rule: 'backend-marker-present-and-frontend-marker-absent';
  readonly fallbackSide: PluginManifestSide;
  readonly sides: readonly {
    readonly side: PluginManifestSide;
    readonly markerFields: readonly string[];
  }[];
  readonly source: string;
}

/** Capability / 行业工作区的成员目录约束。 */
export interface MembershipRule {
  readonly id: string;
  readonly contextId: CommandContextId;
  readonly rule: string;
  readonly source: string;
}

export interface ContextDiscoveryContract {
  readonly schemaVersion: number;
  readonly precedence: readonly ContextMarkerStep[];
  readonly contexts: readonly ContextDescriptor[];
  readonly manifestSideDetection: ManifestSideDetection;
  readonly membershipRules: readonly MembershipRule[];
}

export const CONTEXT_DISCOVERY_CONTRACT: ContextDiscoveryContract = deepFreeze({
  schemaVersion: 1,
  precedence: CONTEXT_PRECEDENCE,
  contexts: [
    {
      id: 'backend-plugin',
      markers: [{ file: PROJECT_PATHS.sourceManifest, manifestSide: 'backend' }],
      supportedCommands: supportedCommandsForContext('backend-plugin'),
      constraints: [
        `清单含后端标志字段（${markerFields('backend')} 之一）且不含任何前端标志字段（${markerFields('frontend')}）`,
        `独立后端插件 build ${BUILD_CONTEXT_OPTIONS['backend-plugin'].supportsWatch ? '支持' : '不支持'} --watch；${BUILD_CONTEXT_OPTIONS['backend-plugin'].supportsConfig ? '支持' : '不支持'} --config`,
        'dev 只 Build + Watch 后端并启动本地 /plugin-api/plugin/invoke 调试 Gateway，不启动前端 Workbench',
        `后端 Handler 发现范围是 ${BACKEND_SOURCE_DIRECTORIES.handlers}/**（源码，排除 *.d.ts）与 ${BACKEND_SOURCE_DIRECTORIES.scripts}/**（已打包）；Bundle 入口使用 h_<domain>_<export> 名，HTTP 可读名从 h_<domain>_<action> 派生别名`,
      ],
      source: 'src/capability/discovery.ts#discoverPluginContextByManifest、src/backend/discovery.ts#discoverBackendHandlerFiles、src/backend/handler-names.ts',
    },
    {
      id: 'capability-project',
      markers: [{ file: PROJECT_PATHS.capabilityMetadata }],
      supportedCommands: supportedCommandsForContext('capability-project'),
      constraints: [
        '根目录 capabilities.json 是最高优先级标志文件（高于 fh2-plugin.json 与 packages.json）',
        `${PROJECT_PATHS.frontend}/* 与 ${PROJECT_PATHS.backend}/* 下的普通子目录是插件成员，目录名必须与插件 ID 一致`,
        `build ${BUILD_CONTEXT_OPTIONS['capability-project'].supportsWatch ? '支持' : '不支持'} --watch；--config 必须且只能指定一个 --frontend <pluginId>`,
        'pack 支持 --no-build 复用最新独立默认配置 Build Report',
        'Preview 只读取 Capability 元数据与 frontend/*，不触碰 backend/*',
      ],
      source: 'src/capability/discovery.ts#discoverCapabilityProject',
    },
    {
      id: 'frontend-plugin',
      markers: [{ file: PROJECT_PATHS.sourceManifest, manifestSide: 'frontend' }],
      supportedCommands: supportedCommandsForContext('frontend-plugin'),
      constraints: [
        `清单含前端标志字段（${markerFields('frontend')} 之一），或前后端标志字段都缺失时按${MANIFEST_SIDE_DETECTION.fallbackSide === 'frontend' ? '前端' : '后端'}处理（前端 schema 会给出具体报错）`,
        'pack 生成独立前端插件交付物 + zip（默认 release/）',
      ],
      source: 'src/capability/discovery.ts#discoverPluginContextByManifest',
    },
    {
      id: 'industry-capability-workspace',
      markers: [{ file: PROJECT_PATHS.packageManifest }],
      supportedCommands: supportedCommandsForContext('industry-capability-workspace'),
      constraints: [
        '根目录 packages.json（且无 capabilities.json / fh2-plugin.json）时识别为工作区',
        `build 不支持 ${[
          ...(BUILD_CONTEXT_OPTIONS['industry-capability-workspace'].supportsWatch ? [] : ['--watch']),
          ...(BUILD_CONTEXT_OPTIONS['industry-capability-workspace'].supportsConfig ? [] : ['--config']),
          ...(BUILD_CONTEXT_OPTIONS['industry-capability-workspace'].supportsFilters ? [] : ['--frontend', '--backend']),
        ].join('、')}；请在具体 Capability 根执行`,
        'pack 始终先构建全部 Capability，不支持 --no-build',
      ],
      source: 'src/capability/discovery.ts#discoverIndustryCapabilityWorkspace',
    },
    {
      id: 'legacy-industry-plugins-root',
      markers: [{ file: 'plugins/' }],
      supportedCommands: supportedCommandsForContext('legacy-industry-plugins-root'),
      constraints: [
        '仅作为 pack 的兜底路径：目录下无任何上下文标记文件时，pack 把 plugins/ 的每个直接子目录当作独立前端插件工程',
        'plugins/ 为空或不可读时 pack 失败（FH2_PACK_PLUGINS_EMPTY / FH2_PACK_PLUGINS_READ_FAILED）',
      ],
      source: 'src/pack/index.ts#discoverIndustryPluginRoots、src/commands/pack-command.ts#runPackCommand',
    },
  ],
  manifestSideDetection: {
    ...MANIFEST_SIDE_DETECTION,
    source: 'src/capability/discovery.ts#discoverPluginContextByManifest',
  },
  membershipRules: [
    {
      id: 'capability-container-members',
      contextId: 'capability-project',
      rule: 'frontend/ 与 backend/ 容器下的普通子目录必须全部携带 fh2-plugin.json，缺失即报 FH2_CAPABILITY_PLUGIN_MANIFEST_MISSING；以 . 开头的隐藏目录忽略',
      source: 'src/capability/discovery.ts#discoverPluginDirectories',
    },
    {
      id: 'capability-container-safety',
      contextId: 'capability-project',
      rule: 'frontend/backend 容器与插件目录不能是符号链接；容器真实路径不得越过 Capability 根（FH2_CAPABILITY_PLUGIN_DISCOVERY_FAILED）',
      source: 'src/capability/discovery.ts#assertCapabilityContainer、discoverPluginDirectories',
    },
    {
      id: 'capability-directory-id-match',
      contextId: 'capability-project',
      rule: '前端插件目录名必须等于 fh2-plugin.json.id，后端插件目录名必须等于 fh2-plugin.json.pluginId（FH2_CAPABILITY_FRONTEND_ID_MISMATCH / FH2_CAPABILITY_BACKEND_ID_MISMATCH）',
      source: 'src/capability/discovery.ts#discoverFrontendProjects、discoverBackendProjects',
    },
    {
      id: 'capability-metadata-shape',
      contextId: 'capability-project',
      rule: `${PROJECT_PATHS.capabilityMetadata} 只允许 ${CAPABILITY_METADATA_FIELDS.join(' 与 ')} 非空字符串字段（FH2_CAPABILITY_METADATA_INVALID）`,
      source: 'src/capability/discovery.ts#readCapabilityMetadata',
    },
    {
      id: 'capability-plugin-id-unique',
      contextId: 'capability-project',
      rule: '同一 Capability 内前后端 pluginId 必须唯一（FH2_CAPABILITY_PLUGIN_ID_CONFLICT）',
      source: 'src/capability/discovery.ts#assertUniquePluginIds',
    },
    {
      id: 'workspace-direct-capability-children',
      contextId: 'industry-capability-workspace',
      rule: 'packages.json 的 capabilityIds 必须是工作区直接子目录名，不能是路径、. 或 ..（FH2_INDUSTRY_CAPABILITY_WORKSPACE_INVALID）',
      source: 'src/capability/discovery.ts#isDirectChild',
    },
    {
      id: 'workspace-member-parity',
      contextId: 'industry-capability-workspace',
      rule: 'capabilityIds 与含 capabilities.json 的直接 Capability 子目录必须双向一致（FH2_INDUSTRY_CAPABILITY_WORKSPACE_MEMBERSHIP_MISMATCH）',
      source: 'src/capability/discovery.ts#discoverIndustryCapabilityWorkspace',
    },
    {
      id: 'workspace-member-safety',
      contextId: 'industry-capability-workspace',
      rule: '工作区 Capability 成员必须是普通直接子目录，拒绝符号链接与非目录（FH2_INDUSTRY_CAPABILITY_WORKSPACE_PATH_UNSAFE）',
      source: 'src/capability/discovery.ts#discoverIndustryCapabilityWorkspace、discoverDirectCapabilityDirectories',
    },
    {
      id: 'workspace-single-package-entry',
      contextId: 'industry-capability-workspace',
      rule: 'packages.json 只允许一个包条目（packageId + name + capabilityIds）（FH2_PACKAGE_MANIFEST_INVALID）',
      source: 'src/package/manifest.ts#parsePackageManifest',
    },
  ],
})

// ---------------------------------------------------------------------------
// 访问器（消费方统一从这里读，不自行解析契约结构）
// ---------------------------------------------------------------------------

/** One support inventory, authored in the execution modules and also consumed by CLI export. */
export function supportedCommandsForContext (
  context: CommandContextId,
  commands: readonly { readonly name: string; readonly contexts: readonly string[] }[] = CLI_CONTRACT.commands,
): readonly string[] {
  return commands.filter(command => command.contexts.includes(context)).map(command => command.name).sort()
}

/** 按上下文 ID 取描述符；未知 ID 直接报错，防止静默漏配。 */
export function contextDescriptor (contract: ContextDiscoveryContract, id: CommandContextId): ContextDescriptor {
  const descriptor = contract.contexts.find(context => context.id === id)
  if (descriptor === undefined) throw new Error(`CONTEXT_DISCOVERY_CONTRACT 缺少上下文：${id}`)
  return descriptor
}

/** precedence 中出现的标记文件清单（去重，保持优先级顺序），tryDiscover 用于快速判定。 */
export function contextMarkerFiles (contract: ContextDiscoveryContract): readonly string[] {
  const files: string[] = []
  for (const step of contract.precedence) {
    if (!files.includes(step.markerFile)) files.push(step.markerFile)
  }
  return files
}

/** 按契约判别清单 side：规则与字段清单都来自 manifestSideDetection，规则不匹配时显式报错。 */
export function detectManifestSide (
  manifest: Readonly<Record<string, unknown>>,
  contract: ContextDiscoveryContract = CONTEXT_DISCOVERY_CONTRACT,
): PluginManifestSide {
  if (contract === CONTEXT_DISCOVERY_CONTRACT) return manifestSide(manifest)
  const detection = contract.manifestSideDetection
  if (detection.rule !== 'backend-marker-present-and-frontend-marker-absent') {
    throw new Error(`不支持的 manifestSideDetection 规则（需扩展判别器）：${detection.rule}`)
  }
  const frontend = detection.sides.find(entry => entry.side === 'frontend')
  const backend = detection.sides.find(entry => entry.side === 'backend')
  if (frontend === undefined || backend === undefined) {
    throw new Error('manifestSideDetection 缺少 frontend 或 backend 字段清单')
  }
  const keys = Object.keys(manifest)
  const hasBackend = backend.markerFields.some(field => keys.includes(field))
  const hasFrontend = frontend.markerFields.some(field => keys.includes(field))
  return hasBackend && !hasFrontend ? 'backend' : detection.fallbackSide
}

/** 导出器唯一使用的契约序列化器。 */
export function serializeContextDiscoveryContract (contract: ContextDiscoveryContract = CONTEXT_DISCOVERY_CONTRACT): string {
  return serializeContract(contract)
}
