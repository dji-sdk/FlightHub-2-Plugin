// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createPluginBuildRunner } from '../../build/runner.js'
import { PluginBuildError } from '../../build/types.js'
import type {
  BuildDiagnostic,
  PluginBuildEvent,
  PluginBuildRunnerOptions,
  PluginBuildSession,
} from '../../build/types.js'
import { runCapabilityDev } from '../../capability/dev.js'
import { tryDiscoverCommandContext } from '../../capability/discovery.js'
import { CapabilityError } from '../../capability/types.js'
import { GatewayConfigurationError, createMockGateway, createProxyGateway, validateGatewayTarget } from '../../dev/gateway.js'
import type { DevGateway, ProxyGatewayOptions } from '../../dev/gateway.js'
import { LocalBackendRuntime } from '../../dev/backend-runtime.js'
import { runBackendPluginDev } from '../../dev/backend-plugin-dev.js'
import type { BackendPluginDevOptions } from '../../dev/backend-plugin-dev.js'
import { hasBackendPlugin } from '../../backend/manifest.js'
import { serveStatic, workbenchEntryUrl } from '../../dev/static-server.js'
import type { DevStaticServer, DevStaticServerOptions } from '../../dev/static-server.js'
import { acquireOperationLock } from '../tasks/operation-lock.js'
import { failureLocationHint, isMissingPathError } from './failure-location.js'
import type { OutputWriter } from './shared.js'

export interface DevSignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface WorkbenchDistPaths {
  readonly shell: string;
  readonly vue3: string;
  readonly vue2: string;
}

export interface DevProjectOptions {
  readonly cwd: string;
  readonly onReady?: (url: string) => void;
  readonly operationLockHeld?: boolean;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly signals: DevSignalSource;
  readonly env?: NodeJS.ProcessEnv;
  readonly createRunner?: (options: PluginBuildRunnerOptions) => Promise<PluginBuildSession>;
  readonly serve?: (options: DevStaticServerOptions) => Promise<DevStaticServer>;
  readonly createProxy?: (options: ProxyGatewayOptions) => DevGateway;
  readonly resolveWorkbench?: () => WorkbenchDistPaths;
  readonly forceExit?: (code: number) => void;
  readonly resolveContext?: typeof tryDiscoverCommandContext;
  readonly runCapabilityDev?: typeof runCapabilityDev;
  readonly runBackendPluginDev?: typeof runBackendPluginDev;
}

export interface ParsedDevArguments {
  readonly workbenchMode: 'all' | 'cockpit';
  readonly manifestPath: string;
  readonly manifestExplicit?: boolean;
  readonly projectRoot: string;
  readonly pluginsDir: readonly string[];
  readonly port: number;
  readonly watch: boolean;
  readonly help: boolean;
  readonly configPath?: string;
  readonly gatewayTarget?: string;
  readonly frontendOnly: boolean;
  readonly backendOnly?: boolean;
  readonly frontend?: readonly string[];
  readonly backend?: readonly string[];
  readonly root?: string;
  readonly pluginsDirExplicit?: boolean;
}

export async function devProject (parsed: ParsedDevArguments, options: DevProjectOptions): Promise<number> {
  let release: (() => void) | undefined
  try {
    release = options.operationLockHeld ? undefined : acquireOperationLock(parsed.root ?? parsed.projectRoot)
  } catch (error) {
    if (isMissingPathError(error)) options.stderr.write(failureLocationHint('dev', parsed.projectRoot))
    throw error
  }
  try {
    return await executeDevProject(parsed, options)
  } finally {
    release?.()
  }
}

