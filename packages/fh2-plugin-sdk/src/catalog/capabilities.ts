// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type {
  ApiCallOptions,
  BlobStore,
  Disposable,
  JsonValue,
  KeyValueStore,
  PlatformEventApi,
  PluginValue,
  PluginWsEvent,
  ViewHandle,
  ViewPresentation,
} from '../contracts/index.js'

export interface GeoPoint {
  readonly lng: number;
  readonly lat: number;
  readonly height: number;
}

export interface VideoPoint {
  readonly x: number;
  readonly y: number;
}

export interface CapabilityAvailability {
  readonly status: 'available' | 'unavailable' | 'unsupported';
  readonly reason: string | null;
}

/**
 * @fh2-contract frontend.capability.platform:http
 * 使用 ctx.apiCall 发起受管 HTTP 调用；成功返回 JSON 响应，失败走异常，不是原生 Response。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "platform:http"。通过 ctx.apiCall 使用内建入口，不重新封装原生网络或存储。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface PlatformHttpCapability {
  call<TData extends JsonValue = JsonValue>(endpoint: string, options?: ApiCallOptions): Promise<TData>;
}

/**
 * @fh2-contract frontend.capability.platform:events
 * 使用 ctx.events 订阅声明的平台事件，事件名与载荷按当前契约，不自行创建全局通信通道。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "platform:events"。通过 ctx.events 使用内建入口，不重新封装原生网络或存储。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export type PlatformEventsCapability = PlatformEventApi

/**
 * @fh2-contract frontend.capability.platform:websocket
 * 使用 ctx.ws 订阅宿主管理连接上的业务码消息，不自行建连、发送或控制重连。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "platform:websocket"。通过 ctx.ws 使用内建入口，不重新封装原生网络或存储。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface PlatformWebsocketCapability {
  onBizCode<TData extends JsonValue = JsonValue>(
    bizCode: string,
    handler: (event: PluginWsEvent<TData>) => void,
  ): Disposable;
}

/**
 * @fh2-contract frontend.capability.platform:storage
 * 通过 ctx.storage 读写 JSON，通过 ctx.blobs 保存二进制与取得受管资源 URL。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "platform:storage"。通过 ctx.storage / ctx.blobs 使用内建入口，不重新封装原生网络或存储。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface PlatformStorageCapability {
  readonly local: KeyValueStore;
  readonly session: KeyValueStore;
  readonly blobs: BlobStore;
}

/**
 * @fh2-contract frontend.capability.platform:navigation
 * 使用受管导航打开地址或返回页面，目标和可用宿主以当前曝光契约为准。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "platform:navigation"。使用 await ctx.capabilities.get("platform:navigation")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface PlatformNavigationCapability {
  open(url: string, options: { readonly target: 'self' | 'blank' }): Promise<void>;
  back(): Promise<void>;
}

export interface PlatformLocationState {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

/**
 * @fh2-contract frontend.capability.platform:location
 * 读取并订阅当前宿主页面位置，未提供的宿主曝光保持待确认。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "platform:location"。使用 await ctx.capabilities.get("platform:location")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface PlatformLocationCapability {
  getState(): PlatformLocationState;
  onStateChanged(handler: (state: PlatformLocationState) => void): Disposable;
}

/**
 * 平台已知机型的稳定语义标识；未知机型统一为 'unknown'。
 *
 * 该枚举只保证「同一物理机型跨版本返回同一 ID」。
 * 新机型进入目录属于兼容变更；消费方必须把 'unknown' 视为不可识别并自行决定策略。
 * 需要原始数字机型 key 的场景（如航线文件机型声明）读 PlatformDeviceModel.modelKey。
 */
export type PlatformDeviceModelId =
  | 'dock'
  | 'dock-2'
  | 'dock-3'
  | 'dock-4'
  | 'm30'
  | 'm30t'
  | 'm3d'
  | 'm3td'
  | 'm4d'
  | 'm4td'
  | 'm5td'
  | 'matrice-400'
  | 'unknown'

export interface PlatformDeviceModel {
  /** 平台稳定机型标识；未知机型为 'unknown'。 */
  readonly id: PlatformDeviceModelId;
  /** 展示名（如 'DJI Dock 3'、'Matrice 4TD'）；后端未提供时为 null。 */
  readonly name: string | null;
  /**
   * 原始机型 key（domain-type-subtype，如 '0-100-1'）；宿主拓扑未提供时为 null。
   * 供需要向后端/航线文件声明具体机型的场景（如示教航线生成的 drone_model_key）；
   * 展示与业务分流一律用 id/name，不得按 key 字符串分发。
   */
  readonly modelKey: string | null;
}

/** 设备身份与连接状态的通用描述。 */
export interface PlatformDeviceIdentity {
  readonly sn: string;
  readonly model: PlatformDeviceModel;
  /** 设备呼号；未设置时为 null，消费方自行决定 SN 回退。 */
  readonly callsign: string | null;
  readonly connectionState: 'online' | 'offline' | 'unknown';
}

/**
 * 飞行器工作状态。
 *
 * 'shutdown-in-dock' 与 'starting-up' 是平台根据机场/机库上报的在舱与子设备
 * 连接状态推导的语义，消费方无需理解数字 mode code。
 */
export type PlatformAircraftOperatingState =
  | 'standby'
  | 'shutdown-in-dock'
  | 'starting-up'
  | 'not-connected'
  | 'upgrading'
  | 'working'
  | 'unknown'

export interface PlatformProjectAircraft extends PlatformDeviceIdentity {
  /** 飞行器自身上报位置；未上报时为 null（在舱关机时可回退机场/机库位置）。 */
  readonly position: GeoPoint | null;
  /** 是否停放在机场/机库内。 */
  readonly inDock: boolean;
  readonly operatingState: PlatformAircraftOperatingState;
  /**
   * 电量百分比。舱内关机/开机中时取机场上报的充电电量；未知或异常时为 null。
   */
  readonly batteryPercent: number | null;
  /** 是否正在机场内充电。 */
  readonly batteryCharging: boolean;
  /** 剩余飞行时长（秒）；未知时为 null。 */
  readonly remainFlightTimeSeconds: number | null;
}

/** 机场/机库工作状态；'executing-task' 表示正在执行飞行任务。 */
export type PlatformDockOperatingState =
  | 'idle'
  | 'on-site-debugging'
  | 'remote-debugging'
  | 'upgrading'
  | 'executing-task'
  | 'uncalibrated'
  | 'low-power'
  | 'emergency-stop'
  | 'battery-swap'
  | 'log-fetching'
  | 'offline'
  | 'unknown'

export interface PlatformProjectDock extends PlatformDeviceIdentity {
  /** 机场/机库位置；含离线前最后位置回退，未知时为 null。 */
  readonly position: GeoPoint | null;
  readonly operatingState: PlatformDockOperatingState;
}

