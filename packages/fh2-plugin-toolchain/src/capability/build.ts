// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { watch as watchFiles } from 'chokidar'
import { buildBackendPlugin } from '../backend/build.js'
import type { BackendPluginBuildResult } from '../backend/build.js'
import { createPluginBuildRunner } from '../build/runner.js'
import { PluginBuildError } from '../build/types.js'
import type { BuildDiagnostic, PluginBuildEvent, PluginBuildRunnerOptions, PluginBuildSession } from '../build/types.js'
import { resolveCapabilityPackageManifest } from '../package/manifest.js'
import { PackageError, packageManifestPath } from '../package/types.js'
import { PROJECT_PATHS } from '../project-policy.js'
import { BUILD_PHASES } from '../build/policy.js'
import { CapabilityError } from './types.js'
import type {
  BackendPluginProject,
  CapabilityProject,
  FrontendPluginProject,
  IndustryCapabilityWorkspaceProject,
} from './types.js'
import { validateIndustryMigrationLinks } from './migration-links.js'
import { validateCapability } from './validate.js'
import type { CapabilityValidationResult } from './validate.js'
import { acquireCapabilityLock } from './lock.js'
import {
  createBuildReportCandidate,
  digestBuildDirectory,
  digestFile,
  digestSourceDirectory,
  discardBuildReportCandidate,
  removeBuildReport,
} from './build-report.js'
import type { BuildReport, BuildReportCandidate, BuildReportPluginEntry } from './build-report.js'
import { BACKEND_WATCH_TRANSACTION_PREFIX, selectBuildProjects } from './policy.js'

const CONFIG_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json']

export interface CapabilityBuildEvent {
  readonly side: 'frontend' | 'backend';
  readonly pluginId: string;
  readonly type: 'success' | 'failure';
  readonly diagnostics: readonly BuildDiagnostic[];
}

export interface CapabilityBuildOptions {
  readonly capability: CapabilityProject;
  /** Capability Pack 持锁调用的内部标记。 */
  readonly operationLockHeld?: boolean;
  readonly frontendFilter?: ReadonlySet<string>;
  readonly backendFilter?: ReadonlySet<string>;
  readonly frontendConfigPath?: string;
  readonly watch?: boolean;
  readonly abortSignal?: AbortSignal;
  readonly createFrontendRunner?: (options: PluginBuildRunnerOptions) => Promise<PluginBuildSession>;
  readonly buildBackend?: typeof buildBackendPlugin;
  readonly validate?: (capability: CapabilityProject) => CapabilityValidationResult;
  readonly createReportCandidate?: typeof createBuildReportCandidate;
  readonly createBackendWatcher?: (
    root: string,
    onChange: () => void,
    onError: (error: unknown) => void,
  ) => CapabilityBackendWatcher;
  readonly onPluginEvent?: (event: CapabilityBuildEvent) => void;
}

export interface CapabilityBuildResult {
  readonly ok: boolean;
  readonly diagnostics: readonly BuildDiagnostic[];
  readonly report?: BuildReport;
}

export interface CapabilityBackendWatcher {
  close: () => Promise<void>;
}

export interface CapabilityBuildWatchSession {
  readonly firstBuild: Promise<void>;
  readonly done: Promise<
    | { readonly reason: 'closed' }
    | { readonly reason: 'fatal'; readonly diagnostics: readonly BuildDiagnostic[] }
  >;
  close: () => Promise<void>;
}

export interface IndustryCapabilityWorkspaceBuildEvent {
  readonly capability: CapabilityProject;
  readonly type: 'start' | 'success' | 'failure';
  readonly diagnostics: readonly BuildDiagnostic[];
}

export interface IndustryCapabilityWorkspaceBuildCapabilityResult {
  readonly capability: CapabilityProject;
  readonly result: CapabilityBuildResult;
}

export interface IndustryCapabilityWorkspaceMemberFilter {
  /** 选中的前端插件成员 id（限定到 capability 内的裸 memberId）。 */
  readonly frontend: ReadonlySet<string>;
  /** 选中的后端插件成员 id。 */
  readonly backend: ReadonlySet<string>;
}

export interface IndustryCapabilityWorkspaceBuildOptions {
  readonly workspace: IndustryCapabilityWorkspaceProject;
  /** Workspace Pack 持锁调用的内部标记。 */
  readonly operationLockHeld?: boolean;
  readonly abortSignal?: AbortSignal;
  readonly buildCapability?: typeof buildCapability;
  readonly onCapabilityEvent?: (event: IndustryCapabilityWorkspaceBuildEvent) => void;
  /**
   * U2 打包范围：选中成员的侧别 id 集合（键 = capabilityId）。
   * 不在映射内的 Capability 整个跳过构建；映射内的 Capability 只构建选中成员。
   * 缺省 = 全量构建（与旧行为一致）。
   */
  readonly memberFilters?: ReadonlyMap<string, IndustryCapabilityWorkspaceMemberFilter>;
}

