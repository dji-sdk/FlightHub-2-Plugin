// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { isPluginError } from 'fh2-plugin-sdk'
import type { ApiCallOptions, JsonValue } from 'fh2-plugin-sdk'
import type { TeachAiTargetType, TeachRoute, TeachWaypoint } from '../workflow/teach-session'

export type ApiCall = (endpoint: string, options?: ApiCallOptions) => Promise<JsonValue>
export type TeachWaypointInput = Omit<TeachWaypoint, 'id' | 'seq' | 'screenshotFileId' | 'screenshotUrl' | 'screenshotBytes' | 'screenshotError' | 'selected'>

export interface ScreenshotUploadTarget {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly objectKey: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly securityToken: string;
  readonly usePathStyle?: boolean;
}

export interface TeachApi {
  /** 仅返回当前 recording 路线；generated 路线返回 null。 */
  getStatus(projectId: string, flightId: string): Promise<TeachRoute | null>;
  enter(input: { readonly projectId: string; readonly flightId: string; readonly dockSn: string; readonly droneSn: string }): Promise<TeachRoute>;
  deleteRoute(routeId: string): Promise<void>;
  createScreenshotUpload(routeId: string, waypointId: string): Promise<ScreenshotUploadTarget>;
  attachScreenshot(waypointId: string, input: { readonly objectKey: string; readonly bytes: number }): Promise<{
    readonly screenshotFileId: string | null;
    readonly screenshotUrl: string | null;
  }>;
  appendWaypoint(routeId: string, input: TeachWaypointInput): Promise<TeachWaypoint>;
  updateWaypoint(waypointId: string, patch: Partial<Pick<TeachWaypoint, 'focalLength' | 'selected'>>): Promise<void>;
  deleteWaypoint(waypointId: string): Promise<void>;
  generate(routeId: string, input: { readonly name: string; readonly globalSpeed: number; readonly waypointSpeed: number; readonly droneModelKey: string }): Promise<{
    readonly waylineUuid: string;
    readonly waylineFileId: string | null;
    readonly kmzObjectKey: string | null;
  }>;
}

type JsonRecord = Readonly<Record<string, JsonValue>>
const TEACH_PLUGIN_ID = 'official_patrol_teach'
const INVOKE_ENDPOINT = '/plugin/invoke'
const VALID_AI_TARGET_TYPES = new Set<TeachAiTargetType>(['person', 'car', 'boat'])

function record (value: JsonValue | undefined, message: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as JsonRecord
}

function text (value: JsonValue | undefined, field: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0) {
    throw new Error(`接口响应缺少 ${field}`)
  }
  return String(value)
}

function numberValue (value: JsonValue | undefined, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`接口响应缺少 ${field}`)
  return value
}

function nullableText (value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value ? value : null
}

