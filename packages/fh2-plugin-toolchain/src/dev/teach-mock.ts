// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'

const TEACH_BASE = '/plugin-api/plugin-scene/patrol/teach'
const MOCK_TEACH_BASE = '/plugin-api/mock/teach'
const OBJECT_UPLOAD_BASE = '/plugin-api/mock/object-upload'
const WAYLINE_TEACH_PLUGIN_ID = 'official_patrol_teach'
const MOCK_OBJECT_BUCKET = 'fh2-plugin-mock'
const SCREENSHOT_MAX_SINGLE_BYTES = 2 * 1024 * 1024
const SCREENSHOT_MAX_ROUTE_BYTES = 80 * 1024 * 1024
const STS_EXPIRES_IN_SECONDS = 15 * 60
const MOCK_SCREENSHOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9K4e8AAAAASUVORK5CYII=',
  'base64',
)

type TeachStatus = 'recording' | 'generated'

interface MockWaypoint {
  readonly id: number;
  readonly seq: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly height: number;
  readonly gimbal_pitch: number;
  readonly camera_yaw: number;
  focal_length: number;
  readonly ai_recognition_on: boolean;
  readonly ai_target_types: readonly ('person' | 'car' | 'boat')[];
  selected: boolean;
  screenshot_file_id: string | null;
  screenshot_url: string | null;
  screenshot_bytes: number;
}

interface MockRoute {
  readonly id: number;
  readonly project_id: string;
  readonly flight_id: string;
  readonly dock_sn: string;
  readonly drone_sn: string;
  readonly created_at: string;
  name: string;
  status: TeachStatus;
  global_speed: number;
  waypoint_speed: number;
  wayline_uuid: string | null;
  wayline_file_id: string | null;
  screenshot_bytes: number;
  waypoint_count: number;
  readonly waypoints: MockWaypoint[];
}

interface MockObject {
  readonly routeId: number;
  readonly waypointId: number;
  readonly fileId: string;
  readonly objectKey: string;
  uploadStarted: boolean;
  bytes: number | null;
}

const VALID_AI_TARGET_TYPES = new Set(['person', 'car', 'boat'])

interface TeachInvokeRequest {
  readonly pluginId?: unknown;
  readonly handler?: unknown;
  readonly input?: unknown;
}

export class TeachMockError extends Error {
  constructor (
    readonly status: number,
    readonly code: number,
    message: string,
    readonly data: unknown = null,
  ) {
    super(message)
    this.name = 'TeachMockError'
  }
}

/**
 * 示教复飞开发 Mock：遵循《示教复飞实现方案》API 与状态约束。
 * 截图接口直接返回临时 STS，Host 向同一 Mock Gateway 的 S3 形状端点上传。
 */
export class TeachMockBackend {
  private readonly routes = new Map<number, MockRoute>()
  private readonly objects = new Map<string, MockObject>()
  private routeSequence = 0
  private waypointSequence = 0
  private objectSequence = 0

  matches (pathname: string): boolean {
    return pathname.startsWith(TEACH_BASE)
      || pathname.startsWith(MOCK_TEACH_BASE)
      || pathname.startsWith(OBJECT_UPLOAD_BASE)
  }

  isObjectUploadPath (pathname: string): boolean {
    return pathname.startsWith(`${OBJECT_UPLOAD_BASE}/`)
  }

  isInvoke (request: TeachInvokeRequest): boolean {
    return request.pluginId === WAYLINE_TEACH_PLUGIN_ID
  }

  invoke (request: TeachInvokeRequest, origin: string): unknown {
    if (!this.isInvoke(request)) throw new TeachMockError(404, 40401, '插件不存在')
    const input = record(request.input)
    switch (request.handler) {
      case 'h_teach_enterRoute':
        return this.enterData(input)
      case 'h_teach_getRouteStatus':
        return this.getRouteStatusData(input)
      case 'h_teach_deleteRoute':
        return this.deleteRouteData(numericId(input?.teach_route_id))
      case 'h_teach_appendWaypoint':
        return this.appendWaypointData(numericId(input?.teach_route_id), input)
      case 'h_teach_updateWaypoint':
        return this.updateWaypointData(numericId(input?.waypoint_id), input)
      case 'h_teach_deleteWaypoint':
        return this.deleteWaypointData(numericId(input?.waypoint_id))
      case 'h_teach_createScreenshotSTS':
        return this.createScreenshotStsData(numericId(input?.teach_route_id), input, origin)
      case 'h_teach_attachScreenshot':
        return this.attachScreenshotData(numericId(input?.waypoint_id), input)
      case 'h_teach_generateWayline':
        return this.generateData(numericId(input?.teach_route_id), input)
      default:
        throw new TeachMockError(404, 40401, `Handler 不存在：${String(request.handler)}`)
    }
  }

