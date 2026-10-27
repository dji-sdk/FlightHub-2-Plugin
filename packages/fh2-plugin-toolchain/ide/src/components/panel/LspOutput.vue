<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { useLspStore } from '../../stores/lsp'
import { useUiStore } from '../../stores/ui'

const lsp = useLspStore()
const ui = useUiStore()
</script>

<template>
  <div class="lsp-output panel-pane" :class="{ active: ui.panelTab === 'lsp' }">
    <div class="lsp-summary">
      {{ lsp.summary }}<template v-if="lsp.detail">
        · {{ lsp.detail }}
      </template>
    </div>
    <div v-if="lsp.logs.length === 0" class="panel-empty">
      语言服务暂无日志。
    </div>
    <pre v-else class="lsp-logs">{{ lsp.logs.join('\n') }}</pre>
  </div>
</template>
