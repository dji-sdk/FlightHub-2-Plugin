// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { buildDispatchAlertEvent, buildEventId, createAlertDispatchApi } from './alert-dispatch-api'
import type { ApiCall } from './types'

// 本地时间分量构造：buildEventId 按本地时间格式化，用分量构造保证期望值与运行时区无关
const FIXED_NOW = new Date(2026, 7, 26, 15, 30, 12, 412)

describe('buildEventId', () => {
  it('构造不含地域信息的 MANUAL-EVENT-<YYMMDD>-<HHMMSS>-<6位随机数>', () => {
    expect(buildEventId(FIXED_NOW, () => 0.300005)).toBe('MANUAL-EVENT-260826-153012-300005')
  })

  it('随机数不足 6 位时左侧补零', () => {
    expect(buildEventId(FIXED_NOW, () => 0.000042)).toBe('MANUAL-EVENT-260826-153012-000042')
  })
})

describe('buildDispatchAlertEvent', () => {
  it('固定字段取约定值，poi 传 0，rawPayload 含字符串坐标、地址和数字高度', () => {
    expect(buildDispatchAlertEvent(
      { address: '测试道路路口', lat: 30.5728, lng: 104.0668, flyAlt: 120, goBackAlt: 120 },
      FIXED_NOW,
      () => 0.300005,
    )).toEqual({
      eventId: 'MANUAL-EVENT-260826-153012-300005',
      eventType: '警情',
      source: 'cascade',
      priority: 'low',
      poi: { lat: 0, lng: 0 },
      occurredAt: FIXED_NOW.toISOString(),
      status: 'unacknowledged',
      notifyOn: ['unacknowledged'],
      rawPayload: {
        address: '测试道路路口',
        lat: '30.5728',
        lng: '104.0668',
        fly_alt: 120,
        go_back_alt: 120,
      },
    })
  })

  it('非默认高度按输入透传，保持 number 类型', () => {
    const event = buildDispatchAlertEvent(
      { address: '测试', lat: 30.5, lng: 104, flyAlt: 150, goBackAlt: 90 },
      FIXED_NOW,
      () => 0.5,
    )
    expect(event.rawPayload.fly_alt).toBe(150)
    expect(event.rawPayload.go_back_alt).toBe(90)
  })
})

describe('createAlertDispatchApi', () => {
  it('派发警情 POST /plugin-scene/data-store/events 并返回构造的 eventId', async () => {
    const calls: Parameters<ApiCall>[] = []
    const apiCall: ApiCall = async (endpoint, options) => {
      calls.push([endpoint, options])
      return { code: 0, message: 'OK', data: { accepted: 1 } }
    }
    const api = createAlertDispatchApi(apiCall, () => FIXED_NOW, () => 0.300005)

    await expect(api.dispatchAlert({ address: '测试道路路口', lat: 30.5728, lng: 104.0668, flyAlt: 120, goBackAlt: 120 }))
      .resolves.toEqual({ eventId: 'MANUAL-EVENT-260826-153012-300005' })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe('/plugin-scene/data-store/events')
    expect(calls[0]?.[1]?.method).toBe('POST')
    expect(calls[0]?.[1]?.body).toEqual(buildDispatchAlertEvent(
      { address: '测试道路路口', lat: 30.5728, lng: 104.0668, flyAlt: 120, goBackAlt: 120 },
      FIXED_NOW,
      () => 0.300005,
    ))
  })

  it('code 非 0 时抛出带 message 的错误', async () => {
    const apiCall: ApiCall = async () => ({ code: 40001, message: 'invalid parameter' })
    const api = createAlertDispatchApi(apiCall)

    await expect(api.dispatchAlert({ address: 'x', lat: 1, lng: 2, flyAlt: 120, goBackAlt: 120 }))
      .rejects.toThrow('invalid parameter（code: 40001）')
  })
})
