// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { failureLocationHint } from '../services/application/failure-location.js'
import { cliDefinition, renderCliOptions } from '../cli-definitions.js'
import type { CliBehaviorMetadata } from '../cli-definitions.js'
import { GENERATED_BACKEND_TYPE_FILES, syncPluginTypes } from '../backend/typegen/sync.js'
import { generatePluginTypes } from '../backend/typegen/plugin-types.js'
import { parseCommandArguments } from './arguments.js'
import type { CommandWriter } from './validate-command.js'

/**
 * fh2-plugin types —— 后端插件的类型生成(生成器②)。
 *
 * 读 allowlist + 源码 import 图，产出 types/ 下按世界拆分的 Host ambient 声明。
 * schema.sql 只服务运行时实体/DDL，不投影为插件 TypeScript 业务模型。--check 只比对不写(CI regen-diff 用法)。
 *
 * 与 fh2-plugin generate(前端 plugin-types.ts)是两个产物:generate 面向前端
 * Manifest,types 面向后端 plugin.json。
 */

export interface TypesCommandOptions {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdout: CommandWriter;
  readonly stderr: CommandWriter;
}

const DEFINITION = cliDefinition('types')
export const TYPES_HELP = `用法：fh2-plugin types [选项]\n\n为后端插件生成 Host ambient 类型（types/ 目录，按调用形态分世界）。\n\n${renderCliOptions(DEFINITION)}`
export const TYPES_CLI_METADATA: CliBehaviorMetadata = {
  behaviorKind: 'manual-description',
  contexts: ['backend-plugin'],
  exitCodes: [{ code: 0, meaning: 'types/ 已是最新或成功生成' }, { code: 1, meaning: '未找到后端插件清单、types/ 过期或未捕获异常（CLI 主入口按 1 处理）' }, { code: 2, meaning: '参数错误' }],
  notes: ['为后端插件生成 Host ambient 类型（types/ 目录，按调用形态分世界）', '只清理本命令拥有的固定产物，不删除作者自行放入 types/ 的文件'],
  source: 'src/commands/types-command.ts#runTypesCommand',
}

interface TypesArguments {
  readonly root: string;
  readonly check: boolean;
  readonly help: boolean;
}

export function runTypesCommand (options: TypesCommandOptions): number {
  let parsed: TypesArguments
  try {
    parsed = parseTypesArguments(options.args, options.cwd)
  } catch (error) {
    options.stderr.write(`${(error as Error).message}\n\n${TYPES_HELP}`)
    return 2
  }
  if (parsed.help) {
    options.stdout.write(TYPES_HELP)
    return 0
  }
  if (!existsSync(join(parsed.root, 'fh2-plugin.json'))) {
    options.stderr.write(`未找到后端插件清单：${join(parsed.root, 'fh2-plugin.json')}\n`)
    options.stderr.write(failureLocationHint('types', parsed.root))
    return 1
  }

  const result = generatePluginTypes(parsed.root)
  const typesDir = join(parsed.root, 'types')

  if (parsed.check) {
    const problems: string[] = []
    if (!existsSync(typesDir)) {
      problems.push('types/ 不存在 —— 运行 fh2-plugin types 生成')
    } else {
      for (const [file, source] of result.files) {
        const onDisk = existsSync(join(typesDir, file))
          ? readFileSyncSafe(join(typesDir, file))
          : undefined
        if (onDisk !== source) problems.push(`types/${file} 与 fh2-plugin.json/源码的最新生成不一致`)
      }
      for (const entry of readdirSync(typesDir)) {
        if (GENERATED_BACKEND_TYPE_FILES.has(entry) && !result.files.has(entry)) {
          problems.push(`types/${entry} 不在生成清单内（手改过?确认后删除）`)
        }
      }
    }
    if (problems.length > 0) {
      options.stderr.write(`生成类型已过期：\n  - ${problems.join('\n  - ')}\n运行 fh2-plugin types 更新。\n`)
      return 1
    }
    options.stdout.write(`生成类型最新（${result.files.size} 个文件）。\n`)
    return 0
  }

  syncPluginTypes(parsed.root)
  options.stdout.write(`已生成 ${result.files.size} 个类型文件到 types/（世界: ${[...new Set([...result.worlds.values()].flat())].join(' ')}）\n`)
  return 0
}

function parseTypesArguments (args: readonly string[], cwd: string): TypesArguments {
  const parsed = parseCommandArguments(args, DEFINITION)
  const root = parsed.value('root', { cwd })!
  return {
    root,
    check: parsed.flag('check'),
    help: parsed.flag('help'),
  }
}

function readFileSyncSafe (path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
