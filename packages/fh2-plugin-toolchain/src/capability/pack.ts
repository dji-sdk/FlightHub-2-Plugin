// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { inflateRawSync } from 'node:zlib'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isPluginId } from 'fh2-plugin-sdk'
import { validateBackendPlugin } from '../backend/contract.js'
import { PluginPackError, packFrontendPlugin } from '../pack/index.js'
import type { PluginPackDiagnostic } from '../pack/index.js'
import { resolveCapabilityPackageManifest, serializePackageManifest } from '../package/manifest.js'
import { PackageError, packageManifestPath } from '../package/types.js'
import { PROJECT_PATHS } from '../project-policy.js'
import { buildCapability, buildIndustryCapabilityWorkspace } from './build.js'
import type {
  CapabilityBuildResult,
  IndustryCapabilityWorkspaceBuildEvent,
  IndustryCapabilityWorkspaceBuildOptions,
  IndustryCapabilityWorkspaceBuildResult,
  IndustryCapabilityWorkspaceMemberFilter,
} from './build.js'
import { buildReportPath, digestBuildDirectory, digestFile, digestSourceDirectory } from './build-report.js'
import type { BuildReport } from './build-report.js'
import type { BackendPluginProject, CapabilityProject, FrontendPluginProject, IndustryCapabilityWorkspaceProject } from './types.js'
import { acquireCapabilityLock } from './lock.js'
import { validateIndustryMigrationLinks } from './migration-links.js'
import { createDeterministicZip } from './zip.js'
import { BUILD_REPORT_MATCH_CHECKS, BUILD_REPORT_REUSE_CHECKS, CAPABILITY_BACKEND_COPY_EXCLUSIONS, CAPABILITY_ZIP_EXCLUSIONS, DEVELOPMENT_ONLY_DIRECTORIES, PLATFORM_OWNED_FILES, isPackExcluded } from './policy.js'

export interface CapabilityPackOptions {
  readonly capability: CapabilityProject;
  readonly outputRoot?: string;
  readonly noBuild?: boolean;
  /** executor 持锁调用的内部标记（T6）：跳过二次抢锁。 */
  readonly operationLockHeld?: boolean;
  /**
   * 成员裁剪（U2 打包范围选择）：选中要装包的成员 id 集合。
   * undefined = 全量；与 noBuild 互斥（部分成员无法复用全量 Build Report）。
   */
  readonly members?: ReadonlySet<string>;
  /** 取消传播：中断内部 build 的挂起子进程（IDE-014-06）。 */
  readonly abortSignal?: AbortSignal;
  readonly build?: (options: { readonly capability: CapabilityProject; readonly operationLockHeld?: boolean }) => Promise<CapabilityBuildResult>;
}

export interface CapabilityPackResult {
  readonly releaseRoot: string;
  readonly packageDir: string;
  readonly capabilityDir: string;
  readonly packageId: string;
  readonly zipPath: string;
  readonly warnings: readonly PluginPackDiagnostic[];
}

export interface IndustryCapabilityWorkspacePackOptions {
  readonly workspace: IndustryCapabilityWorkspaceProject;
  readonly outputRoot?: string;
  /** executor 持锁调用的内部标记（T6）：跳过二次抢锁。 */
  readonly operationLockHeld?: boolean;
  /**
   * 成员裁剪（U2 打包范围选择）：选中成员的限定 id（`<capabilityId>` 或
   * `<capabilityId>/<memberId>`）。undefined = 全量。
   */
  readonly members?: ReadonlySet<string>;
  /** 取消传播：中断内部 build 的挂起子进程（IDE-014-06）。 */
  readonly abortSignal?: AbortSignal;
  readonly build?: (options: IndustryCapabilityWorkspaceBuildOptions) => Promise<IndustryCapabilityWorkspaceBuildResult>;
  readonly onCapabilityEvent?: (event: IndustryCapabilityWorkspaceBuildEvent) => void;
}

export interface IndustryCapabilityWorkspacePackResult {
  readonly releaseRoot: string;
  readonly packageDir: string;
  readonly packageId: string;
  readonly zipPath: string;
  readonly warnings: readonly PluginPackDiagnostic[];
}

export async function packCapability (options: CapabilityPackOptions): Promise<CapabilityPackResult> {
  if (options.operationLockHeld === true) return await packCapabilityUnlocked(options)
  const releaseLock = acquireCapabilityLock(options.capability.root)
  try {
    return await packCapabilityUnlocked(options)
  } finally {
    releaseLock()
  }
}

