// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 路由模块的共享上下文（计划 §C3）。
 *
 * ★★ 为什么要有这一层：`ide-server.ts` 原本把**鉴权、会话、路由分发、业务实现**
 * 四件事写在同一个函数里，于是加一个接口就要在那个 700 行的函数中间插一段。
 * 抽出上下文之后，`ide-server` 只负责前三件，业务实现各自成模块。
 *
 * ⚠️ 上下文里刻意**不放 req/res**：路由模块回一个数据对象，由 ide-server 统一
 * 包信封、统一发。让业务模块自己写 response 会让「错误信封长什么样」散到各处，
 * 而那是前端唯一能依赖的契约。
 */

/** 每个请求都能拿到的东西。 */
export interface RouteContext {
  /** 当前工作根（跟着 `POST /api/workspace/open` 走）。 */
  readonly root: string;
  /** URL 查询参数。 */
  readonly query: URLSearchParams;
  /** 已解析的 JSON body（GET 时为空对象）。 */
  readonly body: Record<string, unknown>;
  /**
   * 写入守卫：所有会改磁盘的操作都必须经它。
   * ⚠️ 不经它的写操作可以与一次 build 并发改同一批文件。
   */
  readonly withWriteGuard: <T>(operation: () => Promise<T>) => Promise<T>;
}

/** 一个路由处理器：拿上下文，回要放进信封 data 的东西。 */
export type RouteHandler = (context: RouteContext) => Promise<unknown> | unknown

/** 一张路由表：`<METHOD> <pathname>` → 处理器。 */
export type RouteTable = Readonly<Record<string, RouteHandler>>

/** 拼路由键。集中一处，免得各模块写法不一（有人带斜杠有人不带）。 */
export function routeKey (method: string, pathname: string): string {
  return `${method.toUpperCase()} ${pathname}`
}
