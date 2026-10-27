// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import type { PluginContext } from './context.js'

function compileOnly (ctx: PluginContext): void {
  if (false) {
    void ctx.apiCall('https://example.com/api', { method: 'POST', body: { ok: true } })
    // @ts-expect-error 绝对 URL 不接受 Blob；二进制上传只保留给平台内部相对路径。
    void ctx.apiCall('https://example.com/upload', { method: 'POST', body: new Blob() })
    void ctx.apiCall('/internal/upload', { method: 'POST', body: new Blob() })
    void ctx.apiCall<{ ok: boolean }>('https://example.com/api', { method: 'POST', body: { ok: true } })
    // @ts-expect-error 显式指定响应类型时，绝对 URL 仍不能接受 Blob。
    void ctx.apiCall<{ ok: boolean }>('https://example.com/upload', { method: 'POST', body: new Blob() })
    void ctx.apiCall<{ ok: boolean }>('/internal/upload', { method: 'POST', body: new Blob() })
  }
}

describe('apiCall endpoint 类型契约', () => {
  it('编译期区分绝对 URL 与相对路径 body', () => {
    expect(typeof compileOnly).toBe('function')
  })
})
