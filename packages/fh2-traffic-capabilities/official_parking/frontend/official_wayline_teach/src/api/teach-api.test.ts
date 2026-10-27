// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { ApiCallOptions } from 'fh2-plugin-sdk'
import { createTeachApi, isTeachConflictError, isTeachStateError } from './teach-api'

const routeDto = {
  id: 'route-1',
  project_id: 'project-1',
  status: 'recording',
  name: '示教航线',
  flight_id: 'flight-1',
  created_at: '2026-09-01T00:00:00Z',
  global_speed: 15,
  waypoint_speed: 5,
  screenshot_bytes: 512,
  wayline_uuid: null,
  wayline_file_id: null,
  kmz_object_key: null,
  waypoints: [{
    id: 'point-1',
    seq: 0,
    longitude: 113.9,
    latitude: 22.5,
    height: 171.6,
    camera_yaw: -20,
    gimbal_pitch: -30,
    focal_length: 24,
    ai_recognition_on: true,
    ai_target_types: ['vehicle', 'car', 'person'],
    screenshot_file_id: 'file-1',
    screenshot_url: null,
    screenshot_bytes: 512,
    selected: true,
  }],
}

describe('示教 API', () => {
  it('只恢复 recording 路线，并映射 WGS84 高度、相机偏航和合法 AI 类型', async () => {
    const apiCall = vi.fn(async () => ({ code: 0, data: { teach_route: routeDto } }))
    const api = createTeachApi(apiCall)

    await expect(api.getStatus('project-1', 'flight-1')).resolves.toMatchObject({
      id: 'route-1',
      waypointSpeed: 5,
      waypoints: [{ height: 171.6, cameraYaw: -20, aiTargetTypes: ['car', 'person'] }],
    })
    expect(apiCall).toHaveBeenCalledWith(
      '/plugin/invoke',
      {
        method: 'POST',
        body: {
          pluginId: 'official_patrol_teach',
          handler: 'h_teach_getRouteStatus',
          input: { flight_id: 'flight-1' },
        },
      },
    )
  })

  it('status 意外返回 generated 时仍不恢复为录制会话', async () => {
    const apiCall = vi.fn(async () => ({ code: 0, data: { teach_route: { ...routeDto, status: 'generated' } } }))
    const api = createTeachApi(apiCall)

    await expect(api.getStatus('project-1', 'flight-1')).resolves.toBeNull()
  })

  it('追加航点发送新契约字段，不携带速度、路段或机头朝向', async () => {
    const apiCall = vi.fn(async () => ({ code: 0, data: { id: 'point-1', seq: 0 } }))
    const api = createTeachApi(apiCall)
    await api.appendWaypoint('route-1', {
      longitude: 113.9,
      latitude: 22.5,
      height: 171.6,
      cameraYaw: -20,
      gimbalPitch: -30,
      focalLength: 24,
      aiRecognitionOn: true,
      aiTargetTypes: ['car'],
    })

    expect(apiCall).toHaveBeenCalledWith(
      '/plugin/invoke',
      {
        method: 'POST',
        body: {
          pluginId: 'official_patrol_teach',
          handler: 'h_teach_appendWaypoint',
          input: {
            teach_route_id: 'route-1',
            longitude: 113.9,
            latitude: 22.5,
            height: 171.6,
            camera_yaw: -20,
            gimbal_pitch: -30,
            focal_length: 24,
            ai_recognition_on: true,
            ai_target_types: ['car'],
          },
        },
      },
    )
  })

  it('进入、删除路线和航点编辑使用唯一函数 handler', async () => {
    const apiCall = vi.fn(async (_endpoint: string, options?: ApiCallOptions) => {
      const body = options?.body as { handler?: string } | undefined
      return body?.handler === 'h_teach_enterRoute'
        ? { code: 0, data: { teach_route_id: 'route-1', name: '示教航线', status: 'recording' } }
        : { code: 0, data: {} }
    })
    const api = createTeachApi(apiCall)

    await api.enter({ projectId: 'project-1', flightId: 'flight-1', dockSn: 'dock-1', droneSn: 'drone-1' })
    await api.updateWaypoint('point-1', { focalLength: 40, selected: false })
    await api.deleteWaypoint('point-1')
    await api.deleteRoute('route-1')

    expect(apiCall.mock.calls.map(([, options]) => options?.body)).toEqual([
      {
        pluginId: 'official_patrol_teach',
        handler: 'h_teach_enterRoute',
        input: { project_id: 'project-1', flight_id: 'flight-1', dock_sn: 'dock-1', drone_sn: 'drone-1' },
      },
      {
        pluginId: 'official_patrol_teach',
        handler: 'h_teach_updateWaypoint',
        input: { waypoint_id: 'point-1', focal_length: 40, selected: false },
      },
      {
        pluginId: 'official_patrol_teach',
        handler: 'h_teach_deleteWaypoint',
        input: { waypoint_id: 'point-1' },
      },
      {
        pluginId: 'official_patrol_teach',
        handler: 'h_teach_deleteRoute',
        input: { teach_route_id: 'route-1' },
      },
    ])
  })

  it('截图 STS 使用统一 handler 并原样携带路线和航点 ID', async () => {
    const apiCall = vi.fn(async () => ({
      code: 0,
      data: {
        endpoint: 'http://storage.local:30802',
        bucket: 'media-storage-privatization',
        region: 'us-east-1',
        object_key: 'teach/route-1/file-1.jpg',
        object_key_prefix: 'teach/route-1/',
        access_key_id: 'access-key',
        secret_access_key: 'secret-key',
        security_token: 'security-token',
        expires_in: 43200,
        use_path_style: true,
      },
    }))
    const api = createTeachApi(apiCall)

    await expect(api.createScreenshotUpload('735dbb8a-4e21-470c-8e0f-5eb5af3cf5b2', 'f0fb813a-e6be-4f68-8988-25a451b592c2')).resolves.toEqual({
      endpoint: 'http://storage.local:30802',
      bucket: 'media-storage-privatization',
      region: 'us-east-1',
      objectKey: 'teach/route-1/file-1.jpg',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      securityToken: 'security-token',
      usePathStyle: true,
    })
    expect(apiCall).toHaveBeenCalledWith(
      '/plugin/invoke',
      {
        method: 'POST',
        body: {
          pluginId: 'official_patrol_teach',
          handler: 'h_teach_createScreenshotSTS',
          input: {
            teach_route_id: '735dbb8a-4e21-470c-8e0f-5eb5af3cf5b2',
            waypoint_id: 'f0fb813a-e6be-4f68-8988-25a451b592c2',
          },
        },
      },
    )
  })

  it('截图 STS 缺少凭证时明确拒绝', async () => {
    const api = createTeachApi(vi.fn(async () => ({
      code: 0,
      data: {
        object_key: 'teach/route-1/file-1.jpg',
      },
    })))

    await expect(api.createScreenshotUpload('route-1', '1')).rejects.toThrow('endpoint')
  })

  it('提交截图元信息固定发送空 file_id', async () => {
    const apiCall = vi.fn(async () => ({
      code: 0,
      data: { waypoint_id: 'point-1', object_key: 'teach/route-1/file-1.jpg', bytes: 5 },
    }))
    const api = createTeachApi(apiCall)

    await expect(api.attachScreenshot('point-1', {
      objectKey: 'teach/route-1/file-1.jpg',
      bytes: 5,
    })).resolves.toEqual({ screenshotFileId: null, screenshotUrl: null })
    expect(apiCall).toHaveBeenCalledWith(
      '/plugin/invoke',
      {
        method: 'POST',
        body: {
          pluginId: 'official_patrol_teach',
          handler: 'h_teach_attachScreenshot',
          input: { waypoint_id: 'point-1', object_key: 'teach/route-1/file-1.jpg', bytes: 5, file_id: '' },
        },
      },
    )
  })

  it('生成只发送路线级双速度，不发送严管路段或 waypoint_ids', async () => {
    const apiCall = vi.fn(async () => ({
      code: 0,
      data: { wayline_uuid: 'wayline-1', wayline_file_id: 'file-1', kmz_object_key: 'teach/route-1.kmz' },
    }))
    const api = createTeachApi(apiCall)
    await api.generate('route-1', { name: '航线 A', globalSpeed: 15, waypointSpeed: 5, droneModelKey: '0-100-1' })

    expect(apiCall).toHaveBeenCalledWith(
      '/plugin/invoke',
      {
        method: 'POST',
        body: {
          pluginId: 'official_patrol_teach',
          handler: 'h_teach_generateWayline',
          input: { teach_route_id: 'route-1', name: '航线 A', global_speed: 15, waypoint_speed: 5, drone_model_key: '0-100-1' },
        },
      },
    )
  })

  it('生成必须随请求下发 drone_model_key', async () => {
    const apiCall = vi.fn(async () => ({
      code: 0,
      data: { wayline_uuid: 'wayline-1', wayline_file_id: 'file-1', kmz_object_key: 'teach/route-1.kmz' },
    }))
    const api = createTeachApi(apiCall)
    await api.generate('route-1', { name: '航线 A', globalSpeed: 15, waypointSpeed: 5, droneModelKey: '0-100-1' })

    expect(apiCall).toHaveBeenCalledWith(
      '/plugin/invoke',
      {
        method: 'POST',
        body: {
          pluginId: 'official_patrol_teach',
          handler: 'h_teach_generateWayline',
          input: {
            teach_route_id: 'route-1',
            name: '航线 A',
            global_speed: 15,
            waypoint_speed: 5,
            drone_model_key: '0-100-1',
          },
        },
      },
    )
  })

  it.each(['', '   '])('机型 key 为空白 %j 时不发起生成请求', async (droneModelKey) => {
    const apiCall = vi.fn(async () => ({ code: 0, data: {} }))
    const api = createTeachApi(apiCall)
    await expect(api.generate('route-1', { name: '航线 A', globalSpeed: 15, waypointSpeed: 5, droneModelKey }))
      .rejects.toThrow('无人机机型不可用')
    expect(apiCall).not.toHaveBeenCalled()
  })

  it('识别 Engine 保留的 40901 结构化错误', () => {
    const error = Object.assign(new Error('冲突'), {
      code: 'PLUGIN_GATEWAY_ERROR',
      detail: { httpStatus: 409, gatewayCode: 40901 },
    })
    expect(isTeachConflictError(error)).toBe(true)
    expect(isTeachConflictError(Object.assign(new Error('状态错误'), {
      code: 'PLUGIN_GATEWAY_ERROR',
      detail: { httpStatus: 409, gatewayCode: 40902 },
    }))).toBe(false)
    expect(isTeachStateError(Object.assign(new Error('状态错误'), {
      code: 'PLUGIN_GATEWAY_ERROR',
      detail: { httpStatus: 409, gatewayCode: 40902 },
    }))).toBe(true)
  })
})
