// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PatrolApi } from '../api/patrol-api'
import type {
  ActivePatrolTask,
  PatrolAbortResponse,
  PatrolActionResponse,
  PatrolTarget,
  PatrolTargetMedia,
  PatrolTargetStats,
  PatrolTaskSnapshot,
} from '../api/types'
import type { PatrolPhase } from '../workflow/phase-machine'
import type { PatrolWsMessage } from '../workflow/patrol-session'
import { createEvidenceImageUrl } from './evidence-images'

/**
 * 违停巡逻内存 Mock 后端：实现与真实 REST 相同的新版 PatrolApi 接口，
 * 并通过事件总线模拟任务到达、patrol_progress 四类 WS 与前端自取的航点进度。
 *
 * 动作接口（return-now/cancel-return/abort）的生效采用「下一次 getTask 收敛」
 * 模式，模拟真实服务端的异步生效；仅在 `enableMock=true` 时装配。
 */

export interface MockFlightTaskProgressEvent {
  readonly taskUuid: string;
  readonly done: number;
  readonly total: number;
}

export interface MockPatrolEvents {
  onTaskArrived (handler: (taskUuid: string, startedAtMs: number) => void): () => void;
  onWsMessage (handler: (message: PatrolWsMessage) => void): () => void;
  onFlightTaskProgress (handler: (event: MockFlightTaskProgressEvent) => void): () => void;
}

interface MockRecheckMedia {
  readonly url: string;
  readonly original_url: string;
  readonly media_type: number;
  readonly file_name: string;
  readonly captured_at_ms: number;
}

interface MockTargetRecord {
  target: PatrolTarget;
  recheck: MockRecheckMedia[];
}

interface MockTaskRecord {
  taskUuid: string;
  routeName: string;
  waylineUuid: string;
  linkState: 'waiting' | 'active';
  phase: PatrolPhase;
  completionReason: string;
  stateRevision: number;
  sessionId: string;
  returnHomeState: string;
  returnHomeDueAtMs: number;
  startedAtMs: number;
  /** 动作已收下、等 getTask 收敛（模拟服务端异步生效） */
  pendingReturnNow: boolean;
  pendingAbort: boolean;
  /** abort 第一次 getTask 仍返回 abort_pending，第二次收敛 */
  abortArmed: boolean;
  targets: MockTargetRecord[];
}

export interface MockPatrolBackend extends PatrolApi {
  readonly events: MockPatrolEvents;
}

/** 剧本内部驱动的后端：PatrolApi + 事件 + 状态迁移入口。 */
export interface MockPatrolBackendDriver extends MockPatrolBackend {
  beginTask (routeName: string): { taskUuid: string; waylineUuid: string; dockSn: string };
  /** waiting → active（巡逻流程拉起） */
  activateTask (): void;
  setPhase (phase: PatrolPhase, extra?: { completionReason?: string }): void;
  admitTarget (input: { plate: string; bodyColor: string; lng: number; lat: number }): string;
  setTargetStatus (targetId: string, status: string): void;
  attachRecheckPhoto (targetId: string): void;
  /** 返航窗口开启（allowed_actions 增加返航两项） */
  openReturnWindow (dueAtMs: number): void;
  /** 模拟后端返航计时器到点：窗口关闭 + 自动返航（终态前的 sent） */
  autoReturnOnTimeout (): void;
  emitFlightTaskProgress (done: number, total: number): void;
  isTaskRunning (): boolean;
  activeTaskUuid (): string;
}

const DOCK_SN = 'MOCK-GATEWAY-001'
const WAYPOINT_COUNT = 26

