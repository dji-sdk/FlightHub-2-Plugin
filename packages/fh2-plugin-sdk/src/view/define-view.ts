// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { ViewMountContext } from '../contracts/index.js'

export interface ViewDefinition {
  /** 挂载 View；返回值负责卸载时的清理（Vue unmount、订阅、Portal） */
  mount(ctx: ViewMountContext): ViewInstance | Promise<ViewInstance>;
}

export interface ViewInstance {
  dispose(): void | Promise<void>;
}

export interface ViewRegistrationOptions extends ViewMountContext {}

/**
 * View bundle 的 default export **必须是这个函数**。
 *
 * ViewRuntime 在 `import()` 之后会校验 `typeof mod.default === 'function'`，
 * 不满足即 `VIEW_LOAD_FAILED` 且不挂载（实现附录 B.3）。
 * 所以 `defineView` 返回的是可调用的 register 函数，不是普通对象。
 */
export type RegisterView = (
  options: ViewRegistrationOptions,
) => Promise<ViewInstance>

export function defineView (
  definition: ViewDefinition,
): RegisterView {
  return async options => definition.mount(options)
}
