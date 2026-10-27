<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="photo-event-card"
       :class="{ 'photo-event-card--active': isActive }"
       :data-target-id="targetId"
       @click="$emit('select')">
    <div class="photo-event-card__thumb">
      <img v-if="thumbUrl && !imgFailed"
           :src="thumbUrl"
           alt=""
           @error="imgFailed = true">
      <div v-else
           class="photo-event-card__placeholder" />
    </div>

    <div class="photo-event-card__top">
      <div class="photo-event-card__name-row">
        <span class="photo-event-card__name">{{ displayName }}</span>
        <span class="photo-event-card__time">{{ displayTime }}</span>
      </div>
    </div>

    <div v-if="badgeText"
         class="photo-event-card__bottom">
      <span class="photo-event-card__badge"
            :class="badgeType">{{ badgeText }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { ref, watch } from 'vue'
import type { BadgeType } from '../../workflow/records-core'

/**
 * 车辆卡片（190:104）
 * 图片 404 退避重试暂缓（见 ARCHITECTURE.md），失败先显示占位。
 */
const props = withDefaults(defineProps<{
  targetId: string
  thumbUrl?: string
  displayName?: string
  displayTime?: string
  badgeText?: string
  badgeType?: BadgeType
  isActive?: boolean
}>(), {
  thumbUrl: '',
  displayName: '',
  displayTime: '',
  badgeText: '',
  badgeType: 'none',
  isActive: false,
})

defineEmits<{
  (e: 'select'): void
}>()

const imgFailed = ref(false)
watch(() => props.thumbUrl, () => {
  imgFailed.value = false
})
</script>

<style scoped>
.photo-event-card {
  position: relative;
  width: 100%;
  aspect-ratio: 190 / 104;
  border-radius: 4px;
  overflow: hidden;
  cursor: pointer;
  flex-shrink: 0;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.15);
  transition: box-shadow 0.15s ease;
}
.photo-event-card:hover {
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.3);
}
.photo-event-card--active {
  box-shadow: 0 0 0 2px #0075ff;
}

.photo-event-card__thumb {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.photo-event-card__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.photo-event-card__placeholder {
  width: 100%;
  height: 100%;
  background: #2a2a2a;
}

.photo-event-card__top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 48px;
  padding: 4px 8px 24px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.4) 0%, rgba(0, 0, 0, 0) 100%);
  pointer-events: none;
}
.photo-event-card__name-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 20px;
}
.photo-event-card__name {
  font-size: 12px;
  font-weight: 600;
  line-height: 20px;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 110px;
}
.photo-event-card__time {
  font-size: 12px;
  font-weight: 400;
  line-height: 20px;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  flex-shrink: 0;
}

.photo-event-card__bottom {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 48px;
  padding: 28px 8px 4px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.8) 100%);
  display: flex;
  align-items: flex-end;
  pointer-events: none;
}
.photo-event-card__badge {
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 4px;
  border-radius: 2px;
  font-size: 12px;
  line-height: 20px;
  color: #fff;
}
.photo-event-card__badge.red { background: #e41f29; }
.photo-event-card__badge.orange { background: #ff9f0a; }
.photo-event-card__badge.blue { background: #0075ff; }
.photo-event-card__badge.green { background: #19be6b; }
.photo-event-card__badge.gray { background: rgba(255, 255, 255, 0.3); }
</style>
