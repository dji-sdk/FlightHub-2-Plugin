// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { generatePluginTypes } from 'fh2-plugin-sdk/generator'
import { cliDefinition, renderCliOptions } from '../cli-definitions.js'
import type { CliBehaviorMetadata } from '../cli-definitions.js'
import { acquireOperationLock } from '../services/tasks/operation-lock.js'
import { generateProject } from '../services/application/generate.js'
import { tryDiscoverCommandContext } from '../capability/discovery.js'
import { CapabilityError } from '../capability/types.js'
import { generatePluginTypes as generateBackendPluginTypes } from '../backend/typegen/plugin-types.js'
import {
  GeneratedTypesPathError,
  writeGeneratedTypes,
} from '../generate/write-generated-types.js'
import { formatValidationResultText, validateSourceManifest } from '../validate/index.js'
import { GENERATED_BACKEND_TYPE_FILES, syncPluginTypes } from '../backend/typegen/sync.js'
import { CliArgumentError, parseCommandArguments } from './arguments.js'
import type { CommandWriter } from './validate-command.js'

export interface GenerateCommandOptions {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdout: CommandWriter;
  readonly stderr: CommandWriter;
  readonly validate?: typeof validateSourceManifest;
  readonly generator?: typeof generatePluginTypes;
  readonly writeTypes?: typeof writeGeneratedTypes;
}

const DEFINITION = cliDefinition('generate')
export const GENERATE_HELP = `用法：fh2-plugin generate [选项]\n\n${renderCliOptions(DEFINITION)}
Capability 根会同时重生成前端 src/generated/plugin-types.ts 与后端 types/
（后端产物与 fh2-plugin types 命令一致；后端只投影 Host 注入面与 allowlist）。
`
export const GENERATE_CLI_METADATA: CliBehaviorMetadata = {
  behaviorKind: 'manual-description',
  contexts: ['industry-capability-workspace', 'capability-project', 'frontend-plugin', 'backend-plugin'],
  exitCodes: [{ code: 0, meaning: '类型已是最新或成功写入' }, { code: 1, meaning: 'Manifest 校验失败或类型缺失/过期' }, { code: 2, meaning: '参数错误或输出路径非法' }, { code: 3, meaning: '内部错误' }],
  notes: ['Capability 根同时重生成前端 src/generated/plugin-types.ts 与后端 types/（与 fh2-plugin types 一致）', 'Capability 根使用 --out 时必须同时用 --manifest 明确指定一个前端插件'],
  source: 'src/commands/generate-command.ts#runGenerateCommand',
}

