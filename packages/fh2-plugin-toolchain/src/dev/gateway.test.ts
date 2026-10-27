// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { request as createRequest, createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadDeveloperRuntime } from '../developer-runtime/loader.js'
import {
  GatewayConfigurationError,
  createMockGateway,
  createProxyGateway,
  validateGatewayTarget,
} from './gateway.js'
import type { DevGateway } from './gateway.js'
import { BackendRuntimeError } from './backend-runtime.js'
import type { BackendDevRuntime } from './backend-runtime.js'

const servers: Server[] = []
const workerScriptErrors = (loadDeveloperRuntime().resources.files['backend/errors.json'] as {
  readonly script: readonly { readonly code: string; readonly class: 'business' | 'contract' | 'retryable' }[];
}).script

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => closeServer(server)))
})

describe('gateway target validation', () => {
  it.each([
    'https://backend.example.com',
    'https://backend.example.com:8443',
    'http://127.0.0.1:9000',
    'http://localhost:9000',
    'http://[::1]:9000',
  ])('接受固定 origin %s', (target) => {
    expect(validateGatewayTarget(target).origin).toBe(new URL(target).origin)
  })

  it.each([
    'backend.example.com',
    'ftp://backend.example.com',
    'https://user:pass@backend.example.com',
    'https://backend.example.com/path',
    'https://backend.example.com/?query=1',
    'https://backend.example.com/#fragment',
    'http://backend.example.com',
  ])('拒绝非封闭 target %s', (target) => {
    expect(() => validateGatewayTarget(target)).toThrow(GatewayConfigurationError)
  })
})

