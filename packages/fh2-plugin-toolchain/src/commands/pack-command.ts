// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { resolve } from 'node:path'
import * as esbuild from 'esbuild'
import { cliDefinition, renderCliOptions } from '../cli-definitions.js'
import type { CliBehaviorMetadata } from '../cli-definitions.js'
import { createTaskService } from '../services/tasks/factory.js'
import type { Diagnostic, TaskOwner } from '../contracts/index.js'
import { PluginBuildError } from '../build/types.js'
import { packBackendPlugin, packStandaloneFrontendPlugin } from '../backend/pack.js'
import { packCapability, packIndustryCapabilityWorkspace } from '../capability/pack.js'
import { tryDiscoverCommandContext } from '../capability/discovery.js'
import { CapabilityError } from '../capability/types.js'
import {
  PluginPackError,
  discoverIndustryPluginRoots,
  packIndustryPlugins,
} from '../pack/index.js'
import type { PackIndustryPluginsOptions } from '../pack/index.js'
import { packProject } from '../services/application/pack.js'
import { failureLocationHint } from '../services/application/failure-location.js'
import { createBuildPackExecutor } from '../services/tasks/executors/build-pack.js'
import { CliArgumentError, parseCommandArguments } from './arguments.js'
import { runBuildCommand } from './build-command.js'
import type { BuildCommandOptions, BuildSignalSource } from './build-command.js'
import type { CommandWriter } from './validate-command.js'

const DEFINITION = cliDefinition('pack')
export const PACK_HELP = `用法：fh2-plugin pack [选项]

按当前目录上下文分流：
  行业 Capability 工作区（packages.json）构建全部 Capability 并生成单个上传 zip
  Capability 根（capabilities.json）   生成平台可上传 zip（含 packages.json）
  前端插件目录（fh2-plugin.json）      生成独立前端插件交付物 + zip
  后端插件目录（fh2-plugin.json）      生成独立后端插件交付物 + zip
  行业包根（plugins/*）                保留旧聚合行为

${renderCliOptions(DEFINITION)}`
export const PACK_CLI_METADATA: CliBehaviorMetadata = {
  behaviorKind: 'manual-description',
  contexts: ['industry-capability-workspace', 'capability-project', 'frontend-plugin', 'backend-plugin', 'legacy-industry-plugins-root'],
  exitCodes: [{ code: 0, meaning: '打包成功（SIGTERM 优雅终止也返回 0）' }, { code: 1, meaning: '打包/构建失败或上下文发现错误' }, { code: 2, meaning: '参数错误' }, { code: 3, meaning: '内部错误' }, { code: 130, meaning: 'SIGINT 中断' }],
  successSignals: ['UPLOAD_READY <zipPath>'],
  notes: ['标准 TaskService 路径对 Capability、行业工作区和独立插件的 zip 输出 UPLOAD_READY；底层依赖注入兼容路径只在 Capability/行业工作区输出该信号', '插件级 Pack 先执行一次默认 build，失败则透传其退出码', '--no-build 只能在 Capability 根执行'],
  source: 'src/commands/pack-command.ts#runPackCommand',
}

export interface PackCommandOptions {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdout: CommandWriter;
  readonly stderr: CommandWriter;
  readonly signals: BuildSignalSource;
  readonly runBuild?: (options: BuildCommandOptions) => Promise<number>;
  readonly discoverPluginRoots?: typeof discoverIndustryPluginRoots;
  readonly pack?: (options: PackIndustryPluginsOptions) => ReturnType<typeof packIndustryPlugins>;
  readonly resolveContext?: typeof tryDiscoverCommandContext;
  readonly packCapability?: typeof packCapability;
  readonly packIndustryCapabilityWorkspace?: typeof packIndustryCapabilityWorkspace;
  /** 标准（无 out-dir、非旧行业 plugins/*）路径的 Application Service 注入。 */
  readonly packProject?: typeof packProject;
}

