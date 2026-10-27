// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk/view'
import type { PluginViewClient } from 'fh2-plugin-sdk/view'

/**
 * 违停巡逻计划表单扩展 View 契约（plan.form-extensions 承载）。
 * 宿主把规范化任务草稿经 plan:form-context 推给插件；开关状态与违停复检间隔由插件自持。
 * UI 与内部状态以分钟为单位；提交时由 Plan Host 装配换算为秒写入 biz_ext.recheck_delay_sec。
 */

/** 违停复检间隔下限（分钟）。 */
export const RECHECK_DELAY_MIN_MINUTES = 1

/** 违停复检间隔上限（分钟）。 */
export const RECHECK_DELAY_MAX_MINUTES = 25

/** 违停复检间隔默认值（分钟）。 */
export const DEFAULT_RECHECK_DELAY_MINUTES = 10

/** 违停复检间隔非法提示文案。 */
export const RECHECK_DELAY_ERROR_MESSAGE = '违停复检间隔需为 1-25 的整数（分钟）'

/** 数值合法性：非空且为 [1, 25] 内的整数（分钟）。 */
export function isValidRecheckDelayMinutes (value: number | null): value is number {
  return value !== null
    && Number.isInteger(value)
    && value >= RECHECK_DELAY_MIN_MINUTES
    && value <= RECHECK_DELAY_MAX_MINUTES
}

/** 输入框文本解析（分钟）：空白或超出 [1, 25] 整数口径时返回 null。 */
export function parseRecheckDelayMinutesInput (raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const value = Number(trimmed)
  return isValidRecheckDelayMinutes(value) ? value : null
}

export interface PatrolFormState {
  /** 违停巡逻开关 */
  readonly enabled: boolean;
  /** 表单上下文可用（plan:form-context available 且当前为 create/copy 普通任务） */
  readonly contextAvailable: boolean;
  /** 多航线模式：开关禁用并自动关闭 */
  readonly multiWayline: boolean;
  /** 提交中（validate/onSubmit 执行期间） */
  readonly submitting: boolean;
  /** 违停复检间隔（分钟）；合法值恒为 [1, 25] 整数，null 表示当前输入非法，提交时由 validate 拦截 */
  readonly recheckDelayMinutes: number | null;
}

interface PatrolFormContract {
  readonly state: PatrolFormState;
  readonly methods: {
    setEnabled (input: { enabled: boolean }): void;
    setRecheckDelayMinutes (input: { value: number | null }): void;
  };
}

export const patrolFormView = definePluginView<PatrolFormContract>('patrol-form')

export type PatrolFormViewClient = PluginViewClient<PatrolFormContract>