export interface IndustryCapabilityWorkspaceBuildResult {
  readonly ok: boolean;
  readonly capabilities: readonly IndustryCapabilityWorkspaceBuildCapabilityResult[];
  readonly diagnostics: readonly BuildDiagnostic[];
}

interface PendingBuild {
  readonly side: 'frontend' | 'backend';
  readonly pluginId: string;
  readonly version: string;
  readonly candidateRoot: string;
  readonly distRoot: string;
  readonly sourceRoot: string;
  readonly sourceDigest: string;
  readonly hasExternalSourceDependencies: boolean;
  readonly hasExternalConfigDependencies: boolean;
  readonly sourceChangedDuringBuild: boolean;
}

export async function buildCapability (options: CapabilityBuildOptions): Promise<CapabilityBuildResult> {
  if (options.operationLockHeld === true) return await buildCapabilityUnlocked(options)
  let releaseLock: (() => void) | undefined
  try {
    releaseLock = acquireCapabilityLock(options.capability.root)
    return await buildCapabilityUnlocked(options)
  } catch (error) {
    return { ok: false, diagnostics: asBuildError(error).diagnostics }
  } finally {
    releaseLock?.()
  }
}

/** 按 packages.json 的 capabilityIds 顺序构建工作区内全部 Capability。 */
export async function buildIndustryCapabilityWorkspace (
  options: IndustryCapabilityWorkspaceBuildOptions,
): Promise<IndustryCapabilityWorkspaceBuildResult> {
  if (options.operationLockHeld === true) return await buildIndustryCapabilityWorkspaceUnlocked(options)
  let releaseLock: (() => void) | undefined
  try {
    releaseLock = acquireCapabilityLock(options.workspace.root)
    return await buildIndustryCapabilityWorkspaceUnlocked(options)
  } catch (error) {
    return {
      ok: false,
      capabilities: [],
      diagnostics: asBuildError(error).diagnostics,
    }
  } finally {
    releaseLock?.()
  }
}

async function buildIndustryCapabilityWorkspaceUnlocked (
  options: IndustryCapabilityWorkspaceBuildOptions,
): Promise<IndustryCapabilityWorkspaceBuildResult> {
  validateIndustryMigrationLinks(options.workspace)
  const capabilities: IndustryCapabilityWorkspaceBuildCapabilityResult[] = []
  const diagnostics: BuildDiagnostic[] = []
  const build = options.buildCapability ?? buildCapability
  for (const capability of options.workspace.capabilities) {
    // U2 打包范围：未选中的 Capability 跳过构建（其成员也不会进包）
    const memberFilter = options.memberFilters?.get(capability.capabilityId)
    if (options.memberFilters !== undefined && memberFilter === undefined) continue
    if (options.abortSignal?.aborted) {
      diagnostics.push({
        code: 'FH2_INDUSTRY_CAPABILITY_WORKSPACE_BUILD_ABORTED',
        phase: 'config',
        message: '行业 Capability 工作区 Build 已被终止。',
      })
      break
    }
    emitWorkspaceBuild(options, { capability, type: 'start', diagnostics: [] })
    let result: CapabilityBuildResult
    try {
      result = await build({
        capability,
        ...(memberFilter === undefined ? {} : sideFiltersOf(memberFilter)),
        ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      })
    } catch (error) {
      result = { ok: false, diagnostics: asBuildError(error).diagnostics }
    }
    capabilities.push({ capability, result })
    emitWorkspaceBuild(options, {
      capability,
      type: result.ok ? 'success' : 'failure',
      diagnostics: result.diagnostics,
    })
  }
  return {
    // 全量口径：全部 Capability 都要构建且成功；memberFilters 裁剪后只看参与构建的部分。
    ok: capabilities.length >= requiredCapabilityCount(options) && capabilities.every(item => item.result.ok),
    capabilities,
    diagnostics,
  }
}

/** 全量构建要求全部 Capability；memberFilters 裁剪后至少要有一个参与构建。 */
function requiredCapabilityCount (options: IndustryCapabilityWorkspaceBuildOptions): number {
  if (options.memberFilters === undefined) return options.workspace.capabilities.length
  return 1
}

/** 成员过滤 → buildCapability 的侧别过滤参数。 */
function sideFiltersOf (filter: IndustryCapabilityWorkspaceMemberFilter): {
  readonly frontendFilter: ReadonlySet<string>;
  readonly backendFilter: ReadonlySet<string>;
} {
  return { frontendFilter: filter.frontend, backendFilter: filter.backend }
}