async function executeDevProject (parsed: ParsedDevArguments, options: DevProjectOptions): Promise<number> {
  try {
    const contextRoot = parsed.manifestExplicit === true ? parsed.projectRoot : parsed.root ?? options.cwd
    const context = (options.resolveContext ?? tryDiscoverCommandContext)(contextRoot)
    if (context?.kind === 'industry-capability-workspace') {
      options.stderr.write(
        'dev 不支持在行业 Capability 工作区根执行：请使用 fh2-plugin dev --root <capability-id>，'
        + '或进入直接子目录 <capability-id>（含 capabilities.json）运行。'
        + '单插件调试请进入 <capability-id>/frontend/<plugin-id> 或 <capability-id>/backend/<plugin-id>（含 fh2-plugin.json）运行。\n',
      )
      options.stderr.write(failureLocationHint('dev', context.root))
      return 2
    }
    if (context?.kind === 'capability-project') {
      return await (options.runCapabilityDev ?? runCapabilityDev)({
        capability: context,
        ...(options.onReady ? { onReady: options.onReady } : {}),
        operationLockHeld: true,
        parsed,
        stdout: options.stdout,
        stderr: options.stderr,
        signals: options.signals,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.createRunner === undefined ? {} : { createRunner: options.createRunner }),
        ...(options.serve === undefined ? {} : { serve: options.serve }),
        ...(options.createProxy === undefined ? {} : { createProxy: options.createProxy }),
        resolveWorkbench: options.resolveWorkbench ?? resolveWorkbenchDist,
        ...(options.forceExit === undefined ? {} : { forceExit: options.forceExit }),
      })
    }
    if (context?.kind === 'backend-plugin') {
      const backendDevOptions: BackendPluginDevOptions = {
        pluginRoot: context.root,
        ...(options.onReady ? { onReady: options.onReady } : {}),
        port: parsed.port,
        watch: parsed.watch,
        stdout: options.stdout,
        stderr: options.stderr,
        signals: options.signals,
        ...(options.forceExit === undefined ? {} : { forceExit: options.forceExit }),
      }
      return await (options.runBackendPluginDev ?? runBackendPluginDev)(backendDevOptions)
    }
  } catch (error) {
    if (error instanceof CapabilityError) {
      options.stderr.write(`[fh2-plugin] dev 失败：${error.code}\n${error.message}\n`)
      return 1
    }
    options.stderr.write(`[fh2-plugin] dev 内部错误：${safeMessage(error)}\n`)
    return 3
  }

  const env = options.env ?? process.env
  let loginToken = env.FH2_DEV_LOGIN_TOKEN
  delete env.FH2_DEV_LOGIN_TOKEN
  let gatewayTarget: URL | undefined
  if (parsed.gatewayTarget !== undefined) {
    try {
      gatewayTarget = validateGatewayTarget(parsed.gatewayTarget)
      if (!loginToken) throw new GatewayConfigurationError('缺少 FH2_DEV_LOGIN_TOKEN。')
    } catch (error) {
      options.stderr.write(`[fh2-plugin] dev 启动失败：${safeMessage(error)}\n`)
      return 1
    }
  } else {
    loginToken = undefined
  }
  const hasBackend = hasBackendPlugin(parsed.projectRoot)
  const localBackendEnabled = gatewayTarget === undefined && !parsed.frontendOnly && hasBackend

  const workbench = (options.resolveWorkbench ?? resolveWorkbenchDist)()
  const sessionReady = deferred<void>()
  const serverReady = deferred<void>()
  const terminated = deferred<number>()
  let session: PluginBuildSession | undefined
  let server: DevStaticServer | undefined
  let detachedGateway: DevGateway | undefined
  let requestedExitCode: number | undefined
  let shutdownPromise: Promise<number> | undefined
  let signalCount = 0
  let fatalWasPrinted = false
  const printedFailureBuildIds = new Set<number>()

  const beginShutdown = (code: number): Promise<number> => {
    requestedExitCode ??= code
    if (shutdownPromise !== undefined) return shutdownPromise
    shutdownPromise = (async () => {
      await sessionReady.promise
      try {
        await session?.close()
      } catch (error) {
        options.stderr.write(`[fh2-plugin] 关闭 Build Session 失败：${safeMessage(error, loginToken)}\n`)
      }
      await serverReady.promise
      try {
        if (server !== undefined) await server.close()
        else await detachedGateway?.close()
      } catch (error) {
        options.stderr.write(`[fh2-plugin] 关闭 Dev Server 失败：${safeMessage(error, loginToken)}\n`)
      }
      return requestedExitCode!
    })()
    void shutdownPromise.then(terminated.resolve)
    return shutdownPromise
  }

  const onSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    signalCount += 1
    const code = signal === 'SIGINT' ? 130 : 0
    if (signalCount > 1) {
      ;(options.forceExit ?? ((exitCode: number) => process.exit(exitCode)))(code)
      return
    }
    void beginShutdown(code)
  }
  const onSigint = (): void => onSignal('SIGINT')
  const onSigterm = (): void => onSignal('SIGTERM')

  const onBuildEvent = (event: PluginBuildEvent): void => {
    if (event.type === 'success') {
      options.stdout.write(`✓ fh2-plugin dev build #${event.buildId} 成功：${event.distManifest?.id ?? ''}\n`)
      if (event.diagnostics.length > 0) writeDiagnostics(options.stderr, event.diagnostics, loginToken)
      server?.publishBuildEvent({ schemaVersion: 1, type: 'reload', buildId: event.buildId })
      return
    }
    options.stderr.write(`[fh2-plugin] dev build #${event.buildId} ${event.type === 'fatal' ? '致命失败' : '失败'}\n`)
    writeDiagnostics(options.stderr, event.diagnostics, loginToken)
    printedFailureBuildIds.add(event.buildId)
    if (event.type === 'fatal') {
      fatalWasPrinted = true
    } else {
      server?.publishBuildEvent({
        schemaVersion: 1,
        type: 'error',
        buildId: event.buildId,
        diagnosticCode: buildFailureCode(event.diagnostics),
      })
    }
  }

  options.signals.on('SIGINT', onSigint)
  options.signals.on('SIGTERM', onSigterm)
  try {
    try {
      session = await (options.createRunner ?? createPluginBuildRunner)({
        cwd: parsed.projectRoot,
        ...(parsed.configPath === undefined ? {} : { configPath: parsed.configPath }),
        expectedManifestPath: parsed.manifestPath,
        includeBackend: !parsed.frontendOnly,
        watch: parsed.watch,
        onEvent: onBuildEvent,
      })
      sessionReady.resolve()
    } catch (error) {
      sessionReady.resolve()
      serverReady.resolve()
      if (requestedExitCode !== undefined) return await beginShutdown(requestedExitCode)
      if (parsed.manifestExplicit !== true && parsed.configPath === undefined)
        options.stderr.write(failureLocationHint('dev', parsed.projectRoot))
      options.stderr.write(`[fh2-plugin] dev 内部错误：${safeMessage(error, loginToken)}\n`)
      return await beginShutdown(3)
    }

    void session.done.then((terminal) => {
      if (terminal.reason !== 'fatal') return
      if (!fatalWasPrinted) writeDiagnostics(options.stderr, terminal.diagnostics, loginToken)
      void beginShutdown(1)
    }, (error: unknown) => {
      options.stderr.write(`[fh2-plugin] Build Session 异常终止：${safeMessage(error, loginToken)}\n`)
      void beginShutdown(3)
    })

    try {
      await session.firstBuild
    } catch (error) {
      serverReady.resolve()
      if (requestedExitCode !== undefined) return await beginShutdown(requestedExitCode)
      if (error instanceof PluginBuildError) {
        if (printedFailureBuildIds.size === 0 && error.diagnostics.length > 0)
          writeDiagnostics(options.stderr, error.diagnostics, loginToken)
        return await beginShutdown(1)
      }
      options.stderr.write(`[fh2-plugin] dev 内部错误：${safeMessage(error, loginToken)}\n`)
      return await beginShutdown(3)
    }
    if (requestedExitCode !== undefined) {
      serverReady.resolve()
      return await beginShutdown(requestedExitCode)
    }

    try {
      if (gatewayTarget !== undefined) {
        detachedGateway = (options.createProxy ?? createProxyGateway)({ target: gatewayTarget, loginToken: loginToken! })
      } else if (localBackendEnabled) {
        detachedGateway = createMockGateway({ backendRuntime: new LocalBackendRuntime(parsed.projectRoot) })
      }
      server = await (options.serve ?? serveStatic)({
        shellDist: workbench.shell,
        vue3Dist: workbench.vue3,
        vue2Dist: workbench.vue2,
        pluginsDir: parsed.pluginsDir,
        workbenchMode: parsed.workbenchMode,
        backendMode: localBackendEnabled ? 'fullstack' : 'frontend',
        port: parsed.port,
        watch: parsed.watch,
        ...(detachedGateway === undefined ? {} : { gateway: detachedGateway }),
      })
      detachedGateway = undefined
      serverReady.resolve()
    } catch (error) {
      serverReady.resolve()
      if (requestedExitCode !== undefined) return await beginShutdown(requestedExitCode)
      options.stderr.write(`[fh2-plugin] Dev Server 启动失败：${safeMessage(error, loginToken)}\n`)
      return await beginShutdown(1)
    }
    if (requestedExitCode !== undefined) return await beginShutdown(requestedExitCode)

    const workbenchUrl = workbenchEntryUrl(server.url, parsed.workbenchMode)
    options.onReady?.(workbenchUrl)
    options.stdout.write(
      `\n✓ Workbench 已启动：${workbenchUrl}\n`
      + `  插件产物目录：${parsed.pluginsDir.join(', ')}\n`
      + `  Workbench 模式：${parsed.workbenchMode === 'cockpit' ? 'Cockpit' : '全部 Host'}\n`
      + `  Build watch：${parsed.watch ? '已开启' : '未开启（已完成一次构建）'}\n`
      + `  Dev 模式：${localBackendEnabled ? '全栈（本地后端 Runtime）' : gatewayTarget === undefined ? '仅前端' : '前端 + Gateway Proxy'}\n`
      + `  HTTP Gateway：${server.apiMode === 'proxy' ? 'Proxy' : 'Mock'}\n`
      + `  打开浏览器访问上述地址即可调试（Ctrl+C 退出）\n\n`,
    )
    return await terminated.promise
  } finally {
    sessionReady.resolve()
    serverReady.resolve()
    options.signals.off('SIGINT', onSigint)
    options.signals.off('SIGTERM', onSigterm)
  }
}

