// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { queryStore, updateStoreRecord } from '../../shared/store'
import {
  DEFAULT_GLOBAL_SPEED,
  MAX_WAYPOINT_PAGES,
  STATUS_RECORDING,
  WAYPOINT_PAGE_SIZE,
  fail,
  fetchWaypoints,
  hasField,
  numOr,
  requireText,
  routeView,
  text,
} from '../../shared/teach'
import type { Input } from '../../shared/teach'
import type { StoreFields } from 'fh2-plugin-sdk/backend'

export function h_teach_updateRoute (input: Input): Record<string, unknown> {
  const routeId = requireText(input, 'teach_route_id')
  const patch: Partial<StoreFields> = {}
  const changed: string[] = []
  if (hasField(input, 'name')) {
    const name = String(input.name).trim()
    if (name === '') fail('INVALID_ARGUMENT', 'name 不能为空或全空格')
    if (name.length > 128) fail('INVALID_ARGUMENT', `name 超过 128 字(当前 ${name.length})`)
    patch.name = name
    changed.push('name')
  }
  if (hasField(input, 'global_speed')) {
    if (typeof input.global_speed === 'boolean') fail('INVALID_ARGUMENT', 'global_speed 不是一个有效数字')
    const speed = Number(input.global_speed)
    if (!Number.isFinite(speed)) fail('INVALID_ARGUMENT', 'global_speed 不是一个有效数字')
    if (speed < 0.1 || speed > 15) fail('INVALID_ARGUMENT', 'global_speed 必须在 [0.1, 15] m/s 之间')
    patch.global_speed = String(speed)
    changed.push('global_speed')
  }
  if (changed.length === 0) fail('INVALID_ARGUMENT', 'name 与 global_speed 至少要传一个(waypoint_speed 不可改 —— 它与 global_speed 喂给 KMZ 的是不同位置)')
  if (updateStoreRecord('teach_route', { id: { eq: routeId }, status: { eq: STATUS_RECORDING } }, patch) === 0) {
    fail('CONFLICT', `航线不存在,或已生成(teach_route_id=${routeId};generated 是终态 —— 名字与速度已经烧进 KMZ,改库里这份会让两边对不上)`)
  }
  const route = queryStore('teach_route', { id: { eq: routeId } }, { limit: 1 }).list[0]
  if (route === undefined) fail('NOT_FOUND', `航线已被删除(teach_route_id=${routeId})`)
  const waypoints = fetchWaypoints(routeId)
  if (waypoints.truncated) {
    log.warn('改航线:航点数超过上限,已截断', {
      teach_route_id: routeId,
      returned: waypoints.list.length,
      max_pages: MAX_WAYPOINT_PAGES,
      page_size: WAYPOINT_PAGE_SIZE,
    })
  }
  log.info('改航线', {
    teach_route_id: routeId,
    changed: changed.join(','),
    name: text(route.name),
    global_speed: numOr(route.global_speed, DEFAULT_GLOBAL_SPEED),
    waypoint_count: waypoints.list.length,
  })
  return routeView(route, waypoints.list, waypoints.truncated)
}
