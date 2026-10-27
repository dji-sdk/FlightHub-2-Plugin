// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h_teach_appendWaypoint } from '../handlers/teach/append-waypoint'
import { h_teach_deleteRoute } from '../handlers/teach/delete-route'
import { h_teach_generateWayline } from '../handlers/teach/generate-wayline'
import { h_teach_listRoutes } from '../handlers/teach/list-routes'
import { h_teach_updateRoute } from '../handlers/teach/update-route'
import { h_teach_updateWaypoint } from '../handlers/teach/update-waypoint'

function result<T> (data: T): { readonly ok: true; readonly data: T } {
  return { ok: true, data }
}

function page<T> (list: T[], total = list.length): { list: T[]; total: number; limit: number; offset: number } {
  return { list, total, limit: list.length, offset: 0 }
}

function thrownBy (run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('Expected the function to throw')
}

function route (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'route-1',
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    project_id: 'project-1',
    name: '巡逻航线',
    flight_id: 'flight-1',
    dock_sn: 'dock-1',
    drone_sn: 'drone-1',
    status: 'recording',
    global_speed: '15',
    waypoint_speed: '5',
    wayline_uuid: 'old-wayline',
    wayline_file_id: '',
    kmz_object_key: 'old.kmz',
    screenshot_bytes: '0',
    recording_flight_id: 'flight-1',
    ...overrides,
  }
}