export function runGenerateCommand (options: GenerateCommandOptions): number {
  let release: (() => void) | undefined
  try {
    const parsed = parseCommandArguments(options.args, DEFINITION)
    if (parsed.flag('help')) {
      options.stdout.write(GENERATE_HELP)
      return 0
    }

    const commandRoot = resolve(options.cwd, parsed.value('root')!)
    if (parsed.values.manifest === undefined && parsed.values.out === undefined && !options.validate && !options.generator && !options.writeTypes) {
      const result = generateProject(commandRoot, { check: parsed.flag('check'), frontendOutDir: parsed.value('out')! })
      for (const diagnostic of result.diagnostics) options.stderr.write(`${diagnostic.code} ${diagnostic.message}\n`)
      for (const file of result.files) options.stdout.write(`✓ 类型已生成到 ${file}\n`)
      return result.ok ? 0 : 1
    }
    const context = parsed.values.manifest === undefined
      ? tryDiscoverCommandContext(commandRoot)
      : undefined
    if (context?.kind === 'capability-project'
      && parsed.values.out !== undefined
      && parsed.values.manifest === undefined) {
      throw new CliArgumentError('Capability 根使用 --out 时必须同时用 --manifest 明确指定一个前端插件。')
    }
    if (parsed.values.manifest === undefined && parsed.values.out === undefined) {
      if (context?.kind === 'capability-project') {
        let exitCode = 0
        for (const frontend of context.frontend) {
          options.stdout.write(`[frontend ${frontend.id}]\n`)
          const code = runGenerateCommand({
            ...options,
            args: parsed.flag('check') ? ['--check'] : [],
            cwd: frontend.root,
          })
          exitCode = Math.max(exitCode, code)
        }
        // 后端 types/ 与前端 plugin-types.ts 是两套产物；后端仅生成 Host 注入面声明。
        for (const backend of context.backend) {
          options.stdout.write(`[backend ${backend.id}]\n`)
          const code = runBackendTypesGeneration(backend.root, options.stdout, parsed.flag('check'))
          exitCode = Math.max(exitCode, code)
        }
        return exitCode
      }
      if (context?.kind === 'backend-plugin') {
        return runBackendTypesGeneration(commandRoot, options.stdout, parsed.flag('check'))
      }
    }

    const manifestPath = resolve(commandRoot, parsed.value('manifest')!)
    const projectRoot = dirname(manifestPath)
    const outValue = parsed.value('out')!
    const outDir = isAbsolute(outValue) ? resolve(outValue) : resolve(projectRoot, outValue)
    const validation = (options.validate ?? validateSourceManifest)({ manifestPath })
    if (!validation.ok) {
      options.stdout.write(formatValidationResultText(validation, basename(manifestPath)))
      return 1
    }

    if (!parsed.flag('check') && !options.writeTypes) release = acquireOperationLock(projectRoot)
    const result = (options.writeTypes ?? writeGeneratedTypes)({
      manifest: validation.manifest,
      generator: options.generator ?? generatePluginTypes,
      manifestPath,
      outDir,
      check: parsed.flag('check'),
    })
    const outputPath = relativeOutputPath(projectRoot, result.outputFile)
    if (!result.ok) {
      options.stdout.write(`类型文件${result.status === 'missing' ? '缺失' : '已过期'}：${outputPath}\n请运行 fh2-plugin generate 更新。\n`)
      return 1
    }
    const message = result.status === 'written'
      ? '类型已生成到'
      : result.status === 'current'
        ? '类型文件已是最新'
        : '类型内容未变化'
    options.stdout.write(`✓ ${message} ${outputPath}\n`)
    return 0
  } catch (error) {
    if (error instanceof CliArgumentError || error instanceof GeneratedTypesPathError) {
      options.stderr.write(`${error.message}\n\n${GENERATE_HELP}`)
      return 2
    }
    if (error instanceof CapabilityError) {
      options.stderr.write(`[fh2-plugin] generate 失败：${error.code}\n${error.message}\n`)
      return 1
    }
    options.stderr.write(`[fh2-plugin] generate 内部错误：${errorMessage(error)}\n`)
    return 3
  } finally {
    release?.()
  }
}

function relativeOutputPath (projectRoot: string, outputFile: string): string {
  const value = relative(projectRoot, outputFile).split(sep).join('/')
  return value.startsWith('.') ? value : `./${value}`
}

/** 后端插件的 types/ 重生成（与 fh2-plugin types 命令同一产物；check=true 只比对不写）。 */
function runBackendTypesGeneration (backendRoot: string, stdout: CommandWriter, check: boolean): number {
  try {
    const result = generateBackendPluginTypes(backendRoot)
    const typesDir = join(backendRoot, 'types')
    if (check) {
      return checkBackendTypes(typesDir, result.files, stdout)
    }
    syncPluginTypes(backendRoot)
    stdout.write(`✓ 后端类型已生成到 ./types/（${result.files.size} 个文件）\n`)
    return 0
  } catch (error) {
    stdout.write(`后端类型生成失败：${errorMessage(error)}\n运行 fh2-plugin types --root ${basename(backendRoot)} 查看详情。\n`)
    return 1
  }
}

function checkBackendTypes (
  typesDir: string,
  files: ReadonlyMap<string, string>,
  stdout: CommandWriter,
): number {
  const problems: string[] = []
  if (!existsSync(typesDir)) {
    problems.push('types/ 不存在')
  } else {
    for (const [file, source] of files) {
      const onDisk = existsSync(join(typesDir, file))
        ? readFileSync(join(typesDir, file), 'utf8')
        : undefined
      if (onDisk !== source) problems.push(`types/${file} 不是最新`)
    }
    for (const entry of readdirSync(typesDir)) {
      if (GENERATED_BACKEND_TYPE_FILES.has(entry) && !files.has(entry)) {
        problems.push(`types/${entry} 不在生成清单内`)
      }
    }
  }
  if (problems.length > 0) {
    stdout.write(`后端类型已过期：\n  - ${problems.join('\n  - ')}\n`)
    return 1
  }
  stdout.write(`✓ 后端类型已是最新（${files.size} 个文件）\n`)
  return 0
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
