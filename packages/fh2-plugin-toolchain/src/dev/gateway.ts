// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { closeRequestAfterResponse } from './http-lifecycle.js'
import { TrafficMockBackend } from './traffic-mock.js'
import { TeachMockBackend, TeachMockError } from './teach-mock.js'
import { BackendRuntimeError } from './backend-runtime.js'
import type { BackendDevRuntime, BackendEventRequest, BackendInvokeRequest } from './backend-runtime.js'

export const PROXY_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024
export const PROXY_RESPONSE_BODY_LIMIT_BYTES = 5 * 1024 * 1024
export const PROXY_TOTAL_TIMEOUT_MS = 15_000

const MOCK_LOGIN_TOKEN = 'mock-login-token'
/** 仅用于本地模拟网关；诊断输出与鉴权消费同一值，不是生产凭据。 */
export const MOCK_PLUGIN_TOKEN = 'mock-plugin-token'
const TOKEN_PATH = '/plugin-gateway/token/issue'
const API_PREFIX = '/plugin-api/'
const TRACE_HEADERS = ['x-request-id', 'x-trace-id'] as const
const API_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/** 调研弹窗 Mock 端点前缀（Engine 网关客户端会拼 /plugin-api 前缀）。 */
const SURVEY_API_BASE = '/plugin-api/plugin-manager/api/v1/frontend/survey'
const SURVEY_RESET_PATH = '/plugin-api/mock/survey/reset'
/** Mock 有效验证码：6 位数字，人工纵切使用 012345。 */
const SURVEY_MOCK_VERIFY_CODE = '012345'

export type GatewayApiMode = 'mock' | 'proxy'

export interface DevGateway {
  readonly apiMode: GatewayApiMode;
  handle(req: IncomingMessage, res: ServerResponse, requestUrl: URL): Promise<boolean>;
  close(): Promise<void>;
}

export interface ProxyGatewayOptions {
  readonly target: string | URL;
  readonly loginToken: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly requestBodyLimitBytes?: number;
  readonly responseBodyLimitBytes?: number;
}

export interface MockGatewayOptions {
  readonly backendRuntime?: BackendDevRuntime;
}

export class GatewayConfigurationError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'GatewayConfigurationError'
  }
}

export function validateGatewayTarget (input: string | URL): URL {
  let target: URL
  try {
    target = input instanceof URL ? new URL(input.href) : new URL(input)
  } catch {
    throw new GatewayConfigurationError('Gateway target 必须是绝对 HTTP(S) origin。')
  }
  if ((target.protocol !== 'http:' && target.protocol !== 'https:')
    || target.username !== ''
    || target.password !== ''
    || target.pathname !== '/'
    || target.search !== ''
    || target.hash !== '') {
    throw new GatewayConfigurationError('Gateway target 必须是无凭据、路径、查询和片段的 HTTP(S) origin。')
  }
  if (!isLoopbackHostname(target.hostname) && target.protocol !== 'https:') {
    throw new GatewayConfigurationError('非 loopback Gateway target 必须使用 HTTPS。')
  }
  return target
}

