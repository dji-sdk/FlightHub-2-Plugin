// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { resolve } from 'node:path'
import { cliDefault, cliDefinition, renderCliOptions } from '../cli-definitions.js'
import type { CliBehaviorMetadata } from '../cli-definitions.js'
import { acquireOperationLock } from '../services/tasks/operation-lock.js'
import { createTaskService } from '../services/tasks/factory.js'
import type { Diagnostic, TaskOwner } from '../contracts/index.js'
import { buildBackendPlugin } from '../backend/build.js'
import { buildCapability, buildIndustryCapabilityWorkspace, watchCapability } from '../capability/build.js'
import { tryDiscoverCommandContext } from '../capability/discovery.js'
import { CapabilityError } from '../capability/types.js'
import { createPluginBuildRunner } from '../build/runner.js'
import { BUILD_CONTEXT_OPTIONS, isCapabilityBuildConfigSelection } from '../build/policy.js'
import { PluginBuildError } from '../build/types.js'
import type {
  BuildDiagnostic,
  PluginBuildEvent,
  PluginBuildRunnerOptions,
  PluginBuildSession,
} from '../build/types.js'
import { buildProject } from '../services/application/build.js'
import { createBuildPackExecutor } from '../services/tasks/executors/build-pack.js'
import { CliArgumentError, parseCommandArguments } from './arguments.js'
import type { CommandWriter } from './validate-command.js'

const DEFINITION = cliDefinition('build')
export const BUILD_HELP = `用法：fh2-plugin build [选项]\n\n${renderCliOptions(DEFINITION)}`
export const BUILD_CLI_METADATA: CliBehaviorMetadata = {
  behaviorKind: 'manual-description',
  contexts: Object.keys(BUILD_CONTEXT_OPTIONS),
  exitCodes: [{ code: 0, meaning: '构建成功（SIGTERM 优雅终止也返回 0）' }, { code: 1, meaning: '构建失败或上下文发现错误' }, { code: 2, meaning: '参数错误' }, { code: 3, meaning: '内部错误' }, { code: 130, meaning: 'SIGINT 中断' }],
  notes: ['行业 Capability 工作区不支持 --watch/--config/--frontend/--backend；请在具体 Capability 根执行', '独立后端插件不支持 --watch 与 --config', 'Capability 根使用 --config 时必须且只能指定一个 --frontend <pluginId>'],
  source: 'src/commands/build-command.ts#runBuildCommand',
}

export interface BuildSignalSource {
  on: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
  off: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
}

export interface BuildCommandOptions {
  readonly args: readonly string[];
  readonly operationLockHeld?: boolean;
  readonly cwd: string;
  readonly stdout: CommandWriter;
  readonly stderr: CommandWriter;
  readonly signals: BuildSignalSource;
  readonly createRunner?: (options: PluginBuildRunnerOptions) => Promise<PluginBuildSession>;
  readonly buildCapability?: typeof buildCapability;
  readonly buildIndustryCapabilityWorkspace?: typeof buildIndustryCapabilityWorkspace;
  readonly watchCapability?: typeof watchCapability;
  readonly buildBackend?: typeof buildBackendPlugin;
  /** 非 watch 构建路径的 Application Service 注入。 */
  readonly buildProject?: typeof buildProject;
}

export async function runBuildCommand (options: BuildCommandOptions): Promise<number> {
  let parsed: ReturnType<typeof parseBuildArguments>
  try {
    parsed = parseBuildArguments(options.args)
  } catch (error) {
    if (!(error instanceof CliArgumentError)) throw error
    options.stderr.write(`${error.message}\n\n${BUILD_HELP}`)
    return 2
  }
  if (parsed.help) {
    options.stdout.write(BUILD_HELP)
    return 0
  }

  let release: (() => void) | undefined
  try {
    if (parsed.watch && !options.operationLockHeld) release = acquireOperationLock(resolve(options.cwd, parsed.root ?? String(cliDefault(DEFINITION, 'root'))))
    return await executeBuildRequest(options, parsed)
  } catch (error) {
    if (!(error instanceof CapabilityError)) throw error
    options.stderr.write(`${error.code} ${error.message}\n`)
    return 1
  } finally {
    release?.()
  }
}

