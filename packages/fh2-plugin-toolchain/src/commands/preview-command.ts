// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { cliDefinition, renderCliOptions } from '../cli-definitions.js'
import type { CliBehaviorMetadata } from '../cli-definitions.js'
import type { ParsedPreviewArguments, PreviewProject, PreviewProjectOptions } from '../services/application/preview.js'
import { previewProject } from '../services/application/preview.js'
import { discoverCapabilityFrontendOnly } from '../capability/discovery.js'
import { CapabilityError } from '../capability/types.js'
import { PROJECT_PATHS } from '../project-policy.js'
import { CliArgumentError, parseCommandArguments } from './arguments.js'

const DEFINITION = cliDefinition('preview')
export const PREVIEW_HELP = `用法：fh2-plugin preview [选项]\n\n${renderCliOptions(DEFINITION)}`
export const PREVIEW_CLI_METADATA: CliBehaviorMetadata = {
  behaviorKind: 'manual-description',
  contexts: ['capability-project', 'frontend-plugin'],
  exitCodes: [{ code: 0, meaning: '预览正常退出（SIGTERM 优雅终止也返回 0）' }, { code: 1, meaning: '构建失败、HTTP Origin Proxy 错误或插件 ID 变更' }, { code: 2, meaning: '参数错误' }, { code: 3, meaning: '内部错误' }, { code: 130, meaning: 'SIGINT 中断（第二次 Ctrl+C 强制退出）' }],
  notes: ['Capability Preview 仅使用本地前端；后端使用目标司空环境已安装版本', '--plugin 不能与 --manifest 或 --config 同时使用', 'Preview 仅支持完整 HTTP URL，通过 PAC 使用受限 Origin Proxy，不支持 HTTPS 目标', '人工操作指南：HTTP PAC 配置 → 同一 Origin 登录并进入项目页 → 打开调试面板地址 → 手动填写完整插件来源URL → 校验、勾选同意、确认并重载；面板地址只设置 debug，不预填来源或 session'],
  source: 'src/commands/preview-command.ts#runPreviewCommand',
}

export { PREVIEW_SESSION_QUERY, PREVIEW_SOURCE_QUERY, resolvePreviewTarget, withPluginDebugQuery, openSystemBrowser } from '../services/application/preview.js'
export type { PreviewSignalSource, ParsedPreviewArguments, PreviewProject } from '../services/application/preview.js'
export interface PreviewCommandOptions extends PreviewProjectOptions {
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

export async function runPreviewCommand (options: PreviewCommandOptions): Promise<number> {
  let raw: ReturnType<typeof parseCommandArguments>
  let parsed: ParsedPreviewArguments
  let commandRoot: string
  try {
    raw = parseCommandArguments(options.args, DEFINITION)
    commandRoot = resolve(options.cwd, raw.value('root')!)
    parsed = resolvePreviewArguments(raw, commandRoot)
  } catch (error) {
    if (error instanceof CliArgumentError) {
      options.stderr.write(`${error.message}\n\n${PREVIEW_HELP}`)
      return 2
    }
    throw error
  }
  if (raw.flag('help')) {
    options.stdout.write(PREVIEW_HELP)
    return 0
  }
  const frontend = raw.multiple.frontend ?? []
  const hasExplicitPlugin = (raw.multiple.plugin?.length ?? 0) > 0
  const hasExplicitManifest = raw.values.manifest !== undefined
  const hasExplicitConfig = raw.values.config !== undefined
  const capabilityRoot = existsSync(join(commandRoot, PROJECT_PATHS.capabilityMetadata))
  if (frontend.length > 0 && (hasExplicitPlugin || hasExplicitManifest || !capabilityRoot)) {
    options.stderr.write(`--frontend 只能在 Capability 根 Preview 使用。\n\n${PREVIEW_HELP}`)
    return 2
  }
  if (!hasExplicitPlugin && !hasExplicitManifest && capabilityRoot) {
    try {
      if (hasExplicitConfig) {
        throw new CliArgumentError('Capability Preview 不支持 --config；请在单个前端插件目录执行自定义 config preview。')
      }
      const capability = discoverCapabilityFrontendOnly(commandRoot)
      const selected = frontend.length === 0
        ? capability.frontend
        : selectCapabilityFrontend(capability.frontend, frontend)
      options.stdout.write(`⚠ Capability Preview 仅使用本地前端；后端使用目标司空环境已安装版本。\n`)
      return await previewProject({ ...parsed, projects: selected.map(project => ({
        projectRoot: project.root,
        manifestPath: project.manifestPath,
        pluginsDir: resolve(project.root, PROJECT_PATHS.dist),
      })) }, options)
    } catch (error) {
      if (error instanceof CliArgumentError) {
        options.stderr.write(`${error.message}\n\n${PREVIEW_HELP}`)
        return 2
      }
      if (error instanceof CapabilityError) {
        options.stderr.write(`[fh2-plugin] preview 失败：${error.code}\n${error.message}\n`)
        return 1
      }
      options.stderr.write(`[fh2-plugin] preview 内部错误：${error instanceof Error ? error.message : String(error)}\n`)
      return 3
    }
  }

  return previewProject(parsed, options)
}

function selectCapabilityFrontend<T extends { readonly id: string }> (
  projects: readonly T[],
  filter: readonly string[],
): readonly T[] {
  const known = new Set(projects.map(project => project.id))
  for (const id of filter) {
    if (!known.has(id)) throw new CliArgumentError(`Capability 内不存在 frontend 插件 ${id}。`)
  }
  return projects.filter(project => filter.includes(project.id))
}

export function parsePreviewArguments (
  args: readonly string[],
  cwd: string,
): ParsedPreviewArguments {
  const parsed = parseCommandArguments(args, DEFINITION)
  return resolvePreviewArguments(parsed, resolve(cwd, parsed.value('root')!))
}

function resolvePreviewArguments (parsed: ReturnType<typeof parseCommandArguments>, cwd: string): ParsedPreviewArguments {
  const pluginPaths = parsed.multiple.plugin ?? []
  const port = Number(parsed.value('port'))
  const manifestPath = resolve(cwd, parsed.value('manifest')!)
  const projects: PreviewProject[] = pluginPaths.length === 0
    ? [{
        manifestPath,
        projectRoot: dirname(manifestPath),
        pluginsDir: resolve(dirname(manifestPath), PROJECT_PATHS.dist),
        ...(parsed.values.config === undefined ? {} : { configPath: resolve(cwd, parsed.values.config) }),
      }]
    : pluginPaths.map((pluginPath) => {
        const projectRoot = resolve(cwd, pluginPath)
        return {
          manifestPath: resolve(projectRoot, parsed.value('manifest')!),
          projectRoot,
          pluginsDir: resolve(projectRoot, PROJECT_PATHS.dist),
        }
      })
  return {
    projects,
    port,
    watch: parsed.flag('watch'),
    noOpen: parsed.flag('no-open'),
    help: parsed.flag('help'),
    ...(parsed.values['fh2-url'] === undefined ? {} : { fh2Url: parsed.values['fh2-url'] }),
  }
}
