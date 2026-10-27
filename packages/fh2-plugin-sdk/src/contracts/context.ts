// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type {
  ImplementationOf,
  PointContractOf,
  PointId,
  RevealablePointId,
  StateOf,
} from '../catalog/points/index.js'
import type {
  PermissionId,
  PluginCapabilityClient,
  PluginCapabilityId,
} from '../catalog/capabilities.js'
import type { PlatformEventMap, PlatformEventName } from '../catalog/events.js'
import type { HostId } from '../catalog/hosts.js'
import type {
  PluginServiceContract,
  ServiceClient,
  ServiceEventsOf,
  ServiceImplementationOf,
  ServiceMethodsOf,
} from '../service/define-service.js'
import type { IsJsonValue, IsPluginValue, JsonValue, PluginValue } from './plugin-value.js'
import type { AsyncDisposable, Disposable } from './plugin.js'
import type { LocaleType } from './locale.js'
import type { ViewHandle } from './view.js'

export type ExtensionPointMap = Readonly<Record<string, PointId>>

type ExtensionImplementationMap<TExtensions extends ExtensionPointMap> = {
  [K in keyof TExtensions]: ImplementationOf<PointContractOf<TExtensions[K]>>
}

type ExtensionStateMap<TExtensions extends ExtensionPointMap> = {
  [K in keyof TExtensions]: StateOf<PointContractOf<TExtensions[K]>>
}

/** 贡献句柄：注册后用它推状态。没有同步 `get()`——见 SDK §6.5 */
export interface ExtensionHandle<TState extends object = Record<string, PluginValue>> {
  readonly extensionId: string;
  update(patch: Partial<TState>): Promise<void>;
  dispose(): Promise<void>;
}

export interface RevealableExtensionHandle<
  TState extends object = Record<string, PluginValue>,
> extends ExtensionHandle<TState> {
  /** 一次完成目标展示与宿主聚焦。 */
  reveal(input?: PluginValue): Promise<void>;
}

type ExtensionHandleOf<TExtensions extends ExtensionPointMap, K extends keyof TExtensions> =
  TExtensions[K] extends RevealablePointId
    ? RevealableExtensionHandle<ExtensionStateMap<TExtensions>[K]>
    : ExtensionHandle<ExtensionStateMap<TExtensions>[K]>

interface UntypedExtensionRegistry {
  contribute<TState extends object = Record<string, PluginValue>>(
    extensionId: string,
    implementation: TState,
  ): Promise<ExtensionHandle<TState>>;
}

interface TypedExtensionRegistry<TExtensions extends ExtensionPointMap> {
  contribute<K extends keyof TExtensions & string>(
    extensionId: K,
    implementation: ExtensionImplementationMap<TExtensions>[K],
  ): Promise<ExtensionHandleOf<TExtensions, K>>;
}

export type ExtensionRegistry<
  TExtensions extends ExtensionPointMap = Record<string, PointId>,
> = string extends keyof TExtensions
  ? UntypedExtensionRegistry
  : TypedExtensionRegistry<TExtensions>

export interface KeyValueStore {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
}

export interface BlobStore {
  get(key: string): Promise<Blob | undefined>;
  put(key: string, value: Blob): Promise<void>;
  remove(key: string): Promise<void>;
  /** 取得受 Engine 台账管理、仅在当前 Realm 有效的 Object URL。 */
  url(key: string): Promise<string | undefined>;
}

export interface PluginStorage {
  readonly local: KeyValueStore;
  readonly session: KeyValueStore;
}

export interface PluginLogger {
  debug(message: string): void;
  debug<TDetail>(message: string, detail: TDetail, ...invalid: IsPluginValue<TDetail> extends true ? [] : [never]): void;
  info(message: string): void;
  info<TDetail>(message: string, detail: TDetail, ...invalid: IsPluginValue<TDetail> extends true ? [] : [never]): void;
  warn(message: string): void;
  warn<TDetail>(message: string, detail: TDetail, ...invalid: IsPluginValue<TDetail> extends true ? [] : [never]): void;
  error(message: string): void;
  error<TDetail>(message: string, detail: TDetail, ...invalid: IsPluginValue<TDetail> extends true ? [] : [never]): void;
}

/** 受控 multipart 上传体；Engine 构造 FormData 并施加文件数量与大小限制。 */
export interface ApiMultipartBody {
  readonly kind: 'multipart';
  /** 附带的字符串表单字段。 */
  readonly fields?: Readonly<Record<string, string>>;
  /** 上传文件列表；每个文件必须是 Blob 或 File。 */
  readonly files: ReadonlyArray<{
    readonly field: string;
    readonly name: string;
    readonly contentType?: string;
    readonly blob: Blob;
  }>;
}

export interface ApiCallOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON、单个 Blob/File 或受控 multipart；GET 请求不允许携带 body。绝对 URL 仅接受 JsonValue。 */
  readonly body?: JsonValue | Blob | ApiMultipartBody;
  readonly timeoutMs?: number;
  /** 写请求的幂等键；Engine 仅将其映射为 Idempotency-Key。 */
  readonly idempotencyKey?: string;
}

export type AbsoluteHttpUrl = `http://${string}` | `https://${string}`

export interface ExternalApiCallOptions extends Omit<ApiCallOptions, 'body'> {
  readonly body?: JsonValue;
}