export function createMockGateway (options: MockGatewayOptions = {}): DevGateway {
  const activeRequests = new Set<Promise<void>>()
  const activeControllers = new Set<AbortController>()
  const trafficBackend = new TrafficMockBackend()
  const teachBackend = new TeachMockBackend()
  const accidentStore = createAccidentEventStore()
  let accidentRoutePlanCode: 0 | 11001 | 11002 = 0
  const surveyStore = createSurveyMockStore()
  let closing = false
  let closePromise: Promise<void> | undefined

  const handleToken = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const controller = new AbortController()
    activeControllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), PROXY_TOTAL_TIMEOUT_MS)
    const abortDownstream = (): void => controller.abort()
    req.once('aborted', abortDownstream)
    res.once('close', abortDownstream)
    try {
      const body = await readJsonRequest(req, PROXY_REQUEST_BODY_LIMIT_BYTES, controller.signal) as { login_token?: unknown }
      if (body?.login_token !== MOCK_LOGIN_TOKEN) {
        sendJson(res, 401, gatewayEnvelope(10001, 'Invalid login token'))
        return
      }
      sendJson(res, 200, {
        code: 0,
        msg: 'Success',
        data: { token: MOCK_PLUGIN_TOKEN, expires_at: '2099-01-01T00:00:00Z' },
      })
    } catch (error) {
      if (!closing && !res.destroyed) sendRequestError(res, error)
    } finally {
      clearTimeout(timeout)
      req.off('aborted', abortDownstream)
      res.off('close', abortDownstream)
      activeControllers.delete(controller)
    }
  }

  return {
    apiMode: 'mock',
    async handle (req, res, requestUrl) {
      if (closing && (requestUrl.pathname === TOKEN_PATH || requestUrl.pathname.startsWith(API_PREFIX))) {
        sendEarlyJson(req, res, 503, gatewayEnvelope(50300, 'Gateway is shutting down'))
        return true
      }
      if (requestUrl.pathname === TOKEN_PATH) {
        if (!isStrictTokenRequest(req, requestUrl)) {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40000, 'Invalid parameter'))
          return true
        }
        const request = handleToken(req, res)
        activeRequests.add(request)
        try {
          await request
        } finally {
          activeRequests.delete(request)
        }
        return true
      }

      if (requestUrl.pathname === '/plugin-api/plugin/invoke') {
        if (req.method !== 'POST' || req.headers['x-plugin-token'] !== MOCK_PLUGIN_TOKEN) {
          sendEarlyJson(req, res, 401, gatewayEnvelope(10005, 'Invalid plugin token'))
          return true
        }
        const request = (async (): Promise<void> => {
          const body = await readMockJsonBody(req, res)
          if (body === undefined) return
          try {
            const backendRuntime = options.backendRuntime
            if (backendRuntime !== undefined) {
              try {
                const data = await backendRuntime.invoke(body as unknown as BackendInvokeRequest, singleHeader(req.headers['idempotency-key']) ?? '')
                sendEarlyJson(req, res, 200, { code: 0, message: 'success', data })
                return
              } catch (error) {
                if (!(error instanceof BackendRuntimeError && error.code === 'PLUGIN_NOT_FOUND' && teachBackend.isInvoke(body))) {
                  throw error
                }
              }
            }
            if (teachBackend.isInvoke(body)) {
              const data = teachBackend.invoke(body, requestOrigin(req))
              sendEarlyJson(req, res, 200, { code: 0, message: 'success', data })
              return
            }
            throw new BackendRuntimeError('PLUGIN_NOT_FOUND', `本地后端未加载插件 ${String(body.pluginId)}。`, 404)
          } catch (error) {
            if (error instanceof TeachMockError) {
              sendEarlyJson(req, res, error.status, { code: error.code, message: error.message, data: error.data })
              return
            }
            sendBackendRuntimeError(req, res, error)
          }
        })()
        activeRequests.add(request)
        try {
          await request
        } finally {
          activeRequests.delete(request)
        }
        return true
      }

      if (options.backendRuntime !== undefined && requestUrl.pathname === '/plugin-api/mock/backend/event') {
        if (req.method !== 'POST') {
          sendEarlyJson(req, res, 405, { code: 40501, message: 'METHOD_NOT_ALLOWED: 只允许 POST。', data: null })
          return true
        }
        const body = await readMockJsonBody(req, res)
        if (body === undefined) return true
        try {
          const data = await options.backendRuntime.dispatchEvent(body as unknown as BackendEventRequest)
          sendEarlyJson(req, res, 200, { code: 0, message: 'success', data })
        } catch (error) {
          sendBackendRuntimeError(req, res, error)
        }
        return true
      }

      if (options.backendRuntime !== undefined && requestUrl.pathname === '/plugin-api/mock/backend/state') {
        if (req.method !== 'GET') {
          sendEarlyJson(req, res, 405, { code: 40501, message: 'METHOD_NOT_ALLOWED: 只允许 GET。', data: null })
          return true
        }
        sendEarlyJson(req, res, 200, { code: 0, message: 'success', data: options.backendRuntime.snapshot() })
        return true
      }

      if (options.backendRuntime !== undefined && requestUrl.pathname === '/plugin-api/mock/backend/reset') {
        if (req.method !== 'POST') {
          sendEarlyJson(req, res, 405, { code: 40501, message: 'METHOD_NOT_ALLOWED: 只允许 POST。', data: null })
          return true
        }
        sendEarlyJson(req, res, 200, { code: 0, message: 'success', data: options.backendRuntime.reset() })
        return true
      }

      // 交通违章抓拍 Mock 后端（含 ai-detect、mock 控制端点与媒体图片；宿主桥端点不做插件 Token 校验）
      if (trafficBackend.matches(requestUrl.pathname)) {
        const request = trafficBackend.handle(req, res, requestUrl).then(() => undefined)
        activeRequests.add(request)
        try {
          await request
        } finally {
          activeRequests.delete(request)
        }
        return true
      }

      if (teachBackend.matches(requestUrl.pathname)) {
        if (!teachBackend.isObjectUploadPath(requestUrl.pathname) && req.headers['x-plugin-token'] !== MOCK_PLUGIN_TOKEN) {
          sendEarlyJson(req, res, 401, gatewayEnvelope(10005, 'Invalid plugin token'))
          return true
        }
        const request = teachBackend.handle(req, res, requestUrl).then(() => undefined)
        activeRequests.add(request)
        try {
          await request
        } finally {
          activeRequests.delete(request)
        }
        return true
      }

      if (requestUrl.pathname === '/plugin-api/mock/accident/event-status') {
        if (req.method !== 'POST') {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40000, 'Invalid parameter'))
          return true
        }
        const body = await readMockJsonBody(req, res)
        if (body === undefined) return true
        const eventId = typeof body.eventId === 'string' ? body.eventId : ''
        const status = typeof body.status === 'string' ? body.status : ''
        if (!['handling', 'completed', 'terminated'].includes(status) || !accidentStore.setStatus(eventId, status)) {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40001, 'invalid accident event status'))
          return true
        }
        sendEarlyJson(req, res, 200, { code: 0, message: 'OK', data: { eventId, status } })
        return true
      }

      if (requestUrl.pathname === '/plugin-api/mock/accident/reset') {
        if (req.method !== 'POST') {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40000, 'Invalid parameter'))
          return true
        }
        accidentStore.reset()
        accidentRoutePlanCode = 0
        sendEarlyJson(req, res, 200, { code: 0, message: 'OK', data: { reset: true } })
        return true
      }

      if (requestUrl.pathname === '/plugin-api/mock/accident/route-plan-code') {
        if (req.method !== 'POST') {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40000, 'Invalid parameter'))
          return true
        }
        const body = await readMockJsonBody(req, res)
        if (body === undefined) return true
        if (body.code !== 0 && body.code !== 11001 && body.code !== 11002) {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40001, 'invalid route plan code'))
          return true
        }
        accidentRoutePlanCode = body.code
        sendEarlyJson(req, res, 200, { code: 0, message: 'OK', data: { routePlanCode: accidentRoutePlanCode } })
        return true
      }

      if (requestUrl.pathname === '/plugin-api/mock/hello/status') {
        if (req.method !== 'GET') {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40000, 'Invalid parameter'))
          return true
        }
        if (req.headers['x-plugin-token'] !== MOCK_PLUGIN_TOKEN) {
          sendEarlyJson(req, res, 401, gatewayEnvelope(10005, 'Invalid plugin token'))
          return true
        }
        sendJson(res, 200, {
          code: 0,
          msg: 'Success',
          data: { service: 'mock-hello', status: 'ready' },
        })
        return true
      }

      // 调研弹窗（机场染色通路二）Mock 后端；?survey=1 启用后走真实插件网关链路。
      if (requestUrl.pathname === SURVEY_RESET_PATH) {
        if (req.method !== 'POST') {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40000, 'Invalid parameter'))
          return true
        }
        const body = await readMockJsonBody(req, res)
        if (body === undefined) return true
        surveyStore.reset({
          ...(typeof body.firstInstalledAt === 'number' ? { firstInstalledAt: body.firstInstalledAt } : {}),
          ...(typeof body.skipCount === 'number' ? { skipCount: body.skipCount } : {}),
          ...(body.lastSkippedAt === null || typeof body.lastSkippedAt === 'number'
            ? { lastSkippedAt: body.lastSkippedAt }
            : {}),
          ...(typeof body.completed === 'boolean' ? { completed: body.completed } : {}),
        })
        sendEarlyJson(req, res, 200, { code: 0, message: 'OK', data: surveyStore.status() })
        return true
      }

      if (requestUrl.pathname.startsWith(`${SURVEY_API_BASE}/`)) {
        if (req.headers['x-plugin-token'] !== MOCK_PLUGIN_TOKEN) {
          sendEarlyJson(req, res, 401, gatewayEnvelope(10005, 'Invalid plugin token'))
          return true
        }
        const action = requestUrl.pathname.slice(SURVEY_API_BASE.length + 1)
        const body = req.method === 'POST' ? await readMockJsonBody(req, res) : {}
        if (body === undefined) return true
        const projectUuid = req.method === 'GET' ? requestUrl.searchParams.get('projectUuid') : body.projectUuid
        if (typeof projectUuid !== 'string' || !projectUuid.trim()) {
          sendEarlyJson(req, res, 200, { code: 221016, message: '项目参数无效', data: null })
          return true
        }
        if (action === 'status' && req.method === 'GET') {
          sendEarlyJson(req, res, 200, { code: 0, message: 'success', data: surveyStore.status(projectUuid) })
          return true
        }
        if (action === 'prepare' && req.method === 'POST') {
          sendEarlyJson(req, res, 200, { code: 0, message: 'success', data: surveyStore.prepare(projectUuid) })
          return true
        }
        if (action === 'skip' && req.method === 'POST') {
          const status = surveyStore.status(projectUuid)
          if (status.skipRemaining === 0 && !status.verified) {
            sendEarlyJson(req, res, 200, { code: 221018, message: '跳过次数已用完', data: null })
          } else {
            sendEarlyJson(req, res, 200, { code: 0, message: 'success', data: surveyStore.skip(projectUuid, Date.now()) })
          }
          return true
        }
        if (action === 'verify' && req.method === 'POST') {
          if (body.code !== SURVEY_MOCK_VERIFY_CODE) {
            sendEarlyJson(req, res, 200, { code: 221019, message: '验证码不正确或已过期', data: null })
          } else {
            surveyStore.complete(projectUuid)
            sendEarlyJson(req, res, 200, { code: 0, message: 'success', data: { verified: true, verifiedAt: surveyStore.status(projectUuid).verifiedAt } })
          }
          return true
        }
        sendEarlyJson(req, res, 404, gatewayEnvelope(40400, `Unknown survey endpoint: ${action}`))
        return true
      }

      if (requestUrl.pathname === '/plugin-api/manage/api/v1/projects/mock-project/topologies') {
        if (req.method !== 'GET' || req.headers['x-plugin-token'] !== MOCK_PLUGIN_TOKEN) {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40000, 'Invalid parameter'))
          return true
        }
        sendJson(res, 200, {
          code: 0,
          msg: 'Success',
          data: {
            list: [{
              airport: {
                device_sn: 'dock-001',
                device_project_callsign: '福田一号机场',
                device_state: { latitude: 22.545, longitude: 114.050, height: 18 },
              },
              host: {
                device_sn: 'drone-001',
                device_project_callsign: '应急无人机',
                thingProperties: { latitude: 22.5451, longitude: 114.0501, height: 28 },
              },
            }],
          },
        })
        return true
      }

      if (requestUrl.pathname === '/plugin-api/plugin-scene/data-store/events/query') {
        if (req.method !== 'POST' || req.headers['x-plugin-token'] !== MOCK_PLUGIN_TOKEN) {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40000, 'Invalid parameter'))
          return true
        }
        const queryBody = await readMockJsonBody(req, res)
        if (queryBody === undefined) return true
        sendEarlyJson(req, res, 200, accidentStore.query(queryBody.status))
        return true
      }

      if (requestUrl.pathname === '/plugin-api/plugin-scene/data-store/events/update') {
        if (req.method !== 'POST' || req.headers['x-plugin-token'] !== MOCK_PLUGIN_TOKEN) {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40000, 'Invalid parameter'))
          return true
        }
        const updateBody = await readMockJsonBody(req, res)
        if (updateBody === undefined) return true
        const eventId = typeof updateBody.eventId === 'string' ? updateBody.eventId : ''
        if (eventId === '') {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40001, 'invalid parameter: 缺少 eventId'))
          return true
        }
        if (!accidentStore.update(eventId, updateBody.rawPayload)) {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40001, `invalid parameter: eventId 不存在: ${eventId}`))
          return true
        }
        sendEarlyJson(req, res, 200, { code: 0, message: 'OK', data: { updated: true } })
        return true
      }

      const eventDetailMatch = requestUrl.pathname.match(
        /^\/plugin-api\/plugin-scene\/data-store\/events\/([^/]+)$/,
      )
      if (eventDetailMatch) {
        if (req.method !== 'GET' || req.headers['x-plugin-token'] !== MOCK_PLUGIN_TOKEN) {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40000, 'Invalid parameter'))
          return true
        }
        let eventId: string
        try {
          eventId = decodeURIComponent(eventDetailMatch[1] ?? '')
        } catch {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40001, 'invalid parameter: eventId 编码无效'))
          return true
        }
        const event = accidentStore.get(eventId)
        if (!event) {
          sendEarlyJson(req, res, 404, gatewayEnvelope(40401, `event not found: ${eventId}`))
          return true
        }
        sendEarlyJson(req, res, 200, { code: 0, message: 'OK', data: event })
        return true
      }

      if (requestUrl.pathname === '/plugin-api/plugin-scene/route-planning/plan') {
        if (req.method !== 'POST' || req.headers['x-plugin-token'] !== MOCK_PLUGIN_TOKEN) {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40000, 'Invalid parameter'))
          return true
        }
        const planBody = await readMockJsonBody(req, res)
        if (planBody === undefined) return true
        if (accidentRoutePlanCode !== 0) {
          sendEarlyJson(req, res, 200, gatewayEnvelope(accidentRoutePlanCode, 'Mock route planning failure'))
          return true
        }
        const workspaceId = typeof planBody.workspace_id === 'string' ? planBody.workspace_id : ''
        for (const field of ['start_lat', 'start_lng', 'end_lat', 'end_lng'] as const) {
          if (typeof planBody[field] !== 'number') {
            sendEarlyJson(req, res, 400, gatewayEnvelope(40001, `invalid parameter: 缺少 ${field}`))
            return true
          }
        }
        sendEarlyJson(req, res, 200, {
          code: 0,
          message: 'OK',
          data: {
            routes: [
              {
                source: 'navinfo',
                label: '大路优先',
                total_distance: 980.5,
                estimated_duration: 98.1,
                waypoint_count: 33,
                wpmz_key: `wayline/${workspaceId || 'mock-project'}/route-main.kmz`,
                wpmz_url: 'http://mock.local/wayline/route-main.kmz',
                warnings: [],
              },
              {
                source: 'osm',
                label: '备选路线',
                total_distance: 1150.2,
                estimated_duration: 115,
                waypoint_count: 40,
                wpmz_key: `wayline/${workspaceId || 'mock-project'}/route-alt.kmz`,
                wpmz_url: '',
                warnings: ['临时模拟航线'],
              },
            ],
          },
        })
        return true
      }

      if (requestUrl.pathname === '/plugin-api/plugin-scene/route-planning/register') {
        if (req.method !== 'POST' || req.headers['x-plugin-token'] !== MOCK_PLUGIN_TOKEN) {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40000, 'Invalid parameter'))
          return true
        }
        const registerBody = await readMockJsonBody(req, res)
        if (registerBody === undefined) return true
        for (const field of ['workspace_id', 'wpmz_key', 'name'] as const) {
          if (typeof registerBody[field] !== 'string' || registerBody[field] === '') {
            sendEarlyJson(req, res, 400, gatewayEnvelope(40001, `invalid parameter: 缺少 ${field}`))
            return true
          }
        }
        const wpmzKey = registerBody.wpmz_key as string
        const basename = wpmzKey.split('/').pop() ?? ''
        sendEarlyJson(req, res, 200, {
          code: 0,
          message: 'OK',
          data: {
            wayline_uuid: `mock-wayline-${basename.replace(/\.kmz$/, '')}`,
            key: wpmzKey,
            name: registerBody.name,
          },
        })
        return true
      }

      const workflowStatusMatch = requestUrl.pathname.match(
        /^\/plugin-api\/flows\/([^/]+)\/incidents\/([^/]+)\/status$/,
      )
      if (workflowStatusMatch) {
        if (req.method !== 'GET' || req.headers['x-plugin-token'] !== MOCK_PLUGIN_TOKEN) {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40000, 'Invalid parameter'))
          return true
        }
        // 状态联动 mock 警情库：未签收等待 acknowledge，已签收等待 route_selected。
        // 与真实后端契约一致：响应不含 incidentStatus，executed/skipped 允许为 null。
        const statusIncidentId = decodeURIComponent(workflowStatusMatch[2] ?? '')
        const incidentStatus = accidentStore.getStatus(statusIncidentId) ?? 'unacknowledged'
        const awaitingSignal = incidentStatus === 'unacknowledged'
          ? 'acknowledge'
          : incidentStatus === 'acknowledged'
            ? 'route_selected'
            : ''
        sendJson(res, 200, {
          code: 0,
          msg: 'Success',
          data: {
            flow: decodeURIComponent(workflowStatusMatch[1] ?? ''),
            currentStep: incidentStatus === 'unacknowledged' ? 'ack' : incidentStatus === 'acknowledged' ? 'pick' : 'device_actions',
            executed: null,
            skipped: null,
            awaitingSignal,
          },
        })
        return true
      }

      const workflowSignalMatch = requestUrl.pathname.match(
        /^\/plugin-api\/flows\/([^/]+)\/incidents\/([^/]+)\/signals\/(acknowledge|route_selected|ignore)$/,
      )
      if (workflowSignalMatch) {
        if (req.method !== 'POST' || req.headers['x-plugin-token'] !== MOCK_PLUGIN_TOKEN) {
          sendEarlyJson(req, res, 400, gatewayEnvelope(40000, 'Invalid parameter'))
          return true
        }
        // 联动 mock 警情状态：签收→已签收，忽略→已忽略，与真实后端一致。
        const incidentId = decodeURIComponent(workflowSignalMatch[2] ?? '')
        const signalName = workflowSignalMatch[3]
        if (signalName === 'acknowledge') accidentStore.setStatus(incidentId, 'acknowledged')
        if (signalName === 'route_selected') accidentStore.setStatus(incidentId, 'handling')
        if (signalName === 'ignore') accidentStore.setStatus(incidentId, 'ignored')
        sendEarlyJson(req, res, 200, {
          code: 0,
          msg: 'Success',
          data: { ok: '1' },
        })
        return true
      }

      if (requestUrl.pathname.startsWith(API_PREFIX)) {
        sendEarlyJson(req, res, 404, gatewayEnvelope(40400, 'Not Found'))
        return true
      }
      return false
    },
    close () {
      if (closePromise !== undefined) return closePromise
      closing = true
      trafficBackend.close()
      options.backendRuntime?.close()
      for (const controller of activeControllers) controller.abort()
      closePromise = Promise.allSettled([...activeRequests]).then(() => undefined)
      return closePromise
    },
  }
}

