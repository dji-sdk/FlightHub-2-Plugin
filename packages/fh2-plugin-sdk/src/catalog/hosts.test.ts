// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { HOST_IDS, isHostId } from './hosts.js'

describe('host catalog', () => {
  it('首期固定为四个 Host', () => {
    expect(HOST_IDS).toEqual(['cockpit', 'plan', 'message', 'project'])
    expect(isHostId('cockpit')).toBe(true)
    expect(isHostId('workflow')).toBe(false)
  })
})
