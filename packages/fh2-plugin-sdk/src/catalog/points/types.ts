// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { FieldKind, FieldSpec } from './field.js'

export type PointContract = Readonly<Record<string, FieldSpec>>

export type FieldValue<T> = T extends { readonly __value?: infer V } ? V : never

type KeysOfKind<T extends PointContract, K extends FieldKind> = {
  [P in keyof T]: T[P] extends { readonly kind: K } ? P : never
}[keyof T]

type OptionalKeys<T extends PointContract, K extends FieldKind> = {
  [P in keyof T]: T[P] extends { readonly kind: K; readonly __options?: infer O }
    ? O extends { readonly optional: true } | { readonly default: unknown }
      ? P
      : never
    : never
}[keyof T]

type RequiredKeys<T extends PointContract, K extends FieldKind> = Exclude<KeysOfKind<T, K>, OptionalKeys<T, K>>

type ShapeOfKind<T extends PointContract, K extends FieldKind> = {
  readonly [P in RequiredKeys<T, K>]: FieldValue<T[P]>
} & {
  readonly [P in OptionalKeys<T, K>]?: FieldValue<T[P]>
}

export type StaticOf<T extends PointContract> = ShapeOfKind<T, 'static'>
export type StateOf<T extends PointContract> = ShapeOfKind<T, 'state'>
export type MethodsOf<T extends PointContract> = ShapeOfKind<T, 'method'>
export type ImplementationOf<T extends PointContract> = StateOf<T> & MethodsOf<T>
export type ContributionOf<T extends PointContract> = StaticOf<T> & StateOf<T> & MethodsOf<T>

export interface PointSpec<
  TId extends string,
  TContract extends PointContract,
  TMultiple extends boolean = true,
  TRevealable extends boolean = false,
> {
  readonly id: TId;
  readonly contract: TContract;
  readonly multiple: TMultiple;
  /** 该位置是否允许插件请求宿主展示并聚焦贡献。 */
  readonly revealable?: TRevealable;
}
