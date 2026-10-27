// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { CapabilityError } from './types.js'

/**
 * Capability / 插件工程的本机文件锁（T3 升级版）。
 *
 * - 锁目录 `<root>/.fh2/operation.lock` 内写入 `owner.json`（pid/命令/时间）；
 * - SIGKILL 后的遗留锁：可判定持有进程已退出（pid 失效）时回收重试；
 *   无法判定（无 owner.json / pid 存活）时明确报错并给出人工恢复路径，
 *   不得仅凭超时删除；
 * - 进程内重入由调用方用 operationLockHeld 语义显式表达（Pack→Build 内部调用不二次抢锁）。
 */
export interface OperationLockOwnerInfo {
  readonly pid: number;
  readonly command: string;
  readonly startedAt: number;
}

const OWNER_FILE = 'owner.json'

export function acquireCapabilityLock (capabilityRoot: string): () => void {
  const root = realpathSync(capabilityRoot)
  const stateRoot = join(root, '.fh2')
  if (existsSync(stateRoot)) {
    const state = lstatSync(stateRoot)
    if (state.isSymbolicLink() || !state.isDirectory()) {
      throw new CapabilityError('FH2_CAPABILITY_OPERATION_LOCK_FAILED', `.fh2 必须是 Capability 根内的普通目录：${stateRoot}`, stateRoot)
    }
  } else {
    mkdirSync(stateRoot, { recursive: true })
  }
  const lockPath = join(stateRoot, 'operation.lock')
  try {
    mkdirSync(lockPath)
  } catch {
    if (reclaimStaleLock(lockPath)) {
      try {
        mkdirSync(lockPath)
      } catch {
        throw inProgressError(root, lockPath, readOwner(lockPath))
      }
    } else {
      throw inProgressError(root, lockPath, readOwner(lockPath))
    }
  }
  writeOwner(lockPath)
  return () => {
    rmSync(lockPath, { recursive: true, force: true })
    // lock 由本次操作新建出的空 .fh2（如工作区根只有 lock 一个成员）随释放一起移除，
    // 避免目录残留；已含其他成员（build-report.json）时 rmdir 报 ENOTEMPTY，保留现场。
    try {
      rmdirSync(stateRoot)
    } catch {
      // 非空或并发占用：保留 .fh2 目录。
    }
  }
}

/** 读取锁持有者信息；无 owner.json 或损坏时返回 undefined（不可判定）。 */
export function readOperationLockOwner (root: string): OperationLockOwnerInfo | undefined {
  return readOwner(join(realpathSync(root), '.fh2', 'operation.lock'))
}

function writeOwner (lockPath: string): void {
  const owner: OperationLockOwnerInfo = {
    pid: process.pid,
    command: process.argv.slice(0, 2).join(' '),
    startedAt: Date.now(),
  }
  writeFileSync(join(lockPath, OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, 'utf8')
}

function readOwner (lockPath: string): OperationLockOwnerInfo | undefined {
  try {
    const raw = readFileSync(join(lockPath, OWNER_FILE), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.pid !== 'number' || !Number.isInteger(record.pid)) return undefined
    return {
      pid: record.pid,
      command: typeof record.command === 'string' ? record.command : '',
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : 0,
    }
  } catch {
    return undefined
  }
}

/** 可判定持有进程已退出时回收遗留锁；不可判定（无 owner / pid 存活）返回 false。 */
function reclaimStaleLock (lockPath: string): boolean {
  const owner = readOwner(lockPath)
  if (owner === undefined) return false
  if (isProcessAlive(owner.pid)) return false
  rmSync(lockPath, { recursive: true, force: true })
  return true
}

function isProcessAlive (pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH = 进程不存在；EPERM（存在但无权限，如 root 进程）视为存活。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function inProgressError (root: string, lockPath: string, owner: OperationLockOwnerInfo | undefined): CapabilityError {
  const detail = owner === undefined
    ? `锁目录存在但无法判定持有进程（缺 owner.json）。The lock directory exists but its holder cannot be determined (owner.json missing).`
    : `持有进程 pid=${owner.pid} 仍在运行。The holding process pid=${owner.pid} is still running.`
  return new CapabilityError(
    'FH2_CAPABILITY_OPERATION_IN_PROGRESS',
    `Capability 已有构建、开发或打包操作进行中：${root}。${detail}`,
    lockPath,
  )
}
