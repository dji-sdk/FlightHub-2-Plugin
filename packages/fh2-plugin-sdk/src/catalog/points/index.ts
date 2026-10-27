// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { presets } from './presets.js'
import type { PointSpec } from './types.js'

export const points = {
  /**
   * @fh2-contract frontend.point.cockpit.ui.toolbar-actions
   * 在驾驶舱工具栏声明静态锚点并贡献按钮，运行时更新标签、图标和状态。
   *
   * 用法：先在清单 extensions 声明插件内 ID、point 和 static 字段，再在插件入口 await ctx.extensions.contribute(插件内ID, implementation)。按该 Point 的契约实现 onTrigger 等字段；没有 render 的 Point 不要实现或返回 ViewHandle。若契约包含 render，才通过 ctx.views.get(viewId) 返回 ViewHandle，不返回 DOM 或 Vue 实例。
   */
  'cockpit.ui.toolbar-actions': { id: 'cockpit.ui.toolbar-actions', contract: presets.cockpitToolbarAction, multiple: true },
  /**
   * @fh2-contract frontend.point.cockpit.ui.menubar
   * 在驾驶舱菜单栏贡献按钮，可在操作回调中通过受管上下文打开界面。
   *
   * 用法：先在清单 extensions 声明插件内 ID、point 和 static 字段，再在插件入口 await ctx.extensions.contribute(插件内ID, implementation)。按该 Point 的契约实现 onTrigger 等字段；没有 render 的 Point 不要实现或返回 ViewHandle。若契约包含 render，才通过 ctx.views.get(viewId) 返回 ViewHandle，不返回 DOM 或 Vue 实例。
   */
  'cockpit.ui.menubar': { id: 'cockpit.ui.menubar', contract: presets.cockpitMenubarAction, multiple: true },
  /**
   * @fh2-contract frontend.point.cockpit.ui.live-overlay
   * 在指定直播流的覆盖层显示界面，清单选择层级，状态选择位置、大小和可见性。
   *
   * 用法：先在清单 extensions 声明插件内 ID、point 和 static 字段，再在插件入口 await ctx.extensions.contribute(插件内ID, implementation)。state 字段提供初值并经贡献句柄 update 更新；method 由宿主调用。渲染回调返回 ctx.views.get(viewId) 的 ViewHandle，不返回 DOM 或 Vue 实例。
   */
  'cockpit.ui.live-overlay': { id: 'cockpit.ui.live-overlay', contract: presets.cockpitLiveOverlay, multiple: true },
  /**
   * @fh2-contract frontend.point.cockpit.ui.left-bottom-panels
   * 在驾驶舱左下方面板序列贡献界面与宽度；该区域的显示条件需在目标设备上验证。
   *
   * 用法：先在清单 extensions 声明插件内 ID、point 和 static 字段，再在插件入口 await ctx.extensions.contribute(插件内ID, implementation)。state 字段提供初值并经贡献句柄 update 更新；method 由宿主调用。渲染回调返回 ctx.views.get(viewId) 的 ViewHandle，不返回 DOM 或 Vue 实例。
   */
  'cockpit.ui.left-bottom-panels': { id: 'cockpit.ui.left-bottom-panels', contract: presets.cockpitLeftBottomPanel, multiple: true },
  /**
   * @fh2-contract frontend.point.cockpit.ui.left-panel
   * 在驾驶舱左侧注册可展示并聚焦的界面面板。
   *
   * 用法：先在清单 extensions 声明插件内 ID、point 和 static 字段，再在插件入口 await ctx.extensions.contribute(插件内ID, implementation)。state 字段提供初值并经贡献句柄 update 更新；method 由宿主调用。渲染回调返回 ctx.views.get(viewId) 的 ViewHandle，不返回 DOM 或 Vue 实例。
   */
  'cockpit.ui.left-panel': {
    id: 'cockpit.ui.left-panel',
    contract: presets.cockpitSwitchableView,
    multiple: true,
    revealable: true,
  },
  /**
   * @fh2-contract frontend.point.cockpit.ui.sublive-tab
   * 在驾驶舱子直播区域贡献可聚焦的界面页签。
   *
   * 用法：先在清单 extensions 声明插件内 ID、point 和 static 字段，再在插件入口 await ctx.extensions.contribute(插件内ID, implementation)。state 字段提供初值并经贡献句柄 update 更新；method 由宿主调用。渲染回调返回 ctx.views.get(viewId) 的 ViewHandle，不返回 DOM 或 Vue 实例。
   */
  'cockpit.ui.sublive-tab': {
    id: 'cockpit.ui.sublive-tab',
    contract: presets.cockpitSwitchableView,
    multiple: true,
    revealable: true,
  },
  /**
   * @fh2-contract frontend.point.cockpit.ui.flight-actions
   * 在驾驶舱飞行动作区域贡献按钮与回调。
   *
   * 用法：先在清单 extensions 声明插件内 ID、point 和 static 字段，再在插件入口 await ctx.extensions.contribute(插件内ID, implementation)。按该 Point 的契约实现 onTrigger 等字段；没有 render 的 Point 不要实现或返回 ViewHandle。若契约包含 render，才通过 ctx.views.get(viewId) 返回 ViewHandle，不返回 DOM 或 Vue 实例。
   */
  'cockpit.ui.flight-actions': { id: 'cockpit.ui.flight-actions', contract: presets.cockpitFlightAction, multiple: true },
  /**
   * @fh2-contract frontend.point.cockpit.ui.live-context-menu
   * 在直播画面右键菜单贡献操作，按回调接收的相对位置与流信息处理。
   *
   * 用法：先在清单 extensions 声明插件内 ID、point 和 static 字段，再在插件入口 await ctx.extensions.contribute(插件内ID, implementation)。按该 Point 的契约实现 onTrigger 等字段；没有 render 的 Point 不要实现或返回 ViewHandle。若契约包含 render，才通过 ctx.views.get(viewId) 返回 ViewHandle，不返回 DOM 或 Vue 实例。
   */
  'cockpit.ui.live-context-menu': { id: 'cockpit.ui.live-context-menu', contract: presets.contextMenuItem, multiple: true },
  /**
   * @fh2-contract frontend.point.plan.form-extensions
   * 在计划表单声明位置与类型匹配，显示插件控件并参与 validate/onSubmit 提交管线。
   *
   * 用法：先在清单 extensions 声明插件内 ID、point 和 static 字段，再在插件入口 await ctx.extensions.contribute(插件内ID, implementation)。state 字段提供初值并经贡献句柄 update 更新；method 由宿主调用。渲染回调返回 ctx.views.get(viewId) 的 ViewHandle，不返回 DOM 或 Vue 实例。
   */
  'plan.form-extensions': { id: 'plan.form-extensions', contract: presets.planFormExtension, multiple: true },
  /**
   * @fh2-contract frontend.point.project.sidebar-actions
   * 在项目侧栏贡献带路由的按钮，返回插件界面或可选工作区界面。
   *
   * 用法：先在清单 extensions 声明插件内 ID、point 和 static 字段，再在插件入口 await ctx.extensions.contribute(插件内ID, implementation)。state 字段提供初值并经贡献句柄 update 更新；method 由宿主调用。渲染回调返回 ctx.views.get(viewId) 的 ViewHandle，不返回 DOM 或 Vue 实例。
   */
  'project.sidebar-actions': { id: 'project.sidebar-actions', contract: presets.projectSidebarAction, multiple: true },
  /**
   * @fh2-contract frontend.point.message.alert-popups
   * 在消息告警流程中贡献受管弹层，可见性由贡献状态控制。
   *
   * 用法：先在清单 extensions 声明插件内 ID、point 和 static 字段，再在插件入口 await ctx.extensions.contribute(插件内ID, implementation)。state 字段提供初值并经贡献句柄 update 更新；method 由宿主调用。渲染回调返回 ctx.views.get(viewId) 的 ViewHandle，不返回 DOM 或 Vue 实例。
   */
  'message.alert-popups': { id: 'message.alert-popups', contract: presets.messageAlertPopup, multiple: true },
} as const satisfies Record<string, PointSpec<string, any, boolean, boolean>>

