// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk'
import type { PluginViewClient } from 'fh2-plugin-sdk'
import type { AccidentListItem, AllEventsPage, AllEventsQuery, EventStatus } from '../../workflow/types'

export type {
  AccidentListItem,
  AllEventItem,
  AllEventsPage,
  AllEventsQuery,
  EventStatus,
} from '../../workflow/types'

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/

/** 解析十进制度数文本：允许负数、整数与任意位小数；拒绝科学计数法、逗号、多个小数点等。 */
export function parseDecimalInput (value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!DECIMAL_PATTERN.test(trimmed)) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseCoordinateInput (
  value: string,
  range: { readonly min: number; readonly max: number },
): number | null {
  const parsed = parseDecimalInput(value)
  if (parsed === null) return null
  return parsed >= range.min && parsed <= range.max ? parsed : null
}

export interface ParsedCoordinates {
  readonly lat: number;
  readonly lng: number;
}

/** 经度 + 纬度校验：(0,0) 视为无效，单独 0 合法。 */
export function parseCoordinatePair (latText: string, lngText: string): ParsedCoordinates | null {
  const lat = parseCoordinateInput(latText, { min: -90, max: 90 })
  const lng = parseCoordinateInput(lngText, { min: -180, max: 180 })
  if (lat === null || lng === null) return null
  if (lat === 0 && lng === 0) return null
  return { lat, lng }
}

/**
 * 解析单字段「纬度,经度」文本——与地图右键「获取并复制经纬度」的复制格式一致。
 * 逗号分隔，允许多余空白；多余逗号、中文逗号、缺项均视为无效。
 */
export function parseCoordinateText (value: string): ParsedCoordinates | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const separatorIndex = trimmed.indexOf(',')
  if (separatorIndex === -1) return null
  return parseCoordinatePair(
    trimmed.slice(0, separatorIndex),
    trimmed.slice(separatorIndex + 1),
  )
}

/** 签收超时窗口：报警时间 + 60 分钟。 */
export const ACK_TIMEOUT_MS = 60 * 60 * 1000

export type ExpiryHint = '' | '10分钟后超时' | '5分钟后超时' | '即将超时'

/**
 * 未签收事件按剩余签收时间分级提示：
 * 剩余 ≤10 分钟且 >5 分钟「10分钟后超时」，≤5 分钟且 >1 分钟「5分钟后超时」，≤1 分钟「即将超时」。
 */
export function getExpiryHint (status: EventStatus, occurredAt: number, now: number): ExpiryHint {
  if (status !== 'unacknowledged') return ''
  const remaining = occurredAt + ACK_TIMEOUT_MS - now
  if (remaining <= 0) return ''
  if (remaining <= 60_000) return '即将超时'
  if (remaining <= 5 * 60_000) return '5分钟后超时'
  if (remaining <= 10 * 60_000) return '10分钟后超时'
  return ''
}

interface AccidentListContract {
  state: {
    readonly items: readonly AccidentListItem[];
    readonly loading: boolean;
    /** 当前选中警情 id；空串表示无选中。 */
    readonly selectedId: string;
  };
  methods: {
    handle: (input: { readonly pluginEventId: string }) => void;
    /** 点击卡片切换选中态；选中时地图渲染告警点并回中。 */
    selectEvent: (input: { readonly pluginEventId: string }) => void;
    submitFeedback: (input: { readonly pluginEventId: string; readonly note: string }) => void;
    ignoreIncident: (input: { readonly pluginEventId: string }) => void;
    submitCoordinates: (input: { readonly pluginEventId: string; readonly lat: number; readonly lng: number }) => void;
    openAllEventsDialog: () => void;
  };
}

interface AllEventsDialogContract {
  state: null;
  methods: {
    loadAllEvents: (input: AllEventsQuery) => AllEventsPage;
    /** 查询飞行任务的媒体文件夹 id；未就绪或接口失败返回 null，不弹错误通知。 */
    getMediaFolderId: (input: { readonly flightMissionId: string }) => string | null;
    /** 新标签打开飞行记录：/organization/{orgId}/project/{projectId}#/flight-path?id={flightMissionId} */
    openFlightRecord: (input: { readonly flightMissionId: string }) => void;
    /** 新标签打开媒体库：/organization/{orgId}/project/{projectId}#/media?pid={folderId} */
    openMediaLibrary: (input: { readonly folderId: string }) => void;
  };
}

export const accidentListView = definePluginView<AccidentListContract>('accident-list')
export type AccidentListViewClient = PluginViewClient<AccidentListContract>
export const allEventsDialogView = definePluginView<AllEventsDialogContract>('all-events-dialog')
export type AllEventsDialogViewClient = PluginViewClient<AllEventsDialogContract>
