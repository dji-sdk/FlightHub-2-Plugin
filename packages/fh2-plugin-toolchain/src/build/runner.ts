// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, writeFileSync } from 'node:fs'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { createRsbuild, loadConfig } from '@rsbuild/core'
import type { RsbuildConfig, RsbuildPlugin, Rspack } from '@rsbuild/core'
import { watch as watchFiles } from 'chokidar'
import type { ChokidarOptions } from 'chokidar'
import { generatePluginTypes } from 'fh2-plugin-sdk/generator'
import type { PluginManifest } from 'fh2-plugin-sdk'
import { writeGeneratedTypes } from '../generate/write-generated-types.js'
import { TOOLCHAIN_VERSION, buildDistManifest } from '../manifest.js'
import {
  clearFh2PluginExecutionContext,
  getFh2PluginRawDescriptor,
  setFh2PluginExecutionContext,
} from '../rsbuild/context.js'
import type { Fh2PluginExecutionContext } from '../rsbuild/context.js'
import { backendManifestPath, buildBackendAssets } from '../backend/manifest.js'
import { validateSourceManifestSnapshot } from '../validate/index.js'
import type { SourceManifestSnapshot } from '../validate/index.js'
import {
  checkSourceCodeConsistency,
  isBlockingCodeConsistencyDiagnostic,
} from '../validate/code-consistency.js'
import { PROJECT_PATHS } from '../project-policy.js'
import { collectBuildProducts, compileFailureFromStats } from './products.js'
import { isPathInside, resolveBuildDescriptor, resolveSourceEntries } from './paths.js'
import type { ResolvedBuildDescriptor } from './paths.js'
import {
  commitCandidateDirectory,
  createCandidateDirectory,
  removeCandidateDirectory,
} from './transaction.js'
import { PluginBuildError, buildError } from './types.js'
import type {
  BuildDiagnostic,
  PluginBuildEvent,
  PluginBuildRunnerOptions,
  PluginBuildSession,
} from './types.js'
import { verifyDist } from './verify.js'
import { BUILD_PHASES, FRONTEND_BACKEND_WATCH_DIRECTORIES, FRONTEND_WATCH_DIRECTORIES, INFRASTRUCTURE_FAILURE_CODES, distTransactionPrefix } from './policy.js'

interface PreparedBuild {
  readonly config: RsbuildConfig;
  readonly configPath?: string;
  readonly adapter: RsbuildPlugin;
  readonly descriptor: ResolvedBuildDescriptor;
  readonly includeBackend?: boolean;
  readonly deferCommit?: boolean;
  readonly beforeCommit?: () => void | Promise<void>;
}

interface BuildRoundResult {
  readonly manifest: PluginManifest;
  readonly diagnostics: readonly BuildDiagnostic[];
  readonly watchDependencies: readonly string[];
  readonly candidateRoot?: string;
}

interface WatcherLike {
  on(event: 'all', listener: () => void): WatcherLike;
  on(event: 'error', listener: (error: unknown) => void): WatcherLike;
  on(event: 'ready', listener: () => void): WatcherLike;
  off(event: 'ready', listener: () => void): WatcherLike;
  add(paths: string | string[]): WatcherLike;
  close: () => Promise<void>;
}

export interface BuildRunnerDependencies {
  readonly loadConfig: typeof loadConfig;
  readonly createRsbuild: typeof createRsbuild;
  readonly watch: (paths: string | string[], options: ChokidarOptions) => WatcherLike;
  readonly executeRound: (
    prepared: PreparedBuild,
    buildId: number,
    dependencies: BuildRunnerDependencies,
  ) => Promise<BuildRoundResult>;
  readonly validate: typeof validateSourceManifestSnapshot;
  readonly generate: typeof writeGeneratedTypes;
}

const DEFAULT_DEPENDENCIES: BuildRunnerDependencies = {
  loadConfig,
  createRsbuild,
  watch: (paths, options) => watchFiles(paths, options) as unknown as WatcherLike,
  executeRound: executeBuildRound,
  validate: validateSourceManifestSnapshot,
  generate: writeGeneratedTypes,
}

export async function createPluginBuildRunner (
  options: PluginBuildRunnerOptions,
): Promise<PluginBuildSession> {
  return createPluginBuildRunnerWithDependencies(options, DEFAULT_DEPENDENCIES)
}