function sendBackendRuntimeError (req: IncomingMessage, res: ServerResponse, error: unknown): void {
  const runtimeError = error instanceof BackendRuntimeError
    ? error
    : new BackendRuntimeError('BACKEND_RUNTIME_FAILED', error instanceof Error ? error.message : String(error), 500)
  // 只对齐 Worker 的数字码分类；HTTP 状态保留本地既有行为，未知码按可重试处理。
  let code = 50301
  switch (runtimeError.code) {
    case 'NOT_FOUND':
    case 'DUPLICATE':
    case 'CONFLICT':
      code = 20001
      break
    case 'INVALID_ARGUMENT':
    case 'UNKNOWN_FIELD':
    case 'UNKNOWN_ENTITY':
    case 'INVALID_FILTER':
    case 'EMPTY_FILTER':
    case 'KEY_TOO_LONG':
    case 'VALUE_TOO_LARGE':
    case 'TTL_INVALID':
    case 'TYPE_MISMATCH':
    case 'LIMIT_EXCEEDED':
    case 'PERMISSION_DENIED':
    case 'PLUGIN_NOT_FOUND':
    case 'HANDLER_NOT_FOUND':
    case 'EVENT_HANDLER_NOT_FOUND':
    case 'IDEMPOTENCY_KEY_REQUIRED':
      code = 40006
      break
  }
  sendEarlyJson(req, res, runtimeError.status, {
    code,
    message: runtimeError.message.includes(runtimeError.code) ? runtimeError.message : `${runtimeError.code}: ${runtimeError.message}`,
    data: null,
  })
}