describe('mock gateway', () => {
  it('把标准 invoke、事件和 reset 路由交给本地后端 Runtime', async () => {
    const backendRuntime = {
      invoke: vi.fn(async () => ({ id: 'issue-1' })),
      dispatchEvent: vi.fn(async () => ({ matched: true })),
      snapshot: vi.fn(() => ({ pluginId: 'exp_demo', version: '0.1.0', entities: { issue: [] } })),
      reset: vi.fn(() => ({ pluginId: 'exp_demo', version: '0.1.0', entities: { issue: [] } })),
      close: vi.fn(),
      reload: vi.fn(),
    }
    const gateway = createMockGateway({ backendRuntime })
    const local = await startGateway(gateway)
    const invoke = await fetch(`${local.url}/plugin-api/plugin/invoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'request-1',
        'x-plugin-token': 'mock-plugin-token',
      },
      body: JSON.stringify({ pluginId: 'exp_demo', handler: 'issue.create', input: { title: '问题' } }),
    })
    expect(await invoke.json()).toEqual({ code: 0, message: 'success', data: { id: 'issue-1' } })
    expect(backendRuntime.invoke).toHaveBeenCalledWith(expect.objectContaining({ handler: 'issue.create' }), 'request-1')

    const event = await fetch(`${local.url}/plugin-api/mock/backend/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'event-1', type: 'media.photo_created', data: {} }),
    })
    expect(await event.json()).toMatchObject({ code: 0, data: { matched: true } })
    expect(backendRuntime.dispatchEvent).toHaveBeenCalledOnce()

    const reset = await fetch(`${local.url}/plugin-api/mock/backend/reset`, { method: 'POST' })
    expect(reset.status).toBe(200)
    await gateway.close()
    expect(backendRuntime.close).toHaveBeenCalledOnce()
  })

  it('已加载的同 ID 后端 Runtime 优先于内置 Teach Mock', async () => {
    const backendRuntime: BackendDevRuntime = {
      invoke: vi.fn(async () => ({ source: 'runtime' })),
      dispatchEvent: vi.fn(),
      snapshot: vi.fn(() => ({ pluginId: 'official_patrol_teach', version: '0.1.0', entities: {} })),
      reset: vi.fn(() => ({ pluginId: 'official_patrol_teach', version: '0.1.0', entities: {} })),
      close: vi.fn(),
      reload: vi.fn(),
    }
    const local = await startGateway(createMockGateway({ backendRuntime }))

    const response = await fetch(`${local.url}/plugin-api/plugin/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plugin-token': 'mock-plugin-token' },
      body: JSON.stringify({ pluginId: 'official_patrol_teach', handler: 'h_teach_enterRoute', input: {} }),
    })

    expect(await response.json()).toEqual({ code: 0, message: 'success', data: { source: 'runtime' } })
    expect(backendRuntime.invoke).toHaveBeenCalledOnce()
  })

  it('多后端 Runtime 未命中时仍可回退到内置 Teach Mock', async () => {
    const backendRuntime: BackendDevRuntime = {
      invoke: vi.fn(async () => {
        throw new BackendRuntimeError('PLUGIN_NOT_FOUND', 'not loaded', 404)
      }),
      dispatchEvent: vi.fn(),
      snapshot: vi.fn(() => ({ pluginId: 'capability', version: 'local', entities: {} })),
      reset: vi.fn(() => ({ pluginId: 'capability', version: 'local', entities: {} })),
      close: vi.fn(),
      reload: vi.fn(),
    }
    const local = await startGateway(createMockGateway({ backendRuntime }))

    const response = await fetch(`${local.url}/plugin-api/plugin/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plugin-token': 'mock-plugin-token' },
      body: JSON.stringify({
        pluginId: 'official_patrol_teach',
        handler: 'h_teach_getRouteStatus',
        input: { flight_id: 'missing' },
      }),
    })

    expect(response.status).toBe(200)
    expect(backendRuntime.invoke).toHaveBeenCalledOnce()
  })

  it.each([
    ...workerScriptErrors.map(({ code, class: classification }) => [
      code,
      code === 'CONFLICT' ? 409 : code === 'NOT_FOUND' ? 404 : code === 'PERMISSION_DENIED' ? 403 : 400,
      { business: 20001, contract: 40006, retryable: 50301 }[classification],
    ] as const),
    ['IDEMPOTENCY_KEY_REQUIRED', 400, 40006],
    ['PLUGIN_NOT_FOUND', 404, 40006],
    ['HANDLER_NOT_FOUND', 404, 40006],
    ['EVENT_HANDLER_NOT_FOUND', 404, 40006],
    ['UNKNOWN_CODE', 400, 50301],
    ['BRIDGE_FAILED', 400, 50301],
    ['RUNTIME_CLOSED', 503, 50301],
    ['BACKEND_DIST_MISSING', 503, 50301],
    ['SCRIPT_EXECUTION_FAILED', 500, 50301],
    ['SCRIPT_RESULT_INVALID', 500, 50301],
  ] as const)('对账已发布 Worker 错误策略及本地错误：%s 数字信封保留 HTTP %s', async (code, status, envelopeCode) => {
    const error = new BackendRuntimeError(code, 'operation failed', status)
    const backendRuntime: BackendDevRuntime = {
      invoke: vi.fn().mockRejectedValue(error),
      dispatchEvent: vi.fn().mockRejectedValue(new BackendRuntimeError(code, `${code}: operation failed`, status)),
      snapshot: vi.fn(),
      reset: vi.fn(),
      close: vi.fn(),
      reload: vi.fn(),
    }
    const gateway = createMockGateway({ backendRuntime })
    const local = await startGateway(gateway)
    try {
      for (const path of ['/plugin-api/plugin/invoke', '/plugin-api/mock/backend/event']) {
        const response = await fetch(`${local.url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-plugin-token': 'mock-plugin-token' },
          body: JSON.stringify({ pluginId: 'exp_demo', handler: 'items.get', type: 'shared.event', input: {} }),
        })
        expect(response.status).toBe(status)
        expect(await response.json()).toEqual({
          code: envelopeCode,
          message: `${code}: operation failed`,
          data: null,
        })
      }
      expect(error.code).toBe(code)
      expect(error.message).toBe('operation failed')
    } finally {
      await gateway.close()
    }
  })

  it('无 Runtime 的未知插件和未分类故障也返回数字信封', async () => {
    const local = await startGateway(createMockGateway())
    const missing = await fetch(`${local.url}/plugin-api/plugin/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plugin-token': 'mock-plugin-token' },
      body: JSON.stringify({ pluginId: 'exp_missing', handler: 'items.get', input: {} }),
    })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 40006, message: expect.stringContaining('PLUGIN_NOT_FOUND') })

    const backendRuntime: BackendDevRuntime = {
      invoke: vi.fn().mockRejectedValue(new Error('unexpected failure')),
      dispatchEvent: vi.fn(),
      snapshot: vi.fn(),
      reset: vi.fn(),
      close: vi.fn(),
      reload: vi.fn(),
    }
    const gateway = createMockGateway({ backendRuntime })
    const failedLocal = await startGateway(gateway)
    try {
      const failed = await fetch(`${failedLocal.url}/plugin-api/plugin/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-plugin-token': 'mock-plugin-token' },
        body: JSON.stringify({ pluginId: 'exp_demo', handler: 'items.get', input: {} }),
      })
      expect(failed.status).toBe(500)
      expect(await failed.json()).toEqual({ code: 50301, message: 'BACKEND_RUNTIME_FAILED: unexpected failure', data: null })
    } finally {
      await gateway.close()
    }
  })

  it.each([
    ['event', 'GET', 'POST'],
    ['state', 'POST', 'GET'],
    ['reset', 'GET', 'POST'],
  ] as const)('backend/%s 的错误方法保留 405 并使用数字码', async (endpoint, method, allowedMethod) => {
    const backendRuntime: BackendDevRuntime = {
      invoke: vi.fn(),
      dispatchEvent: vi.fn(),
      snapshot: vi.fn(),
      reset: vi.fn(),
      close: vi.fn(),
      reload: vi.fn(),
    }
    const gateway = createMockGateway({ backendRuntime })
    const local = await startGateway(gateway)
    try {
      const response = await fetch(`${local.url}/plugin-api/mock/backend/${endpoint}`, { method })
      expect(response.status).toBe(405)
      expect(await response.json()).toEqual({ code: 40501, message: `METHOD_NOT_ALLOWED: 只允许 ${allowedMethod}。`, data: null })
      expect(backendRuntime.dispatchEvent).not.toHaveBeenCalled()
      expect(backendRuntime.snapshot).not.toHaveBeenCalled()
      expect(backendRuntime.reset).not.toHaveBeenCalled()
    } finally {
      await gateway.close()
    }
  })

  it('内置 Teach Mock 已有数字错误信封保持不变', async () => {
    const local = await startGateway(createMockGateway())
    const response = await fetch(`${local.url}/plugin-api/plugin/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plugin-token': 'mock-plugin-token' },
      body: JSON.stringify({ pluginId: 'official_patrol_teach', handler: 'h_teach_appendWaypoint', input: { teach_route_id: 9999 } }),
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ code: 40401, message: '路线不存在', data: null })
  })

  it('严格校验 Token issue，并给未知 API 标准 JSON 404', async () => {
    const local = await startGateway(createMockGateway())
    for (const path of [
      '/plugin-gateway/token/issue',
      '/plugin-gateway/token/issue?svc=manage&svc=manage',
      '/plugin-gateway/token/issue?svc=manage&extra=1',
      '/plugin-gateway/token/issue?svc=other',
    ]) {
      expect((await fetch(`${local.url}${path}`, { method: 'POST', body: '{}' })).status).toBe(400)
    }
    expect((await fetch(`${local.url}/plugin-gateway/token/issue?svc=manage`)).status).toBe(400)

    const issued = await fetch(`${local.url}/plugin-gateway/token/issue?svc=manage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login_token: 'mock-login-token' }),
    })
    expect(issued.status).toBe(200)
    expect(await issued.json()).toMatchObject({ code: 0, data: { token: 'mock-plugin-token' } })

    const unknown = await fetch(`${local.url}/plugin-api/unknown`)
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ code: 40400, msg: 'Not Found', data: null })
    expect(unknown.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('通过 official_patrol_teach unified invoke 完成完整录制流程', async () => {
    const local = await startGateway(createMockGateway())
    const headers = { 'content-type': 'application/json', 'x-plugin-token': 'mock-plugin-token' }
    const invoke = async (handler: string, input: Record<string, unknown>): Promise<Response> => fetch(`${local.url}/plugin-api/plugin/invoke`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ pluginId: 'official_patrol_teach', handler, input }),
    })
    const unauthorized = await fetch(`${local.url}/plugin-api/plugin/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginId: 'official_patrol_teach', handler: 'h_teach_getRouteStatus', input: {} }),
    })
    expect(unauthorized.status).toBe(401)

    const entered = await invoke('h_teach_enterRoute', {
      project_id: 'mock-project',
      flight_id: 'flight-sts',
      dock_sn: 'dock-1',
      drone_sn: 'drone-1',
    })
    const routeId = (await entered.json() as { data: { teach_route_id: number } }).data.teach_route_id
    expect(await (await invoke('h_teach_getRouteStatus', { flight_id: 'flight-sts' })).json()).toMatchObject({
      code: 0,
      data: { teach_route: { id: routeId, project_id: 'mock-project', status: 'recording' } },
    })
    const waypointIds: number[] = []
    for (const longitude of [114.05, 114.06, 114.07]) {
      const response = await invoke('h_teach_appendWaypoint', {
        teach_route_id: routeId,
        latitude: 22.53,
        longitude,
        height: 100,
        gimbal_pitch: -30,
        camera_yaw: 0,
        focal_length: 24,
        ai_recognition_on: false,
        ai_target_types: [],
      })
      waypointIds.push((await response.json() as { data: { id: number } }).data.id)
    }
    expect((await invoke('h_teach_updateWaypoint', {
      waypoint_id: waypointIds[2],
      focal_length: 35,
      selected: false,
    })).status).toBe(200)
    expect((await invoke('h_teach_deleteWaypoint', { waypoint_id: waypointIds[2] })).status).toBe(200)
    const stsResponse = await invoke('h_teach_createScreenshotSTS', {
      teach_route_id: routeId,
      waypoint_id: waypointIds[0],
    })
    const sts = (await stsResponse.json() as { data: { endpoint: string; bucket: string; object_key: string } }).data
    const upload = await fetch(`${sts.endpoint}/${sts.bucket}/${sts.object_key}`, { method: 'PUT', body: 'frame' })
    expect(upload.status).toBe(200)
    expect((await invoke('h_teach_attachScreenshot', {
      waypoint_id: waypointIds[0],
      object_key: sts.object_key,
      bytes: 5,
    })).status).toBe(200)
    const generated = await invoke('h_teach_generateWayline', {
      teach_route_id: routeId,
      name: 'Unified invoke 航线',
      global_speed: 15,
      waypoint_speed: 5,
    })
    expect(await generated.json()).toMatchObject({ code: 0, data: { waypoint_count: 2 } })
    expect(await (await invoke('h_teach_getRouteStatus', { flight_id: 'flight-sts' })).json())
      .toEqual({ code: 0, message: 'success', data: { teach_route: null } })
    expect((await invoke('h_teach_deleteRoute', { teach_route_id: routeId })).status).toBe(200)
  })

  it('为事故快处纵切提供事件、设备、工作流状态和信号响应', async () => {
    const local = await startGateway(createMockGateway())
    const headers = { 'x-plugin-token': 'mock-plugin-token' }
    const devices = await fetch(
      `${local.url}/plugin-api/manage/api/v1/projects/mock-project/topologies`,
      { headers },
    )
    expect(await devices.json()).toMatchObject({
      code: 0,
      data: { list: [{ airport: { device_sn: 'dock-001' } }] },
    })

    const events = await fetch(
      `${local.url}/plugin-api/plugin-scene/data-store/events/query`,
      { method: 'POST', headers, body: '{}' },
    )
    expect(await events.json()).toMatchObject({
      code: 0,
      data: {
        list: expect.arrayContaining([
          expect.objectContaining({ eventId: 'mock-list-incident-001', status: 'unacknowledged' }),
          expect.objectContaining({ eventId: 'mock-list-incident-002', status: 'completed' }),
          expect.objectContaining({ eventId: 'mock-list-incident-003', status: 'acknowledged' }),
        ]),
      },
    })

    const event = await fetch(
      `${local.url}/plugin-api/plugin-scene/data-store/events/mock-list-incident-002?tenantId=ignored`,
      { headers },
    )
    expect(await event.json()).toMatchObject({
      code: 0,
      data: {
        eventId: 'mock-list-incident-002',
        status: 'completed',
        rawPayload: { id: 'MOCKP-000016' },
        result: { dispatched: true },
      },
    })

    const missingEvent = await fetch(
      `${local.url}/plugin-api/plugin-scene/data-store/events/missing-event`,
      { headers },
    )
    expect(missingEvent.status).toBe(404)
    expect(await missingEvent.json()).toEqual({
      code: 40401,
      msg: 'event not found: missing-event',
      data: null,
    })

    const status = await fetch(
      `${local.url}/plugin-api/flows/accident-response-cascade-test/incidents/mock-list-incident-001/status`,
      { headers },
    )
    expect(await status.json()).toMatchObject({
      code: 0,
      data: { currentStep: 'ack', awaitingSignal: 'acknowledge' },
    })

    for (const signal of [
      'route_selected',
    ]) {
      const response = await fetch(
        `${local.url}/plugin-api/flows/accident-response-cascade-test/incidents/mock-list-incident-001/signals/${signal}`,
        { method: 'POST', headers, body: JSON.stringify({ payload: {} }) },
      )
      expect(await response.json()).toEqual({ code: 0, msg: 'Success', data: { ok: '1' } })
    }

    // 签收与忽略信号联动 mock 状态，活动查询按 status 白名单过滤。
    await fetch(
      `${local.url}/plugin-api/flows/accident-response-cascade-test/incidents/mock-list-incident-001/signals/acknowledge`,
      { method: 'POST', headers, body: JSON.stringify({ payload: {} }) },
    )
    const statusAfterAck = await fetch(
      `${local.url}/plugin-api/flows/accident-response-cascade-test/incidents/mock-list-incident-001/status`,
      { headers },
    )
    expect(await statusAfterAck.json()).toMatchObject({
      code: 0,
      data: { currentStep: 'pick', awaitingSignal: 'route_selected' },
    })
    const activeAfterAck = await fetch(`${local.url}/plugin-api/plugin-scene/data-store/events/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ status: ['unacknowledged', 'acknowledged', 'handling'] }),
    })
    expect(await activeAfterAck.json()).toMatchObject({
      code: 0,
      data: {
        list: expect.arrayContaining([
          expect.objectContaining({ eventId: 'mock-list-incident-001', status: 'acknowledged' }),
          expect.objectContaining({ eventId: 'mock-list-incident-003', status: 'acknowledged' }),
        ]),
      },
    })

    await fetch(
      `${local.url}/plugin-api/flows/accident-response-cascade-test/incidents/mock-list-incident-001/signals/ignore`,
      { method: 'POST', headers, body: JSON.stringify({ payload: {} }) },
    )
    const activeAfterIgnore = await fetch(`${local.url}/plugin-api/plugin-scene/data-store/events/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ status: ['unacknowledged', 'acknowledged', 'handling'] }),
    })
    expect(await activeAfterIgnore.json()).toMatchObject({
      code: 0,
      data: {
        list: expect.arrayContaining([
          expect.objectContaining({ eventId: 'mock-list-incident-003', status: 'acknowledged' }),
        ]),
      },
    })
  })

  it('警情 update 有状态保存并回显到 query', async () => {
    const local = await startGateway(createMockGateway())
    const headers = { 'x-plugin-token': 'mock-plugin-token' }

    const update = await fetch(`${local.url}/plugin-api/plugin-scene/data-store/events/update`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        eventId: 'mock-list-incident-001',
        rawPayload: {
          id: 'MOCKP-000017',
          lat: '22.5405',
          lng: 114.0579,
          addr: '深圳市福田区深南大道',
          correction_note: '数据补录：警官王小明二次核对后修正',
        },
      }),
    })
    expect(await update.json()).toMatchObject({ code: 0, data: { updated: true } })

    const query = await fetch(`${local.url}/plugin-api/plugin-scene/data-store/events/query`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    const body = await query.json() as {
      data: { list: Array<{ eventId: string; status: string; rawPayload: Record<string, unknown> }> };
    }
    expect(body.data.list).toHaveLength(3)
    expect(body.data.list.find(event => event.eventId === 'mock-list-incident-001')?.rawPayload)
      .toMatchObject({ correction_note: '数据补录：警官王小明二次核对后修正' })
    expect(body.data.list.find(event => event.eventId === 'mock-list-incident-001')?.status).toBe('unacknowledged')
    expect(body.data.list.find(event => event.eventId === 'mock-list-incident-002')?.rawPayload)
      .toMatchObject({ correction_note: '数据补录：警官王小明二次核对后修正' })

    const unknownEvent = await fetch(`${local.url}/plugin-api/plugin-scene/data-store/events/update`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ eventId: 'missing-id', rawPayload: {} }),
    })
    expect(unknownEvent.status).toBe(400)
    expect(await unknownEvent.json()).toMatchObject({ code: 40001 })

    const missingEventId = await fetch(`${local.url}/plugin-api/plugin-scene/data-store/events/update`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ rawPayload: {} }),
    })
    expect(missingEventId.status).toBe(400)
  })

  it('为事故快处纵切提供路线规划与航线入库响应', async () => {
    const local = await startGateway(createMockGateway())
    const headers = { 'x-plugin-token': 'mock-plugin-token' }

    const plan = await fetch(`${local.url}/plugin-api/plugin-scene/route-planning/plan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workspace_id: 'mock-project',
        start_lat: 22.545,
        start_lng: 114.050,
        end_lat: 22.5405,
        end_lng: 114.0579,
        height: 120,
      }),
    })
    expect(await plan.json()).toMatchObject({
      code: 0,
      data: {
        routes: [
          { wpmz_key: 'wayline/mock-project/route-main.kmz', wpmz_url: 'http://mock.local/wayline/route-main.kmz' },
          { wpmz_key: 'wayline/mock-project/route-alt.kmz', wpmz_url: '' },
        ],
      },
    })

    const missingStart = await fetch(`${local.url}/plugin-api/plugin-scene/route-planning/plan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspace_id: 'mock-project', end_lat: 22.5405, end_lng: 114.0579 }),
    })
    expect(missingStart.status).toBe(400)
    expect(await missingStart.json()).toMatchObject({ code: 40001 })

    const invalidBody = await fetch(`${local.url}/plugin-api/plugin-scene/route-planning/plan`, {
      method: 'POST',
      headers,
      body: 'not-json',
    })
    expect(invalidBody.status).toBe(400)

    const register = await fetch(`${local.url}/plugin-api/plugin-scene/route-planning/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workspace_id: 'mock-project',
        wpmz_key: 'wayline/mock-project/route-alt.kmz',
        name: '事故快处-测试警情-120000',
      }),
    })
    expect(await register.json()).toMatchObject({
      code: 0,
      data: {
        wayline_uuid: 'mock-wayline-route-alt',
        key: 'wayline/mock-project/route-alt.kmz',
        name: '事故快处-测试警情-120000',
      },
    })

    const missingName = await fetch(`${local.url}/plugin-api/plugin-scene/route-planning/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspace_id: 'mock-project', wpmz_key: 'wayline/mock-project/route-alt.kmz' }),
    })
    expect(missingName.status).toBe(400)
    expect(await missingName.json()).toMatchObject({ code: 40001 })

    const invalidMethod = await fetch(`${local.url}/plugin-api/plugin-scene/route-planning/plan`, { headers })
    expect(invalidMethod.status).toBe(400)
  })

  it('通过 Mock 控制端点切换事故状态与路线规划业务错误', async () => {
    const local = await startGateway(createMockGateway())
    const pluginHeaders = { 'x-plugin-token': 'mock-plugin-token', 'content-type': 'application/json' }
    const mockHeaders = { 'content-type': 'application/json' }

    const status = await fetch(`${local.url}/plugin-api/mock/accident/event-status`, {
      method: 'POST',
      headers: mockHeaders,
      body: JSON.stringify({ eventId: 'mock-list-incident-002', status: 'terminated' }),
    })
    expect(await status.json()).toMatchObject({ code: 0, data: { status: 'terminated' } })
    const event = await fetch(
      `${local.url}/plugin-api/plugin-scene/data-store/events/mock-list-incident-002`,
      { headers: pluginHeaders },
    )
    expect(await event.json()).toMatchObject({ data: { status: 'terminated' } })

    for (const code of [11001, 11002] as const) {
      await fetch(`${local.url}/plugin-api/mock/accident/route-plan-code`, {
        method: 'POST',
        headers: mockHeaders,
        body: JSON.stringify({ code }),
      })
      const plan = await fetch(`${local.url}/plugin-api/plugin-scene/route-planning/plan`, {
        method: 'POST',
        headers: pluginHeaders,
        body: JSON.stringify({ start_lat: 1, start_lng: 2, end_lat: 3, end_lng: 4 }),
      })
      expect(await plan.json()).toMatchObject({ code })
    }

    const invalid = await fetch(`${local.url}/plugin-api/mock/accident/route-plan-code`, {
      method: 'POST',
      headers: mockHeaders,
      body: JSON.stringify({ code: 999 }),
    })
    expect(invalid.status).toBe(400)
  })
})

