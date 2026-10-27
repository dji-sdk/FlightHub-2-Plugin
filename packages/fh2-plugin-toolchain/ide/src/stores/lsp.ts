// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { LspClientStatus } from '../lsp/client.js'

const MAX_LOG_LINES = 500

export const LSP_STATUS_LABEL: Readonly<Record<LspClientStatus, string>> = {
  connecting: '连接中',
  starting: '启动中',
  open: '已就绪',
  closed: '已断开',
  failed: '异常',
}

export const useLspStore = defineStore('lsp', () => {
  const status = ref<LspClientStatus>('closed')
  const detail = ref('')
  const serverKind = ref<'ts' | 'vue' | null>(null)
  const logs = ref<readonly string[]>([])
  const summary = computed(() => `${serverKind.value === 'vue' ? 'Volar' : 'TS LSP'}：${LSP_STATUS_LABEL[status.value]}`)

  function setStatus (next: LspClientStatus, nextDetail = ''): void {
    status.value = next
    detail.value = nextDetail
    if (nextDetail === 'Volar') serverKind.value = 'vue'
    if (nextDetail === 'TypeScript') serverKind.value = 'ts'
  }

  function append (source: string, message: string): void {
    const added = message.trimEnd().split('\n').filter(Boolean).map(line => `[${source}] ${line}`)
    const next = [...logs.value, ...added]
    logs.value = next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next
  }

  function reset (): void {
    status.value = 'closed'
    detail.value = ''
    serverKind.value = null
    logs.value = []
  }

  return { status, detail, serverKind, logs, summary, setStatus, append, reset }
})