/** 把工作区的全部 Capability 组装为一个 GT 风格的未签名上传包。 */
export async function packIndustryCapabilityWorkspace (
  options: IndustryCapabilityWorkspacePackOptions,
): Promise<IndustryCapabilityWorkspacePackResult> {
  if (options.operationLockHeld === true) {
    validateIndustryMigrationLinks(options.workspace)
    return await packIndustryCapabilityWorkspaceUnlocked(options)
  }
  const releaseLock = acquireCapabilityLock(options.workspace.root)
  try {
    validateIndustryMigrationLinks(options.workspace)
    return await packIndustryCapabilityWorkspaceUnlocked(options)
  } finally {
    releaseLock()
  }
}

async function packIndustryCapabilityWorkspaceUnlocked (
  options: IndustryCapabilityWorkspacePackOptions,
): Promise<IndustryCapabilityWorkspacePackResult> {
  const workspace = options.workspace
  const packageEntry = workspace.packageManifest
  const packageId = packageEntry.packageId
  const releaseRoot = resolve(realpathSync(workspace.root), options.outputRoot ?? PROJECT_PATHS.release)
  const packageDir = join(releaseRoot, packageId)
  const zipPath = join(releaseRoot, `${packageId}.zip`)
  assertWorkspaceReleaseRoot(workspace, releaseRoot, packageDir, zipPath)
  assertWorkspaceSourceRoots(workspace)
  // U2：按成员裁剪参与打包的 Capability 与其成员；members 缺省 = 全量。
  const selected = selectWorkspaceMembers(workspace, options.members)

  const build = options.build ?? buildIndustryCapabilityWorkspace
  // 构建范围与装包范围一致：未选中的 Capability 不构建，选中的 Capability 只构建选中成员。
  const memberFilters = options.members === undefined ? undefined : toMemberFilters(selected)
  const buildResult = await build({
    workspace,
    operationLockHeld: true,
    ...(memberFilters === undefined ? {} : { memberFilters }),
    ...(options.onCapabilityEvent === undefined ? {} : { onCapabilityEvent: options.onCapabilityEvent }),
    ...(options.abortSignal === undefined || options.build !== undefined ? {} : { abortSignal: options.abortSignal }),
  })
  if (!buildResult.ok) {
    throw new PluginPackError({
      code: 'FH2_INDUSTRY_CAPABILITY_WORKSPACE_PACK_BUILD_FAILED',
      file: workspace.root,
      message: formatWorkspaceBuildFailure(buildResult),
    })
  }

  mkdirSync(releaseRoot, { recursive: true })
  const candidateRoot = join(releaseRoot, `.${packageId}.fh2-pack-next-${randomUUID()}`)
  const candidateZipPath = join(releaseRoot, `.${packageId}.fh2-zip-next-${randomUUID()}`)
  let committed = false
  try {
    mkdirSync(candidateRoot, { recursive: true })
    writeFileSync(join(candidateRoot, 'packages.json'), serializePackageManifest(packageEntry), 'utf8')
    for (const capability of selected) await stageCapability(candidateRoot, capability.capability)
    writeCapabilityZip(candidateRoot, candidateZipPath)
    verifyZipMatchesCandidate(
      candidateRoot,
      candidateZipPath,
      selected.map(entry => entry.capability.capabilityId),
    )
    const warnings = commitArtifacts([
      { label: '行业 Capability 工作区包目录', candidatePath: candidateRoot, targetPath: packageDir },
      { label: '行业 Capability 工作区包 zip', candidatePath: candidateZipPath, targetPath: zipPath },
    ])
    committed = true
    return { releaseRoot, packageDir, packageId, zipPath, warnings }
  } catch (error) {
    if (error instanceof PluginPackError) throw error
    throw new PluginPackError({
      code: 'FH2_INDUSTRY_CAPABILITY_WORKSPACE_PACK_FAILED',
      message: `生成行业 Capability 工作区上传包失败：${message(error)}`,
      file: packageDir,
    })
  } finally {
    if (!committed) {
      rmSync(candidateRoot, { recursive: true, force: true })
      rmSync(candidateZipPath, { force: true })
    }
  }
}

