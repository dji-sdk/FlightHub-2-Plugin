// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PluginValue, ViewHandle, ViewPresentation } from '../../contracts/index.js'
import { field as f } from './field.js'
import type { FieldSpec } from './field.js'

export interface ActionContext {
  openView(view: ViewHandle, options?: {
    readonly placement?: 'left' | 'right' | 'top' | 'bottom';
  }): Promise<ViewPresentation>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): Promise<void>;
}

export interface RelativeVideoPoint {
  /** 有效视频画面内横向归一化位置，范围 0..1。 */
  readonly relativeLeft: number;
  /** 有效视频画面内纵向归一化位置，范围 0..1。 */
  readonly relativeTop: number;
}

export interface PlanFormExtensionContext {
  readonly projectId: string;
  readonly mode: 'create' | 'copy';
  readonly planType: 'normal' | 'atob' | 'manual';
  readonly isMultiWayline: boolean;
}

/** 多航线任务中的单条航线草稿。 */
export type PlanFormWaylineDraft = Readonly<{
  readonly wayline_uuid: string;
  readonly segment_indexes?: readonly number[];
  readonly wayline_duration: number;
  readonly wayline_distance: number;
  readonly total_waypoints: number;
  readonly wayline_name: string;
}> & Readonly<Record<string, PluginValue>>

/** 系统推荐设备时使用的航线起点。 */
export type PlanFormGeographicPosition = Readonly<{
  readonly longitude: number;
  readonly latitude: number;
  readonly height?: number;
}> & Readonly<Record<string, PluginValue>>

/**
 * 点击确定时由 Plan Host 生成的规范化任务草稿。
 *
 * 已知字段提供类型提示；开放索引用于兼容 Host 后续增加的任务字段。条件字段只在对应
 * 任务策略或功能开启时存在。所有时间均为 Unix 秒，所有值都可安全跨 Plugin Realm 传输。
 */
export type PlanFormDraft = Readonly<{
  /** 计划名称。 */
  readonly name: string;
  /** 任务策略：1 立即、2 定时重复、3 单次定时、4 重复子任务、5 连续、6 连续子任务、7 机场试飞。 */
  readonly task_type: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** 重复频率：0 不重复、1 秒、2 分钟、3 小时、4 天、5 周、6 按日期月、7 按星期月、8 年。 */
  readonly repeat_type: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  /** 单航线 UUID；多航线任务的详细列表见 wayline_list。 */
  readonly wayline_uuid: string;
  /** 起飞机场或遥控器 SN；系统推荐设备时为空字符串。 */
  readonly sn: string;
  /** 降落机场 SN。 */
  readonly landing_dock_sn: string;
  /** 网络基站 SN。 */
  readonly connect_sn?: string;
  /** 飞行中失联动作：1 返航、2 继续执行。 */
  readonly out_of_control_action_in_flight: 1 | 2;
  readonly interval?: number;
  readonly month?: number;
  readonly dom?: readonly number[];
  readonly dow?: readonly number[];
  /** 快速起飞精度：0 GPS、1 RTK。 */
  readonly wayline_precision_type?: 0 | 1;
  readonly wom?: number;
  readonly begin_at?: number;
  readonly end_at?: number;
  readonly latest_begin_at?: number;
  readonly extended_begin_at?: readonly number[];
  readonly extended_latest_begin_at?: readonly number[];
  readonly excluded_task_uuid?: string;
  readonly time_zone?: string;
  readonly cloud_to_cloud_id?: string;
  readonly tags?: readonly string[];
  readonly default_name?: string;
  /** 任务预计执行时间，单位秒。 */
  readonly wayline_duration?: number;
  /** 航段纯飞行时间，单位秒。 */
  readonly duration?: number;
  readonly rth_altitude?: number;
  readonly min_battery_capacity?: number;
  readonly continuous_task_periods?: readonly (readonly number[])[];
  /** 自动断点续飞状态。 */
  readonly resumable_status?: 'auto' | 'manual' | '';
  readonly breakpoint_resume_mode?: 'cross_time_segment' | 'within_time_segment';
  /** 返航方式：0 最优航线、1 默认高度。 */
  readonly rth_mode?: 0 | 1;
  /** 当前任务为 AI 告警任务时固定为 1。 */
  readonly business_type?: 1;
  readonly subscription_receive_type?: readonly ('email' | 'phone' | 'user_web' | 'cloud_to_cloud')[];
  readonly subscription_user_id?: readonly string[];
  readonly subscription_alert_user_web_frequency?: number;
  readonly subscription_alert_cloud_to_cloud_frequency?: number;
  readonly subscription_alert_email_frequency?: number;
  readonly subscription_alert_phone_frequency?: number;
  readonly push_c2c_organization_uuid?: string;
  readonly wayline_segment_indexes?: readonly number[];
  readonly wayline_segment_points?: number;
  readonly fast_reconstruction?: boolean;
  /** 下发设备类型：0 机场、1 遥控器。 */
  readonly device_type?: 0 | 1;
  /** 自动连接推荐基站：0 关闭、1 开启。 */
  readonly signal_type?: 0 | 1;
  readonly wayline_list?: readonly PlanFormWaylineDraft[];
  readonly media_folder_id_paths: string;
  readonly vlm_enabled?: boolean;
  readonly prompt_uuid?: string;
  readonly labels?: readonly string[];
  readonly alert_title?: string;
  readonly alert_content?: string;
  readonly alert_record_interval?: number;
  readonly drone_sn?: string;
  readonly payload_index?: string;
  readonly not_exceed_agl_enabled?: boolean;
  readonly not_exceed_agl_altitude?: number;
  /** 编辑任务时由 Host 原样保留；create/copy 由插件补丁重新贡献。 */
  readonly biz_ext?: Readonly<Record<string, PluginValue>>;
  /** 自动化工作流设备模式：0 系统推荐、1 指定设备。 */
  readonly device_mode?: 0 | 1;
  readonly wayline_start_position?: PlanFormGeographicPosition;
}> & Readonly<Record<string, PluginValue>>

