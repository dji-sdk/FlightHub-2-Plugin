// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 跨界传输的值域（SDK 设计 §1.7）。
 *
 * Entry 与 Host、Entry 与 View 之间流动的一切数据都必须落在这个集合内：
 * `isolated-iframe` 上由结构化克隆强制，`isolated-realm` 上同源直调不做序列化，
 * 边界改由「类型 + 构建期检查」保证（Engine §6.2.1）。
 */
/** JSON 通道可无损表达的值域。 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/** 浏览器结构化克隆可处理、且平台允许跨 Realm 传输的值域。 */
export type PluginValue =
  | undefined
  | null
  | boolean
  | number
  | bigint
  | string
  | Date
  | RegExp
  | Error
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | File
  | readonly PluginValue[]
  | ReadonlyMap<PluginValue, PluginValue>
  | ReadonlySet<PluginValue>
  | { readonly [key: string]: PluginValue }

type IsAny<T> = 0 extends (1 & T) ? true : false

type IsPluginValueMember<T> = [T] extends [undefined | null | boolean | number | bigint | string]
  ? true
  : T extends Date | RegExp | Error | ArrayBuffer | ArrayBufferView | Blob | File
    ? true
    : T extends readonly (infer TItem)[]
      ? IsPluginValue<TItem>
      : T extends ReadonlyMap<infer TKey, infer TValue>
        ? IsPluginValue<TKey> extends true ? IsPluginValue<TValue> : false
        : T extends ReadonlySet<infer TItem>
          ? IsPluginValue<TItem>
          : T extends object
            ? T extends (...args: never[]) => unknown
              ? false
              : false extends { [K in keyof T]-?: IsPluginValue<Exclude<T[K], undefined>> }[keyof T]
                ? false
                : true
            : false

/**
 * 递归判断一个声明类型是否完全落在 PluginValue 值域内。
 *
 * 与 `T extends PluginValue` 不同，这个判定按已声明字段检查普通 interface，
 * 不要求业务 DTO 额外声明 `[key: string]` 索引签名。
 */
export type IsPluginValue<T> = IsAny<T> extends true
  ? false
  : [T] extends [PluginValue]
      ? true
      : false extends (T extends unknown ? IsPluginValueMember<T> : never)
        ? false
        : true

type IsJsonValueMember<T> = [T] extends [null | boolean | number | string]
  ? true
  : T extends readonly (infer TItem)[]
    ? IsJsonValue<TItem>
    : T extends object
      ? T extends (...args: never[]) => unknown
        ? false
        : false extends { [K in keyof T]-?: IsJsonValue<Exclude<T[K], undefined>> }[keyof T]
          ? false
          : true
      : false

/** 按已声明字段递归判断一个类型是否落在 JsonValue 值域内。 */
export type IsJsonValue<T> = IsAny<T> extends true
  ? false
  : [T] extends [JsonValue]
      ? true
      : false extends (T extends unknown ? IsJsonValueMember<T> : never)
        ? false
        : true
