// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { manifestSchema } from '../index.js'
import { PLUGIN_ID_PATTERN, isPluginId } from './index.js'

describe('plugin id', () => {
  it.each([
    'official_dashboard_ui',
    'official_route_strategy',
    'exp_customer_plugin',
    'exp_customer-plugin',
    'exp_plugin2',
  ])('接受服务端统一 ID %s', (id) => {
    expect(isPluginId(id)).toBe(true)
  })

  it.each([
    'com.example.plugin',
    'example.musi',
    'plugin',
    'official_',
    'exp_',
    'official_Dashboard',
    'exp_customer__plugin',
  ])('拒绝不符合服务端规范的 ID %s', (id) => {
    expect(isPluginId(id)).toBe(false)
  })

  it('运行时 helper 与 Manifest Schema 使用同一规则', () => {
    expect(PLUGIN_ID_PATTERN.source).toBe(
      manifestSchema.properties.id.pattern.replaceAll('(', '(?:'),
    )
  })
})
