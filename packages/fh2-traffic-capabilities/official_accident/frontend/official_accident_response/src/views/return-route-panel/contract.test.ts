// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { canExecuteReturnRoute, formatRouteMeta } from './contract'

describe('return route panel contract', () => {
  it('仅 ready 且选中有效路线时允许执行', () => {
    const route = { id: 'r', source: 'road', label: '路线', totalDistance: 1, estimatedDuration: 1, waypointCount: 1, wpmzKey: 'k', wpmzUrl: '', warnings: [] }
    expect(canExecuteReturnRoute({ phase: 'ready', routes: [route], selectedIndex: 0, error: null })).toBe(true)
    expect(canExecuteReturnRoute({ phase: 'loading', routes: [route], selectedIndex: 0, error: null })).toBe(false)
    expect(canExecuteReturnRoute({ phase: 'ready', routes: [route], selectedIndex: 1, error: null })).toBe(false)
  })

  it('路线元信息与派遣卡同格式，缺失字段显示 --', () => {
    expect(formatRouteMeta({ totalDistance: 980.5, estimatedDuration: 98.1 })).toBe('980.5 m · 1 分 38 秒')
    expect(formatRouteMeta({ totalDistance: 1234.56, estimatedDuration: 45 })).toBe('1234.5 m · 45 秒')
    expect(formatRouteMeta({ totalDistance: 12345, estimatedDuration: 120 })).toBe('12.3 km · 2 分')
    expect(formatRouteMeta({ totalDistance: 0, estimatedDuration: 0 })).toBe('-- · --')
  })
})
