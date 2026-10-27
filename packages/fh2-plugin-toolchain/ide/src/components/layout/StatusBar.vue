<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { useStatusStore } from '../../stores/status'
import { useLspStore } from '../../stores/lsp'
import { monacoWorkerFailed } from '../../editor/monaco-setup'

const status = useStatusStore()
const lsp = useLspStore()
</script>

<template>
  <div class="statusbar" :class="[{ error: status.isError }]">
    <span id="status-message" :title="status.message">{{ status.message }}</span>
    <span v-if="monacoWorkerFailed" id="status-worker" title="Monaco 语言 Worker 加载失败，校验与补全已降级">后台校验不可用（Worker 加载失败）</span>
    <span class="statusbar-spacer" />
    <span id="status-position" :title="status.position">{{ status.position }}</span>
    <span id="status-lsp" :title="lsp.detail || lsp.summary">{{ lsp.summary }}</span>
    <span class="statusbar-connection">
      <span class="statusbar-dot" :class="[{ connected: status.connected }]" />
      <span>{{ status.connected ? '已连接文件监听' : '文件监听断开' }}</span>
    </span>
  </div>
</template>
