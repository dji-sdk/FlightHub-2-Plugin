// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { queryStore } from './store'
import type { StoreRecord, WaylineGenerateIntent } from 'fh2-plugin-sdk/backend'

export type Input = Readonly<Record<string, unknown>>
export type TeachRoute = StoreRecord
export type TeachWaypoint = StoreRecord

export const STATUS_RECORDING = 'recording'
export const STATUS_GENERATED = 'generated'
export const DEFAULT_GLOBAL_SPEED = 15
export const DEFAULT_WAYPOINT_SPEED = 5
export const WAYPOINT_PAGE_SIZE = 1000
export const MAX_WAYPOINT_PAGES = 5

export interface WaypointView {
  readonly id: string
  readonly seq: number
  readonly latitude: number
  readonly longitude: number
  readonly height: number
  readonly gimbal_pitch: number
  readonly camera_yaw: number
  readonly focal_length: number
  readonly ai_recognition_on: boolean
  readonly ai_target_types: readonly string[]
  readonly screenshot_file_id: string
  readonly screenshot_key: string
  readonly screenshot_bytes: number
  readonly screenshot_url: string
  readonly selected: boolean
  readonly created_at: string
  readonly updated_at: string
}

export function fail (code: string, message: string): never {
  throw { code, message }
}

export function text (value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

export function requireText (input: Input, key: string): string {
  const value = text(input[key]).trim()
  if (value === '') fail('INVALID_ARGUMENT', `${key} 不能为空`)
  return value
}

export function codePointLength (value: string): number {
  return Array.from(value).length
}

export function requireIdText (input: Input, key: string): string {
  const value = requireText(input, key)
  if (codePointLength(value) > 64) fail('INVALID_ARGUMENT', `${key} 超过 64 字`)
  return value
}

export function numOr (value: unknown, fallback: number): number {
  const numberValue = Number(value)
  return text(value).trim() === '' || !Number.isFinite(numberValue) ? fallback : numberValue
}

export function isTrue (value: unknown): boolean {
  return value === 'true'
}

export function boolText (value: boolean): string {
  return value ? 'true' : 'false'
}

export function requireNumber (input: Input, key: string): number {
  const value = input[key]
  if (value === undefined || value === null || value === '' || typeof value === 'boolean') {
    fail('INVALID_ARGUMENT', `${key} 不能为空`)
  }
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) fail('INVALID_ARGUMENT', `${key} 不是一个有效数字`)
  return numberValue
}

export function requireRange (key: string, value: number, minimum: number, maximum: number): number {
  if (value < minimum || value > maximum) fail('INVALID_ARGUMENT', `${key} 超出 [${minimum}, ${maximum}]`)
  return value
}

export function requireBoolean (input: Input, key: string): boolean {
  const value = input[key]
  if (value === true || value === false) return value
  return fail('INVALID_ARGUMENT', `${key} 必须是布尔 true / false(不传与传 false 是两回事,不能省)`)
}

export function hasField (input: Input, key: string): boolean {
  return input[key] !== undefined && input[key] !== null
}

export function optionalBoolean (input: Input, key: string): boolean {
  const value = input[key]
  if (value === true || value === false) return value
  return fail('INVALID_ARGUMENT', `${key} 必须是布尔 true / false(不传表示不改,传了就得是真布尔)`)
}

export function optionalSpeed (input: Input, key: string): number | undefined {
  const value = input[key]
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') fail('INVALID_ARGUMENT', `${key} 不是一个有效数字`)
  const speed = Number(value)
  if (!Number.isFinite(speed)) fail('INVALID_ARGUMENT', `${key} 不是一个有效数字`)
  if (speed < 0.1 || speed > 15) fail('INVALID_ARGUMENT', `${key} 必须在 [0.1, 15] m/s 之间`)
  return speed
}

export function routeFor (routeId: string): TeachRoute {
  const page = queryStore('teach_route', { id: { eq: routeId } }, { limit: 1 })
  const route = page.list[0]
  return route ?? fail('NOT_FOUND', `航线不存在(teach_route_id=${routeId})`)
}

export function waypointFor (waypointId: string): TeachWaypoint {
  const page = queryStore('teach_waypoint', { id: { eq: waypointId } }, { limit: 1 })
  const waypoint = page.list[0]
  return waypoint ?? fail('NOT_FOUND', `航点不存在(waypoint_id=${waypointId})`)
}

export function fetchWaypoints (routeId: string): { readonly list: readonly WaypointView[]; readonly truncated: boolean } {
  const list: WaypointView[] = []
  for (let pageNumber = 0; pageNumber < MAX_WAYPOINT_PAGES; pageNumber += 1) {
    const page = queryStore('teach_waypoint',
      { teach_route_id: { eq: routeId } },
      { limit: WAYPOINT_PAGE_SIZE, offset: pageNumber * WAYPOINT_PAGE_SIZE, orderBy: [{ field: 'seq', dir: 'asc' }] },
    )
    list.push(...page.list.map(waypointView))
    if (page.list.length < WAYPOINT_PAGE_SIZE) return { list, truncated: false }
    if (pageNumber === MAX_WAYPOINT_PAGES - 1) return { list, truncated: page.total > list.length }
  }
  return { list, truncated: false }
}

