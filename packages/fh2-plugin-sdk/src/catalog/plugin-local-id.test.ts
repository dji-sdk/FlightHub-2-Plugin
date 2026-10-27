// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import manifestSchema from '../schema/manifest.schema.json' with { type: 'json' }
import { PLUGIN_LOCAL_ID_PATTERN, isPluginLocalId } from './index.js'

const PLUGIN_LOCAL_ID_REF = '#/definitions/pluginLocalId'

describe('plugin-local ID contract', () => {
  it('schema 的 Extension、View 与 Icon 共用同一定义', () => {
    expect(manifestSchema.properties.extensions.items.properties.id.$ref).toBe(PLUGIN_LOCAL_ID_REF)
    expect(manifestSchema.properties.views.propertyNames.$ref).toBe(PLUGIN_LOCAL_ID_REF)
    expect(manifestSchema.properties.contributes.properties.icons.items.properties.id.$ref).toBe(PLUGIN_LOCAL_ID_REF)
  })

  it('schema pattern 与公开 helper 保持同步', () => {
    const schemaPattern = manifestSchema.definitions.pluginLocalId.pattern
    expect(schemaPattern).toBe(PLUGIN_LOCAL_ID_PATTERN.source)

    for (const [value, expected] of [
      ['a', true],
      ['Action-1', true],
      ['view-', true],
      ['', false],
      ['-leading', false],
      ['with_underscore', false],
      ['with.dot', false],
      ['with space', false],
    ] as const) {
      expect(isPluginLocalId(value)).toBe(expected)
      expect(new RegExp(schemaPattern).test(value)).toBe(expected)
    }
  })
})
