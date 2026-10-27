// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import process from 'node:process'
import { resolve } from 'node:path'
import type { DevProjectOptions, DevSignalSource, ParsedDevArguments, WorkbenchDistPaths } from '../services/application/dev.js'
import type { BuildDiagnostic, PluginBuildRunnerOptions, PluginBuildSession } from '../build/types.js'
import { CapabilityBackendRuntime } from '../dev/capability-backend-runtime.js'
import { GatewayConfigurationError, MOCK_PLUGIN_TOKEN, createMockGateway, createProxyGateway, validateGatewayTarget } from '../dev/gateway.js'
import type { DevGateway, ProxyGatewayOptions } from '../dev/gateway.js'
import { serveStatic, workbenchEntryUrl } from '../dev/static-server.js'
import type { DevStaticServer, DevStaticServerOptions } from '../dev/static-server.js'
import { CapabilityError } from './types.js'
import type { BackendPluginProject, CapabilityProject } from './types.js'
import { buildCapability, watchCapability } from './build.js'
import type { CapabilityBuildEvent, CapabilityBuildOptions, CapabilityBuildWatchSession } from './build.js'

export interface CapabilityDevOptions {
  readonly capability: CapabilityProject;
  readonly onReady?: (url: string) => void;
  readonly operationLockHeld?: boolean;
  readonly parsed: ParsedDevArguments;
  readonly stdout: DevProjectOptions['stdout'];
  readonly stderr: DevProjectOptions['stderr'];
  readonly signals: DevSignalSource;
  readonly env?: NodeJS.ProcessEnv;
  readonly createRunner?: (options: PluginBuildRunnerOptions) => Promise<PluginBuildSession>;
  readonly serve?: (options: DevStaticServerOptions) => Promise<DevStaticServer>;
  readonly createProxy?: (options: ProxyGatewayOptions) => DevGateway;
  readonly resolveWorkbench: () => WorkbenchDistPaths;
  readonly forceExit?: (code: number) => void;
  readonly buildCapability?: typeof buildCapability;
  readonly watchCapability?: typeof watchCapability;
  readonly createBackendRuntime?: (capabilityRoot: string, projects: readonly BackendPluginProject[]) => CapabilityBackendRuntime;
}

