// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PatrolTarget, PatrolTargetStats } from '../api/types'

/**
 * 抓拍记录面板纯逻辑：数据源为巡逻状态快照的 targets[]（新版契约，
 * 不再有 session 列表与 tracking 关联）。
 *
 * 时间格式化不引 dayjs：此处只需要固定格式，用纯函数实现并完整单测。
 */

export type BadgeType = 'red' | 'orange' | 'blue' | 'green' | 'gray' | 'none'

/** 可直接下发给记录 View 的车辆条目。 */
export interface PatrolRecordItem {
  readonly id: string;
  readonly thumbUrl: string;
  readonly displayName: string;
  readonly displayTime: string;
  readonly badgeText: string;
  readonly badgeType: BadgeType;
  readonly targetId: string;
}

/** 记录侧边栏中的当前巡逻任务分组。 */
export interface PatrolRecordGroup {
  readonly id: string;
  readonly routeName: string;
  readonly timeText: string;
  readonly isActive: boolean;
  readonly statText: string;
  readonly items: readonly PatrolRecordItem[];
}

// ── 时间格式化 ──────────────────────────────────────────────────────────

function pad2 (n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** YYYY-MM-DD HH:mm */
export function formatMinute (ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** HH:mm:ss */
export function formatClockTime (ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

// ── Badge 映射（六态与现网一字不差） ────────────────────────────────────

/** 复检状态标签（targets[].status） */
export function mapTargetBadge (status?: string): { text: string; type: BadgeType } | null {
  if (!status) return null
  switch (status) {
    case 'pending': return { text: '待复检', type: 'orange' }
    case 'in_progress': return { text: '复检中', type: 'blue' }
    case 'photo_pending': return { text: '复检照片回传中', type: 'red' }
    case 'completed': return { text: '取证完整', type: 'green' }
    case 'failed': return { text: '复检失败', type: 'gray' }
    case 'skipped_no_car': return { text: '目标消失', type: 'gray' }
    default: return null
  }
}

// ── View 数据构建 ────────────────────────────────────────────────────────

/** 从巡逻目标构建记录条目（缩略图为初检最佳帧签名 URL）。 */
export function toPatrolRecordItem (target: PatrolTarget): PatrolRecordItem {
  const badge = mapTargetBadge(target.status)
  return {
    id: target.target_id,
    thumbUrl: target.best_frame_thumb_url,
    displayName: target.display_name || '待识别车牌',
    displayTime: target.photo_taken_at_ms > 0 ? formatClockTime(target.photo_taken_at_ms) : '',
    badgeText: badge?.text ?? '',
    badgeType: badge?.type ?? 'none',
    targetId: target.target_id,
  }
}

/** 复检统计：completed + failed + skipped（含失败与消失，口径与现网一致）。 */
export function recheckDoneCount (stats: PatrolTargetStats): number {
  return stats.completed + stats.failed + stats.skipped
}

/**
 * 构建当前任务的记录分组（产品口径：侧边栏只展示当前在飞任务，
 * 任务结束后数据保留至下一轮）。尚无目标时返回 null（空态）。
 */
export function buildPatrolRecordGroup (input: {
  readonly taskUuid: string;
  readonly targets: readonly PatrolTarget[];
  readonly targetStats: PatrolTargetStats;
  readonly routeName: string;
  readonly startedAtMs: number;
  readonly isActive: boolean;
}): PatrolRecordGroup | null {
  if (input.targets.length === 0) return null
  return {
    id: input.taskUuid,
    routeName: input.routeName.trim() ? input.routeName : '--',
    timeText: input.startedAtMs > 0 ? formatMinute(input.startedAtMs) : '--',
    isActive: input.isActive,
    statText: `${recheckDoneCount(input.targetStats)}/${input.targetStats.total}`,
    items: input.targets.map(toPatrolRecordItem),
  }
}
