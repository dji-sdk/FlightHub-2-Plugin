// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { cliDefinition, renderCliOptions } from '../cli-definitions.js'
import type { CliBehaviorMetadata } from '../cli-definitions.js'
import { parseCommandArguments } from '../commands/arguments.js'
import { ServiceWorkerSupervisor, resolveServiceWorkerEntry } from '../services/tasks/supervisor.js'
import type { ApplicationServiceHost } from '../services/tasks/service-host.js'
import { type WorkspaceAccess, canonicalizeAllowedRoot } from './guard.js'
import { formatClientConfigGuide } from './guide.js'
import { loadKnowledgeBundle, resolveContractRoot } from './knowledge/loader.js'
import { createKnowledgeService } from './knowledge/service.js'
import type { KnowledgeService } from './knowledge/service.js'
import { createFh2McpServer } from './server.js'

/**
 * M2：MCP stdio 入口（`fh2-plugin mcp [--root <dir>]`，由 CLI 分发惰性加载）。
 *
 * - stdout 只承载 MCP 协议帧：业务执行全部走 worker 子进程（T4）；
 * - 双模式（v3.9 §3）：默认开放（任意绝对路径 / 相对启动 cwd，baseDir 不冻结）；
 *   `--root` 显式开启收纳模式（canonicalizeAllowedRoot 冻结真实路径）；
 * - 严格参数解析：未知旗标、位置参数、重复 --root 均以退出码 2 拒绝；
 * - 退出清理：SIGINT/SIGTERM/stdin 关闭 → worker shutdown（stopOwned）→ 退出。
 */

const DEFINITION = cliDefinition('mcp')
export const MCP_USAGE = `启动 FH2 插件工具链 stdio MCP Server（AI 客户端经 stdio 接入）。

用法：fh2-plugin mcp [--root <directory>]

${renderCliOptions(DEFINITION)}`
export const MCP_CLI_METADATA: CliBehaviorMetadata = {
  behaviorKind: 'manual-description',
  contexts: [],
  exitCodes: [{ code: 0, meaning: 'stdio MCP Server 正常退出' }, { code: 1, meaning: '服务启动失败' }, { code: 2, meaning: '参数或收纳根非法' }],
  notes: ['默认开放模式允许任意绝对路径；--root 显式开启收纳模式'],
  source: 'src/mcp/main.ts#runMcpMain',
}

export type McpRootResolution =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly message: string }

/**
 * 解析收纳模式 allowed root（仅在 --root 出现时调用，args 须含 `--root <dir>`）：
 * - 相对路径按 cwd 解析，经 canonicalizeAllowedRoot（realpath）冻结为真实路径；
 * - 目标必须是已存在的普通目录，否则快速失败（退出码 2）。
 */
export function resolveRootArg (args: readonly string[], cwd: string): McpRootResolution {
  const rootIndex = args.indexOf('--root')
  if (rootIndex === -1) {
    return { ok: false, message: 'resolveRootArg 仅在 --root 出现时调用。resolveRootArg requires --root.' }
  }
  const rawRoot = args[rootIndex + 1]
  if (rawRoot === undefined || rawRoot === '' || rawRoot.startsWith('--')) {
    return {
      ok: false,
      message: 'fh2-plugin mcp 需要 --root <directory>（相对路径按当前工作目录解析）。--root <directory> is required.',
    }
  }
  try {
    return { ok: true, root: canonicalizeAllowedRoot(resolve(cwd, rawRoot)) }
  } catch {
    // realpath 失败多为目录不存在；给出解析后的目标便于定位。
    return { ok: false, message: `--root 指向的目录不存在或不可访问：${resolve(cwd, rawRoot)}` }
  }
}

/**
 * 严格解析 mcp 子命令参数：只接受 --root <dir>、--root=<dir>、--help、-h。
 * 未知旗标、位置参数、重复 --root 返回错误（退出码 2）；help 返回用法请求。
 */
export type McpArgsParse =
  | { readonly kind: 'help' }
  | { readonly kind: 'run'; readonly rootArg?: string }
  | { readonly kind: 'error'; readonly message: string }

export function parseMcpArgs (args: readonly string[]): McpArgsParse {
  try {
    const parsed = parseCommandArguments(args, DEFINITION)
    if (parsed.flag('help')) return { kind: 'help' }
    const rootArg = parsed.values.root
    return { kind: 'run', ...(rootArg === undefined ? {} : { rootArg }) }
  } catch (error) {
    return { kind: 'error', message: (error as Error).message }
  }
}

/**
 * 运行 mcp 子命令，返回进程退出码：参数/目标非法为 2，启动失败为 1。
 * 正常路径启动 stdio Server 后返回 0；进程此后由 stdin 关闭与信号事件驱动退出。
 */