async function executeBuildRequest (options: BuildCommandOptions, parsed: ReturnType<typeof parseBuildArguments>): Promise<number> {
  const commandRoot = resolve(options.cwd, parsed.root ?? String(cliDefault(DEFINITION, 'root')))
  try {
    const context = tryDiscoverCommandContext(commandRoot)
    if (context === undefined) {
      throw new CapabilityError(
        'FH2_CONTEXT_NOT_FOUND',
        `当前目录不是行业 Capability 工作区、Capability、前端插件或后端插件，没有可构建内容：${commandRoot}`,
        commandRoot,
      )
    }
    const contextOptions = BUILD_CONTEXT_OPTIONS[context.kind]
    if (context.kind === 'industry-capability-workspace') {
      if (parsed.watch && !contextOptions.supportsWatch) throw new CliArgumentError('行业 Capability 工作区暂不支持 build --watch；请在具体 Capability 根执行。')
      if (parsed.configPath !== undefined && !contextOptions.supportsConfig) throw new CliArgumentError('行业 Capability 工作区不支持 --config；请在具体 Capability 根执行。')
      if (!contextOptions.supportsFilters && (parsed.frontend.length > 0 || parsed.backend.length > 0)) {
        throw new CliArgumentError('--frontend/--backend 只能在单个 Capability 根使用。')
      }
    } else if (context.kind === 'capability-project') {
      if (parsed.watch && !contextOptions.supportsWatch) throw new CliArgumentError('Capability 根不支持 build --watch。')
      if (!contextOptions.supportsFilters && (parsed.frontend.length > 0 || parsed.backend.length > 0)) {
        throw new CliArgumentError('Capability 根不支持 --frontend/--backend。')
      }
      if (parsed.configPath !== undefined && (!contextOptions.supportsConfig || !isCapabilityBuildConfigSelection(new Set(parsed.frontend)))) {
        throw new CliArgumentError('Capability 根使用 --config 时必须且只能指定一个 --frontend <pluginId>。')
      }
    } else if (context.kind === 'backend-plugin') {
      if (!contextOptions.supportsFilters && (parsed.frontend.length > 0 || parsed.backend.length > 0)) {
        throw new CliArgumentError('--frontend/--backend 只能在 Capability 根使用。')
      }
      if (parsed.configPath !== undefined && !contextOptions.supportsConfig) throw new CliArgumentError('独立后端插件不支持 --config。')
      if (parsed.watch && !contextOptions.supportsWatch) throw new CliArgumentError('独立后端插件暂不支持 build --watch。')
    } else {
      if (!contextOptions.supportsFilters && (parsed.frontend.length > 0 || parsed.backend.length > 0)) {
        throw new CliArgumentError('--frontend/--backend 只能在 Capability 根使用。')
      }
      if (parsed.watch && !contextOptions.supportsWatch) throw new CliArgumentError('前端插件不支持 build --watch。')
      if (parsed.configPath !== undefined && !contextOptions.supportsConfig) throw new CliArgumentError('前端插件不支持 --config。')
    }
    // Both dispatch paths must pass the same CLI context gate before starting work.
    if (shouldUseBuildTask(options, parsed)) {
      return await runBuildTask(options, commandRoot, context, parsed)
    }
    if (context.kind === 'industry-capability-workspace') {
      options.stdout.write(
        `[workspace ${context.packageManifest.packageId}] build started (${context.capabilities.length} capabilities)\n`,
      )
      const controller = new AbortController()
      let signalCode: 0 | 130 | undefined
      const onSigint = (): void => {
        signalCode ??= 130
        controller.abort()
      }
      const onSigterm = (): void => {
        signalCode ??= 0
        controller.abort()
      }
      options.signals.on('SIGINT', onSigint)
      options.signals.on('SIGTERM', onSigterm)
      try {
        const result = await (options.buildIndustryCapabilityWorkspace ?? buildIndustryCapabilityWorkspace)({
          workspace: context,
          abortSignal: controller.signal,
          onCapabilityEvent: (event) => {
            if (event.type === 'start') {
              options.stdout.write(`[capability ${event.capability.capabilityId}] build started\n`)
              return
            }
            if (event.type === 'success') {
              options.stdout.write(`✓ [capability ${event.capability.capabilityId}] build success\n`)
              return
            }
            options.stderr.write(`[capability ${event.capability.capabilityId}] build failed\n`)
            writeDiagnostics(options.stderr, event.diagnostics)
          },
        })
        if (signalCode !== undefined) return signalCode
        if (!result.ok) {
          writeDiagnostics(options.stderr, result.diagnostics)
          options.stderr.write(`[workspace ${context.packageManifest.packageId}] build failed\n`)
          return 1
        }
        options.stdout.write(`[workspace ${context.packageManifest.packageId}] build success\n`)
        return 0
      } finally {
        options.signals.off('SIGINT', onSigint)
        options.signals.off('SIGTERM', onSigterm)
      }
    }
    if (context?.kind === 'capability-project') {
      const frontendFilter = new Set(parsed.frontend)
      // 任一侧给了过滤，另一侧显式传空集 = 跳过该侧（与帮助文案“只构建指定插件”一致）。
      const filterActive = frontendFilter.size > 0 || parsed.backend.length > 0
      options.stdout.write(`[capability ${context.capabilityId}] build started\n`)
      const controller = new AbortController()
      let signalCode: 0 | 130 | undefined
      let watchSession: Awaited<ReturnType<typeof watchCapability>> | undefined
      const onSigint = (): void => {
        signalCode ??= 130
        controller.abort()
        void watchSession?.close()
      }
      const onSigterm = (): void => {
        signalCode ??= 0
        controller.abort()
        void watchSession?.close()
      }
      options.signals.on('SIGINT', onSigint)
      options.signals.on('SIGTERM', onSigterm)
      const capabilityOptions = {
        capability: context,
        ...(parsed.watch ? { operationLockHeld: true } : {}),
        ...(filterActive
          ? { frontendFilter, backendFilter: new Set(parsed.backend) }
          : {}),
        ...(parsed.configPath === undefined ? {} : { frontendConfigPath: resolve(commandRoot, parsed.configPath) }),
        abortSignal: controller.signal,
        onPluginEvent: (event: import('../capability/build.js').CapabilityBuildEvent) => {
          if (event.type === 'success') {
            options.stdout.write(`✓ [${event.side} ${event.pluginId}] build success（dist/ 已更新）\n`)
            return
          }
          options.stderr.write(`[${event.side} ${event.pluginId}] build failed\n`)
          writeDiagnostics(options.stderr, event.diagnostics)
        },
      }
      let result: Awaited<ReturnType<typeof buildCapability>> | undefined
      try {
        if (parsed.watch) {
          watchSession = await (options.watchCapability ?? watchCapability)(capabilityOptions)
          await watchSession.firstBuild
          const terminal = await watchSession.done
          if (signalCode !== undefined) return signalCode
          if (terminal.reason === 'fatal') {
            writeDiagnostics(options.stderr, terminal.diagnostics)
            return 1
          }
          return 0
        }
        result = await (options.buildCapability ?? buildCapability)(capabilityOptions)
      } catch (error) {
        if (signalCode !== undefined) return signalCode
        throw error
      } finally {
        options.signals.off('SIGINT', onSigint)
        options.signals.off('SIGTERM', onSigterm)
      }
      if (signalCode !== undefined) return signalCode
      if (result === undefined) return 3
      if (!result.ok) writeDiagnostics(options.stderr, result.diagnostics)
      else options.stdout.write(`[capability ${context.capabilityId}] build success\n`)
      return result.ok ? 0 : 1
    }
    if (context?.kind === 'backend-plugin') {
      const result = await (options.buildBackend ?? buildBackendPlugin)(context.root)
      options.stdout.write(`✓ [backend ${result.pluginId}] build success\n`)
      if (result.diagnostics.length > 0) writeDiagnostics(options.stderr, result.diagnostics)
      return 0
    }
  } catch (error) {
    if (error instanceof CliArgumentError) {
      options.stderr.write(`${error.message}\n\n${BUILD_HELP}`)
      return 2
    }
    if (error instanceof CapabilityError) {
      options.stderr.write(`[fh2-plugin] build 失败：${error.code}\n${error.message}\n`)
      return 1
    }
    if (error instanceof PluginBuildError) {
      writeDiagnostics(options.stderr, error.diagnostics)
      return 1
    }
    options.stderr.write(`[fh2-plugin] build 内部错误：${message(error)}\n`)
    return 3
  }

  let failureWasPrinted = false
  const onEvent = (event: PluginBuildEvent): void => {
    if (event.type === 'success') {
      options.stdout.write(`✓ fh2-plugin build #${event.buildId} 成功：${event.distManifest?.id ?? ''}\n`)
      if (event.diagnostics.length > 0) writeDiagnostics(options.stderr, event.diagnostics)
      return
    }
    failureWasPrinted = true
    options.stderr.write(`[fh2-plugin] build #${event.buildId} ${event.type === 'fatal' ? '致命失败' : '失败'}\n`)
    writeDiagnostics(options.stderr, event.diagnostics)
  }

  let session: PluginBuildSession | undefined
  let signalCode: 0 | 130 | undefined
  let signalClose: Promise<void> | undefined
  const onSigint = (): void => {
    if (signalCode !== undefined) return
    signalCode = 130
    signalClose = session?.close()
  }
  const onSigterm = (): void => {
    if (signalCode !== undefined) return
    signalCode = 0
    signalClose = session?.close()
  }

  options.signals.on('SIGINT', onSigint)
  options.signals.on('SIGTERM', onSigterm)
  try {
    session = await (options.createRunner ?? createPluginBuildRunner)({
      cwd: commandRoot,
      ...(parsed.configPath === undefined ? {} : { configPath: resolve(commandRoot, parsed.configPath) }),
      watch: parsed.watch,
      onEvent,
    })
    if (signalCode !== undefined && signalClose === undefined) signalClose = session.close()
    await session.firstBuild
    const terminal = await session.done
    await signalClose
    if (signalCode !== undefined) return signalCode
    return terminal.reason === 'fatal' ? 1 : 0
  } catch (error) {
    if (session !== undefined && signalClose === undefined) signalClose = session.close()
    await signalClose?.catch(() => undefined)
    if (signalCode !== undefined) return signalCode
    if (error instanceof PluginBuildError) {
      if (!failureWasPrinted) writeDiagnostics(options.stderr, error.diagnostics)
      return 1
    }
    options.stderr.write(`[fh2-plugin] build 内部错误：${message(error)}\n`)
    return 3
  } finally {
    options.signals.off('SIGINT', onSigint)
    options.signals.off('SIGTERM', onSigterm)
  }
}

