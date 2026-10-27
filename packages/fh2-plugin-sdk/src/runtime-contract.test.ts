// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import packageMetadata from '../package.json' with { type: 'json' }
import runtimeContract from '../runtime-contract.json' with { type: 'json' }
import { runtimeContract as publicRuntimeContract } from './runtime-contract.js'

describe('runtime contract metadata', () => {
  it('发布显式协议元数据，不从 SemVer 推导', () => {
    expect(runtimeContract).toEqual({
      schemaVersion: 1,
      manifestVersion: 1,
      platformVersion: '1.0.0',
      platformRange: '>=1.0.0-alpha.0 <2.0.0',
    })
    expect(publicRuntimeContract).toEqual(runtimeContract)
  })

  it('package root 导出并发布同一份 JSON', () => {
    expect(packageMetadata.exports['./runtime-contract.json']).toBe('./runtime-contract.json')
    expect(packageMetadata.files).toContain('runtime-contract.json')
  })
})