function booleanValue (value: JsonValue | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function aiTargetTypes (value: JsonValue | undefined): readonly TeachAiTargetType[] {
  if (!Array.isArray(value)) return []
  const values = new Set<TeachAiTargetType>()
  for (const item of value) {
    if (typeof item === 'string' && VALID_AI_TARGET_TYPES.has(item as TeachAiTargetType)) {
      values.add(item as TeachAiTargetType)
    }
  }
  return [...values].sort()
}

function unwrap (value: JsonValue): JsonValue {
  const envelope = record(value, '接口响应格式无效')
  if (typeof envelope.code !== 'number') throw new Error('接口响应缺少 code')
  if (envelope.code !== 0) {
    const message = typeof envelope.message === 'string'
      ? envelope.message
      : typeof envelope.msg === 'string' ? envelope.msg : '接口请求失败'
    throw new Error(`${message}（code: ${envelope.code}）`)
  }
  if (!Object.prototype.hasOwnProperty.call(envelope, 'data')) throw new Error('接口响应缺少 data')
  return envelope.data ?? null
}

function waypointFromDto (value: JsonValue): TeachWaypoint {
  const dto = record(value, '航点响应格式无效')
  const screenshotFileId = nullableText(dto.screenshot_file_id)
  const screenshotUrl = nullableText(dto.screenshot_url)
  // file_id 允许为空；对象键或签名预览 URL 已足以证明截图已持久化。
  const screenshotObjectKey = nullableText(dto.screenshot_key)
    ?? nullableText(dto.screenshot_object_key)
    ?? nullableText(dto.object_key)
  return {
    id: text(dto.id, 'waypoint.id'),
    seq: numberValue(dto.seq, 'waypoint.seq'),
    longitude: numberValue(dto.longitude, 'waypoint.longitude'),
    latitude: numberValue(dto.latitude, 'waypoint.latitude'),
    height: numberValue(dto.height, 'waypoint.height'),
    cameraYaw: numberValue(dto.camera_yaw, 'waypoint.camera_yaw'),
    gimbalPitch: numberValue(dto.gimbal_pitch, 'waypoint.gimbal_pitch'),
    focalLength: numberValue(dto.focal_length, 'waypoint.focal_length'),
    aiRecognitionOn: booleanValue(dto.ai_recognition_on, false),
    aiTargetTypes: aiTargetTypes(dto.ai_target_types),
    screenshotFileId,
    screenshotUrl,
    screenshotBytes: typeof dto.screenshot_bytes === 'number' ? dto.screenshot_bytes : 0,
    screenshotError: screenshotFileId || screenshotObjectKey || screenshotUrl ? null : '截图未完成，请重试',
    selected: booleanValue(dto.selected, true),
  }
}

function routeFromDto (value: JsonValue): TeachRoute {
  const dto = record(value, '示教路线响应格式无效')
  return {
    id: text(dto.id, 'route.id'),
    projectId: text(dto.project_id, 'route.project_id'),
    name: typeof dto.name === 'string' ? dto.name : '',
    flightId: text(dto.flight_id, 'route.flight_id'),
    createdAt: nullableText(dto.created_at),
    globalSpeed: typeof dto.global_speed === 'number' ? dto.global_speed : 15,
    waypointSpeed: typeof dto.waypoint_speed === 'number' ? dto.waypoint_speed : 5,
    screenshotBytes: typeof dto.screenshot_bytes === 'number' ? dto.screenshot_bytes : 0,
    waylineUuid: nullableText(dto.wayline_uuid),
    waylineFileId: nullableText(dto.wayline_file_id),
    kmzObjectKey: nullableText(dto.kmz_object_key),
    waypointCount: typeof dto.waypoint_count === 'number'
      ? dto.waypoint_count
      : Array.isArray(dto.waypoints) ? dto.waypoints.length : 0,
    waypoints: Array.isArray(dto.waypoints) ? dto.waypoints.map(waypointFromDto) : [],
  }
}

function waypointBody (input: TeachWaypointInput): JsonRecord {
  return {
    longitude: input.longitude,
    latitude: input.latitude,
    height: input.height,
    camera_yaw: input.cameraYaw,
    gimbal_pitch: input.gimbalPitch,
    focal_length: input.focalLength,
    ai_recognition_on: input.aiRecognitionOn,
    ai_target_types: [...input.aiTargetTypes],
  }
}

export function isTeachConflictError (error: unknown): boolean {
  if (!isPluginError(error) || !error.detail || typeof error.detail !== 'object' || Array.isArray(error.detail)) return false
  const detail = error.detail as Readonly<Record<string, JsonValue>>
  return detail.httpStatus === 409 && detail.gatewayCode === 40901
}

export function isTeachStateError (error: unknown): boolean {
  if (!isPluginError(error) || !error.detail || typeof error.detail !== 'object' || Array.isArray(error.detail)) return false
  const detail = error.detail as Readonly<Record<string, JsonValue>>
  return detail.httpStatus === 409 && detail.gatewayCode === 40902
}

export function createTeachApi (apiCall: ApiCall): TeachApi {
  const call = async (endpoint: string, options?: ApiCallOptions): Promise<JsonValue> => unwrap(await apiCall(endpoint, options))
  const invoke = (handler: string, input: JsonRecord): Promise<JsonValue> => call(INVOKE_ENDPOINT, {
    method: 'POST',
    body: { pluginId: TEACH_PLUGIN_ID, handler, input },
  })
  return {
    async getStatus (projectId, flightId) {
      const data = record(await invoke('h_teach_getRouteStatus', { flight_id: flightId }), '示教状态响应格式无效')
      const route = data.teach_route
      if (route === null || route === undefined) return null
      if (record(route, '示教路线响应格式无效').status !== 'recording') return null
      const parsed = routeFromDto(route)
      if (parsed.projectId !== projectId) throw new Error('示教路线项目上下文不匹配')
      return parsed
    },
    async enter (input) {
      const data = record(await invoke('h_teach_enterRoute', {
        project_id: input.projectId,
        flight_id: input.flightId,
        dock_sn: input.dockSn,
        drone_sn: input.droneSn,
      }), '进入示教响应格式无效')
      return {
        id: text(data.teach_route_id, 'teach_route_id'),
        projectId: input.projectId,
        name: typeof data.name === 'string' ? data.name : '',
        flightId: input.flightId,
        createdAt: null,
        globalSpeed: 15,
        waypointSpeed: 5,
        screenshotBytes: 0,
        waylineUuid: null,
        waylineFileId: null,
        kmzObjectKey: null,
        waypointCount: 0,
        waypoints: [],
      }
    },
    async deleteRoute (routeId) {
      await invoke('h_teach_deleteRoute', { teach_route_id: routeId })
    },
    async createScreenshotUpload (routeId, waypointId) {
      const dto = record(await invoke('h_teach_createScreenshotSTS', {
        teach_route_id: routeId,
        waypoint_id: waypointId,
      }), '截图上传凭证格式无效')
      const usePathStyle = typeof dto.use_path_style === 'boolean'
        ? { usePathStyle: dto.use_path_style }
        : {}
      return {
        endpoint: text(dto.endpoint, 'endpoint'),
        bucket: text(dto.bucket, 'bucket'),
        region: text(dto.region, 'region'),
        objectKey: text(dto.object_key, 'object_key'),
        accessKeyId: text(dto.access_key_id, 'access_key_id'),
        secretAccessKey: text(dto.secret_access_key, 'secret_access_key'),
        securityToken: text(dto.security_token, 'security_token'),
        ...usePathStyle,
      }
    },
    async attachScreenshot (waypointId, input) {
      await invoke('h_teach_attachScreenshot', {
        waypoint_id: waypointId,
        object_key: input.objectKey,
        bytes: input.bytes,
        file_id: '',
      })
      return {
        screenshotFileId: null,
        screenshotUrl: null,
      }
    },
    async appendWaypoint (routeId, input) {
      const dto = record(await invoke('h_teach_appendWaypoint', {
        teach_route_id: routeId,
        ...waypointBody(input),
      }), '追加航点响应格式无效')
      return {
        ...input,
        id: text(dto.id, 'waypoint.id'),
        seq: numberValue(dto.seq, 'waypoint.seq'),
        screenshotFileId: null,
        screenshotUrl: null,
        screenshotBytes: 0,
        screenshotError: null,
        selected: true,
      }
    },
    async updateWaypoint (waypointId, patch) {
      await invoke('h_teach_updateWaypoint', {
        waypoint_id: waypointId,
        ...(patch.focalLength === undefined ? {} : { focal_length: patch.focalLength }),
        ...(patch.selected === undefined ? {} : { selected: patch.selected }),
      })
    },
    async deleteWaypoint (waypointId) {
      await invoke('h_teach_deleteWaypoint', { waypoint_id: waypointId })
    },
    async generate (routeId, input) {
      const droneModelKey = input.droneModelKey?.trim()
      if (!droneModelKey) throw new Error('无人机机型不可用，无法生成示教航线')
      const dto = record(await invoke('h_teach_generateWayline', {
        teach_route_id: routeId,
        name: input.name,
        global_speed: input.globalSpeed,
        waypoint_speed: input.waypointSpeed,
        // 无人机原始机型 key（domain-type-subtype，如 '0-100-1'）；
        // 后端生成 KMZ 的机型声明依赖此必填字段，不能省略后交给默认机型兜底。
        drone_model_key: droneModelKey,
      }), '航线生成响应格式无效')
      return {
        waylineUuid: text(dto.wayline_uuid, 'wayline_uuid'),
        waylineFileId: nullableText(dto.wayline_file_id),
        kmzObjectKey: nullableText(dto.kmz_object_key),
      }
    },
  }
}
