// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PluginContext, PluginDefinition } from '../contracts/index.js'

/**
 * 插件的唯一入口（SDK 设计 §4.1）。
 *
 * 插件只有两个生命周期钩子：`activate` 接入宿主，其返回值上的 `dispose`
 * 负责业务收尾。同一 entry 在不同 PluginHost 分别激活，靠 `ctx.host.id` 分流；
 * entry 内对各 Host 业务的动态 import 只是 bundle 分包优化，
 * **不创建新的公共入口或生命周期**。
 */
export function definePlugin<TContext extends PluginContext = PluginContext> (
  definition: PluginDefinition<TContext>,
): PluginDefinition<TContext> {
  return definition
}