async function buildCapabilityUnlocked (options: CapabilityBuildOptions): Promise<CapabilityBuildResult> {
  if (options.watch === true) {
    throw new CapabilityError(
      'FH2_CAPABILITY_BUILD_WATCH_UNSUPPORTED',
      '调用 buildCapability() 时不支持 watch；请使用 watchCapability()。',
    )
  }
  const frontend = selectProjects(options.capability.frontend, options.frontendFilter, 'frontend')
  const backend = selectProjects(options.capability.backend, options.backendFilter, 'backend')
  const selectedCapability: CapabilityProject = {
    ...options.capability,
    frontend,
    backend,
  }
  const fullBuild = frontend.length === options.capability.frontend.length
    && backend.length === options.capability.backend.length
  const pending: PendingBuild[] = []
  const diagnostics: BuildDiagnostic[] = []
  let reportCandidate: BuildReportCandidate | undefined
  let metadataDigest: string | undefined
  let packageManifestDigest: string | undefined
  try {
    throwIfAborted(options.abortSignal)
    assertCapabilitySourceRoots(selectedCapability)
    removeBuildReport(options.capability.root)
    const validation = (options.validate ?? validateCapability)(selectedCapability)
    if (!validation.ok) {
      return {
        ok: false,
        diagnostics: validation.diagnostics.map(diagnostic => ({
          code: diagnostic.code,
          phase: BUILD_PHASES.validate,
          ...(diagnostic.file === undefined ? {} : { file: diagnostic.file }),
          message: `[${diagnostic.side}${diagnostic.pluginId === undefined ? '' : ` ${diagnostic.pluginId}`}] ${diagnostic.message}`,
        })),
      }
    }
    if (fullBuild) {
      metadataDigest = digestFile(options.capability.metadataPath)
      packageManifestDigest = readPackageManifestDigest(options.capability)
    }
    for (const project of frontend) {
      throwIfAborted(options.abortSignal)
      const result = await buildFrontendProject(project, options)
      pending.push(result)
    }
    for (const project of backend) {
      throwIfAborted(options.abortSignal)
      const sourceDigestBefore = digestSourceDirectory(project.root)
      const result = await (options.buildBackend ?? buildBackendPlugin)(project.root, { commit: false })
      pending.push(pendingBackendBuild(result, project.root, sourceDigestBefore))
      emit(options, {
        side: 'backend',
        pluginId: project.id,
        type: 'success',
        diagnostics: result.diagnostics,
      })
      diagnostics.push(...result.diagnostics)
    }
    throwIfAborted(options.abortSignal)
    assertCapabilityValid(selectedCapability, options.validate)
    if (metadataDigest !== undefined) assertMetadataUnchanged(options.capability, metadataDigest)
    if (packageManifestDigest !== undefined) assertPackageManifestUnchanged(options.capability, packageManifestDigest)
    const report = fullBuild
      ? createBuildReport(options.capability, pending, true, options.frontendConfigPath, metadataDigest!, packageManifestDigest)
      : undefined
    if (report !== undefined) reportCandidate = (options.createReportCandidate ?? createBuildReportCandidate)(options.capability.root, report)
    if (metadataDigest !== undefined) assertMetadataUnchanged(options.capability, metadataDigest)
    if (packageManifestDigest !== undefined) assertPackageManifestUnchanged(options.capability, packageManifestDigest)
    diagnostics.push(...commitPendingBuilds(pending, reportCandidate))
    reportCandidate = undefined
    return { ok: true, diagnostics, ...(report === undefined ? {} : { report }) }
  } catch (error) {
    const failure = asBuildError(error)
    diagnostics.push(...failure.diagnostics)
    cleanupPendingBuilds(pending, diagnostics)
    if (reportCandidate !== undefined) discardBuildReportCandidate(reportCandidate)
    return { ok: false, diagnostics }
  }
}

export async function watchCapability (options: CapabilityBuildOptions): Promise<CapabilityBuildWatchSession> {
  const releaseOperationLock = options.operationLockHeld ? () => {} : acquireCapabilityLock(options.capability.root)
  try {
    return await watchCapabilityLocked(options, releaseOperationLock)
  } catch (error) {
    releaseOperationLock()
    throw error
  }
}

