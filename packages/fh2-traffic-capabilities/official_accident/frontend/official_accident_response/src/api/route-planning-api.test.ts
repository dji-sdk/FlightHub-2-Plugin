// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { JsonValue } from 'fh2-plugin-sdk'
import type { AccidentAlertContext, DispatchDevice } from '../workflow/types'
import {
  createRoutePlanningHttpApi,
  parsePlannedRoutes,
  parseWaylineRegisterResult,
} from './route-planning-api'
import type { RoutePlanInput } from './route-planning-api'

const alert: AccidentAlertContext = {
  projectId: 'project-1',
  organizationId: 'organization-1',
  pluginEventId: 'JQ-001',
  title: '测试事故',
  alarmPosition: { lat: 22.5405, lng: 114.0579, height: 0 },
  flightHeight: 120,
  originParams: {},
  level: 1,
  address: '',
  description: '',
  waitTime: 0,
}

const device: DispatchDevice = {
  dockSn: 'dock-1',
  droneSn: 'drone-1',
  gatewaySn: 'dock-1',
  droneCallsign: '应急无人机',
  dockCallsign: '福田一号机场',
  droneModelName: 'M4D',
  dockModelName: 'Dock 3',
  startPosition: { lat: 22.545, lng: 114.050, height: 10 },
  takeoffReferenceAltitude: 10,
  idle: true,
  executingTask: false,
}

const planInput: RoutePlanInput = {
  workspaceId: alert.projectId,
  startPosition: device.startPosition,
  destinationPosition: alert.alarmPosition,
  height: alert.flightHeight,
  takeoffReferenceAltitude: device.takeoffReferenceAltitude,
  speed: 10,
}

function gatewayError (gatewayCode: number, httpStatus: number): Error {
  const error = new Error(`插件网关请求失败：规划器未就绪`) as Error & {
    code: string;
    detail: JsonValue;
  }
  error.code = 'PLUGIN_GATEWAY_ERROR'
  error.detail = { gatewayCode, httpStatus }
  return error
}