/** plan.form-extension 提交输入：form 是点击确定时生成的规范化任务草稿（JSON 安全）。 */
export interface PlanFormSubmitInput {
  readonly context: PlanFormExtensionContext;
  readonly form: PlanFormDraft;
}

/** 编辑任务提交输入；编辑扩展不渲染 UI，只用于恢复插件已拥有任务的提交语义。 */
export interface PlanFormEditSubmitInput {
  readonly context: Omit<PlanFormExtensionContext, 'mode'> & { readonly mode: 'edit' };
  readonly form: PlanFormDraft;
}

export type PlanFormValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly message: string }

export const presets = {
  cockpitToolbarAction: {
    anchor: f.static.enum(['footer-toolbar', 'footer-toolbar:before-ai'] as const, { optional: true }),
    icon: f.state.iconId(),
    label: f.state.string(),
    active: f.state.boolean({ default: false }),
    disabled: f.state.boolean({ default: false }),
    onTrigger: f.method<(ctx: ActionContext) => void | Promise<void>>(),
  },
  cockpitMenubarAction: {
    icon: f.state.iconId(),
    label: f.state.string(),
    active: f.state.boolean({ default: false }),
    disabled: f.state.boolean({ default: false }),
    /** 与 toolbar 一致：onTrigger 收到 ActionContext，openView 把 View 锚定到本按钮 Popover。 */
    onTrigger: f.method<(ctx: ActionContext) => void | Promise<void>>(),
  },
  cockpitFlightAction: {
    anchor: f.static.enum(['flight-actions', 'flight-actions:after-return-home'] as const, { optional: true }),
    visible: f.state.boolean({ default: true }),
    icon: f.state.iconId(),
    label: f.state.string(),
    active: f.state.boolean({ default: false }),
    disabled: f.state.boolean({ default: false }),
    onTrigger: f.method<() => void | Promise<void>>(),
  },
  projectSidebarAction: {
    path: f.static.string(),
    position: f.static.number({ optional: true }),
    icon: f.state.iconId(),
    label: f.state.string(),
    disabled: f.state.boolean({ default: false }),
    showBadge: f.state.boolean({ default: false }),
    render: f.method<() => ViewHandle>(),
    /** 可选：路由激活时由 Project Host 同时挂载到项目主内容区（工作区）的页面 View。 */
    renderWorkspace: f.methodOptional<() => ViewHandle>(),
  },
  cockpitSwitchableView: {
    visible: f.state.boolean({ default: false }),
    label: f.state.string(),
    icon: f.state.iconId({ optional: true }),
    /**
     * 面板初始宽度 px（仅 panel 生效；tab 由宿主布局决定）。宿主以此调整
     * 初始宽与拖拽下限，未声明走宿主默认（不传给 Cockpit SDK）。
     */
    width: f.state.number({ optional: true }),
    render: f.method<() => ViewHandle>(),
  },
  cockpitLiveOverlay: {
    stream: f.static.enum(['DronePayload', 'DronePayloadSide', 'Fpv', 'Dock', 'Assistant', 'LensType'] as const, { optional: true }),
    overlayLevel: f.static.enum(['normal', 'top'] as const),
    visible: f.state.boolean({ default: false }),
    interactive: f.state.boolean({ default: false }),
    width: f.state.cssLength({ default: 320 }),
    height: f.state.cssLength({ default: 36 }),
    placement: f.state.enum([
      'fill',
      'top',
      'bottom',
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
      'custom',
    ] as const),
    offsetX: f.state.cssLength({ optional: true }),
    offsetY: f.state.cssLength({ optional: true }),
    top: f.state.cssLength({ optional: true }),
    right: f.state.cssLength({ optional: true }),
    bottom: f.state.cssLength({ optional: true }),
    left: f.state.cssLength({ optional: true }),
    render: f.method<() => ViewHandle>(),
  },
  /**
   * 左下角信息栏面板栈：由 Cockpit 宿主参与原生 AI/VLM 等面板的 flex 布局。
   * 插件只能声明内容与宽度，不得控制定位、高度或跨插件排序。
   * 该宿主区域受载荷控制权门控；无控制权时仍需展示的面板必须使用 live-overlay。
   */
  cockpitLeftBottomPanel: {
    visible: f.state.boolean({ default: false }),
    interactive: f.state.boolean({ default: true }),
    width: f.state.cssLength({ default: 240 }),
    render: f.method<() => ViewHandle>(),
  },
  contextMenuItem: {
    visible: f.state.boolean({ default: true }),
    icon: f.state.iconId(),
    label: f.state.string(),
    disabled: f.state.boolean({ default: false }),
    onTrigger: f.method<(ctx: {
      relativePos: RelativeVideoPoint;
      videoPoint: { readonly x: number; readonly y: number };
      stream: string;
    }) => void | Promise<void>>(),
  },
  messageAlertPopup: {
    visible: f.state.boolean({ default: false }),
    render: f.method<() => ViewHandle>(),
  },
  /**
   * 计划表单扩展（multiple）。匹配当前表单（mode/planType 由宿主判定）的贡献
   * 在提交时先统一 validate，再各自 onSubmit 返回字段补丁；宿主把补丁合并进
   * 任务提交体后仍调用原生任务下发接口。
   *
   * anchor 选择表单内的呈现位置（Manifest 静态字段，插件运行期不可改）：
   * - 缺省 / `form-end`：表单末尾（原生字段之后、操作按钮之前），现行为。
   * - `task-strategy:after`：任务策略配置区（含定时/重复参数）之后、自动断点续飞之前。
   * 未知的 anchor 值由 Manifest 校验拒绝；宿主对未知值按 form-end 防御处理。
   * 提交管线顺序与 anchor 无关：validate/onSubmit 始终按 PluginPlan 列表顺序执行。
   *
   * onSubmit 在所有贡献 validate 通过后执行，可调用已授权 Capability 完成提交准备，
   * 随后返回字段补丁。补丁可包含 `biz_ext`（值为仅含一个业务 key 的对象）声明任务
   * 归属；同一任务最多归属一个业务插件，多个插件同时贡献 biz_ext 时宿主在发送请求前
   * 整体阻断。提交准备产生的宿主临时资源必须由 Host 失败清理路径负责回收。
   * onEditSubmit 是可选的隐藏编辑生命周期；宿主仅在编辑提交时调用，不渲染该贡献，
   * 插件应根据 form.biz_ext 自行判断任务归属，非本插件任务直接返回。
   */
  planFormExtension: {
    anchor: f.static.enum(['form-end', 'task-strategy:after'] as const, { optional: true }),
    planType: f.static.enum(['all', 'normal', 'atob', 'manual'] as const),
    render: f.method<() => ViewHandle>(),
    validate: f.method<(input: PlanFormSubmitInput) => Promise<PlanFormValidationResult>>(),
    onSubmit: f.method<(input: PlanFormSubmitInput) => Promise<Record<string, PluginValue>>>(),
    onEditSubmit: f.methodOptional<(input: PlanFormEditSubmitInput) => Promise<void>>(),
  },
} as const satisfies Record<string, Record<string, FieldSpec>>
