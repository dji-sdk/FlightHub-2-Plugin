// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { resolve } from 'node:path'
import process from 'node:process'
import { cliDefinition, renderCliOptions } from '../cli-definitions.js'
import type { CliBehaviorMetadata } from '../cli-definitions.js'
import { CapabilityError } from '../capability/types.js'
import { IdeAssetsMissingError, resolveWebIdeDist, startIdeServer } from '../serve/ide-server.js'
import type { IdeServer, IdeServerOptions } from '../serve/ide-server.js'
import { CliArgumentError, parseCommandArguments } from './arguments.js'
import { openSystemBrowser } from './preview-command.js'
import type { CommandWriter } from './validate-command.js'

const DEFINITION = cliDefinition('serve')
export const SERVE_HELP = `用法：fh2-plugin serve [选项]

在 127.0.0.1 启动 Web IDE：同时提供 Web IDE 前端与基于能力层的本地 API，
浏览器不启动任何进程，全部操作都通过 localhost 回到本命令。

${renderCliOptions(DEFINITION)}`
export const SERVE_CLI_METADATA: CliBehaviorMetadata = {
  behaviorKind: 'manual-description',
  contexts: [],
  exitCodes: [{ code: 0, meaning: 'Web IDE Server 正常退出（SIGTERM 优雅终止也返回 0）' }, { code: 1, meaning: '工程发现或服务启动失败' }, { code: 2, meaning: '参数错误' }, { code: 3, meaning: '内部错误' }, { code: 130, meaning: 'SIGINT 中断（第二次 Ctrl+C 强制退出）' }],
  notes: ['不依赖已识别的插件工程：unknown 根也可启动 Start Center'],
  source: 'src/commands/serve-command.ts#runServeCommand',
}

export interface ServeSignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface ServeCommandOptions {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdout: CommandWriter;
  readonly stderr: CommandWriter;
  readonly signals: ServeSignalSource;
  readonly env?: NodeJS.ProcessEnv;
  readonly serve?: (options: IdeServerOptions) => Promise<IdeServer>;
  readonly resolveWebRoot?: () => string;
  readonly openBrowser?: (url: string) => Promise<void>;
  readonly forceExit?: (code: number) => void;
}

export interface ParsedServeArguments {
  /** 0 = 让内核分配随机空闲端口（契约不约束端口，前端从 URL 取）。 */
  readonly port: number;
  readonly root: string;
  readonly noOpen: boolean;
  readonly help: boolean;
}

export async function runServeCommand (options: ServeCommandOptions): Promise<number> {
  let parsed: ParsedServeArguments
  try {
    parsed = parseServeArguments(options.args, options.cwd)
  } catch (error) {
    if (!(error instanceof CliArgumentError)) throw error
    options.stderr.write(`${error.message}\n\n${SERVE_HELP}`)
    return 2
  }
  if (parsed.help) {
    options.stdout.write(SERVE_HELP)
    return 0
  }

  const terminated = deferred<number>()
  let server: IdeServer | undefined
  let serverReady = false
  let requestedExitCode: number | undefined
  let shutdownPromise: Promise<number> | undefined
  let signalCount = 0

  const beginShutdown = (code: number): Promise<number> => {
    requestedExitCode ??= code
    if (shutdownPromise !== undefined) return shutdownPromise
    shutdownPromise = (async () => {
      try {
        await server?.close()
      } catch (error) {
        options.stderr.write(`[fh2-plugin] 关闭 Web IDE Server 失败：${errorMessage(error)}\n`)
      }
      return requestedExitCode!
    })()
    void shutdownPromise.then(terminated.resolve)
    return shutdownPromise
  }

  // 与 dev-command 一致：首个信号优雅退出，第二个信号强制退出。
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
      server = await (options.serve ?? startIdeServer)({
        root: parsed.root,
        webRoot: (options.resolveWebRoot ?? resolveWebIdeDist)(),
        port: parsed.port,
      })
      serverReady = true
    } catch (error) {
      if (requestedExitCode !== undefined) return await beginShutdown(requestedExitCode)
      if (error instanceof IdeAssetsMissingError) {
        options.stderr.write(`[fh2-plugin] serve 启动失败：${error.code}\n${error.message}\n`)
        return 1
      }
      if (error instanceof CapabilityError) {
        options.stderr.write(`[fh2-plugin] serve 失败：${error.code}\n${error.message}\n`)
        return 1
      }
      options.stderr.write(`[fh2-plugin] serve 启动失败：${errorMessage(error)}\n`)
      return 1
    }
    if (requestedExitCode !== undefined) return await beginShutdown(requestedExitCode)

    // token 只在首页 HTML 里注入，终端不打印——避免它进入日志或终端回滚缓冲。
    options.stdout.write(
      `\n✓ Web IDE 已启动：${server.url}\n`
      + `  工作根：${parsed.root}\n`
      + `  鉴权：一次性 token 已注入首页（本次进程有效）\n`
      + `  打开浏览器访问上述地址即可开发插件（Ctrl+C 退出）\n\n`,
    )

    if (!parsed.noOpen) {
      try {
        await (options.openBrowser ?? openSystemBrowser)(server.url)
      } catch (error) {
        // 打不开浏览器不影响服务本身，地址已经打印出来了。
        options.stderr.write(`[fh2-plugin] 打开浏览器失败：${errorMessage(error)}\n`)
      }
    }
    return await terminated.promise
  } catch (error) {
    if (requestedExitCode !== undefined) return await beginShutdown(requestedExitCode)
    options.stderr.write(`[fh2-plugin] serve 内部错误：${errorMessage(error)}\n`)
    return 3
  } finally {
    if (!serverReady) void server?.close()
    options.signals.off('SIGINT', onSigint)
    options.signals.off('SIGTERM', onSigterm)
  }
}

export function parseServeArguments (args: readonly string[], cwd: string): ParsedServeArguments {
  const parsed = parseCommandArguments(args, DEFINITION)
  return {
    port: Number(parsed.value('port')),
    root: resolve(cwd, parsed.value('root')!),
    noOpen: parsed.flag('no-open'),
    help: parsed.flag('help'),
  }
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
