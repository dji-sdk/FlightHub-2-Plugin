// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from './settings'

/** happy-dom 的 localStorage 是空 stub：换成内存实现，专门测读写与恢复。 */
function stubLocalStorage (): Map<string, string> {
  const storage = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value)
      },
      removeItem: (key: string) => {
        storage.delete(key)
      },
    },
  })
  return storage
}

describe('settings store', () => {
  let storage: Map<string, string>

  beforeEach(() => {
    setActivePinia(createPinia())
    storage = stubLocalStorage()
  })

  it('自动保存默认开启', () => {
    const settings = useSettingsStore()
    expect(settings.autoSave).toBe(true)
  })

  it('持久化的 autoSave=false 被恢复', () => {
    storage.set('fh2-ide-settings', JSON.stringify({ autoSave: false }))
    const settings = useSettingsStore()
    expect(settings.autoSave).toBe(false)
  })

  it('setAutoSave 写入 localStorage', async () => {
    const settings = useSettingsStore()
    settings.setAutoSave(false)
    await nextTick()
    expect(JSON.parse(storage.get('fh2-ide-settings') ?? '{}').autoSave).toBe(false)
    settings.setAutoSave(true)
    await nextTick()
    expect(JSON.parse(storage.get('fh2-ide-settings') ?? '{}').autoSave).toBe(true)
  })
})