export async function resolvePluginBuildDescriptor (options: {
  readonly cwd: string;
  readonly configPath?: string;
  readonly expectedManifestPath?: string;
}): Promise<ResolvedBuildDescriptor> {
  const prepared = await prepareBuild({ ...options, watch: false }, DEFAULT_DEPENDENCIES)
  return prepared.descriptor
}

export async function createPluginBuildRunnerWithDependencies (
  options: PluginBuildRunnerOptions,
  dependencies: BuildRunnerDependencies,
): Promise<PluginBuildSession> {
  const first = deferred<void>()
  const done = deferred<
    | { readonly reason: 'closed' }
    | { readonly reason: 'fatal'; readonly diagnostics: readonly BuildDiagnostic[] }
  >()
  let firstSettled = false
  let terminal = false
  let terminalClaim: 'closed' | 'fatal' | undefined
  let closing = false
  let buildId = 0
  let queued = false
  let active: Promise<void> | undefined
  let watcher: WatcherLike | undefined
  let cancelWatcherReady: (() => void) | undefined
  let closePromise: Promise<void> | undefined
  let prepared: PreparedBuild | undefined

  const settleFirst = (error?: PluginBuildError): void => {
    if (firstSettled) return
    firstSettled = true
    if (error === undefined) first.resolve()
    else first.reject(error)
  }
  const claimTerminal = (reason: 'closed' | 'fatal'): boolean => {
    if (terminalClaim === undefined) terminalClaim = reason
    return terminalClaim === reason
  }
  const finishClosed = (): void => {
    if (terminal || !claimTerminal('closed')) return
    terminal = true
    done.resolve({ reason: 'closed' })
  }
  const finishFatal = (diagnostics: readonly BuildDiagnostic[]): void => {
    if (terminal || !claimTerminal('fatal')) return
    terminal = true
    const error = new PluginBuildError(diagnostics)
    settleFirst(error)
    emit(options, { type: 'fatal', buildId: Math.max(1, buildId), diagnostics })
    done.resolve({ reason: 'fatal', diagnostics })
  }
  const closeWatcher = async (): Promise<void> => {
    cancelWatcherReady?.()
    cancelWatcherReady = undefined
    const current = watcher
    watcher = undefined
    if (current !== undefined) await current.close()
  }
  const addWatchDependencies = (paths: readonly string[]): void => {
    if (!options.watch || watcher === undefined) return
    const dependenciesToWatch = paths.filter(path => !isIgnoredWatchPath(path, prepared!.descriptor))
    if (dependenciesToWatch.length === 0) return
    try {
      watcher.add(dependenciesToWatch)
    } catch (error) {
      throw buildError('compile', 'FH2_BUILD_WATCH_DEPENDENCY_ADD_FAILED', error)
    }
  }

  const runOne = async (): Promise<void> => {
    if (prepared === undefined || closing) return
    buildId += 1
    try {
      const result = await dependencies.executeRound(prepared, buildId, dependencies)
      if (closing) return
      addWatchDependencies(result.watchDependencies)
      emit(options, {
        type: 'success',
        buildId,
        diagnostics: result.diagnostics,
        distManifest: result.manifest,
        watchDependencies: result.watchDependencies,
        ...(prepared.configPath === undefined ? {} : { configPath: prepared.configPath }),
        ...(result.candidateRoot === undefined ? {} : { candidateRoot: result.candidateRoot }),
      })
      settleFirst()
    } catch (error) {
      let failure = asBuildError(error, 'compile', 'FH2_BUILD_ROUND_FAILED')
      if (firstSettled && !isInfrastructureFailure(failure)) {
        try {
          addWatchDependencies(failure.watchDependencies)
        } catch (watchError) {
          failure = asBuildError(watchError, 'compile', 'FH2_BUILD_WATCH_DEPENDENCY_ADD_FAILED')
        }
      }
      if (firstSettled && isInfrastructureFailure(failure)) {
        if (!claimTerminal('fatal')) return
        closing = true
        let diagnostics = failure.diagnostics
        try {
          await closeWatcher()
        } catch (closeError) {
          diagnostics = [...diagnostics, {
            code: 'FH2_BUILD_WATCHER_CLOSE_FAILED',
            phase: 'config',
            message: `关闭构建监督 watcher 失败：${message(closeError)}`,
          }]
        }
        finishFatal(diagnostics)
        return
      }
      if (!firstSettled) {
        if (!claimTerminal('closed')) return
        closing = true
        let diagnostics = failure.diagnostics
        try {
          await closeWatcher()
        } catch (closeError) {
          diagnostics = [...diagnostics, watcherCloseDiagnostic(closeError)]
        }
        const terminalFailure = new PluginBuildError(diagnostics, failure.watchDependencies)
        emit(options, { type: 'failure', buildId, diagnostics })
        settleFirst(terminalFailure)
        finishClosed()
        return
      }
      emit(options, { type: 'failure', buildId, diagnostics: failure.diagnostics })
    }
  }

  const drain = async (): Promise<void> => {
    while (queued) {
      if (closing) break
      queued = false
      await runOne()
    }
    if (!options.watch && !terminal) {
      claimTerminal('closed')
      closing = true
      finishClosed()
    }
  }

  const schedule = (): void => {
    if (closing || terminal) return
    queued = true
    if (active !== undefined) return
    active = drain().finally(() => {
      active = undefined
      if (queued && !closing) schedule()
    })
  }

  const fatalWatcher = (error: unknown): void => {
    if (closing || terminal || !claimTerminal('fatal')) return
    closing = true
    const initialDiagnostics: readonly BuildDiagnostic[] = [{
      code: 'FH2_BUILD_WATCHER_FATAL',
      phase: 'config',
      message: `构建监督 watcher 失败：${message(error)}`,
    }]
    void (async () => {
      let diagnostics = initialDiagnostics
      try {
        await closeWatcher()
      } catch (closeError) {
        diagnostics = [...diagnostics, watcherCloseDiagnostic(closeError)]
      }
      try {
        await active
      } catch (activeError) {
        diagnostics = [...diagnostics, {
          code: 'FH2_BUILD_ACTIVE_ROUND_FAILED',
          phase: 'compile',
          message: `等待在途构建轮次失败：${message(activeError)}`,
        }]
      }
      finishFatal(diagnostics)
    })()
  }

  let initialization: Promise<void>
  const performExplicitClose = async (): Promise<void> => {
    let closeError: unknown
    try {
      await closeWatcher()
    } catch (error) {
      closeError = error
    }
    try {
      await initialization
      await active
    } catch (error) {
      closeError ??= error
    }
    settleFirst(new PluginBuildError([{
      code: 'FH2_BUILD_CLOSED_BEFORE_FIRST_BUILD',
      phase: 'config',
      message: 'Build Session 在首轮构建完成前已关闭。',
    }]))
    finishClosed()
    if (closeError !== undefined) throw closeError
  }
  const session: PluginBuildSession = {
    firstBuild: first.promise,
    done: done.promise,
    close () {
      if (closePromise !== undefined) return closePromise
      if (terminalClaim !== undefined) {
        closePromise = done.promise.then(() => undefined)
        return closePromise
      }
      claimTerminal('closed')
      closing = true
      queued = false
      closePromise = performExplicitClose()
      return closePromise
    },
  }

  initialization = (async () => {
    try {
      prepared = await prepareBuild(options, dependencies)
      if (closing) return
      if (options.watch) {
        watcher = dependencies.watch(
          [
            prepared.descriptor.manifestPath,
            prepared.descriptor.pluginEntry,
            ...FRONTEND_WATCH_DIRECTORIES.map(directory => resolve(prepared!.descriptor.projectRoot, directory)),
            ...(prepared.includeBackend
              ? FRONTEND_BACKEND_WATCH_DIRECTORIES.map(directory => resolve(prepared!.descriptor.projectRoot, directory))
              : []),
          ],
          {
            ignoreInitial: true,
            followSymlinks: false,
            ignored: (path: string) => isIgnoredWatchPath(path, prepared!.descriptor),
          },
        )
        watcher.on('all', () => schedule())
        watcher.on('error', fatalWatcher)
        const readyWait = waitForWatcherReady(watcher)
        cancelWatcherReady = readyWait.cancel
        const ready = await readyWait.promise
        cancelWatcherReady = undefined
        if (!ready || closing) return
      }
      schedule()
    } catch (error) {
      if (terminal || closing) return
      const failure = asBuildError(error, 'config', 'FH2_BUILD_CONFIG_FAILED')
      if (!claimTerminal('closed')) return
      buildId = Math.max(1, buildId)
      closing = true
      let diagnostics = failure.diagnostics
      try {
        await closeWatcher()
      } catch (closeError) {
        diagnostics = [...diagnostics, watcherCloseDiagnostic(closeError)]
      }
      const terminalFailure = new PluginBuildError(diagnostics, failure.watchDependencies)
      emit(options, { type: 'failure', buildId, diagnostics })
      settleFirst(terminalFailure)
      finishClosed()
    }
  })()

  return session
}

