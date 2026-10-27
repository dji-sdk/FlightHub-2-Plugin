// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

/**
 * 编辑器偏好（Monaco 字号 / 自动换行 / 自动保存）：localStorage 持久化。
 * 隐私模式等 localStorage 不可用场景回落内存态，本次会话内仍然生效。
 */

const STORAGE_KEY = 'fh2-ide-settings'
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 32

interface PersistedSettings {
  readonly fontSize?: unknown;
  readonly wordWrap?: unknown;
  readonly autoSave?: unknown;
}

function loadPersisted (): PersistedSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as PersistedSettings
  } catch {
    return {}
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const persisted = loadPersisted()
  const initialFontSize = typeof persisted.fontSize === 'number' && Number.isFinite(persisted.fontSize)
    ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(persisted.fontSize)))
    : 13

  const fontSize = ref(initialFontSize)
  const wordWrap = ref(persisted.wordWrap === true)
  /** 编辑器自动保存：开启时内容变化后短暂静默即落盘，Ctrl+S 仍可用。 */
  const autoSave = ref(persisted.autoSave !== false)

  watch([fontSize, wordWrap, autoSave], () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: fontSize.value, wordWrap: wordWrap.value, autoSave: autoSave.value }))
    } catch {
      // 存不进去（隐私模式 / 配额）时静默降级
    }
  })

  function setFontSize (value: number): void {
    if (!Number.isFinite(value)) return
    fontSize.value = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)))
  }

  function setWordWrap (value: boolean): void {
    wordWrap.value = value
  }

  function setAutoSave (value: boolean): void {
    autoSave.value = value
  }

  return { fontSize, wordWrap, autoSave, setFontSize, setWordWrap, setAutoSave }
})
