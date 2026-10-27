// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { ApiCallOptions, JsonValue, PlatformObjectUploadInput } from 'fh2-plugin-sdk'
import type { ApiCall } from './teach-api'

type JsonRecord = Readonly<Record<string, JsonValue>>

interface MockWaypoint {
  readonly id: number;
  readonly seq: number;
  readonly longitude: number;
  readonly latitude: number;
  readonly height: number;
  readonly cameraYaw: number;
  readonly gimbalPitch: number;
  focalLength: number;
  readonly aiRecognitionOn: boolean;
  readonly aiTargetTypes: readonly string[];
  selected: boolean;
  screenshotFileId: string | null;
  screenshotUrl: string | null;
  screenshotBytes: number;
}

interface MockRoute {
  readonly id: number;
  readonly projectId: string;
  readonly flightId: string;
  readonly dockSn: string;
  readonly droneSn: string;
  readonly createdAt: string;
  name: string;
  status: 'recording' | 'generated';
  globalSpeed: number;
  waypointSpeed: number;
  screenshotBytes: number;
  waypointCount: number;
  waylineUuid: string | null;
  waylineFileId: string | null;
  kmzObjectKey: string | null;
  readonly waypoints: MockWaypoint[];
}

interface MockUpload {
  readonly routeId: number;
  readonly waypointId: number;
  readonly objectKey: string;
  blob: Blob | null;
}

interface ObjectUpload {
  upload(input: PlatformObjectUploadInput): Promise<{ readonly etag: string | null }>;
}

export interface TeachTransport {
  readonly apiCall: ApiCall;
  readonly objectUpload: ObjectUpload;
  isMock(): boolean;
  dispose(): void;
}

const INVOKE_ENDPOINT = '/plugin/invoke'
const TEACH_PLUGIN_ID = 'official_patrol_teach'
const MOCK_STS_ENDPOINT = 'https://mock-object-storage.invalid'
const MOCK_STS_BUCKET = 'fh2-plugin-mock'
const MOCK_STS_REGION = 'us-east-1'
const MOCK_STS_ACCESS_KEY_ID = 'mock-access-key'
const MOCK_STS_SECRET_ACCESS_KEY = 'mock-secret-access-key'
const MOCK_STS_SECURITY_TOKEN = 'mock-security-token'
const SCREENSHOT_MAX_SINGLE_BYTES = 2 * 1024 * 1024
const SCREENSHOT_MAX_ROUTE_BYTES = 80 * 1024 * 1024
const VALID_AI_TARGET_TYPES = new Set(['person', 'car', 'boat'])

export function createTeachTransport (input: {
  readonly apiCall: ApiCall;
  readonly objectUpload: ObjectUpload;
  readonly enableMock: boolean;
}): TeachTransport {
  const mock = new MemoryTeachBackend()
  const apiCall: ApiCall = (endpoint, options) => input.enableMock
    ? mock.call(endpoint, options)
    : input.apiCall(endpoint, options)

  return {
    apiCall,
    isMock: () => input.enableMock,
    objectUpload: {
      async upload (uploadInput) {
        if (!input.enableMock) return input.objectUpload.upload(uploadInput)
        return mock.upload(uploadInput)
      },
    },
    dispose: () => mock.dispose(),
  }
}

class MemoryTeachBackend {
  private readonly routes = new Map<number, MockRoute>()
  private readonly uploads = new Map<string, MockUpload>()
  private routeSequence = 0
  private waypointSequence = 0
  private uploadSequence = 0

  call (endpoint: string, options?: ApiCallOptions): Promise<JsonValue> {
    const url = new URL(endpoint, 'https://mock.invalid')
    const method = options?.method ?? 'GET'
    const body = jsonRecord(options?.body)

    if (url.pathname === INVOKE_ENDPOINT && method === 'POST') {
      if (stringValue(body?.pluginId) !== TEACH_PLUGIN_ID) throw mockError(404, 40401, '插件不存在')
      return resolved(this.invoke(stringValue(body?.handler), jsonRecord(body?.input)))
    }

    throw mockError(404, 40401, '路线或航点不存在')
  }