export function createProxyGateway (options: ProxyGatewayOptions): DevGateway {
  const target = validateGatewayTarget(options.target)
  if (options.loginToken === '') throw new GatewayConfigurationError('缺少 FH2_DEV_LOGIN_TOKEN。')
  const fetchImplementation = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? PROXY_TOTAL_TIMEOUT_MS
  const requestLimit = options.requestBodyLimitBytes ?? PROXY_REQUEST_BODY_LIMIT_BYTES
  const responseLimit = options.responseBodyLimitBytes ?? PROXY_RESPONSE_BODY_LIMIT_BYTES
  const activeRequests = new Set<Promise<void>>()
  const activeControllers = new Set<AbortController>()
  let closing = false
  let closePromise: Promise<void> | undefined

  const forward = async (req: IncomingMessage, res: ServerResponse, requestUrl: URL): Promise<void> => {
    const controller = new AbortController()
    activeControllers.add(controller)
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const abortDownstream = (): void => controller.abort()
    req.once('aborted', abortDownstream)
    res.once('close', abortDownstream)

    try {
      const isTokenRequest = requestUrl.pathname === TOKEN_PATH
      const method = req.method ?? ''
      if (isTokenRequest && !isStrictTokenRequest(req, requestUrl)) {
        sendEarlyJson(req, res, 400, gatewayEnvelope(40000, 'Invalid parameter'))
        return
      }
      if (!isTokenRequest && !API_METHODS.has(method)) {
        sendEarlyJson(req, res, 400, gatewayEnvelope(40000, 'Invalid parameter'))
        return
      }

      const incomingBody = await readRequestBody(req, requestLimit, controller.signal)
      let requestBody: Buffer | undefined
      if (isTokenRequest) {
        parseJson(incomingBody)
        requestBody = Buffer.from(JSON.stringify({ login_token: options.loginToken }))
      } else if (incomingBody.length > 0) {
        if (method === 'GET') throw new GatewayRequestError(400, 40000, 'Invalid parameter')
        requireJsonContentType(req.headers['content-type'])
        parseJson(incomingBody)
        requestBody = incomingBody
      }

      const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, target)
      const upstreamHeaders = requestHeaders(req, requestBody, isTokenRequest)
      const response = await fetchImplementation(upstreamUrl, {
        method,
        headers: upstreamHeaders,
        redirect: 'manual',
        signal: controller.signal,
        ...(requestBody === undefined ? {} : { body: requestBody }),
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined)
        sendJson(res, 502, gatewayEnvelope(50200, 'Gateway upstream redirect rejected'))
        return
      }
      const upstreamBody = await readResponseBody(response, responseLimit, controller)
      const responseBody = isTokenRequest
        ? redactTokenResponse(upstreamBody, options.loginToken)
        : upstreamBody
      if (closing || controller.signal.aborted || res.destroyed) return
      res.writeHead(response.status, responseHeaders(
        response.headers,
        responseBody.byteLength,
        options.loginToken,
      ))
      res.end(responseBody)
    } catch (error) {
      if (closing || res.destroyed) {
        if (!res.destroyed) res.destroy()
        return
      }
      if (error instanceof GatewayRequestError) {
        sendJson(res, error.status, gatewayEnvelope(error.code, error.message))
        return
      }
      sendJson(res, 502, gatewayEnvelope(50200, timedOut ? 'Gateway upstream timeout' : 'Gateway upstream unavailable'))
    } finally {
      clearTimeout(timeout)
      req.off('aborted', abortDownstream)
      res.off('close', abortDownstream)
      activeControllers.delete(controller)
    }
  }

  return {
    apiMode: 'proxy',
    async handle (req, res, requestUrl) {
      if (requestUrl.pathname !== TOKEN_PATH && !requestUrl.pathname.startsWith(API_PREFIX)) return false
      if (closing) {
        sendEarlyJson(req, res, 503, gatewayEnvelope(50300, 'Gateway is shutting down'))
        return true
      }
      const request = forward(req, res, requestUrl)
      activeRequests.add(request)
      try {
        await request
      } finally {
        activeRequests.delete(request)
      }
      return true
    },
    close () {
      if (closePromise !== undefined) return closePromise
      closing = true
      for (const controller of activeControllers) controller.abort()
      closePromise = Promise.allSettled([...activeRequests]).then(() => undefined)
      return closePromise
    },
  }
}