async function packCapabilityUnlocked (options: CapabilityPackOptions): Promise<CapabilityPackResult> {
  const capability = options.capability
  // 平台上传包必须携带根级 packages.json（由 create 生成）。
  const packageEntry = readCapabilityPackageManifest(capability)
  const packageId = packageEntry.packageId
  const releaseRoot = resolve(realpathSync(capability.root), options.outputRoot ?? PROJECT_PATHS.release)
  const packageDir = join(releaseRoot, packageId)
  const capabilityDir = join(packageDir, capability.capabilityId)
  const zipPath = join(releaseRoot, `${packageId}.zip`)
  assertReleaseRoot(capability, releaseRoot, packageDir, zipPath)
  assertCapabilitySourceRoots(capability)
  // U2：成员裁剪。部分成员无法复用全量 Build Report，与 noBuild 互斥。
  if (options.members !== undefined && options.noBuild === true) {
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_PACK_MEMBERS_NO_BUILD',
      message: '按成员打包与 --no-build 不能同时使用：部分成员打包必须执行完整构建。Members filter cannot be combined with --no-build.',
    })
  }
  const selected = selectCapabilityMembers(capability, options.members)
  const buildOptions = options.members === undefined
    ? {}
    : {
        frontendFilter: new Set(selected.frontend.map(project => project.id)),
        backendFilter: new Set(selected.backend.map(project => project.id)),
      }
  if (options.noBuild === true) {
    verifyFreshBuild(capability)
  } else {
    const build = options.build === undefined
      ? await buildCapability({ capability, operationLockHeld: true, ...buildOptions, ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }) })
      : await options.build({ capability })
    if (!build.ok) {
      throw new PluginPackError({
        code: 'FH2_CAPABILITY_PACK_BUILD_FAILED',
        message: build.diagnostics.map(diagnostic => diagnostic.message).join('\n'),
      })
    }
  }

  mkdirSync(releaseRoot, { recursive: true })
  const candidateRoot = join(releaseRoot, `.${packageId}.fh2-pack-next-${randomUUID()}`)
  const candidateZipPath = join(releaseRoot, `.${packageId}.fh2-zip-next-${randomUUID()}`)
  let committed = false
  try {
    mkdirSync(candidateRoot, { recursive: true })
    writeFileSync(join(candidateRoot, 'packages.json'), serializePackageManifest(packageEntry), 'utf8')
    await stageCapability(candidateRoot, { ...capability, frontend: selected.frontend, backend: selected.backend })
    // zip 根目录直接包含 packages.json 与能力目录，不套 <packageId>/ 层。
    writeCapabilityZip(candidateRoot, candidateZipPath)
    verifyZipMatchesCandidate(candidateRoot, candidateZipPath, [capability.capabilityId])
    const warnings = commitArtifacts([
      { label: '平台包目录', candidatePath: candidateRoot, targetPath: packageDir },
      { label: '平台包 zip', candidatePath: candidateZipPath, targetPath: zipPath },
    ])
    committed = true
    return { releaseRoot, packageDir, capabilityDir, packageId, zipPath, warnings }
  } catch (error) {
    if (error instanceof PluginPackError) throw error
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_PACK_FAILED',
      message: `生成 Capability 上传包失败：${message(error)}`,
      file: packageDir,
    })
  } finally {
    if (!committed) {
      rmSync(candidateRoot, { recursive: true, force: true })
      rmSync(candidateZipPath, { force: true })
    }
  }
}

function readCapabilityPackageManifest (capability: CapabilityProject) {
  try {
    const resolution = resolveCapabilityPackageManifest(capability.root, capability.capabilityId)
    if (resolution === undefined) {
      throw new PackageError(
        'FH2_PACKAGE_MANIFEST_NOT_FOUND',
        `Capability 根缺少 packages.json（上传包清单），且不属于任何声明了它的行业工作区；请通过 fh2-plugin create 创建完整 Capability（工作区根携带 packages.json），或在父工作区根的 packages.json 中声明 ${capability.capabilityId}。`,
        packageManifestPath(capability.root),
      )
    }
    return resolution.entry
  } catch (error) {
    if (error instanceof PackageError) {
      throw new PluginPackError({
        code: error.code,
        message: error.message,
        ...(error.file === undefined ? {} : { file: error.file }),
      })
    }
    throw error
  }
}

function resolveManifestForFreshness (capability: CapabilityProject) {
  try {
    return resolveCapabilityPackageManifest(capability.root, capability.capabilityId)
  } catch (error) {
    if (error instanceof PackageError) {
      throw new PluginPackError({
        code: error.code,
        message: error.message,
        ...(error.file === undefined ? {} : { file: error.file }),
      })
    }
    throw error
  }
}

