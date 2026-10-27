// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { ACK_TIMEOUT_MS, getExpiryHint, parseCoordinateInput, parseCoordinatePair, parseCoordinateText, parseDecimalInput } from './contract'

describe('accident list coordinate input', () => {
  it('接受负数、整数、任意位小数与前导零、前后空白', () => {
    expect(parseDecimalInput('22.54')).toBe(22.54)
    expect(parseDecimalInput('  -90 ')).toBe(-90)
    expect(parseDecimalInput('0')).toBe(0)
    expect(parseDecimalInput('114.0579123456789')).toBe(114.0579123456789)
    expect(parseDecimalInput('022.5')).toBe(22.5)
  })

  it('拒绝空串、科学计数法、逗号、多个小数点、非法字符与加号前缀', () => {
    for (const value of ['', ' ', 'abc', '1,2', '1.2.3', '1e5', '+1', '--1', '.5', '-']) {
      expect(parseDecimalInput(value), `value=${JSON.stringify(value)}`).toBeNull()
    }
  })

  it('按范围校验经度与纬度', () => {
    expect(parseCoordinateInput('90', { min: -90, max: 90 })).toBe(90)
    expect(parseCoordinateInput('180', { min: -180, max: 180 })).toBe(180)
    expect(parseCoordinateInput('-180', { min: -180, max: 180 })).toBe(-180)
    expect(parseCoordinateInput('91', { min: -90, max: 90 })).toBeNull()
    expect(parseCoordinateInput('181', { min: -180, max: 180 })).toBeNull()
    expect(parseCoordinateInput('-91', { min: -90, max: 90 })).toBeNull()
  })

  it('(0,0) 视为无效，单独 0 合法', () => {
    expect(parseCoordinatePair('0', '0')).toBeNull()
    expect(parseCoordinatePair('0', '114.05')).toEqual({ lat: 0, lng: 114.05 })
    expect(parseCoordinatePair('22.5', '0')).toEqual({ lat: 22.5, lng: 0 })
    expect(parseCoordinatePair('22.5', '114.05')).toEqual({ lat: 22.5, lng: 114.05 })
  })

  it('任一坐标缺失或超范围都会失败', () => {
    expect(parseCoordinatePair('', '114.05')).toBeNull()
    expect(parseCoordinatePair('22.5', '')).toBeNull()
    expect(parseCoordinatePair('91', '114.05')).toBeNull()
    expect(parseCoordinatePair('22.5', '181')).toBeNull()
  })
})

describe('accident list single coordinate input', () => {
  it('接受地图右键复制格式「纬度,经度」，含前后与逗号两侧空白', () => {
    expect(parseCoordinateText('22.5431,114.0579')).toEqual({ lat: 22.5431, lng: 114.0579 })
    expect(parseCoordinateText('  22.5431 , 114.0579  ')).toEqual({ lat: 22.5431, lng: 114.0579 })
    expect(parseCoordinateText('-22.5,-114.05')).toEqual({ lat: -22.5, lng: -114.05 })
    expect(parseCoordinateText('90,180')).toEqual({ lat: 90, lng: 180 })
    expect(parseCoordinateText('-90,-180')).toEqual({ lat: -90, lng: -180 })
    expect(parseCoordinateText('0,114.05')).toEqual({ lat: 0, lng: 114.05 })
    expect(parseCoordinateText('22.5,0')).toEqual({ lat: 22.5, lng: 0 })
  })

  it('拒绝空值、缺逗号、缺项、多余字段与中文逗号', () => {
    for (const value of ['', ' ', '22.5', ',114.05', '22.5,', '22.5，114.05', '22.5,114.05,', '1,2,3', ',']) {
      expect(parseCoordinateText(value), `value=${JSON.stringify(value)}`).toBeNull()
    }
  })

  it('拒绝非法数字、越界与 (0,0)', () => {
    for (const value of ['abc,114', '22.5,abc', '1e5,2', '91,114.05', '22.5,181', '0,0', '.5,2', '22.5,.5']) {
      expect(parseCoordinateText(value), `value=${JSON.stringify(value)}`).toBeNull()
    }
  })
})

describe('accident list expiry hint', () => {
  const occurredAt = 1_700_000_000_000
  const at = (remainingMs: number): number => occurredAt + ACK_TIMEOUT_MS - remainingMs

  it('按剩余签收时间分级：10 分钟、5 分钟与 1 分钟边界', () => {
    expect(getExpiryHint('unacknowledged', occurredAt, at(10 * 60_000 + 1))).toBe('')
    expect(getExpiryHint('unacknowledged', occurredAt, at(10 * 60_000))).toBe('10分钟后超时')
    expect(getExpiryHint('unacknowledged', occurredAt, at(5 * 60_000 + 1))).toBe('10分钟后超时')
    expect(getExpiryHint('unacknowledged', occurredAt, at(5 * 60_000))).toBe('5分钟后超时')
    expect(getExpiryHint('unacknowledged', occurredAt, at(60_000 + 1))).toBe('5分钟后超时')
    expect(getExpiryHint('unacknowledged', occurredAt, at(60_000))).toBe('即将超时')
    expect(getExpiryHint('unacknowledged', occurredAt, at(1))).toBe('即将超时')
  })

  it('已过期与非未签收状态不提示', () => {
    expect(getExpiryHint('unacknowledged', occurredAt, at(0))).toBe('')
    expect(getExpiryHint('unacknowledged', occurredAt, at(-1))).toBe('')
    for (const status of ['acknowledged', 'handling', 'completed', 'ack_timeout', 'ignored', 'terminated'] as const) {
      expect(getExpiryHint(status, occurredAt, at(30_000)), `status=${status}`).toBe('')
    }
  })
})
