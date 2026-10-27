// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { ActionField } from '../../../../src/workflow/core/catalog.js'
import type { ScriptIoField } from '../../../../src/workflow/core/script-commands.js'

/**
 * 「功能契约」编辑器的草稿模型。
 *
 * ★ 为什么要一个**可变**的草稿模型，而不是直接改清单：
 * `ChangeScriptIO` 是「整份 io 替换」的命令，每敲一个字符发一条命令既是噪声
 * （Monaco 的撤销栈会被打成碎片），也会让「删一个出参」的影响确认框在打字途中弹出来。
 * 故编辑期只动草稿，点保存时才走一次命令。
 *
 * ⚠️ `fields` 这一层必须一路带着。它是手写清单里最容易被工具抹掉的东西：
 * 读进来是平的、写回去也是平的，嵌套声明就这么没了 —— 而没了之后 worker 的
 * `projectValue` 把整块原样放行，声明还在、约束消失，哪一侧都不会红。
 */
export interface DraftField {
  name: string;
  type: string;
  /**
   * 只服务入参。出参侧界面不给这个勾（worker 不读它：出参「声明即必产」），
   * 但草稿里仍然保留字段本身 —— 清单里原本写了 required 的出参，
   * 要能原样读进来、让用户看见它被去掉，而不是我们假装它从没存在过。
   */
  required: boolean;
  fields: DraftField[];
}

/** 清单里的声明 → 草稿。 */
export function toDraft (fields: readonly ActionField[]): DraftField[] {
  return fields.map(field => ({
    name: field.name,
    type: field.type,
    required: field.required === true,
    fields: toDraft(field.fields ?? []),
  }))
}

/**
 * 草稿 → 命令入参。
 *
 * 不在这里做任何校验与剔除：空名、词表外的类型、标量上的 fields 一律原样交给
 * `prepareChangeScriptIo` 去拒。**校验只能有一个执行点** —— 在这儿先悄悄修一遍，
 * 结果就是界面显示的和真正写进清单的不是同一份东西。
 */
export function toIoFields (draft: readonly DraftField[]): ScriptIoField[] {
  return draft.map(field => ({
    name: field.name.trim(),
    type: field.type,
    ...(field.required ? { required: true } : {}),
    ...(field.fields.length > 0 ? { fields: toIoFields(field.fields) } : {}),
  }))
}

/** 新增一行时的缺省值：类型取词表第一项，没有词表就留空让用户自己填。 */
export function blankField (types: readonly string[]): DraftField {
  return { name: '', type: types[0] ?? '', required: false, fields: [] }
}

/** 两份声明是否等价（判草稿脏不脏）。逐字段比，不用 JSON.stringify —— 键序无关。 */
export function sameDraft (left: readonly DraftField[], right: readonly DraftField[]): boolean {
  if (left.length !== right.length) return false
  return left.every((field, index) => {
    const other = right[index]!
    return field.name === other.name
      && field.type === other.type
      && field.required === other.required
      && sameDraft(field.fields, other.fields)
  })
}

/** 这个类型能不能带嵌套成员（object 是成员，array 是元素形状）。 */
export function isNestable (type: string): boolean {
  return type === 'object' || type === 'array'
}
