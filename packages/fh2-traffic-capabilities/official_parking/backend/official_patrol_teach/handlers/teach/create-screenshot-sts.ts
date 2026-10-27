// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { fail, requireText } from '../../shared/teach'
import type { Input } from '../../shared/teach'

export function h_teach_createScreenshotSTS (input: Input): Record<string, unknown> {
  const routeId = requireText(input, 'teach_route_id')
  const waypointId = input.waypoint_id === undefined || input.waypoint_id === null
    ? ''
    : String(input.waypoint_id).trim()
  if (input.waypoint_id !== undefined && input.waypoint_id !== null && waypointId === '') {
    fail('INVALID_ARGUMENT', 'waypoint_id 传了就不能是空白')
  }
  const grant = screenshot.issueUpload({ routeId, waypointId })
  return {
    access_key_id: grant.accessKeyID,
    secret_access_key: grant.secretAccessKey,
    security_token: grant.securityToken,
    endpoint: grant.endpoint,
    bucket: grant.bucket,
    region: grant.region,
    object_key_prefix: grant.objectKeyPrefix,
    expires_in: grant.expiresIn,
    use_path_style: grant.usePathStyle,
    ...(grant.objectKey === undefined ? {} : { object_key: grant.objectKey }),
  }
}
