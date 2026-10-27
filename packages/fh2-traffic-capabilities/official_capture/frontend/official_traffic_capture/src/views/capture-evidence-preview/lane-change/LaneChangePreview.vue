<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="lane-preview">
    <ImageViewer v-if="state.screenshotUrl" :key="state.screenshotUrl" :url="state.screenshotUrl" />
    <p v-else-if="state.record" class="message">暂无实时截图</p>
    <p v-else class="message">暂无数据</p>
    <div v-if="state.record" class="overlay">
      <span class="title">{{ state.record.title }}</span>
      <span class="time">{{ formatDateTime(state.record.crossedAt) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import ImageViewer from '../ImageViewer.vue'
import type { LaneChangePreviewState } from './contract'

defineProps<{ state: LaneChangePreviewState }>()

function formatDateTime (timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}
</script>

<style scoped>
.lane-preview { position: relative; width: 100%; height: 100%; overflow: hidden; background: #000; }
.message { position: absolute; top: 50%; left: 50%; margin: 0; color: rgba(255,255,255,.7); font-size: 12px; transform: translate(-50%, -50%); }
.overlay { position: absolute; top: 0; right: 0; left: 0; z-index: 4; display: flex; justify-content: space-between; gap: 12px; padding: 8px 12px; background: linear-gradient(180deg, rgba(0,0,0,.6), transparent); pointer-events: none; }
.title { min-width: 0; overflow: hidden; color: #fff; font-size: 16px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.time { flex-shrink: 0; color: #fff; font-size: 14px; }
</style>