function verifyFreshBuild (capability: CapabilityProject): void {
  const reportPath = buildReportPath(capability.root)
  let report: BuildReport
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8')) as BuildReport
  } catch (error) {
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_BUILD_STALE',
      file: reportPath,
      message: `无法读取 Capability Build Report：${message(error)}`,
    })
  }
  if (!BUILD_REPORT_MATCH_CHECKS.capabilityId(report.capabilityId, capability.capabilityId)) {
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_BUILD_STALE',
      file: reportPath,
      message: 'Build Report 的 Capability ID 与当前目录不一致。',
    })
  }
  if (!BUILD_REPORT_MATCH_CHECKS.metadataDigest(report.metadataDigest, digestFile(capability.metadataPath))) {
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_BUILD_STALE',
      file: reportPath,
      message: 'Build Report 与 capabilities.json 不一致。',
    })
  }
  // packages.json（本地或父工作区派生）必须纳入 Build Report：缺失或变化都视为过期。
  const resolution = resolveManifestForFreshness(capability)
  if (!BUILD_REPORT_MATCH_CHECKS.packageManifestRecorded(report.packageManifestDigest)) {
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_BUILD_STALE',
      file: reportPath,
      message: 'Build Report 未记录 packages.json；Build 时该文件不存在或已过期，请重新构建。',
    })
  }
  if (!BUILD_REPORT_MATCH_CHECKS.packageManifestDigest(report.packageManifestDigest, resolution?.digest)) {
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_BUILD_STALE',
      file: reportPath,
      message: 'Build Report 与 packages.json 不一致。',
    })
  }
  verifyReportEntries(report.frontend, capability.frontend.map(project => project.id), 'frontend', reportPath)
  verifyReportEntries(report.backend, capability.backend.map(project => project.id), 'backend', reportPath)
  for (const frontend of capability.frontend) {
    verifyReportEntry(report.frontend[frontend.id], join(frontend.root, PROJECT_PATHS.dist), frontend.root, reportPath)
  }
  for (const backend of capability.backend) {
    verifyReportEntry(report.backend[backend.id], join(backend.root, PROJECT_PATHS.dist), backend.root, reportPath)
  }
}

function verifyReportEntry (
  entry: {
    readonly digest: string;
    readonly sourceDigest: string;
    readonly configPath?: string;
    readonly configDigest?: string;
    readonly hasExternalSourceDependencies?: boolean;
    readonly hasExternalConfigDependencies?: boolean;
    readonly sourceChangedDuringBuild?: boolean;
  } | undefined,
  distRoot: string,
  sourceRoot: string,
  reportPath: string,
): void {
  if (entry === undefined || !BUILD_REPORT_MATCH_CHECKS.distDigest(entry, existsSync(distRoot) ? digestBuildDirectory(distRoot) : undefined)) {
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_BUILD_STALE',
      file: reportPath,
      message: `Build Report 与 dist 产物不一致：${distRoot}。`,
    })
  }
  if (!BUILD_REPORT_MATCH_CHECKS.sourceDigest(entry.sourceDigest, digestSourceDirectory(sourceRoot))) {
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_BUILD_STALE',
      file: reportPath,
      message: `Build Report 生成后源码已变更：${sourceRoot}。`,
    })
  }
  if (BUILD_REPORT_REUSE_CHECKS.hasExternalSourceDependencies(entry)) {
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_BUILD_STALE',
      file: reportPath,
      message: `Build Report 包含 Capability 外源码依赖：${sourceRoot}；--no-build 不支持复用该构建。`,
    })
  }
  if (BUILD_REPORT_REUSE_CHECKS.hasExternalConfigDependencies(entry)) {
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_BUILD_STALE',
      file: reportPath,
      message: `Build Report 使用了 Capability 外的 Rsbuild 配置依赖：${sourceRoot}；--no-build 不支持复用该构建。`,
    })
  }
  if (BUILD_REPORT_REUSE_CHECKS.sourceChangedDuringBuild(entry)) {
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_BUILD_STALE',
      file: reportPath,
      message: `Build Report 生成期间源码发生变化：${sourceRoot}；--no-build 不支持复用该构建。`,
    })
  }
  if (BUILD_REPORT_REUSE_CHECKS.customConfig(entry)) {
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_BUILD_STALE',
      file: reportPath,
      message: `Build Report 使用了自定义 Rsbuild 配置：${entry.configPath ?? '未知配置'}；--no-build 不支持复用该构建。`,
    })
  }
}

function verifyReportEntries (
  entries: Readonly<Record<string, unknown>>,
  currentIds: readonly string[],
  side: 'frontend' | 'backend',
  reportPath: string,
): void {
  if (BUILD_REPORT_MATCH_CHECKS.currentMembers(entries, currentIds)) return
  throw new PluginPackError({
    code: 'FH2_CAPABILITY_BUILD_STALE',
    file: reportPath,
    message: `Build Report 包含当前 Capability 不存在的 ${side} 插件。`,
  })
}

