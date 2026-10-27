// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { basename, dirname, resolve } from 'node:path'
import { cliDefinition, renderCliOptions } from '../cli-definitions.js'
import type { CliBehaviorMetadata } from '../cli-definitions.js'
import { validateBackendSourcePlugin } from '../backend/source-contract.js'
import { resolvePluginBuildDescriptor } from '../build/runner.js'
import { tryDiscoverCommandContext } from '../capability/discovery.js'
import {
  formatCapabilityValidationResult,
  validateCapability,
} from '../capability/validate.js'
import { CapabilityError } from '../capability/types.js'
import { validateProject } from '../services/application/validate.js'
import { failureLocationHint } from '../services/application/failure-location.js'
import {
  formatValidationResultJson,
  formatValidationResultText,
  validateSourceManifest,
} from '../validate/index.js'
import {
  checkSourceCodeConsistency,
  isBlockingCodeConsistencyDiagnostic,
} from '../validate/code-consistency.js'
import { CliArgumentError, parseCommandArguments } from './arguments.js'

export interface CommandWriter {
  write(chunk: string): unknown;
}

export interface ValidateCommandOptions {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdout: CommandWriter;
  readonly stderr: CommandWriter;
  readonly validate?: typeof validateSourceManifest;
  readonly checkCode?: typeof checkSourceCodeConsistency;
  readonly resolveDescriptor?: typeof resolvePluginBuildDescriptor;
  readonly validateProject?: typeof validateProject;
}

const DEFINITION = cliDefinition('validate')
export const VALIDATE_HELP = `用法：fh2-plugin validate [选项]\n\n后端插件使用 --root <后端目录>，不要传 --manifest 或 --config；显式 --manifest 只走前端清单校验。\n\n${renderCliOptions(DEFINITION)}`
export const VALIDATE_CLI_METADATA: CliBehaviorMetadata = {
  behaviorKind: 'manual-description',
  contexts: ['industry-capability-workspace', 'capability-project', 'frontend-plugin', 'backend-plugin'],
  exitCodes: [
    { code: 0, meaning: '校验通过（源码一致性 warning 不改变退出码）' },
    { code: 1, meaning: '校验失败、阻断级源码一致性诊断或上下文发现错误' },
    { code: 2, meaning: '参数错误' },
    { code: 3, meaning: '内部错误' },
  ],
  notes: ['显式 --manifest 时不做上下文发现，仅使用前端清单校验；后端使用 --root，不传 --manifest 或 --config', 'Capability 根使用 --config 时必须同时用 --manifest 指定一个前端插件'],
  source: 'src/commands/validate-command.ts#runValidateCommand',
}

