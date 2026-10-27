// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { JsonValue } from 'fh2-plugin-sdk'
import { unwrapApiData } from './api-response'
import { createPluginInvoke } from './invoke'

const envelope = (data: JsonValue, code = 0): JsonValue => ({ code, message: code === 0 ? 'success' : 'failed', data })

describe('plugin invoke transport', () => {
  it('unwraps one envelope and sends the fixed plugin endpoint', async () => {
    expect(unwrapApiData(envelope({ id: 1 }))).toEqual({ id: 1 })
    expect(() => unwrapApiData(envelope({}, 20001))).toThrow('code: 20001')
    const apiCall = vi.fn(async () => envelope({ ok: true }))
    const invoke = createPluginInvoke(apiCall)
    await expect(invoke('domain.action', { id: '1' })).resolves.toEqual({ ok: true })
    expect(apiCall).toHaveBeenCalledWith('/plugin/invoke', {
      method: 'POST',
      body: { pluginId: 'official_traffic_capture_backend', handler: 'domain.action', input: { id: '1' } },
    })
  })
})