function shouldUseBuildTask (
  options: BuildCommandOptions,
  parsed: ReturnType<typeof parseBuildArguments>,
): boolean {
  if (parsed.watch) {
    return false
  }
  // 旧测试/扩展通过依赖注入验证底层命令适配；有旧注入时保留兼容路径。
  return options.buildCapability === undefined
    && options.buildIndustryCapabilityWorkspace === undefined
    && options.watchCapability === undefined
    && options.buildBackend === undefined
    && options.createRunner === undefined
}

async function runBuildTask (
  options: BuildCommandOptions,
  commandRoot: string,
  context: ReturnType<typeof tryDiscoverCommandContext>,
  parsed: ReturnType<typeof parseBuildArguments>,
): Promise<number> {
  const tasks = createTaskService()
  tasks.registerExecutor('build', createBuildPackExecutor('build', {
    build: options.buildProject ?? buildProject,
  }))
  const owner: TaskOwner = { ownerId: 'cli-build' }
  let taskId: string | undefined
  let signalCode: 0 | 130 | undefined
  const cancel = (code: 0 | 130): void => {
    signalCode ??= code
    if (taskId !== undefined) void tasks.cancel(owner, taskId).catch(() => undefined)
  }
  const onSigint = (): void => cancel(130)
  const onSigterm = (): void => cancel(0)
  options.signals.on('SIGINT', onSigint)
  options.signals.on('SIGTERM', onSigterm)
  try {
    const label = context?.kind === 'industry-capability-workspace'
      ? `[workspace ${context.packageManifest.packageId}]`
      : context?.kind === 'capability-project'
        ? `[capability ${context.capabilityId}]`
        : context?.kind === 'backend-plugin'
          ? `[backend ${context.root.split('/').at(-1) ?? ''}]`
          : '[plugin]'
    options.stdout.write(`${label} build task started\n`)
    const started = await tasks.start(owner, { kind: 'build', root: commandRoot, params: { frontend: parsed.frontend.join(','), backend: parsed.backend.join(','), ...(parsed.configPath ? { configPath: resolve(options.cwd, parsed.configPath) } : {}) } })
    taskId = started.taskId
    if (signalCode !== undefined) {
      await tasks.cancel(owner, taskId).catch(() => undefined)
    }
    const final = await tasks.settle(owner, taskId)
    if (signalCode !== undefined) return signalCode
    if (final.state !== 'succeeded') {
      writeProtocolDiagnostics(options.stderr, final.diagnostics)
      options.stderr.write(`${label} build failed (${final.state})\n`)
      return 1
    }
    options.stdout.write(`${label} build success\n`)
    if (final.stale === true) options.stderr.write('FH2_BUILD_STALE [build]\n构建期间源码发生变化，产物已标记 stale。\n')
    return 0
  } finally {
    options.signals.off('SIGINT', onSigint)
    options.signals.off('SIGTERM', onSigterm)
  }
}

