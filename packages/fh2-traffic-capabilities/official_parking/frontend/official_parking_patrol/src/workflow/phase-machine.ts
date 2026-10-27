// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 违停巡逻 phase/revision 纯守卫，对齐《前端联调API-违停巡逻》新版契约。
 *
 * - phase 只进不退：非终态按序号严格递增；四个终态（completed/failed/skipped/
 *   manual_control）等序号且互不覆盖（终态吸收）。
 * - WS 增量：revision <= 已见最大值整条丢弃（防乱序回退）。
 * - HTTP 快照：revision < 已见最大值丢弃；== 允许权威全量覆盖；> 正常更新。
 */

export type PatrolPhase =
  | 'dispatching'
  | 'pending'
  | 'phase1'
  | 'phase1_done'
  | 'phase2'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'manual_control'

const PHASE_ORDER: Record<PatrolPhase, number> = {
  dispatching: 0,
  pending: 1,
  phase1: 2,
  phase1_done: 3,
  phase2: 4,
  completed: 5,
  failed: 5,
  skipped: 5,
  manual_control: 5,
}

export function isTerminalPhase (phase: PatrolPhase): boolean {
  return PHASE_ORDER[phase] >= 5
}

/** phase 单调保护：新 phase 序号严格更高才允许更新；终态等序号不互相覆盖。 */
export function shouldUpdatePhase (oldPhase: PatrolPhase, newPhase: PatrolPhase): boolean {
  return PHASE_ORDER[newPhase] > PHASE_ORDER[oldPhase]
}

export function isPatrolPhase (value: string): value is PatrolPhase {
  return value in PHASE_ORDER
}

/** WS 增量防乱序：revision <= 已见最大值整条丢弃（0/缺失视为旧协议兼容，不丢弃）。 */
export function shouldDropWsRevision (currentRevision: number, incomingRevision: number): boolean {
  if (!Number.isFinite(incomingRevision) || incomingRevision <= 0) return false
  return incomingRevision <= currentRevision
}

/** HTTP 快照防乱序：仅更旧（<）的快照丢弃；同 revision 允许权威覆盖。 */
export function shouldDropSnapshotRevision (currentRevision: number, incomingRevision: number): boolean {
  if (!Number.isFinite(incomingRevision) || incomingRevision <= 0) return false
  return incomingRevision < currentRevision
}
