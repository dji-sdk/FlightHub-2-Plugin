// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk/view'
import type { PluginViewClient } from 'fh2-plugin-sdk/view'

/** 行人上路抓拍"识别确认中 / 结束本轮"提示条（K 键；Esc 是宿主保留安全键，不可注册）。 */

/**
 * - hidden：不显示
 * - confirming：LookAt 完成后等待 SPZ 稳定与后端 tracking 创建
 * - ready：后端 trackingId 已取得，K 键可结束本轮
 */
export type PersonRoadSkipHintPhase = 'hidden' | 'confirming' | 'ready'

interface PersonRoadSkipHintContract {
  state: { readonly phase: PersonRoadSkipHintPhase };
  methods: Record<string, never>;
}

export const personRoadSkipHintView = definePluginView<PersonRoadSkipHintContract>('person-road-skip-hint')

export type PersonRoadSkipHintClient = PluginViewClient<PersonRoadSkipHintContract>