async function stageCapability (candidateRoot: string, capability: CapabilityProject): Promise<void> {
  const capabilityRoot = join(candidateRoot, capability.capabilityId)
  mkdirSync(capabilityRoot, { recursive: true })
  writeFileSync(
    join(capabilityRoot, PROJECT_PATHS.capabilityMetadata),
    `${JSON.stringify(capability.metadata, null, 2)}\n`,
    'utf8',
  )
  for (const frontend of capability.frontend) {
    assertNoPlatformOwnedFiles(join(frontend.root, PROJECT_PATHS.dist))
    await packFrontendPlugin({
      distRoot: join(frontend.root, PROJECT_PATHS.dist),
      outputRoot: join(capabilityRoot, PROJECT_PATHS.frontend),
    })
  }
  for (const backend of capability.backend) {
    copyBackendDist(backend.root, join(capabilityRoot, PROJECT_PATHS.backend, backend.id))
  }
}

/** U2：单 Capability 根的成员裁剪（members 缺省 = 全量；id 必须存在）。 */
function selectCapabilityMembers (
  capability: CapabilityProject,
  members: ReadonlySet<string> | undefined,
): { readonly frontend: readonly FrontendPluginProject[]; readonly backend: readonly BackendPluginProject[] } {
  if (members === undefined) {
    return { frontend: capability.frontend, backend: capability.backend }
  }
  const known = new Set([
    ...capability.frontend.map(project => project.id),
    ...capability.backend.map(project => project.id),
  ])
  for (const id of members) {
    if (!known.has(id)) {
      throw new PluginPackError({
        code: 'FH2_CAPABILITY_PLUGIN_DISCOVERY_FAILED',
        message: `Capability 内不存在插件成员 ${id}。Plugin member not found: ${id}.`,
      })
    }
  }
  return {
    frontend: capability.frontend.filter(project => members.has(project.id)),
    backend: capability.backend.filter(project => members.has(project.id)),
  }
}

/**
 * U2：行业工作区成员裁剪。成员限定 id 形如 `<capabilityId>`（整选，含其全部
 * 插件成员）或 `<capabilityId>/<memberId>`（选该 Capability 下的单个插件）。
 * 没有任何成员被选中的 Capability 整个不进包；members 缺省 = 全量。
 */
function selectWorkspaceMembers (
  workspace: IndustryCapabilityWorkspaceProject,
  members: ReadonlySet<string> | undefined,
): readonly { readonly capability: CapabilityProject }[] {
  if (members === undefined) {
    return workspace.capabilities.map(capability => ({ capability }))
  }
  // 先校验全部限定 id 都指向真实成员
  const capabilityIds = new Set(workspace.capabilities.map(capability => capability.capabilityId))
  for (const id of members) {
    const [capabilityId, memberId = ''] = id.split('/')
    if (capabilityId === undefined || capabilityId === '' || !capabilityIds.has(capabilityId)) {
      throw new PluginPackError({
        code: 'FH2_INDUSTRY_CAPABILITY_WORKSPACE_PACK_MEMBER_NOT_FOUND',
        message: `工作区内不存在成员 ${id}。Workspace member not found: ${id}.`,
      })
    }
    if (memberId !== '') {
      const capability = workspace.capabilities.find(entry => entry.capabilityId === capabilityId)
      const known = new Set([
        ...(capability?.frontend ?? []).map(project => project.id),
        ...(capability?.backend ?? []).map(project => project.id),
      ])
      if (!known.has(memberId)) {
        throw new PluginPackError({
          code: 'FH2_INDUSTRY_CAPABILITY_WORKSPACE_PACK_MEMBER_NOT_FOUND',
          message: `Capability ${capabilityId} 内不存在插件成员 ${memberId}。Plugin member not found: ${memberId}.`,
        })
      }
    }
  }
  return workspace.capabilities
    .map((capability) => {
      const whole = members.has(capability.capabilityId)
      const memberIds = new Set(
        [...members]
          .filter(id => id.split('/')[0] === capability.capabilityId && (id.split('/')[1] ?? '') !== '')
          .map(id => id.split('/')[1] ?? ''),
      )
      if (whole) return { capability, anySelected: true }
      if (memberIds.size === 0) return { capability, anySelected: false }
      const selected = selectCapabilityMembers(capability, memberIds)
      return { capability: { ...capability, frontend: selected.frontend, backend: selected.backend }, anySelected: true }
    })
    .filter(entry => entry.anySelected)
}

/**
 * U2：把装包选集翻译为构建过滤（键 = capabilityId，值 = 该 Capability 选中成员的
 * 侧别 id 集合）。整选 capability 的成员集合即其全部成员，等价于全量构建它。
 */
function toMemberFilters (
  selected: readonly { readonly capability: CapabilityProject }[],
): ReadonlyMap<string, IndustryCapabilityWorkspaceMemberFilter> {
  return new Map(selected.map(entry => [
    entry.capability.capabilityId,
    {
      frontend: new Set(entry.capability.frontend.map(project => project.id)),
      backend: new Set(entry.capability.backend.map(project => project.id)),
    },
  ] as const))
}