function waypoint (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'waypoint-1',
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    teach_route_id: 'route-1',
    seq: '000001',
    latitude: '22.5',
    longitude: '114.0',
    height: '10',
    gimbal_pitch: '-45',
    camera_yaw: '90',
    focal_length: '24',
    ai_recognition_on: 'false',
    ai_target_types: '',
    screenshot_file_id: '',
    screenshot_key: '',
    screenshot_bytes: '0',
    selected: 'true',
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('official patrol teach diagnostics', () => {
  it('uses Worker UTF-16 route-name lengths in both generation and update errors', () => {
    const name = `${'a'.repeat(127)}😀`
    const error = { code: 'INVALID_ARGUMENT', message: 'name 超过 128 字(当前 129)' }

    expect(thrownBy(() => h_teach_generateWayline({ teach_route_id: 'route-1', name }))).toEqual(error)
    expect(thrownBy(() => h_teach_updateRoute({ teach_route_id: 'route-1', name }))).toEqual(error)
  })

  it('keeps generate-wayline result, fallback, and cleanup diagnostics', () => {
    const info = vi.fn()
    const warn = vi.fn()
    const query = vi.fn((entity: string) => result(page(entity === 'teach_route'
      ? [route()]
      : [waypoint(), waypoint({ id: 'waypoint-2', seq: '000002' })])))
    vi.stubGlobal('store', {
      query,
      update: vi.fn(() => result({ affected: 1 })),
      delete: vi.fn(() => result({ deleted: 2 })),
    })
    vi.stubGlobal('wayline', {
      generate: vi.fn(() => ({ waylineUuid: 'wayline-1', objectKey: 'generated.kmz', name: '', waypointCount: 2 })),
    })
    vi.stubGlobal('log', { info, warn, error: vi.fn() })

    expect(h_teach_generateWayline({ teach_route_id: 'route-1', name: '请求名', drone_model_key: '0-100-1' })).toMatchObject({
      name: '请求名',
      waypoint_count: 2,
      deleted_waypoints: 2,
    })
    expect(warn).toHaveBeenCalledWith('航线登记回了空名字,兜底用请求里的 name', {
      teach_route_id: 'route-1',
      wayline_uuid: 'wayline-1',
    })
    expect(info).toHaveBeenCalledWith('生成示教航线', {
      teach_route_id: 'route-1',
      wayline_uuid: 'wayline-1',
      object_key: 'generated.kmz',
      name: '请求名',
      global_speed: 15,
      waypoint_speed: 5,
      drone_model_key: '0-100-1',
      waypoints_in_kmz: 2,
      deleted_waypoints: 2,
    })
  })

  it('explains dropped append-waypoint AI types without changing validation', () => {
    expect(thrownBy(() => h_teach_appendWaypoint({
      teach_route_id: 'route-1',
      latitude: 22.5,
      longitude: 114,
      height: 10,
      gimbal_pitch: -45,
      camera_yaw: 90,
      focal_length: 24,
      ai_recognition_on: true,
      ai_target_types: ['vehicle', 'human'],
    }))).toEqual({
      code: 'INVALID_ARGUMENT',
      message: 'ai_recognition_on 为 true 时 ai_target_types 不能为空(收到 2 个类型:vehicle / human,白名单里一个都不认识;合法值只有 boat / car / person —— ⚠️ 小写,且 vehicle 不是 car 的同义词)',
    })
  })

  it('keeps actionable list and update validation errors', () => {
    expect(thrownBy(() => h_teach_listRoutes({ status: 'archived' }))).toEqual({
      code: 'INVALID_ARGUMENT',
      message: 'status 只能是 recording / generated(不传表示不按状态筛)',
    })
    expect(thrownBy(() => h_teach_updateWaypoint({ waypoint_id: 'waypoint-1' }))).toEqual({
      code: 'INVALID_ARGUMENT',
      message: 'focal_length / selected 至少要传一个(位置与姿态是实测值,不可改;速度是路线级的,走 update-route)',
    })
    expect(thrownBy(() => h_teach_updateRoute({ teach_route_id: 'route-1' }))).toEqual({
      code: 'INVALID_ARGUMENT',
      message: 'name 与 global_speed 至少要传一个(waypoint_speed 不可改 —— 它与 global_speed 喂给 KMZ 的是不同位置)',
    })
  })

  it('logs unreconciled route screenshots and list filters', () => {
    const deleteInfo = vi.fn()
    const deleteWarn = vi.fn()
    vi.stubGlobal('store', {
      query: vi.fn(() => result(page([route({ screenshot_bytes: '128' })]))),
      count: vi.fn(() => result({ count: 3 })),
      delete: vi.fn(() => result({ deleted: 1 })),
    })
    vi.stubGlobal('log', { info: deleteInfo, warn: deleteWarn, error: vi.fn() })

    expect(h_teach_deleteRoute({ teach_route_id: 'route-1' })).toEqual({ id: 'route-1', deleted_waypoints: 3 })
    expect(deleteWarn).toHaveBeenCalledWith('删除示教航线:名下截图未对账(级联删拿不到航点的 screenshot_key)', {
      teach_route_id: 'route-1',
      screenshot_bytes: '128',
      deleted_waypoints: 3,
    })

    const listInfo = vi.fn()
    vi.stubGlobal('store', {
      query: vi.fn(() => result(page([]))),
      count: vi.fn(() => result({ count: 0 })),
    })
    vi.stubGlobal('log', { info: listInfo, warn: vi.fn(), error: vi.fn() })

    expect(h_teach_listRoutes({ project_id: 'project-1', status: 'generated' })).toEqual({
      pagination: { page: 1, page_size: 20, total: 0 },
      list: [],
    })
    expect(listInfo).toHaveBeenCalledWith('示教航线列表', {
      page: 1,
      page_size: 20,
      total: 0,
      returned: 0,
      count_queries: 0,
      filtered_by_project: true,
      filtered_by_status: true,
    })
  })

  it('logs updated waypoint values and reports vanished records precisely', () => {
    const info = vi.fn()
    vi.stubGlobal('store', {
      update: vi.fn(() => result({ affected: 1 })),
      query: vi.fn(() => result(page([waypoint({ focal_length: '50', selected: 'false' })]))),
    })
    vi.stubGlobal('log', { info, warn: vi.fn(), error: vi.fn() })

    h_teach_updateWaypoint({ waypoint_id: 'waypoint-1', focal_length: 50, selected: false })
    expect(info).toHaveBeenCalledWith('更新航点', {
      waypoint_id: 'waypoint-1',
      teach_route_id: 'route-1',
      seq: 1,
      changed: 'focal_length,selected',
      focal_length: 50,
      selected: false,
    })

    vi.stubGlobal('store', {
      update: vi.fn(() => result({ affected: 1 })),
      query: vi.fn(() => result(page([]))),
    })
    expect(thrownBy(() => h_teach_updateWaypoint({ waypoint_id: 'waypoint-1', selected: true }))).toEqual({
      code: 'NOT_FOUND',
      message: '航点已被删除(waypoint_id=waypoint-1)',
    })
  })

  it('logs update-route results with its returned waypoint count', () => {
    const info = vi.fn()
    const query = vi.fn((entity: string) => result(page(entity === 'teach_route' ? [route({ name: '新航线', global_speed: '8' })] : [])))
    vi.stubGlobal('store', {
      update: vi.fn(() => result({ affected: 1 })),
      query,
    })
    vi.stubGlobal('log', { info, warn: vi.fn(), error: vi.fn() })

    h_teach_updateRoute({ teach_route_id: 'route-1', name: '新航线', global_speed: 8 })
    expect(info).toHaveBeenCalledWith('改航线', {
      teach_route_id: 'route-1',
      changed: 'name,global_speed',
      name: '新航线',
      global_speed: 8,
      waypoint_count: 0,
    })
  })
})