  private invoke (handler: string, input: JsonRecord | undefined): JsonValue {
    if (handler === 'h_teach_enterRoute') return this.enter(input)
    if (handler === 'h_teach_getRouteStatus') {
      const flightId = stringValue(input?.flight_id)
      const route = [...this.routes.values()].find(item => item.flightId === flightId && item.status === 'recording')
      return { teach_route: route ? this.routeDto(route) : null }
    }
    if (handler === 'h_teach_deleteRoute') {
      return this.routeCall(numericId(input?.teach_route_id), '', 'DELETE', input)
    }
    if (handler === 'h_teach_appendWaypoint') {
      return this.routeCall(numericId(input?.teach_route_id), 'waypoints', 'POST', input)
    }
    if (handler === 'h_teach_updateWaypoint') {
      return this.waypointCall(numericId(input?.waypoint_id), false, 'PATCH', input)
    }
    if (handler === 'h_teach_deleteWaypoint') {
      return this.waypointCall(numericId(input?.waypoint_id), false, 'DELETE', input)
    }
    if (handler === 'h_teach_createScreenshotSTS') {
      return this.createScreenshotUpload(this.requireRecordingRoute(numericId(input?.teach_route_id)), input)
    }
    if (handler === 'h_teach_attachScreenshot') {
      return this.waypointCall(numericId(input?.waypoint_id), true, 'POST', input)
    }
    if (handler === 'h_teach_generateWayline') {
      return this.generate(this.requireRecordingRoute(numericId(input?.teach_route_id)), input)
    }
    throw mockError(404, 40401, 'Handler 不存在')
  }

  upload (input: PlatformObjectUploadInput): Promise<{ readonly etag: string }> {
    const upload = this.uploads.get(input.objectKey)
    if (!upload) throw mockError(404, 40401, '截图上传对象不存在')
    if (upload.blob) throw mockError(409, 40903, '截图对象已上传')
    if (input.endpoint !== MOCK_STS_ENDPOINT || input.bucket !== MOCK_STS_BUCKET
      || input.region !== MOCK_STS_REGION || input.accessKeyId !== MOCK_STS_ACCESS_KEY_ID
      || input.secretAccessKey !== MOCK_STS_SECRET_ACCESS_KEY || input.securityToken !== MOCK_STS_SECURITY_TOKEN) {
      throw mockError(403, 40301, '截图上传凭证无效')
    }
    if (input.blob.type !== 'image/jpeg') throw mockError(415, 41501, '截图上传文件类型不允许')
    if (input.blob.size > SCREENSHOT_MAX_SINGLE_BYTES) throw mockError(413, 41301, '单张截图超过 2MB')
    upload.blob = input.blob
    return Promise.resolve({ etag: `mock-${upload.waypointId}` })
  }

  dispose (): void {
    for (const route of this.routes.values()) this.releaseRoute(route)
    this.routes.clear()
    this.uploads.clear()
  }

  private enter (body: JsonRecord | undefined): JsonValue {
    const projectId = stringValue(body?.project_id)
    const flightId = stringValue(body?.flight_id)
    const dockSn = stringValue(body?.dock_sn)
    const droneSn = stringValue(body?.drone_sn)
    if (!projectId || !flightId || !dockSn || !droneSn) throw mockError(400, 40001, '参数缺失或非法')
    const existing = [...this.routes.values()].find(route => route.flightId === flightId && route.status === 'recording')
    if (existing) throw mockError(409, 40901, '该架次已有录制中的示教航线')

    const route: MockRoute = {
      id: ++this.routeSequence,
      projectId,
      flightId,
      dockSn,
      droneSn,
      createdAt: new Date().toISOString(),
      name: defaultRouteName(),
      status: 'recording',
      globalSpeed: 15,
      waypointSpeed: 5,
      screenshotBytes: 0,
      waypointCount: 0,
      waylineUuid: null,
      waylineFileId: null,
      kmzObjectKey: null,
      waypoints: [],
    }
    this.routes.set(route.id, route)
    return { teach_route_id: route.id, name: route.name }
  }

  private routeCall (
    routeId: number,
    action: string,
    method: NonNullable<ApiCallOptions['method']>,
    body: JsonRecord | undefined,
  ): JsonValue {
    const route = this.routes.get(routeId)
    if (!route) throw mockError(404, 40401, '路线不存在')
    if (!action && method === 'DELETE') {
      this.releaseRoute(route)
      this.routes.delete(routeId)
      return { deleted: true }
    }
    if (route.status !== 'recording') throw mockError(409, 40902, '路线状态不允许此操作')
    if (action === 'waypoints' && method === 'POST') return this.appendWaypoint(route, body)
    if (action === 'screenshot-sts' && method === 'POST') return this.createScreenshotUpload(route, body)
    if (action === 'generate' && method === 'POST') return this.generate(route, body)
    throw mockError(400, 40001, '请求方法不允许')
  }

  private requireRecordingRoute (routeId: number): MockRoute {
    const route = this.routes.get(routeId)
    if (!route) throw mockError(404, 40401, '路线不存在')
    if (route.status !== 'recording') throw mockError(409, 40902, '路线状态不允许此操作')
    return route
  }

