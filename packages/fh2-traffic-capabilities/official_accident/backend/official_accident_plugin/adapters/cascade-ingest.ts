// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { AdapterCtx } from 'fh2-plugin-sdk/backend'

interface CascadeIngestInput {
  readonly windowTo: string
  readonly intervalSec: number
}

interface CascadeIngestResult {
  readonly fetched: number
  readonly inserted: number
  readonly windowFrom: string
  readonly windowTo: string
}

interface CascadeConfig extends Record<string, unknown> {
  readonly baseUrl?: unknown
  readonly loginName?: unknown
  readonly password?: unknown
  readonly source?: unknown
  readonly tenantId?: unknown
}

interface CascadeResponse {
  readonly code?: unknown
  readonly data?: unknown
}

interface CascadeRow extends Record<string, unknown> {
  readonly jqbh?: unknown
  readonly lat?: unknown
  readonly lng?: unknown
  readonly bjsj?: unknown
  readonly jjsj?: unknown
  readonly createTime?: unknown
  readonly alarmTime?: unknown
}

const UPSTREAM_TZ_OFFSET_MIN = 480
const LOOKBACK_MIN = 5
const MAX_INSERT_PER_ROUND = 24
const EVENT_TYPE = '警情'
const EVENT_SOURCE = 'cascade'
const EVENT_PRIORITY = 'high'
const INITIAL_STATUS = 'unacknowledged'

/**
 * Worker sample official_classify_accident 的级联采集 Adapter。
 *
 * `windowTo` 显式接 run.now，作为普通业务入参穿过既有 Worker 校验与投影；
 * 不依赖 ctx.now，也不使用本机时间兜底。连接配置从 platform.getConfig() 读取。
 */
export function handle (input: CascadeIngestInput, _ctx: AdapterCtx): CascadeIngestResult {
  const config = platform.getConfig() as CascadeConfig
  requireConfig(config)
  requireWindow(input.intervalSec)

  const to = input.windowTo
  const from = shift(to, -LOOKBACK_MIN * 60)
  const token = login(config)
  const rows = pull(config, from, to, token)
  const events = toEvents(rows, to, config)

  return {
    fetched: rows.length,
    inserted: insertEvents(events),
    windowFrom: from,
    windowTo: to,
  }
}

function requireConfig (config: CascadeConfig): void {
  if (!config.baseUrl) {
    throw new Error('config 缺 baseUrl(级联的接入地址)')
  }
  for (const key of ['loginName', 'password', 'source'] as const) {
    if (!config[key]) {
      throw new Error(`config 缺 ${key}(三步 SSO 登不进去)`)
    }
  }
}

function requireWindow (intervalSec: number): void {
  if (intervalSec > 0 && intervalSec >= LOOKBACK_MIN * 60) {
    throw new Error(`intervalSec=${intervalSec} 不小于回溯窗口 ${LOOKBACK_MIN * 60}s:两轮之间会漏数据,改小 triggers 里的间隔或加大 LOOKBACK_MIN`)
  }
}

function login (config: CascadeConfig): string {
  const r1 = callJSON({
    method: 'POST',
    url: String(config.baseUrl) + '/api/sso/login',
    body: {
      loginName: config.loginName,
      password: config.password,
      source: config.source,
    },
  }, 'sso/login')
  const ssoToken = String(r1.data || '')
  if (!ssoToken) throw new Error('sso/login 未返回 token')

  const r2 = callJSON({
    method: 'GET',
    url: String(config.baseUrl) + '/api/sso/redirectUrl',
    headers: { 'Video-Sso-Token': ssoToken },
  }, 'sso/redirectUrl')
  const redirectUrl = String(r2.data || '')
  if (!redirectUrl) throw new Error('sso/redirectUrl 未返回地址')

  const r3 = callJSON({
    method: 'GET',
    url: redirectUrl,
    headers: { 'Video-Sso-Token': ssoToken },
  }, 'sso/redirect')
  const videoToken = String(r3.data || '')
  if (!videoToken) throw new Error('sso/redirect 未返回 videoToken')
  return videoToken
}