async function prepareBuild (
  options: PluginBuildRunnerOptions,
  dependencies: BuildRunnerDependencies,
): Promise<PreparedBuild> {
  const cwd = resolve(options.cwd)
  let loaded: Awaited<ReturnType<typeof loadConfig>>
  try {
    loaded = await dependencies.loadConfig({
      cwd,
      ...(options.configPath === undefined ? {} : { path: resolve(cwd, options.configPath) }),
    })
  } catch (error) {
    throw buildError('config', 'FH2_RSBUILD_CONFIG_LOAD_FAILED', error)
  }
  const adapters = await findBrandedAdapters(loaded.content.plugins)
  if (adapters.length !== 1) {
    throw new PluginBuildError([{
      code: 'FH2_ADAPTER_COUNT_INVALID',
      phase: 'config',
      ...(loaded.filePath === null ? {} : { file: loaded.filePath }),
      message: `Rsbuild config 必须且只能注册一个 fh2Plugin() adapter，实际为 ${adapters.length} 个。`,
    }])
  }
  const adapter = adapters[0]!
  const rawDescriptor = getFh2PluginRawDescriptor(adapter)!
  const descriptor = resolveBuildDescriptor(cwd, rawDescriptor)
  if (options.expectedManifestPath !== undefined) {
    const expected = resolveBuildDescriptor(cwd, { manifestPath: options.expectedManifestPath }).manifestPath
    if (expected !== descriptor.manifestPath) {
      throw new PluginBuildError([{
        code: 'FH2_EXPECTED_MANIFEST_MISMATCH',
        phase: 'config',
        file: descriptor.manifestPath,
        message: `fh2Plugin() Manifest 与调用方期望的 Manifest 不一致：${expected}`,
      }])
    }
  }
  const includeBackend = options.includeBackend !== false && existsSync(backendManifestPath(descriptor.projectRoot))
  if (options.deferCommit === true && options.watch) {
    throw new PluginBuildError([{
      code: 'FH2_BUILD_DEFER_COMMIT_WATCH_UNSUPPORTED',
      phase: 'config',
      message: '延迟提交仅支持单次 Build，watch 模式必须由调用方单独编排。',
    }])
  }
  return Object.freeze({
    config: loaded.content,
    ...(loaded.filePath === null ? {} : { configPath: loaded.filePath }),
    adapter,
    descriptor,
    includeBackend,
    ...(options.deferCommit === true ? { deferCommit: true } : {}),
    ...(options.beforeCommit === undefined ? {} : { beforeCommit: options.beforeCommit }),
  })
}