describe('proxy gateway', () => {
  it('token issue 参数非法时不产生上游请求', async () => {
    const requests = vi.fn()
    const backend = await startBackend(async (_req, res) => {
      requests()
      res.end('{}')
    })
    const local = await startGateway(createProxyGateway({ target: backend.url, loginToken: 'login' }))
    const response = await fetch(`${local.url}/plugin-gateway/token/issue?svc=manage&extra=1`, {
      method: 'POST',
      body: '{}',
    })
    expect(response.status).toBe(400)
    expect(requests).not.toHaveBeenCalled()
  })

  it('服务端重写登录 Token，并过滤双向敏感 Header', async () => {
    let received: CapturedRequest | undefined
    const backend = await startBackend(async (req, res) => {
      received = await captureRequest(req)
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'trace-response',
        'set-cookie': 'session=secret',
        location: 'https://secret.example.com',
        'www-authenticate': 'Bearer',
        'access-control-allow-origin': '*',
        connection: 'keep-alive',
      })
      res.end('{"code":0,"msg":"Success","data":{"token":"plugin"}}')
    })
    const gateway = createProxyGateway({ target: backend.url, loginToken: 'server-login-secret' })
    const local = await startGateway(gateway)

    const response = await fetch(`${local.url}/plugin-gateway/token/issue?svc=manage`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'browser=session',
        authorization: 'Bearer browser',
        'x-user-token': 'browser-user',
        'x-auth-token': 'browser-auth',
        'x-request-id': 'trace-request',
      },
      body: JSON.stringify({ login_token: 'browser-token' }),
    })
    expect(response.status).toBe(200)
    expect(received?.body).toBe('{"login_token":"server-login-secret"}')
    expect(received?.headers.cookie).toBeUndefined()
    expect(received?.headers.authorization).toBeUndefined()
    expect(received?.headers['x-user-token']).toBeUndefined()
    expect(received?.headers['x-auth-token']).toBeUndefined()
    expect(received?.headers['accept-encoding']).toBe('identity')
    expect(received?.headers['content-type']).toBe('application/json')
    expect(received?.headers['x-request-id']).toBe('trace-request')
    expect(response.headers.get('x-request-id')).toBe('trace-response')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('www-authenticate')).toBeNull()
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(await response.text()).not.toContain('server-login-secret')
  })

  it.each([
    ['json', (secret: string) => JSON.stringify({
      code: 1,
      msg: secret,
      data: { nested: [secret], embedded: `reflected:${secret}` },
    })],
    ['raw', (secret: string) => `upstream reflected ${secret} in invalid JSON`],
  ] as const)('token issue %s 响应不会向浏览器反射登录 Token', async (_format, responseBody) => {
    const loginToken = 'server-login-secret'
    const backend = await startBackend(async (_req, res) => {
      res.writeHead(401, {
        'content-type': `application/json; reflected=${loginToken}`,
        'x-request-id': loginToken,
        'x-trace-id': `trace-${loginToken}`,
      })
      res.end(responseBody(loginToken))
    })
    const local = await startGateway(createProxyGateway({ target: backend.url, loginToken }))
    const response = await fetch(`${local.url}/plugin-gateway/token/issue?svc=manage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const browserBody = await response.text()
    expect(response.status).toBe(401)
    expect(browserBody).not.toContain(loginToken)
    expect(browserBody).toContain('[REDACTED]')
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(browserBody)))
    expect(response.headers.get('content-type')).toBeNull()
    expect(response.headers.get('x-request-id')).toBeNull()
    expect(response.headers.get('x-trace-id')).toBeNull()
  })

  it('登录 Token 含 JSON 转义字符时仍从嵌入字符串中删除', async () => {
    const loginToken = 'server-"login\\secret'
    const backend = await startBackend(async (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ msg: `prefix:${loginToken}:suffix`, data: [loginToken] }))
    })
    const local = await startGateway(createProxyGateway({ target: backend.url, loginToken }))
    const response = await fetch(`${local.url}/plugin-gateway/token/issue?svc=manage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const browserBody = await response.text()
    expect(JSON.stringify(JSON.parse(browserBody))).not.toContain(loginToken)
    expect(browserBody).toContain('[REDACTED]')
  })

  it('不读取 body 的 Mock/Proxy 拒绝会返回响应并关闭慢速 chunked connection', async () => {
    const mockGateway = createMockGateway()
    const mockLocal = await startGateway(mockGateway)
    const mockRequest = openSlowRequest(`${mockLocal.url}/plugin-gateway/token/issue?svc=invalid`)
    mockRequest.request.write('{"partial":')
    expect((await expectWithin(mockRequest.response.promise, 1_000, 'mock rejection response missing')).status).toBe(400)
    await expectWithin(mockRequest.closed.promise, 1_000, 'mock rejected connection remained open')
    await expectWithin(mockGateway.close(), 1_000, 'mock gateway close hung after rejection')

    const upstreamRequests = vi.fn()
    const backend = await startBackend(async (_req, res) => {
      upstreamRequests()
      res.end('{}')
    })
    const proxyGateway = createProxyGateway({ target: backend.url, loginToken: 'login' })
    const proxyLocal = await startGateway(proxyGateway)
    const proxyRequest = openSlowRequest(`${proxyLocal.url}/plugin-api/rejected`, { method: 'OPTIONS' })
    proxyRequest.request.write('{"partial":')
    expect((await expectWithin(proxyRequest.response.promise, 1_000, 'proxy rejection response missing')).status).toBe(400)
    await expectWithin(proxyRequest.closed.promise, 1_000, 'proxy rejected connection remained open')
    await expectWithin(proxyGateway.close(), 1_000, 'proxy gateway close hung after rejection')
    expect(upstreamRequests).not.toHaveBeenCalled()
  })

  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])('保留 %s 的 path、query、插件 Token 和 JSON body', async (method) => {
    let received: CapturedRequest | undefined
    const backend = await startBackend(async (req, res) => {
      received = await captureRequest(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"code":0,"msg":"Success","data":{}}')
    })
    const local = await startGateway(createProxyGateway({ target: backend.url, loginToken: 'login' }))
    const body = method === 'GET' ? undefined : JSON.stringify({ method })
    const response = await fetch(`${local.url}/plugin-api/dev/items?mode=full`, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-plugin-token': 'plugin-token',
      },
      ...(body === undefined ? {} : { body }),
    })
    expect(response.status).toBe(200)
    expect(received?.method).toBe(method)
    expect(received?.url).toBe('/plugin-api/dev/items?mode=full')
    expect(received?.headers['x-plugin-token']).toBe('plugin-token')
    expect(received?.body).toBe(body ?? '')
  })

  it('把上游 redirect 转成无 Location 的 502', async () => {
    const backend = await startBackend(async (_req, res) => {
      res.writeHead(302, { location: 'https://secret.example.com/path' })
      res.end()
    })
    const local = await startGateway(createProxyGateway({ target: backend.url, loginToken: 'login' }))
    const response = await fetch(`${local.url}/plugin-api/redirect`)
    expect(response.status).toBe(502)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.json()).toMatchObject({ code: 50200 })
  })

  it('请求超限时不连接上游，响应超限时返回脱敏 502', async () => {
    const requests = vi.fn()
    const backend = await startBackend(async (_req, res) => {
      requests()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: 'response-too-large' }))
    })
    const local = await startGateway(createProxyGateway({
      target: backend.url,
      loginToken: 'login',
      requestBodyLimitBytes: 8,
      responseBodyLimitBytes: 8,
    }))
    const oversizedRequest = await fetch(`${local.url}/plugin-api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'request-too-large' }),
    })
    expect(oversizedRequest.status).toBe(413)
    expect(requests).not.toHaveBeenCalled()

    const oversizedResponse = await fetch(`${local.url}/plugin-api/items`)
    expect(oversizedResponse.status).toBe(502)
    expect(await oversizedResponse.text()).not.toContain('response-too-large')
    expect(requests).toHaveBeenCalledOnce()
  })

  it('总超时返回固定 502，close 中止在途上游并缓存完成 Promise', async () => {
    const backend = await startBackend(async (_req, res) => {
      await new Promise(resolve => setTimeout(resolve, 100))
      if (!res.destroyed) res.end('{"code":0}')
    })
    const timeoutGateway = createProxyGateway({ target: backend.url, loginToken: 'login', timeoutMs: 20 })
    const timeoutLocal = await startGateway(timeoutGateway)
    const timeoutResponse = await fetch(`${timeoutLocal.url}/plugin-api/slow`)
    expect(timeoutResponse.status).toBe(502)
    expect(await timeoutResponse.json()).toEqual({ code: 50200, msg: 'Gateway upstream timeout', data: null })

    const closingGateway = createProxyGateway({ target: backend.url, loginToken: 'login' })
    const closingLocal = await startGateway(closingGateway)
    const request = fetch(`${closingLocal.url}/plugin-api/slow`).catch(error => error)
    await new Promise(resolve => setTimeout(resolve, 10))
    const first = closingGateway.close()
    const second = closingGateway.close()
    expect(first).toBe(second)
    await first
    await request
  })

  it('总超时中止慢速 chunked request body，不连接上游', async () => {
    const upstreamRequests = vi.fn()
    const backend = await startBackend(async (_req, res) => {
      upstreamRequests()
      res.end('{}')
    })
    const gateway = createProxyGateway({ target: backend.url, loginToken: 'login', timeoutMs: 30 })
    const local = await startGateway(gateway)
    const slowRequest = openSlowRequest(`${local.url}/plugin-api/slow-upload`)
    slowRequest.request.write('{"partial":')
    await expectWithin(slowRequest.closed.promise, 1_000, 'slow request was not closed on timeout')
    expect(upstreamRequests).not.toHaveBeenCalled()
    await gateway.close()
  })

  it('close 中止慢速 chunked request body，且 active request 不阻塞关闭', async () => {
    const upstreamRequests = vi.fn()
    const backend = await startBackend(async (_req, res) => {
      upstreamRequests()
      res.end('{}')
    })
    const gateway = createProxyGateway({ target: backend.url, loginToken: 'login', timeoutMs: 10_000 })
    const local = await startGateway(gateway)
    const slowRequest = openSlowRequest(`${local.url}/plugin-api/slow-upload`)
    slowRequest.request.write('{"partial":')
    await new Promise(resolve => setTimeout(resolve, 10))
    const first = gateway.close()
    const second = gateway.close()
    expect(first).toBe(second)
    await expectWithin(first, 1_000, 'gateway.close was blocked by slow request body')
    await expectWithin(slowRequest.closed.promise, 1_000, 'slow request was not closed on shutdown')
    expect(upstreamRequests).not.toHaveBeenCalled()
  })

  it('下游断开时 abort 在途上游请求', async () => {
    const upstreamStarted = deferred<void>()
    const upstreamAborted = deferred<void>()
    const backend = await startBackend(async (req) => {
      upstreamStarted.resolve()
      req.once('aborted', () => upstreamAborted.resolve())
    })
    const local = await startGateway(createProxyGateway({ target: backend.url, loginToken: 'login' }))
    const downstream = createRequest(`${local.url}/plugin-api/slow`)
    downstream.on('error', () => {})
    downstream.end()
    await upstreamStarted.promise
    downstream.destroy()
    await Promise.race([
      upstreamAborted.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('upstream was not aborted')), 1_000)),
    ])
  })
})

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

async function captureRequest (req: IncomingMessage): Promise<CapturedRequest> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return {
    method: req.method ?? '',
    url: req.url ?? '',
    headers: req.headers,
    body: Buffer.concat(chunks).toString('utf8'),
  }
}

async function startBackend (
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string }> {
  const server = createServer((req, res) => void handler(req, res))
  return listen(server)
}

async function startGateway (gateway: DevGateway): Promise<{ url: string }> {
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://local.test')
    void gateway.handle(req, res, requestUrl).then((handled) => {
      if (!handled && !res.writableEnded) {
        res.writeHead(404)
        res.end()
      }
    })
  })
  return listen(server)
}

async function listen (server: Server): Promise<{ url: string }> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server address missing')
  return { url: `http://127.0.0.1:${address.port}` }
}

