// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { CAPABILITY_SPECS } from '../catalog/capabilities.js'
import { POINT_IDS, points } from '../catalog/points/index.js'
import type { FieldSpec } from '../catalog/points/field.js'
import manifestSchema from './manifest.schema.json' with { type: 'json' }

interface SchemaBranch {
  readonly required?: readonly string[];
  readonly properties: Readonly<Record<string, {
    readonly const?: string;
    readonly enum?: readonly string[];
    readonly type?: string;
  }>>;
}

const extensionsItems = (manifestSchema as {
  properties: {
    extensions: {
      items: {
        required: readonly string[];
        anyOf: readonly SchemaBranch[];
      };
    };
  };
}).properties.extensions.items

/** Point Contract static 字段类型 → JSON Schema 约束；新增类型时必须先补映射。 */
const STATIC_TYPE_TO_SCHEMA: Record<string, object> = {
  string: { type: 'string' },
  viewId: { type: 'string' },
  iconId: { type: 'string' },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
}

describe('manifest.schema.json 与 Point Catalog 同步', () => {
  it('extensions 条目要求 id/point，且每个 Point 都有 anyOf 分支', () => {
    expect(extensionsItems.required).toEqual(['id', 'point'])
    const branchPoints = extensionsItems.anyOf.map(branch => branch.properties.point?.const)
    expect(branchPoints.every(point => typeof point === 'string')).toBe(true)
    expect([...branchPoints].sort()).toEqual([...POINT_IDS].sort())
  })

  it('分支 static 字段与 Contract 一一对应，enum 值和类型一致', () => {
    const branchByPoint = new Map(extensionsItems.anyOf.map(branch => [
      branch.properties.point!.const!,
      branch,
    ]))

    for (const pointId of POINT_IDS) {
      const branch = branchByPoint.get(pointId)!
      const staticFields = (Object.entries(points[pointId].contract) as [string, FieldSpec][])
        .filter(([, spec]) => spec.kind === 'static')

      const expectedKeys = ['point', ...staticFields.map(([name]) => name)].sort()
      expect(Object.keys(branch.properties).sort(), `Point ${pointId} 分支字段`).toEqual(expectedKeys)

      for (const [name, spec] of staticFields) {
        const actual = branch.properties[name]
        if (spec.type === 'enum') {
          expect(actual?.enum, `${pointId}.${name} enum 值`).toEqual(spec.values)
          continue
        }
        const expected = STATIC_TYPE_TO_SCHEMA[spec.type]
        expect(expected, `${pointId}.${name} 的 ${spec.type} 缺少 schema 类型映射`).toBeDefined()
        expect(actual, `${pointId}.${name} 类型约束`).toEqual(expected)
      }
    }
  })

  it('live Overlay 必须显式声明 normal/top 层级', () => {
    const branch = extensionsItems.anyOf.find(item => item.properties.point?.const === 'cockpit.ui.live-overlay')
    expect(branch?.required).toEqual(['overlayLevel'])
    expect(branch?.properties.overlayLevel?.enum).toEqual(['normal', 'top'])
  })

  it('permissions enum 与 CAPABILITY_DESCRIPTORS 的 permission 一一对应', () => {
    const schemaPermissions = (manifestSchema as {
      properties: {
        permissions: {
          items: {
            enum: readonly string[];
          };
        };
      };
    }).properties.permissions.items.enum
    const catalogPermissions = CAPABILITY_SPECS.map(spec => spec.permission)
    expect([...schemaPermissions].sort()).toEqual([...catalogPermissions].sort())
  })
})
