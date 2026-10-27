// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { TeachMockBackend } from './teach-mock.js'

const servers: Server[] = []
const BASE = '/plugin-api/plugin-scene/patrol/teach'

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function startBackend (): Promise<{ readonly url: string; readonly backend: TeachMockBackend }> {
  const backend = new TeachMockBackend()
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://local.test')
    void backend.handle(req, res, requestUrl).then((handled) => {
      if (!handled && !res.writableEnded) res.end()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { url: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`, backend }
}

function waypoint (longitude: number, aiRecognitionOn = true): Record<string, unknown> {
  return {
    latitude: 22.53,
    longitude,
    height: 171.6,
    gimbal_pitch: -30,
    camera_yaw: -20,
    focal_length: 24,
    ai_recognition_on: aiRecognitionOn,
    ai_target_types: aiRecognitionOn ? ['car'] : [],
  }
}

describe('teach mock backend', () => {
  it('遵循 recording -> generated、WGS84/camera_yaw 与截图绑定闭环', async () => {
    const { url, backend } = await startBackend()
    const pluginId = 'official_patrol_teach'
    const entered = backend.invoke({
      pluginId,
      handler: 'h_teach_enterRoute',
      input: { project_id: 'futian', flight_id: 'flight-1', dock_sn: 'dock-1', drone_sn: 'drone-1' },
    }, url) as { teach_route_id: number }
    const routeId = entered.teach_route_id
    expect(() => backend.invoke({
      pluginId,
      handler: 'h_teach_enterRoute',
      input: { project_id: 'futian', flight_id: 'flight-1', dock_sn: 'dock-1', drone_sn: 'drone-1' },
    }, url)).toThrow('该架次已有录制中的示教航线')
    expect(backend.invoke({
      pluginId,
      handler: 'h_teach_getRouteStatus',
      input: { flight_id: 'flight-1' },
    }, url)).toMatchObject({ teach_route: { id: routeId, status: 'recording' } })

    const first = backend.invoke({
      pluginId,
      handler: 'h_teach_appendWaypoint',
      input: { teach_route_id: routeId, ...waypoint(114.0562) },
    }, url) as { id: number }
    const waypointId = first.id
    const second = backend.invoke({
      pluginId,
      handler: 'h_teach_appendWaypoint',
      input: { teach_route_id: routeId, ...waypoint(114.0572, false) },
    }, url) as { id: number }
    const secondWaypointId = second.id
    expect(backend.invoke({
      pluginId,
      handler: 'h_teach_updateWaypoint',
      input: { waypoint_id: secondWaypointId, focal_length: 35, selected: true },
    }, url)).toEqual({ id: secondWaypointId })

    expect(() => backend.invoke({
      pluginId: 'official_patrol_teach',
      handler: 'h_teach_createScreenshotSTS',
      input: { teach_route_id: routeId },
    }, url)).toThrow('ID 参数非法')

    const sts = backend.invoke({
      pluginId: 'official_patrol_teach',
      handler: 'h_teach_createScreenshotSTS',
      input: { teach_route_id: routeId, waypoint_id: waypointId },
    }, url) as {
      endpoint: string;
      bucket: string;
      region: string;
      object_key_prefix: string;
      object_key: string;
      access_key_id: string;
      secret_access_key: string;
      security_token: string;
      expires_in: number;
      use_path_style: boolean;
    }
    expect(sts).toMatchObject({
      endpoint: `${url}/plugin-api/mock/object-upload`,
      bucket: 'fh2-plugin-mock',
      region: 'mock-region-1',
      object_key_prefix: `teach/${routeId}/`,
      expires_in: 900,
      use_path_style: true,
    })
    const uploadUrl = `${sts.endpoint}/${sts.bucket}/${sts.object_key}`
    const uploaded = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: new Blob(['frame'], { type: 'text/plain' }),
    })
    expect(uploaded.status).toBe(200)
    const duplicateUpload = await fetch(uploadUrl, {
      method: 'PUT',
      body: new Blob(['frame']),
    })
    expect(duplicateUpload.status).toBe(409)
    expect(() => backend.invoke({
      pluginId: 'official_patrol_teach',
      handler: 'h_teach_attachScreenshot',
      input: { waypoint_id: secondWaypointId, object_key: sts.object_key, bytes: 5 },
    }, url)).toThrow('截图元信息非法')
    expect(() => backend.invoke({
      pluginId: 'official_patrol_teach',
      handler: 'h_teach_attachScreenshot',
      input: { waypoint_id: waypointId, object_key: sts.object_key, bytes: 5 },
    }, url)).not.toThrow()

    expect(backend.invoke({
      pluginId: 'official_patrol_teach',
      handler: 'h_teach_generateWayline',
      input: { teach_route_id: routeId, name: '福华三路巡逻线', global_speed: 15, waypoint_speed: 5 },
    }, url)).toMatchObject({ waypoint_count: 2, kmz_object_key: `teach/${routeId}/route.kmz` })

    expect(backend.invoke({
      pluginId,
      handler: 'h_teach_getRouteStatus',
      input: { flight_id: 'flight-1' },
    }, url)).toEqual({ teach_route: null })
    const detail = await fetch(`${url}${BASE}/routes/${routeId}`)
    expect(await detail.json()).toMatchObject({
      code: 0,
      data: { status: 'generated', waypoint_count: 2, waypoints: [], waypoint_speed: 5 },
    })

    expect(() => backend.invoke({
      pluginId: 'official_patrol_teach',
      handler: 'h_teach_generateWayline',
      input: { teach_route_id: routeId, name: '重复生成', global_speed: 15, waypoint_speed: 5 },
    }, url)).toThrow('路线状态不允许此操作')
    expect(() => backend.invoke({
      pluginId: 'official_patrol_teach',
      handler: 'h_teach_createScreenshotSTS',
      input: { teach_route_id: routeId, waypoint_id: waypointId },
    }, url)).toThrow('路线状态不允许此操作')
  })

  it('ai 开启但没有合法类型时拒绝航点', async () => {
    const { url, backend } = await startBackend()
    const entered = backend.invoke({
      pluginId: 'official_patrol_teach',
      handler: 'h_teach_enterRoute',
      input: { project_id: 'futian', flight_id: 'flight-2', dock_sn: 'dock-1', drone_sn: 'drone-1' },
    }, url) as { teach_route_id: number }

    expect(() => backend.invoke({
      pluginId: 'official_patrol_teach',
      handler: 'h_teach_appendWaypoint',
      input: { teach_route_id: entered.teach_route_id, ...waypoint(114.0562), ai_target_types: ['vehicle'] },
    }, url)).toThrow('AI 已开启但没有合法目标类型')
  })

  it('通过 unified invoke 删除航点和路线', async () => {
    const { url, backend } = await startBackend()
    const pluginId = 'official_patrol_teach'
    const entered = backend.invoke({
      pluginId,
      handler: 'h_teach_enterRoute',
      input: { project_id: 'futian', flight_id: 'flight-delete', dock_sn: 'dock-1', drone_sn: 'drone-1' },
    }, url) as { teach_route_id: number }
    const appended = backend.invoke({
      pluginId,
      handler: 'h_teach_appendWaypoint',
      input: { teach_route_id: entered.teach_route_id, ...waypoint(114.0562) },
    }, url) as { id: number }

    expect(backend.invoke({
      pluginId,
      handler: 'h_teach_deleteWaypoint',
      input: { waypoint_id: appended.id },
    }, url)).toEqual({ deleted: true })
    expect(backend.invoke({
      pluginId,
      handler: 'h_teach_deleteRoute',
      input: { teach_route_id: entered.teach_route_id },
    }, url)).toEqual({ deleted: true })
    expect(backend.invoke({
      pluginId,
      handler: 'h_teach_getRouteStatus',
      input: { flight_id: 'flight-delete' },
    }, url)).toEqual({ teach_route: null })
  })
})
