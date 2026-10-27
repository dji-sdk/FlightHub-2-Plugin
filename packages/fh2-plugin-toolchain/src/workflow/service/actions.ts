// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * `GET /api/actions` 的组装入口：先按项目锁解析知识包，再交给 catalog 适配。
 *
 * ★★ 为什么单独一层而不是塞进 catalog.ts：`resolveIdeActions` 是**同步**的
 * （画布每次切文件都调它，且被多处同步复用），而知识解析要读盘。
 * 把 await 加进那个函数会让所有调用点跟着变成 async；单独一层只让路由层付这个代价。
 *
 * ⚠️ 知识解析失败时**不抛**，而是带着原因回退到内建手抄快照：
 * 画布拿不到节点菜单会整个不可用，而「用手抄快照 + 明确标注来源」是可工作的状态。
 * 但它必须**可见**——`catalogSource.kind='builtin-snapshot'` + reason 一起下发。
 */

import type { PlatformCatalog } from '../../contracts/knowledge.js'
import { loadPlatformCatalog, resolveProjectKnowledge } from '../../knowledge/resolve.js'
import type { IdeActionsData, ResolveIdeActionsOptions } from './catalog.js'
import { resolveIdeActions } from './catalog.js'

/**
 * 已解析 Catalog 的进程内缓存。
 *
 * 键是 `knowledgeId@bundleDigest`：同 ID 不同内容必须各算一份，否则换了一份脏产物
 * 之后画布还在用上一份的节点菜单。知识包装好后内容不可变，故缓存不需要失效策略。
 */
const catalogCache = new Map<string, PlatformCatalog>()

/** 清缓存（测试用；生产里知识内容不可变，没有清的理由）。 */
export function clearPlatformCatalogCache (): void {
  catalogCache.clear()
}

export interface ResolveActionsWithKnowledgeOptions extends ResolveIdeActionsOptions {
  /** 项目根（读 lock 用）。缺省用 root —— 二者在当前布局下同一个目录。 */
  readonly projectRoot?: string;
}

export async function resolveIdeActionsWithKnowledge (
  options: ResolveActionsWithKnowledgeOptions,
): Promise<IdeActionsData> {
  const projectRoot = options.projectRoot ?? options.root

  let platformCatalog: PlatformCatalog | undefined
  let fallbackReason: string | undefined
  try {
    const resolved = await resolveProjectKnowledge(projectRoot)
    if (resolved.knowledge !== undefined) {
      const key = `${resolved.knowledge.knowledgeId}@${resolved.knowledge.bundleDigest}`
      const cached = catalogCache.get(key)
      if (cached !== undefined) {
        platformCatalog = cached
      } else {
        platformCatalog = loadPlatformCatalog(resolved.knowledge)
        catalogCache.set(key, platformCatalog)
      }
    } else if (resolved.problems.length > 0) {
      fallbackReason = resolved.problems.join('；')
    } else {
      fallbackReason = '项目还没固定知识包（没有 backend-plugin-knowledge.lock.json）。'
        + '当前节点菜单来自 Toolchain 内建手抄快照，可能与目标 worker 版本不一致。'
        + '用 `fh2-plugin knowledge import <知识包目录>` 与 `knowledge use <id>` 固定。'
    }
  } catch (error) {
    fallbackReason = `解析项目知识包失败：${(error as Error).message}`
  }

  return resolveIdeActions({
    ...options,
    ...(platformCatalog === undefined ? {} : { platformCatalog }),
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
  })
}
