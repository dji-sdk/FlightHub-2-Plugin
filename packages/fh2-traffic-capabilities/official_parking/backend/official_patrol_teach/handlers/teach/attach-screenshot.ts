// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { updateStoreRecord } from '../../shared/store'
import { fail, requireText, text, waypointFor } from '../../shared/teach'
import type { Input } from '../../shared/teach'
import type { StoreFields } from 'fh2-plugin-sdk/backend'

const MAX_SINGLE_BYTES = 2 * 1024 * 1024

export function h_teach_attachScreenshot (input: Input): Record<string, unknown> {
  const waypointId = requireText(input, 'waypoint_id')
  const objectKey = requireText(input, 'object_key')
  if (typeof input.bytes === 'boolean' || input.bytes === undefined || input.bytes === null) {
    fail('INVALID_ARGUMENT', 'bytes 必须是正整数')
  }
  const bytes = Number(input.bytes)
  if (!Number.isInteger(bytes) || bytes <= 0) fail('INVALID_ARGUMENT', 'bytes 必须是正整数')
  if (bytes > MAX_SINGLE_BYTES) fail('INVALID_ARGUMENT', '单张截图超过 2 MiB')
  if (objectKey.length > 4096) fail('INVALID_ARGUMENT', 'object_key 过长')

  const waypoint = waypointFor(waypointId)
  const routeId = text(waypoint.teach_route_id)
  if (!objectKey.includes(`teach/${routeId}/`)) {
    fail('INVALID_ARGUMENT', 'object_key 前缀与航点所属航线不匹配')
  }
  const fileId = text(input.file_id).trim()
  const patch: Partial<StoreFields> = {
    screenshot_key: objectKey,
    screenshot_bytes: String(bytes),
  }
  if (fileId !== '') patch.screenshot_file_id = fileId
  if (updateStoreRecord('teach_waypoint', { id: { eq: waypointId } }, patch) === 0) {
    fail('NOT_FOUND', `航点不存在或已被删除(waypoint_id=${waypointId})`)
  }
  const previousKey = text(waypoint.screenshot_key)
  if (previousKey !== '' && previousKey !== objectKey) {
    log.warn('截图已替换:旧截图对象成为孤儿(本插件不删对象存储)', {
      waypoint_id: waypointId,
      teach_route_id: routeId,
      orphan_screenshot_key: previousKey,
    })
  }
  log.info('登记截图', {
    waypoint_id: waypointId,
    teach_route_id: routeId,
    object_key: objectKey,
    bytes,
  })
  return { waypoint_id: waypointId, teach_route_id: routeId, object_key: objectKey, bytes }
}