  async handle (req: IncomingMessage, res: ServerResponse, requestUrl: URL): Promise<boolean> {
    const { pathname } = requestUrl
    if (!this.matches(pathname)) return false

    const objectMatch = pathname.match(/^\/plugin-api\/mock\/object-upload\/([^/]+)\/(.+)$/)
    if (objectMatch !== null) {
      await this.handleObjectUpload(
        req,
        res,
        decodeURIComponent(objectMatch[1]!),
        decodeObjectKey(objectMatch[2]!),
      )
      return true
    }
    if (pathname === `${MOCK_TEACH_BASE}/reset`) {
      if (req.method !== 'POST') {
        methodNotAllowed(res)
        return true
      }
      this.routes.clear()
      this.objects.clear()
      this.routeSequence = 0
      this.waypointSequence = 0
      this.objectSequence = 0
      sendJson(res, 200, envelope(0, 'ok', { reset: true }))
      return true
    }
    if (pathname === `${TEACH_BASE}/routes/status`) {
      if (req.method !== 'GET') {
        methodNotAllowed(res)
        return true
      }
      const flightId = requestUrl.searchParams.get('flight_id') ?? ''
      const route = [...this.routes.values()].find(item => item.flight_id === flightId && item.status === 'recording')
      sendJson(res, 200, envelope(0, 'ok', { teach_route: route ? routeDto(route) : null }))
      return true
    }
    if (pathname === `${TEACH_BASE}/routes/enter`) {
      await this.enter(req, res)
      return true
    }

    const routeMatch = pathname.match(/^\/plugin-api\/plugin-scene\/patrol\/teach\/routes\/(\d+)(?:\/(waypoints))?$/)
    if (routeMatch !== null) {
      await this.handleRoute(req, res, Number(routeMatch[1]), routeMatch[2] ?? '')
      return true
    }
    const waypointMatch = pathname.match(/^\/plugin-api\/plugin-scene\/patrol\/teach\/waypoints\/(\d+)$/)
    if (waypointMatch !== null) {
      await this.handleWaypoint(req, res, Number(waypointMatch[1]))
      return true
    }

    sendJson(res, 404, envelope(40401, '路线或航点不存在'))
    return true
  }

  private async enter (req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const body = await readJsonBody(req)
    try {
      sendJson(res, 200, envelope(0, 'ok', this.enterData(body)))
    } catch (error) {
      sendTeachError(res, error)
    }
  }

  private enterData (body: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
    const projectId = text(body?.project_id)
    const flightId = text(body?.flight_id)
    const dockSn = text(body?.dock_sn)
    const droneSn = text(body?.drone_sn)
    if (!projectId || !flightId || !dockSn || !droneSn) {
      throw new TeachMockError(400, 40001, '参数缺失或非法')
    }
    const existing = [...this.routes.values()].find(route => route.flight_id === flightId && route.status === 'recording')
    if (existing) {
      throw new TeachMockError(409, 40901, '该架次已有录制中的示教航线', {
        teach_route_id: existing.id,
        name: existing.name,
        waypoint_count: existing.waypoints.length,
        created_at: existing.created_at,
      })
    }
    const route: MockRoute = {
      id: ++this.routeSequence,
      project_id: projectId,
      flight_id: flightId,
      dock_sn: dockSn,
      drone_sn: droneSn,
      created_at: new Date().toISOString(),
      name: `新建巡逻航线${this.routeSequence}`,
      status: 'recording',
      global_speed: 15,
      waypoint_speed: 5,
      wayline_uuid: null,
      wayline_file_id: null,
      screenshot_bytes: 0,
      waypoint_count: 0,
      waypoints: [],
    }
    this.routes.set(route.id, route)
    return { teach_route_id: route.id, name: route.name }
  }

  private getRouteStatusData (body: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
    const flightId = text(body?.flight_id)
    const route = [...this.routes.values()].find(item => item.flight_id === flightId && item.status === 'recording')
    return { teach_route: route ? routeDto(route) : null }
  }