export async function executeBuildRound (
  prepared: PreparedBuild,
  _buildId: number,
  dependencies: BuildRunnerDependencies,
): Promise<BuildRoundResult> {
  const snapshot = dependencies.validate({ manifestPath: prepared.descriptor.manifestPath })
  if (!snapshot.ok) throw validationFailure(snapshot)

  try {
    dependencies.generate({
      manifest: snapshot.manifest,
      generator: generatePluginTypes,
      manifestPath: prepared.descriptor.manifestPath,
      outDir: prepared.descriptor.typesOutDir,
    })
  } catch (error) {
    throw buildError(BUILD_PHASES.generate, 'FH2_GENERATE_FAILED', error, prepared.descriptor.typesOutDir)
  }
  const codeDiagnostics = checkSourceCodeConsistency({
    manifest: snapshot.manifest,
    manifestPath: prepared.descriptor.manifestPath,
    descriptor: prepared.descriptor,
  }).filter(isBlockingCodeConsistencyDiagnostic)
  if (codeDiagnostics.length > 0) {
    throw new PluginBuildError(codeDiagnostics.map(diagnostic => ({
      code: diagnostic.code,
      phase: BUILD_PHASES.generate,
      file: diagnostic.file,
      message: diagnostic.message,
      ...(diagnostic.hint === undefined ? {} : { hint: diagnostic.hint }),
    })))
  }
  const entries = resolveSourceEntries(prepared.descriptor, snapshot.manifest)
  const candidateRoot = createCandidateDirectory(prepared.descriptor.distRoot)
  const statsByEnvironment = new Map<string, Rspack.Stats>()
  const context: Fh2PluginExecutionContext = Object.freeze({
    candidateRoot,
    projectRoot: prepared.descriptor.projectRoot,
    manifest: snapshot.manifest,
    sdkContext: snapshot.sdkContext,
    entries,
    collect: (environment: string, stats: Rspack.Stats) => statsByEnvironment.set(environment, stats),
  })
  let buildResult: Awaited<ReturnType<Awaited<ReturnType<typeof createRsbuild>>['build']>> | undefined
  let buildResultCloseAttempted = false
  let outcome: BuildRoundResult | undefined
  let failure: unknown
  try {
    setFh2PluginExecutionContext(prepared.adapter, context)
    let rsbuild: Awaited<ReturnType<typeof createRsbuild>>
    try {
      rsbuild = await dependencies.createRsbuild({
        cwd: prepared.descriptor.projectRoot,
        callerName: 'fh2-plugin',
        rsbuildConfig: prepared.config,
      })
    } catch (error) {
      throw buildError('compile', 'FH2_RSBUILD_CREATE_FAILED', error)
    }
    try {
      buildResult = await rsbuild.build()
    } catch (error) {
      if (statsByEnvironment.size === 0)
        throw buildError('compile', 'FH2_RSBUILD_INFRASTRUCTURE_FAILED', error)
      throw compileFailureFromStats(statsByEnvironment, error)
    }

    const products = collectBuildProducts(statsByEnvironment, snapshot.manifest, entries)
    const distManifest = buildDistManifest({
      manifest: snapshot.manifest,
      pluginEntryFile: products.pluginEntryFile,
      viewAssets: products.views.map(view => ({
        viewId: view.viewId,
        jsFile: view.entryFile,
        cssFiles: view.cssFiles,
      })),
      sdkVersion: snapshot.sdkContext.projectSdkVersion,
      runtimeContract: snapshot.sdkContext.runtimeContract,
      toolchainVersion: TOOLCHAIN_VERSION,
    })
    writeFileSync(
      resolve(candidateRoot, PROJECT_PATHS.sourceManifest),
      `${JSON.stringify(distManifest, null, 2)}\n`,
      'utf8',
    )
    const backend = prepared.includeBackend
      ? buildBackendAssets({
          projectRoot: prepared.descriptor.projectRoot,
          candidateRoot,
          frontendPluginId: snapshot.manifest.id,
        })
      : undefined
    buildResultCloseAttempted = true
    try {
      await buildResult.close()
    } catch (error) {
      throw buildError('compile', 'FH2_BUILD_RESULT_CLOSE_FAILED', error)
    }
    const verifiedManifest = await verifyDist({
      candidateRoot,
      products,
      sdkContext: snapshot.sdkContext,
      toolchainVersion: TOOLCHAIN_VERSION,
    })
    try {
      await prepared.beforeCommit?.()
    } catch (error) {
      throw buildError('commit', 'FH2_BUILD_PRECOMMIT_FAILED', error)
    }
    const commitDiagnostics = prepared.deferCommit === true
      ? []
      : commitCandidateDirectory(candidateRoot, prepared.descriptor.distRoot)
    outcome = {
      manifest: verifiedManifest,
      diagnostics: [...products.warnings, ...commitDiagnostics],
      watchDependencies: backend === undefined
        ? products.watchDependencies
        : [...products.watchDependencies, ...backend.watchDependencies],
      ...(prepared.deferCommit === true ? { candidateRoot } : {}),
    }
  } catch (error) {
    failure = error
  } finally {
    if (buildResult !== undefined && !buildResultCloseAttempted) {
      buildResultCloseAttempted = true
      try {
        await buildResult.close()
      } catch (error) {
        const diagnostic: BuildDiagnostic = {
          code: 'FH2_BUILD_RESULT_CLOSE_FAILED',
          phase: 'compile',
          message: `关闭 Rsbuild BuildResult 失败：${message(error)}`,
        }
        if (failure instanceof PluginBuildError)
          failure = new PluginBuildError([...failure.diagnostics, diagnostic], failure.watchDependencies)
        else if (failure === undefined) failure = new PluginBuildError([diagnostic])
      }
    }
    clearFh2PluginExecutionContext(prepared.adapter)
    try {
      if (outcome?.candidateRoot === undefined) removeCandidateDirectory(candidateRoot)
    } catch (error) {
      const diagnostic: BuildDiagnostic = {
        code: 'FH2_CANDIDATE_CLEANUP_FAILED',
        phase: 'commit',
        file: candidateRoot,
        message: `清理候选制品目录失败：${message(error)}`,
      }
      if (outcome !== undefined) outcome = { ...outcome, diagnostics: [...outcome.diagnostics, diagnostic] }
      else if (failure instanceof PluginBuildError)
        failure = new PluginBuildError([...failure.diagnostics, diagnostic], failure.watchDependencies)
      else if (failure === undefined) failure = new PluginBuildError([diagnostic])
    }
  }
  if (failure !== undefined) throw failure
  if (outcome === undefined)
    throw buildError('compile', 'FH2_BUILD_OUTCOME_MISSING', new Error('构建轮次未产生结果'))
  return outcome
}