/**
 * 项目内一组相关设备：飞行器、其起降机场/机库与通信网关。
 *
 * 任一角色缺失时为 null（例如遥控器直连的飞行器没有机场；机场条目可能
 * 没有飞行器）。能否参与派遣等业务策略由插件基于这些语义字段自行决定。
 */
export interface PlatformProjectDevice {
  readonly aircraft: PlatformProjectAircraft | null;
  readonly dock: PlatformProjectDock | null;
  /** 通信网关设备；网联飞机为其自身，否则为机场/基站等父设备。 */
  readonly gateway: PlatformDeviceIdentity | null;
}

/**
 * @fh2-contract frontend.capability.platform:devices
 * 按 projectId 获取规范化设备快照，处理角色缺失、离线和未知机型，不按未核对的原始数值分流。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "platform:devices"。使用 await ctx.capabilities.get("platform:devices")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface PlatformDevicesCapability {
  /**
   * 查询项目设备快照。宿主负责把原始拓扑协议规范化为语义 DTO；
   * 接口失败或业务错误码时 Reject。
   */
  getProjectDevices(input: {
    readonly projectId: string;
  }): Promise<readonly PlatformProjectDevice[]>;
}

export interface CockpitContextState {
  readonly organizationId: string | null;
  readonly projectId: string | null;
  readonly droneSn: string | null;
  readonly gatewaySn: string | null;
  readonly alertExecutionId: string | null;
  readonly liveReady: boolean;
  /** 当前飞行航次 ID；宿主从 FlightTask 状态提供，未起飞或旧宿主为 null。 */
  readonly flightId?: string | null;
}

/**
 * @fh2-contract frontend.capability.cockpit:context
 * 读取驾驶舱当前项目、设备与直播状态，并订阅上下文变化。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "cockpit:context"。使用 await ctx.capabilities.get("cockpit:context")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface CockpitContextCapability {
  getState(): CockpitContextState;
  onStateChanged(handler: (state: CockpitContextState) => void): Disposable;
}

/** WPMZ missionConfig 受控改写项；由宿主映射为 WPMZ 标准值并同步写入 template.kml 与 waylines.wpml。 */
export interface WpmzMissionConfigChanges {
  readonly finishAction?: 'no-action' | 'go-home' | 'auto-land' | 'goto-first-waypoint';
  readonly rcLost?:
    | { readonly behavior: 'continue' }
    | { readonly behavior: 'execute-action'; readonly action: 'go-home' | 'land' | 'hover' };
  readonly takeOffReference?: {
    readonly longitude: number;
    readonly latitude: number;
    readonly altitude: number;
    readonly aglHeight?: number;
  };
}

/**
 * @fh2-contract frontend.capability.platform:wpmz
 * 通过受管能力读取航线坐标或做契约允许的航线改写，失败仍需按异步调用处理。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "platform:wpmz"。使用 await ctx.capabilities.get("platform:wpmz")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface PlatformWpmzCapability {
  parseCoordinates(input: {
    readonly url: string;
    readonly referenceAltitude?: number;
  }): Promise<readonly GeoPoint[]>;

  /** 改写指定航线文件的 missionConfig 并原地持久化，保持 waylineId 不变。 */
  rewrite(input: {
    readonly target: {
      readonly projectId: string;
      readonly waylineId: string;
    };
    readonly changes: {
      readonly missionConfig?: WpmzMissionConfigChanges;
    };
  }): Promise<{
    readonly waylineId: string;
    readonly changed: boolean;
  }>;
}

export interface CameraState {
  readonly availability: CapabilityAvailability;
  readonly mode: 'photo' | 'record' | null;
  readonly lens: 'wide' | 'zoom' | null;
  readonly zoom: number | null;
  readonly recording: boolean;
}

/** 有效视频画幅内的归一化矩形。 */
export interface BoundingZoomRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 录像所有权句柄。`acquireRecording()` 成功时返回；
 * `stop()` 只停止本句柄启动（或接管）的那一代录像；
 * 被后写覆盖抢占后本句柄立即失效，`stop()/dispose()` 不会再作用于设备。
 */
export interface CameraRecordingHandle extends Disposable {
  /** 请求停止录像并等待设备权威状态；句柄失效后调用是幂等 no-op。 */
  stop(): Promise<void>;
  onRevoked(handler: (reason: 'superseded' | 'device-state-changed' | 'disposed') => void): Disposable;
}

export interface CameraCaptureOptions {
  readonly scale: number;
  readonly mime: 'image/png' | 'image/jpeg';
  readonly quality?: number;
}

export interface CameraCapturedFrame {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: number;
}

/**
 * @fh2-contract frontend.capability.cockpit:camera
 * 读取相机状态，并按可用性、模式和控制条件执行拍照、变焦或受管录像。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "cockpit:camera"。使用 await ctx.capabilities.get("cockpit:camera")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface CockpitCameraCapability {
  getState(): CameraState;
  onStateChanged(handler: (state: CameraState) => void): Disposable;
  /** 切换拍照/录像模式；Provider 必须等待设备权威状态确认后返回。 */
  ensureMode(mode: 'photo' | 'record'): Promise<void>;
  switchLens(lens: 'wide' | 'zoom'): Promise<void>;
  ensureZoom(factor: number): Promise<void>;
  /** 按有效视频画幅的归一化矩形执行框选变焦。 */
  boundingZoom(rect: BoundingZoomRect): Promise<void>;
  takePhoto(): Promise<{ readonly accepted: boolean; readonly capturedAt: number }>;
  /**
   * 获取录像所有权：设备未录像时启动录像；`takeover: true` 时接管既有录像。
   * 后写覆盖——新申请成功后旧句柄收到 `superseded` 并失效。
   */
  acquireRecording(input: { readonly takeover?: boolean }): Promise<CameraRecordingHandle>;
  /**
   * `requireGeometry` 默认 true，截图会同时创建用于投影的几何快照；
   * false 时仅截图，不读取 SEI，返回的 geometrySnapshotId 为 null。
   */
  captureFrame(options: CameraCaptureOptions & { readonly requireGeometry?: boolean }): Promise<CameraCapturedFrame & {
    readonly geometrySnapshotId: string | null;
  }>;
}

export interface CockpitDeviceState {
  readonly roster: {
    readonly droneSn: string | null;
    readonly gatewaySn: string | null;
    readonly gatewayType: 'base_station' | 'dock' | 'rc' | 'unknown';
    readonly dockSn: string | null;
    readonly baseStationSn: string | null;
    readonly rcSn: string | null;
    readonly isNetworked: boolean;
  } | null;
}

export interface CockpitDroneState {
  readonly pose: {
    readonly source: 'drc' | 'ws';
    readonly longitude: number | null;
    readonly latitude: number | null;
    readonly height: number | null;
    readonly elevation: number | null;
    readonly attitude_head: number | null;
    readonly horizontal_speed: number | null;
    readonly vertical_speed: number | null;
    readonly home_distance: number | null;
  } | null;
  readonly mode: { readonly source: 'drc' | 'ws'; readonly mode_code: number | null } | null;
  readonly link: { readonly drcReady: boolean; readonly timeDiffDeviceAndWeb: number };
  /**
   * 飞机侧 Unix 毫秒时间戳；语义对齐 Cockpit SDK（云端物模型锚定，不做 DRC 兜底）。
   * 无数据或未上报时为 null；用于抓拍/事件与飞机录像、飞行记录的跨系统对齐。
   */
  readonly timestamp: number | null;
}