async function watchCapabilityLocked (
  options: CapabilityBuildOptions,
  releaseOperationLock: () => void,
): Promise<CapabilityBuildWatchSession> {
  const frontend = selectProjects(options.capability.frontend, options.frontendFilter, 'frontend')
  const backend = selectProjects(options.capability.backend, options.backendFilter, 'backend')
  const selectedCapability: CapabilityProject = {
    ...options.capability,
    frontend,
    backend,
  }
  // Independent watchers cannot prove every source tree still matches its dist.
  removeBuildReport(options.capability.root)
  let operationLockReleased = false
  const releaseOperationLockOnce = (): void => {
    if (operationLockReleased) return
    operationLockReleased = true
    releaseOperationLock()
  }
  const sessions: PluginBuildSession[] = []
  const watchers: CapabilityBackendWatcher[] = []
  const done = deferred<
    | { readonly reason: 'closed' }
    | { readonly reason: 'fatal'; readonly diagnostics: readonly BuildDiagnostic[] }
  >()
  let closed = false
  let shutdownPromise: Promise<void> | undefined
  let onAbort: (() => void) | undefined
  const backendRuns = new Map<string, { running: boolean; queued: boolean; done?: Promise<void> }>()

  async function shutdown (
    terminal: { readonly reason: 'closed' } | { readonly reason: 'fatal'; readonly diagnostics: readonly BuildDiagnostic[] },
  ): Promise<void> {
    if (shutdownPromise !== undefined) return shutdownPromise
    closed = true
    if (onAbort !== undefined) options.abortSignal?.removeEventListener('abort', onAbort)
    shutdownPromise = (async () => {
      try {
        const cleanup = await Promise.allSettled([
          ...sessions.map(session => session.close()),
          ...watchers.map(watcher => watcher.close()),
        ])
        const cleanupDiagnostics: BuildDiagnostic[] = cleanup.flatMap(result => result.status === 'rejected'
          ? [{
              code: 'FH2_CAPABILITY_BUILD_WATCH_CLOSE_FAILED',
              phase: 'commit' as const,
              message: `关闭 Capability Watch 资源失败：${message(result.reason)}`,
            }]
          : [])
        if (terminal.reason === 'fatal') {
          done.resolve({
            reason: 'fatal',
            diagnostics: [...terminal.diagnostics, ...cleanupDiagnostics],
          })
        } else if (cleanupDiagnostics.length > 0) {
          done.resolve({ reason: 'fatal', diagnostics: cleanupDiagnostics })
        } else {
          done.resolve(terminal)
        }
      } finally {
        releaseOperationLockOnce()
      }
    })()
    return shutdownPromise
  }
  function finishFatal (diagnostics: readonly BuildDiagnostic[]): void {
    if (closed) return
    void shutdown({ reason: 'fatal', diagnostics })
  }
  onAbort = () => finishFatal([{
    code: 'FH2_CAPABILITY_BUILD_ABORTED',
    phase: 'config',
    message: 'Capability Watch 已被终止。',
  }])
  options.abortSignal?.addEventListener('abort', onAbort, { once: true })
  if (options.abortSignal?.aborted) onAbort()
  const runBackend = (project: BackendPluginProject): Promise<void> => {
    const state = backendRuns.get(project.id) ?? { running: false, queued: false }
    state.queued = true
    backendRuns.set(project.id, state)
    if (state.running) return state.done ?? Promise.resolve()
    state.running = true
    state.done = (async () => {
      while (state.queued) {
        if (closed) break
        state.queued = false
        try {
          const validation = (options.validate ?? validateCapability)(selectedCapability)
          if (!validation.ok) {
            emit(options, {
              side: 'backend',
              pluginId: project.id,
              type: 'failure',
              diagnostics: validation.diagnostics.map(diagnostic => ({
                code: diagnostic.code,
                phase: 'config' as const,
                ...(diagnostic.file === undefined ? {} : { file: diagnostic.file }),
                message: diagnostic.message,
              })),
            })
            continue
          }
          const result = await (options.buildBackend ?? buildBackendPlugin)(project.root)
          emit(options, { side: 'backend', pluginId: project.id, type: 'success', diagnostics: result.diagnostics })
        } catch (error) {
          const failure = asBuildError(error)
          emit(options, { side: 'backend', pluginId: project.id, type: 'failure', diagnostics: failure.diagnostics })
        }
      }
      state.running = false
    })()
    return state.done
  }

  // Watch 启动阶段的后端首次构建：失败视为致命错误（区别于稳态期只上报失败）。
  const initialBackendBuild = async (project: BackendPluginProject): Promise<void> => {
    try {
      const result = await (options.buildBackend ?? buildBackendPlugin)(project.root)
      emit(options, { side: 'backend', pluginId: project.id, type: 'success', diagnostics: result.diagnostics })
    } catch (error) {
      finishFatal(asBuildError(error).diagnostics)
      throw error
    }
  }

  try {
    throwIfAborted(options.abortSignal)
    assertCapabilityValid(selectedCapability, options.validate)
    for (const project of backend) {
      const watcher = (options.createBackendWatcher ?? createBackendWatcher)(
        project.root,
        () => runBackend(project),
        error => finishFatal([{
          code: 'FH2_CAPABILITY_BUILD_WATCH_FAILED',
          phase: 'config',
          message: `监听后端插件 ${project.id} 失败：${message(error)}`,
        }]),
      )
      watchers.push(watcher)
      if (closed) await watcher.close()
    }
    if (closed) {
      await shutdown({ reason: 'closed' })
      throw new PluginBuildError([{
        code: 'FH2_CAPABILITY_BUILD_WATCH_FAILED',
        phase: 'config',
        message: 'Capability Watch 在初始化期间已终止。',
      }])
    }
    await Promise.all(backend.map(initialBackendBuild))
    for (const project of frontend) {
      if (closed) break
      const session = await (options.createFrontendRunner ?? createPluginBuildRunner)({
        cwd: project.root,
        expectedManifestPath: project.manifestPath,
        ...(options.frontendConfigPath === undefined ? {} : { configPath: options.frontendConfigPath }),
        includeBackend: false,
        watch: true,
        beforeCommit: () => assertCapabilityValid(selectedCapability, options.validate),
        onEvent: (event) => {
          const type = event.type === 'success' ? 'success' : 'failure'
          emit(options, { side: 'frontend', pluginId: project.id, type, diagnostics: event.diagnostics })
        },
      })
      sessions.push(session)
      if (closed) {
        await session.close()
        break
      }
      void session.done.then((terminal) => {
        if (terminal.reason === 'fatal') finishFatal(terminal.diagnostics)
      }, (error: unknown) => finishFatal(asBuildError(error).diagnostics))
    }
    if (closed) {
      await shutdown({ reason: 'closed' })
      throw new PluginBuildError([{
        code: 'FH2_CAPABILITY_BUILD_WATCH_FAILED',
        phase: 'config',
        message: 'Capability Watch 在初始化期间已终止。',
      }])
    }
    await Promise.all(sessions.map(session => session.firstBuild))
    if (closed) {
      await shutdown({ reason: 'closed' })
      throw new PluginBuildError([{
        code: 'FH2_CAPABILITY_BUILD_WATCH_FAILED',
        phase: 'config',
        message: 'Capability Watch 在初始化期间已终止。',
      }])
    }
  } catch (error) {
    await shutdown({ reason: 'closed' })
    throw asBuildError(error)
  }

  return {
    firstBuild: Promise.resolve(),
    done: done.promise,
    close: () => shutdown({ reason: 'closed' }),
  }
}

