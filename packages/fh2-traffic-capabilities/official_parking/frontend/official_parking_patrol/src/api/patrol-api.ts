// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { ApiCallOptions, JsonValue } from 'fh2-plugin-sdk'
import type { PatrolWsMessage } from '../workflow/patrol-session'
import { unwrapApiData } from './api-response'
import type {
  ActivePatrolTask,
  FlightTaskDetail,
  PatrolAbortResponse,
  PatrolActionResponse,
  PatrolTarget,
  PatrolTargetMedia,
  PatrolTargetStats,
  PatrolTaskSnapshot,
  WaylineInfo,
} from './types'

/**
 * Patrol 数据源接口：Mock 后端与真实 REST 适配器实现同一接口，
 * `enableMock` 关闭后零改动切换。
 *
 * 新版契约：Engine 六接口（task/current/media/return-now/cancel-return/abort）
 * + 平台任务服务 v1 单任务详情（biz_ext 判别）+ wayline 服务（路段名）。主键 task_uuid。
 * 已知 task_uuid 时先用 biz_ext 判别；页面刷新、其他操作员和定时巡逻等无
 * task_uuid 场景用 current 发现，拿到 task_uuid 后切换到 task 接口。
 */
export interface PatrolApi {
  getTask (taskUuid: string): Promise<PatrolTaskSnapshot>;
  getCurrent (dockSn: string): Promise<PatrolTaskSnapshot | null>;
  getTargetMedia (targetId: string): Promise<PatrolTargetMedia>;
  returnNow (taskUuid: string): Promise<PatrolActionResponse>;
  cancelReturn (taskUuid: string): Promise<PatrolActionResponse>;
  abort (taskUuid: string): Promise<PatrolAbortResponse>;
  getFlightTaskDetail (projectId: string, taskUuid: string): Promise<FlightTaskDetail | null>;
  getWaylineInfo (projectId: string, waylineUuid: string): Promise<WaylineInfo>;
}

export type ApiCallFn = (endpoint: string, options?: ApiCallOptions) => Promise<JsonValue>

const PATROL_BASE = '/plugin-scene/api/v1/patrol'
const QUERY_TIMEOUT_MS = 10_000

// ── 运行时防御解析（DTO 为 TS 强转，快照字段逐项校验） ──────────────────

function asRecord (value: unknown): Readonly<Record<string, JsonValue>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : null
}

