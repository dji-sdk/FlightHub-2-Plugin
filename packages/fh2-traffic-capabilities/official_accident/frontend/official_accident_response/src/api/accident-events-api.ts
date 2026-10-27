// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { JsonValue } from 'fh2-plugin-sdk'
import type { AccidentRecord, AllEventItem, AllEventsPage, AllEventsQuery, EventStatus } from '../workflow/types'
import { unwrapApiData } from './api-response'
import type { ApiCall } from './types'

export const ACCIDENT_PAGE_SIZE = 500

/** 活动警情：状态机前三个非终态。 */
const ACTIVE_EVENT_STATUSES: readonly ('unacknowledged' | 'acknowledged' | 'handling')[] = [
  'unacknowledged',
  'acknowledged',
  'handling',
]

export interface AccidentEventsApi {
  listActive(): Promise<readonly AccidentRecord[]>;
  listAll(input: AllEventsQuery): Promise<AllEventsPage>;
  getEvent(pluginEventId: string): Promise<AccidentRecord>;
  updateEventRawPayload(eventId: string, rawPayload: Readonly<Record<string, JsonValue>>): Promise<void>;
}

/**
 * 事故警情查询接口。
 *
 * HTTP 字段和信封解析全部收口在本文件；调用方只接触前端工作流类型。
 */
export function createAccidentEventsApi (apiCall: ApiCall): AccidentEventsApi {
  async function queryEvents (input: {
    readonly page: number;
    readonly pageSize: number;
    readonly status?: readonly EventStatus[];
  }): Promise<JsonValue> {
    return apiCall('/plugin-scene/data-store/events/query', {
      method: 'POST',
      body: {
        source: 'cascade',
        eventType: '警情',
        page: input.page,
        pageSize: input.pageSize,
        ...(input.status === undefined ? {} : { status: input.status }),
      },
    })
  }

  return {
    async listActive () {
      const response = await queryEvents({
        page: 1,
        pageSize: ACCIDENT_PAGE_SIZE,
        status: ACTIVE_EVENT_STATUSES,
      })
      return [...parseAccidentEventResponse(response)]
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, ACCIDENT_PAGE_SIZE)
    },
    async listAll (input) {
      const response = await queryEvents({ page: input.page, pageSize: input.pageSize })
      return parseAllEventsPage(response)
    },
    async getEvent (pluginEventId) {
      const response = await apiCall(`/plugin-scene/data-store/events/${encodeURIComponent(pluginEventId)}`, {
        method: 'GET',
      })
      return parseAccidentEvent(unwrapApiData(response))
    },
    async updateEventRawPayload (eventId, rawPayload) {
      const response = await apiCall('/plugin-scene/data-store/events/update', {
        method: 'POST',
        body: { eventId, rawPayload },
      })
      unwrapApiData(response)
    },
  }
}

export function parseAccidentEventResponse (value: JsonValue): readonly AccidentRecord[] {
  const data = record(unwrapApiData(value))
  return array(data.list).map(parseAccidentEvent)
}

export function parseAccidentEvent (value: JsonValue): AccidentRecord {
  const event = record(value)
  const pluginEventId = string(event.eventId)
  if (!pluginEventId) throw new Error('事件响应缺少 eventId')
  const flightMissionId = string(event.flightMissionId)
  const rawPayload = strictRecord(event.rawPayload, 'rawPayload')
  const rawLat = numeric(rawPayload.lat)
  const rawLng = numeric(rawPayload.lng)
  const hasRawCoordinate = validCoordinate(rawLat, rawLng)
  const latitude = hasRawCoordinate ? rawLat : undefined
  const longitude = hasRawCoordinate ? rawLng : undefined
  const correctionNote = string(rawPayload.correction_note)
  return {
    pluginEventId,
    ...(flightMissionId === '' ? {} : { flightMissionId }),
    title: string(rawPayload.desc) || string(event.eventType) || '事故快处',
    createdAt: timestamp(event.occurredAt),
    status: eventStatus(event.status),
    priority: string(event.priority),
    address: string(rawPayload.address) || string(rawPayload.addr),
    ...(latitude === undefined ? {} : { latitude }),
    ...(longitude === undefined ? {} : { longitude }),
    height: number(rawPayload.height) ?? 0,
    ...(correctionNote === '' ? {} : { correctionNote }),
    rawPayload,
    result: event.result ?? null,
  }
}

function parseAllEventsPage (value: JsonValue): AllEventsPage {
  const data = record(unwrapApiData(value))
  const items: AllEventItem[] = parseAccidentEventResponse(value).map(item => ({
    pluginEventId: item.pluginEventId,
    ...(item.flightMissionId === undefined ? {} : { flightMissionId: item.flightMissionId }),
    status: item.status,
    occurredAt: item.createdAt,
    address: item.address,
    hasCoordinates: item.latitude !== undefined && item.longitude !== undefined,
    ...(item.correctionNote === undefined ? {} : { correctionNote: item.correctionNote }),
    ...(item.latitude === undefined ? {} : { latitude: item.latitude }),
    ...(item.longitude === undefined ? {} : { longitude: item.longitude }),
  }))
  const pagination = record(data.pagination)
  return { items, total: number(pagination.total) ?? items.length }
}

function record (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : {}
}

function strictRecord (value: JsonValue | undefined, field: string): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`事件响应字段无效：${field}`)
  }
  return value as Readonly<Record<string, JsonValue>>
}

function array (value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : []
}

function string (value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function number (value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numeric (value: JsonValue | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function validCoordinate (lat: number | undefined, lng: number | undefined): boolean {
  return lat !== undefined && lng !== undefined && (lat !== 0 || lng !== 0)
}

function timestamp (value: JsonValue | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime()
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

function eventStatus (value: JsonValue | undefined): EventStatus {
  if (value === 'unacknowledged' || value === 'acknowledged' || value === 'handling'
    || value === 'completed' || value === 'ack_timeout' || value === 'ignored' || value === 'terminated') {
    return value
  }
  throw new Error(`事件状态无效：${String(value)}`)
}