function createBackendWatcher (
  root: string,
  onChange: () => void,
  onError: (error: unknown) => void,
): CapabilityBackendWatcher {
  const watcher = watchFiles(root, {
    ignoreInitial: true,
    ignored: (path: string) => isBackendWatchIgnored(path),
  })
  watcher.on('all', onChange)
  watcher.on('error', onError)
  return { close: async () => await watcher.close() }
}

export function isBackendWatchIgnored (path: string): boolean {
  return path.replaceAll('\\', '/').split('/').some(segment =>
    segment === PROJECT_PATHS.dist || segment.startsWith(BACKEND_WATCH_TRANSACTION_PREFIX),
  )
}

async function buildFrontendProject (
  project: FrontendPluginProject,
  options: CapabilityBuildOptions,
): Promise<PendingBuild> {
  const sourceDigestBefore = digestSourceDirectory(project.root)
  let candidateRoot: string | undefined
  let distManifestVersion: string | undefined
  let sourceDigest: string | undefined
  let hasExternalSourceDependencies = false
  let hasExternalConfigDependencies = false
  const onEvent = (event: PluginBuildEvent): void => {
    const diagnostics = event.diagnostics
    if (event.type === 'success') {
      candidateRoot = event.candidateRoot
      distManifestVersion = event.distManifest?.version
      sourceDigest = digestSourceDirectory(project.root)
      hasExternalSourceDependencies = hasExternalDependencies(project.root, event.watchDependencies ?? [])
      hasExternalConfigDependencies = hasExternalConfigDependenciesFor(project.root, event.configPath)
      emit(options, { side: 'frontend', pluginId: project.id, type: 'success', diagnostics })
    } else {
      emit(options, { side: 'frontend', pluginId: project.id, type: 'failure', diagnostics })
    }
  }
  const session = await (options.createFrontendRunner ?? createPluginBuildRunner)({
    cwd: project.root,
    expectedManifestPath: project.manifestPath,
    ...(options.frontendConfigPath === undefined ? {} : { configPath: options.frontendConfigPath }),
    includeBackend: false,
    deferCommit: true,
    watch: false,
    onEvent,
  })
  const abort = (): void => {
    void session.close()
  }
  options.abortSignal?.addEventListener('abort', abort, { once: true })
  try {
    await session.firstBuild
    const terminal = await session.done
    if (terminal.reason === 'fatal') throw new PluginBuildError(terminal.diagnostics)
  } finally {
    options.abortSignal?.removeEventListener('abort', abort)
    await session.close().catch(() => undefined)
  }
  if (candidateRoot === undefined || distManifestVersion === undefined || sourceDigest === undefined) {
    throw new PluginBuildError([{
      code: 'FH2_CAPABILITY_BUILD_FAILED',
      phase: 'commit',
      file: project.root,
      message: `前端插件 ${project.id} 未返回可提交的候选产物。`,
    }])
  }
  return {
    side: 'frontend',
    pluginId: project.id,
    version: distManifestVersion,
    candidateRoot,
    distRoot: join(project.root, PROJECT_PATHS.dist),
    sourceRoot: project.root,
    sourceDigest,
    hasExternalSourceDependencies,
    hasExternalConfigDependencies,
    sourceChangedDuringBuild: sourceDigestBefore !== sourceDigest,
  }
}

