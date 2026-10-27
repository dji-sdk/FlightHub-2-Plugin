// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 路由装配（计划 §C3）。
 *
 * ⓘ 本轮只把方案点名的三组搬出来（knowledge / workflow / workspace）。
 * 文件读写、fs、task、lsp、run 仍在 `ide-server.ts` 里 —— 它们与 SSE、
 * 子进程生命周期、写入守卫耦合得更深，机械搬迁的回归风险大于结构收益。
 * ⚠️ 别把这句读成「以后也不用搬」：`ide-server.ts` 的目标仍是只管鉴权/会话/装配。
 */

export type { RouteContext, RouteHandler, RouteTable } from './context.js'
export { routeKey } from './context.js'
export { knowledgeRoutes } from './knowledge.js'
export { normalizeSaveItems, workflowRoutes } from './workflow.js'
export { workspaceRoutes } from './workspace.js'
export type { WorkspaceRoutePorts } from './workspace.js'