function copyBackendDist (backendRoot: string, outputRoot: string): void {
  const distRoot = resolve(backendRoot, PROJECT_PATHS.dist)
  assertNoPlatformOwnedFiles(distRoot)
  const validation = validateBackendPlugin(distRoot)
  if (!validation.ok) {
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_PACK_BACKEND_INVALID',
      file: join(distRoot, 'plugin.json'),
      message: validation.diagnostics.map(diagnostic => diagnostic.message).join('\n'),
    })
  }
  mkdirSync(outputRoot, { recursive: true })
  copyBackendDirectory(distRoot, distRoot, outputRoot)
}

function copyBackendDirectory (root: string, directory: string, outputRoot: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (isPackExcluded(entry.name, CAPABILITY_BACKEND_COPY_EXCLUSIONS)) {
      continue
    }
    const source = resolve(directory, entry.name)
    const relativePath = relative(root, source).split(sep).join('/')
    if (entry.isDirectory()) {
      copyBackendDirectory(root, source, outputRoot)
      continue
    }
    if (!entry.isFile()) continue
    const realRoot = realpathSync(root)
    const realSource = realpathSync(source)
    if (!isContained(realRoot, realSource)) {
      throw new PluginPackError({
        code: 'FH2_CAPABILITY_PACK_PATH_UNSAFE',
        file: source,
        message: `后端 dist 资产真实路径越过根目录：${relativePath}。`,
      })
    }
    const target = resolve(outputRoot, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(realSource, target)
  }
}

function writeCapabilityZip (candidateRoot: string, zipPath: string): void {
  // zip 根直接映射 candidate 根：packages.json 与 <capabilityId>/ 平铺。
  const entries = collectZipEntries(candidateRoot, candidateRoot)
  writeFileSync(zipPath, createDeterministicZip(entries))
}

/** Spec 12：zip 解压后的文件集合与内容必须和 release 目录一致（digest 级比对）。 */
function verifyZipMatchesCandidate (
  candidateRoot: string,
  zipPath: string,
  capabilityIds: readonly string[],
): void {
  const expected = collectZipEntries(candidateRoot, candidateRoot)
  const actual = readZipEntries(readFileSync(zipPath))
  const expectedMap = new Map(expected.map(entry => [entry.path, entry.data] as const))
  if (actual.length !== expected.length) {
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_PACK_VERIFY_FAILED',
      file: zipPath,
      message: `zip 条目数不一致：预期 ${expected.length}，实际 ${actual.length}。`,
    })
  }
  for (const entry of actual) {
    const source = expectedMap.get(entry.path)
    if (source === undefined) {
      throw new PluginPackError({
        code: 'FH2_CAPABILITY_PACK_VERIFY_FAILED',
        file: zipPath,
        message: `zip 内出现候选目录不存在的条目：${entry.path}。`,
      })
    }
    if (!source.equals(entry.data)) {
      throw new PluginPackError({
        code: 'FH2_CAPABILITY_PACK_VERIFY_FAILED',
        file: zipPath,
        message: `zip 条目内容与候选目录不一致：${entry.path}。`,
      })
    }
    if (entry.path !== 'packages.json' && !capabilityIds.some(id => entry.path.startsWith(`${id}/`))) {
      throw new PluginPackError({
        code: 'FH2_CAPABILITY_PACK_VERIFY_FAILED',
        file: zipPath,
        message: `zip 根目录只允许 packages.json 与声明的 Capability 目录，发现：${entry.path}。`,
      })
    }
  }
}

function readZipEntries (archive: Buffer): readonly { readonly path: string; readonly data: Buffer }[] {
  const entries: { path: string; data: Buffer }[] = []
  let offset = 0
  while (offset + 30 <= archive.byteLength) {
    const signature = archive.readUInt32LE(offset)
    if (signature !== 0x04034B50) break
    const method = archive.readUInt16LE(offset + 8)
    const compressedSize = archive.readUInt32LE(offset + 18)
    const nameLength = archive.readUInt16LE(offset + 26)
    const extraLength = archive.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const path = archive.subarray(nameStart, nameStart + nameLength).toString('utf8')
    const compressed = archive.subarray(dataStart, dataStart + compressedSize)
    if (method === 8) {
      entries.push({ path, data: inflateRawSync(compressed) })
    } else {
      entries.push({ path, data: Buffer.from(compressed) })
    }
    offset = dataStart + compressedSize
  }
  return entries
}

