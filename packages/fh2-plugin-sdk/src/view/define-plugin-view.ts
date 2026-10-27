// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type {
  Disposable,
  ExtensionPointMap,
  IsJsonValue,
  IsPluginValue,
  JsonValue,
  PluginContext,
  PluginValue,
  ViewHandle,
} from '../contracts/index.js'

/** Entry ↔ View typed state/method contract. */
export interface PluginViewContractSchema {
  readonly state: unknown;
  /** 可选的稳定初始状态字段；相同值复用 View，不同值重挂。 */
  readonly initialState?: unknown;
  readonly methods?: Readonly<Record<string, unknown>>;
}

type StateOf<T extends PluginViewContractSchema> = T['state']
type MethodMap<T extends PluginViewContractSchema> = T extends { readonly methods: infer TMethods extends Readonly<Record<string, unknown>> }
  ? TMethods
  : Readonly<Record<never, never>>
type MethodKey<T extends PluginViewContractSchema> = keyof MethodMap<T> & string
type MaybePromise<T> = T | Promise<T>
type ReservedMethodName = 'state' | 'dispose' | 'then' | 'catch' | 'finally' | 'constructor' | 'prototype' | '__proto__'

type IsMethodValueValid<TMethod> = TMethod extends (...args: infer TArgs) => infer TResult
  ? TArgs extends []
    ? Awaited<TResult> extends void ? true : IsPluginValue<Awaited<TResult>>
    : TArgs extends [infer TArg] | [(infer TArg)?]
      ? IsPluginValue<Exclude<TArg, undefined>> extends true
        ? Awaited<TResult> extends void ? true : IsPluginValue<Awaited<TResult>>
        : false
      : false
  : false

type InvalidMethodKey<T extends PluginViewContractSchema> = {
  [K in MethodKey<T>]: K extends ReservedMethodName
    ? K
    : IsMethodValueValid<MethodMap<T>[K]> extends true ? never : K
}[MethodKey<T>]

type IsValidContract<T extends PluginViewContractSchema> = IsPluginValue<StateOf<T>> extends true
  ? T extends { readonly initialState: infer TInitialState }
    ? TInitialState extends Partial<StateOf<T>>
      ? IsJsonValue<TInitialState> extends true
        ? InvalidMethodKey<T> extends never ? true : false
        : false
      : false
    : InvalidMethodKey<T> extends never ? true : false
  : false

type ClientMethod<TMethod> = TMethod extends (...args: infer TArgs) => infer TResult
  ? (...args: TArgs) => Promise<Awaited<TResult>>
  : never

type HandlerMethod<TMethod> = TMethod extends (...args: infer TArgs) => infer TResult
  ? (...args: TArgs) => MaybePromise<Awaited<TResult>>
  : never

export interface PluginViewStateSource<TState> {
  /** 必须在返回 Disposable 前同步发送完整当前状态。 */
  subscribe(listener: (state: TState) => void): Disposable;
}

export interface PluginViewSession<T extends PluginViewContractSchema> {
  readonly state: PluginViewStateSource<StateOf<T>>;
  readonly methods: {
    [K in MethodKey<T>]: HandlerMethod<MethodMap<T>[K]>
  };
  dispose?(): void | Promise<void>;
}

export interface PluginViewCall {
  readonly pluginId: string;
  readonly hostInstanceId: string;
  readonly viewId: string;
  readonly instanceId: number;
}

type PluginViewSessionProvider<T extends PluginViewContractSchema> = T extends { readonly initialState: infer TInitialState }
  ? (
      initialState: TInitialState,
      call: PluginViewCall,
    ) => MaybePromise<PluginViewSession<T>>
  : PluginViewSession<T>

type PluginViewGet<T extends PluginViewContractSchema> = T extends { readonly initialState: infer TInitialState }
  ? <TConfig extends object, TExtensions extends ExtensionPointMap>(
      ctx: PluginContext<TConfig, TExtensions>,
      initialState: TInitialState,
    ) => ViewHandle<TInitialState>
  : <TConfig extends object, TExtensions extends ExtensionPointMap>(
      ctx: PluginContext<TConfig, TExtensions>,
    ) => ViewHandle<null>

export interface PluginViewContract<T extends PluginViewContractSchema = PluginViewContractSchema> {
  readonly viewId: string;
  readonly get: PluginViewGet<T>;
  handle<
    TConfig extends object,
    TExtensions extends ExtensionPointMap,
  >(
    ctx: PluginContext<TConfig, TExtensions>,
    provider: PluginViewSessionProvider<T>,
  ): Promise<PluginViewHandlerRegistration>;
  client(port: MessagePort): PluginViewClient<T>;
}

