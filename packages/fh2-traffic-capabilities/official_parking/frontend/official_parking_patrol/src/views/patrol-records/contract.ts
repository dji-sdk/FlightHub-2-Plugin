// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk/view'
import type { PluginViewClient } from 'fh2-plugin-sdk/view'
import type { PatrolRecordGroup } from '../../workflow/records-core'

/** 抓拍记录面板 View 契约。只展示当前任务（无历史架次），无分组折叠。 */
export interface RecordsState {
  /** 当前任务分组；无任务时为 null（显示空态） */
  readonly group: PatrolRecordGroup | null;
  /** 当前选中车辆卡片（与 SubLive 预览联动） */
  readonly activeTargetId: string;
}

interface RecordsContract {
  readonly state: RecordsState;
  readonly methods: {
    /** 点击车辆卡片：再次点击同一卡片关闭预览 */
    selectCard (input: { readonly targetId: string }): void;
  };
}

export const recordsView = definePluginView<RecordsContract>('patrol-records')

export type RecordsClient = PluginViewClient<RecordsContract>