export interface CockpitDockState {
  readonly status: {
    readonly source: 'airport' | 'dock';
    readonly sn: string | null;
    readonly mode_code: number | null;
    readonly cover_state: number | null;
    readonly putter_state: number | null;
    readonly drone_in_dock: number | null;
    readonly emergency_stop_state: number | null;
    readonly alarm_state: number | null;
  } | null;
  readonly position: {
    readonly source: 'airport' | 'dock';
    readonly longitude: number | null;
    readonly latitude: number | null;
    readonly height: number | null;
  } | null;
  readonly environment: {
    readonly source: 'airport' | 'dock';
    readonly rainfall: number | null;
    readonly wind_speed: number | null;
    readonly temperature: number | null;
    readonly humidity: number | null;
    readonly environment_temperature: number | null;
    readonly environment_humidity: number | null;
  } | null;
}

export interface CockpitPayloadState {
  readonly camera: {
    readonly source: 'drc' | 'ws';
    readonly camera_index: string;
    readonly camera_mode: number | null;
    readonly photo_state: number | null;
    readonly recording_state: number | null;
    readonly record_time: number | null;
    readonly zoom_factor: number | null;
    readonly remain_photo_num: number | null;
    readonly remain_record_duration: number | null;
    readonly lens: 'wide' | 'zoom' | null;
  } | null;
  readonly gimbal: {
    readonly pitch: number | null;
    readonly yaw: number | null;
    readonly roll: number | null;
    readonly locked: boolean;
  } | null;
  readonly laser: {
    readonly latitude: number | null;
    readonly longitude: number | null;
    readonly altitude: number | null;
    readonly distance: number | null;
  } | null;
}

export interface CockpitControlState {
  readonly flight: { readonly hasControl: boolean; readonly ownerUserId: string | null };
  readonly payload: { readonly hasControl: boolean; readonly ownerUserId: string | null };
}

/** Cockpit SDK 可序列化状态快照；字段名、嵌套和空值语义与 SDK 保持一致。 */
export interface TelemetryState {
  readonly device: CockpitDeviceState;
  readonly drone: CockpitDroneState;
  readonly dock: CockpitDockState;
  readonly payload: CockpitPayloadState;
  readonly control: CockpitControlState;
}

export type TelemetryChangeSource =
  | 'device'
  | 'drone'
  | 'dock'
  | 'payload.camera'
  | 'payload.gimbal'
  | 'payload.laser'
  | 'control'

export interface TelemetryChangedEvent {
  readonly source: TelemetryChangeSource;
  readonly state: TelemetryState;
}

/**
 * @fh2-contract frontend.capability.cockpit:telemetry
 * 读取或订阅飞机与机场遥测，处理设备状态和字段未提供的情况。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "cockpit:telemetry"。使用 await ctx.capabilities.get("cockpit:telemetry")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface CockpitTelemetryCapability {
  getState(): TelemetryState;
  onStateChanged(handler: (event: TelemetryChangedEvent) => void): Disposable;
}

/**
 * @fh2-contract frontend.capability.platform:notification
 * 显示受管通知并在需要时释放，不依赖宿主内部提示组件。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "platform:notification"。使用 await ctx.capabilities.get("platform:notification")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface PlatformNotificationCapability {
  show(options: {
    readonly key: string;
    readonly message: string;
    readonly intent: 'info' | 'success' | 'warning' | 'error';
    readonly durationMs?: number;
  }): Disposable;
}

export interface PlatformObjectUploadInput {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly objectKey: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly securityToken: string;
  readonly usePathStyle?: boolean;
  readonly blob: Blob;
}

/** 由 Host 使用临时 STS 凭证执行受控对象上传。 */
/**
 * @fh2-contract frontend.capability.platform:object-upload
 * 在当前允许的同 Realm 驾驶舱入口使用对象上传能力；凭据来自获授权流程，不在示例中自造真实凭据。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "platform:object-upload"。使用 await ctx.capabilities.get("platform:object-upload")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface PlatformObjectUploadCapability {
  upload(input: PlatformObjectUploadInput): Promise<{ readonly etag: string | null }>;
}

export type PlatformAudioPreset = 'warning' | 'shutter' | 'record-start' | 'record-stop'

export type PlatformAudioSource =
  | { readonly type: 'preset'; readonly sound: PlatformAudioPreset }
  | { readonly type: 'url'; readonly url: string }
  | { readonly type: 'plugin'; readonly path: `./${string}` }

export interface PlatformAudioPlayer extends Disposable {
  play(options?: { readonly restart?: boolean }): Promise<void>;
  pause(): void;
  stop(): void;
  setVolume(input: { readonly volume: number }): void;
  setLoop(input: { readonly loop: boolean }): void;
}

/**
 * @fh2-contract frontend.capability.platform:audio
 * 创建受管提示音播放器，按资源句柄控制与释放播放。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "platform:audio"。使用 await ctx.capabilities.get("platform:audio")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface PlatformAudioCapability {
  createPlayer(input: {
    readonly source: PlatformAudioSource;
    readonly volume?: number;
    readonly loop?: boolean;
  }): PlatformAudioPlayer;
}

export interface PlatformDialogOptions {
  readonly title?: string;
  /** 期望宽度（px）；Host 必须按当前视口安全限宽。 */
  readonly width?: number;
  /** 期望内容区高度（px）；Host 必须按当前视口安全限高。 */
  readonly height?: number;
  /** 隐藏宿主标题栏和关闭按钮；插件必须在 View 内提供关闭入口。 */
  readonly hideHeader?: boolean;
}

/** 由平台 Shell 在宿主原生模态层中呈现插件内容 View；遮罩不关闭，ESC 关闭。 */
/**
 * @fh2-contract frontend.capability.platform:dialog
 * 把已声明界面的 ViewHandle 交给宿主打开弹窗，不传 Vue 实例或 DOM。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "platform:dialog"。使用 await ctx.capabilities.get("platform:dialog")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface PlatformDialogCapability {
  open(view: ViewHandle, options?: PlatformDialogOptions): Promise<ViewPresentation>;
}

/** 检测目标的语义状态；由 Provider 从设备枚举归一化，未识别值映射为 unknown。插件自行业务过滤。 */
export type DetectionTargetState =
  | 'tracked'
  | 'vision-beacon-fused'
  | 'auxiliary-tracked'
  | 'not-confident'
  | 'lost-predicting'
  | 'lost'
  | 'redetected'
  | 'invalid'
  | 'unknown'

