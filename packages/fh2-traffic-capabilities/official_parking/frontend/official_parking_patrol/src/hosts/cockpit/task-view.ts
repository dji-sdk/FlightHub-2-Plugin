// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { RecordsState } from '../../views/patrol-records/contract'
import type { TaskPanelState } from '../../views/patrol-task-panel/contract'
import {
  type PatrolTaskState,
  initialPercent,
  isPatrolActive,
  isPatrolReview,
  isTaskVisible,
  recheckPercent,
  recheckProgress,
} from '../../workflow/patrol-session'
import { buildPatrolRecordGroup } from '../../workflow/records-core'

/**
 * 把巡逻任务状态换算成界面要显示的数据：
 * 任务面板文案与进度、记录列表卡片。
 */

/** rejected 文案：飞机仍会照常飞完航线，不是「任务失败」。 */
const REJECT_REASONS: Readonly<Record<string, string>> = {
  notify_lost: '巡逻未接管，服务异常',
  route_not_patrol: '该航线不支持违停抓拍，飞行任务仍会正常执行',
  dock_mismatch: '机场与航线不匹配',
  previous_run_in_flight: '上一趟巡逻尚未结束',
}

export function rejectText (reason: string): string {
  return REJECT_REASONS[reason] ?? (reason || '巡逻流程未能启动')
}

/** failed 终态原因码 → 中文文案；开放取值兜底「异常结束」。 */
const COMPLETION_REASONS: Readonly<Record<string, string>> = {
  '': '已完成',
  user_abort: '已终止',
  return_home_failed: '返航失败',
  flight_ended: '架次已结束',
  startup_cleanup_stuck: '启动清理未完成',
  all_done: '已完成',
  mode_code_return_home: '飞机已返航',
  timeout_60min: '任务超时',
  aborted: '已中止',
}

export function completionText (reason: string): string {
  return COMPLETION_REASONS[reason] ?? '异常结束'
}

function reviewText (state: PatrolTaskState): string {
  if (state.phase === 'manual_control') return '已转人工控制'
  if (state.phase === 'skipped') return '巡逻未接管'
  if (state.phase === 'failed') return state.completionReason ? `任务失败：${completionText(state.completionReason)}` : '任务失败'
  if (state.completionReason === 'user_abort') return '任务已终止'
  return '任务完成'
}

export function toTaskPanelState (state: PatrolTaskState): TaskPanelState {
  const preparing = state.linkState === 'waiting'
  const rejected = state.linkState === 'rejected'
  const linked = state.linkState === 'active'
  const recheck = recheckProgress(state)
  const active = isPatrolActive(state)
  const review = isPatrolReview(state)
  return {
    phase: linked ? state.phase : null,
    preparing,
    rejected,
    rejectText: rejected ? rejectText(state.rejectReason) : '',
    routeName: state.routeName,
    showProgress: linked && state.phase !== null,
    initialLabel: `初检 — 已执行航点（${state.initialDone}/${state.initialTotal}）`,
    recheckLabel: `复检 — 已处理车辆（${recheck.done}/${recheck.total}）`,
    initialPercent: initialPercent(state),
    recheckPercent: recheckPercent(state),
    initialActive: linked && state.phase === 'phase1',
    recheckActive: linked && state.phase === 'phase2',
    showEndButton: active,
    endButtonDisabled: state.abortPending || !state.allowedActions.includes('abort'),
    endButtonText: state.abortPending ? '正在终止…' : '终止巡逻',
    isReview: review,
    reviewText: review ? reviewText(state) : '',
  }
}

export interface TaskViewUpdaterDeps {
  readonly recordsState: {
    readonly update: (updater: (current: RecordsState) => RecordsState) => void;
  };
  readonly taskOverlay: {
    readonly update: (patch: { visible: boolean }) => Promise<unknown>;
  };
}

export interface TaskViewUpdater {
  /** 任务面板的显示/隐藏（任务结束后保留进度和照片） */
  updateTaskOverlay (state: PatrolTaskState): Promise<void>;
  /** 根据抓拍目标列表生成记录面板的分组卡片 */
  updateRecordsPanel (state: PatrolTaskState): void;
}

export function createTaskViewUpdater (deps: TaskViewUpdaterDeps): TaskViewUpdater {
  return {
    async updateTaskOverlay (state) {
      await deps.taskOverlay.update({ visible: isTaskVisible(state) })
    },
    updateRecordsPanel (state) {
      const group = buildPatrolRecordGroup({
        taskUuid: state.taskUuid,
        targets: state.targets,
        targetStats: state.targetStats,
        routeName: state.routeName,
        startedAtMs: state.startedAtMs,
        isActive: isPatrolActive(state),
      })
      deps.recordsState.update(current => ({ ...current, group }))
    },
  }
}