async function findBrandedAdapters (plugins: unknown): Promise<RsbuildPlugin[]> {
  const adapters: RsbuildPlugin[] = []
  const visit = async (value: unknown): Promise<void> => {
    if (value instanceof Promise) {
      await visit(await value)
      return
    }
    if (Array.isArray(value)) {
      await Promise.all(value.map(visit))
      return
    }
    if (getFh2PluginRawDescriptor(value) !== undefined) adapters.push(value as RsbuildPlugin)
  }
  await visit(plugins)
  return adapters
}

function validationFailure (snapshot: Extract<SourceManifestSnapshot, { ok: false }>): PluginBuildError {
  return new PluginBuildError(snapshot.diagnostics.map(diagnostic => ({
    code: diagnostic.code,
    phase: BUILD_PHASES.validate,
    file: diagnostic.file,
    message: diagnostic.message,
    ...(diagnostic.hint === undefined ? {} : { hint: diagnostic.hint }),
  })))
}

function asBuildError (error: unknown, phase: BuildDiagnostic['phase'], code: string): PluginBuildError {
  return error instanceof PluginBuildError ? error : buildError(phase, code, error)
}

export function isIgnoredWatchPath (path: string, descriptor: ResolvedBuildDescriptor): boolean {
  const absolute = resolve(path)
  const generatedFile = resolve(descriptor.typesOutDir, PROJECT_PATHS.generatedTypesFile)
  const generatedTemporary = dirname(absolute) === descriptor.typesOutDir
    && /^\.plugin-types\.ts\..+\.tmp$/.test(basename(absolute))
  const distParent = dirname(descriptor.distRoot)
  const distName = basename(descriptor.distRoot)
  const projectSegments = relative(descriptor.projectRoot, absolute).split(sep)
  const transactionDirectory = projectSegments.some(segment =>
    segment.startsWith(distTransactionPrefix(distName, 'candidate')) || segment.startsWith(distTransactionPrefix(distName, 'backup')),
  )
  const nodeModules = projectSegments.includes('node_modules')
  return nodeModules
    || isPathInside(descriptor.distRoot, absolute)
    || absolute === generatedFile
    || generatedTemporary
    || (isPathInside(distParent, absolute) && transactionDirectory)
}