export interface DetectionFrame {
  readonly frameId: string;
  /** AI SEI 内时间戳；它不是浏览器 wall clock。 */
  readonly capturedAt: number;
  /** 播放器 presentation 时钟（微秒）；直播未建立时为 null。 */
  readonly frameTimestampUs: number | null;
  /** Host 私有 GeometrySnapshot 的短期关联 ID；快照不可用时为 null。 */
  readonly geometrySnapshotId: string | null;
  readonly targets: readonly {
    readonly targetId: string;
    readonly type: string;
    readonly state: DetectionTargetState;
    readonly bbox: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  }[];
}

/**
 * @fh2-contract frontend.capability.cockpit:detection
 * 订阅检测帧，在支持的几何条件下转换画面坐标与地面坐标。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "cockpit:detection"。使用 await ctx.capabilities.get("cockpit:detection")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface CockpitDetectionCapability {
  onFrame(
    handler: (frame: DetectionFrame) => void,
    options?: { readonly maxFps?: 1 | 2 | 5 | 10 | 30 },
  ): Disposable;
  /** 使用检测帧采集时的 Host 私有几何快照完成投影；快照缺失或已过期时返回 null。 */
  projectToGround(
    frameId: string,
    points: readonly VideoPoint[],
    input: { readonly groundHeight: number },
  ): Promise<{
    readonly capturedAt: number;
    readonly points: readonly (GeoPoint | null)[];
  } | null>;
  /** 使用检测帧采集时的几何快照，把地理点正投为该帧画面归一化坐标；快照缺失或过期返回 null。 */
  projectFromGround(
    frameId: string,
    points: readonly GeoPoint[],
  ): Promise<{
    readonly capturedAt: number;
    readonly points: readonly (VideoPoint | null)[];
  } | null>;
}

export interface AiConfigState {
  readonly availability: CapabilityAvailability;
  readonly model: string | null;
  readonly recognitionEnabled: boolean;
  readonly targetTypes: readonly string[];
}

/**
 * @fh2-contract frontend.capability.cockpit:ai-config
 * 读取识别配置、提交受支持配置并观察是否确认生效。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "cockpit:ai-config"。使用 await ctx.capabilities.get("cockpit:ai-config")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface CockpitAiConfigCapability {
  getState(): AiConfigState;
  onStateChanged(handler: (state: AiConfigState) => void): Disposable;
  ensure(input: {
    /** 稳定模型语义；Host 负责映射为 Cockpit SDK 的 index=0 visible 模型。 */
    readonly model?: 'dji-visible';
    readonly recognitionEnabled?: boolean;
    /** 提供时精确替换可见光识别目标全集；空数组表示关闭全部目标类型。 */
    readonly targetTypes?: readonly string[];
  }): Promise<{
    readonly confirmed: boolean;
    readonly reason: string | null;
  }>;
}

/**
 * @fh2-contract frontend.capability.cockpit:scene-geometry
 * 按实际场景快照与坐标契约进行视频和地面几何转换，不能把无法投影当成功结果。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "cockpit:scene-geometry"。使用 await ctx.capabilities.get("cockpit:scene-geometry")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface CockpitSceneGeometryCapability {
  /**
   * Host 在一次调用内冻结 Cockpit 私有 GeometrySnapshot 并完成投影。
   * Snapshot 不跨 Realm；插件只获得可序列化的坐标与采集时间。
   */
  projectVideoToGround(
    points: readonly VideoPoint[],
    input: { readonly groundHeight: number },
  ): Promise<{
    readonly capturedAt: number;
    readonly points: readonly (GeoPoint | null)[];
  } | null>;
  /** 使用同一份 Host 私有快照，将地理点投影为有效视频画面内的归一化坐标。 */
  projectGeoToVideo(points: readonly GeoPoint[]): Promise<{
    readonly capturedAt: number;
    readonly points: readonly (VideoPoint | null)[];
  } | null>;
  /**
   * 按 `camera.captureFrame()` 返回的 geometrySnapshotId 反投：使用截图那一刻的几何，
   * 而非调用时刻姿态。快照由 Provider 保存至 `releaseSnapshot()` 或 Runtime 回收。
   */
  projectSnapshotVideoToGround(
    snapshotId: string,
    points: readonly VideoPoint[],
    input: { readonly groundHeight: number },
  ): Promise<{
    readonly capturedAt: number;
    readonly points: readonly (GeoPoint | null)[];
  } | null>;
  /** 按快照 ID 把地理点正投为截图时刻的画面归一化坐标。 */
  projectSnapshotGeoToVideo(
    snapshotId: string,
    points: readonly GeoPoint[],
  ): Promise<{
    readonly capturedAt: number;
    readonly points: readonly (VideoPoint | null)[];
  } | null>;
  /** 释放不再需要的截图几何快照；未知 ID 是幂等 no-op。 */
  releaseSnapshot(snapshotId: string): Promise<void>;
}

export type CockpitLivePointerRevocationReason = 'host-mode' | 'disposed'

export interface CockpitLivePointerLease extends Disposable {
  readonly stream: string;
  release(): void;
  onRevoked(handler: (reason: CockpitLivePointerRevocationReason) => void): Disposable;
}

/**
 * @fh2-contract frontend.capability.cockpit:live-pointer
 * 使用受管直播画面指针交互，不传递或持有宿主 DOM。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "cockpit:live-pointer"。使用 await ctx.capabilities.get("cockpit:live-pointer")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface CockpitLivePointerCapability {
  acquire(stream?: string): Promise<CockpitLivePointerLease>;
}

/**
 * @fh2-contract frontend.capability.cockpit:flight-control
 * 在驾驶舱中请求受管飞行控制与返航等操作；获取能力不代表已取得控制权。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "cockpit:flight-control"。使用 await ctx.capabilities.get("cockpit:flight-control")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface CockpitFlightControlCapability {
  acquireControl(type?: 'flight' | 'payload' | 'all'): Promise<void>;
  releaseControl(): Promise<void>;
  flyTo(points: readonly GeoPoint[], options?: { readonly maxSpeed?: number }): Promise<void>;
  emergencyStop(): Promise<void>;
  returnHome(): Promise<void>;
  returnHomeCancel(): Promise<void>;
}

/**
 * @fh2-contract frontend.capability.cockpit:gimbal
 * 通过受管云台能力执行姿态操作，先处理能力缺席与操作拒绝。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "cockpit:gimbal"。使用 await ctx.capabilities.get("cockpit:gimbal")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface CockpitGimbalCapability {
  reset(mode?: 'all' | 'yaw' | 'down'): Promise<void>;
  lookAt(
    point: VideoPoint | GeoPoint,
    options?: {
      /** 视频点使用；地理点由 Host 直接发送 camera_look_at，不读取该字段。 */
      readonly videoType?: 'normal' | 'wide' | 'zoom' | 'ir' | 'thermal';
      readonly locked?: boolean;
    },
  ): Promise<void>;
}

/**
 * 智能跟踪（SPZ）语义状态。Provider 负责设备协议编排（enable/track/等待 OSD 权威状态）
 * 并把固件数字状态映射为语义 phase；插件只消费语义状态做业务决策。
 */
