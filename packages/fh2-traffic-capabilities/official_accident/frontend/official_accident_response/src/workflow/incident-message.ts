// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { JsonValue } from 'fh2-plugin-sdk'
import type { AccidentListItem, AccidentRecord, DispatchRequest } from './types'

export const ACCIDENT_LIST_POLL_INTERVAL_MS = 10_000

/** Project 列表发起派遣时无需重新伪造成 WS 消息。 */
export function createDispatchRequest (
  record: AccidentRecord,
  projectId: string,
  organizationId: string,
): DispatchRequest {
  if (record.latitude === undefined || record.longitude === undefined) {
    throw new Error('警情缺少经纬度，无法派遣')
  }
  return {
    popupId: '',
    receivedAt: record.createdAt,
    projectId,
    organizationId,
    pluginEventId: record.pluginEventId,
    title: record.title,
    alarmPosition: {
      lat: record.latitude,
      lng: record.longitude,
      height: record.height,
    },
    flightHeight: numberValue(record.rawPayload.fly_alt) ?? 120,
    originParams: record.rawPayload,
    level: numberValue(record.rawPayload.level) ?? 1,
    address: record.address,
    description: stringValue(record.rawPayload.desc),
    waitTime: numberValue(record.rawPayload.wait_time) ?? 0,
  }
}

export function toAccidentListItem (record: AccidentRecord): AccidentListItem {
  return {
    pluginEventId: record.pluginEventId,
    title: record.title,
    occurredAt: record.createdAt,
    status: record.status,
    address: record.address,
    hasCoordinates: record.latitude !== undefined && record.longitude !== undefined,
    ...(record.correctionNote === undefined ? {} : { correctionNote: record.correctionNote }),
    ...(record.latitude === undefined ? {} : { latitude: record.latitude }),
    ...(record.longitude === undefined ? {} : { longitude: record.longitude }),
  }
}

function stringValue (value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function numberValue (value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