export async function runPackCommand (options: PackCommandOptions): Promise<number> {
  let legacyRoot: string | undefined
  try {
    const parsed = parseCommandArguments(options.args, DEFINITION)
    if (parsed.flag('help')) {
      options.stdout.write(PACK_HELP)
      return 0
    }

    const commandRoot = resolve(options.cwd, parsed.value('root')!)
    const context = (options.resolveContext ?? tryDiscoverCommandContext)(commandRoot)
    const outputRoot = resolve(commandRoot, parsed.value('out-dir', { mode: context?.kind ?? 'legacy-industry-plugins-root' })!)
    // 标准 Capability/工作区/独立插件 Pack 统一走 TaskService + S7。
    // 自定义 out-dir 与旧 plugins/* 聚合保留兼容路径。
    if (context !== undefined && shouldUsePackTask(options, parsed, context)) {
      return await runPackTask(options, commandRoot, context, parsed.flag('no-build'), outputRoot)
    }
    if (context?.kind === 'industry-capability-workspace') {
      if (parsed.flag('no-build')) {
        throw new CliArgumentError('行业 Capability 工作区 Pack 会始终先构建全部 Capability，不支持 --no-build。')
      }
      let signalCode: 0 | 130 | undefined
      const onSigint = (): void => {
        signalCode = 130
      }
      const onSigterm = (): void => {
        signalCode = 0
      }
      options.signals.on('SIGINT', onSigint)
      options.signals.on('SIGTERM', onSigterm)
      try {
        const result = await (options.packIndustryCapabilityWorkspace ?? packIndustryCapabilityWorkspace)({
          workspace: context,
          outputRoot,
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
          },
        })
        if (signalCode !== undefined) return signalCode
        options.stdout.write(`✓ 行业 Capability 工作区包已生成：${result.zipPath}\n`)
        options.stdout.write(`UPLOAD_READY ${result.zipPath}\n`)
        for (const warning of result.warnings)
          options.stderr.write(`${warning.code} [pack]${warning.file === undefined ? '' : ` ${warning.file}`}\n${warning.message}\n`)
        return 0
      } finally {
        options.signals.off('SIGINT', onSigint)
        options.signals.off('SIGTERM', onSigterm)
        // DAG-020-04：CLI 进程结束前显式关停 esbuild service 子进程 —— 它不随宿主
        // 退出而退出，残留进程会污染外部进程组观察（harness 逐进程对账时拒绝）。
        esbuild.stop()
      }
    }
    if (context?.kind === 'capability-project') {
      let signalCode: 0 | 130 | undefined
      const onSigint = (): void => {
        signalCode = 130
      }
      const onSigterm = (): void => {
        signalCode = 0
      }
      options.signals.on('SIGINT', onSigint)
      options.signals.on('SIGTERM', onSigterm)
      try {
        const result = await (options.packCapability ?? packCapability)({
          capability: context,
          ...(parsed.flag('no-build') ? { noBuild: true } : {}),
          outputRoot,
        })
        if (signalCode !== undefined) return signalCode
        options.stdout.write(`✓ Capability 包已生成：${result.zipPath}\n`)
        options.stdout.write(`UPLOAD_READY ${result.zipPath}\n`)
        for (const warning of result.warnings)
          options.stderr.write(`${warning.code} [pack]${warning.file === undefined ? '' : ` ${warning.file}`}\n${warning.message}\n`)
        return 0
      } finally {
        options.signals.off('SIGINT', onSigint)
        options.signals.off('SIGTERM', onSigterm)
        // DAG-020-04：CLI 进程结束前显式关停 esbuild service 子进程 —— 它不随宿主
        // 退出而退出，残留进程会污染外部进程组观察（harness 逐进程对账时拒绝）。
        esbuild.stop()
      }
    }
    if (parsed.flag('no-build')) {
      throw new CliArgumentError('--no-build 只能在 Capability 根执行。')
    }

    // 插件级 Pack：先按明确 Manifest 识别前端/后端插件目录。
    if (context?.kind === 'frontend-plugin' || context?.kind === 'backend-plugin') {
      const pluginRoot = context.root
      let signalCode: 0 | 130 | undefined
      const onSigint = (): void => {
        signalCode = 130
      }
      const onSigterm = (): void => {
        signalCode = 0
      }
      options.signals.on('SIGINT', onSigint)
      options.signals.on('SIGTERM', onSigterm)
      try {
        const buildCode = await (options.runBuild ?? runBuildCommand)({
          args: [],
          cwd: pluginRoot,
          stdout: options.stdout,
          stderr: options.stderr,
          signals: options.signals,
        })
        if (signalCode !== undefined) return signalCode
        if (buildCode !== 0) return buildCode

        const result = context.kind === 'frontend-plugin'
          ? await packStandaloneFrontendPlugin({ projectRoot: pluginRoot, outputRoot })
          : await packBackendPlugin({ pluginRoot, outputRoot })
        if (signalCode !== undefined) return signalCode
        options.stdout.write(`✓ 插件交付物已生成：${result.zipPath}\n`)
        for (const warning of result.warnings)
          options.stderr.write(`${warning.code} [pack]${warning.file === undefined ? '' : ` ${warning.file}`}\n${warning.message}\n`)
        return 0
      } finally {
        options.signals.off('SIGINT', onSigint)
        options.signals.off('SIGTERM', onSigterm)
        // DAG-020-04：CLI 进程结束前显式关停 esbuild service 子进程 —— 它不随宿主
        // 退出而退出，残留进程会污染外部进程组观察（harness 逐进程对账时拒绝）。
        esbuild.stop()
      }
    }

    legacyRoot = commandRoot
    const pluginRoots = (options.discoverPluginRoots ?? discoverIndustryPluginRoots)(commandRoot)
    let signalCode: 0 | 130 | undefined
    const onSigint = (): void => {
      signalCode = 130
    }
    const onSigterm = (): void => {
      signalCode = 0
    }
    options.signals.on('SIGINT', onSigint)
    options.signals.on('SIGTERM', onSigterm)
    try {
      for (const pluginRoot of pluginRoots) {
        if (signalCode !== undefined) return signalCode
        const buildCode = await (options.runBuild ?? runBuildCommand)({
          args: [],
          cwd: pluginRoot,
          stdout: options.stdout,
          stderr: options.stderr,
          signals: options.signals,
        })
        if (signalCode !== undefined) return signalCode
        if (buildCode !== 0) return buildCode
      }

      const result = await (options.pack ?? packIndustryPlugins)({
        industryRoot: commandRoot,
        pluginRoots,
        outputRoot,
      })
      if (signalCode !== undefined) return signalCode
      options.stdout.write(`✓ fh2-plugin pack 成功：${result.packages.length} 个插件已聚合到 ${result.outputRoot}\n`)
      for (const warning of result.warnings)
        options.stderr.write(`${warning.code} [pack]${warning.file === undefined ? '' : ` ${warning.file}`}\n${warning.message}\n`)
      return 0
    } finally {
      options.signals.off('SIGINT', onSigint)
      options.signals.off('SIGTERM', onSigterm)
    }
  } catch (error) {
    if (error instanceof CliArgumentError) {
      options.stderr.write(`${error.message}\n\n${PACK_HELP}`)
      return 2
    }
    if (error instanceof CapabilityError) {
      options.stderr.write(`[fh2-plugin] pack 失败：${error.code}\n${error.message}\n`)
      return 1
    }
    if (error instanceof PluginBuildError) {
      for (const diagnostic of error.diagnostics)
        options.stderr.write(`${diagnostic.code} [${diagnostic.phase}]${diagnostic.file === undefined ? '' : ` ${diagnostic.file}`}\n${diagnostic.message}\n`)
      return 1
    }
    if (error instanceof PluginPackError) {
      const diagnostic = error.diagnostic
      if (legacyRoot !== undefined && diagnostic.code === 'FH2_PACK_PLUGINS_READ_FAILED')
        options.stderr.write(failureLocationHint('pack', legacyRoot))
      options.stderr.write(`${diagnostic.code} [pack]${diagnostic.file === undefined ? '' : ` ${diagnostic.file}`}\n${diagnostic.message}\n`)
      return 1
    }
    options.stderr.write(`[fh2-plugin] pack 内部错误：${message(error)}\n`)
    return 3
  }
}