export function createMockPatrolBackend (now: () => number = Date.now): MockPatrolBackendDriver {
  const taskArrivedHandlers = new Set<(taskUuid: string, startedAtMs: number) => void>()
  const wsHandlers = new Set<(message: PatrolWsMessage) => void>()
  const flightProgressHandlers = new Set<(event: MockFlightTaskProgressEvent) => void>()

  let taskSeq = 0
  let targetSeq = 900

  const tasks: MockTaskRecord[] = []
  let current: MockTaskRecord | null = null

  function emitTaskArrived (taskUuid: string, startedAtMs: number): void {
    for (const handler of [...taskArrivedHandlers]) handler(taskUuid, startedAtMs)
  }

  function emitWs (message: PatrolWsMessage): void {
    for (const handler of [...wsHandlers]) handler(message)
  }

  function emitFlightTaskProgress (done: number, total: number): void {
    if (!current) return
    for (const handler of [...flightProgressHandlers]) {
      handler({ taskUuid: current.taskUuid, done, total })
    }
  }

  function bump (record: MockTaskRecord): number {
    record.stateRevision += 1
    return record.stateRevision
  }

  /** 折叠规则与现网一致：photo_pending 并入 completed（拍完即算处理完成）。 */
  function statsOf (record: MockTaskRecord): PatrolTargetStats {
    const stats = { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, skipped: 0 }
    for (const { target } of record.targets) {
      stats.total++
      if (target.status === 'pending') stats.pending++
      else if (target.status === 'in_progress') stats.processing++
      else if (target.status === 'photo_pending' || target.status === 'completed') stats.completed++
      else if (target.status === 'failed') stats.failed++
      else if (target.status === 'skipped_no_car') stats.skipped++
    }
    return stats
  }

  function allowedActionsOf (record: MockTaskRecord): readonly string[] {
    if (record.linkState !== 'active') return []
    if (record.pendingAbort || record.pendingReturnNow) return []
    const running = record.phase === 'phase1' || record.phase === 'phase1_done' || record.phase === 'phase2'
    if (!running) return []
    if (record.returnHomeDueAtMs > 0) return ['return_now', 'cancel_return', 'abort']
    return ['abort']
  }

  function meta (record: MockTaskRecord) {
    return {
      dockSn: DOCK_SN,
      taskUuid: record.taskUuid,
      sessionId: record.sessionId,
      stateRevision: record.stateRevision,
    }
  }

  /** 动作收敛：pendingReturnNow/pendingAbort 在下一次 getTask 生效。 */
  function resolvePending (record: MockTaskRecord): void {
    if (record.pendingAbort) {
      if (!record.abortArmed) {
        // 第一次 getTask：仍返回 abort_pending（按钮"正在终止…"可观察）
        record.abortArmed = true
        return
      }
      record.pendingAbort = false
      record.phase = 'completed'
      record.completionReason = 'user_abort'
      record.returnHomeState = 'sent'
      record.returnHomeDueAtMs = 0
      bump(record)
    } else if (record.pendingReturnNow) {
      record.pendingReturnNow = false
      record.phase = 'completed'
      record.returnHomeState = 'sent'
      record.returnHomeDueAtMs = 0
      bump(record)
    }
  }

  function toSnapshot (record: MockTaskRecord): PatrolTaskSnapshot {
    if (record.linkState !== 'active') {
      return { link_state: record.linkState, task_uuid: record.taskUuid, reject_reason: '' }
    }
    const active: ActivePatrolTask = {
      link_state: 'active',
      task_uuid: record.taskUuid,
      reject_reason: '',
      session_id: record.sessionId,
      wayline_uuid: record.waylineUuid,
      phase: record.phase,
      completion_reason: record.completionReason,
      state_revision: record.stateRevision,
      allowed_actions: allowedActionsOf(record),
      abort_pending: record.pendingAbort,
      return_home_state: record.returnHomeState,
      return_home_due_at_ms: record.returnHomeDueAtMs,
      target_stats: statsOf(record),
      targets: record.targets.map(entry => entry.target),
    }
    return active
  }

  function findTarget (targetId: string): MockTargetRecord | null {
    for (const record of tasks) {
      const entry = record.targets.find(item => item.target.target_id === targetId)
      if (entry) return entry
    }
    return null
  }

  const api: PatrolApi = {
    async getTask (taskUuid) {
      const record = tasks.find(item => item.taskUuid === taskUuid)
      if (!record) {
        // engine 尚未收到计划库下发通知：按 waiting 处理，前端继续轮询
        return { link_state: 'waiting', task_uuid: taskUuid, reject_reason: '' }
      }
      resolvePending(record)
      return toSnapshot(record)
    },
    async getCurrent (dockSn) {
      if (dockSn !== DOCK_SN) return null
      const running = [...tasks].reverse().find(item => item.linkState === 'active'
        && item.phase !== 'completed' && item.phase !== 'failed' && item.phase !== 'skipped' && item.phase !== 'manual_control')
      return running ? toSnapshot(running) : null
    },
    async getTargetMedia (targetId) {
      const entry = findTarget(targetId)
      const target = entry?.target
      const media: PatrolTargetMedia = {
        target_id: targetId,
        status: target?.status ?? '',
        url_expires_at_ms: now() + 60 * 60 * 1000,
        initial: target && Number.isFinite(target.lat)
          ? { url: target.best_frame_thumb_url, captured_at_ms: target.photo_taken_at_ms, lat: target.lat, lng: target.lng }
          : null,
        recheck: entry?.recheck ?? [],
      }
      return media
    },
    async returnNow (taskUuid) {
      const record = tasks.find(item => item.taskUuid === taskUuid)
      if (!record || record.returnHomeDueAtMs <= 0) {
        throw new Error('当前不在返航窗口（code: 40901）')
      }
      record.returnHomeState = 'pending'
      record.pendingReturnNow = true
      const revision = bump(record)
      emitWs({ kind: 'return_state', ...meta(record), stateRevision: revision, returnHomeState: 'pending' })
      const response: PatrolActionResponse = { return_home_state: 'pending' }
      return response
    },
    async cancelReturn (taskUuid) {
      const record = tasks.find(item => item.taskUuid === taskUuid)
      if (!record || record.returnHomeDueAtMs <= 0) {
        throw new Error('当前不在返航窗口（code: 40901）')
      }
      record.returnHomeState = 'cancelled'
      record.returnHomeDueAtMs = 0
      record.phase = 'manual_control'
      let revision = bump(record)
      emitWs({ kind: 'return_state', ...meta(record), stateRevision: revision, returnHomeState: 'cancelled' })
      revision = bump(record)
      emitWs({
        kind: 'progress',
        ...meta(record),
        stateRevision: revision,
        phase: record.phase,
        completionReason: record.completionReason,
        targetStats: statsOf(record),
      })
      const response: PatrolActionResponse = { return_home_state: 'cancelled' }
      return response
    },
    async abort (taskUuid) {
      const record = tasks.find(item => item.taskUuid === taskUuid)
      if (!record || allowedActionsOf(record).length === 0) {
        throw new Error('巡逻已结束，无法终止（code: 40901）')
      }
      // 复检进行中（有目标在拍）→ 排队生效；否则立即排队，下次 getTask 收敛
      record.pendingAbort = true
      const response: PatrolAbortResponse = { effective: 'pending', return_home_state: 'none' }
      return response
    },
    async getFlightTaskDetail (_projectId, taskUuid) {
      const record = tasks.find(item => item.taskUuid === taskUuid)
      // Mock 任务全部由巡逻剧本创建：biz_ext 恒带 es-patrol；未知任务视为普通飞行
      const base = { uuid: taskUuid, begin_at_ms: record?.startedAtMs ?? 0 }
      return record ? { ...base, biz_ext: { 'es-patrol': {} } } : { ...base, biz_ext: null }
    },
    async getWaylineInfo (_projectId, waylineUuid) {
      const record = tasks.find(item => item.waylineUuid === waylineUuid)
      return { name: record?.routeName ?? '', waypointCount: record ? WAYPOINT_COUNT : 0 }
    },
  }

  const backend: MockPatrolBackendDriver = {
    ...api,
    events: {
      onTaskArrived (handler) {
        taskArrivedHandlers.add(handler)
        return () => taskArrivedHandlers.delete(handler)
      },
      onWsMessage (handler) {
        wsHandlers.add(handler)
        return () => wsHandlers.delete(handler)
      },
      onFlightTaskProgress (handler) {
        flightProgressHandlers.add(handler)
        return () => flightProgressHandlers.delete(handler)
      },
    },

    beginTask (routeName) {
      taskSeq += 1
      const taskUuid = `MOCK-PATROL-TASK-${String(taskSeq).padStart(3, '0')}`
      current = {
        taskUuid,
        routeName,
        waylineUuid: `mock-wayline-patrol-${String(taskSeq).padStart(3, '0')}`,
        linkState: 'waiting',
        phase: 'pending',
        completionReason: '',
        stateRevision: 0,
        sessionId: '',
        returnHomeState: 'none',
        returnHomeDueAtMs: 0,
        startedAtMs: now(),
        pendingReturnNow: false,
        pendingAbort: false,
        abortArmed: false,
        targets: [],
      }
      tasks.push(current)
      // 计划库下发 → 通知到达（前端据此识别任务）
      emitTaskArrived(taskUuid, current.startedAtMs)
      return { taskUuid, waylineUuid: current.waylineUuid, dockSn: DOCK_SN }
    },

    activateTask () {
      if (!current) throw new Error('Mock 后端没有进行中的巡逻任务')
      current.linkState = 'active'
      current.sessionId = String(4000 + taskSeq)
      current.stateRevision += 1
    },

    setPhase (phase, extra) {
      if (!current) return
      current.phase = phase
      if (extra?.completionReason !== undefined) current.completionReason = extra.completionReason
      const revision = bump(current)
      emitWs({
        kind: 'progress',
        dockSn: DOCK_SN,
        taskUuid: current.taskUuid,
        sessionId: current.sessionId,
        stateRevision: revision,
        phase,
        completionReason: current.completionReason,
        targetStats: statsOf(current),
      })
    },

    admitTarget ({ plate, bodyColor, lng, lat }) {
      if (!current) throw new Error('Mock 后端没有进行中的巡逻任务')
      const targetId = String(++targetSeq)
      const target: PatrolTarget = {
        target_id: targetId,
        status: 'pending',
        display_name: plate,
        vehicle_class: 'car',
        lat,
        lng,
        best_frame_thumb_url: createEvidenceImageUrl({
          plate,
          label: '初检截图',
          index: 0,
          capturedAt: now(),
          bodyColor,
        }),
        photo_taken_at_ms: now(),
        fail_reason: '',
      }
      current.targets.push({ target, recheck: [] })
      emitWs({
        kind: 'target_updated',
        ...meta(current),
        target,
      })
      return targetId
    },

    setTargetStatus (targetId, status) {
      const entry = findTarget(targetId)
      if (!entry) return
      entry.target = { ...entry.target, status }
      const record = tasks.find(item => item.targets.includes(entry))!
      emitWs({
        kind: 'target_updated',
        ...meta(record),
        target: entry.target,
      })
    },

    attachRecheckPhoto (targetId) {
      const entry = findTarget(targetId)
      if (!entry) return
      const plate = entry.target.display_name
      const capturedAt = now()
      const url = createEvidenceImageUrl({
        plate,
        label: '复检照片',
        index: entry.recheck.length + 1,
        capturedAt,
        bodyColor: entry.target.vehicle_class === 'SUV' ? '#a16207' : '#dc2626',
      })
      entry.recheck.push({
        url,
        original_url: url,
        media_type: 1,
        file_name: `mock-${targetId}-${entry.recheck.length + 1}.jpg`,
        captured_at_ms: capturedAt,
      })
    },

    openReturnWindow (dueAtMs) {
      if (!current) return
      current.returnHomeDueAtMs = dueAtMs
      const revision = bump(current)
      emitWs({ kind: 'return_pending', ...meta(current), stateRevision: revision, dueAtMs })
    },

    autoReturnOnTimeout () {
      if (!current || current.returnHomeDueAtMs <= 0) return
      current.returnHomeState = 'sent'
      current.returnHomeDueAtMs = 0
      const revision = bump(current)
      emitWs({ kind: 'return_state', ...meta(current), stateRevision: revision, returnHomeState: 'sent' })
    },

    emitFlightTaskProgress,

    isTaskRunning () {
      return current != null && current.linkState === 'active'
        && current.phase !== 'completed' && current.phase !== 'failed'
        && current.phase !== 'skipped' && current.phase !== 'manual_control'
    },

    activeTaskUuid () {
      return current?.taskUuid ?? ''
    },
  }

  return backend
}
