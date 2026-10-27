// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk/view'
import type { PluginViewClient } from 'fh2-plugin-sdk/view'

/**
 * 变道标注重命名弹窗（platform:dialog 承载）。
 * 标题栏、遮罩、关闭按钮与 ESC 由宿主 Dialog 提供；输入草稿保留在 View 本地。
 */

export interface LaneChangeRenameDialogState {
  /** 打开时的标注名称（View 挂载/状态更新时回填到输入框）。 */
  readonly initialName: string;
}

interface LaneChangeRenameDialogContract {
  readonly state: LaneChangeRenameDialogState;
  readonly methods: {
    /** 提交重命名；空名称由 Entry 忽略并保持弹窗打开。 */
    confirm(input: { readonly name: string }): Promise<void>;
    cancel(): void;
  };
}

export const laneChangeRenameDialogView = definePluginView<LaneChangeRenameDialogContract>('lane-change-rename-dialog')

export type LaneChangeRenameDialogClient = PluginViewClient<LaneChangeRenameDialogContract>
