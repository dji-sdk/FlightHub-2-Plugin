// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { acquireCapabilityLock } from '../../capability/lock.js'
import { tryDiscoverCommandContext } from '../../capability/discovery.js'

/**
 * T3：canonical operation root 与统一 operation lock（实施计划 §3.1.1）。
 *
 * - 锁范围按真实工程归属归一化：成员插件 → 所属 Capability；工作区成员 Capability →
 *   行业工作区根（保守序列化：工作区 Pack 读取全部成员，任何成员写操作都必须与其互斥）；
 * - Build、Pack、Generate、Install 及会写构建目录的 Dev/Preview 均经过同一 operation lock；
 *   TaskService 负责进程内任务语义，文件锁负责合作 Toolchain 进程的写互斥，两者不互相替代；
 * - 进程内重入（Pack→Build 持锁内部调用）用 {@link isOperationLockHeld} 显式表达，
 *   不二次抢锁；
 * - 正常结束、异常和取消都释放自己的锁；释放失败由调用方兜底（executor finally）。
 */

/** 按真实工程归属归一化操作根。 */
export function canonicalOperationRoot (rawRoot: string): string {
  const root = resolve(rawRoot)
  let projectRoot = root
  try {
    const context = tryDiscoverCommandContext(root)
    if (context === undefined) {
      projectRoot = root
    } else if (context.kind === 'capability-project' || context.kind === 'industry-capability-workspace') {
      projectRoot = context.root
    } else {
      projectRoot = memberProjectRoot(context.root)
    }
  } catch {
    // discovery 失败（损坏的 capabilities.json 等）：操作本身会给出诊断；锁根退回请求根。
    projectRoot = root
  }
  return liftToWorkspaceRoot(projectRoot)
}

/**
 * 成员插件入口归一到所属 Capability 根：`<cap>/frontend/<plugin>` / `<cap>/backend/<plugin>`
 * 的祖父目录携带 capabilities.json 时视为 Capability 成员；否则插件自身就是工程根。
 */
function memberProjectRoot (pluginRoot: string): string {
  const container = dirname(pluginRoot)
  const containerName = basename(container)
  if (containerName !== 'frontend' && containerName !== 'backend') return pluginRoot
  const capabilityRoot = dirname(container)
  return existsSync(join(capabilityRoot, 'capabilities.json')) ? capabilityRoot : pluginRoot
}

/** Capability 是行业工作区直接子成员时，锁根上提到工作区根。 */
function liftToWorkspaceRoot (projectRoot: string): string {
  if (!existsSync(join(projectRoot, 'capabilities.json'))) return projectRoot
  const parent = dirname(projectRoot)
  return existsSync(join(parent, 'packages.json')) ? parent : projectRoot
}

const heldRoots = new Set<string>()

/**
 * 在 canonical root 上获取 operation lock；返回释放函数。
 * 同进程重复获取会因自身 pid 存活而报 IN_PROGRESS——内部调用请先检查
 * {@link isOperationLockHeld} 并透传 operationLockHeld 语义。
 */
export function acquireOperationLock (rawRoot: string): () => void {
  const canonical = canonicalOperationRoot(rawRoot)
  const release = acquireCapabilityLock(canonical)
  heldRoots.add(canonical)
  let released = false
  return () => {
    if (released) return
    released = true
    heldRoots.delete(canonical)
    release()
  }
}

/** 当前进程是否已持有该工程的操作锁（重入检查）。 */
export function isOperationLockHeld (rawRoot: string): boolean {
  return heldRoots.has(canonicalOperationRoot(rawRoot))
}