export async function runCapabilityDev (options: CapabilityDevOptions): Promise<number> {
  const selectedFrontend = selectProjects(options.capability.frontend, options.parsed.frontend, 'frontend')
  const selectedBackend = selectProjects(options.capability.backend, options.parsed.backend, 'backend')
  if (options.parsed.frontendOnly && options.parsed.backendOnly) {
    options.stderr.write('[fh2-plugin] dev 启动失败：不能同时指定 --frontend-only 与 --backend-only。\n')
    return 1
  }
  if (options.parsed.pluginsDirExplicit) {
    options.stderr.write('[fh2-plugin] dev 启动失败：Capability Dev 不支持 --plugins-dir；前端目录由 capabilities.json 自动发现。\n')
    return 1
  }
  if (options.parsed.configPath !== undefined && selectedFrontend.length !== 1) {
    options.stderr.write('[fh2-plugin] dev 启动失败：Capability 使用 --config 时必须且只能指定一个 --frontend <pluginId>。\n')
    return 1
  }

  const env = options.env ?? process.env
  let loginToken = env.FH2_DEV_LOGIN_TOKEN
  delete env.FH2_DEV_LOGIN_TOKEN
  let gatewayTarget: URL | undefined
  if (options.parsed.gatewayTarget !== undefined) {
    try {
      gatewayTarget = validateGatewayTarget(options.parsed.gatewayTarget)
      if (!loginToken) throw new GatewayConfigurationError('缺少 FH2_DEV_LOGIN_TOKEN。')
    } catch (error) {
      options.stderr.write(`[fh2-plugin] dev 启动失败：${safeMessage(error)}\n`)
      return 1
    }
  } else {
    loginToken = undefined
  }
  if (options.parsed.backendOnly && gatewayTarget !== undefined) {
    options.stderr.write('[fh2-plugin] dev 启动失败：--backend-only 不能与 --gateway-target 同时使用。\n')
    return 1
  }

  const localBackendEnabled = gatewayTarget === undefined && !options.parsed.frontendOnly && selectedBackend.length > 0
  const devCapability: CapabilityProject = {
    ...options.capability,
    frontend: options.parsed.backendOnly ? [] : selectedFrontend,
    backend: localBackendEnabled ? selectedBackend : [],
  }
  const workbench = options.resolveWorkbench()
  let runtime: CapabilityBackendRuntime | undefined
  let server: DevStaticServer | undefined
  let buildWatch: CapabilityBuildWatchSession | undefined
  let detachedGateway: DevGateway | undefined
  let requestedExitCode: number | undefined
  let shutdownPromise: Promise<number> | undefined
  const terminated = deferred<number>()
  const controller = new AbortController()
  let signalCount = 0
  let buildId = 0

  const beginShutdown = (code: number): Promise<number> => {
    requestedExitCode ??= code
    if (shutdownPromise !== undefined) return shutdownPromise
    shutdownPromise = (async () => {
      try {
        await buildWatch?.close()
      } catch (error) {
        options.stderr.write(`[fh2-plugin] 关闭 Capability Build Watch 失败：${safeMessage(error, loginToken)}\n`)
      }
      try {
        if (server !== undefined) await server.close()
        else await detachedGateway?.close()
      } catch (error) {
        options.stderr.write(`[fh2-plugin] 关闭 Capability Dev Server 失败：${safeMessage(error, loginToken)}\n`)
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
      controller.abort()
      void beginShutdown(code).then(() => {
        ;(options.forceExit ?? ((exitCode: number) => process.exit(exitCode)))(code)
      })
      return
    }
    controller.abort()
    void beginShutdown(code)
  }
  const onSigint = (): void => onSignal('SIGINT')
  const onSigterm = (): void => onSignal('SIGTERM')
  const onPluginEvent = (event: CapabilityBuildEvent): void => {
    if (event.type === 'success') {
      options.stdout.write(`✓ [${event.side} ${event.pluginId}] dev build success\n`)
      if (event.side === 'backend' && runtime !== undefined) {
        try {
          runtime.reload(event.pluginId)
        } catch (error) {
          options.stderr.write(`[${event.side} ${event.pluginId}] runtime reload failed：${safeMessage(error, loginToken)}\n`)
        }
      }
      if (event.side === 'frontend' && server !== undefined) {
        buildId += 1
        server.publishBuildEvent({ schemaVersion: 1, type: 'reload', buildId })
      }
      return
    }
    options.stderr.write(`[${event.side} ${event.pluginId}] dev build failed\n`)
    writeDiagnostics(options.stderr, event.diagnostics, loginToken)
    if (server !== undefined) {
      buildId += 1
      server.publishBuildEvent({
        schemaVersion: 1,
        type: 'error',
        buildId,
        diagnosticCode: event.diagnostics[0]?.code ?? 'FH2_BUILD_FAILED',
      })
    }
  }

  options.signals.on('SIGINT', onSigint)
  options.signals.on('SIGTERM', onSigterm)
  try {
    const buildOptions: CapabilityBuildOptions = {
      capability: devCapability,
      ...(options.operationLockHeld ? { operationLockHeld: true } : {}),
      abortSignal: controller.signal,
      ...(options.parsed.configPath === undefined ? {} : { frontendConfigPath: options.parsed.configPath }),
      onPluginEvent,
      ...(options.createRunner === undefined ? {} : { createFrontendRunner: options.createRunner }),
    }
    if (options.parsed.watch) {
      buildWatch = await (options.watchCapability ?? watchCapability)(buildOptions)
      if (requestedExitCode !== undefined) {
        await buildWatch.close()
        return await beginShutdown(requestedExitCode)
      }
      await buildWatch.firstBuild
      void buildWatch.done.then((terminal) => {
        if (terminal.reason !== 'fatal') return
        const diagnostics = signalCount > 0
          ? terminal.diagnostics.filter(diagnostic => diagnostic.code !== 'FH2_CAPABILITY_BUILD_ABORTED')
          : terminal.diagnostics
        if (diagnostics.length > 0) writeDiagnostics(options.stderr, diagnostics, loginToken)
        void beginShutdown(1)
      }, (error: unknown) => {
        options.stderr.write(`[fh2-plugin] Capability Build Watch 异常终止：${safeMessage(error, loginToken)}\n`)
        void beginShutdown(3)
      })
    } else {
      const result = await (options.buildCapability ?? buildCapability)(buildOptions)
      if (!result.ok) {
        writeDiagnostics(options.stderr, result.diagnostics, loginToken)
        return await beginShutdown(1)
      }
    }
    if (requestedExitCode !== undefined) return await beginShutdown(requestedExitCode)

    if (localBackendEnabled) {
      runtime = (options.createBackendRuntime ?? ((capabilityRoot, projects) => new CapabilityBackendRuntime(capabilityRoot, projects)))(
        options.capability.root,
        devCapability.backend,
      )
      detachedGateway = createMockGateway({ backendRuntime: runtime })
    } else if (gatewayTarget !== undefined) {
      detachedGateway = (options.createProxy ?? createProxyGateway)({ target: gatewayTarget, loginToken: loginToken! })
    }
    server = await (options.serve ?? serveStatic)({
      shellDist: workbench.shell,
      vue3Dist: workbench.vue3,
      vue2Dist: workbench.vue2,
      pluginsDir: devCapability.frontend.map(project => resolve(project.root, 'dist')),
      pluginCatalog: devCapability.frontend.map(project => ({
        pluginId: project.id,
        root: resolve(project.root, 'dist'),
      })),
      workbenchMode: options.parsed.workbenchMode,
      backendMode: localBackendEnabled ? 'fullstack' : 'frontend',
      port: options.parsed.port,
      watch: options.parsed.watch,
      ...(detachedGateway === undefined ? {} : { gateway: detachedGateway }),
    })
    detachedGateway = undefined
    if (requestedExitCode !== undefined) {
      await server.close()
      return await beginShutdown(requestedExitCode)
    }
    // T5：ready URL 经 Node IPC 上报（fork 的父进程消费）；stdout 只承载人读的日志。
    // FH2_DEV_IPC_REPORT 由任务执行器的 fork 注入——测试/普通 CLI 进程虽有 IPC 通道
    // （vitest worker），但不是本协议的消费者，误发会破坏宿主协议。
    const workbenchUrl = workbenchEntryUrl(server.url, options.parsed.workbenchMode)
    const localGatewayNotice = localBackendEnabled
      ? `  本地后端 Gateway URL：${new URL(server.url).origin}\n  本地调用凭据（仅模拟网关）：x-plugin-token: ${MOCK_PLUGIN_TOKEN}\n`
      : ''
    options.onReady?.(workbenchUrl)
    options.stdout.write(
      `\n✓ Capability Workbench 已启动：${workbenchUrl}\n`
      + `  Capability：${options.capability.capabilityId}\n`
      + `  前端插件：${devCapability.frontend.map(project => project.id).join(', ') || '无'}\n`
      + `  后端插件：${devCapability.backend.map(project => project.id).join(', ') || (gatewayTarget === undefined ? '无' : 'Gateway Proxy')}\n${localGatewayNotice}`
      + `  Build watch：${options.parsed.watch ? '已开启' : '未开启（已完成一次构建）'}\n`
      + `  打开浏览器访问上述地址即可调试（Ctrl+C 退出）\n\n`,
    )
    return await terminated.promise
  } catch (error) {
    if (requestedExitCode !== undefined) return await beginShutdown(requestedExitCode)
    if (error instanceof CapabilityError) {
      options.stderr.write(`[fh2-plugin] Capability dev 失败：${error.code}\n${error.message}\n`)
      return await beginShutdown(1)
    }
    options.stderr.write(`[fh2-plugin] Capability dev 启动失败：${safeMessage(error, loginToken)}\n`)
    return await beginShutdown(error instanceof Error ? 1 : 3)
  } finally {
    options.signals.off('SIGINT', onSigint)
    options.signals.off('SIGTERM', onSigterm)
  }
}

function selectProjects<T extends { readonly id: string }> (
  projects: readonly T[],
  filter: readonly string[] | undefined,
  side: 'frontend' | 'backend',
): readonly T[] {
  if (filter === undefined || filter.length === 0) return projects
  const known = new Set(projects.map(project => project.id))
  for (const id of filter) {
    if (!known.has(id)) {
      throw new CapabilityError('FH2_CAPABILITY_PLUGIN_DISCOVERY_FAILED', `Capability 内不存在 ${side} 插件 ${id}。`)
    }
  }
  return projects.filter(project => filter.includes(project.id))
}

function writeDiagnostics (writer: DevProjectOptions['stderr'], diagnostics: readonly BuildDiagnostic[], secret?: string): void {
  for (const diagnostic of diagnostics) {
    const file = diagnostic.file === undefined ? '' : ` ${redact(diagnostic.file, secret)}`
    const hint = diagnostic.hint === undefined ? '' : `\n建议：${redact(diagnostic.hint, secret)}`
    writer.write(`${diagnostic.code} [${diagnostic.phase}]${file}\n${redact(diagnostic.message, secret)}${hint}\n`)
  }
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
  const promise = new Promise<T>((resolveValue) => {
    resolvePromise = resolveValue
  })
  return { promise, resolve: resolvePromise }
}
