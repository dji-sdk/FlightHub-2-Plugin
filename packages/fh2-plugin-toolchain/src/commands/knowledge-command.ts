// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * `fh2-plugin knowledge` —— 后端插件知识包的安装、固定与状态查询（计划 §B2）。
 *
 * 三个子命令，各自的边界刻意分开：
 *   import  把知识包装进 Toolchain 受控缓存，逐文件校验完整性。**不动项目锁**。
 *   use     把项目锁指向某个已安装的身份。**不装任何东西**。
 *   status  报当前固定的是哪份、本机装了哪些、缺什么。只读。
 *
 * ★★ import 与 use 分开是刻意的：装上不等于用上。合成一个命令会让
 * 「我只是想看看这份知识带了什么」变成「顺手改了项目锁」——而锁是进 Git 的。
 *
 * ⚠️ 切版本必须显式（`use <id>`），不跟随 latest：知识版本决定了检查结论，
 * 它悄悄变了等于昨天的「检查通过」今天不再成立，而没有任何提示。
 */

import { relative, resolve } from 'node:path'
import { cliDefinition, renderCliArguments, renderCliOptions } from '../cli-definitions.js'
import type { CliBehaviorMetadata } from '../cli-definitions.js'
import {
  KNOWLEDGE_LOCK_FILENAME,
  SUPPORTED_KNOWLEDGE_FORMAT_VERSION,
} from '../contracts/knowledge.js'
import { KnowledgeInstallError, findInstalled, importKnowledge, knowledgeCacheRoot, listInstalled } from '../knowledge/install.js'
import { KnowledgeLockError, readLock, writeLock } from '../knowledge/lock.js'
import { describeContents, resolveKnowledgeStatus } from '../knowledge/resolve.js'
import type { CommandWriter } from './validate-command.js'
import { parseCommandArguments } from './arguments.js'

export interface KnowledgeCommandOptions {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdout: CommandWriter;
  readonly stderr: CommandWriter;
}

const DEFINITION = cliDefinition('knowledge')
export const KNOWLEDGE_HELP = `用法：fh2-plugin knowledge <子命令>

管理后端插件知识包（平台契约的唯一事实来源：动作 I/O、Host 能力、DSL 词法、Schema、类型）。

${renderCliArguments(DEFINITION)}${renderCliOptions(DEFINITION)}
import 安装并校验完整性（不改项目锁）；use 固定已安装身份；status 只读查询。
use/status 的锁文件为 ${KNOWLEDGE_LOCK_FILENAME}。

知识包由 worker 仓生成：
  cd <worker> && go run ./cmd/pluginknowledge build --out .work/kb --package
  fh2-plugin knowledge import <worker>/.work/kb/backend-plugin-knowledge-<id>.tar.gz

也可直接指向未打包的目录（本地开发）：
  fh2-plugin knowledge import <worker>/.work/kb/backend-plugin-knowledge-<id>
`
export const KNOWLEDGE_CLI_METADATA: CliBehaviorMetadata = {
  behaviorKind: 'manual-description',
  contexts: [],
  exitCodes: [{ code: 0, meaning: '安装/固定/查询成功' }, { code: 1, meaning: '知识包校验失败、项目锁冲突或未捕获异常（CLI 主入口按 1 处理）' }, { code: 2, meaning: '参数错误' }],
  notes: ['import 不改项目锁，use 不安装知识包，status 只读；省略子命令返回 2'],
  source: 'src/commands/knowledge-command.ts#runKnowledgeCommand',
}