  private appendWaypoint (route: MockRoute, body: JsonRecord | undefined): JsonValue {
    const required = ['longitude', 'latitude', 'height', 'camera_yaw', 'gimbal_pitch', 'focal_length'] as const
    if (!body || required.some(key => !Number.isFinite(body[key]))) throw mockError(400, 40001, '航点缺少必填项')
    if (typeof body.ai_recognition_on !== 'boolean' || !Array.isArray(body.ai_target_types)) {
      throw mockError(400, 40001, '航点缺少必填项')
    }
    const aiTargetTypes = [...new Set(body.ai_target_types.filter(item => typeof item === 'string' && VALID_AI_TARGET_TYPES.has(item)))] as string[]
    if (body.ai_recognition_on && aiTargetTypes.length === 0) throw mockError(400, 40001, 'AI 已开启但没有合法目标类型')
    const waypoint: MockWaypoint = {
      id: ++this.waypointSequence,
      seq: route.waypoints.length === 0 ? 0 : Math.max(...route.waypoints.map(item => item.seq)) + 1,
      longitude: body.longitude as number,
      latitude: body.latitude as number,
      height: body.height as number,
      cameraYaw: body.camera_yaw as number,
      gimbalPitch: body.gimbal_pitch as number,
      focalLength: body.focal_length as number,
      aiRecognitionOn: body.ai_recognition_on,
      aiTargetTypes,
      selected: true,
      screenshotFileId: null,
      screenshotUrl: null,
      screenshotBytes: 0,
    }
    route.waypoints.push(waypoint)
    return { id: waypoint.id, seq: waypoint.seq }
  }

  private createScreenshotUpload (route: MockRoute, body: JsonRecord | undefined): JsonValue {
    const waypointId = Number(body?.waypoint_id)
    if (!Number.isSafeInteger(waypointId) || waypointId <= 0
      || !route.waypoints.some(waypoint => waypoint.id === waypointId)) {
      throw mockError(400, 40001, '截图上传凭证缺少有效 waypoint_id')
    }
    const objectKeyPrefix = `teach/${route.id}/`
    const objectKey = `${objectKeyPrefix}wp_${waypointId}_${++this.uploadSequence}.jpg`
    this.uploads.set(objectKey, { routeId: route.id, waypointId, objectKey, blob: null })
    return {
      endpoint: MOCK_STS_ENDPOINT,
      bucket: MOCK_STS_BUCKET,
      region: MOCK_STS_REGION,
      object_key: objectKey,
      object_key_prefix: objectKeyPrefix,
      access_key_id: MOCK_STS_ACCESS_KEY_ID,
      secret_access_key: MOCK_STS_SECRET_ACCESS_KEY,
      security_token: MOCK_STS_SECURITY_TOKEN,
      expires_in: 900,
      use_path_style: true,
    }
  }

  private waypointCall (
    waypointId: number,
    screenshot: boolean,
    method: NonNullable<ApiCallOptions['method']>,
    body: JsonRecord | undefined,
  ): JsonValue {
    const entry = this.findWaypoint(waypointId)
    if (!entry) throw mockError(404, 40401, '航点不存在')
    const { route, waypoint } = entry
    if (route.status !== 'recording') throw mockError(409, 40902, '路线状态不允许此操作')

    if (screenshot && method === 'POST') {
      const objectKey = stringValue(body?.object_key)
      const bytes = body?.bytes
      const upload = this.uploads.get(objectKey)
      if (!objectKey || typeof bytes !== 'number' || !upload || !upload.blob
        || upload.routeId !== route.id || upload.waypointId !== waypoint.id
        || upload.blob.size !== bytes) {
        throw mockError(400, 40001, '截图元信息非法')
      }
      const nextBytes = route.screenshotBytes - waypoint.screenshotBytes + bytes
      const replacedBytes = waypoint.screenshotBytes
      if (bytes > SCREENSHOT_MAX_SINGLE_BYTES) throw mockError(413, 41301, '单张截图超过 2MB')
      if (nextBytes > SCREENSHOT_MAX_ROUTE_BYTES) throw mockError(413, 41302, '路线截图累计超过 80MB')
      if (waypoint.screenshotUrl?.startsWith('blob:')) URL.revokeObjectURL(waypoint.screenshotUrl)
      waypoint.screenshotFileId = null
      waypoint.screenshotUrl = URL.createObjectURL(upload.blob)
      waypoint.screenshotBytes = bytes
      route.screenshotBytes = nextBytes
      return {
        bytes,
        object_key: objectKey,
        replaced_bytes: replacedBytes,
        route_quota_bytes: SCREENSHOT_MAX_ROUTE_BYTES,
        route_screenshot_bytes: nextBytes,
        teach_route_id: String(route.id),
        waypoint_id: String(waypoint.id),
      }
    }
    if (!screenshot && method === 'PATCH') {
      if (typeof body?.focal_length === 'number') waypoint.focalLength = body.focal_length
      if (typeof body?.selected === 'boolean') waypoint.selected = body.selected
      return { id: waypoint.id }
    }
    if (!screenshot && method === 'DELETE') {
      if (waypoint.screenshotUrl?.startsWith('blob:')) URL.revokeObjectURL(waypoint.screenshotUrl)
      route.screenshotBytes -= waypoint.screenshotBytes
      route.waypoints.splice(route.waypoints.indexOf(waypoint), 1)
      for (const [key, upload] of this.uploads) {
        if (upload.routeId === route.id && upload.waypointId === waypoint.id) this.uploads.delete(key)
      }
      return { deleted: true }
    }
    throw mockError(400, 40001, '请求方法不允许')
  }

