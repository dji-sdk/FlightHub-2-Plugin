<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="person-records">
    <button v-for="record in state.records"
            :key="record.trackingId"
            type="button"
            class="record-card"
            :class="{ 'record-card--active': record.trackingId === state.selectedTrackingId }"
            :data-tracking-id="record.trackingId"
            @click="$emit('select', record.trackingId)">
      <div class="record-card__thumb">
        <img v-if="record.previewPhotoUrl" :src="record.previewPhotoUrl" alt="" loading="lazy">
        <span v-else class="record-card__placeholder">{{ record.pending ? '截图中…' : '回传中' }}</span>
      </div>
      <div class="record-card__top">
        <span class="record-card__name">{{ record.title }}</span>
        <span class="record-card__time">{{ formatTime(record.startedAt) }}</span>
      </div>
      <div class="record-card__bottom">
        <span class="record-card__badge" :data-pending="record.pending">{{ record.pending ? '待回传' : '行人上路' }}</span>
      </div>
    </button>
    <p v-if="state.records.length === 0" class="records-empty">暂无数据</p>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import type { PersonRoadRecordsState } from './contract'

defineProps<{ state: PersonRoadRecordsState }>()
defineEmits<{ select: [trackingId: string] }>()

function formatTime (timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}
</script>

<style scoped>
.person-records { display: flex; flex: 1; flex-direction: column; gap: 12px; }
.records-empty { display: flex; flex: 1; align-items: center; justify-content: center; min-height: 120px; margin: 0; color: rgba(255,255,255,.7); font-size: 12px; }
.record-card { position: relative; width: 100%; aspect-ratio: 190 / 104; padding: 0; overflow: hidden; flex-shrink: 0; border: 0; border-radius: 4px; background: #2a2a2a; color: #fff; cursor: pointer; box-shadow: 0 0 0 1px rgba(255,255,255,.15); }
.record-card:hover { box-shadow: 0 0 0 1px rgba(255,255,255,.3); }
.record-card--active { box-shadow: 0 0 0 2px #0075ff; }
.record-card__thumb { position: absolute; inset: 0; display: flex; overflow: hidden; }
.record-card__thumb img { width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
.record-card__placeholder { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,.7); font-size: 11px; }
.record-card__top { position: absolute; top: 0; right: 0; left: 0; display: flex; justify-content: space-between; padding: 4px 8px 24px; background: linear-gradient(180deg, rgba(0,0,0,.4), transparent); pointer-events: none; }
.record-card__name, .record-card__time { overflow: hidden; color: #fff; font-size: 12px; line-height: 20px; text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0,0,0,.6); white-space: nowrap; }
.record-card__name { max-width: 110px; font-weight: 600; }
.record-card__bottom { position: absolute; right: 0; bottom: 0; left: 0; display: flex; align-items: center; gap: 6px; padding: 28px 8px 4px; background: linear-gradient(180deg, transparent, rgba(0,0,0,.8)); pointer-events: none; }
.record-card__badge { padding: 0 4px; border-radius: 2px; background: #0075ff; color: #fff; font-size: 12px; line-height: 16px; }
.record-card__badge[data-pending="true"] { background: #ffcc00; }
</style>
