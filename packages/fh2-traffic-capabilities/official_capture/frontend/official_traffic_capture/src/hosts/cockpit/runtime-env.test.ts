// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { resolveTrafficMediaUrl } from './runtime-env'

describe('resolveTrafficMediaUrl', () => {
  it('不依赖当前 Realm 的 base 解析后端绝对 URL', () => {
    expect(resolveTrafficMediaUrl('')).toBe('')
    expect(resolveTrafficMediaUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    // RFC 5737 TEST-NET-1 文档专用地址，不含任何真实网络信息
    expect(resolveTrafficMediaUrl('http://192.0.2.213/media/a.jpg?token=1')).toBe('http://192.0.2.213/media/a.jpg?token=1')
  })

  it('拒绝后端契约之外的相对 URL', () => {
    expect(() => resolveTrafficMediaUrl('/media/a.jpg')).toThrow()
  })
})