export async function runMcpMain (args: readonly string[]): Promise<number> {
  const parsed = parseMcpArgs(args)
  if (parsed.kind === 'help') {
    process.stdout.write(MCP_USAGE)
    process.stdout.write('\n')
    process.stdout.write(formatClientConfigGuide(resolveGuideInput()))
    process.stdout.write('\n')
    return 0
  }
  if (parsed.kind === 'error') {
    process.stderr.write(`${parsed.message}\n`)
    return 2
  }

  // 双模式（v3.9 §3）：--root 出现 = contained（边界收纳）；默认 = open
  // （baseDir 仅作相对路径基准，不冻结、不校验——任意目录可操作）。
  let access: WorkspaceAccess
  if (parsed.rootArg === undefined) {
    access = { mode: 'open', baseDir: process.cwd() }
  } else {
    const resolved = resolveRootArg(['--root', parsed.rootArg], process.cwd())
    if (!resolved.ok) {
      process.stderr.write(`${resolved.message}\n`)
      return 2
    }
    access = { mode: 'contained', root: resolved.root }
  }

  // 知识层 fail-closed（§9.3）：契约包加载/校验失败即启动失败，不带残缺知识运行。
  let knowledge: KnowledgeService
  try {
    knowledge = createKnowledgeService(loadKnowledgeBundle(resolveContractRoot()))
  } catch (error) {
    process.stderr.write(`fh2-plugin mcp 知识层初始化失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  const supervisor = new ServiceWorkerSupervisor(resolveServiceWorkerEntry())
  supervisor.setLogListener((stream, line) => {
    process.stderr.write(`[worker:${stream}] ${line}\n`)
  })

  const host: ApplicationServiceHost = {
    ownerLabel: 'mcp-worker',
    inspect: root => supervisor.call('inspect', root, {}),
    validate: root => supervisor.call('validate', root, {}),
    generate: (root, check) => supervisor.call('generate', root, { check }),
    create: (root, params) => supervisor.call('create', root, { ...params }),
    taskStart: (kind, root, params) => supervisor.taskStart(`task-${randomUUID()}`, kind, root, { ...params }),
    taskGet: taskId => supervisor.taskGet(taskId),
    taskCancel: taskId => supervisor.taskCancel(taskId),
    taskSubscribe: (listener) => {
      supervisor.setTaskEventListener(listener)
      return () => supervisor.setTaskEventListener(() => undefined)
    },
    stopOwned: () => supervisor.shutdown(),
  }

  const server = createFh2McpServer({ access, host, version: await readVersion(), knowledge })

  // stdin 关闭 = 客户端断开：清理 worker 后退出。
  process.stdin.on('end', () => {
    void supervisor.shutdown().finally(() => process.exit(0))
  })
  const onSignal = (): void => {
    void supervisor.shutdown().finally(() => process.exit(0))
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    const transport = new StdioServerTransport()
    await server.connect(transport)
  } catch (error) {
    process.stderr.write(`fh2-plugin mcp 启动失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  if (access.mode === 'contained') {
    process.stderr.write(`fh2-plugin mcp ready (root: ${access.root}, contained)\n`)
  } else {
    process.stderr.write('fh2-plugin mcp ready (open)\n')
  }
  // 手工启动（TTY）时附配置指南；AI 客户端 spawn（非 TTY）只保留一行 ready，
  // 避免每次连接在客户端日志里刷屏。
  if (process.stderr.isTTY === true) {
    process.stderr.write('\n')
    process.stderr.write(formatClientConfigGuide(resolveGuideInput()))
    process.stderr.write('\n')
  }
  return 0
}

/**
 * 指南形态与路径：
 * - `argv[1]` basename 无扩展名（fh2-plugin）= npm 全局 bin 的 symlink（含
 *   npm/pnpm link）→ installed 形态，主推 `["fh2-plugin","mcp"]`；
 * - `fh2-plugin.mjs` = 仓内直跑 → dev 形态，主推「绝对 Node + 绝对 bin」
 *   （相对路径在客户端 spawn cwd 下不可解析）。
 * 绝对路径恒定生成（realpath），用于备选兜底段。
 */
function resolveGuideInput (): { form: 'installed' | 'dev'; nodePath: string; binPath: string } {
  const nodePath = process.execPath
  const rawBin = process.argv[1] ?? 'fh2-plugin'
  const basename = rawBin.split('/').pop() ?? rawBin
  const form: 'installed' | 'dev' = basename === 'fh2-plugin' ? 'installed' : 'dev'
  let binPath = rawBin
  try {
    binPath = realpathSync(rawBin)
  } catch {
    // 保留原值（如 claude mcp add 场景由 shell 解析）。
  }
  return { form, nodePath, binPath }
}

async function readVersion (): Promise<string> {
  try {
    const pkg = await import('../manifest.js')
    return pkg.TOOLCHAIN_VERSION
  } catch {
    return '0.0.0'
  }
}
