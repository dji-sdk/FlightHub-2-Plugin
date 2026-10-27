// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { Buffer } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { tryDiscoverCommandContext } from '../../../capability/discovery.js'

/**
 * Dev/Build/Pack 的前置依赖保障：检测缺失 node_modules 的安装根并自动补装。
 *
 * - 安装根枚举：工作区（有 workspaces/pnpm-workspace.yaml 的根）只装根一份
 *   （frontend 成员由 workspace 覆盖）；无工作区的插件根与 capability 的
 *   backend 成员各自独立 package.json → 逐个检测安装；
 * - 包管理器检测：lockfile 优先 → npm_config_user_agent → npm；
 * - 安装进程固定命令（npm/pnpm/yarn install），SIGTERM → 宽限 → SIGKILL。
 */

export type PackageManagerName = 'npm' | 'pnpm' | 'yarn'

export interface InstallRunOptions {
  readonly emitLog: (stream: 'stdout' | 'stderr', line: string) => void;
  readonly signal: AbortSignal;
  /** 注入点：单测替换真实子进程。 */
  readonly spawnInstall?: (manager: PackageManagerName, cwd: string) => InstallChildProcess;
}

/** install 子进程的最小消费面（真实 spawn 与测试桩共同实现）。 */
export interface InstallChildProcess {
  onData (stream: 'stdout' | 'stderr', listener: (chunk: Buffer) => void): void;
  onExit (listener: (code: number | null) => void): void;
  onError (listener: (error: Error) => void): void;
  kill (signal: NodeJS.Signals): void;
}

/** 需要独立执行 install 的根：缺 node_modules 时才出现在结果里。 */
export function resolveInstallRoots (root: string): readonly string[] {
  const context = tryDiscoverCommandContext(root)
  if (context === undefined) {
    return needsInstall(root) ? [root] : []
  }
  const roots: string[] = []
  // 根：有 workspaces（或 pnpm-workspace.yaml）时一份根安装覆盖 frontend 成员；
  // 无工作区结构的插件根也装自身
  if (needsInstall(root)) roots.push(root)
  // backend 成员：独立 package.json（不在 workspace 声明里），逐个检测
  if (context.kind === 'capability-project') {
    for (const backend of context.backend) {
      if (needsInstall(backend.root)) roots.push(backend.root)
    }
  }
  if (context.kind === 'industry-capability-workspace') {
    for (const capability of context.capabilities) {
      for (const backend of capability.backend) {
        if (needsInstall(backend.root)) roots.push(backend.root)
      }
    }
  }
  return roots
}

function needsInstall (root: string): boolean {
  return existsSync(join(root, 'package.json')) && !existsSync(join(root, 'node_modules'))
}

/** lockfile 优先 → UA → npm；与 CLI create 的检测口径对齐。 */
export function detectPackageManager (root: string, userAgent: string | undefined): PackageManagerName {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'package-lock.json'))) return 'npm'
  if (userAgent !== undefined) {
    if (userAgent.startsWith('pnpm/')) return 'pnpm'
    if (userAgent.startsWith('yarn/')) return 'yarn'
    if (userAgent.startsWith('npm/')) return 'npm'
  }
  return 'npm'
}

/**
 * 对所有缺失依赖的根执行 install（串行：npm/pnpm 并发写同盘容易互相踩）。
 * 已全部安装时是 no-op；任一失败抛错（调用方转为任务失败）。
 */
export async function ensureDependenciesInstalled (root: string, options: InstallRunOptions): Promise<void> {
  const roots = resolveInstallRoots(root)
  if (roots.length === 0) return
  const manager = detectPackageManager(root, process.env.npm_config_user_agent)
  for (const installRoot of roots) {
    options.emitLog('stdout', `检测到 ${relativeLabel(root, installRoot)} 缺少依赖，自动执行 ${manager} install…`)
    await runPackageManagerInstall(manager, installRoot, options)
  }
}

function relativeLabel (root: string, target: string): string {
  return target === root ? '工程' : target.slice(root.length + 1)
}

/**
 * 共享的 install 子进程执行（install executor 与 ensureDependenciesInstalled 复用）。
 * SIGTERM → 5s 宽限 → SIGKILL；退出码非 0 抛错。
 */
export async function runPackageManagerInstall (
  manager: PackageManagerName,
  cwd: string,
  options: InstallRunOptions,
): Promise<void> {
  options.emitLog('stdout', `$ ${manager} install`)
  const spawnInstall = options.spawnInstall ?? defaultSpawnInstall
  const child = spawnInstall(manager, cwd)
  const consume = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() !== '') options.emitLog(stream, line)
    }
  }
  child.onData('stdout', chunk => consume('stdout', chunk))
  child.onData('stderr', chunk => consume('stderr', chunk))
  const exited = new Promise<number | null>((resolveExit) => {
    child.onExit(exitCode => resolveExit(exitCode))
    child.onError(() => resolveExit(null))
  })
  const stop = (): void => {
    child.kill('SIGTERM')
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
    killTimer.unref()
  }
  options.signal.addEventListener('abort', stop, { once: true })
  try {
    const code = await exited
    if (options.signal.aborted) throw new AbortedInstallError()
    if (code !== 0) {
      throw new Error(`依赖安装失败（${manager} install @ ${cwd}，退出码 ${code ?? '信号中断'}）。Dependency install failed.`)
    }
  } finally {
    options.signal.removeEventListener('abort', stop)
  }
}

/** 取消语义：让调用方区分「用户取消」与「安装失败」。 */
export class AbortedInstallError extends Error {
  constructor () {
    super('依赖安装被取消。Dependency install cancelled.')
    this.name = 'AbortedInstallError'
  }
}

/** win32 下 npm/pnpm/yarn 是 .cmd shim（无 .exe），须经 cmd.exe 按 PATHEXT 解析。导出供单测。 */
export function installSpawnShell (platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

/**
 * 终止 install 子进程。win32 shell:true 时 child 是 cmd.exe 壳，
 * child.kill 杀不到包管理器孙进程，必须 taskkill /T 按进程树终止。
 */
export function stopInstallChild (
  child: { pid?: number | undefined; kill: (signal: NodeJS.Signals) => void },
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  treeKill: (pid: number) => void = defaultTreeKill,
): void {
  if (platform === 'win32' && child.pid !== undefined) treeKill(child.pid)
  child.kill(signal)
}

function defaultTreeKill (pid: number): void {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'])
}

function defaultSpawnInstall (manager: PackageManagerName, cwd: string): InstallChildProcess {
  const child = spawn(manager, ['install'], {
    cwd,
    env: process.env,
    shell: installSpawnShell(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    onData: (stream, listener) => {
      const source = stream === 'stdout' ? child.stdout : child.stderr
      source?.on('data', listener)
    },
    onExit: listener => child.on('exit', listener),
    onError: listener => child.on('error', listener),
    kill: signal => stopInstallChild(child, signal),
  }
}