export type PointCatalog = typeof points
export type PointId = keyof PointCatalog
export type PointContractOf<TId extends PointId> = PointCatalog[TId]['contract']
export type RevealablePointId = {
  [TId in PointId]: PointCatalog[TId] extends { readonly revealable: true } ? TId : never
}[PointId]

export const COCKPIT_POINT_IDS = [
  'cockpit.ui.toolbar-actions',
  'cockpit.ui.menubar',
  'cockpit.ui.live-overlay',
  'cockpit.ui.left-bottom-panels',
  'cockpit.ui.left-panel',
  'cockpit.ui.sublive-tab',
  'cockpit.ui.flight-actions',
  'cockpit.ui.live-context-menu',
] as const satisfies readonly PointId[]

export const PLAN_POINT_IDS = ['plan.form-extensions'] as const satisfies readonly PointId[]
export const PROJECT_POINT_IDS = ['project.sidebar-actions'] as const satisfies readonly PointId[]
export const MESSAGE_POINT_IDS = ['message.alert-popups'] as const satisfies readonly PointId[]

export const POINT_IDS: readonly PointId[] = [
  ...COCKPIT_POINT_IDS,
  ...PLAN_POINT_IDS,
  ...PROJECT_POINT_IDS,
  ...MESSAGE_POINT_IDS,
]

export { field } from './field.js'
export { isCssLength } from './field.js'
export type { CssLength, FieldKind, FieldSpec, StateOptions, StaticOptions } from './field.js'
export { presets } from './presets.js'
export type {
  ActionContext,
  PlanFormDraft,
  PlanFormEditSubmitInput,
  PlanFormExtensionContext,
  PlanFormGeographicPosition,
  PlanFormSubmitInput,
  PlanFormValidationResult,
  PlanFormWaylineDraft,
  RelativeVideoPoint,
} from './presets.js'
export type {
  ContributionOf,
  FieldValue,
  ImplementationOf,
  MethodsOf,
  PointContract,
  PointSpec,
  StateOf,
  StaticOf,
} from './types.js'