export async function runValidateCommand (options: ValidateCommandOptions): Promise<number> {
  let format: 'text' | 'json' = 'text'
  try {
    const parsed = parseCommandArguments(options.args, DEFINITION)
    if (parsed.flag('help')) {
      options.stdout.write(VALIDATE_HELP)
      return 0
    }
    format = parsed.value('format') as 'text' | 'json'

    const commandRoot = resolve(options.cwd, parsed.value('root')!)
    const context = parsed.values.manifest === undefined
      ? tryDiscoverCommandContext(commandRoot)
      : undefined
    // 行业工作区（S2）：fan-out 校验全部成员 Capability，单成员失败不中断后续成员。
    if (context?.kind === 'industry-capability-workspace') {
      const result = options.validateProject !== undefined
        ? options.validateProject(commandRoot)
        : validateProject(commandRoot)
      if (format === 'json') {
        options.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      } else {
        for (const member of result.members) {
          if (member.ok) {
            options.stdout.write(`✓ [capability ${member.label}] validate success\n`)
            continue
          }
          options.stderr.write(`[capability ${member.label}] validate failed\n`)
          for (const diagnostic of member.diagnostics) {
            options.stderr.write(`  ${diagnostic.code} ${diagnostic.file}\n    ${diagnostic.message}\n`)
          }
        }
        if (result.ok) {
          options.stdout.write(`[workspace ${context.packageManifest.packageId}] validate success\n`)
        } else {
          options.stderr.write(`[workspace ${context.packageManifest.packageId}] validate failed\n`)
        }
      }
      return result.ok ? 0 : 1
    }
    if (context?.kind === 'capability-project'
      && parsed.values.config !== undefined
      && parsed.values.manifest === undefined) {
      throw new CliArgumentError('Capability 根使用 --config 时必须同时用 --manifest 明确指定一个前端插件。')
    }
    if (context?.kind === 'backend-plugin'
      && parsed.values.config !== undefined
      && parsed.values.manifest === undefined) {
      throw new CliArgumentError('后端插件校验不支持 --config；请直接在后端插件根运行，或显式 --manifest 走前端清单校验。')
    }
    if (parsed.values.manifest === undefined && parsed.values.config === undefined) {
      if (context?.kind === 'capability-project') {
        const result = validateCapability(context, options.validate ?? validateSourceManifest)
        options.stdout.write(formatCapabilityValidationResult(result, format))
        return result.ok ? 0 : 1
      }
      if (context?.kind === 'backend-plugin') {
        // 后端目录是作者源码：Source Contract 允许受约束 ESM（import/export 由 Backend Bundler 消化）。
        const result = validateBackendSourcePlugin(context.root)
        options.stdout.write(formatBackendValidationResult(result, context.root, format))
        return result.ok ? 0 : 1
      }
    }

    const manifestPath = resolve(commandRoot, parsed.value('manifest')!)
    const result = (options.validate ?? validateSourceManifest)({ manifestPath })
    if (result.ok) {
      let warnings
      if (options.checkCode !== undefined) {
        warnings = options.checkCode({ manifest: result.manifest, manifestPath })
      } else {
        try {
          const descriptor = await (options.resolveDescriptor ?? resolvePluginBuildDescriptor)({
            cwd: dirname(manifestPath),
            ...(parsed.values.config === undefined ? {} : { configPath: resolve(commandRoot, parsed.values.config) }),
            expectedManifestPath: manifestPath,
          })
          warnings = checkSourceCodeConsistency({ manifest: result.manifest, manifestPath, descriptor })
        } catch (error) {
          warnings = [{
            code: 'FH2_CODE_SOURCE_LAYOUT_UNRESOLVED',
            phase: 'code' as const,
            file: basename(manifestPath),
            message: `无法按 Rsbuild config 解析源码布局：${errorMessage(error)}。Source layout could not be resolved from Rsbuild config: ${errorMessage(error)}.`,
          }]
        }
      }
      const blocking = warnings.filter(isBlockingCodeConsistencyDiagnostic)
      if (blocking.length > 0) {
        const failed = { ok: false as const, diagnostics: blocking }
        options.stdout.write(format === 'json'
          ? formatValidationResultJson(failed)
          : formatValidationResultText(failed, basename(manifestPath)))
        return 1
      }
      const withWarnings = { ...result, warnings }
      options.stdout.write(format === 'json'
        ? formatValidationResultJson(withWarnings)
        : formatValidationResultText(withWarnings, basename(manifestPath)))
      return 0
    }
    if (context === undefined && parsed.values.manifest === undefined && parsed.values.config === undefined
      && result.diagnostics.some(diagnostic => diagnostic.code === 'FH2_MANIFEST_READ_FAILED')) {
      options.stderr.write(failureLocationHint('validate', commandRoot))
    }
    options.stdout.write(format === 'json'
      ? formatValidationResultJson(result)
      : formatValidationResultText(result, basename(manifestPath)))
    return 1
  } catch (error) {
    if (error instanceof CliArgumentError) {
      options.stderr.write(`${error.message}\n\n${VALIDATE_HELP}`)
      return 2
    }
    if (format === 'json') {
      options.stdout.write(formatValidationResultJson({
        ok: false,
        diagnostics: [{
          code: error instanceof CapabilityError ? error.code : 'FH2_VALIDATE_INTERNAL',
          phase: 'parse',
          file: error instanceof CapabilityError && error.file !== undefined ? basename(error.file) : '.',
          message: errorMessage(error),
        }],
      }))
    }
    if (error instanceof CapabilityError) {
      options.stderr.write(`[fh2-plugin] validate 失败：${error.code}\n${error.message}\n`)
      return 1
    }
    options.stderr.write(`[fh2-plugin] validate 内部错误：${errorMessage(error)}\n`)
    return 3
  }
}

function formatBackendValidationResult (
  result: ReturnType<typeof validateBackendSourcePlugin>,
  root: string,
  format: 'text' | 'json',
): string {
  if (format === 'json') return `${JSON.stringify(result, null, 2)}\n`
  if (result.ok) return `[backend ${basename(root)}] validate success\n`
  return `${result.diagnostics.map((diagnostic) => {
    const path = diagnostic.path === undefined ? '' : ` ${diagnostic.path}`
    return `[backend ${basename(root)}] ${diagnostic.code} ${diagnostic.file}${path}\n${diagnostic.message}`
  }).join('\n')}\n`
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