function isStrictTokenRequest (req: IncomingMessage, requestUrl: URL): boolean {
  return req.method === 'POST'
    && [...requestUrl.searchParams.keys()].length === 1
    && requestUrl.searchParams.getAll('svc').length === 1
    && requestUrl.searchParams.get('svc') === 'manage'
}

function isLoopbackHostname (hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function singleHeader (value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function requestOrigin (req: IncomingMessage): string {
  return `http://${req.headers.host ?? '127.0.0.1'}`
}

function requestHeaders (req: IncomingMessage, body: Buffer | undefined, forceJson: boolean): Headers {
  const headers = new Headers()
  for (const name of ['content-type', 'accept', 'x-plugin-token', ...TRACE_HEADERS]) {
    const value = req.headers[name]
    if (typeof value === 'string') headers.set(name, value)
  }
  headers.set('accept-encoding', 'identity')
  if (body !== undefined) {
    headers.set('content-length', String(body.byteLength))
    if (forceJson) headers.set('content-type', 'application/json')
  } else {
    headers.delete('content-type')
  }
  return headers
}

function responseHeaders (upstream: Headers, contentLength: number, secret: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-length': String(contentLength) }
  for (const name of ['content-type', ...TRACE_HEADERS]) {
    const value = upstream.get(name)
    if (value !== null && !value.includes(secret)) headers[name] = value
  }
  return headers
}

async function readJsonRequest (req: IncomingMessage, limit: number, signal: AbortSignal): Promise<unknown> {
  return parseJson(await readRequestBody(req, limit, signal))
}

async function readRequestBody (req: IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise<Buffer>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    let settled = false
    let onAbort!: () => void
    let onData!: (chunk: Buffer | string) => void
    let onEnd!: () => void
    let onError!: (error: Error) => void
    let onRequestAborted!: () => void

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onRequestAborted)
    }
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error !== undefined) rejectBody(error)
      else if (tooLarge) rejectBody(new GatewayRequestError(413, 41300, 'Request body too large'))
      else resolveBody(Buffer.concat(chunks))
    }
    onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.byteLength
      if (size > limit) tooLarge = true
      else if (!tooLarge) chunks.push(buffer)
    }
    onEnd = (): void => finish()
    onError = (error: Error): void => finish(error)
    onRequestAborted = (): void => finish(new Error('Downstream request aborted'))
    onAbort = (): void => {
      finish(new DOMException('Aborted', 'AbortError'))
      if (!req.destroyed) req.destroy()
    }

    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onRequestAborted)
  })
}