async function closeServer (server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>(resolve => server.close(() => resolve()))
}

function openSlowRequest (url: string, options: { readonly method?: string } = {}): {
  readonly request: ReturnType<typeof createRequest>;
  readonly closed: ReturnType<typeof deferred<void>>;
  readonly response: ReturnType<typeof deferred<{ readonly status: number; readonly body: string }>>;
} {
  const closed = deferred<void>()
  const response = deferred<{ readonly status: number; readonly body: string }>()
  const request = createRequest(url, {
    method: options.method ?? 'POST',
    headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
  }, (incoming) => {
    const chunks: Buffer[] = []
    incoming.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    incoming.once('end', () => response.resolve({
      status: incoming.statusCode ?? 0,
      body: Buffer.concat(chunks).toString('utf8'),
    }))
  })
  request.on('error', () => {})
  request.once('close', () => closed.resolve())
  return { request, closed, response }
}

async function expectWithin<T> (promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
  ])
}

function deferred<T> (): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

describe('mock survey protocol', () => {
  it('每次跳过冷却 1 分钟，第二次冷却结束进入强制态', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const local = await startGateway(createMockGateway())
      const base = `${local.url}/plugin-api/plugin-manager/api/v1/frontend/survey`
      const call = async (action: 'status' | 'skip') => {
        const response = await fetch(action === 'status' ? `${base}/status?projectUuid=a` : `${base}/skip`, {
          method: action === 'status' ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json', 'x-plugin-token': 'mock-plugin-token' },
          ...(action === 'skip' ? { body: JSON.stringify({ projectUuid: 'a' }) } : {}),
        })
        return await response.json()
      }
      for (const skipCount of [1, 2]) {
        const skippedAt = Date.now()
        expect(await call('skip')).toMatchObject({ data: { skipCount, nextPopupAt: new Date(skippedAt + 60_000).toISOString() } })
        clock.mockReturnValue(skippedAt + 59_999)
        expect(await call('status')).toMatchObject({ data: { shouldPopup: false, popupReason: 'cooldown' } })
        clock.mockReturnValue(skippedAt + 60_000)
        expect(await call('status')).toMatchObject({ data: { shouldPopup: true, skipRemaining: 2 - skipCount } })
      }
    } finally {
      clock.mockRestore()
    }
  })

  it('project isolation, formal fields, skip and verify business errors', async () => {
    const local = await startGateway(createMockGateway())
    const base = `${local.url}/plugin-api/plugin-manager/api/v1/frontend/survey`
    const call = async (action: string, project = 'a', code?: string) => {
      const response = await fetch(action === 'status' ? `${base}/status?projectUuid=${project}` : `${base}/${action}`, {
        method: action === 'status' ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-plugin-token': 'mock-plugin-token' },
        ...(action === 'status' ? {} : { body: JSON.stringify({ projectUuid: project, ...(code === undefined ? {} : { code }) }) }),
      })
      return await response.json()
    }
    expect(await call('status')).toMatchObject({ code: 0, message: 'success', data: { shouldPopup: true, skipRemaining: 2, verified: false } })
    expect(await call('prepare')).toMatchObject({ data: { qrUrl: expect.stringContaining('https://survey.example.com/'), airportTotal: 0 } })
    expect(await call('verify', 'a', '999999')).toMatchObject({ code: 221019 })
    expect(await call('skip')).toMatchObject({ data: { skipCount: 1, skipRemaining: 1, nextPopupAt: expect.any(String) } })
    await call('skip')
    expect(await call('skip')).toMatchObject({ code: 221018 })
    expect(await call('verify', 'a', '012345')).toMatchObject({ data: { verified: true, verifiedAt: expect.any(String) } })
    expect(await call('status')).toMatchObject({ data: { shouldPopup: false, verified: true } })
    expect(await call('status', 'b')).toMatchObject({ data: { shouldPopup: true, skipRemaining: 2, verified: false } })
    expect(await call('status', '')).toMatchObject({ code: 221016 })
  })
})