function throwIfAborted (signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CapabilityError('FH2_CAPABILITY_BUILD_ABORTED', 'Capability Build 已被终止。')
  }
}

function pendingBackendBuild (
  result: BackendPluginBuildResult,
  sourceRoot: string,
  sourceDigestBefore: string,
): PendingBuild {
  if (result.candidateRoot === undefined) {
    throw new PluginBuildError([{
      code: 'FH2_CAPABILITY_BUILD_FAILED',
      phase: 'commit',
      file: result.distRoot,
      message: `后端插件 ${result.pluginId} 未返回可提交的候选产物。`,
    }])
  }
  return {
    side: 'backend',
    pluginId: result.pluginId,
    version: result.version,
    candidateRoot: result.candidateRoot,
    distRoot: result.distRoot,
    sourceRoot,
    sourceDigest: digestSourceDirectory(sourceRoot),
    hasExternalSourceDependencies: hasExternalDependencies(sourceRoot, result.watchDependencies),
    hasExternalConfigDependencies: false,
    sourceChangedDuringBuild: sourceDigestBefore !== digestSourceDirectory(sourceRoot),
  }
}

function selectProjects<T extends { readonly id: string }> (
  projects: readonly T[],
  filter: ReadonlySet<string> | undefined,
  side: 'frontend' | 'backend',
): readonly T[] {
  // filter 未传 = 全量；显式传空集 = 跳过该侧（build --frontend/--backend 的对称语义）。
  if (filter === undefined) return projects
  const known = new Set(projects.map(project => project.id))
  for (const id of filter) {
    if (!known.has(id)) {
      throw new CapabilityError(
        'FH2_CAPABILITY_PLUGIN_DISCOVERY_FAILED',
        `Capability 内不存在 ${side} 插件 ${id}。`,
      )
    }
  }
  return selectBuildProjects(projects, filter)
}

function commitPendingBuilds (
  pending: readonly PendingBuild[],
  reportCandidate: BuildReportCandidate | undefined,
): readonly BuildDiagnostic[] {
  const promotions: PendingPromotion[] = [
    ...pending.map(build => ({
      label: `${build.side} ${build.pluginId}`,
      candidatePath: build.candidateRoot,
      targetPath: build.distRoot,
    })),
    ...(reportCandidate === undefined
      ? []
      : [{
          label: 'build report',
          candidatePath: reportCandidate.candidatePath,
          targetPath: reportCandidate.reportPath,
        }]),
  ]
  const committed: PromotionRecord[] = []
  try {
    for (const promotion of promotions) {
      const backupRoot = join(dirname(promotion.targetPath), `.${basename(promotion.targetPath)}.fh2-capability-backup-${randomUUID()}`)
      const record: PromotionRecord = {
        promotion,
        ...(existsSync(promotion.targetPath) ? { backupRoot } : {}),
      }
      if (record.backupRoot !== undefined) {
        renameSync(promotion.targetPath, record.backupRoot)
        committed.push(record)
      }
      try {
        renameSync(promotion.candidatePath, promotion.targetPath)
      } catch {
        if (record.backupRoot === undefined) committed.push(record)
        throw new Error(`提交 ${promotion.label} 失败。`)
      }
      if (record.backupRoot === undefined) committed.push(record)
    }
  } catch (error) {
    const rollbackErrors: string[] = []
    for (const { promotion, backupRoot } of [...committed].reverse()) {
      try {
        rmSync(promotion.targetPath, { recursive: true, force: true })
        if (backupRoot !== undefined && existsSync(backupRoot)) renameSync(backupRoot, promotion.targetPath)
      } catch (rollbackError) {
        rollbackErrors.push(`${promotion.label}：${message(rollbackError)}`)
      }
    }
    throw new PluginBuildError([{
      code: 'FH2_CAPABILITY_BUILD_FAILED',
      phase: 'commit',
      message: rollbackErrors.length === 0
        ? `Capability 候选产物提交失败，已回滚已提交的插件：${message(error)}`
        : `Capability 候选产物提交失败，回滚不完整：${rollbackErrors.join('；')}`,
    }])
  }

  const diagnostics: BuildDiagnostic[] = []
  for (const { backupRoot, promotion } of committed) {
    if (backupRoot === undefined) continue
    try {
      rmSync(backupRoot, { recursive: true, force: true })
    } catch (error) {
      diagnostics.push({
        code: 'FH2_DIST_BACKUP_CLEANUP_FAILED',
        phase: 'commit',
        file: backupRoot,
        message: `Capability ${promotion.label} 新产物已提交，但旧制品备份清理失败：${message(error)}`,
      })
    }
  }
  return diagnostics
}

