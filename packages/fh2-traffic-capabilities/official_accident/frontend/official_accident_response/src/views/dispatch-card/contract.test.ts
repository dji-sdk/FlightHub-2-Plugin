// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import {
  COLLAPSED_DEVICE_COUNT,
  estimateArrivalSeconds,
  formatRemainFlightTime,
  getDeviceBatteryDisplay,
  getRemainFlightTimeColor,
  getVisibleDispatchDevices,
  isDispatchAvailable,
} from './contract'

describe('dispatch card availability', () => {
  it('设备超过三台时默认截断，展开后显示全部', () => {
    const devices = ['dock-1', 'dock-2', 'dock-3', 'dock-4']
    expect(COLLAPSED_DEVICE_COUNT).toBe(3)
    expect(getVisibleDispatchDevices(devices, false)).toEqual(['dock-1', 'dock-2', 'dock-3'])
    expect(getVisibleDispatchDevices(devices, true)).toEqual(devices)
    expect(getVisibleDispatchDevices(devices.slice(0, 3), false)).toEqual(devices.slice(0, 3))
  })

  it('设备和路线都已选且不在加载/派遣中才可用', () => {
    const ready = {
      loadingDevices: false,
      loadingRoutes: false,
      dispatching: false,
      selectedDockSn: 'dock-1',
      selectedRouteIndex: 0,
    }
    expect(isDispatchAvailable(ready)).toBe(true)
    expect(isDispatchAvailable({ ...ready, loadingDevices: true })).toBe(false)
    expect(isDispatchAvailable({ ...ready, loadingRoutes: true })).toBe(false)
    expect(isDispatchAvailable({ ...ready, dispatching: true })).toBe(false)
    expect(isDispatchAvailable({ ...ready, selectedDockSn: '' })).toBe(false)
    expect(isDispatchAvailable({ ...ready, selectedRouteIndex: -1 })).toBe(false)
  })

  it('预估到达时间 = 距离 ÷ 15m/s + 20s 起飞准备，与原生一致', () => {
    expect(estimateArrivalSeconds(0)).toBe(20)
    expect(estimateArrivalSeconds(1500)).toBe(120)
    expect(estimateArrivalSeconds(450)).toBe(50)
  })

  it('剩余飞行时长格式化为 mm:ss，缺失或非正值不显示', () => {
    expect(formatRemainFlightTime(1250)).toBe('20:50')
    expect(formatRemainFlightTime(65)).toBe('01:05')
    expect(formatRemainFlightTime(5)).toBe('00:05')
    expect(formatRemainFlightTime(0)).toBeNull()
    expect(formatRemainFlightTime(undefined)).toBeNull()
  })

  it('剩余飞行时长颜色阈值与原生一致：≤10s 红、≤60s 橙、其余白', () => {
    expect(getRemainFlightTimeColor(10)).toBe('#E70102')
    expect(getRemainFlightTimeColor(11)).toBe('#FF9900')
    expect(getRemainFlightTimeColor(60)).toBe('#FF9900')
    expect(getRemainFlightTimeColor(61)).toBe('#FFFFFF')
  })
})

describe('getDeviceBatteryDisplay', () => {
  it('按电量分级选择图标与颜色，阈值与原生一致（≤10 红 / ≤20 橙 / <90 白 3 格 / ≥90 白 4 格）', () => {
    expect(getDeviceBatteryDisplay({ batteryPercent: 9, batteryCharging: false })).toEqual({
      icon: 'battery-level-low',
      text: '9%',
      textColor: '#E70102',
    })
    expect(getDeviceBatteryDisplay({ batteryPercent: 10, batteryCharging: false })?.icon).toBe('battery-level-low')
    expect(getDeviceBatteryDisplay({ batteryPercent: 15, batteryCharging: false })).toEqual({
      icon: 'battery-level-middle',
      text: '15%',
      textColor: '#FF9900',
    })
    expect(getDeviceBatteryDisplay({ batteryPercent: 20, batteryCharging: false })?.icon).toBe('battery-level-middle')
    expect(getDeviceBatteryDisplay({ batteryPercent: 21, batteryCharging: false })?.icon).toBe('battery-level-high')
    expect(getDeviceBatteryDisplay({ batteryPercent: 89, batteryCharging: false })?.icon).toBe('battery-level-high')
    expect(getDeviceBatteryDisplay({ batteryPercent: 90, batteryCharging: false })).toEqual({
      icon: 'battery-level-full',
      text: '90%',
      textColor: '#FFFFFF',
    })
  })

  it('充电中显示绿色充电图标，并覆盖常态分级', () => {
    expect(getDeviceBatteryDisplay({ batteryPercent: 40, batteryCharging: true })).toEqual({
      icon: 'battery-charging',
      text: '40%',
      textColor: '#00EE8B',
    })
    expect(getDeviceBatteryDisplay({ batteryPercent: 9, batteryCharging: true })?.icon).toBe('battery-charging')
  })

  it('充电中但无电量值时显示绿色 --', () => {
    expect(getDeviceBatteryDisplay({ batteryCharging: true })).toEqual({
      icon: 'battery-charging',
      text: '--',
      textColor: '#00EE8B',
    })
  })

  it('电量缺失显示灰色空电池与 --', () => {
    expect(getDeviceBatteryDisplay({})).toEqual({
      icon: 'battery-unknown',
      text: '--',
      textColor: 'rgba(255, 255, 255, 0.25)',
    })
  })
})