interface ParsedArguments {
  readonly subcommand: string;
  readonly positional: readonly string[];
  readonly root: string;
  readonly force: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

function parseArguments (args: readonly string[], cwd: string): ParsedArguments {
  const parsed = parseCommandArguments(args, DEFINITION)
  const [subcommand = '', ...positional] = parsed.positional
  return { subcommand, positional, root: resolve(cwd, parsed.value('root')!), force: parsed.flag('force'), json: parsed.flag('json'), help: parsed.flag('help') }
}

export async function runKnowledgeCommand (options: KnowledgeCommandOptions): Promise<number> {
  let parsed: ParsedArguments
  try {
    parsed = parseArguments(options.args, options.cwd)
  } catch (error) {
    options.stderr.write(`${(error as Error).message}\n\n${KNOWLEDGE_HELP}`)
    return 2
  }

  if (parsed.help) {
    options.stdout.write(KNOWLEDGE_HELP)
    return 0
  }

  switch (parsed.subcommand) {
    case 'import': return runImport(parsed, options)
    case 'use': return runUse(parsed, options)
    case 'status': return runStatus(parsed, options)
    case '':
      options.stderr.write(`缺少子命令。\n\n${KNOWLEDGE_HELP}`)
      return 2
    default:
      options.stderr.write(`未知子命令 ${parsed.subcommand}。\n\n${KNOWLEDGE_HELP}`)
      return 2
  }
}

async function runImport (parsed: ParsedArguments, options: KnowledgeCommandOptions): Promise<number> {
  const source = parsed.positional[0]
  if (source === undefined) {
    options.stderr.write(`import 需要一个知识包目录或 .tar.gz。\n\n${KNOWLEDGE_HELP}`)
    return 2
  }
  try {
    const installed = await importKnowledge({ source: resolve(options.cwd, source), force: parsed.force })
    const contents = describeContents(installed)
    options.stdout.write(
      `已安装知识包 ${installed.knowledgeId}\n`
      + `  bundleDigest     ${installed.bundleDigest}\n`
      + `  workerRevision   ${installed.manifest.workerRevision}\n`
      + `  contractsVersion ${installed.manifest.contractsVersion}\n`
      + `  载荷             ${installed.manifest.files.length} 份`
      + `（docs ${contents.docs.length} / catalog ${contents.catalogs.length}`
      + ` / schemas ${contents.schemas.length} / types ${contents.types.length}`
      + ` / examples ${contents.examples.length}）\n`
      + `  缓存             ${installed.directory}\n`,
    )
    if (installed.manifest.local === true) {
      options.stdout.write(
        '  ⚠️ local=true：这份包出自脏工作区或拿不到 revision，**不是可发布的 release**。\n'
        + '     它可以用来试用，但同一个 ID 可能对应不同内容 —— 别把它当作可复现的检查基准。\n',
      )
    }
    if (installed.manifest.checkers.length === 0) {
      options.stdout.write(
        '  ⚠️ checkers 为空：没有同版本权威 checker。编辑器只能做浏览器快速预检，\n'
        + '     不能显示「可部署」或「真实运行已验证」。\n',
      )
    }
    options.stdout.write(`\n下一步：fh2-plugin knowledge use ${installed.knowledgeId}\n`)
    return 0
  } catch (error) {
    if (error instanceof KnowledgeInstallError) {
      options.stderr.write(`安装失败：${error.message}\n`)
      return 1
    }
    throw error
  }
}

async function runUse (parsed: ParsedArguments, options: KnowledgeCommandOptions): Promise<number> {
  const knowledgeId = parsed.positional[0]
  if (knowledgeId === undefined) {
    const installed = await listInstalled()
    options.stderr.write(
      `use 需要一个 knowledge-id。\n${
        installed.length === 0
          ? `本机还没装任何知识包（缓存：${knowledgeCacheRoot()}）。先 import。\n`
          : `已安装：\n${installed.map(item => `  ${item.knowledgeId}  ${item.bundleDigest.slice(0, 12)}`).join('\n')}\n`}`,
    )
    return 2
  }
  const installed = await findInstalled(knowledgeId)
  if (installed === undefined) {
    options.stderr.write(
      `本机没有安装知识 ${knowledgeId}。\n`
      + '  ⚠️ 刻意不在这里顺手去装：use 只改项目锁，装什么由 import 显式决定。\n',
    )
    return 1
  }
  const lock = await writeLock(parsed.root, {
    knowledgeId: installed.knowledgeId,
    bundleDigest: installed.bundleDigest,
  })
  const lockRelative = relative(options.cwd, resolve(parsed.root, KNOWLEDGE_LOCK_FILENAME)) || KNOWLEDGE_LOCK_FILENAME
  options.stdout.write(
    `已固定知识 ${lock.knowledgeId}\n`
    + `  写入 ${lockRelative}\n`
    + `  bundleDigest ${lock.bundleDigest}\n`
    + '  ⓘ 锁文件只含身份与摘要，不含 URL、凭据或可执行路径；它应当提交进 Git。\n',
  )
  return 0
}

async function runStatus (parsed: ParsedArguments, options: KnowledgeCommandOptions): Promise<number> {
  let status
  try {
    status = await resolveKnowledgeStatus(parsed.root)
  } catch (error) {
    if (error instanceof KnowledgeLockError) {
      options.stderr.write(`${error.message}\n`)
      return 1
    }
    throw error
  }

  if (parsed.json) {
    options.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
    // ⚠️ 有阻断项时退出码非零：CI 里 `knowledge status --json` 要能当门禁用。
    return status.problems.length > 0 ? 1 : 0
  }

  options.stdout.write(`知识包格式版本：${SUPPORTED_KNOWLEDGE_FORMAT_VERSION}\n缓存：${knowledgeCacheRoot()}\n\n`)

  if (status.active !== undefined) {
    const active = status.active
    options.stdout.write(
      `当前固定：${active.knowledgeId}\n`
      + `  bundleDigest     ${active.bundleDigest}\n`
      + `  workerRevision   ${active.workerRevision}\n`
      + `  contractsVersion ${active.contractsVersion}\n`
      + `  gojaVersion      ${active.gojaVersion}\n`
      + `  内容             docs ${active.contents.docs.length} / catalog ${active.contents.catalogs.length}`
      + ` / schemas ${active.contents.schemas.length} / types ${active.contents.types.length}`
      + ` / examples ${active.contents.examples.length}`
      + ` / skill ${active.contents.hasSkill ? '有' : '无'}\n`,
    )
    if (active.local) options.stdout.write('  ⚠️ local=true：不是可发布的 release\n')
  } else if (status.locked) {
    options.stdout.write('当前固定：有锁文件，但解析不到可用知识（见下方阻断项）\n')
  } else {
    options.stdout.write(
      `当前固定：无（项目里没有 ${KNOWLEDGE_LOCK_FILENAME}）\n`
      + '  ⚠️ 未固定时编辑器用 Toolchain 内建手抄快照，它可能与目标 worker 版本已漂移。\n',
    )
  }

  options.stdout.write(
    `\ncheckerAvailable：${String(status.checkerAvailable)}\n`
    + '  ⚠️ 本轮没有同版本权威 checker。浏览器快速预检**不等于**可部署或真实运行已验证。\n',
  )

  options.stdout.write(`\n已安装（${status.installed.length}）：\n`)
  if (status.installed.length === 0) {
    options.stdout.write('  （空）\n')
  } else {
    for (const item of status.installed) {
      options.stdout.write(
        `  ${item.knowledgeId}  ${item.bundleDigest.slice(0, 12)}  ${item.workerRevision.slice(0, 12)}`
        + `${item.local ? '  [local]' : ''}\n`,
      )
    }
  }

  if (status.problems.length > 0) {
    options.stdout.write(`\n阻断项（${status.problems.length}）：\n`)
    for (const problem of status.problems) options.stdout.write(`  - ${problem}\n`)
    return 1
  }
  return 0
}

/** 项目当前锁的身份（给别处诊断用；没有锁回 undefined）。 */
export function currentLockedKnowledgeId (projectRoot: string): string | undefined {
  try {
    return readLock(projectRoot)?.knowledgeId
  } catch {
    return undefined
  }
}