export type SmartTrackPhase =
  | 'off'
  | 'selecting'
  | 'confirming'
  | 'tracking'
  | 'lost'
  | 'stopping'
  | 'error'
  | 'unknown'

export interface SmartTrackState {
  readonly availability: CapabilityAvailability;
  readonly phase: SmartTrackPhase;
  /** 当前跟踪目标 ID；phase 非 tracking/lost 时为 null。 */
  readonly targetId: string | null;
  /** 最近一次离开 tracking 的原因；从未跟踪时为 null。 */
  readonly exitReason: string | null;
}

/**
 * @fh2-contract frontend.capability.cockpit:smart-track
 * 读取智能跟踪状态，并在能力允许时请求启动或停止跟踪。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "cockpit:smart-track"。使用 await ctx.capabilities.get("cockpit:smart-track")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface CockpitSmartTrackCapability {
  getState(): SmartTrackState;
  onStateChanged(handler: (state: SmartTrackState) => void): Disposable;
  /**
   * 按检测目标 ID 启动跟踪（主路径）：Provider 编排 开启 SPZ → 指定目标 → 等待权威 tracking。
   * 也可以用画面矩形启动（人工框选路径）。
   */
  start(target:
    | { readonly kind: 'detection-target'; readonly targetId: string }
    | { readonly kind: 'rect'; readonly bbox: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } },
  ): Promise<SmartTrackState>;
  /** 停止跟踪并回到 off；返回终态。 */
  stop(): Promise<SmartTrackState>;
}

export type FlightTaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'unknown'

export interface WaylineTaskSnapshot {
  readonly taskId: string | null;
  readonly status: FlightTaskStatus;
  readonly progressPercent: number | null;
  readonly waylineUuid: string | null;
  readonly taskType: string | null;
  readonly completedWaypointCount: number | null;
  readonly totalWaypointCount: number | null;
}

export interface InFlightWaylineTaskSnapshot {
  readonly taskId: string | null;
  readonly status: FlightTaskStatus;
  readonly progressPercent: number | null;
  readonly taskName: string | null;
}

export interface FlightTaskState {
  /** 当前活动任务形态；终态快照保留时可以为 null。 */
  readonly kind: 'wayline' | 'in-flight-wayline' | null;
  readonly flightId: string | null;
  /** 普通航线任务快照；即时航线执行期间父任务快照仍保留。 */
  readonly wayline: WaylineTaskSnapshot | null;
  /** 空中下发的即时航线任务快照。 */
  readonly inFlightWayline: InFlightWaylineTaskSnapshot | null;
}

/**
 * @fh2-contract frontend.capability.cockpit:flight-task
 * 读取飞行任务状态，并按实际可用条件请求或取消飞行中航线任务。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "cockpit:flight-task"。使用 await ctx.capabilities.get("cockpit:flight-task")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface CockpitFlightTaskCapability {
  getState(): FlightTaskState;
  onStateChanged(handler: (state: FlightTaskState) => void): Disposable;
  startInFlightWayline(input: {
    readonly waylineUuid: string;
    readonly rthAltitude: number;
    readonly taskName: string;
    readonly waylineDuration: number;
    readonly waylineLength: number;
    readonly finishAction: 'goHome';
  }): Promise<{ readonly taskId: string }>;
  cancelInFlightWayline(input: {
    readonly taskId: string;
    readonly afterCancel: 'hover';
  }): Promise<void>;
}

export interface CockpitArOverlayCapability {
  create(input: { readonly id: string; readonly position: VideoPoint; readonly content: PluginValue }): Disposable & {
    update(patch: { readonly position?: VideoPoint; readonly content?: PluginValue }): void;
  };
}

/**
 * @fh2-contract frontend.capability.cockpit:hotkeys
 * 在驾驶舱注册受管快捷键，避免直接安装无法随插件卸载的全局键盘监听。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "cockpit:hotkeys"。使用 await ctx.capabilities.get("cockpit:hotkeys")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface CockpitHotkeysCapability {
  register(input: {
    readonly key: string;
    readonly modifiers?: readonly ('ctrl' | 'alt' | 'meta' | 'shift')[];
    readonly allowInInput?: boolean;
    readonly enabled?: boolean;
    readonly onTrigger: () => void | Promise<void>;
  }): Disposable & {
    update(patch: { readonly enabled?: boolean }): void;
  };
}

export type PlatformMapElementKind = 'marker' | 'billboard' | 'label' | 'polyline' | 'polygon'

export interface PlatformMapElementBase {
  readonly position?: GeoPoint;
  readonly visible?: boolean;
}

export interface PlatformMapMarkerInput extends PlatformMapElementBase {
  readonly position: GeoPoint;
  readonly icon?: string;
  readonly label?: string;
  readonly color?: string;
  /** 贴地：开启后图元贴合地表；缺省 false，按坐标绝对高度渲染。 */
  readonly clampToGround?: boolean;
}

export interface PlatformMapBillboardInput extends PlatformMapElementBase {
  readonly position: GeoPoint;
  readonly image: string;
  readonly width?: number;
  readonly height?: number;
  /** 贴地：开启后图元贴合地表；缺省 false，按坐标绝对高度渲染。 */
  readonly clampToGround?: boolean;
}

export interface PlatformMapLabelInput extends PlatformMapElementBase {
  readonly position: GeoPoint;
  readonly text: string;
  readonly color?: string;
  readonly fontSize?: number;
  /** 贴地：开启后图元贴合地表；缺省 false，按坐标绝对高度渲染。 */
  readonly clampToGround?: boolean;
}

export interface PlatformMapPolylineInput {
  readonly points: readonly GeoPoint[];
  readonly color?: string;
  readonly width?: number;
  readonly dashed?: boolean;
  readonly visible?: boolean;
  /** 贴地：开启后线贴合地表；缺省 false，按坐标绝对高度连接。 */
  readonly clampToGround?: boolean;
}

export interface PlatformMapPolygonInput {
  readonly points: readonly GeoPoint[];
  readonly fillColor?: string;
  readonly fillOpacity?: number;
  readonly outlineColor?: string;
  readonly outlineWidth?: number;
  readonly visible?: boolean;
  /** 贴地：开启后面（含轮廓）贴合地表；缺省 false，按坐标绝对高度渲染。 */
  readonly clampToGround?: boolean;
}

export interface PlatformMapElementHandle<TPatch> extends Disposable {
  readonly id: string;
  update(patch: TPatch): Promise<void>;
}

export interface PlatformMapInteractionEvent {
  readonly id: string;
  readonly kind: PlatformMapElementKind;
  readonly position: GeoPoint | null;
}

export interface PlatformMapHoverEvent extends PlatformMapInteractionEvent {
  readonly hovering: boolean;
}

export interface PlatformMapContextMenuTriggerEvent {
  /** 菜单点击位置拾取结果；拾取失败（如指向天空）为 null。 */
  readonly position: GeoPoint | null;
}

