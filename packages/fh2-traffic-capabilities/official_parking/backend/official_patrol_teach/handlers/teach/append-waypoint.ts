// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createStoreRecord, queryStore } from '../../shared/store'
import {
  STATUS_RECORDING,
  boolText,
  fail,
  numOr,
  requireBoolean,
  requireNumber,
  requireRange,
  requireText,
  text,
  waypointView,
} from '../../shared/teach'
import type { Input, TeachWaypoint } from '../../shared/teach'

const AI_TARGET_TYPES = ['boat', 'car', 'person'] as const
const MAX_SEQ = 999999
const MAX_SEQ_RETRY = 3

function normalizeAiTargetTypes (value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail('INVALID_ARGUMENT', 'ai_target_types 必须是数组')
  const values: string[] = []
  for (const item of value) {
    const target = text(item).trim()
    if ((AI_TARGET_TYPES as readonly string[]).includes(target) && !values.includes(target)) values.push(target)
  }
  return values.sort()
}

function droppedAiTargetTypes (value: unknown, kept: readonly string[]): string[] {
  if (!Array.isArray(value)) return []
  const values: string[] = []
  for (const item of value) {
    const target = text(item).trim()
    if (!kept.includes(target) && !values.includes(target)) values.push(target)
  }
  return values
}

function previewAiTargetTypes (values: readonly string[]): string {
  if (values.length === 0) return ''
  const shown = values.slice(0, 5).map(value => value.length > 24 ? `${value.slice(0, 24)}…` : value)
  if (values.length > shown.length) shown.push('…')
  return `:${shown.join(' / ')}`
}

function nextSequence (routeId: string): number {
  const page = queryStore('teach_waypoint',
    { teach_route_id: { eq: routeId } },
    { limit: 1, orderBy: [{ field: 'seq', dir: 'desc' }] },
  )
  const sequence = (page.list[0] === undefined ? -1 : numOr(page.list[0].seq, -1)) + 1
  if (sequence > MAX_SEQ) fail('LIMIT_EXCEEDED', `这条航线的航点数已达上限(seq 最大 ${MAX_SEQ}),不能再追加`)
  return sequence
}

function paddedSequence (value: number): string {
  return String(value).padStart(6, '0')
}

export function h_teach_appendWaypoint (input: Input): ReturnType<typeof waypointView> {
  const routeId = requireText(input, 'teach_route_id')
  const latitude = requireRange('latitude', requireNumber(input, 'latitude'), -90, 90)
  const longitude = requireRange('longitude', requireNumber(input, 'longitude'), -180, 180)
  const height = requireNumber(input, 'height')
  const gimbalPitch = requireRange('gimbal_pitch', requireNumber(input, 'gimbal_pitch'), -90, 90)
  const cameraYaw = requireRange('camera_yaw', requireNumber(input, 'camera_yaw'), -180, 180)
  const focalLength = requireNumber(input, 'focal_length')
  if (focalLength <= 0) fail('INVALID_ARGUMENT', 'focal_length 必须大于 0')
  const aiRecognitionOn = requireBoolean(input, 'ai_recognition_on')
  const aiTargetTypes = normalizeAiTargetTypes(input.ai_target_types)
  const dropped = droppedAiTargetTypes(input.ai_target_types, aiTargetTypes)
  if (aiRecognitionOn && aiTargetTypes.length === 0) {
    const received = Array.isArray(input.ai_target_types) ? input.ai_target_types.length : 0
    fail('INVALID_ARGUMENT', `ai_recognition_on 为 true 时 ai_target_types 不能为空(收到 ${received} 个类型${previewAiTargetTypes(dropped)}${received > 0 ? ',白名单里一个都不认识' : ''};合法值只有 ${AI_TARGET_TYPES.join(' / ')} —— ⚠️ 小写,且 vehicle 不是 car 的同义词)`)
  }

  const route = queryStore('teach_route', { id: { eq: routeId } }, { limit: 1 }).list[0]
  if (route === undefined) fail('NOT_FOUND', `航线不存在(teach_route_id=${routeId})`)
  if (route.status !== STATUS_RECORDING) {
    fail('CONFLICT', `航线不在录制中(teach_route_id=${routeId},status=${route.status}),已生成的航线不能再追加航点`)
  }

  let created: TeachWaypoint | undefined
  for (let attempt = 1; attempt <= MAX_SEQ_RETRY; attempt += 1) {
    const sequence = paddedSequence(nextSequence(routeId))
    const result = createStoreRecord('teach_waypoint', {
      teach_route_id: routeId,
      seq: sequence,
      latitude: String(latitude),
      longitude: String(longitude),
      height: String(height),
      gimbal_pitch: String(gimbalPitch),
      camera_yaw: String(cameraYaw),
      focal_length: String(focalLength),
      ai_recognition_on: boolText(aiRecognitionOn),
      ai_target_types: aiTargetTypes.join(','),
      screenshot_file_id: '',
      screenshot_key: '',
      screenshot_bytes: '0',
      selected: boolText(true),
    }, ['teach_route_id', 'seq'])
    if (result.created) {
      created = result.record
      break
    }
    log.warn('追加航点:seq 撞车,重试', { teach_route_id: routeId, seq: sequence, attempt })
  }
  if (created === undefined) fail('CONFLICT', `航点序号连续 ${MAX_SEQ_RETRY} 次被占用,请重试(多半是同一架次开了两个页面同时在录)`)

  log.info('追加航点', {
    teach_route_id: routeId,
    waypoint_id: created.id,
    seq: numOr(created.seq, -1),
    ai_recognition_on: aiRecognitionOn,
  })
  if (dropped.length > 0) {
    log.warn('追加航点:AI 目标类型被部分丢弃(白名单外)', {
      teach_route_id: routeId,
      waypoint_id: created.id,
      dropped_types: dropped.join(','),
      kept_types: aiTargetTypes.join(','),
    })
  }
  return waypointView(created)
}
