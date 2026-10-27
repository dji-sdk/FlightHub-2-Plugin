<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="person-preview">
    <template v-if="activePhoto">
      <ImageViewer :key="activePhoto.url" :url="activePhoto.url" />
      <div class="pager">
        <button type="button" :disabled="state.photos.length <= 1" @click="selectOffset(-1)">‹</button>
        <strong>{{ state.activeIndex + 1 }} / {{ state.photos.length }}</strong>
        <button type="button" :disabled="state.photos.length <= 1" @click="selectOffset(1)">›</button>
      </div>
    </template>
    <p v-else-if="state.loading" class="message">照片加载中…</p>
    <p v-else-if="state.loadError" class="message error">{{ state.loadError }}</p>
    <p v-else-if="state.record" class="message">回传中</p>
    <p v-else class="message">暂无数据</p>
    <div v-if="state.record" class="overlay">
      <span class="title">{{ state.record.title }}</span>
      <span v-if="state.record.folderId > 0"
              class="media-library"
              @click="$emit('openMediaLibrary')">查看全部</span>
      <span class="time">{{ formatDateTime(state.record.startedAt) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed } from 'vue'
import ImageViewer from '../ImageViewer.vue'
import type { PersonRoadPreviewState } from './contract'

const props = defineProps<{ state: PersonRoadPreviewState }>()
const emit = defineEmits<{ selectPhoto: [index: number]; openMediaLibrary: [] }>()
const activePhoto = computed(() => props.state.photos[props.state.activeIndex] ?? null)

function selectOffset (offset: number): void {
  if (props.state.photos.length <= 1) return
  emit('selectPhoto', (props.state.activeIndex + offset + props.state.photos.length) % props.state.photos.length)
}

function formatDateTime (timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}
</script>

<style scoped>
.person-preview { position: relative; width: 100%; height: 100%; overflow: hidden; background: #000; }
.message { position: absolute; top: 50%; left: 50%; margin: 0; color: rgba(255,255,255,.7); font-size: 12px; transform: translate(-50%, -50%); }
.error { color: #e41f29; }
.overlay { position: absolute; top: 0; right: 0; left: 0; z-index: 4; display: flex; align-items: baseline; gap: 12px; padding: 8px 12px; background: linear-gradient(180deg, rgba(0,0,0,.6), transparent); color: rgba(255,255,255,.7); font-size: 12px; pointer-events: none; }
.title { text-align: left; min-width: 0; overflow: hidden; flex: 1; color: #fff; font-size: 16px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.media-library { padding: 0; flex-shrink: 0; border: 0; background: transparent; color: #fff; cursor: pointer; font-size: 12px; pointer-events: auto; text-decoration: underline; white-space: nowrap; }
.time { flex-shrink: 0; color: #fff; font-size: 14px; }
.pager { position: absolute; bottom: 12px; left: 50%; z-index: 3; display: flex; align-items: center; gap: 8px; color: #fff; transform: translateX(-50%); }
.pager button { width: 24px; height: 24px; border: 0; border-radius: 50%; background: transparent; color: #fff; cursor: pointer; }
.pager button:disabled { cursor: not-allowed; opacity: .35; }
.pager strong { min-width: 40px; font-size: 14px; text-align: center; }
</style>