  private deleteRouteData (routeId: number): Record<string, unknown> {
    if (!this.routes.has(routeId)) throw new TeachMockError(404, 40401, '路线不存在')
    this.routes.delete(routeId)
    return { deleted: true }
  }

  private appendWaypointData (
    routeId: number,
    body: Readonly<Record<string, unknown>> | undefined,
  ): Record<string, unknown> {
    const route = this.routes.get(routeId)
    if (!route) throw new TeachMockError(404, 40401, '路线不存在')
    if (route.status !== 'recording') throw new TeachMockError(409, 40902, '路线状态不允许此操作')
    const requiredNumbers = ['latitude', 'longitude', 'height', 'gimbal_pitch', 'camera_yaw', 'focal_length']
    if (!body || requiredNumbers.some(key => typeof body[key] !== 'number')
      || typeof body.ai_recognition_on !== 'boolean' || !Array.isArray(body.ai_target_types)) {
      throw new TeachMockError(400, 40001, '航点缺少必填项')
    }
    const aiTargetTypes = normalizeAiTargetTypes(body.ai_target_types)
    if (body.ai_recognition_on === true && aiTargetTypes.length === 0) {
      throw new TeachMockError(400, 40001, 'AI 已开启但没有合法目标类型')
    }
    const waypoint: MockWaypoint = {
      id: ++this.waypointSequence,
      seq: route.waypoints.length === 0 ? 0 : Math.max(...route.waypoints.map(item => item.seq)) + 1,
      latitude: body.latitude as number,
      longitude: body.longitude as number,
      height: body.height as number,
      gimbal_pitch: body.gimbal_pitch as number,
      camera_yaw: body.camera_yaw as number,
      focal_length: body.focal_length as number,
      ai_recognition_on: body.ai_recognition_on,
      ai_target_types: aiTargetTypes,
      selected: true,
      screenshot_file_id: null,
      screenshot_url: null,
      screenshot_bytes: 0,
    }
    route.waypoints.push(waypoint)
    return { id: waypoint.id, seq: waypoint.seq }
  }

  private updateWaypointData (
    waypointId: number,
    body: Readonly<Record<string, unknown>> | undefined,
  ): Record<string, unknown> {
    const entry = this.findWaypoint(waypointId)
    if (!entry) throw new TeachMockError(404, 40401, '航点不存在')
    if (!body) throw new TeachMockError(400, 40001, '参数缺失或非法')
    if (typeof body.focal_length === 'number') entry.waypoint.focal_length = body.focal_length
    if (typeof body.selected === 'boolean') entry.waypoint.selected = body.selected
    return { id: entry.waypoint.id }
  }

  private deleteWaypointData (waypointId: number): Record<string, unknown> {
    const entry = this.findWaypoint(waypointId)
    if (!entry) throw new TeachMockError(404, 40401, '航点不存在')
    const { route, waypoint } = entry
    route.waypoints.splice(route.waypoints.indexOf(waypoint), 1)
    route.screenshot_bytes -= waypoint.screenshot_bytes
    return { deleted: true }
  }

  private async handleRoute (req: IncomingMessage, res: ServerResponse, routeId: number, action: string): Promise<void> {
    const route = this.routes.get(routeId)
    if (!route) {
      sendJson(res, 404, envelope(40401, '路线不存在'))
      return
    }
    if (action === '' && req.method === 'GET') {
      sendJson(res, 200, envelope(0, 'ok', routeDto(route)))
      return
    }
    if (action === '' && req.method === 'DELETE') {
      sendJson(res, 200, envelope(0, 'ok', this.deleteRouteData(routeId)))
      return
    }
    if (action === 'waypoints' && req.method === 'POST') {
      await this.appendWaypoint(req, res, route)
      return
    }
    methodNotAllowed(res)
  }

  private async appendWaypoint (req: IncomingMessage, res: ServerResponse, route: MockRoute): Promise<void> {
    const body = await readJsonBody(req)
    try {
      sendJson(res, 200, envelope(0, 'ok', this.appendWaypointData(route.id, body)))
    } catch (error) {
      sendTeachError(res, error)
    }
  }