function parseJson (body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown
  } catch {
    throw new GatewayRequestError(400, 40003, 'Invalid JSON format')
  }
}

function requireJsonContentType (value: string | undefined): void {
  if (value?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new GatewayRequestError(400, 40000, 'Invalid parameter')
  }
}

async function readResponseBody (
  response: Response,
  limit: number,
  controller: AbortController,
): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const item = await reader.read()
    if (item.done) break
    size += item.value.byteLength
    if (size > limit) {
      controller.abort()
      throw new GatewayRequestError(502, 50200, 'Gateway upstream response too large')
    }
    chunks.push(item.value)
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
}

function redactTokenResponse (body: Buffer, secret: string): Buffer {
  const text = body.toString('utf8')
  try {
    const parsed = JSON.parse(text) as unknown
    const redacted = JSON.stringify(redactExactSecret(parsed, secret))
    return Buffer.from(redacted)
  } catch {
    const escapedSecret = JSON.stringify(secret).slice(1, -1)
    return Buffer.from(text
      .replaceAll(secret, '[REDACTED]')
      .replaceAll(escapedSecret, '[REDACTED]'))
  }
}

function redactExactSecret (value: unknown, secret: string): unknown {
  if (typeof value === 'string') return value.replaceAll(secret, '[REDACTED]')
  if (Array.isArray(value)) return value.map(item => redactExactSecret(item, secret))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactExactSecret(item, secret)]))
  }
  return value
}