export interface PlatformMapContextMenuItemInput {
  /** 插件内局部菜单项 ID；宿主按插件命名空间隔离，不会与其他插件冲突。 */
  readonly id: string;
  readonly label: string;
  /** 菜单分组；省略时使用插件默认分组。 */
  readonly group?: { readonly id: string; readonly label: string };
  onTrigger(event: PlatformMapContextMenuTriggerEvent): void | Promise<void>;
}

/**
 * @fh2-contract frontend.capability.platform:map
 * 在受管地图添加图元并订阅交互，更新和释放图元通过资源句柄完成。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "platform:map"。使用 await ctx.capabilities.get("platform:map")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface PlatformMapCapability {
  addMarker(input: PlatformMapMarkerInput): Promise<PlatformMapElementHandle<Partial<PlatformMapMarkerInput>>>;
  addBillboard(input: PlatformMapBillboardInput): Promise<PlatformMapElementHandle<Partial<PlatformMapBillboardInput>>>;
  addLabel(input: PlatformMapLabelInput): Promise<PlatformMapElementHandle<Partial<PlatformMapLabelInput>>>;
  addPolyline(input: PlatformMapPolylineInput): Promise<PlatformMapElementHandle<Partial<PlatformMapPolylineInput>>>;
  addPolygon(input: PlatformMapPolygonInput): Promise<PlatformMapElementHandle<Partial<PlatformMapPolygonInput>>>;
  recenter(input: { readonly points: readonly GeoPoint[]; readonly padding?: number }): Promise<void>;
  onClick(handler: (event: PlatformMapInteractionEvent) => void): Disposable;
  onHover(handler: (event: PlatformMapHoverEvent) => void): Disposable;
  /** 注册全局地图右键菜单项；宿主负责菜单渲染与点击位置拾取，点击后回调插件。 */
  registerContextMenuItem(input: PlatformMapContextMenuItemInput): Disposable;
}

/**
 * @fh2-contract frontend.capability.platform:clipboard
 * 通过受管能力复制文本，仍需处理浏览器或权限导致的调用失败。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "platform:clipboard"。使用 await ctx.capabilities.get("platform:clipboard")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface PlatformClipboardCapability {
  /** 将文本写入系统剪贴板；写入失败抛错，由插件决定降级提示。 */
  writeText(input: { readonly text: string }): void;
}

export interface ProjectContextState {
  readonly projectId: string | null;
  readonly organizationId: string | null;
  readonly userInfo: {
    readonly org_role: string | null;
    readonly project_role: string | null;
    readonly user_id: string | null;
    readonly nick_name: string | null;
    readonly account: string | null;
  };
}

/**
 * @fh2-contract frontend.capability.project:context
 * 读取当前项目、组织和用户角色，用于业务上下文与界面展示，不替代后端权限校验。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "project:context"。使用 await ctx.capabilities.get("project:context")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface ProjectContextCapability {
  getState(): ProjectContextState;
  onStateChanged(handler: (state: ProjectContextState) => void): Disposable;
}

export type PlanFormMode =
  | 'create'
  | 'copy'
  | 'edit'
  | 'airport-test'
  | 'workflow-create'
  | 'workflow-edit'

/** 计划表单状态快照；PlanForm 未挂载或已卸载时 available 为 false。 */
export type PlanFormContextState =
  | {
    readonly available: false;
    /** 每次有效快照变化递增；unavailable 状态沿用最后一个 revision。 */
    readonly revision: number;
  }
  | {
    readonly available: true;
    readonly revision: number;
    readonly projectId: string;
    readonly mode: PlanFormMode;
    readonly planType: 'normal' | 'atob' | 'manual';
    readonly isMultiWayline: boolean;
    /** PlanForm 实例标识；表单重新挂载时变化，插件据此重置本地开关状态。 */
    readonly formInstanceId?: string | undefined;
    /** 基于当前任务提交体生成的规范化草稿；JSON 安全，Dayjs 已转 Unix 时间戳。 */
    readonly draft: Record<string, PluginValue>;
    /**
     * 复制模式下源任务的 biz_ext（任务详情原样快照）；其余模式为 undefined。
     * 业务插件据此初始化开关；复制提交时 biz_ext 由插件重新贡献，不自动继承。
     */
    readonly sourceBizExt?: Record<string, PluginValue> | undefined;
  }

/**
 * @fh2-contract frontend.capability.plan:form-context
 * 读取计划表单挂载期间的草稿与 revision，表单不在当前状态时按不可用分支处理。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "plan:form-context"。使用 await ctx.capabilities.get("plan:form-context")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface PlanFormContextCapability {
  getState(): PlanFormContextState;
  onStateChanged(handler: (state: PlanFormContextState) => void): Disposable;
}

/** 终点标记的宿主显示语义：alert 对应告警激活点图标，home 对应起降家点图标。 */
export type PlatformWaylinePreviewDestinationKind = 'alert' | 'home'

export interface PlatformWaylinePreviewDestination {
  readonly position: GeoPoint;
  readonly kind: PlatformWaylinePreviewDestinationKind;
}

export interface PlatformWaylinePreviewInput {
  readonly points: readonly GeoPoint[];
  readonly startPosition: GeoPoint | null;
  readonly destination: PlatformWaylinePreviewDestination | null;
}

export interface PlatformWaylinePreviewHandle extends Disposable {
  update(input: PlatformWaylinePreviewInput): void;
}

/**
 * @fh2-contract frontend.capability.platform:wayline-preview
 * 通过受管航线预览句柄显示、更新或移除预览，不直接控制宿主地图设施。
 *
 * 用法：在 fh2-plugin.json 的 permissions 中声明 "platform:wayline-preview"。使用 await ctx.capabilities.get("platform:wayline-preview")，能力不可用时处理 undefined；获取或调用失败仍须处理异常。能力客户端的方法与资源句柄方法按当前插件侧类型等待返回结果。
 */
export interface PlatformWaylinePreviewCapability {
  show(input: PlatformWaylinePreviewInput): PlatformWaylinePreviewHandle;
}

export interface CapabilityContractMap {
  readonly 'platform:http': PlatformHttpCapability;
  readonly 'platform:events': PlatformEventsCapability;
  readonly 'platform:websocket': PlatformWebsocketCapability;
  readonly 'platform:storage': PlatformStorageCapability;
  readonly 'platform:navigation': PlatformNavigationCapability;
  readonly 'platform:location': PlatformLocationCapability;
  readonly 'platform:wpmz': PlatformWpmzCapability;
  readonly 'platform:audio': PlatformAudioCapability;
  readonly 'platform:clipboard': PlatformClipboardCapability;
  readonly 'platform:notification': PlatformNotificationCapability;
  readonly 'platform:dialog': PlatformDialogCapability;
  readonly 'platform:map': PlatformMapCapability;
  readonly 'platform:wayline-preview': PlatformWaylinePreviewCapability;
  readonly 'platform:object-upload': PlatformObjectUploadCapability;
  readonly 'platform:devices': PlatformDevicesCapability;
  readonly 'cockpit:context': CockpitContextCapability;
  readonly 'cockpit:camera': CockpitCameraCapability;
  readonly 'cockpit:telemetry': CockpitTelemetryCapability;
  readonly 'cockpit:detection': CockpitDetectionCapability;
  readonly 'cockpit:ai-config': CockpitAiConfigCapability;
  readonly 'cockpit:scene-geometry': CockpitSceneGeometryCapability;
  readonly 'cockpit:live-pointer': CockpitLivePointerCapability;
  readonly 'cockpit:flight-control': CockpitFlightControlCapability;
  readonly 'cockpit:gimbal': CockpitGimbalCapability;
  readonly 'cockpit:hotkeys': CockpitHotkeysCapability;
  readonly 'cockpit:smart-track': CockpitSmartTrackCapability;
  readonly 'cockpit:flight-task': CockpitFlightTaskCapability;
  readonly 'project:context': ProjectContextCapability;
  readonly 'plan:form-context': PlanFormContextCapability;
}

