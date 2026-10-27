// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { ACCIDENT_LIST_POLL_INTERVAL_MS, createDispatchRequest, toAccidentListItem } from './incident-message'
import type { AccidentRecord } from './types'

describe('incident message', () => {
  it('project 记录直接转换为派遣请求，不再构造伪 WS 消息', () => {
    const record: AccidentRecord = {
      pluginEventId: 'incident-2',
      title: '列表事故',
      createdAt: 2,
      status: 'handling',
      priority: 'high',
      address: '福田路口',
      latitude: 22.5,
      longitude: 114,
      height: 10,
      correctionNote: '已有反馈',
      rawPayload: {
        fly_alt: 100,
        desc: '道路事故',
      },
      result: null,
    }
    expect(createDispatchRequest(record, 'project-2', 'organization-2')).toMatchObject({
      pluginEventId: 'incident-2',
      popupId: '',
      projectId: 'project-2',
      organizationId: 'organization-2',
      alarmPosition: { lat: 22.5, lng: 114, height: 10 },
      description: '道路事故',
    })
    expect(toAccidentListItem(record)).toMatchObject({ correctionNote: '已有反馈', status: 'handling', hasCoordinates: true })
  })

  it('缺少经纬度时拒绝创建派遣请求', () => {
    const record: AccidentRecord = {
      pluginEventId: 'incident-3',
      title: '缺坐标事故',
      createdAt: 3,
      status: 'acknowledged',
      priority: 'low',
      address: '北环大道',
      height: 0,
      rawPayload: { desc: '北环大道三车追尾' },
      result: null,
    }
    expect(() => createDispatchRequest(record, 'project-3', 'organization-3'))
      .toThrow('警情缺少经纬度，无法派遣')
    expect(toAccidentListItem(record)).toMatchObject({ hasCoordinates: false })
  })

  it('列表轮询间隔固定为 10 秒', () => {
    expect(ACCIDENT_LIST_POLL_INTERVAL_MS).toBe(10_000)
  })
})