function sendRequestError (res: ServerResponse, error: unknown): void {
  if (error instanceof GatewayRequestError) {
    sendJson(res, error.status, gatewayEnvelope(error.code, error.message))
    return
  }
  sendJson(res, 400, gatewayEnvelope(40003, 'Invalid JSON format'))
}

function sendJson (res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function sendEarlyJson (req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  closeRequestAfterResponse(req, res)
  sendJson(res, status, body)
}

/** Mock 端点读取并校验 JSON body；非法时已回 400 并返回 undefined。 */
async function readMockJsonBody (req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await readJsonRequest(req, PROXY_REQUEST_BODY_LIMIT_BYTES, new AbortController().signal)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('body must be a JSON object')
    }
    return body as Record<string, unknown>
  } catch {
    sendEarlyJson(req, res, 400, gatewayEnvelope(40001, 'invalid parameter: 请求体必须是 JSON 对象'))
    return undefined
  }
}

/**
 * 事故警情 Mock 存储：query 返回全部记录（含终态），update 合并 rawPayload。
 * 活动状态过滤由调用方（插件）按 status 白名单请求时忽略——mock 一律返回全量，前端自行过滤渲染。
 */
function createAccidentEventStore () {
  interface MockEvent {
    readonly id: number;
    readonly eventId: string;
    readonly eventType: string;
    readonly source: string;
    readonly priority: string;
    status: string;
    readonly resultCode: number;
    readonly result: Record<string, unknown> | null;
    readonly occurredAt: string;
    readonly createdAt: string;
    rawPayload: Record<string, unknown>;
  }

  const seedEvents: MockEvent[] = [
    {
      id: 5,
      eventId: 'mock-list-incident-001',
      eventType: '警情',
      source: 'cascade-test',
      priority: 'low',
      status: 'unacknowledged',
      resultCode: 0,
      result: { dispatched: true },
      occurredAt: '2026-08-24 14:16:29',
      createdAt: '2026-08-24 14:16:29',
      rawPayload: {
        id: 'MOCKP-000017',
        lat: '22.5405',
        lng: 114.0579,
        addr: '深圳市福田区深南大道',
      },
    },
    {
      id: 6,
      eventId: 'mock-list-incident-002',
      eventType: '警情',
      source: 'cascade-test',
      priority: 'low',
      status: 'completed',
      resultCode: 0,
      result: { dispatched: true },
      occurredAt: '2026-08-24 13:02:11',
      createdAt: '2026-08-24 13:02:11',
      rawPayload: {
        id: 'MOCKP-000016',
        lat: '22.5409',
        lng: 114.0612,
        addr: '深圳市福田区彩田路',
        correction_note: '数据补录：警官王小明二次核对后修正',
      },
    },
    {
      id: 7,
      eventId: 'mock-list-incident-003',
      eventType: '警情',
      source: 'cascade-test',
      priority: 'low',
      status: 'acknowledged',
      resultCode: 0,
      result: null,
      occurredAt: '2026-08-24 14:10:00',
      createdAt: '2026-08-24 14:10:00',
      rawPayload: {
        id: 'MOCKP-000018',
        desc: '北环大道三车追尾',
        addr: '深圳市福田区北环大道',
      },
    },
  ]

  const cloneEvent = (event: MockEvent): MockEvent => ({
    ...event,
    rawPayload: { ...event.rawPayload },
    result: event.result === null ? null : { ...event.result },
  })
  const events = seedEvents.map(cloneEvent)

  return {
    query (statusFilter: unknown): unknown {
      const activeStatuses = Array.isArray(statusFilter)
        ? new Set(statusFilter.filter((item): item is string => typeof item === 'string'))
        : undefined
      const visible = activeStatuses === undefined
        ? events
        : events.filter(event => activeStatuses.has(event.status))
      return {
        code: 0,
        message: 'OK',
        data: {
          pagination: { page: 1, page_size: 20, total: visible.length },
          list: visible.map(event => ({ ...event, rawPayload: { ...event.rawPayload } })),
        },
      }
    },
    update (eventId: string, rawPayload: unknown): boolean {
      const event = events.find(item => item.eventId === eventId)
      if (!event) return false
      if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return false
      event.rawPayload = { ...rawPayload }
      return true
    },
    get (eventId: string): MockEvent | undefined {
      const event = events.find(item => item.eventId === eventId)
      return event === undefined
        ? undefined
        : { ...event, rawPayload: { ...event.rawPayload }, result: event.result === null ? null : { ...event.result } }
    },
    setStatus (eventId: string, status: string): boolean {
      const event = events.find(item => item.eventId === eventId)
      if (!event) return false
      event.status = status
      return true
    },
    getStatus (eventId: string): string | undefined {
      const event = events.find(item => item.eventId === eventId)
      return event?.status
    },
    reset (): void {
      events.splice(0, events.length, ...seedEvents.map(cloneEvent))
    },
  }
}

