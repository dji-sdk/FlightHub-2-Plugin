// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk/view'
import type { PluginViewClient } from 'fh2-plugin-sdk/view'

/**
 * 违停巡逻确认弹窗 View 契约（platform:dialog 承载）。
 * 两种形态共用：结束任务确认（warning）与复检完成返航（success + 倒计时）。
 */
export interface PatrolDialogState {
  readonly kind: 'end-task' | 'return-home';
  readonly iconType: 'warning' | 'success';
  readonly title: string;
  readonly description: string;
  readonly cancelText: string;
  readonly confirmText: string;
  /** 返航倒计时剩余秒数；0 表示无倒计时 */
  readonly countdown: number;
  /** 命令执行中禁用按钮 */
  readonly confirmPending: boolean;
  readonly cancelDisabled: boolean;
  readonly confirmDisabled: boolean;
}

interface PatrolDialogContract {
  readonly state: PatrolDialogState;
  readonly methods: {
    cancel (): void;
    confirm (): void;
  };
}

export const patrolDialogView = definePluginView<PatrolDialogContract>('patrol-dialog')

export type PatrolDialogClient = PluginViewClient<PatrolDialogContract>