export interface PluginViewHandlerRegistration extends Disposable {}

export interface PluginViewState<TState> {
  /** 首次订阅获得完整当前状态；后续订阅立即重放最新值。 */
  subscribe(handler: (state: TState) => void): Disposable;
}

export type PluginViewClient<T extends PluginViewContractSchema> = {
  readonly state: PluginViewState<StateOf<T>>;
} & {
  [K in MethodKey<T>]: ClientMethod<MethodMap<T>[K]>
} & {
  dispose(): void;
}

export function definePluginView<T extends PluginViewContractSchema> (
  viewId: IsValidContract<T> extends true ? string : never,
): PluginViewContract<T> {
  const get = ((ctx: PluginContext, initialState?: JsonValue): ViewHandle => (
    initialState === undefined
      ? ctx.views.get(viewId)
      : ctx.views.get(viewId, initialState)
  )) as PluginViewGet<T>

  return {
    viewId,
    get,
    handle: (ctx, provider) => {
      const runtimeProvider = typeof provider === 'function'
        ? provider
        : () => provider
      return ctx.views.handle(viewId, runtimeProvider as never)
    },
    client: port => createViewClient<T>(port),
  }
}

interface ViewResponseMessage {
  readonly t: 'resp';
  readonly id: number;
  readonly ok: true;
  readonly result?: unknown;
}
interface ViewResponseErrorMessage {
  readonly t: 'resp';
  readonly id: number;
  readonly ok: false;
  readonly error: { code?: string; message: string };
}
interface ViewStateMessage {
  readonly t: 'state';
  readonly value: unknown;
}
interface ViewCloseMessage {
  readonly t: 'close';
  readonly reason?: string;
}

const RESERVED_CLIENT_PROPERTIES = new Set([
  'state',
  'dispose',
  'then',
  'catch',
  'finally',
  'constructor',
  'prototype',
  '__proto__',
])

function createViewClient<T extends PluginViewContractSchema> (
  port: MessagePort,
): PluginViewClient<T> {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const stateSubscribers = new Set<(state: unknown) => void>()
  let nextId = 0
  let closed = false
  let hasState = false
  let latestState: unknown

  function close (reason = 'view channel closed', closePort = true): void {
    if (closed) return
    closed = true
    port.removeEventListener('message', onMessage)
    for (const request of pending.values()) request.reject(new Error(reason))
    pending.clear()
    stateSubscribers.clear()
    if (closePort) port.close()
  }

  function onMessage (event: MessageEvent): void {
    const data = event.data as ViewResponseMessage | ViewResponseErrorMessage | ViewStateMessage | ViewCloseMessage | undefined
    if (!data || typeof data !== 'object' || typeof data.t !== 'string') return
    if (data.t === 'close') {
      close(data.reason, true)
      return
    }
    if (data.t === 'resp') {
      const request = pending.get(data.id)
      if (!request) return
      pending.delete(data.id)
      if (data.ok) {
        request.resolve(data.result)
      } else {
        const error = new Error(data.error?.message ?? data.error?.code ?? 'view method failed') as Error & { code?: string }
        if (data.error?.code) error.code = data.error.code
        request.reject(error)
      }
      return
    }
    if (data.t === 'state') {
      hasState = true
      latestState = data.value
      for (const handler of [...stateSubscribers]) handler(data.value)
    }
  }
  port.addEventListener('message', onMessage)
  port.start()

  const request = (method: string, args: readonly unknown[]): Promise<unknown> => {
    if (closed) return Promise.reject(new Error('view channel closed'))
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      port.postMessage({ t: 'req', id, method, args })
    })
  }

  const state: PluginViewState<unknown> = {
    subscribe: (handler) => {
      if (closed) return { dispose: () => {} }
      stateSubscribers.add(handler)
      if (hasState) handler(latestState)
      return {
        dispose: () => {
          stateSubscribers.delete(handler)
        },
      }
    },
  }

  const target = { state, dispose: () => close('view client disposed', true) }
  return new Proxy(target, {
    get (obj, prop, receiver) {
      if (prop === 'state' || prop === 'dispose') return Reflect.get(obj, prop, receiver)
      if (prop === Symbol.toStringTag) return undefined
      if (typeof prop !== 'string') return Reflect.get(obj, prop, receiver)
      if (RESERVED_CLIENT_PROPERTIES.has(prop)) return undefined
      return (...args: readonly unknown[]) => request(prop, args)
    },
  }) as unknown as PluginViewClient<T>
}

export type { PluginValue }
