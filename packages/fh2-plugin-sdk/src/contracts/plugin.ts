// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
export interface Disposable {
  dispose(): void | Promise<void>;
}

/** 跨 SDK/Engine 边界返回的资源句柄；释放完成与失败均可观察。 */
export interface AsyncDisposable {
  dispose(): Promise<void>;
}

/** 停用原因（Engine §5.4） */
export type DisposeReason =
  | 'host-unmount'
  | 'plugin-disabled'
  | 'plugin-uninstalled'
  | 'config-changed'
  | 'activation-failed'
  | 'runtime-terminated'

export interface DisposeContext {
  readonly reason: DisposeReason;
}

/**
 * `activate` 的返回值：插件自己的**业务**收尾逻辑。
 *
 * 资源释放不走这里——注册、timer、Port、View 由 Engine 的 ResourceTracker
 * 统一回收（Engine §9.1）。不需要业务收尾时，`activate` 什么都不返回即可。
 */
export interface PluginTeardown {
  dispose(context: DisposeContext): void | Promise<void>;
}

export interface PluginDefinition<TContext = unknown> {
  activate(ctx: TContext): PluginTeardown | void | Promise<PluginTeardown | void>;
}
