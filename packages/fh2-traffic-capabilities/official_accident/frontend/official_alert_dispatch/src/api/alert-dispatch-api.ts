// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { JsonValue } from 'fh2-plugin-sdk'
import { unwrapApiData } from './api-response'
import type { ApiCall } from './types'

/** 派发警情的业务输入：表单五字段；高度为米。 */
export interface DispatchAlertInput {
  readonly address: string;
  readonly lat: number;
  readonly lng: number;
  readonly flyAlt: number;
  readonly goBackAlt: number;
}

/** 派发到事件中心的完整警情事件；eventId/occurredAt 由前端构造。 */
export interface DispatchAlertEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly source: string;
  readonly priority: string;
  readonly poi: { readonly lat: number; readonly lng: number };
  readonly occurredAt: string;
  readonly status: string;
  readonly notifyOn: readonly string[];
  readonly rawPayload: {
    readonly address: string;
    readonly lat: string;
    readonly lng: string;
    readonly fly_alt: number;
    readonly go_back_alt: number;
  };
}

/**
 * 构造 eventId：`MANUAL-EVENT-<YYMMDD>-<HHMMSS>-<6位随机数>`。
 * 时间与随机源可注入，保证纯函数可测。
 */
export function buildEventId (now: Date, random: () => number): string {
  const randomDigits = String(Math.floor(random() * 1_000_000)).padStart(6, '0')
  return `MANUAL-EVENT-${formatDate(now)}-${formatTime(now)}-${randomDigits}`
}

/** 组装派发事件：固定字段 + 零值 poi + 字符串坐标 rawPayload；高度保持 number，事故快处只认数字类型。 */
export function buildDispatchAlertEvent (
  input: DispatchAlertInput,
  now: Date,
  random: () => number,
): DispatchAlertEvent {
  return {
    eventId: buildEventId(now, random),
    eventType: '警情',
    source: 'cascade',
    priority: 'low',
    poi: { lat: 0, lng: 0 },
    occurredAt: now.toISOString(),
    status: 'unacknowledged',
    notifyOn: ['unacknowledged'],
    rawPayload: {
      address: input.address,
      lat: String(input.lat),
      lng: String(input.lng),
      fly_alt: input.flyAlt,
      go_back_alt: input.goBackAlt,
    },
  }
}

export interface AlertDispatchApi {
  dispatchAlert(input: DispatchAlertInput): Promise<{ readonly eventId: string }>;
}

/**
 * 手动警情派发接口。
 *
 * HTTP 字段和信封解析全部收口在本文件；调用方只接触前端业务类型。
 * 网关最终请求路径为 /plugin-api/plugin-scene/data-store/events。
 */
export function createAlertDispatchApi (
  apiCall: ApiCall,
  clock: () => Date = () => new Date(),
  random: () => number = Math.random,
): AlertDispatchApi {
  return {
    async dispatchAlert (input) {
      const event = buildDispatchAlertEvent(input, clock(), random)
      await apiCall('/plugin-scene/data-store/events', {
        method: 'POST',
        body: event as unknown as JsonValue,
      }).then(unwrapApiData)
      return { eventId: event.eventId }
    },
  }
}

function padTwo (value: number): string {
  return String(value).padStart(2, '0')
}

function formatDate (now: Date): string {
  return `${String(now.getFullYear()).slice(2)}${padTwo(now.getMonth() + 1)}${padTwo(now.getDate())}`
}

function formatTime (now: Date): string {
  return `${padTwo(now.getHours())}${padTwo(now.getMinutes())}${padTwo(now.getSeconds())}`
}
