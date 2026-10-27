// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { deleteStoreRecords, updateStoreRecord } from '../../shared/store'
import {
  DEFAULT_GLOBAL_SPEED,
  DEFAULT_WAYPOINT_SPEED,
  STATUS_GENERATED,
  STATUS_RECORDING,
  fail,
  fetchSelectedWaypoints,
  legalAITypes,
  numOr,
  optionalSpeed,
  requireText,
  routeFor,
  text,
  toWaylineIntent,
} from '../../shared/teach'
import type { Input } from '../../shared/teach'

function errorMessage (error: unknown): string {
  const message = error !== null && typeof error === 'object' && 'message' in error ? error.message : undefined
  return String(message || error)
}

function assertAiTargets (waypoints: ReturnType<typeof fetchSelectedWaypoints>): void {
  const invalidSequences = waypoints
    .filter(waypoint => waypoint.ai_recognition_on === 'true' && legalAITypes(waypoint.ai_target_types).length === 0)
    .map(waypoint => numOr(waypoint.seq, -1))
  if (invalidSequences.length > 0) {
    fail('INVALID_ARGUMENT', `第 ${invalidSequences.join(', ')} 个航点(seq)开启了 AI 识别但没有合法目标类型(只允许 boat / car / person),请关掉这些点的 AI 或补上类型后重新生成`)
  }
}

export function h_teach_generateWayline (input: Input): Record<string, unknown> {
  const routeId = requireText(input, 'teach_route_id')
  const name = requireText(input, 'name')
  if (name.length > 128) fail('INVALID_ARGUMENT', `name 超过 128 字(当前 ${name.length})`)
  // 机型 key 来自 DJI 设备拓扑的 device_enum_key(三段式 domain-type-subtype)。
  // drone 必传:漏传会让能力面按 M4D 兜底,产物静默错配(能飞、拍的不对);
  // payload 可选:同机身多云台机型(如 H30/H30T)必须传,其余机型由宿主按机身推导。
  const droneEnumKey = requireText(input, 'drone_model_key')
  const payloadEnumKey = text(input.payload_model_key).trim()
  const route = routeFor(routeId)
  if (route.status !== STATUS_RECORDING) {
    fail('CONFLICT', `teach_route_id=${routeId} 当前状态是 ${route.status},只有 ${STATUS_RECORDING} 状态可以生成航线(${STATUS_GENERATED} 是终态,请新建一条重新示教)`)
  }
  const globalSpeed = optionalSpeed(input, 'global_speed') ?? numOr(route.global_speed, DEFAULT_GLOBAL_SPEED)
  const waypointSpeed = optionalSpeed(input, 'waypoint_speed') ?? numOr(route.waypoint_speed, DEFAULT_WAYPOINT_SPEED)
  const waypoints = fetchSelectedWaypoints(routeId)
  if (waypoints.length < 2) fail('INVALID_ARGUMENT', `当前选中 ${waypoints.length} 个航点,至少需要 2 个`)
  assertAiTargets(waypoints)

  let generated: ReturnType<typeof wayline.generate>
  try {
    generated = wayline.generate(toWaylineIntent(route, name, globalSpeed, waypointSpeed, droneEnumKey, payloadEnumKey, waypoints))
  } catch (error) {
    log.error('生成示教航线失败(能力面)', {
      teach_route_id: routeId,
      waypoint_count: waypoints.length,
      global_speed: globalSpeed,
      waypoint_speed: waypointSpeed,
      drone_model_key: droneEnumKey,
      reason: errorMessage(error),
    })
    return fail('INTERNAL', '航线上传失败,录制内容已保留,请稍后重试')
  }
  let finalName = text(generated.name)
  if (finalName === '') {
    log.warn('航线登记回了空名字,兜底用请求里的 name', {
      teach_route_id: routeId,
      wayline_uuid: generated.waylineUuid,
    })
    finalName = name
  }
  const affected = updateStoreRecord('teach_route', { id: { eq: routeId }, status: { eq: STATUS_RECORDING } }, {
    status: STATUS_GENERATED,
    name: finalName,
    wayline_uuid: generated.waylineUuid,
    wayline_file_id: '',
    kmz_object_key: generated.objectKey,
    // ★ 生成必须释放同架次锁:recording_flight_id 置 null(不是空串!),
    //   同一架次可以「生成→继续录→再生成」串行多段。NULL 在唯一索引里互不相等,
    //   任意多条 generated 航线共存不撞;空串会判重,第二条航线生成时就 23505。
    //   置 null 的链路:JS null → storehost 导出 nil → datastore 原样绑 NULL。
    recording_flight_id: null,
    // ★ 落库是字符串(业务列一律 text)。
    global_speed: String(globalSpeed),
    waypoint_speed: String(waypointSpeed),
  })
  if (affected === 0) {
    log.warn('生成示教航线:抢占失败,上游留下一条孤儿航线', {
      teach_route_id: routeId,
      orphan_wayline_uuid: generated.waylineUuid,
      orphan_object_key: generated.objectKey,
      orphan_wayline_name: finalName,
    })
    fail('CONFLICT', `航线不存在,或已被另一次生成占用(teach_route_id=${routeId}),请刷新查看`)
  }

  let deletedWaypoints = 0
  try {
    deletedWaypoints = deleteStoreRecords('teach_waypoint', { teach_route_id: { eq: routeId } })
  } catch (error) {
    log.warn('生成示教航线:航线已置终态但航点没删干净(脏数据,不影响航线)', {
      teach_route_id: routeId,
      wayline_uuid: generated.waylineUuid,
      reason: errorMessage(error),
    })
  }
  log.info('生成示教航线', {
    teach_route_id: routeId,
    wayline_uuid: generated.waylineUuid,
    object_key: generated.objectKey,
    name: finalName,
    global_speed: globalSpeed,
    waypoint_speed: waypointSpeed,
    drone_model_key: droneEnumKey,
    waypoints_in_kmz: waypoints.length,
    deleted_waypoints: deletedWaypoints,
  })
  return {
    teach_route_id: routeId,
    wayline_uuid: generated.waylineUuid,
    wayline_file_id: '',
    kmz_object_key: generated.objectKey,
    name: finalName,
    waypoint_count: waypoints.length,
    deleted_waypoints: deletedWaypoints,
  }
}