function isInfrastructureFailure (error: PluginBuildError): boolean {
  return error.diagnostics.some(diagnostic => INFRASTRUCTURE_FAILURE_CODES.includes(diagnostic.code))
}

function waitForWatcherReady (watcher: WatcherLike): {
  readonly promise: Promise<boolean>;
  readonly cancel: () => void;
} {
  let settle!: (ready: boolean) => void
  let settled = false
  let onReady!: () => void
  const finish = (ready: boolean): void => {
    if (settled) return
    settled = true
    watcher.off('ready', onReady)
    settle(ready)
  }
  onReady = () => finish(true)
  const promise = new Promise<boolean>((resolveReady) => {
    settle = resolveReady
    watcher.on('ready', onReady)
  })
  return { promise, cancel: () => finish(false) }
}

function watcherCloseDiagnostic (error: unknown): BuildDiagnostic {
  return {
    code: 'FH2_BUILD_WATCHER_CLOSE_FAILED',
    phase: 'config',
    message: `关闭构建监督 watcher 失败：${message(error)}`,
  }
}

function emit (options: PluginBuildRunnerOptions, event: PluginBuildEvent): void {
  try {
    options.onEvent?.(event)
  } catch {
    // Build ownership stays with the Runner even if an observer fails.
  }
}

function deferred<T> (): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  let rejectPromise!: (reason?: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
