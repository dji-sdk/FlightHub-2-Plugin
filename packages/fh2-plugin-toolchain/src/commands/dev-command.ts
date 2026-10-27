// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { dirname, resolve } from 'node:path'
import { cliDefinition, renderCliArguments, renderCliOptions } from '../cli-definitions.js'
import type { CliBehaviorMetadata } from '../cli-definitions.js'
import type { DevProjectOptions, ParsedDevArguments } from '../services/application/dev.js'
import { devProject } from '../services/application/dev.js'

import { CliArgumentError, parseCommandArguments } from './arguments.js'

const DEFINITION = cliDefinition('dev')
export const DEV_HELP = `用法：fh2-plugin dev [cockpit] [选项]

${renderCliArguments(DEFINITION)}在后端插件目录（fh2-plugin.json）执行时：只 Build + Watch 后端并启动本地
/plugin-api/plugin/invoke 调试 Gateway，不启动前端 Workbench。

${renderCliOptions(DEFINITION)}`
export const DEV_CLI_METADATA: CliBehaviorMetadata = {
  behaviorKind: 'manual-description',
  contexts: ['capability-project', 'frontend-plugin', 'backend-plugin'],
  exitCodes: [{ code: 0, meaning: 'Dev Server 正常退出（SIGTERM 优雅终止也返回 0）' }, { code: 1, meaning: '构建失败、Dev/Gateway 启动失败或上下文发现错误' }, { code: 2, meaning: '参数错误' }, { code: 3, meaning: '内部错误' }, { code: 130, meaning: 'SIGINT 中断（第二次 Ctrl+C 强制退出）' }],
  notes: ['在后端插件目录执行时只 Build + Watch 后端并启动本地调试 Gateway，不启动前端 Workbench', '--watch 与 --no-watch、--frontend-only 与 --backend-only 互斥', '--gateway-target 需要环境变量 FH2_DEV_LOGIN_TOKEN', 'cockpit 固定驾驶舱路由，project+message+cockpit 仍按路由拓扑挂载'],
  source: 'src/commands/dev-command.ts#runDevCommand',
}

export type { DevSignalSource, WorkbenchDistPaths, ParsedDevArguments } from '../services/application/dev.js'
export { resolveWorkbenchDist } from '../services/application/dev.js'
export interface DevCommandOptions extends DevProjectOptions {
  readonly args: readonly string[];
}

export async function runDevCommand (options: DevCommandOptions): Promise<number> {
  let parsed: ParsedDevArguments
  try {
    parsed = parseDevArguments(options.args, options.cwd)
  } catch (error) {
    if (!(error instanceof CliArgumentError)) throw error
    options.stderr.write(`${error.message}\n\n${DEV_HELP}`)
    return 2
  }
  if (parsed.help) {
    options.stdout.write(DEV_HELP)
    return 0
  }

  return devProject(parsed, options)
}

export function parseDevArguments (args: readonly string[], cwd: string): ParsedDevArguments {
  const parsed = parseCommandArguments(args, DEFINITION)
  const workbenchMode = parsed.positional[0] === 'cockpit' ? 'cockpit' : 'all'
  const frontend = parsed.multiple.frontend ?? []
  const backend = parsed.multiple.backend ?? []
  const port = Number(parsed.value('port', { mode: workbenchMode }))
  const commandRoot = resolve(cwd, parsed.value('root')!)
  const manifestPath = resolve(commandRoot, parsed.value('manifest')!)
  const projectRoot = dirname(manifestPath)
  return {
    workbenchMode,
    manifestPath,
    ...(parsed.values.manifest === undefined ? {} : { manifestExplicit: true }),
    projectRoot,
    pluginsDir: parsed.values['plugins-dir'] === undefined
      ? [parsed.value('plugins-dir', { projectRoot })!]
      : parsed.values['plugins-dir']
          .split(',')
          .map(dir => dir.trim())
          .filter(dir => dir.length > 0)
          .map(dir => resolve(commandRoot, dir)),
    port,
    watch: parsed.flag('watch'),
    frontendOnly: parsed.flag('frontend-only'),
    ...(parsed.flag('backend-only') ? { backendOnly: true } : {}),
    help: parsed.flag('help'),
    ...(frontend.length === 0 ? {} : { frontend: Object.freeze(frontend) }),
    ...(backend.length === 0 ? {} : { backend: Object.freeze(backend) }),
    ...(parsed.values.root === undefined ? {} : { root: commandRoot }),
    ...(parsed.values['plugins-dir'] === undefined ? {} : { pluginsDirExplicit: true }),
    ...(parsed.values.config === undefined ? {} : { configPath: resolve(commandRoot, parsed.values.config) }),
    ...(parsed.values['gateway-target'] === undefined ? {} : { gatewayTarget: parsed.values['gateway-target'] }),
  }
}
