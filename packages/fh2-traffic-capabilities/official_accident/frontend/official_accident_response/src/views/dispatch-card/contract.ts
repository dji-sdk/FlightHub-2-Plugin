// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk'
import type { GeoPoint, PluginViewClient } from 'fh2-plugin-sdk'
import type { DispatchDevice, DispatchRoute } from '../../workflow/types'

export interface DispatchCardState {
  readonly popupId: string;
  readonly pluginEventId: string;
  readonly title: string;
  readonly receivedAt: number;
  readonly enableMultiAngle: boolean;
  readonly status: 'idle' | 'pending' | 'dispatching' | 'dispatched' | 'closed';
  readonly projectId: string;
  readonly organizationId: string;
  readonly alarmPosition: GeoPoint | null;
  readonly requiresRoute: boolean;
  readonly devices: readonly DispatchDevice[];
  readonly selectedDockSn: string;
  readonly routes: readonly DispatchRoute[];
  readonly selectedRouteIndex: number;
  readonly loadingDevices: boolean;
  readonly loadingRoutes: boolean;
  readonly dispatching: boolean;
  readonly error: string | null;
  readonly level: number;
  readonly address: string;
  readonly description: string;
  readonly waitTime: number;
}

export const COLLAPSED_DEVICE_COUNT = 3

export function getVisibleDispatchDevices<T> (
  devices: readonly T[],
  expanded: boolean,
): readonly T[] {
  return expanded ? devices : devices.slice(0, COLLAPSED_DEVICE_COUNT)
}

export function isDispatchAvailable (
  state: Pick<DispatchCardState, 'loadingDevices' | 'loadingRoutes' | 'dispatching' | 'selectedDockSn' | 'selectedRouteIndex'>,
): boolean {
  return !state.loadingDevices && !state.loadingRoutes && !state.dispatching
    && state.selectedDockSn !== '' && state.selectedRouteIndex >= 0
}

/** 与原生设备卡一致：预估到达时间 = 距离 ÷ 15m/s + 20s 起飞准备。 */
export const DEVICE_DISPATCH_SPEED_MPS = 15
export const DEVICE_TAKEOFF_PREPARATION_SECONDS = 20

export function estimateArrivalSeconds (distanceMeters: number): number {
  return distanceMeters / DEVICE_DISPATCH_SPEED_MPS + DEVICE_TAKEOFF_PREPARATION_SECONDS
}

/** 剩余飞行时长秒数 → mm:ss；缺失或非正值返回 null（原生 v-if 不显示）。 */
export function formatRemainFlightTime (seconds: number | undefined): string | null {
  if (seconds === undefined || seconds <= 0) return null
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

/** 剩余飞行时长文字颜色，与原生 getFlightRemainTimeTextColor 一致：≤10s 红、≤60s 橙、其余白。 */
export function getRemainFlightTimeColor (seconds: number): string {
  if (seconds <= 10) return '#E70102'
  if (seconds <= 60) return '#FF9900'
  return '#FFFFFF'
}

export type DeviceBatteryIcon =
  | 'battery-level-low'
  | 'battery-level-middle'
  | 'battery-level-high'
  | 'battery-level-full'
  | 'battery-charging'
  | 'battery-unknown'

export interface DeviceBatteryDisplay {
  readonly icon: DeviceBatteryIcon;
  readonly text: string;
  readonly textColor: string;
}

// 与原生宿主原生设备详情模块 的电量颜色保持一致。
const BATTERY_TEXT_COLORS = {
  low: '#E70102',
  middle: '#FF9900',
  normal: '#FFFFFF',
  charging: '#00EE8B',
  unknown: 'rgba(255, 255, 255, 0.25)',
} as const

/**
 * 电量展示与原生 BatteryInfo 对齐：≤10% 红、≤20% 橙、其余白；充电中绿色；缺失显示 --。
 * 原生对未知电量会因 icon 分支 default 渲染成满格白图标，这里改为灰色空电池框。
 */
export function getDeviceBatteryDisplay (
  device: Pick<DispatchDevice, 'batteryPercent' | 'batteryCharging'>,
): DeviceBatteryDisplay {
  const percent = device.batteryPercent
  if (device.batteryCharging === true) {
    return { icon: 'battery-charging', text: percentText(percent), textColor: BATTERY_TEXT_COLORS.charging }
  }
  if (percent === undefined) {
    return { icon: 'battery-unknown', text: '--', textColor: BATTERY_TEXT_COLORS.unknown }
  }
  if (percent <= 10) return { icon: 'battery-level-low', text: `${percent}%`, textColor: BATTERY_TEXT_COLORS.low }
  if (percent <= 20) return { icon: 'battery-level-middle', text: `${percent}%`, textColor: BATTERY_TEXT_COLORS.middle }
  if (percent < 90) return { icon: 'battery-level-high', text: `${percent}%`, textColor: BATTERY_TEXT_COLORS.normal }
  return { icon: 'battery-level-full', text: `${percent}%`, textColor: BATTERY_TEXT_COLORS.normal }
}

function percentText (percent: number | undefined): string {
  return percent === undefined ? '--' : `${percent}%`
}

interface DispatchCardContract {
  state: DispatchCardState;
  methods: {
    close: () => void;
    refreshDevices: () => void;
    refreshRoutes: () => void;
    selectDevice: (input: { readonly dockSn: string }) => void;
    selectRoute: (input: { readonly index: number }) => void;
    dispatch: () => { readonly accepted: boolean };
    cancelDispatch: () => void;
    viewDetail: () => void;
  };
}

export const dispatchCardView = definePluginView<DispatchCardContract>('dispatch-card')
export type DispatchCardViewClient = PluginViewClient<DispatchCardContract>