function writeProtocolDiagnostics (writer: CommandWriter, diagnostics: readonly Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const file = diagnostic.file === '' ? '' : ` ${diagnostic.file}`
    const location = diagnostic.line === undefined
      ? ''
      : `:${diagnostic.line}${diagnostic.column === undefined ? '' : `:${diagnostic.column}`}`
    const hint = diagnostic.hint === undefined ? '' : `\n建议：${diagnostic.hint}`
    writer.write(`${diagnostic.code} [${diagnostic.phase}]${file}${location}\n${diagnostic.message}${hint}\n`)
  }
}

export function parseBuildArguments (args: readonly string[]): {
  readonly watch: boolean;
  readonly help: boolean;
  readonly configPath?: string;
  readonly root?: string;
  readonly frontend: readonly string[];
  readonly backend: readonly string[];
} {
  const parsed = parseCommandArguments(args, DEFINITION)
  return {
    watch: parsed.flag('watch'),
    help: parsed.flag('help'),
    frontend: Object.freeze(parsed.multiple.frontend ?? []),
    backend: Object.freeze(parsed.multiple.backend ?? []),
    ...(parsed.values.config === undefined ? {} : { configPath: parsed.values.config }),
    ...(parsed.values.root === undefined ? {} : { root: parsed.values.root }),
  }
}

function writeDiagnostics (writer: CommandWriter, diagnostics: readonly BuildDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const file = diagnostic.file === undefined ? '' : ` ${diagnostic.file}`
    const hint = diagnostic.hint === undefined ? '' : `\n建议：${diagnostic.hint}`
    writer.write(`${diagnostic.code} [${diagnostic.phase}]${file}\n${diagnostic.message}${hint}\n`)
  }
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
