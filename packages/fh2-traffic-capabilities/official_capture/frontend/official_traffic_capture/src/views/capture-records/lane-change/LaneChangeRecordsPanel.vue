<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="lane-records">
    <button v-for="record in state.records"
            :key="record.eventKey"
            type="button"
            class="record-card"
            :class="{ 'record-card--active': record.eventKey === state.selectedEventKey }"
            :data-event-key="record.eventKey"
            @click="$emit('select', record.eventKey)">
      <div class="record-card__thumb">
        <img v-if="record.screenshotUrl" :src="record.screenshotUrl" alt="" loading="lazy">
        <span v-else class="record-card__placeholder">暂无实时截图</span>
      </div>
      <div class="record-card__top">
        <span class="record-card__name">{{ record.title }}</span>
        <span class="record-card__time">{{ formatTime(record.crossedAt) }}</span>
      </div>
      <div class="record-card__bottom">
        <span class="record-card__badge">{{ collisionLabel(record.collisionType) }}</span>
      </div>
    </button>
    <p v-if="state.records.length === 0" class="records-empty">暂无数据</p>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import type { LaneChangeRecordsState } from './contract'

defineProps<{ state: LaneChangeRecordsState }>()
defineEmits<{ select: [eventKey: string] }>()

function collisionLabel (type: 'solid_line' | 'guide_area'): string {
  return type === 'guide_area' ? '导流区' : '压实线'
}

function formatTime (timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}
</script>

<style scoped>
.lane-records { display: flex; flex: 1; flex-direction: column; gap: 12px; }
.records-empty { display: flex; flex: 1; align-items: center; justify-content: center; min-height: 120px; margin: 0; color: rgba(255, 255, 255, 0.7); font-size: 12px; }
.record-card { position: relative; width: 100%; aspect-ratio: 190 / 104; padding: 0; overflow: hidden; flex-shrink: 0; border: 0; border-radius: 4px; background: #2a2a2a; color: #fff; cursor: pointer; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.15); }
.record-card:hover { box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.3); }
.record-card--active { box-shadow: 0 0 0 2px #0075ff; }
.record-card__thumb { position: absolute; inset: 0; display: flex; overflow: hidden; }
.record-card__thumb img { width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
.record-card__placeholder { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: rgba(255, 255, 255, 0.7); font-size: 11px; }
.record-card__top { position: absolute; top: 0; right: 0; left: 0; display: flex; justify-content: space-between; padding: 4px 8px 24px; background: linear-gradient(180deg, rgba(0,0,0,.4), transparent); pointer-events: none; }
.record-card__name, .record-card__time { overflow: hidden; color: #fff; font-size: 12px; line-height: 20px; text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0,0,0,.6); white-space: nowrap; }
.record-card__name { max-width: 110px; font-weight: 600; }
.record-card__bottom { position: absolute; right: 0; bottom: 0; left: 0; display: flex; align-items: flex-end; gap: 6px; padding: 28px 8px 4px; background: linear-gradient(180deg, transparent, rgba(0,0,0,.8)); pointer-events: none; }
.record-card__badge { padding: 0 4px; border-radius: 2px; background: #ff9f0a; color: #fff; font-size: 12px; line-height: 16px; }
</style>
