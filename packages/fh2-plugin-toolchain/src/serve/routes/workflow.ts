// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 工作流相关路由（计划 §C3）：浏览器快速预检、多文件保存。
 *
 * ⚠️ 会改磁盘的 save 必须经 `withWriteGuard`：不经它的话，
 * 一次保存可以与一次 build 并发改同一批文件。
 *
 * ⓘ 旧 `POST /api/workflow/scripts`（服务端复合新建脚本）已按
 * 「FH2 DAG画布插件开发者体验优化 Plan P0-5」删除：新建业务功能统一走
 * CreateScriptFunction / CreateScriptAndBind 内存命令 + SaveCoordinator，
 * 失败时磁盘零修改，不再有服务端旁路。
 */

import { runSavePlan } from '../../services/ide/save.js'
import type { SaveItem } from '../../services/ide/save.js'
import { validateWorkflowRequest } from '../../workflow/service/validate-request.js'
import type { RouteTable } from './context.js'
import { routeKey } from './context.js'

export function workflowRoutes (): RouteTable {
  return {
    [routeKey('POST', '/api/workflow/validate')]: context =>
      validateWorkflowRequest(context.root, context.body),

    /** 计划 §C2：多文件有序保存（脚本 → 清单 → 工作流）。 */
    [routeKey('POST', '/api/save')]: async context =>
      await context.withWriteGuard(async () =>
        await runSavePlan({ root: context.root, plan: { items: normalizeSaveItems(context.body.items) } })),
  }
}

/**
 * 归一化保存计划入参。
 *
 * ⚠️ 服务端**不信**前端给的形状：缺 kind、缺 content、path 不是字符串的项一律丢掉，
 * 而不是带着 undefined 往下走 —— 那会让 CAS 退化成无条件覆盖。
 */
export function normalizeSaveItems (raw: unknown): SaveItem[] {
  if (!Array.isArray(raw)) return []
  const items: SaveItem[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const path = record.path
    if (typeof path !== 'string' || path === '') continue
    if (record.kind === 'delete') {
      items.push({
        path,
        kind: 'delete',
        expectedDiskHash: typeof record.expectedDiskHash === 'string' ? record.expectedDiskHash : '',
      })
      continue
    }
    if (typeof record.content !== 'string') continue
    if (record.kind === 'create') {
      items.push({ path, kind: 'create', content: record.content })
      continue
    }
    if (record.kind === 'write') {
      items.push({
        path,
        kind: 'write',
        expectedDiskHash: typeof record.expectedDiskHash === 'string' ? record.expectedDiskHash : '',
        content: record.content,
      })
    }
  }
  return items
}