  private createScreenshotStsData (
    routeId: number,
    body: Readonly<Record<string, unknown>> | undefined,
    origin: string,
  ): Record<string, unknown> {
    const route = this.routes.get(routeId)
    if (!route) throw new TeachMockError(404, 40401, '路线不存在')
    if (route.status !== 'recording') throw new TeachMockError(409, 40902, '路线状态不允许此操作')
    const waypointId = numericId(body?.waypoint_id)
    if (!route.waypoints.some(waypoint => waypoint.id === waypointId)) {
      throw new TeachMockError(400, 40001, '截图上传凭证缺少有效 waypoint_id')
    }
    const sequence = ++this.objectSequence
    const fileId = `mock-file-${sequence}`
    const objectKey = `teach/${route.id}/${fileId}.jpg`
    this.objects.set(objectKey, {
      routeId: route.id,
      waypointId,
      fileId,
      objectKey,
      uploadStarted: false,
      bytes: null,
    })
    return {
      endpoint: `${origin}${OBJECT_UPLOAD_BASE}`,
      bucket: MOCK_OBJECT_BUCKET,
      region: 'mock-region-1',
      object_key_prefix: `teach/${route.id}/`,
      object_key: objectKey,
      access_key_id: `mock-access-key-${sequence}`,
      secret_access_key: `mock-secret-key-${sequence}`,
      security_token: `mock-security-token-${sequence}`,
      expires_in: STS_EXPIRES_IN_SECONDS,
      use_path_style: true,
    }
  }

  private async handleObjectUpload (
    req: IncomingMessage,
    res: ServerResponse,
    bucket: string,
    objectKey: string,
  ): Promise<void> {
    const object = bucket === MOCK_OBJECT_BUCKET ? this.objects.get(objectKey) : undefined
    if (req.method === 'GET') {
      if (!object || object.bytes === null) {
        sendJson(res, 404, envelope(40401, '截图对象不存在'))
        return
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      res.end(MOCK_SCREENSHOT_PNG)
      return
    }
    if (!object) {
      sendJson(res, 404, envelope(40401, '对象上传目标不存在'))
      return
    }
    if (req.method !== 'PUT') return methodNotAllowed(res)
    if (object.uploadStarted) {
      sendJson(res, 409, envelope(40903, '对象上传目标已使用'))
      return
    }
    object.uploadStarted = true
    const bytes = await readBodyBytes(req, SCREENSHOT_MAX_SINGLE_BYTES + 1)
    if (bytes === undefined || bytes.byteLength > SCREENSHOT_MAX_SINGLE_BYTES) {
      sendJson(res, 413, envelope(41301, '单张截图超限'))
      return
    }
    object.bytes = bytes.byteLength
    res.writeHead(200, { etag: `mock-${object.fileId}` })
    res.end()
  }

  private async handleWaypoint (req: IncomingMessage, res: ServerResponse, waypointId: number): Promise<void> {
    const entry = this.findWaypoint(waypointId)
    if (!entry) {
      sendJson(res, 404, envelope(40401, '航点不存在'))
      return
    }
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req)
      try {
        sendJson(res, 200, envelope(0, 'ok', this.updateWaypointData(waypointId, body)))
      } catch (error) {
        sendTeachError(res, error)
      }
      return
    }
    if (req.method === 'DELETE') {
      sendJson(res, 200, envelope(0, 'ok', this.deleteWaypointData(waypointId)))
      return
    }
    methodNotAllowed(res)
  }

  private attachScreenshotData (
    waypointId: number,
    body: Readonly<Record<string, unknown>> | undefined,
  ): Record<string, unknown> {
    const entry = this.findWaypoint(waypointId)
    if (!entry) throw new TeachMockError(404, 40401, '航点不存在')
    const { route, waypoint } = entry
    if (route.status !== 'recording') throw new TeachMockError(409, 40902, '路线状态不允许此操作')
    const objectKey = text(body?.object_key)
    const bytes = body?.bytes
    const object = this.objects.get(objectKey)
    if (!objectKey || typeof bytes !== 'number' || !object
      || object.routeId !== route.id || object.waypointId !== waypoint.id
      || object.bytes !== bytes) {
      throw new TeachMockError(400, 40001, '截图元信息非法')
    }
    const nextBytes = route.screenshot_bytes - waypoint.screenshot_bytes + bytes
    if (nextBytes > SCREENSHOT_MAX_ROUTE_BYTES) throw new TeachMockError(413, 41302, '路线截图累计超限')
    waypoint.screenshot_file_id = object.fileId
    waypoint.screenshot_url = `${OBJECT_UPLOAD_BASE}/${encodeURIComponent(MOCK_OBJECT_BUCKET)}/${encodeObjectKey(object.objectKey)}`
    waypoint.screenshot_bytes = bytes
    route.screenshot_bytes = nextBytes
    return {
      screenshot_file_id: object.fileId,
      screenshot_url: waypoint.screenshot_url,
    }
  }

  private generateData (
    routeId: number,
    body: Readonly<Record<string, unknown>> | undefined,
  ): Record<string, unknown> {
    const route = this.routes.get(routeId)
    if (!route) throw new TeachMockError(404, 40401, '路线不存在')
    if (!body || typeof body.name !== 'string' || typeof body.global_speed !== 'number' || typeof body.waypoint_speed !== 'number') {
      throw new TeachMockError(400, 40001, '参数缺失或非法')
    }
    if (route.status !== 'recording') {
      throw new TeachMockError(409, 40902, '路线状态不允许此操作')
    }
    const selected = route.waypoints.filter(waypoint => waypoint.selected)
    if (selected.length < 2) {
      throw new TeachMockError(422, 42201, '至少需要 2 个选中航点')
    }
    if (!body.name.trim() || body.name.trim().length > 100
      || body.global_speed < 0.1 || body.global_speed > 15
      || body.waypoint_speed < 0.1 || body.waypoint_speed > 15) {
      throw new TeachMockError(400, 40001, '参数缺失或非法')
    }
    route.name = body.name.trim()
    route.global_speed = body.global_speed
    route.waypoint_speed = body.waypoint_speed
    route.status = 'generated'
    route.waypoint_count = selected.length
    route.wayline_uuid = `mock-wayline-${route.id}`
    route.wayline_file_id = `mock-kmz-${route.id}`
    route.waypoints.length = 0
    return {
      wayline_uuid: route.wayline_uuid,
      wayline_file_id: route.wayline_file_id,
      kmz_object_key: `teach/${route.id}/route.kmz`,
      waypoint_count: selected.length,
    }
  }

  private findWaypoint (waypointId: number): { readonly route: MockRoute; readonly waypoint: MockWaypoint } | undefined {
    for (const route of this.routes.values()) {
      const waypoint = route.waypoints.find(item => item.id === waypointId)
      if (waypoint) return { route, waypoint }
    }
    return undefined
  }
}

