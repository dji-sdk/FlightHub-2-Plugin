// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 状态栏与连接态。文案直接展示给用户，不做国际化（仓规）。
 */
export const useStatusStore = defineStore('status', () => {
  const message = ref('就绪')
  const isError = ref(false)
  const position = ref('')
  const connected = ref(false)

  function set (text: string, error = false): void {
    message.value = text
    isError.value = error
  }

  /** 追加一段回执（如保存后的静默校验结果），用「·」并到现有消息后面。 */
  function append (text: string): void {
    const current = message.value
    message.value = current === '' ? text : `${current} · ${text}`
  }

  function setPosition (text: string): void {
    position.value = text
  }

  function setConnected (value: boolean): void {
    connected.value = value
  }

  return { message, isError, position, connected, set, append, setPosition, setConnected }
})
