// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { formatDistance, formatDuration } from './route-format'

describe('route format', () => {
  it('估计时长格式化为分钟加秒', () => {
    expect(formatDuration(112.6)).toBe('1 分 53 秒')
    expect(formatDuration(83.8)).toBe('1 分 24 秒')
    expect(formatDuration(45)).toBe('45 秒')
    expect(formatDuration(120)).toBe('2 分')
    expect(formatDuration(0)).toBe('0 秒')
    expect(formatDuration(-1)).toBe('0 秒')
  })

  it('距离文案与原生 measureBasicUnitTransfer 一致：floor 1 位小数，>10000m 才转 km', () => {
    expect(formatDistance(0)).toBe('0 m')
    expect(formatDistance(500)).toBe('500 m')
    expect(formatDistance(1234.56)).toBe('1234.5 m')
    expect(formatDistance(10000)).toBe('10000 m')
    expect(formatDistance(10001)).toBe('10 km')
    expect(formatDistance(12345)).toBe('12.3 km')
  })
})
