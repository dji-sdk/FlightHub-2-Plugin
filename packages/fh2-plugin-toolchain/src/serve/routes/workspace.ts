// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 工作区相关路由（计划 §C3）：信息、文件树、最近工程、切换/新建工程。
 *
 * ⚠️ 切工作区（`/api/workspace/open`）有两个副作用**必须一起发生**：
 * 会话的 root 换掉、以及前端那侧 DocumentStore 的 workspaceEpoch +1。
 * 只换 root 不推代号，一条 prepare 于旧工程的命令会去写新工程里同名的那个文件。
 * 代号由前端 `setWorkspaceRoot` 推进，本模块只负责服务端那一半。
 */

import { readWorkspaceTree } from '../../services/ide/files.js'
import type { RouteTable } from './context.js'
import { routeKey } from './context.js'

export interface WorkspaceRoutePorts {
  /** 当前会话快照（root / id / kind）。 */
  readonly info: () => unknown;
  readonly recent: () => unknown;
  readonly open: (body: Record<string, unknown>) => Promise<unknown>;
  readonly create: (body: Record<string, unknown>) => Promise<unknown>;
}

export function workspaceRoutes (ports: WorkspaceRoutePorts): RouteTable {
  return {
    [routeKey('GET', '/api/workspace')]: () => ports.info(),

    [routeKey('GET', '/api/tree')]: async context =>
      await readWorkspaceTree({ root: context.root }),

    [routeKey('GET', '/api/workspace/recent')]: () => ports.recent(),

    [routeKey('POST', '/api/workspace/open')]: async context =>
      await ports.open(context.body),

    [routeKey('POST', '/api/workspace/create')]: async context =>
      await context.withWriteGuard(async () => await ports.create(context.body)),
  }
}
