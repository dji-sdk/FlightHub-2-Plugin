// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * `fh2-plugin-sdk` 根 barrel（SDK 设计 §11）。
 *
 * SDK **不导出** Engine 的 PluginHost、Runtime、Registry、资源台账
 * 或宿主 Adapter 实现——那些在平台 Engine 实现（不随 SDK 分发）。
 */

export * from './catalog/index.js'
export * from './contracts/index.js'
export { definePlugin } from './runtime/index.js'
export { runtimeContract } from './runtime-contract.js'
export { MANIFEST_SCHEMA_ID, manifestSchema } from './schema/index.js'
export { definePluginService } from './service/index.js'
export type {
  PluginServiceContract,
  PluginServiceDescriptor,
  ServiceClient,
  ServiceImplementation,
} from './service/index.js'
export { createViewState, definePluginView, defineView } from './view/index.js'
export type {
  PluginState,
  PluginViewCall,
  PluginViewClient,
  PluginViewContract,
  PluginViewContractSchema,
  PluginViewHandlerRegistration,
  PluginViewSession,
  PluginViewState,
  PluginViewStateSource,
  RegisterView,
  ViewDefinition,
  ViewInstance,
  ViewRegistrationOptions,
} from './view/index.js'