function routeDto (route: MockRoute): Record<string, unknown> {
  return {
    id: route.id,
    project_id: route.project_id,
    name: route.name,
    flight_id: route.flight_id,
    created_at: route.created_at,
    status: route.status,
    global_speed: route.global_speed,
    waypoint_speed: route.waypoint_speed,
    wayline_uuid: route.wayline_uuid,
    wayline_file_id: route.wayline_file_id,
    kmz_object_key: route.wayline_uuid ? `teach/${route.id}/route.kmz` : null,
    screenshot_bytes: route.screenshot_bytes,
    waypoint_count: route.status === 'recording' ? route.waypoints.length : route.waypoint_count,
    waypoints: route.waypoints.map(waypoint => ({ ...waypoint })),
  }
}

function text (value: unknown): string {
  return typeof value === 'string' && value ? value : ''
}

function numericId (value: unknown): number {
  const id = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new TeachMockError(400, 40001, 'ID 参数非法')
  return id
}

function record (value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function encodeObjectKey (value: string): string {
  return value.split('/').map(encodeURIComponent).join('/')
}

function decodeObjectKey (value: string): string {
  return value.split('/').map(decodeURIComponent).join('/')
}

function normalizeAiTargetTypes (value: unknown): readonly ('person' | 'car' | 'boat')[] {
  if (!Array.isArray(value)) return []
  const types = new Set<'person' | 'car' | 'boat'>()
  for (const item of value) {
    if (typeof item === 'string' && VALID_AI_TARGET_TYPES.has(item)) {
      types.add(item as 'person' | 'car' | 'boat')
    }
  }
  return [...types].sort()
}

async function readJsonBody (req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const bytes = await readBodyBytes(req, SCREENSHOT_MAX_SINGLE_BYTES)
  if (bytes === undefined) return undefined
  try {
    const body = JSON.parse(bytes.toString('utf8')) as unknown
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

async function readBodyBytes (req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.byteLength
    if (size > limit) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function envelope (code: number, msg: string, data: unknown = null): Record<string, unknown> {
  return { code, msg, data }
}

function methodNotAllowed (res: ServerResponse): void {
  sendJson(res, 405, envelope(40001, '请求方法不允许'))
}

function sendTeachError (res: ServerResponse, error: unknown): void {
  if (error instanceof TeachMockError) {
    sendJson(res, error.status, envelope(error.code, error.message, error.data))
    return
  }
  throw error
}

function sendJson (res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