function pull (config: CascadeConfig, from: string, to: string, token: string): CascadeRow[] {
  const response = callJSON({
    method: 'POST',
    url: String(config.baseUrl) + '/api/v-case-jj/platform/pull/jq',
    headers: { 'video-token': token },
    body: { startTime: fmtUpstream(from), endTime: fmtUpstream(to) },
  }, 'pull/jq')
  return Array.isArray(response.data) ? response.data as CascadeRow[] : []
}

function insertEvents (events: readonly Record<string, unknown>[]): number {
  const count = Math.min(events.length, MAX_INSERT_PER_ROUND)
  let inserted = 0
  for (let index = 0; index < count; index++) {
    if (platform.insertEvent(events[index]!)) inserted++
  }
  return inserted
}

function callJSON (
  request: {
    readonly method: string
    readonly url: string
    readonly headers?: Record<string, string>
    readonly body?: Record<string, unknown>
  },
  what: string,
): CascadeResponse {
  const response = connector.fetch(request)
  let body: CascadeResponse
  try {
    body = (JSON.parse(response.body) || {}) as CascadeResponse
  } catch {
    throw new Error(`${what} 响应不是 JSON: status=${response.status}`)
  }
  if (response.status < 200 || response.status > 299) {
    throw new Error(`${what} 失败: status=${response.status}`)
  }
  if (String(body.code) !== '1') {
    throw new Error(`${what} 业务失败: code=${body.code}`)
  }
  return body
}

function toEvents (rows: readonly CascadeRow[], now: string, config: CascadeConfig): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  for (const row of rows) {
    if (!row || !row.jqbh) continue
    const event: Record<string, unknown> = {
      eventId: String(row.jqbh),
      eventType: EVENT_TYPE,
      source: EVENT_SOURCE,
      priority: EVENT_PRIORITY,
      poi: { lat: coord(row.lat), lng: coord(row.lng) },
      occurredAt: occurredAt(row, now),
      status: INITIAL_STATUS,
      notifyOn: [INITIAL_STATUS],
      rawPayload: row,
    }
    if (config.tenantId) event.tenantId = String(config.tenantId)
    events.push(event)
  }
  return events
}

function occurredAt (row: CascadeRow, now: string): string {
  for (const key of ['bjsj', 'jjsj', 'createTime', 'alarmTime'] as const) {
    const iso = fromUpstream(row[key])
    if (iso) return iso
  }
  return now
}

function fmtUpstream (rfc3339: string): string {
  const milliseconds = Date.parse(rfc3339)
  if (!isFinite(milliseconds)) throw new Error(`无法解析时刻: ${rfc3339}`)
  const date = new Date(milliseconds + UPSTREAM_TZ_OFFSET_MIN * 60000)
  return date.getUTCFullYear()
    + '-' + pad2(date.getUTCMonth() + 1)
    + '-' + pad2(date.getUTCDate())
    + ' ' + pad2(date.getUTCHours())
    + ':' + pad2(date.getUTCMinutes())
    + ':' + pad2(date.getUTCSeconds())
}

function fromUpstream (value: unknown): string {
  if (!value) return ''
  const text = String(value).trim().replace(' ', 'T')
  const milliseconds = Date.parse(text + tzSuffix())
  return isFinite(milliseconds) ? new Date(milliseconds).toISOString() : ''
}

function tzSuffix (): string {
  let minutes = UPSTREAM_TZ_OFFSET_MIN
  const sign = minutes < 0 ? '-' : '+'
  if (minutes < 0) minutes = -minutes
  return sign + pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60)
}

function pad2 (value: number): string {
  return value < 10 ? '0' + value : String(value)
}

function shift (rfc3339: string, seconds: number): string {
  const milliseconds = Date.parse(rfc3339)
  if (!isFinite(milliseconds)) throw new Error(`无法解析时刻: ${rfc3339}`)
  return new Date(milliseconds + seconds * 1000).toISOString()
}

function coord (value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  let candidate: unknown = value
  if (typeof candidate === 'object') candidate = (candidate as Record<string, unknown>).value
  const number = parseFloat(String(candidate))
  return isFinite(number) ? number : 0
}