function shouldUsePackTask (
  options: PackCommandOptions,
  parsed: ReturnType<typeof parseCommandArguments>,
  context: ReturnType<typeof tryDiscoverCommandContext>,
): boolean {
  if (context === undefined) return false
  return options.runBuild === undefined
    && options.packCapability === undefined
    && options.packIndustryCapabilityWorkspace === undefined
    && options.pack === undefined
    && options.discoverPluginRoots === undefined
}

async function runPackTask (
  options: PackCommandOptions,
  commandRoot: string,
  context: Exclude<ReturnType<typeof tryDiscoverCommandContext>, undefined>,
  noBuild: boolean,
  outputRoot?: string,
): Promise<number> {
  if (context.kind === 'industry-capability-workspace' && noBuild) {
    throw new CliArgumentError('行业 Capability 工作区 Pack 会始终先构建全部 Capability，不支持 --no-build。')
  }
  if (noBuild && context.kind !== 'capability-project') {
    throw new CliArgumentError('--no-build 只能在 Capability 根执行。')
  }
  const tasks = createTaskService()
  tasks.registerExecutor('pack', createBuildPackExecutor('pack', {
    pack: options.packProject ?? packProject,
  }))
  const owner: TaskOwner = { ownerId: 'cli-pack' }
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
    const label = context.kind === 'industry-capability-workspace'
      ? `[workspace ${context.packageManifest.packageId}]`
      : context.kind === 'capability-project'
        ? `[capability ${context.capabilityId}]`
        : '[plugin]'
    options.stdout.write(`${label} pack task started\n`)
    const started = await tasks.start(owner, {
      kind: 'pack',
      root: commandRoot,
      params: { ...(noBuild ? { noBuild: true } : {}), ...(outputRoot ? { outputRoot } : {}) },
    })
    taskId = started.taskId
    if (signalCode !== undefined) await tasks.cancel(owner, taskId).catch(() => undefined)
    const final = await tasks.settle(owner, taskId)
    if (signalCode !== undefined) return signalCode
    if (final.state !== 'succeeded') {
      writePackDiagnostics(options.stderr, final.diagnostics)
      options.stderr.write(`${label} pack failed (${final.state})\n`)
      return 1
    }
    const artifact = final.artifacts.find(candidate => candidate.kind === 'capability-package')
    const output = artifact === undefined ? '' : resolve(commandRoot, artifact.path)
    options.stdout.write(`✓ ${label} 包已生成：${output}\n`)
    if (output !== '') options.stdout.write(`UPLOAD_READY ${output}\n`)
    if (final.stale === true) options.stderr.write('FH2_PACK_STALE [pack]\n打包期间源码发生变化，产物已标记 stale。\n')
    return 0
  } finally {
    options.signals.off('SIGINT', onSigint)
    options.signals.off('SIGTERM', onSigterm)
  }
}

function writePackDiagnostics (writer: CommandWriter, diagnostics: readonly Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const file = diagnostic.file === '' ? '' : ` ${diagnostic.file}`
    const location = diagnostic.line === undefined
      ? ''
      : `:${diagnostic.line}${diagnostic.column === undefined ? '' : `:${diagnostic.column}`}`
    const hint = diagnostic.hint === undefined ? '' : `\n建议：${diagnostic.hint}`
    writer.write(`${diagnostic.code} [${diagnostic.phase}]${file}${location}\n${diagnostic.message}${hint}\n`)
  }
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