function gatewayEnvelope (code: number, msg: string): { code: number; msg: string; data: null } {
  return { code, msg, data: null }
}

/**
 * 调研弹窗 Mock 存储：默认「安装满 31 天、未完成」即可触发弹窗，跳过冷却 1 分钟。
 * 场景经 SURVEY_RESET_PATH 重置（不校验插件 Token，与 accident/reset 同模式）。
 */
function createSurveyMockStore () {
  const DAY_MS = 24 * 60 * 60 * 1000
  const SKIP_COOLDOWN_MS = 60 * 1000
  const defaultState = () => ({ firstInstalledAt: Date.now() - 31 * DAY_MS, skipCount: 0, lastSkippedAt: null as number | null, completed: false, verifiedAt: null as string | null })
  let defaults = defaultState()
  const projects = new Map<string, ReturnType<typeof defaultState>>()
  const get = (project: string) => {
    let state = projects.get(project)
    if (!state) {
      state = { ...defaults }
      projects.set(project, state)
    }
    return state
  }
  return {
    status (project = 'mock-project') {
      const state = get(project)
      const now = Date.now()
      const eligible = now - state.firstInstalledAt >= 30 * DAY_MS && (state.lastSkippedAt === null || now - state.lastSkippedAt >= SKIP_COOLDOWN_MS)
      return { shouldPopup: eligible && !state.completed, popupReason: state.completed ? 'verified' : eligible ? 'eligible' : 'cooldown', serverTime: new Date(now).toISOString(), baseInstalledAt: new Date(state.firstInstalledAt).toISOString(), firstPluginInstalledAt: new Date(state.firstInstalledAt).toISOString(), skipCount: state.skipCount, skipRemaining: Math.max(0, 2 - state.skipCount), lastSkippedAt: state.lastSkippedAt === null ? null : new Date(state.lastSkippedAt).toISOString(), verified: state.completed, verifiedAt: state.verifiedAt }
    },
    skip (project: string, now: number) {
      const state = get(project)
      if (!state.completed) {
        state.skipCount = Math.min(2, state.skipCount + 1)
        state.lastSkippedAt = now
      }
      return { skipCount: state.skipCount, skipRemaining: Math.max(0, 2 - state.skipCount), lastSkippedAt: state.lastSkippedAt === null ? null : new Date(state.lastSkippedAt).toISOString(), nextPopupAt: state.completed ? null : new Date(now + SKIP_COOLDOWN_MS).toISOString() }
    },
    prepare (project: string) {
      return { qrUrl: `https://survey.example.com/qr?project=${encodeURIComponent(project)}`, deploymentId: project, airportTotal: 0, airportReportedCount: 0 }
    },
    complete (project: string): void {
      const state = get(project)
      state.completed = true
      state.verifiedAt = new Date().toISOString()
    },
    reset (overrides: Partial<ReturnType<typeof defaultState>>): void {
      defaults = { ...defaultState(), ...overrides }
      projects.clear()
    },
  }
}

class GatewayRequestError extends Error {
  constructor (
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = 'GatewayRequestError'
  }
}
