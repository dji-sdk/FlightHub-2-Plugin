// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import type { JsonValue } from 'fh2-plugin-sdk'
import { createAccidentEventsApi, parseAccidentEventResponse } from './accident-events-api'

function eventResponse (...events: readonly {
  readonly status: string;
  readonly eventId: string;
  readonly flightMissionId?: string;
}[]): JsonValue {
  return {
    code: 0,
    message: 'OK',
    data: {
      pagination: { page: 1, page_size: 20, total: events.length },
      list: events.map(event => ({
        id: 5,
        eventId: event.eventId,
        ...(event.flightMissionId === undefined ? {} : { flightMissionId: event.flightMissionId }),
        eventType: '测试警情',
        source: 'cascade',
        priority: 'low',
        status: event.status,
        resultCode: 0,
        result: { dispatched: true },
        occurredAt: '2026-08-24 14:16:29',
        createdAt: '2026-08-24 14:16:29',
        rawPayload: {
          id: event.eventId,
          lat: '22.5431',
          lng: 114.0579,
          addr: '深圳市南山区科技园',
        },
      })),
    },
  }
}

describe('accident events api', () => {
  it('一次查询状态机前三个非终态，并返回前端警情类型', async () => {
    const calls: Array<{ endpoint: string; body?: JsonValue }> = []
    const apiCall = async (endpoint: string, options?: { body?: JsonValue }): Promise<JsonValue> => {
      calls.push({ endpoint, ...(options?.body === undefined ? {} : { body: options.body }) })
      return eventResponse(
        { status: 'unacknowledged', eventId: 'TEST-MOCKP-000017' },
        { status: 'acknowledged', eventId: 'TEST-MOCKP-000018' },
      )
    }

    const records = await createAccidentEventsApi(apiCall).listActive()

    expect(calls).toEqual([{
      endpoint: '/plugin-scene/data-store/events/query',
      body: {
        source: 'cascade',
        eventType: '警情',
        page: 1,
        pageSize: 500,
        status: ['unacknowledged', 'acknowledged', 'handling'],
      },
    }])
    expect(records.map(record => record.pluginEventId).sort()).toEqual(['TEST-MOCKP-000017', 'TEST-MOCKP-000018'])
    expect(records[0]).toMatchObject({ address: '深圳市南山区科技园', latitude: 22.5431, longitude: 114.0579 })
  })

  it('业务 code 非 0 时按失败处理', async () => {
    const apiCall = async (): Promise<JsonValue> => ({ code: 1001, message: 'query failed', data: {} })
    await expect(createAccidentEventsApi(apiCall).listAll({ page: 1, pageSize: 20 }))
      .rejects.toThrow('query failed（code: 1001）')
  })

  it('查询全量警情时不发送 status', async () => {
    let body: JsonValue | undefined
    const apiCall = async (_endpoint: string, options?: { body?: JsonValue }): Promise<JsonValue> => {
      body = options?.body
      return eventResponse({ status: 'completed', eventId: 'JQ-3' })
    }
    await createAccidentEventsApi(apiCall).listAll({ page: 2, pageSize: 10 })
    expect(body).toEqual({ source: 'cascade', eventType: '警情', page: 2, pageSize: 10 })
  })

  it('rawPayload 坐标为零时保持未定位', () => {
    const response = eventResponse({ status: 'unacknowledged', eventId: 'JQ-0' }) as Record<string, JsonValue>
    const data = response.data as Record<string, JsonValue>
    const list = data.list as Array<Record<string, JsonValue>>
    list[0] = { ...list[0], rawPayload: { lat: '0', lng: 0 } }

    const records = parseAccidentEventResponse(response)
    expect(records).toMatchObject([{ pluginEventId: 'JQ-0' }])
    expect(records[0]).not.toHaveProperty('latitude')
    expect(records[0]).not.toHaveProperty('longitude')
  })

  it('不读取 poi 字段：poi 有坐标但 rawPayload 无 lat/lng 时仍判定无坐标', () => {
    const response = eventResponse({ status: 'unacknowledged', eventId: 'JQ-POI' }) as Record<string, JsonValue>
    const data = response.data as Record<string, JsonValue>
    const list = data.list as Array<Record<string, JsonValue>>
    list[0] = { ...list[0], poi: { lat: 22.5431, lng: 114.0579 }, rawPayload: { addr: '科技园' } }

    const records = parseAccidentEventResponse(response)
    expect(records[0]).not.toHaveProperty('latitude')
    expect(records[0]).not.toHaveProperty('longitude')
  })

  it('旧字段 latitude/longitude/lon 不再参与坐标判定', () => {
    const response = eventResponse({ status: 'unacknowledged', eventId: 'JQ-OLD' }) as Record<string, JsonValue>
    const data = response.data as Record<string, JsonValue>
    const list = data.list as Array<Record<string, JsonValue>>
    list[0] = { ...list[0], rawPayload: { latitude: 22.5431, longitude: 114.0579, lon: 114.0579 } }

    const records = parseAccidentEventResponse(response)
    expect(records[0]).not.toHaveProperty('latitude')
    expect(records[0]).not.toHaveProperty('longitude')
  })

  it('严格解析七个状态值并拒绝未知值', () => {
    const response = eventResponse(
      { status: 'unacknowledged', eventId: 'E-1' },
      { status: 'acknowledged', eventId: 'E-2' },
      { status: 'handling', eventId: 'E-3' },
      { status: 'completed', eventId: 'E-4' },
      { status: 'ack_timeout', eventId: 'E-5' },
      { status: 'ignored', eventId: 'E-6' },
      { status: 'terminated', eventId: 'E-7' },
    )

    const statuses = parseAccidentEventResponse(response).map(record => record.status)

    expect(statuses).toEqual([
      'unacknowledged',
      'acknowledged',
      'handling',
      'completed',
      'ack_timeout',
      'ignored',
      'terminated',
    ])
    expect(() => parseAccidentEventResponse(eventResponse(
      { status: 'legacy_pending', eventId: 'E-8' },
    ))).toThrow('事件状态无效：legacy_pending')
  })

  it('解析顶层 flightMissionId 并透传到全量列表', async () => {
    const apiCall = async (): Promise<JsonValue> => eventResponse(
      { status: 'completed', eventId: 'F-1', flightMissionId: 'flight-task-1' },
      { status: 'unacknowledged', eventId: 'F-2' },
    )

    const page = await createAccidentEventsApi(apiCall).listAll({ page: 1, pageSize: 10 })

    const withFlight = page.items.find(item => item.pluginEventId === 'F-1')
    const withoutFlight = page.items.find(item => item.pluginEventId === 'F-2')
    expect(withFlight).toMatchObject({ flightMissionId: 'flight-task-1' })
    expect(withoutFlight).not.toHaveProperty('flightMissionId')
  })

  it('flightMissionId 非字符串或空串时忽略', () => {
    const response = eventResponse({ status: 'completed', eventId: 'F-3' }) as Record<string, JsonValue>
    const data = response.data as Record<string, JsonValue>
    const list = data.list as Array<Record<string, JsonValue>>
    list[0] = { ...list[0], flightMissionId: '' }

    const records = parseAccidentEventResponse(response)
    expect(records[0]).not.toHaveProperty('flightMissionId')
  })

  it('按编码后的 pluginEventId GET 单事件并保留 rawPayload/result', async () => {
    const calls: Array<{ endpoint: string; method?: string }> = []
    const apiCall = async (endpoint: string, options?: { readonly method?: 'GET' | 'POST' }): Promise<JsonValue> => {
      calls.push({ endpoint, ...(options?.method === undefined ? {} : { method: options.method }) })
      const response = eventResponse({ status: 'completed', eventId: '事故/1' }) as Record<string, JsonValue>
      const data = response.data as Record<string, JsonValue>
      const list = data.list as JsonValue[]
      return { code: 0, data: list[0] ?? null }
    }

    const event = await createAccidentEventsApi(apiCall).getEvent('事故/1')

    expect(calls).toEqual([{
      endpoint: '/plugin-scene/data-store/events/%E4%BA%8B%E6%95%85%2F1',
      method: 'GET',
    }])
    expect(event).toMatchObject({
      pluginEventId: '事故/1',
      status: 'completed',
      rawPayload: { id: '事故/1', lat: '22.5431', lng: 114.0579 },
      result: { dispatched: true },
    })
  })

  it('解析 rawPayload.correction_note 为 correctionNote', () => {
    const response = eventResponse({ status: 'acknowledged', eventId: 'E-1' }) as Record<string, JsonValue>
    const data = response.data as Record<string, JsonValue>
    const list = data.list as Array<Record<string, JsonValue>>
    const first = list[0]
    const firstRawPayload = first?.rawPayload
    if (!first || firstRawPayload === null || typeof firstRawPayload !== 'object' || Array.isArray(firstRawPayload)) {
      throw new Error('测试数据缺少 rawPayload')
    }
    list[0] = {
      ...first,
      rawPayload: { ...firstRawPayload, correction_note: '数据补录：警官王小明二次核对后修正' },
    }

    const records = parseAccidentEventResponse(response)

    expect(records[0]).toMatchObject({ correctionNote: '数据补录：警官王小明二次核对后修正' })
    expect(records[0]?.rawPayload).toMatchObject({ correction_note: '数据补录：警官王小明二次核对后修正' })
  })

  it('updateEventRawPayload 发送 eventId 与 rawPayload 并按信封判定成功', async () => {
    const calls: Array<{ endpoint: string; method?: string; body?: JsonValue }> = []
    const apiCall = async (
      endpoint: string,
      options?: { readonly method?: 'GET' | 'POST'; readonly body?: JsonValue },
    ): Promise<JsonValue> => {
      calls.push({ endpoint, ...(options?.method === undefined ? {} : { method: options.method }), ...(options?.body === undefined ? {} : { body: options.body }) })
      return { code: 0, message: 'OK', data: { updated: true } }
    }

    await expect(createAccidentEventsApi(apiCall).updateEventRawPayload('E-1', {
      alarm_id: '20260811-001',
      correction_note: '数据补录',
    })).resolves.toBeUndefined()

    expect(calls).toEqual([{
      endpoint: '/plugin-scene/data-store/events/update',
      method: 'POST',
      body: {
        eventId: 'E-1',
        rawPayload: { alarm_id: '20260811-001', correction_note: '数据补录' },
      },
    }])
  })

  it('updateEventRawPayload 失败信封抛出后端 message', async () => {
    const apiCall = async (): Promise<JsonValue> => ({ code: 40001, message: 'invalid parameter: eventId 不存在', data: null })
    await expect(createAccidentEventsApi(apiCall).updateEventRawPayload('E-404', {}))
      .rejects.toThrow('invalid parameter: eventId 不存在')
  })
})
