// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk/view'
import type { PluginViewClient } from 'fh2-plugin-sdk/view'
import type { PatrolPhase } from '../../workflow/phase-machine'

/**
 * 任务面板 View 契约：Entry 预先生成可渲染状态，View 只负责展示。
 * 状态字段全部满足 PluginValue。
 */
export interface TaskPanelState {
  /** active 后的巡逻阶段；waiting/rejected 期间为 null */
  readonly phase: PatrolPhase | null;
  /** link_state=waiting：流程未拉起，显示「正在准备巡逻…」 */
  readonly preparing: boolean;
  /** link_state=rejected：显示拒绝原因（飞行任务仍会正常执行） */
  readonly rejected: boolean;
  readonly rejectText: string;
  /** 巡逻路段（只读展示；空串显示占位） */
  readonly routeName: string;
  readonly showProgress: boolean;
  readonly initialLabel: string;
  readonly recheckLabel: string;
  readonly initialPercent: number;
  readonly recheckPercent: number;
  readonly initialActive: boolean;
  readonly recheckActive: boolean;
  readonly showEndButton: boolean;
  readonly endButtonDisabled: boolean;
  readonly endButtonText: string;
  readonly isReview: boolean;
  /** 回顾态结论文案（已完成/已终止/未接管/已转人工控制/失败） */
  readonly reviewText: string;
}

interface TaskPanelContract {
  readonly state: TaskPanelState;
  readonly methods: {
    /** 终止巡逻（弹确认弹窗） */
    requestEndTask (): void;
    /** 回顾态关闭面板 */
    dismiss (): void;
  };
}

export const taskPanelView = definePluginView<TaskPanelContract>('patrol-task-panel')

export type TaskPanelClient = PluginViewClient<TaskPanelContract>
