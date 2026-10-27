// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 知识包相关路由（计划 §C3）：当前固定了哪份知识、Schema、平台 Catalog。
 *
 * ⚠️ 这一组**只读**，且回包里**不含任何本机路径**：缓存目录对前端无用，
 * 下发它等于鼓励前端拼路径回传（见 contracts/knowledge.ts 的 InstalledKnowledge）。
 */

import { resolveKnowledgeStatus } from '../../knowledge/resolve.js'
import { resolveIdeSchemas } from '../../services/ide/schemas.js'
import { resolveIdeActionsWithKnowledge } from '../../workflow/service/actions.js'
import type { RouteTable } from './context.js'
import { routeKey } from './context.js'

export function knowledgeRoutes (): RouteTable {
  return {
    [routeKey('GET', '/api/knowledge')]: async context =>
      await resolveKnowledgeStatus(context.root),

    [routeKey('GET', '/api/schemas')]: context =>
      resolveIdeSchemas({ root: context.root }),

    /**
     * 画布节点菜单。
     * ⚠️ 跟着当前工作根走：切工作区后脚本候选必须换成新工程的。
     */
    [routeKey('GET', '/api/actions')]: async (context) => {
      const path = context.query.get('path')
      return await resolveIdeActionsWithKnowledge({
        root: context.root,
        ...(path === null ? {} : { workflowPath: path }),
      })
    },
  }
}