export type CapabilityId = keyof CapabilityContractMap
export type CapabilityContract<TId extends CapabilityId> = CapabilityContractMap[TId]

/** 已有 PluginContext 顶层 facade 覆盖的平台基础能力，不再重复暴露给插件作者。 */
export type PlatformFacadeCapabilityId =
  | 'platform:http'
  | 'platform:events'
  | 'platform:websocket'
  | 'platform:storage'

export type PluginCapabilityId = Exclude<CapabilityId, PlatformFacadeCapabilityId>

type AsyncCapabilityHandle<THandle> = {
  readonly [TKey in keyof THandle]: THandle[TKey] extends (...args: infer TArgs) => infer TResult
    ? (...args: TArgs) => Promise<Awaited<TResult>>
    : THandle[TKey]
}

type PluginCapabilityResult<TResult> = Awaited<TResult> extends import('../contracts/plugin.js').Disposable
  ? AsyncCapabilityHandle<Awaited<TResult>>
  : Awaited<TResult>

/**
 * 插件消费的异步 Capability Client。
 * Host Provider 可同步实现，但跨 SDK/Engine 后所有方法都有统一 Promise 语义。
 */
export type PluginCapabilityClient<TId extends PluginCapabilityId> = {
  readonly [TKey in keyof CapabilityContract<TId>]: CapabilityContract<TId>[TKey] extends (
    ...args: infer TArgs
  ) => infer TResult
    ? (...args: TArgs) => Promise<PluginCapabilityResult<TResult>>
    : never
}

export type CapabilityMemberDescriptor<TContract> = {
  readonly [TKey in keyof TContract]: TContract[TKey] extends (...args: infer _TArgs) => infer _TResult
    ? 'method'
    : 'value';
}

export type CapabilityDescriptorMap = {
  readonly [TId in CapabilityId]: {
    readonly id: TId;
    /** Manifest 授权项；与 Capability ID 是两个独立维度。 */
    readonly permission: `${string}:${string}`;
    readonly realm: 'any' | 'same-origin';
    /** Provider 的唯一注册与生命周期归属，与 ID 命名空间无关。 */
    readonly providerScope: 'builtin' | 'platform' | 'host';
    /** platform Provider 是否必须在 Host mount 前就绪。 */
    readonly providerRequirement: 'required' | 'optional';
    /** TypeScript 类型擦除后的最低运行时契约，用于校验 Provider 返回值。 */
    readonly members: CapabilityMemberDescriptor<CapabilityContractMap[TId]>;
  };
}

/**
 * Capability 的唯一权威目录。
 *
 * Host Provider 只选择 id 并实现对应 contract；permission/realm/members 均由 SDK 决定，
 * 避免 Host、Engine 和插件各自维护一份会漂移的字符串映射。
 */