function cleanupPendingBuilds (pending: readonly PendingBuild[], diagnostics: BuildDiagnostic[]): void {
  for (const build of pending) {
    try {
      rmSync(build.candidateRoot, { recursive: true, force: true })
    } catch (error) {
      diagnostics.push({
        code: 'FH2_CANDIDATE_CLEANUP_FAILED',
        phase: 'commit',
        file: build.candidateRoot,
        message: `清理 Capability 候选产物失败：${message(error)}`,
      })
    }
  }
}

function createBuildReport (
  capability: CapabilityProject,
  pending: readonly PendingBuild[],
  useCandidates: boolean,
  frontendConfigPath: string | undefined,
  metadataDigest: string,
  packageManifestDigest?: string,
): BuildReport {
  const frontend: Record<string, BuildReportPluginEntry> = {}
  const backend: Record<string, BuildReportPluginEntry> = {}
  for (const build of pending) {
    const entry: BuildReportPluginEntry = {
      status: 'success',
      version: build.version,
      digest: digestBuildDirectory(useCandidates ? build.candidateRoot : build.distRoot),
      sourceDigest: build.sourceDigest,
      ...(build.hasExternalSourceDependencies ? { hasExternalSourceDependencies: true } : {}),
      ...(build.hasExternalConfigDependencies ? { hasExternalConfigDependencies: true } : {}),
      ...(build.sourceChangedDuringBuild ? { sourceChangedDuringBuild: true } : {}),
      ...(build.side === 'frontend' ? configReportFields(frontendConfigPath, build.sourceRoot) : {}),
    }
    if (build.side === 'frontend') frontend[build.pluginId] = entry
    else backend[build.pluginId] = entry
  }
  return Object.freeze({
    capabilityId: capability.capabilityId,
    metadataDigest,
    ...(packageManifestDigest === undefined ? {} : { packageManifestDigest }),
    frontend: Object.freeze(frontend),
    backend: Object.freeze(backend),
  })
}

/** packages.json（本地或父工作区派生）存在时校验并返回 digest；两处都没有返回 undefined（兼容旧工程）。 */
function readPackageManifestDigest (capability: CapabilityProject): string | undefined {
  try {
    return resolveCapabilityPackageManifest(capability.root, capability.capabilityId)?.digest
  } catch (error) {
    if (error instanceof PackageError) {
      throw new PluginBuildError([{
        code: error.code,
        phase: 'config',
        ...(error.file === undefined ? {} : { file: error.file }),
        message: error.message,
      }])
    }
    throw error
  }
}

function assertPackageManifestUnchanged (capability: CapabilityProject, expectedDigest: string): void {
  if (readPackageManifestDigest(capability) === expectedDigest) return
  throw new CapabilityError(
    'FH2_CAPABILITY_BUILD_INPUT_CHANGED',
    'Capability Build 期间 packages.json（本地或所属工作区）已变更，请重新构建。',
    packageManifestPath(capability.root),
  )
}

function assertMetadataUnchanged (capability: CapabilityProject, expectedDigest: string): void {
  if (digestFile(capability.metadataPath) === expectedDigest) return
  throw new CapabilityError(
    'FH2_CAPABILITY_BUILD_INPUT_CHANGED',
    'Capability Build 期间 capabilities.json 已变更，请重新构建。',
    capability.metadataPath,
  )
}

function hasExternalDependencies (sourceRoot: string, dependencies: readonly string[]): boolean {
  const root = realpathSync(sourceRoot)
  return dependencies.some((dependency) => {
    const resolved = resolve(dependency)
    if (isNodeModulePath(resolved)) return false
    if (!existsSync(resolved)) return !isContained(root, resolved)
    if (lstatSync(resolved).isSymbolicLink()) return true
    const realDependency = realpathSync(resolved)
    if (statSync(realDependency).isDirectory() && isContained(realDependency, root)) return false
    return !isNodeModulePath(realDependency) && !isContained(root, realDependency)
  })
}

