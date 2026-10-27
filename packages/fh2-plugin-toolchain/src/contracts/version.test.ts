// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, checkSchemaVersion, isSupportedSchemaVersion } from './version.js'

describe('checkSchemaVersion', () => {
  it('接受当前版本', () => {
    expect(checkSchemaVersion({ schemaVersion: 1 })).toEqual({ ok: true, version: 1 })
  })

  it('缺失版本明确失败，不得按 v1 处理', () => {
    expect(checkSchemaVersion({})).toEqual({ ok: false, reason: 'missing' })
    expect(isSupportedSchemaVersion({})).toBe(false)
  })

  it('非整数/非数字版本明确失败', () => {
    expect(checkSchemaVersion({ schemaVersion: '1' })).toEqual({ ok: false, reason: 'invalid', received: '1' })
    expect(checkSchemaVersion({ schemaVersion: 1.5 })).toEqual({ ok: false, reason: 'invalid', received: 1.5 })
  })

  it('未知版本明确失败', () => {
    expect(checkSchemaVersion({ schemaVersion: 2 })).toEqual({ ok: false, reason: 'unsupported', received: 2 })
    expect(checkSchemaVersion({ schemaVersion: 0 })).toEqual({ ok: false, reason: 'unsupported', received: 0 })
  })

  it('支持声明多版本', () => {
    expect(checkSchemaVersion({ schemaVersion: 1 }, [1, 2])).toEqual({ ok: true, version: 1 })
    expect(checkSchemaVersion({ schemaVersion: 2 }, [1, 2])).toEqual({ ok: true, version: 2 })
  })

  it('sCHEMA_VERSION 常量为 1', () => {
    expect(SCHEMA_VERSION).toBe(1)
  })
})