function collectZipEntries (root: string, directory: string): Array<{ readonly path: string; readonly data: Buffer }> {
  const entries: Array<{ readonly path: string; readonly data: Buffer }> = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (CAPABILITY_ZIP_EXCLUSIONS.files.includes(entry.name)
      || CAPABILITY_ZIP_EXCLUSIONS.directories.includes(entry.name)) {
      continue
    }
    // 根层的 packages.json 是我们自己生成的上传包清单；子目录里的 packages.json 仍视为平台文件（dist 已拦截）。
    if (directory !== root && CAPABILITY_ZIP_EXCLUSIONS.nestedFiles.includes(entry.name)) {
      continue
    }
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      entries.push(...collectZipEntries(root, path))
      continue
    }
    if (!entry.isFile()) continue
    const relativePath = relative(root, path).split(sep).join('/')
    entries.push({ path: relativePath, data: readFileSync(path) })
  }
  return entries
}

function assertReleaseRoot (
  capability: CapabilityProject,
  releaseRoot: string,
  capabilityDir: string,
  zipPath: string,
): void {
  const root = realpathSync(capability.root)
  if (!isPluginId(capability.capabilityId)) {
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_PACK_OUTPUT_UNSAFE',
      file: capability.root,
      message: `Capability ID 不合法：${capability.capabilityId}。`,
    })
  }
  const release = canonicalPath(releaseRoot)
  const outputDirectory = canonicalPath(capabilityDir)
  const outputZip = canonicalPath(zipPath)
  if (release === root || !isContained(root, release)
    || !isContained(root, outputDirectory) || !isContained(root, outputZip)) {
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_PACK_OUTPUT_UNSAFE',
      file: release,
      message: 'Capability Pack 输出目录必须位于 Capability 根目录内。',
    })
  }
  for (const protectedRoot of [
    ...capability.frontend.map(project => project.root),
    ...capability.backend.map(project => project.root),
    join(capability.root, 'mock'),
  ]) {
    const canonicalProtectedRoot = existsSync(protectedRoot) ? realpathSync(protectedRoot) : resolve(protectedRoot)
    if (isContained(canonicalProtectedRoot, release) || isContained(canonicalProtectedRoot, outputDirectory)) {
      throw new PluginPackError({
        code: 'FH2_CAPABILITY_PACK_OUTPUT_UNSAFE',
        file: release,
        message: 'Capability Pack 输出目录不能位于前端、后端或 mock 源码目录内。',
      })
    }
  }
}

function assertWorkspaceReleaseRoot (
  workspace: IndustryCapabilityWorkspaceProject,
  releaseRoot: string,
  packageDir: string,
  zipPath: string,
): void {
  const root = realpathSync(workspace.root)
  const release = canonicalPath(releaseRoot)
  const outputDirectory = canonicalPath(packageDir)
  const outputZip = canonicalPath(zipPath)
  if (release === root || !isContained(root, release)
    || !isContained(root, outputDirectory) || !isContained(root, outputZip)) {
    throw new PluginPackError({
      code: 'FH2_INDUSTRY_CAPABILITY_WORKSPACE_PACK_OUTPUT_UNSAFE',
      file: release,
      message: '行业 Capability 工作区 Pack 输出目录必须位于工作区根目录内。',
    })
  }
  for (const capability of workspace.capabilities) {
    const capabilityRoot = realpathSync(capability.root)
    if (isContained(capabilityRoot, release) || isContained(capabilityRoot, outputDirectory)) {
      throw new PluginPackError({
        code: 'FH2_INDUSTRY_CAPABILITY_WORKSPACE_PACK_OUTPUT_UNSAFE',
        file: release,
        message: '行业 Capability 工作区 Pack 输出目录不能位于任一 Capability 源码目录内。',
      })
    }
  }
}

function assertCapabilitySourceRoots (capability: CapabilityProject): void {
  const root = realpathSync(capability.root)
  for (const project of [...capability.frontend, ...capability.backend]) {
    const sourceRoot = realpathSync(project.root)
    if (!isContained(root, sourceRoot)) {
      throw new PluginPackError({
        code: 'FH2_CAPABILITY_PACK_PATH_UNSAFE',
        file: project.root,
        message: `Capability 插件源码根越过 Capability 目录：${project.root}。`,
      })
    }
  }
}

function assertWorkspaceSourceRoots (workspace: IndustryCapabilityWorkspaceProject): void {
  const root = realpathSync(workspace.root)
  for (const capability of workspace.capabilities) {
    const capabilityRoot = realpathSync(capability.root)
    if (!isContained(root, capabilityRoot)) {
      throw new PluginPackError({
        code: 'FH2_INDUSTRY_CAPABILITY_WORKSPACE_PACK_PATH_UNSAFE',
        file: capability.root,
        message: `工作区 Capability 源码根越过工作区目录：${capability.root}。`,
      })
    }
    assertCapabilitySourceRoots(capability)
  }
}

