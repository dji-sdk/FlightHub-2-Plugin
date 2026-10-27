// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * Patrol Engine DTO（snake_case，对齐《前端联调API-违停巡逻》新版契约）。
 *
 * 主键为 task_uuid（计划库返回的任务 UUID）；session_id 仅出现在响应/WS 中供排障
 * 与过滤。时间字段一律 Unix 毫秒（*_ms）。成功判据 code==0；失败响应没有 data 键。
 */

// ── 任务快照（§2 /tasks/{uuid} 与 /current 共用） ────────────────────────

export type PatrolLinkState = 'waiting' | 'active' | 'rejected' | 'not_patrol'

export interface PatrolTargetStats {
  readonly total: number;
  readonly pending: number;
  readonly processing: number;
  readonly completed: number;
  readonly failed: number;
  readonly skipped: number;
}

/** 复检目标（侧边栏抓拍列表）；target_id 全局唯一。 */
export interface PatrolTarget {
  readonly target_id: string;
  /** pending | in_progress | photo_pending | completed | failed | skipped_no_car */
  readonly status: string;
  readonly display_name: string;
  readonly vehicle_class: string;
  readonly lat: number;
  readonly lng: number;
  /** 初检最佳帧缩略图（签名 URL，会过期，禁止持久化） */
  readonly best_frame_thumb_url: string;
  readonly photo_taken_at_ms: number;
  readonly fail_reason: string;
}

/** link_state=active 的完整快照；其余 link_state 只有三个基础字段。 */
export interface ActivePatrolTask {
  readonly link_state: 'active';
  readonly task_uuid: string;
  readonly reject_reason: string;

  readonly session_id: string;
  readonly wayline_uuid: string;
  /** dispatching | pending | phase1 | phase1_done | phase2 | completed | failed | skipped | manual_control */
  readonly phase: string;
  readonly completion_reason: string;
  readonly state_revision: number;

  readonly allowed_actions: readonly string[];
  readonly abort_pending: boolean;
  readonly return_home_state: string;
  readonly return_home_due_at_ms: number;

  readonly target_stats: PatrolTargetStats;
  readonly targets: readonly PatrolTarget[];
}

export type PatrolTaskSnapshot =
  | {
    readonly link_state: 'waiting' | 'rejected' | 'not_patrol';
    readonly task_uuid: string;
    readonly reject_reason: string;
  }
  | ActivePatrolTask

// ── 媒体（§4 /targets/{target_id}/media） ────────────────────────────────

export interface PatrolTargetMedia {
  readonly target_id: string;
  readonly status: string;
  readonly url_expires_at_ms: number;
  /** 初检最佳帧（恒定一张）；未识别完成时可能缺失 */
  readonly initial: {
    readonly url: string;
    readonly captured_at_ms: number;
    readonly lat: number;
    readonly lng: number;
  } | null;
  /** 复检取证照（可能多张；photo_pending 回传中 / skipped_no_car 未拍为空数组） */
  readonly recheck: readonly {
    readonly url: string;
    readonly original_url: string;
    readonly media_type: number;
    readonly file_name: string;
    readonly captured_at_ms: number;
  }[];
}

// ── 动作接口（§5/§6/§7） ────────────────────────────────────────────────

/** 三个动作接口的统一出参；return_home_state 为收下信号那一刻的状态。 */
export interface PatrolActionResponse {
  readonly return_home_state: string;
}

export interface PatrolAbortResponse extends PatrolActionResponse {
  /** immediate=已生效；pending=已收下，等流程走到下一个可中断点 */
  readonly effective: 'immediate' | 'pending';
}

// ── 计划库 / 航线服务（前端自取数据） ───────────────────────────────────

/** 平台任务服务 v1 单任务详情（巡逻判别只看 biz_ext）。 */
export interface FlightTaskDetail {
  readonly uuid: string;
  /** 顶层 key 为业务插件标识（如 es-patrol）；无 = 普通飞行 */
  readonly biz_ext?: Record<string, unknown> | null;
  /** 任务开始时间（begin_at，ISO 8601 字符串解析为毫秒）；0 = 缺失/非法 */
  readonly begin_at_ms: number;
}

/** wayline 服务航线信息（路段名 + 航点数兜底）。 */
export interface WaylineInfo {
  readonly name: string;
  readonly waypointCount: number;
}