export type ApiCallOptionsFor<TEndpoint extends string> = TEndpoint extends AbsoluteHttpUrl
  ? ExternalApiCallOptions
  : ApiCallOptions

export type PlatformEvent<TName extends PlatformEventName = PlatformEventName> = {
  readonly [K in TName]: {
    readonly name: K;
    readonly payload: PlatformEventMap[K];
  }
}[TName]

export interface PlatformEventApi {
  on<TName extends PlatformEventName>(
    name: TName,
    handler: (event: PlatformEvent<TName>) => void,
  ): Promise<AsyncDisposable>;
}

/** 主仓唯一 WebSocket 中按后端 biz_code 路由的原始实时消息。 */
export interface PluginWsEvent<TData extends JsonValue = JsonValue> {
  readonly bizCode: string;
  /** 后端 sub_biz_code；消息未携带时为 null。 */
  readonly subBizCode: string | null;
  /** 后端消息时间戳（毫秒）；消息未携带时为 null。 */
  readonly timestamp: number | null;
  readonly data: TData;
}

/**
 * 共享 WebSocket 的只读订阅面。
 *
 * 插件不能建连、发送或控制重连；连接与上游订阅集合均由宿主管理。
 */
export interface PluginWsApi {
  onBizCode<TData extends JsonValue = JsonValue>(
    bizCode: string,
    handler: (event: PluginWsEvent<TData>) => void,
  ): Promise<AsyncDisposable>;
}

export interface PluginServiceRegistry {
  provide<TService extends PluginServiceContract<any, any>>(
    service: TService,
    implementation: ServiceImplementationOf<TService>,
  ): Promise<Disposable>;
  connect<TService extends PluginServiceContract<any, any>>(
    service: TService,
  ): Promise<ServiceClient<ServiceMethodsOf<TService>, ServiceEventsOf<TService>>>;
}

export interface PluginHostIdentity {
  readonly id: HostId;
  readonly instanceId: string;
}

export interface PluginCapabilityRegistry {
  get<TId extends PluginCapabilityId>(name: TId): Promise<PluginCapabilityClient<TId> | undefined>;
}

export interface PluginIdentity {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

export interface PluginLifecycle {
  /** Runtime 进入 Disposing 时 abort；Service connect 等挂起操作据此取消（§8） */
  readonly signal: AbortSignal;
  readonly disposed: boolean;
}

export interface TrackedTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/**
 * 插件在某个 Host 里拿到的上下文。
 *
 * `TConfig` 由 Toolchain 从 Manifest 的 `config` 生成并绑定
 * （见 toolchain §5），插件写 `activate(ctx: AppCockpitContext)` 即可。
 */
export interface PluginContext<
  TConfig extends object = Record<string, boolean | number | string>,
  TExtensions extends ExtensionPointMap = Record<string, PointId>,
> {
  readonly plugin: PluginIdentity;
  readonly host: PluginHostIdentity;
  /** 宿主当前 locale（LocaleType 快照）；EngineOptions.locale 注入，缺省 ZH。宿主切语言整页 reload 后随 Engine 重建更新。 */
  readonly locale: LocaleType;
  readonly config: Readonly<TConfig>;
  readonly permissions: readonly PermissionId[];
  readonly lifecycle: PluginLifecycle;
  readonly timers: TrackedTimers;
  readonly extensions: ExtensionRegistry<TExtensions>;
  readonly capabilities: PluginCapabilityRegistry;
  readonly services: PluginServiceRegistry;
  readonly storage: PluginStorage;
  readonly blobs: BlobStore;
  readonly events: PlatformEventApi;
  readonly ws: PluginWsApi;
  readonly logger: PluginLogger;

  /** 插件业务 HTTP 的**唯一**出口；裸 fetch / XHR / WebSocket 已被 Guard 拦掉（附录 D）。 */
  /**
   * 相对路径调用平台内部接口；绝对 HTTP(S) URL 经 Gateway 动态白名单出网。
   * 两者成功时都原样返回 JSON 响应，不自动提取 data；绝对 URL 不开放自定义 Header。
   */
  apiCall<
    TResponse extends JsonValue = JsonValue,
    TEndpoint extends string = `/${string}`,
  >(endpoint: TEndpoint, options?: ApiCallOptionsFor<TEndpoint>): Promise<TResponse>;
  apiCall<TResponse extends JsonValue = JsonValue>(endpoint: string, options?: ExternalApiCallOptions): Promise<TResponse>;

  views: {
    get(viewId: string): ViewHandle<null>;
    get<TInitialState>(
      viewId: string,
      initialState: TInitialState,
      ...invalid: IsJsonValue<TInitialState> extends true ? [] : [never]
    ): ViewHandle<TInitialState>;
    /** 注册该 viewId 的 typed handler（SDK §7.5）；同 viewId 只允许一个 */
    handle(viewId: string, sessionProvider: unknown): Promise<Disposable>;
  };
}

/** Cockpit Host 的 Context；Capability 面待各批次实现时补齐 */
export interface CockpitPluginContext<
  TConfig extends object = Record<string, boolean | number | string>,
  TExtensions extends ExtensionPointMap = Record<string, PointId>,
> extends PluginContext<TConfig, TExtensions> {
  readonly host: PluginHostIdentity & { readonly id: 'cockpit' };
}