export function fetchSelectedWaypoints (routeId: string): readonly TeachWaypoint[] {
  const list: TeachWaypoint[] = []
  for (let pageNumber = 0; pageNumber < MAX_WAYPOINT_PAGES; pageNumber += 1) {
    const page = queryStore('teach_waypoint',
      { teach_route_id: { eq: routeId }, selected: { eq: 'true' } },
      { limit: WAYPOINT_PAGE_SIZE, offset: pageNumber * WAYPOINT_PAGE_SIZE, orderBy: [{ field: 'seq', dir: 'asc' }] },
    )
    list.push(...page.list)
    if (page.list.length < WAYPOINT_PAGE_SIZE) return list
  }
  return fail('INVALID_ARGUMENT', `选中的航点超过 ${MAX_WAYPOINT_PAGES * WAYPOINT_PAGE_SIZE} 个,一次生成不了(平台单次查询上限 ${WAYPOINT_PAGE_SIZE} 行 × ${MAX_WAYPOINT_PAGES} 页)。请取消勾选一部分航点后重试 —— 航点与录制内容都还在,这一步没有改动任何东西`)
}

export function waypointView (waypoint: TeachWaypoint): WaypointView {
  const screenshotKey = text(waypoint.screenshot_key)
  return {
    id: waypoint.id,
    seq: numOr(waypoint.seq, -1),
    latitude: numOr(waypoint.latitude, 0),
    longitude: numOr(waypoint.longitude, 0),
    height: numOr(waypoint.height, 0),
    gimbal_pitch: numOr(waypoint.gimbal_pitch, 0),
    camera_yaw: numOr(waypoint.camera_yaw, 0),
    focal_length: numOr(waypoint.focal_length, 0),
    ai_recognition_on: isTrue(waypoint.ai_recognition_on),
    ai_target_types: text(waypoint.ai_target_types) === '' ? [] : text(waypoint.ai_target_types).split(','),
    screenshot_file_id: text(waypoint.screenshot_file_id),
    screenshot_key: screenshotKey,
    screenshot_bytes: numOr(waypoint.screenshot_bytes, 0),
    screenshot_url: screenshotKey === '' ? '' : screenshot.signUrl(screenshotKey),
    selected: isTrue(waypoint.selected),
    created_at: waypoint.createdAt,
    updated_at: waypoint.updatedAt,
  }
}

export function routeView (
  route: TeachRoute,
  waypoints: readonly WaypointView[],
  truncated: boolean,
): Record<string, unknown> {
  return {
    id: route.id,
    project_id: text(route.project_id),
    name: text(route.name),
    flight_id: text(route.flight_id),
    dock_sn: text(route.dock_sn),
    drone_sn: text(route.drone_sn),
    status: text(route.status),
    global_speed: numOr(route.global_speed, DEFAULT_GLOBAL_SPEED),
    waypoint_speed: numOr(route.waypoint_speed, DEFAULT_WAYPOINT_SPEED),
    wayline_uuid: text(route.wayline_uuid),
    wayline_file_id: text(route.wayline_file_id),
    kmz_object_key: text(route.kmz_object_key),
    screenshot_bytes: numOr(route.screenshot_bytes, 0),
    created_at: route.createdAt,
    updated_at: route.updatedAt,
    waypoints,
    waypoints_truncated: truncated,
  }
}

export function summaryView (route: TeachRoute, waypointCount: number): Record<string, unknown> {
  return {
    id: route.id,
    project_id: text(route.project_id),
    name: text(route.name),
    flight_id: text(route.flight_id),
    dock_sn: text(route.dock_sn),
    drone_sn: text(route.drone_sn),
    status: text(route.status),
    global_speed: numOr(route.global_speed, DEFAULT_GLOBAL_SPEED),
    waypoint_speed: numOr(route.waypoint_speed, DEFAULT_WAYPOINT_SPEED),
    waypoint_count: waypointCount,
    wayline_uuid: text(route.wayline_uuid),
    screenshot_bytes: numOr(route.screenshot_bytes, 0),
    created_at: route.createdAt,
    updated_at: route.updatedAt,
  }
}

export function buildDefaultRouteName (now: string): string {
  const milliseconds = Date.parse(now)
  if (!Number.isFinite(milliseconds)) return '新建巡逻航线'
  const date = new Date(milliseconds + 8 * 60 * 60 * 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `新建巡逻航线${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}`
}

export function toWaylineIntent (
  route: TeachRoute,
  name: string,
  globalSpeed: number,
  waypointSpeed: number,
  droneEnumKey: string,
  payloadEnumKey: string,
  waypoints: readonly TeachWaypoint[],
): WaylineGenerateIntent {
  return {
    name,
    projectId: text(route.project_id),
    globalSpeed,
    waypointSpeed,
    droneEnumKey,
    // 载荷 key 可选:仅非空时出现。空串传给能力面会被 str() 解析成 "",与未传无法区分,
    // 但 worker 侧按"空=payload 缺省"处理,这里保持显式缺省语义。
    ...(payloadEnumKey === '' ? {} : { payloadEnumKey }),
    waypoints: waypoints.map(waypoint => ({
      latitude: numOr(waypoint.latitude, 0),
      longitude: numOr(waypoint.longitude, 0),
      height: numOr(waypoint.height, 0),
      gimbalPitch: numOr(waypoint.gimbal_pitch, 0),
      cameraYaw: numOr(waypoint.camera_yaw, 0),
      focalLength: numOr(waypoint.focal_length, 0),
      aiRecognitionOn: isTrue(waypoint.ai_recognition_on),
      aiTargetTypes: legalAITypes(waypoint.ai_target_types),
    })),
  }
}

export function legalAITypes (value: unknown): readonly string[] {
  const valid = new Set(['boat', 'car', 'person'])
  return text(value).split(',').map(item => item.trim()).filter((item, index, values) => valid.has(item) && values.indexOf(item) === index)
}
