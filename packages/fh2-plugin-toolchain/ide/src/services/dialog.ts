// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 模态对话框服务：队列状态 + Promise 接口。
 *
 * API 形状沿用原手写版（showDialog / confirmDialog / DialogSpec），
 * 渲染由 App 树内的 DialogHost.vue 完成（Naive UI），本模块不碰 DOM。
 * 不用 `window.confirm` / `window.prompt`：它们冻结渲染线程（Monaco 的
 * worker 回调也被卡住），且仓库的 antfu 配置用 `no-alert` 明确禁止。
 */

import { reactive } from 'vue'

export interface DialogFieldBase {
  readonly name: string;
  readonly label: string;
}

export interface DialogTextField extends DialogFieldBase {
  readonly kind: 'text';
  readonly value?: string;
  readonly placeholder?: string;
  readonly hint?: string;
  readonly required?: boolean;
}

export interface DialogSelectField extends DialogFieldBase {
  readonly kind: 'select';
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly value?: string;
  readonly hint?: string;
}

export interface DialogCheckboxField extends DialogFieldBase {
  readonly kind: 'checkbox';
  readonly value?: boolean;
  readonly hint?: string;
  /** 勾上代表破坏性升级（如递归删除 / 覆盖），用醒目色。 */
  readonly danger?: boolean;
}

export interface DialogMemberNode {
  readonly id: string;
  readonly label: string;
  /** 递归树：叶子（children 为空数组）的 id 即提交值，分支 id 仅作展示 key。 */
  readonly children: readonly DialogMemberNode[];
}

export interface DialogMembersField extends DialogFieldBase {
  /** U2 打包范围：级联勾选树（capability → 侧别分组 → 插件成员）。 */
  readonly kind: 'members';
  readonly tree: readonly DialogMemberNode[];
  /** 选中成员的限定 id（叶子 id）；缺省 = 全选。 */
  readonly value?: readonly string[];
  readonly hint?: string;
}

/**
 * 「键 = 值」对字段（如工作流向导的事件筛选条件）。
 *
 * ★ 与 text 字段的「键=值, 逗号分隔」写法相比，行式编辑不用记隐藏约定 ——
 *   与画布检查器里的同形字段（PairRowsField）共用一套理解。
 */
export interface DialogPairsField extends DialogFieldBase {
  readonly kind: 'pairs';
  readonly value?: Readonly<Record<string, string>>;
  readonly keyPlaceholder?: string;
  readonly valuePlaceholder?: string;
  readonly hint?: string;
  readonly required?: boolean;
}

export type DialogField =
  | DialogTextField
  | DialogSelectField
  | DialogCheckboxField
  | DialogMembersField
  | DialogPairsField

export type DialogValues = Readonly<Record<string, string | boolean | readonly string[] | Readonly<Record<string, string>>>>

export interface DialogSpec {
  readonly title: string;
  /** 正文段落。每个元素一段，纯文本（不解析 HTML）。 */
  readonly body?: readonly string[];
  readonly fields?: readonly DialogField[];
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /**
   * 底部取消键的返回值（缺省 null）。
   *
   * 右上角 X / Esc / 点遮罩始终返回 null；只有用户主动点带自定义文案的
   * 取消键时才交付这个值，用来区分「关闭对话框」和「改走另一条分支」。
   */
  readonly cancelResult?: DialogValues;
  /** 破坏性操作：确认键用红色。 */
  readonly danger?: boolean;
}

export type DialogResult = DialogValues | null

interface ActiveDialog {
  /** 递增序号：DialogHost 用作 :key，保证连续打开两个对话框时表单状态重建。 */
  readonly id: number;
  readonly spec: DialogSpec;
  readonly resolve: (result: DialogResult) => void;
}

interface DialogState {
  current: ActiveDialog | null;
}

const state: DialogState = reactive({ current: null })
let serial = 0

/** DialogHost.vue 消费；业务代码不要直接改。 */
export function dialogState (): DialogState {
  return state
}

/** 关闭当前对话框并交付结果。 */
export function closeDialog (result: DialogResult): void {
  const current = state.current
  if (current === null) return
  state.current = null
  current.resolve(result)
}

/** 同一时刻只允许一个对话框；新开的会先把旧的关掉，避免焦点陷阱。 */
export function showDialog (spec: DialogSpec): Promise<DialogResult> {
  closeDialog(null)
  return new Promise<DialogResult>((resolve) => {
    serial += 1
    state.current = { id: serial, spec, resolve }
  })
}

/** 只要「确定 / 取消」的简化入口。 */
export async function confirmDialog (spec: Omit<DialogSpec, 'fields'>): Promise<boolean> {
  return await showDialog(spec) !== null
}
