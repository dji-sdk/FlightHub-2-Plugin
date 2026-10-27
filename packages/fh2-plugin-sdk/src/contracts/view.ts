// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * View 契约（SDK 设计 §7）。
 *
 * View 拿不到 Plugin Context 或 Capability；Entry 与 View 之间只有 typed channel。
 * View bundle 在宿主 Realm 执行，可视 DOM/CSS 位于宿主 WebComponent ShadowRoot。
 * ShadowRoot 只提供 UI/CSS 隔离，不提供 JS 安全隔离；插件安装审核是安全边界。
 */

import type { LocaleType } from './locale.js'

/** Entry 侧持有的 View 引用；由 typed View contract 的 `get(ctx)` 取得。 */
export interface ViewHandle<TInitialState = unknown> {
  readonly viewId: string;
  /** 可选的稳定初始状态字段；值变化表示新的 View 内容身份。 */
  readonly initialState: TInitialState;
}

/**
 * Host 把 View 挂到明确 DOM 容器后取得的实例句柄。
 *
 * 容器与呈现位置始终由 Host（或 Host SDK）决定；Engine 只负责按 ViewHandle
 * 所属插件 Runtime 完成挂载、隔离和资源回收。
 */
export interface ViewMount {
  dispose(): void | Promise<void>;
  readonly closed: Promise<void>;
}

/**
 * 打开一个 View 后拿到的呈现句柄（Engine §4.4.9 / SDK §4）。
 *
 * 双向：插件可主动 `close()`；用户点外部、按 ESC 或锚点销毁时 `closed` resolve。
 * 位置、外部点击与 ESC 仍由宿主拥有。
 */
export interface ViewPresentation {
  close(): Promise<void>;
  readonly closed: Promise<void>;
}

/** View 侧 mount 时收到的上下文 */
export interface ViewMountContext {
  readonly viewId: string;
  /** 挂载点：`<div data-view-root>`，Vue / React / Lit 都挂这里 */
  readonly mountElement: HTMLElement;
  /**
   * CSS-in-JS 样式挂载目标，由 Engine 创建并随 View 一起清理。
   */
  readonly styleTarget: ShadowRoot;
  /**
   * Engine 创建的浮层目标；Select/Modal/Teleport 应挂这里，随 View 一起清理。
   * 它与 mountElement 位于同一 ShadowRoot，并以 fixed 零尺寸根越过纯 overflow 裁剪。
   */
  readonly overlayElement: HTMLElement;
  /** 与 Entry 通信的 typed channel 端口 */
  readonly port: MessagePort;
  /** 宿主当前 locale（LocaleType 快照）；由 EngineOptions.locale 注入，缺省 ZH，生命周期内不变 */
  readonly locale: LocaleType;
  /** 初始化方向 */
  readonly direction: 'ltr' | 'rtl';
  /** 初始化主题 token；主题变化通过受控消息更新 */
  readonly theme: Readonly<Record<string, string>>;
}
