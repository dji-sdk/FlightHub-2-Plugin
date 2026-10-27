// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 平台 Catalog：权限、事件与共享 Point 类型。
 *
 * 宿主作者消费 `catalog/` + `contracts/`（SDK 设计 §2 依赖方向）。
 * 各 Host 的完整清单见
 * `docs/design/fh2-plugin-host-extension-points-and-permissions-summary.md`，
 * 按批次实现时逐条补进来。
 */

/** Extension、View 与 Icon 共用的插件内局部 ID 格式。 */
export const PLUGIN_LOCAL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/

export function isPluginLocalId (value: unknown): value is string {
  return typeof value === 'string' && PLUGIN_LOCAL_ID_PATTERN.test(value)
}

/** 服务端与 Manifest 共用的插件 ID：官方插件 official_，扩展插件 exp_。 */
export const PLUGIN_ID_PATTERN = /^(?:official|exp)_[a-z0-9]+(?:[_-][a-z0-9]+)*$/

export function isPluginId (value: unknown): value is PluginId {
  return typeof value === 'string' && PLUGIN_ID_PATTERN.test(value)
}

/** 插件 ID；Manifest id 字段。 */
export type PluginId = string

/** Extension 声明 ID；在插件内唯一（§3.2 安装校验） */
export type ExtensionId = string

/** View 资源 ID；在插件内唯一 */
export type ViewId = string

/** Service 定义 ID；路由键为 (pluginId, serviceId)（§8） */
export type ServiceId = string

export { HOST_IDS, isHostId } from './hosts.js'
export type { HostId } from './hosts.js'

export * from './capabilities.js'

export * from './events.js'

export * from './points/index.js'
