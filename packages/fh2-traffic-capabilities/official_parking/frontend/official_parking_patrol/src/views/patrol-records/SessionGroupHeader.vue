<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="session-group-header">
    <div class="session-group-header__info">
      <div class="session-group-header__name" :title="group.routeName">
        <span class="session-group-header__name-text">{{ group.routeName }}</span>
        <span v-if="group.isActive"
              class="session-group-header__live-dot" />
      </div>
      <div class="session-group-header__time">{{ group.timeText }}</div>
    </div>
    <span class="session-group-header__stat">{{ group.statText }}</span>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import type { PatrolRecordGroup } from '../../workflow/records-core'

/**
 * 当前任务分组头（静态展示，无折叠交互）：
 * 路段名 + 进行中蓝点 + 时间 + n/n 统计，样式移植自原生 SessionRecordGroup.vue 头部。
 */
defineProps<{ group: PatrolRecordGroup }>()
</script>

<style scoped>
.session-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 4px;
  user-select: none;
}
.session-group-header__info {
  flex: 1;
  min-width: 0;
}
.session-group-header__name {
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.7);
  display: flex;
  align-items: center;
  gap: 5px;
}
.session-group-header__name-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-group-header__live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #0075ff;
  flex-shrink: 0;
  animation: session-pulse 1.5s infinite;
}
.session-group-header__time {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.3);
  margin-top: 1px;
  text-align: left;
}
.session-group-header__stat {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.3);
  flex-shrink: 0;
}

@keyframes session-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
