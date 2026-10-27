// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import valueParser from 'postcss-value-parser'

/** Extension Point 字段 DSL；插件、宿主、Engine 共用同一协议定义。 */
export type FieldKind = 'static' | 'state' | 'method'

/** Point 布局字段支持数字像素值或受控 CSS 长度表达式。 */
export type CssLength = number | string

export interface StateOptions<T> {
  readonly default?: T;
  readonly optional?: boolean;
}

export interface StaticOptions {
  readonly optional?: boolean;
}

export type FieldSpec<
  TKind extends FieldKind = FieldKind,
  TValue = unknown,
  TOptions extends object = object,
> = {
  readonly kind: TKind;
  readonly type: 'string' | 'number' | 'boolean' | 'enum' | 'cssLength' | 'iconId' | 'viewId' | 'method';
  readonly optional?: boolean;
  readonly default?: TValue;
  readonly values?: readonly string[];
  /** 仅用于类型提取，运行时不存在。 */
  readonly __value?: TValue;
  readonly __options?: TOptions;
} & TOptions

export const field = {
  static: {
    string: <const O extends StaticOptions = object>(o = {} as O): FieldSpec<'static', string, O> =>
      ({ kind: 'static', type: 'string', ...o }),
    number: <const O extends StaticOptions = object>(o = {} as O): FieldSpec<'static', number, O> =>
      ({ kind: 'static', type: 'number', ...o }),
    boolean: <const O extends StaticOptions = object>(o = {} as O): FieldSpec<'static', boolean, O> =>
      ({ kind: 'static', type: 'boolean', ...o }),
    enum: <const V extends readonly string[], const O extends StaticOptions = object>(
      values: V,
      o = {} as O,
    ): FieldSpec<'static', V[number], O> => ({ kind: 'static', type: 'enum', values, ...o }),
    cssLength: <const O extends StaticOptions = object>(o = {} as O): FieldSpec<'static', CssLength, O> =>
      ({ kind: 'static', type: 'cssLength', ...o }),
    viewId: <const O extends StaticOptions = object>(o = {} as O): FieldSpec<'static', string, O> =>
      ({ kind: 'static', type: 'viewId', ...o }),
  },
  state: {
    string: <const O extends StateOptions<string> = object>(o = {} as O): FieldSpec<'state', string, O> =>
      ({ kind: 'state', type: 'string', ...o }),
    number: <const O extends StateOptions<number> = object>(o = {} as O): FieldSpec<'state', number, O> =>
      ({ kind: 'state', type: 'number', ...o }),
    boolean: <const O extends StateOptions<boolean> = object>(o = {} as O): FieldSpec<'state', boolean, O> =>
      ({ kind: 'state', type: 'boolean', ...o }),
    enum: <const V extends readonly string[], const O extends StateOptions<V[number]> = object>(
      values: V,
      o = {} as O,
    ): FieldSpec<'state', V[number], O> => ({ kind: 'state', type: 'enum', values, ...o }),
    cssLength: <const O extends StateOptions<CssLength> = object>(o = {} as O): FieldSpec<'state', CssLength, O> =>
      ({ kind: 'state', type: 'cssLength', ...o }),
    iconId: <const O extends StateOptions<string> = object>(o = {} as O): FieldSpec<'state', string, O> =>
      ({ kind: 'state', type: 'iconId', ...o }),
  },
  method: <TSignature extends (...args: never[]) => unknown, const O extends { optional?: boolean } = object>(
    o = {} as O,
  ): FieldSpec<'method', TSignature, O> => ({ kind: 'method', type: 'method', ...o }),
  /**
   * 可选 method。签名必须显式给出，而 TS 的部分类型实参应用会禁用其余泛型推断，
   * 因此可选性无法经 `method(sig, { optional: true })` 传入，需要独立工厂。
   */
  methodOptional: <TSignature extends (...args: never[]) => unknown>(): FieldSpec<
    'method',
    TSignature,
    { readonly optional: true }
  > => ({ kind: 'method', type: 'method', optional: true }),
} as const

const CSS_LENGTH_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%|px|em|rem|vw|vh|vmin|vmax|ch|ex|cm|mm|q|in|pt|pc)$/i
const CSS_ZERO_PATTERN = /^[+-]?(?:0+(?:\.0+)?|\.0+)$/
const CSS_LENGTH_FUNCTIONS = new Set(['calc', 'min', 'max', 'clamp'])

function validCssLengthNodes (nodes: ReturnType<typeof valueParser>['nodes']): boolean {
  let hasValue = false
  for (const node of nodes) {
    if (node.type === 'space' || node.type === 'comment') continue
    if (node.type === 'div') {
      if (node.value !== ',' && node.value !== '/') return false
      continue
    }
    if (node.type === 'word') {
      if (node.value === '+' || node.value === '-' || node.value === '*' || node.value === '/') continue
      if (!CSS_ZERO_PATTERN.test(node.value) && !CSS_LENGTH_PATTERN.test(node.value)) return false
      hasValue = true
      continue
    }
    if (node.type === 'function') {
      if (!CSS_LENGTH_FUNCTIONS.has(node.value.toLowerCase()) || !validCssLengthNodes(node.nodes)) return false
      hasValue = true
      continue
    }
    return false
  }
  return hasValue
}

/** 不接受 url()/var()/关键字，避免把任意 CSS 文本带进 Host style。 */
export function isCssLength (value: unknown): value is CssLength {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'string' || value.trim() === '') return false
  return validCssLengthNodes(valueParser(value.trim()).nodes)
}
