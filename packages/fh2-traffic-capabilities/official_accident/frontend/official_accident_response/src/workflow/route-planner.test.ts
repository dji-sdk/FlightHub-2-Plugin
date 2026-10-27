// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { RoutePlanningHttpApi } from '../api/route-planning-api'
import { createRoutePlanningApi } from './route-planner'
import type { AccidentAlertContext, DispatchDevice, DispatchRoute } from './types'

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

const planInput = {
  workspaceId: alert.projectId,
  startPosition: device.startPosition,
  destinationPosition: alert.alarmPosition,
  height: alert.flightHeight,
  takeoffReferenceAltitude: device.takeoffReferenceAltitude,
  speed: 10,
} as const

const plannedRoutes: readonly DispatchRoute[] = [
  {
    id: 'wayline/project-1/route-a.kmz',
    source: 'navinfo',
    label: '大路优先',
    totalDistance: 950,
    estimatedDuration: 95,
    waypointCount: 32,
    wpmzKey: 'wayline/project-1/route-a.kmz',
    wpmzUrl: 'http://minio.example.com/wayline/project-1/route-a.kmz',
    warnings: [],
  },
  {
    id: 'wayline/project-1/route-b.kmz',
    source: 'osm',
    label: '备选路线',
    totalDistance: 1100,
    estimatedDuration: 110,
    waypointCount: 40,
    wpmzKey: 'wayline/project-1/route-b.kmz',
    wpmzUrl: '',
    warnings: [],
  },
]

function http (routes: readonly DispatchRoute[] = plannedRoutes): RoutePlanningHttpApi {
  return {
    plan: vi.fn(async () => routes),
    registerWayline: vi.fn(async () => ({
      waylineUuid: 'uuid-a',
      key: 'wayline/project-1/route-a.kmz',
      name: '事故快处-测试事故-120000',
    })),
  }
}

describe('route planner', () => {
  it('plan 后为每条有下载地址的航线解析预览坐标', async () => {
    const wpmz = {
      parseCoordinates: vi.fn(async () => [
        { lat: 22.545, lng: 114.050, height: 120 },
        { lat: 22.5405, lng: 114.0579, height: 120 },
      ]),
    }
    const api = createRoutePlanningApi(http(), wpmz)

    const routes = await api.plan(planInput)

    expect(wpmz.parseCoordinates).toHaveBeenCalledOnce()
    expect(wpmz.parseCoordinates).toHaveBeenCalledWith({
      url: 'http://minio.example.com/wayline/project-1/route-a.kmz',
      referenceAltitude: 10,
    })
    expect(routes[0]?.coordinates).toEqual([
      { lat: 22.545, lng: 114.050, height: 120 },
      { lat: 22.5405, lng: 114.0579, height: 120 },
    ])
    expect(routes[1]).not.toHaveProperty('coordinates')
  })

  it('把 Capability 返回的自定义原型坐标投影为纯 DTO', async () => {
    class HostCoordinate {
      constructor (
        readonly lng: number,
        readonly lat: number,
        readonly height: number,
      ) {}
    }
    const hostCoordinate = new HostCoordinate(114.050, 22.545, 120)
    const api = createRoutePlanningApi(http(), {
      parseCoordinates: vi.fn(async () => [hostCoordinate]),
    })

    const routes = await api.plan(planInput)
    const coordinate = routes[0]?.coordinates?.[0]

    expect(coordinate).toEqual({ lng: 114.050, lat: 22.545, height: 120 })
    expect(coordinate).not.toBe(hostCoordinate)
    expect(Object.getPrototypeOf(coordinate)).toBe(Object.prototype)
  })

  it('坐标解析失败不阻断路线返回', async () => {
    const wpmz = {
      parseCoordinates: vi.fn(async () => {
        throw new Error('WPMZ 下载失败：HTTP 404')
      }),
    }
    const logger = { debug: vi.fn(), warn: vi.fn() }
    const api = createRoutePlanningApi(http(), wpmz, logger)

    const routes = await api.plan(planInput)

    expect(routes).toHaveLength(2)
    expect(routes[0]).not.toHaveProperty('coordinates')
    expect(logger.warn).toHaveBeenCalledWith('航线 WPMZ 坐标解析失败，仅保留起终点', expect.objectContaining({
      routeId: 'wayline/project-1/route-a.kmz',
      wpmzHost: 'minio.example.com',
      errorMessage: 'WPMZ 下载失败：HTTP 404',
    }))
  })

  it('解析结果为空与无下载地址输出对应日志', async () => {
    const wpmz = { parseCoordinates: vi.fn(async () => []) }
    const logger = { debug: vi.fn(), warn: vi.fn() }
    const api = createRoutePlanningApi(http(), wpmz, logger)

    await api.plan(planInput)

    expect(logger.warn).toHaveBeenCalledWith('航线 WPMZ 坐标解析结果为空，仅保留起终点', expect.objectContaining({
      routeId: 'wayline/project-1/route-a.kmz',
    }))
    expect(logger.debug).toHaveBeenCalledWith('航线无下载地址，仅保留起终点', expect.objectContaining({
      routeId: 'wayline/project-1/route-b.kmz',
      source: 'osm',
    }))
    // 日志只输出 host，不记录带签名的完整 URL。
    const allCalls = JSON.stringify([...logger.debug.mock.calls, ...logger.warn.mock.calls])
    expect(allCalls).not.toContain('http://minio.example.com/wayline/project-1/route-a.kmz')
  })

  it('解析成功输出耗时与坐标数日志', async () => {
    const wpmz = {
      parseCoordinates: vi.fn(async () => [
        { lat: 22.545, lng: 114.050, height: 120 },
      ]),
    }
    const logger = { debug: vi.fn(), warn: vi.fn() }
    const api = createRoutePlanningApi(http(), wpmz, logger)

    await api.plan(planInput)

    expect(logger.debug).toHaveBeenCalledWith('航线 WPMZ 坐标解析完成', expect.objectContaining({
      routeId: 'wayline/project-1/route-a.kmz',
      coordinateCount: 1,
      wpmzHost: 'minio.example.com',
    }))
  })

  it('register 以 projectId 作为 workspace 并返回 uuid', async () => {
    const client = http()
    const api = createRoutePlanningApi(client, { parseCoordinates: vi.fn(async () => []) })

    await expect(api.register(alert.projectId, { wpmzKey: 'wayline/project-1/route-a.kmz', name: '事故快处-测试事故-120000' }))
      .resolves.toBe('uuid-a')

    expect(client.registerWayline).toHaveBeenCalledWith({
      workspaceId: 'project-1',
      wpmzKey: 'wayline/project-1/route-a.kmz',
      name: '事故快处-测试事故-120000',
    })
  })
})
