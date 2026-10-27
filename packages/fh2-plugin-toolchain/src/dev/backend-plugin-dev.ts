// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { watch } from 'chokidar'
import { buildBackendPlugin } from '../backend/build.js'
import type { BackendPluginBuildResult } from '../backend/build.js'
import { PluginBuildError } from '../build/types.js'
import type { BuildDiagnostic } from '../build/types.js'
import { syncPluginTypes } from '../backend/typegen/sync.js'
import { CapabilityBackendRuntime } from './capability-backend-runtime.js'
import { MOCK_PLUGIN_TOKEN, createMockGateway } from './gateway.js'
import type { BackendDevRuntime } from './backend-runtime.js'

const REBUILD_DEBOUNCE_MS = 200

export interface BackendPluginDevSignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface BackendPluginDevOptions {
  readonly onReady?: (url: string) => void;
  readonly pluginRoot: string;
  readonly port: number;
  readonly watch: boolean;
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
  readonly signals: BackendPluginDevSignalSource;
  readonly forceExit?: (code: number) => void;
  readonly buildBackend?: typeof buildBackendPlugin;
  readonly createRuntime?: (options: {
    readonly pluginRoot: string;
    readonly pluginId: string;
    readonly mockRoot: string;
  }) => BackendDevRuntime;
}

/**
 * 独立后端插件 Dev：首次 Build -> 本地 Gateway（/plugin/invoke）-> Watch 热重建。
 * 不启动前端 Workbench；位于 Capability 下时自动加载父级 mock/。
 */
export async function runBackendPluginDev (options: BackendPluginDevOptions): Promise<number> {
  const pluginRoot = resolve(options.pluginRoot)
  const buildBackend = options.buildBackend ?? buildBackendPlugin
  const mockRoot = findCapabilityMockRoot(pluginRoot)

  let build: BackendPluginBuildResult
  try {
    build = await buildBackend(pluginRoot)
    syncPluginTypes(pluginRoot)
  } catch (error) {
    if (error instanceof PluginBuildError) {
      options.stderr.write(`[fh2-plugin] dev 启动失败：FH2_BACKEND_DEV_START_FAILED\n`)
      for (const diagnostic of error.diagnostics) writeDiagnostic(options.stderr, diagnostic)
      return 1
    }
    options.stderr.write(`[fh2-plugin] dev 内部错误：${message(error)}\n`)
    return 3
  }

  const createRuntime = options.createRuntime ?? defaultCreateRuntime
  const runtime = createRuntime({ pluginRoot, pluginId: build.pluginId, mockRoot })
  const gateway = createMockGateway({ backendRuntime: runtime })

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    void gateway.handle(req, res, requestUrl).then((handled) => {
      if (handled || res.writableEnded || res.destroyed) return
      res.statusCode = 404
      res.setHeader('content-type', 'application/json')
      res.end(`${JSON.stringify({ code: 404, message: 'Not Found' })}\n`)
    }).catch((error: unknown) => {
      if (res.writableEnded || res.destroyed) return
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(`${JSON.stringify({ code: 500, message: message(error) })}\n`)
    })
  })

  const watchers: { close: () => Promise<void> }[] = []
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined
  let rebuilding = false
  let requestedExitCode: number | undefined
  let shutdownPromise: Promise<number> | undefined
  let signalCount = 0
  const terminated = deferred<number>()

  const beginShutdown = (code: number): Promise<number> => {
    requestedExitCode ??= code
    if (shutdownPromise !== undefined) return shutdownPromise
    shutdownPromise = (async () => {
      if (rebuildTimer !== undefined) clearTimeout(rebuildTimer)
      for (const watcher of watchers) await watcher.close().catch(() => undefined)
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
        server.closeAllConnections()
      })
      runtime.close()
      await gateway.close().catch(() => undefined)
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
  options.signals.on('SIGINT', onSigint)
  options.signals.on('SIGTERM', onSigterm)

  try {
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        server.once('error', rejectReady)
        server.listen(options.port, '127.0.0.1', () => {
          resolveReady()
        })
      })
    } catch (error) {
      runtime.close()
      await gateway.close().catch(() => undefined)
      options.stderr.write(`[fh2-plugin] dev 启动失败：FH2_BACKEND_DEV_START_FAILED：${message(error)}\n`)
      return 1
    }

    const actualPort = (server.address() as { readonly port: number }).port
    options.onReady?.(`http://127.0.0.1:${actualPort}`)
    options.stdout.write(
      `\n✓ 后端 Dev Gateway 已启动：http://127.0.0.1:${actualPort}\n`
      + `  后端插件：${build.pluginId}\n`
      + `  Mock 根目录：${mockRoot}\n`
      + `  调用入口：POST /plugin-api/plugin/invoke（header x-plugin-token: ${MOCK_PLUGIN_TOKEN}，仅模拟网关）\n`
      + `  构建模式：Bundle（${build.watchDependencies.length} 个依赖文件）\n`
      + `  Source watch：${options.watch ? '已开启' : '未开启'}（Ctrl+C 退出）\n\n`,
    )

    if (options.watch) {
      const watcher = watch([pluginRoot], {
        ignored: /(\/|^)(?:dist|types|node_modules|\.fh2|\.git)(\/|$)/,
        ignoreInitial: true,
      })
      watchers.push(watcher)
      watcher.on('all', () => {
        if (rebuilding) return
        if (rebuildTimer !== undefined) clearTimeout(rebuildTimer)
        rebuildTimer = setTimeout(() => {
          rebuilding = true
          void (async () => {
            try {
              await buildBackend(pluginRoot)
              // 只在候选源码成功构建后提交新的 ambient 声明；SQL 改动不会改变该输出。
              syncPluginTypes(pluginRoot)
              runtime.reload(build.pluginId)
              options.stdout.write(`✓ [backend ${build.pluginId}] dev 重建成功，Runtime 已 reload\n`)
            } catch (error) {
              options.stderr.write(`[fh2-plugin] dev 重建失败：\n`)
              if (error instanceof PluginBuildError) {
                for (const diagnostic of error.diagnostics) writeDiagnostic(options.stderr, diagnostic)
              } else {
                options.stderr.write(`${message(error)}\n`)
              }
            } finally {
              rebuilding = false
            }
          })()
        }, REBUILD_DEBOUNCE_MS)
      })
    }

    return await terminated.promise
  } finally {
    options.signals.off('SIGINT', onSigint)
    options.signals.off('SIGTERM', onSigterm)
  }
}

function defaultCreateRuntime (options: {
  readonly pluginRoot: string;
  readonly pluginId: string;
  readonly mockRoot: string;
}): BackendDevRuntime {
  return new CapabilityBackendRuntime(options.mockRoot, [
    { id: options.pluginId, root: options.pluginRoot, manifestPath: join(options.pluginRoot, 'fh2-plugin.json') },
  ], { mockRoot: options.mockRoot })
}

/** 从插件根向上查找最近的 Capability 根（capabilities.json）；找不到则回退插件自身根。 */
export function findCapabilityMockRoot (pluginRoot: string): string {
  let directory = resolve(pluginRoot)
  while (true) {
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
    if (existsSync(join(directory, 'capabilities.json'))) return directory
  }
  return resolve(pluginRoot)
}

function writeDiagnostic (stderr: { write(chunk: string): unknown }, diagnostic: BuildDiagnostic): void {
  const file = diagnostic.file === undefined ? '' : ` ${diagnostic.file}`
  stderr.write(`  ${diagnostic.code}${file}\n    ${diagnostic.message}\n`)
}

function deferred<T> (): { readonly promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: (value: T) => {
    resolvePromise(value)
  } }
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
