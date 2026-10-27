// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { Disposable } from '../contracts/plugin.js'
import type { IsPluginValue } from '../contracts/plugin-value.js'

type ServiceMethod = (...args: never[]) => unknown

type InvalidMethod<TMethods extends object> = {
  [K in keyof TMethods]: TMethods[K] extends (...args: infer TArgs) => infer TResult
    ? TArgs extends []
      ? IsPluginValue<TResult> extends true ? never : K
      : TArgs extends [infer TArg]
        ? IsPluginValue<TArg> extends true
          ? IsPluginValue<TResult> extends true ? never : K
          : K
        : K
    : K
}[keyof TMethods]

type InvalidEvent<TEvents extends object> = {
  [K in keyof TEvents]: IsPluginValue<TEvents[K]> extends true ? never : K
}[keyof TEvents]

type ReservedMethod<TMethods extends object> = Extract<keyof TMethods, 'dispose' | 'on'>
type OverlappingMember<TMethods extends object, TEvents extends object> = Extract<keyof TMethods, keyof TEvents>

type IsValidServiceContract<TMethods extends object, TEvents extends object> =
  InvalidMethod<TMethods> extends never
    ? InvalidEvent<TEvents> extends never
      ? ReservedMethod<TMethods> extends never
        ? OverlappingMember<TMethods, TEvents> extends never ? true : false
        : false
      : false
    : false

export interface PluginServiceDescriptor {
  readonly serviceId: string;
}

declare const serviceMethodsShape: unique symbol
declare const serviceEventsShape: unique symbol
declare const serviceImplementationShape: unique symbol

export interface PluginServiceContract<
  TMethods extends object = object,
  TEvents extends object = object,
> extends PluginServiceDescriptor {
  /** 幽灵字段：只为让 TypeScript 记住方法签名，运行时不存在。 */
  readonly [serviceMethodsShape]: TMethods;
  /** 幽灵字段：只为让 TypeScript 记住事件 payload，运行时不存在。 */
  readonly [serviceEventsShape]: TEvents;
  /** 幽灵字段：只为给 Provider 实现提供上下文类型，运行时不存在。 */
  readonly [serviceImplementationShape]: ServiceImplementation<TMethods, TEvents>;
}

export type ServiceMethodsOf<TService extends PluginServiceContract<any, any>> =
  TService[typeof serviceMethodsShape]

export type ServiceEventsOf<TService extends PluginServiceContract<any, any>> =
  TService[typeof serviceEventsShape]

export type ServiceImplementationOf<TService extends PluginServiceContract<any, any>> =
  TService[typeof serviceImplementationShape]

export function definePluginService<
  TMethods extends object = Record<never, never>,
  TEvents extends object = Record<never, never>,
> (
  serviceId: IsValidServiceContract<TMethods, TEvents> extends true ? string : never,
): PluginServiceContract<TMethods, TEvents> {
  if (serviceId.length === 0) throw new TypeError('Service ID 不能为空')
  return Object.freeze({ serviceId }) as unknown as PluginServiceContract<TMethods, TEvents>
}

type ServiceMethodArgs<T> = T extends (...args: infer TArgs) => unknown ? TArgs : never
type ServiceMethodResult<T> = T extends (...args: never[]) => infer TResult ? TResult : never

export type ServiceImplementation<TMethods extends object, TEvents extends object> = {
  readonly [K in keyof TMethods]: TMethods[K] extends ServiceMethod
    ? (...args: ServiceMethodArgs<TMethods[K]>) => ServiceMethodResult<TMethods[K]> | Promise<ServiceMethodResult<TMethods[K]>>
    : never
} & {
  readonly [K in keyof TEvents]: (
    emit: (payload: TEvents[K]) => void,
    options?: { readonly immediate?: boolean },
  ) => Disposable | void
}

export type ServiceClient<TMethods extends object, TEvents extends object> = {
  readonly [K in keyof TMethods]: TMethods[K] extends ServiceMethod
    ? (...args: ServiceMethodArgs<TMethods[K]>) => Promise<ServiceMethodResult<TMethods[K]>>
    : never
} & {
  on<K extends keyof TEvents & string>(
    event: K,
    handler: (payload: TEvents[K]) => void,
  ): Promise<Disposable>;
  dispose(): Promise<void>;
}