describe('route planning api', () => {
  it('plan 发送 snake_case 请求体并解析候选航线', async () => {
    const apiCall = vi.fn(async (): Promise<JsonValue> => ({
      code: 0,
      message: 'OK',
      data: {
        routes: [
          {
            source: 'navinfo',
            label: '大路优先',
            total_distance: 950.5,
            estimated_duration: 95.1,
            waypoint_count: 32,
            wpmz_key: 'wayline/project-1/route-a.kmz',
            wpmz_url: 'http://minio.example.com/wayline/project-1/route-a.kmz',
            warnings: [],
          },
          {
            source: 'osm',
            label: '备选路线',
            total_distance: 1100,
            estimated_duration: 110,
            waypoint_count: 40,
            wpmz_key: 'wayline/project-1/route-b.kmz',
            wpmz_url: '',
            wayline_uuid: 'uuid-b',
            warnings: ['前方存在禁飞区'],
          },
          {
            source: 'osm',
            label: '缺 key 路线',
            total_distance: 1,
            estimated_duration: 1,
            waypoint_count: 1,
          },
        ],
      },
    }))
    const api = createRoutePlanningHttpApi(apiCall)

    const routes = await api.plan(planInput)

    expect(apiCall).toHaveBeenCalledWith('/plugin-scene/route-planning/plan', {
      method: 'POST',
      body: {
        workspace_id: 'project-1',
        start_lat: 22.545,
        start_lng: 114.050,
        end_lat: 22.5405,
        end_lng: 114.0579,
        height: 120,
        takeoff_ref_altitude: 10,
        speed: 10,
      },
    })
    expect(routes).toHaveLength(2)
    expect(routes[0]).toMatchObject({
      id: 'wayline/project-1/route-a.kmz',
      wpmzKey: 'wayline/project-1/route-a.kmz',
      wpmzUrl: 'http://minio.example.com/wayline/project-1/route-a.kmz',
      warnings: [],
    })
    expect(routes[0]).not.toHaveProperty('waylineUuid')
    expect(routes[1]).toMatchObject({
      wpmzUrl: '',
      waylineUuid: 'uuid-b',
      warnings: ['前方存在禁飞区'],
    })
  })

  it('plan 规划器未就绪转换为友好文案', async () => {
    const apiCall = vi.fn(async (): Promise<JsonValue> => {
      throw gatewayError(50001, 503)
    })
    const api = createRoutePlanningHttpApi(apiCall)

    await expect(api.plan(planInput)).rejects.toThrow('路线规划服务未就绪，请稍后重试')
  })

  it('plan 参数层失败不透传后端 message，使用通用兜底文案', async () => {
    const apiCall = vi.fn(async (): Promise<JsonValue> => {
      const error = new Error('插件网关请求失败：invalid parameter: 起终点直线距离8.34km超过限制7.0km，请缩短飞行距离') as Error & {
        code: string;
        detail: JsonValue;
      }
      error.code = 'PLUGIN_GATEWAY_ERROR'
      error.detail = { gatewayCode: 40001, httpStatus: 400 }
      throw error
    })
    const api = createRoutePlanningHttpApi(apiCall)

    await expect(api.plan(planInput)).rejects.toThrow('路线规划失败')
  })

  it('plan 非插件错误对象也使用通用兜底文案', async () => {
    // 本用例特意以非 Error 对象拒绝，验证防御分支；lint 规则要求 Error 是常规代码约定。
    const apiCall = vi.fn(async (): Promise<JsonValue> => {
      // eslint-disable-next-line prefer-promise-reject-errors
      return Promise.reject({ message: 'network down' })
    })
    const api = createRoutePlanningHttpApi(apiCall)

    await expect(api.plan(planInput)).rejects.toThrow('路线规划失败')
  })

  it.each([
    [11001, '起终点直线距离超过无人机航程上限'],
    [11002, '所有候选图都没能生成可达航线'],
  ])('plan 业务码 %s 转换为中文提示', async (code, message) => {
    const apiCall = vi.fn(async (): Promise<JsonValue> => ({ code, message: 'internal detail', data: null }))

    await expect(createRoutePlanningHttpApi(apiCall).plan(planInput)).rejects.toThrow(message)
  })

  it('plan 网关 11001 固定文案不透传后端 message 与 detail', async () => {
    const apiCall = vi.fn(async (): Promise<JsonValue> => {
      const error = new Error('插件网关请求失败：route distance exceeds limit') as Error & {
        code: string;
        detail: JsonValue;
      }
      error.code = 'PLUGIN_GATEWAY_ERROR'
      error.detail = {
        gatewayCode: 11001,
        httpStatus: 200,
        gatewayMessage: 'route distance exceeds limit',
        gatewayDetail: '起终点直线距离9.67km超过限制7.0km，请缩短飞行距离',
      }
      throw error
    })
    const api = createRoutePlanningHttpApi(apiCall)

    await expect(api.plan(planInput)).rejects.toThrow('起终点直线距离超过无人机航程上限')
  })

  it('gateway 透传的 11002 同样转换为中文提示', async () => {
    const apiCall = vi.fn(async (): Promise<JsonValue> => {
      throw gatewayError(11002, 400)
    })

    await expect(createRoutePlanningHttpApi(apiCall).plan(planInput))
      .rejects.toThrow('所有候选图都没能生成可达航线')
  })

  it('返航规划透传 interval 与 finish_action', async () => {
    const apiCall = vi.fn(async (): Promise<JsonValue> => ({ code: 0, message: 'OK', data: { routes: [] } }))
    await createRoutePlanningHttpApi(apiCall).plan({ ...planInput, speed: 14, interval: 100, finishAction: 'goHome' })
    expect(apiCall).toHaveBeenCalledWith('/plugin-scene/route-planning/plan', expect.objectContaining({
      body: expect.objectContaining({ speed: 14, interval: 100, finish_action: 'goHome' }),
    }))
  })

  it('去程规划透传 end_gimbal_pitch，未传时请求体不含该字段', async () => {
    const apiCall = vi.fn(async (): Promise<JsonValue> => ({ code: 0, message: 'OK', data: { routes: [] } }))
    const api = createRoutePlanningHttpApi(apiCall)

    await api.plan({ ...planInput, endGimbalPitch: -90 })
    expect(apiCall).toHaveBeenCalledWith('/plugin-scene/route-planning/plan', expect.objectContaining({
      body: expect.objectContaining({ end_gimbal_pitch: -90 }),
    }))

    await api.plan(planInput)
    expect(apiCall).toHaveBeenLastCalledWith('/plugin-scene/route-planning/plan', {
      method: 'POST',
      body: {
        workspace_id: 'project-1',
        start_lat: 22.545,
        start_lng: 114.050,
        end_lat: 22.5405,
        end_lng: 114.0579,
        height: 120,
        takeoff_ref_altitude: 10,
        speed: 10,
      },
    })
  })

  it('registerWayline 发送入库请求并解析 uuid', async () => {
    const apiCall = vi.fn(async (): Promise<JsonValue> => ({
      code: 0,
      message: 'OK',
      data: {
        wayline_uuid: 'uuid-1',
        key: 'wayline/project-1/route-a.kmz',
        name: '巡检航线-A',
      },
    }))
    const api = createRoutePlanningHttpApi(apiCall)

    const result = await api.registerWayline({
      workspaceId: 'project-1',
      wpmzKey: 'wayline/project-1/route-a.kmz',
      name: '巡检航线-A',
    })

    expect(apiCall).toHaveBeenCalledWith('/plugin-scene/route-planning/register', {
      method: 'POST',
      body: {
        workspace_id: 'project-1',
        wpmz_key: 'wayline/project-1/route-a.kmz',
        name: '巡检航线-A',
      },
    })
    expect(result).toEqual({
      waylineUuid: 'uuid-1',
      key: 'wayline/project-1/route-a.kmz',
      name: '巡检航线-A',
    })
  })

  it('registerWayline 航线库未就绪转换为友好文案', async () => {
    const apiCall = vi.fn(async (): Promise<JsonValue> => {
      throw gatewayError(50001, 503)
    })
    const api = createRoutePlanningHttpApi(apiCall)

    await expect(api.registerWayline({
      workspaceId: 'project-1',
      wpmzKey: 'wayline/project-1/route-a.kmz',
      name: '巡检航线-A',
    })).rejects.toThrow('航线库服务未就绪，请稍后重试')
  })

  it('registerWayline 缺 wayline_uuid 抛出明确错误', async () => {
    const apiCall = vi.fn(async (): Promise<JsonValue> => ({
      code: 0,
      message: 'OK',
      data: { key: 'wayline/project-1/route-a.kmz' },
    }))
    const api = createRoutePlanningHttpApi(apiCall)

    await expect(api.registerWayline({
      workspaceId: 'project-1',
      wpmzKey: 'wayline/project-1/route-a.kmz',
      name: '巡检航线-A',
    })).rejects.toThrow('航线入库响应缺少 wayline_uuid')
  })

  it('parsePlannedRoutes 容忍空 routes 与非对象输入', () => {
    expect(parsePlannedRoutes({ routes: [] })).toEqual([])
    expect(parsePlannedRoutes({})).toEqual([])
    expect(parsePlannedRoutes('bad')).toEqual([])
  })

  it('parseWaylineRegisterResult 缺 uuid 抛错', () => {
    expect(() => parseWaylineRegisterResult({ key: 'k', name: 'n' })).toThrow('航线入库响应缺少 wayline_uuid')
    expect(parseWaylineRegisterResult({ wayline_uuid: 'u', key: 'k', name: 'n' })).toEqual({
      waylineUuid: 'u',
      key: 'k',
      name: 'n',
    })
  })
})