export function resolveWorkbenchDist (): WorkbenchDistPaths {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const packageRoots = [resolve(moduleDirectory, '..'), resolve(moduleDirectory, '../..'), resolve(moduleDirectory, '../../..')]
  const packageRoot = packageRoots.find(candidate => existsSync(resolve(candidate, 'package.json'))) ?? packageRoots[0]!
  const apps = resolve(packageRoot, 'apps')
  return {
    shell: resolve(apps, 'mock-host-workbench-shell/dist'),
    vue3: resolve(apps, 'mock-host-vue3/dist'),
    vue2: resolve(apps, 'mock-host-vue2/dist'),
  }
}

function writeDiagnostics (
  writer: OutputWriter,
  diagnostics: readonly BuildDiagnostic[],
  secret?: string,
): void {
  for (const diagnostic of diagnostics) {
    const file = diagnostic.file === undefined ? '' : ` ${redact(diagnostic.file, secret)}`
    const hint = diagnostic.hint === undefined ? '' : `\n建议：${redact(diagnostic.hint, secret)}`
    writer.write(`${diagnostic.code} [${diagnostic.phase}]${file}\n${redact(diagnostic.message, secret)}${hint}\n`)
  }
}

function buildFailureCode (diagnostics: readonly BuildDiagnostic[]): string {
  const diagnostic = diagnostics[0]
  return diagnostic?.code ?? 'FH2_BUILD_FAILED'
}

function safeMessage (error: unknown, secret?: string): string {
  return redact(error instanceof Error ? error.message : String(error), secret)
}

function redact (value: string, secret?: string): string {
  return secret ? value.replaceAll(secret, '[REDACTED]') : value
}

function deferred<T> (): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolveDeferred) => {
    resolvePromise = resolveDeferred
  })
  return { promise, resolve: resolvePromise }
}
