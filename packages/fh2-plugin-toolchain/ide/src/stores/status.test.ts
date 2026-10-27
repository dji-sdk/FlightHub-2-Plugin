// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useStatusStore } from './status.js'

describe('status store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('set 覆盖消息与错误标记', () => {
    const status = useStatusStore()
    status.set('就绪')
    expect(status.message).toBe('就绪')
    expect(status.isError).toBe(false)
    status.set('出错了', true)
    expect(status.message).toBe('出错了')
    expect(status.isError).toBe(true)
  })

  it('append 用「·」并接；当前为空时直接写入', () => {
    const status = useStatusStore()
    status.set('')
    status.append('已保存 a.ts')
    expect(status.message).toBe('已保存 a.ts')
    status.append('校验通过')
    expect(status.message).toBe('已保存 a.ts · 校验通过')
  })

  it('setPosition 与 setConnected 独立更新', () => {
    const status = useStatusStore()
    status.setPosition('行 3，列 5')
    status.setConnected(true)
    expect(status.position).toBe('行 3，列 5')
    expect(status.connected).toBe(true)
  })
})