function text (value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function finiteNumber (value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringArray (value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** WS progress 消息的 target_stats 解析（导出供 WS 分发复用）。 */
export function parseWsStats (value: unknown): PatrolTargetStats {
  return parseStats(value)
}

function parseStats (value: unknown): PatrolTargetStats {
  const record = asRecord(value)
  const stats = { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, skipped: 0 }
  if (!record) return stats
  for (const key of Object.keys(stats) as (keyof PatrolTargetStats)[]) {
    stats[key] = finiteNumber(record[key]) ?? 0
  }
  return stats
}

/** WS target_updated / 快照共用的单目标解析（导出供 WS 分发复用）。 */
export function parseTarget (value: unknown): PatrolTarget | null {
  const record = asRecord(value)
  if (!record) return null
  const targetId = text(record.target_id)
  if (!targetId) return null
  return {
    target_id: targetId,
    status: text(record.status) || 'pending',
    display_name: text(record.display_name),
    vehicle_class: text(record.vehicle_class),
    lat: finiteNumber(record.lat) ?? Number.NaN,
    lng: finiteNumber(record.lng) ?? Number.NaN,
    best_frame_thumb_url: text(record.best_frame_thumb_url),
    photo_taken_at_ms: finiteNumber(record.photo_taken_at_ms) ?? 0,
    fail_reason: text(record.fail_reason),
  }
}

/**
 * 真实 WS（biz_code=patrol_progress）消息解析：snake_case → PatrolWsMessage。
 * 未知 sub_biz_code 返回 null（忽略）；消息头字段（dock_sn/task_uuid 等）与现网逐字相同。
 */
export function parsePatrolWsEvent (subBizCode: string | null, data: unknown): PatrolWsMessage | null {
  const raw = asRecord(data)
  if (!raw) return null
  const meta = {
    dockSn: typeof raw.dock_sn === 'string' ? raw.dock_sn : undefined,
    taskUuid: typeof raw.task_uuid === 'string' ? raw.task_uuid : undefined,
    sessionId: raw.session_id !== undefined && raw.session_id !== null ? String(raw.session_id) : undefined,
    stateRevision: typeof raw.state_revision === 'number' ? raw.state_revision : undefined,
  }
  switch (subBizCode) {
    case 'progress':
      return {
        kind: 'progress',
        ...meta,
        phase: typeof raw.phase === 'string' ? raw.phase : undefined,
        completionReason: typeof raw.completion_reason === 'string' ? raw.completion_reason : undefined,
        targetStats: parseWsStats(raw.target_stats),
      }
    case 'target_updated': {
      const target = parseTarget(raw.target)
      return target ? { kind: 'target_updated', ...meta, target } : null
    }
    case 'return_pending':
      return {
        kind: 'return_pending',
        ...meta,
        dueAtMs: typeof raw.due_at_ms === 'number' ? raw.due_at_ms : 0,
      }
    case 'return_state':
      return {
        kind: 'return_state',
        ...meta,
        returnHomeState: typeof raw.return_home_state === 'string' ? raw.return_home_state : 'none',
      }
    default:
      return null
  }
}

function parseTargets (value: unknown): readonly PatrolTarget[] {
  if (!Array.isArray(value)) return []
  return value.map(parseTarget).filter((item): item is PatrolTarget => item !== null)
}

/** §2/§3 响应解析：active 收窄读全量字段，其余 link_state 只保留三个基础字段。 */
export function parsePatrolTaskSnapshot (raw: unknown): PatrolTaskSnapshot | null {
  const record = asRecord(raw)
  if (!record) return null
  const taskUuid = text(record.task_uuid)
  const linkState = text(record.link_state)
  const base = { task_uuid: taskUuid, reject_reason: text(record.reject_reason) }
  if (linkState !== 'active') {
    const normalized = linkState === 'waiting' || linkState === 'rejected' || linkState === 'not_patrol'
      ? linkState
      : 'not_patrol'
    return { link_state: normalized, ...base }
  }
  const active: ActivePatrolTask = {
    link_state: 'active',
    ...base,
    session_id: typeof record.session_id === 'number' ? String(record.session_id) : text(record.session_id),
    wayline_uuid: text(record.wayline_uuid),
    phase: text(record.phase) || 'pending',
    completion_reason: text(record.completion_reason),
    state_revision: finiteNumber(record.state_revision) ?? 0,
    allowed_actions: stringArray(record.allowed_actions),
    abort_pending: record.abort_pending === true,
    return_home_state: text(record.return_home_state) || 'none',
    return_home_due_at_ms: finiteNumber(record.return_home_due_at_ms) ?? 0,
    target_stats: parseStats(record.target_stats),
    targets: parseTargets(record.targets),
  }
  return active
}

function parseActionResponse (raw: unknown): PatrolActionResponse {
  const record = asRecord(raw)
  return { return_home_state: record ? text(record.return_home_state) || 'none' : 'none' }
}

function parseAbortResponse (raw: unknown): PatrolAbortResponse {
  const record = asRecord(raw) ?? {}
  const effective = record.effective === 'pending' ? 'pending' : 'immediate'
  return { effective, return_home_state: text(record.return_home_state) || 'none' }
}

function parseTargetMedia (raw: unknown): PatrolTargetMedia {
  const record = asRecord(raw) ?? {}
  const initialRecord = asRecord(record.initial)
  const initial = initialRecord
    ? {
        url: text(initialRecord.url),
        captured_at_ms: finiteNumber(initialRecord.captured_at_ms) ?? 0,
        lat: finiteNumber(initialRecord.lat) ?? Number.NaN,
        lng: finiteNumber(initialRecord.lng) ?? Number.NaN,
      }
    : null
  const recheck = Array.isArray(record.recheck)
    ? record.recheck.map((item) => {
        const entry = asRecord(item) ?? {}
        return {
          url: text(entry.url),
          original_url: text(entry.original_url),
          media_type: finiteNumber(entry.media_type) ?? 0,
          file_name: text(entry.file_name),
          captured_at_ms: finiteNumber(entry.captured_at_ms) ?? 0,
        }
      })
    : []
  return {
    target_id: text(record.target_id),
    status: text(record.status),
    url_expires_at_ms: finiteNumber(record.url_expires_at_ms) ?? 0,
    initial,
    recheck,
  }
}

/** 平台任务服务 v1 单任务详情解析：巡逻判别只读 biz_ext 顶层 key；begin_at 为 ISO 8601 字符串。 */
function parseFlightTaskDetail (raw: unknown): FlightTaskDetail | null {
  const record = asRecord(raw)
  if (!record) return null
  const uuid = text(record.uuid)
  if (!uuid) return null
  const bizExt = asRecord(record.biz_ext)
  const beginAtMs = Date.parse(text(record.begin_at))
  return { uuid, biz_ext: bizExt ?? null, begin_at_ms: Number.isFinite(beginAtMs) ? beginAtMs : 0 }
}

// ── 真实 REST 适配器（插件网关代理 Engine/平台任务服务/wayline） ──────────────

export function createHttpPatrolApi (apiCall: ApiCallFn): PatrolApi {
  async function get<T> (endpoint: string): Promise<T> {
    return unwrapApiData(await apiCall(endpoint, { method: 'GET', timeoutMs: QUERY_TIMEOUT_MS })) as T
  }

  async function post<T> (endpoint: string): Promise<T> {
    return unwrapApiData(await apiCall(endpoint, { method: 'POST' })) as T
  }

  return {
    async getTask (taskUuid) {
      return parsePatrolTaskSnapshot(await get(`${PATROL_BASE}/tasks/${taskUuid}`))!
    },
    async getCurrent (dockSn) {
      const data = await get(`${PATROL_BASE}/current?dock_sn=${encodeURIComponent(dockSn)}`)
      // data=null 是正常响应（当前机场没在巡逻），不按错误处理
      return data === null ? null : parsePatrolTaskSnapshot(data)
    },
    async getTargetMedia (targetId) {
      return parseTargetMedia(await get(`${PATROL_BASE}/targets/${encodeURIComponent(targetId)}/media`))
    },
    async returnNow (taskUuid) {
      return parseActionResponse(await post(`${PATROL_BASE}/tasks/${taskUuid}/return-now`))
    },
    async cancelReturn (taskUuid) {
      return parseActionResponse(await post(`${PATROL_BASE}/tasks/${taskUuid}/cancel-return`))
    },
    async abort (taskUuid) {
      return parseAbortResponse(await post(`${PATROL_BASE}/tasks/${taskUuid}/abort`))
    },
    async getFlightTaskDetail (projectId, taskUuid) {
      const data = await get(
        `/task/api/v1/workspaces/${encodeURIComponent(projectId)}`
        + `/flight-tasks/${encodeURIComponent(taskUuid)}`,
      )
      return parseFlightTaskDetail(data)
    },
    async getWaylineInfo (projectId, waylineUuid) {
      return fetchWaylineInfo(apiCall, projectId, waylineUuid)
    },
  }
}

/**
 * web-waylines 航线信息：有 parent 时查原始航线名，否则去掉 "-副本(N)" 后缀。
 * 移植自原生 getWaylineInfoByUuid。
 */
async function fetchWaylineInfo (apiCall: ApiCallFn, projectId: string, waylineUuid: string): Promise<WaylineInfo> {
  const fetchItem = async (uuid: string) => {
    const data = unwrapApiData(await apiCall(
      `/wayline/api/v1/workspaces/${encodeURIComponent(projectId)}/waylines/${encodeURIComponent(uuid)}`,
      { method: 'GET', timeoutMs: QUERY_TIMEOUT_MS },
    )) as { name?: string; ext?: { wayline_point_nums?: number }; parent_uuid?: string; parent_id?: string } | null
    return data ?? null
  }
  const item = await fetchItem(waylineUuid)
  if (!item?.name) return { name: '', waypointCount: 0 }
  const waypointCount = item.ext?.wayline_point_nums || 0
  const parentUuid = item.parent_uuid || item.parent_id
  if (parentUuid) {
    try {
      const parent = await fetchItem(parentUuid)
      if (parent?.name) return { name: parent.name, waypointCount }
    } catch { /* fallback 到去后缀名 */ }
  }
  return { name: item.name.replace(/-副本\(\d+\)$/, ''), waypointCount }
}
