// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk'
import type { PluginViewClient } from 'fh2-plugin-sdk'

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/

/** 解析十进制度数文本：允许负数、整数与任意位小数；拒绝科学计数法、逗号、多个小数点等。 */
export function parseDecimalInput (value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!DECIMAL_PATTERN.test(trimmed)) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/** 表单校验结果：null 表示通过，string 为中文错误文案。 */
export function validateAddress (value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return '请输入地址'
  return trimmed.length > 100 ? '地址不能超过 100 字' : null
}

export function validateLatitude (value: string): string | null {
  const lat = parseDecimalInput(value)
  if (lat === null) return '纬度必须是十进制数字'
  if (lat < -90 || lat > 90) return '纬度范围 -90 ~ 90'
  return null
}

export function validateLongitude (value: string): string | null {
  const lng = parseDecimalInput(value)
  if (lng === null) return '经度必须是十进制数字'
  if (lng < -180 || lng > 180) return '经度范围 -180 ~ 180'
  return null
}

/** 高度为不小于 30 米的十进制米数；事故快处只消费数字类型 fly_alt/go_back_alt。 */
export function validateAltitude (value: string): string | null {
  const alt = parseDecimalInput(value)
  if (alt === null) return '高度必须是十进制数字（米）'
  if (alt < 30) return '高度不能低于 30 米'
  return null
}

export interface DispatchFormState {
  readonly submitting: boolean;
  /** 最近一次派发成功的 eventId，未提交过为 null。 */
  readonly lastEventId: string | null;
  /** 内联错误文案；无错误为 null。 */
  readonly error: string | null;
}

interface DispatchFormContract {
  state: DispatchFormState;
  methods: {
    dispatch: (input: {
      readonly address: string;
      readonly lat: number;
      readonly lng: number;
      readonly flyAlt: number;
      readonly goBackAlt: number;
    }) => void;
  };
}

export const dispatchFormView = definePluginView<DispatchFormContract>('dispatch-form')
export type DispatchFormViewClient = PluginViewClient<DispatchFormContract>