function formatWorkspaceBuildFailure (result: IndustryCapabilityWorkspaceBuildResult): string {
  const failures = result.capabilities
    .filter(item => !item.result.ok)
    .map(item => `[capability ${item.capability.capabilityId}] ${item.result.diagnostics.map(diagnostic => diagnostic.message).join('\n')}`)
  const rootDiagnostics = result.diagnostics.map(diagnostic => diagnostic.message)
  const messages = [...failures, ...rootDiagnostics]
  return messages.length === 0
    ? '行业 Capability 工作区 Build 未完成。'
    : messages.join('\n')
}

interface PackPromotion {
  readonly label: string;
  readonly candidatePath: string;
  readonly targetPath: string;
}

interface PromotionRecord {
  readonly promotion: PackPromotion;
  readonly backupPath?: string;
}

function commitArtifacts (promotions: readonly PackPromotion[]): readonly PluginPackDiagnostic[] {
  const committed: PromotionRecord[] = []
  try {
    for (const promotion of promotions) {
      const backupPath = join(dirname(promotion.targetPath), `.${basename(promotion.targetPath)}.fh2-pack-backup-${randomUUID()}`)
      const record: PromotionRecord = {
        promotion,
        ...(existsSync(promotion.targetPath) ? { backupPath } : {}),
      }
      if (record.backupPath !== undefined) renameSync(promotion.targetPath, record.backupPath)
      committed.push(record)
      renameSync(promotion.candidatePath, promotion.targetPath)
    }
  } catch (error) {
    const rollbackErrors: string[] = []
    for (const record of [...committed].reverse()) {
      try {
        rmSync(record.promotion.targetPath, { recursive: true, force: true })
        if (record.backupPath !== undefined && existsSync(record.backupPath)) {
          renameSync(record.backupPath, record.promotion.targetPath)
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${record.promotion.label}：${message(rollbackError)}`)
      }
    }
    throw new PluginPackError({
      code: rollbackErrors.length === 0 ? 'FH2_CAPABILITY_PACK_COMMIT_FAILED' : 'FH2_CAPABILITY_PACK_ROLLBACK_FAILED',
      ...(promotions[0] === undefined ? {} : { file: promotions[0].targetPath }),
      message: rollbackErrors.length === 0
        ? `Capability 包提交失败，已回滚：${message(error)}`
        : `Capability 包提交失败且回滚不完整：${message(error)}；${rollbackErrors.join('；')}`,
    })
  }
  const warnings: PluginPackDiagnostic[] = []
  for (const record of committed) {
    if (record.backupPath === undefined) continue
    try {
      rmSync(record.backupPath, { recursive: true, force: true })
    } catch (error) {
      warnings.push({
        code: 'FH2_CAPABILITY_PACK_BACKUP_CLEANUP_FAILED',
        file: record.backupPath,
        message: `Capability ${record.promotion.label} 新包已提交，但旧包备份清理失败：${message(error)}`,
      })
    }
  }
  return warnings
}

function isContained (root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

function canonicalPath (pathValue: string): string {
  let existing = resolve(pathValue)
  const missingSegments: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    missingSegments.unshift(basename(existing))
    existing = parent
  }
  return resolve(realpathSync(existing), ...missingSegments)
}

function assertNoPlatformOwnedFiles (root: string): void {
  const rootStat = lstatSync(root)
  if (rootStat.isSymbolicLink()) {
    throw new PluginPackError({
      code: 'FH2_CAPABILITY_PACK_PATH_UNSAFE',
      file: root,
      message: `Capability dist 根不支持符号链接：${root}。`,
    })
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name)
    if (entry.isSymbolicLink()) {
      throw new PluginPackError({
        code: 'FH2_CAPABILITY_PACK_PATH_UNSAFE',
        file: path,
        message: `Capability dist 不支持符号链接资产：${path}。`,
      })
    }
    if (PLATFORM_OWNED_FILES.includes(entry.name)) {
      throw new PluginPackError({
        code: 'FH2_CAPABILITY_PACK_PLATFORM_FILE_FORBIDDEN',
        file: path,
        message: `${entry.name} 由管理平台生成，Toolchain 上传包不得包含该文件。`,
      })
    }
    if (entry.isDirectory() && DEVELOPMENT_ONLY_DIRECTORIES.includes(entry.name)) {
      throw new PluginPackError({
        code: 'FH2_CAPABILITY_PACK_DEVELOPMENT_FILE_FORBIDDEN',
        file: path,
        message: `${entry.name} 是本地开发目录，Toolchain 上传包不得包含该目录。`,
      })
    }
    if (entry.isDirectory()) assertNoPlatformOwnedFiles(path)
  }
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