  private generate (route: MockRoute, body: JsonRecord | undefined): JsonValue {
    const name = stringValue(body?.name).trim()
    const globalSpeed = body?.global_speed
    const waypointSpeed = body?.waypoint_speed
    if (!name || name.length > 100 || !validSpeed(globalSpeed) || !validSpeed(waypointSpeed)) {
      throw mockError(400, 40001, '名称或速度参数非法')
    }
    const selected = route.waypoints.filter(waypoint => waypoint.selected)
    if (selected.length < 2) throw mockError(422, 42201, '至少需要 2 个选中航点')
    route.name = name
    route.globalSpeed = globalSpeed
    route.waypointSpeed = waypointSpeed
    route.status = 'generated'
    route.waypointCount = selected.length
    route.waylineUuid = `mock-wayline-${route.id}`
    route.waylineFileId = `mock-kmz-${route.id}`
    route.kmzObjectKey = `teach/${route.id}/route.kmz`
    this.releaseRoute(route)
    route.waypoints.length = 0
    return {
      wayline_uuid: route.waylineUuid,
      wayline_file_id: route.waylineFileId,
      kmz_object_key: route.kmzObjectKey,
      waypoint_count: route.waypointCount,
    }
  }

  private routeDto (route: MockRoute): JsonValue {
    return {
      id: route.id,
      project_id: route.projectId,
      name: route.name,
      flight_id: route.flightId,
      created_at: route.createdAt,
      status: route.status,
      global_speed: route.globalSpeed,
      waypoint_speed: route.waypointSpeed,
      screenshot_bytes: route.screenshotBytes,
      waypoint_count: route.status === 'recording' ? route.waypoints.length : route.waypointCount,
      wayline_uuid: route.waylineUuid,
      wayline_file_id: route.waylineFileId,
      kmz_object_key: route.kmzObjectKey,
      waypoints: route.waypoints.map(waypoint => ({
        id: waypoint.id,
        seq: waypoint.seq,
        longitude: waypoint.longitude,
        latitude: waypoint.latitude,
        height: waypoint.height,
        camera_yaw: waypoint.cameraYaw,
        gimbal_pitch: waypoint.gimbalPitch,
        focal_length: waypoint.focalLength,
        ai_recognition_on: waypoint.aiRecognitionOn,
        ai_target_types: [...waypoint.aiTargetTypes],
        selected: waypoint.selected,
        screenshot_file_id: waypoint.screenshotFileId,
        screenshot_url: waypoint.screenshotUrl,
        screenshot_bytes: waypoint.screenshotBytes,
      })),
    }
  }

  private findWaypoint (waypointId: number): { readonly route: MockRoute; readonly waypoint: MockWaypoint } | undefined {
    for (const route of this.routes.values()) {
      const waypoint = route.waypoints.find(item => item.id === waypointId)
      if (waypoint) return { route, waypoint }
    }
    return undefined
  }

  private releaseRoute (route: MockRoute): void {
    for (const waypoint of route.waypoints) {
      if (waypoint.screenshotUrl?.startsWith('blob:')) URL.revokeObjectURL(waypoint.screenshotUrl)
    }
    for (const [key, upload] of this.uploads) {
      if (upload.routeId === route.id) this.uploads.delete(key)
    }
  }
}

function resolved (data: JsonValue): Promise<JsonValue> {
  return Promise.resolve({ code: 0, message: 'ok', data })
}

function jsonRecord (value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Blob)
    ? value as JsonRecord
    : undefined
}

function stringValue (value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function numericId (value: JsonValue | undefined): number {
  const id = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw mockError(400, 40001, 'ID 参数非法')
  return id
}

function validSpeed (value: JsonValue | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.1 && value <= 15
}

function defaultRouteName (): string {
  const date = new Date()
  const twoDigits = (value: number): string => String(value).padStart(2, '0')
  return `新建巡逻航线${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}-${twoDigits(date.getHours())}-${twoDigits(date.getMinutes())}-${twoDigits(date.getSeconds())}`
}

function mockError (httpStatus: number, gatewayCode: number, message: string): Error {
  return Object.assign(new Error(message), {
    code: 'PLUGIN_GATEWAY_ERROR',
    detail: {
      stage: 'request',
      httpStatus,
      gatewayCode,
      gatewayMessage: message,
    },
  })
}
