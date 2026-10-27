// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 稳定错误码（Engine 设计 §11.1）。
 *
 * 这些码是插件、宿主与诊断系统之间的公共词汇，只增不改；
 * 删除或改写任何一条都属于运行时协议破坏，必须走 major。
 */
export const PLUGIN_ERROR_CODES = [
  'MANIFEST_INVALID',
  'ENGINE_INCOMPATIBLE',
  'PLUGIN_ENTRY_INVALID',
  'EXTENSION_POINT_NOT_FOUND',
  'EXTENSION_DECLARATION_INVALID',
  'EXTENSION_IMPLEMENTATION_MISSING',
  'EXTENSION_IMPLEMENTATION_INVALID',
  'EXTENSION_NOT_FOUND',
  'HANDLER_STATE_INVALID',
  'CONTRIBUTION_UPDATE_FAILED',
  'HOST_ADAPTER_FAILED',
  'EXTENSION_REVEAL_UNAVAILABLE',
  'REGISTRATION_CONFLICT',
  'POINT_CONSUMER_CONFLICT',
  'CAPABILITY_NOT_AVAILABLE',
  'CAPABILITY_CONTRACT_INVALID',
  'CAPABILITY_REALM_MISMATCH',
  'CAPABILITY_RATE_UNSUPPORTED',
  'COCKPIT_SDK_ERROR',
  'SERVICE_CONTRACT_INVALID',
  'SERVICE_UNAVAILABLE',
  'VIEW_NOT_DECLARED',
  'VIEW_LOAD_FAILED',
  'VIEW_CONTRIBUTION_ALREADY_MOUNTED',
  'HOST_RUNTIME_DISPOSED',
  'PLUGIN_VALUE_INVALID',
  'CONFIG_VALUE_INVALID',
  'STORAGE_QUOTA_EXCEEDED',
  'RUNTIME_UNRESPONSIVE',
  'RESOURCE_LEAK',
  'PLUGIN_NETWORK_BLOCKED',
  'PLUGIN_GATEWAY_ERROR',
  'TIMEOUT',
] as const

export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number]

/** 跨界传递的错误形状；必须可结构化克隆，故不含 Error 实例 */
export interface PluginErrorShape {
  readonly code: PluginErrorCode;
  readonly message: string;
  readonly pluginId?: string;
  readonly hostId?: string;
  readonly detail?: import('./plugin-value.js').PluginValue;
}

/** 跨 Realm 使用结构判断；不要依赖 `instanceof`。 */
export function isPluginError (error: unknown): error is Error & PluginErrorShape {
  if (!(error instanceof Error) && (typeof error !== 'object' || error === null)) return false
  const candidate = error as { code?: unknown; message?: unknown }
  return typeof candidate.message === 'string'
    && typeof candidate.code === 'string'
    && (PLUGIN_ERROR_CODES as readonly string[]).includes(candidate.code)
}