export const CAPABILITY_DESCRIPTORS = {
  'platform:http': {
    id: 'platform:http',
    permission: 'platform:http',
    realm: 'any',
    providerScope: 'builtin',
    providerRequirement: 'required',
    members: { call: 'method' },
  },
  'platform:events': {
    id: 'platform:events',
    permission: 'platform:events',
    realm: 'any',
    providerScope: 'builtin',
    providerRequirement: 'required',
    members: { on: 'method' },
  },
  'platform:websocket': {
    id: 'platform:websocket',
    permission: 'platform:websocket',
    realm: 'any',
    providerScope: 'builtin',
    providerRequirement: 'required',
    members: { onBizCode: 'method' },
  },
  'platform:storage': {
    id: 'platform:storage',
    permission: 'platform:storage',
    realm: 'any',
    providerScope: 'builtin',
    providerRequirement: 'required',
    members: { local: 'value', session: 'value', blobs: 'value' },
  },
  'platform:navigation': {
    id: 'platform:navigation',
    permission: 'platform:navigation',
    realm: 'any',
    providerScope: 'host',
    providerRequirement: 'optional',
    members: { open: 'method', back: 'method' },
  },
  'platform:location': {
    id: 'platform:location',
    permission: 'platform:location',
    realm: 'any',
    providerScope: 'host',
    providerRequirement: 'optional',
    members: { getState: 'method', onStateChanged: 'method' },
  },
  'platform:wpmz': {
    id: 'platform:wpmz',
    permission: 'platform:wpmz',
    realm: 'any',
    providerScope: 'platform',
    providerRequirement: 'required',
    members: { parseCoordinates: 'method', rewrite: 'method' },
  },
  'platform:audio': {
    id: 'platform:audio',
    permission: 'platform:audio',
    realm: 'any',
    providerScope: 'platform',
    providerRequirement: 'required',
    members: { createPlayer: 'method' },
  },
  'platform:clipboard': {
    id: 'platform:clipboard',
    permission: 'platform:clipboard',
    realm: 'any',
    providerScope: 'platform',
    providerRequirement: 'optional',
    members: { writeText: 'method' },
  },
  'platform:notification': {
    id: 'platform:notification',
    permission: 'platform:notification',
    realm: 'any',
    providerScope: 'host',
    providerRequirement: 'optional',
    members: { show: 'method' },
  },
  'platform:dialog': {
    id: 'platform:dialog',
    permission: 'platform:dialog',
    realm: 'any',
    providerScope: 'platform',
    providerRequirement: 'optional',
    members: { open: 'method' },
  },
  'platform:map': {
    id: 'platform:map',
    permission: 'platform:map',
    realm: 'any',
    providerScope: 'platform',
    providerRequirement: 'optional',
    members: {
      addMarker: 'method',
      addBillboard: 'method',
      addLabel: 'method',
      addPolyline: 'method',
      addPolygon: 'method',
      recenter: 'method',
      onClick: 'method',
      onHover: 'method',
      registerContextMenuItem: 'method',
    },
  },
  'platform:wayline-preview': {
    id: 'platform:wayline-preview',
    permission: 'platform:wayline-preview',
    realm: 'any',
    providerScope: 'platform',
    providerRequirement: 'optional',
    members: { show: 'method' },
  },
  'platform:object-upload': {
    id: 'platform:object-upload',
    permission: 'platform:object-upload',
    realm: 'same-origin',
    providerScope: 'platform',
    providerRequirement: 'optional',
    members: { upload: 'method' },
  },
  'platform:devices': {
    id: 'platform:devices',
    permission: 'platform:devices',
    realm: 'any',
    providerScope: 'platform',
    providerRequirement: 'optional',
    members: { getProjectDevices: 'method' },
  },
  'cockpit:context': {
    id: 'cockpit:context',
    permission: 'cockpit:context',
    realm: 'any',
    providerScope: 'host',
    providerRequirement: 'optional',
    members: { getState: 'method', onStateChanged: 'method' },
  },
  'cockpit:camera': {
    id: 'cockpit:camera',
    permission: 'cockpit:camera',
    realm: 'any',
    providerScope: 'host',
    providerRequirement: 'optional',
    members: {
      getState: 'method',
      onStateChanged: 'method',
      ensureMode: 'method',
      switchLens: 'method',
      ensureZoom: 'method',
      boundingZoom: 'method',
      takePhoto: 'method',
      acquireRecording: 'method',
      captureFrame: 'method',
    },
  },
  'cockpit:telemetry': {
    id: 'cockpit:telemetry',
    permission: 'cockpit:telemetry',
    realm: 'any',
    providerScope: 'host',
    providerRequirement: 'optional',
    members: { getState: 'method', onStateChanged: 'method' },
  },
  'cockpit:detection': {
    id: 'cockpit:detection',
    permission: 'cockpit:detection',
    realm: 'any',
    providerScope: 'host',
    providerRequirement: 'optional',
    members: { onFrame: 'method', projectToGround: 'method', projectFromGround: 'method' },
  },
  'cockpit:ai-config': {
    id: 'cockpit:ai-config',
    permission: 'cockpit:ai-config',
    realm: 'any',
    providerScope: 'host',
    providerRequirement: 'optional',
    members: { getState: 'method', onStateChanged: 'method', ensure: 'method' },
  },
  'cockpit:scene-geometry': {
    id: 'cockpit:scene-geometry',
    permission: 'cockpit:scene-geometry',
    realm: 'any',
    providerScope: 'host',
    providerRequirement: 'optional',
    members: {
      projectVideoToGround: 'method',
      projectGeoToVideo: 'method',
      projectSnapshotVideoToGround: 'method',
      projectSnapshotGeoToVideo: 'method',
      releaseSnapshot: 'method',
    },
  },
  'cockpit:live-pointer': {
    id: 'cockpit:live-pointer',
    permission: 'cockpit:live-pointer',
    realm: 'any',
    providerScope: 'host',
    providerRequirement: 'optional',
    members: { acquire: 'method' },
  },
  'cockpit:flight-control': {
    id: 'cockpit:flight-control',
    permission: 'cockpit:flight-control',
    realm: 'any',
    providerScope: 'host',
    providerRequirement: 'optional',
    members: {
      acquireControl: 'method',
      releaseControl: 'method',
      flyTo: 'method',
      emergencyStop: 'method',
      returnHome: 'method',
      returnHomeCancel: 'method',
    },
  },
  'cockpit:gimbal': {
    id: 'cockpit:gimbal',
    permission: 'cockpit:gimbal',
    realm: 'any',
    providerScope: 'host',
    providerRequirement: 'optional',
    members: { reset: 'method', lookAt: 'method' },
  },
  'cockpit:hotkeys': {
    id: 'cockpit:hotkeys',
    permission: 'cockpit:hotkeys',
    realm: 'any',
    providerScope: 'host',
    providerRequirement: 'optional',
    members: { register: 'method' },
  },
  'cockpit:smart-track': {
    id: 'cockpit:smart-track',
    permission: 'cockpit:smart-track',
    realm: 'any',
    providerScope: 'host',
    providerRequirement: 'optional',
    members: { getState: 'method', onStateChanged: 'method', start: 'method', stop: 'method' },
  },
  'cockpit:flight-task': {
    id: 'cockpit:flight-task',
    permission: 'cockpit:flight-task',
    realm: 'any',
    providerScope: 'host',
    providerRequirement: 'optional',
    members: {
      getState: 'method',
      onStateChanged: 'method',
      startInFlightWayline: 'method',
      cancelInFlightWayline: 'method',
    },
  },
  'project:context': {
    id: 'project:context',
    permission: 'project:context',
    realm: 'any',
    providerScope: 'host',
    providerRequirement: 'optional',
    members: { getState: 'method', onStateChanged: 'method' },
  },
  'plan:form-context': {
    id: 'plan:form-context',
    permission: 'plan:form-context',
    realm: 'any',
    providerScope: 'host',
    providerRequirement: 'optional',
    members: { getState: 'method', onStateChanged: 'method' },
  },
} as const satisfies CapabilityDescriptorMap

export type CapabilityDescriptor = (typeof CAPABILITY_DESCRIPTORS)[CapabilityId]
export type PermissionId = CapabilityDescriptor['permission']

type CapabilityIdByProviderScope<TScope extends CapabilityDescriptor['providerScope']> = {
  readonly [TId in CapabilityId]: (typeof CAPABILITY_DESCRIPTORS)[TId]['providerScope'] extends TScope
    ? TId
    : never;
}[CapabilityId]

export type BuiltinCapabilityId = CapabilityIdByProviderScope<'builtin'>
export type PlatformProviderCapabilityId = CapabilityIdByProviderScope<'platform'>
export type HostProviderCapabilityId = CapabilityIdByProviderScope<'host'>

/** 有序数组兼容现有目录消费者；内容仍来自唯一 Descriptor Map。 */
export const CAPABILITY_SPECS: readonly CapabilityDescriptor[] = Object.values(CAPABILITY_DESCRIPTORS)

export const REQUIRED_PLATFORM_PROVIDER_CAPABILITY_IDS: readonly PlatformProviderCapabilityId[] = CAPABILITY_SPECS
  .filter(descriptor => descriptor.providerScope === 'platform' && descriptor.providerRequirement === 'required')
  .map(descriptor => descriptor.id as PlatformProviderCapabilityId)

export const PLUGIN_CAPABILITY_IDS: readonly PluginCapabilityId[] = CAPABILITY_SPECS
  .map(descriptor => descriptor.id)
  .filter((id): id is PluginCapabilityId => !(
    id === 'platform:http'
    || id === 'platform:events'
    || id === 'platform:websocket'
    || id === 'platform:storage'
  ))

export function isCapabilityId (value: string): value is CapabilityId {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_DESCRIPTORS, value)
}

export function isPluginCapabilityId (value: string): value is PluginCapabilityId {
  return isCapabilityId(value) && PLUGIN_CAPABILITY_IDS.includes(value as PluginCapabilityId)
}

export function getCapabilityDescriptor (value: string): CapabilityDescriptor | undefined {
  return isCapabilityId(value) ? CAPABILITY_DESCRIPTORS[value] : undefined
}