function hasExternalConfigDependenciesFor (sourceRoot: string, configPath: string | undefined): boolean {
  if (configPath === undefined) return false
  const root = realpathSync(sourceRoot)
  const visited = new Set<string>()
  const visit = (path: string): boolean => {
    if (!existsSync(path)) return true
    const realPath = realpathSync(path)
    if (!isContained(root, realPath) || !statSync(realPath).isFile()) return true
    if (visited.has(realPath)) return false
    visited.add(realPath)
    const source = readFileSync(realPath, 'utf8')
    if (/\b(?:import|require)\s*\(\s*(?!['"])/.test(source)) return true
    for (const specifier of configImportSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue
      const dependency = resolveConfigImport(realPath, specifier)
      if (dependency === undefined || visit(dependency)) return true
    }
    return false
  }
  return visit(configPath)
}

function configImportSpecifiers (source: string): readonly string[] {
  const specifiers: string[] = []
  const pattern = /(?:\b(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?|\brequire\s*\(|\bimport\s*\()(['"])([^'"]+)\1/g
  for (const match of source.matchAll(pattern)) specifiers.push(match[2]!)
  return specifiers
}

function resolveConfigImport (configPath: string, specifier: string): string | undefined {
  const candidate = resolve(dirname(configPath), specifier)
  const extensionless = candidate.slice(0, candidate.lastIndexOf('.'))
  const candidates = [
    candidate,
    ...CONFIG_EXTENSIONS.map(extension => `${candidate}${extension}`),
    ...CONFIG_EXTENSIONS.map(extension => `${extensionless}${extension}`),
    ...CONFIG_EXTENSIONS.map(extension => join(candidate, `index${extension}`)),
  ]
  return candidates.find(path => existsSync(path) && statSync(path).isFile())
}

function assertCapabilitySourceRoots (capability: CapabilityProject): void {
  const root = realpathSync(capability.root)
  for (const project of [...capability.frontend, ...capability.backend]) {
    if (!isContained(root, realpathSync(project.root))) {
      throw new CapabilityError(
        'FH2_CAPABILITY_PLUGIN_DISCOVERY_FAILED',
        `Capability 插件源码根越过 Capability 目录：${project.root}。`,
        project.root,
      )
    }
  }
}

function isNodeModulePath (path: string): boolean {
  return path.split(sep).includes('node_modules')
}

function isContained (root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

function configReportFields (
  configPath: string | undefined,
  projectRoot: string,
): Pick<BuildReportPluginEntry, 'configPath' | 'configDigest'> {
  if (configPath === undefined) return {}
  const resolvedPath = resolve(projectRoot, configPath)
  return {
    configPath: resolvedPath,
    configDigest: digestFile(resolvedPath),
  }
}

interface PendingPromotion {
  readonly label: string;
  readonly candidatePath: string;
  readonly targetPath: string;
}

interface PromotionRecord {
  readonly promotion: PendingPromotion;
  readonly backupRoot?: string;
}

function asBuildError (error: unknown): PluginBuildError {
  if (error instanceof PluginBuildError) return error
  if (error instanceof CapabilityError) {
    return new PluginBuildError([{
      code: error.code,
      phase: 'config',
      ...(error.file === undefined ? {} : { file: error.file }),
      message: error.message,
    }])
  }
  return new PluginBuildError([{
    code: 'FH2_CAPABILITY_BUILD_FAILED',
    phase: 'commit',
    message: message(error),
  }])
}

function assertCapabilityValid (
  capability: CapabilityProject,
  validate: CapabilityBuildOptions['validate'],
): void {
  const result = (validate ?? validateCapability)(capability)
  if (result.ok) return
  throw new PluginBuildError(result.diagnostics.map(diagnostic => ({
    code: diagnostic.code,
    phase: 'config' as const,
    ...(diagnostic.file === undefined ? {} : { file: diagnostic.file }),
    message: `[${diagnostic.side}${diagnostic.pluginId === undefined ? '' : ` ${diagnostic.pluginId}`}] ${diagnostic.message}`,
  })))
}

function emit (options: CapabilityBuildOptions, event: CapabilityBuildEvent): void {
  try {
    options.onPluginEvent?.(event)
  } catch {
    // Observer failures must not interrupt build ownership.
  }
}

function emitWorkspaceBuild (
  options: IndustryCapabilityWorkspaceBuildOptions,
  event: IndustryCapabilityWorkspaceBuildEvent,
): void {
  try {
    options.onCapabilityEvent?.(event)
  } catch {
    // Observer failures must not interrupt build ownership.
  }
}

function deferred<T> (): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolvePromiseValue) => {
    resolvePromise = resolvePromiseValue
  })
  return { promise, resolve: resolvePromise }
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
