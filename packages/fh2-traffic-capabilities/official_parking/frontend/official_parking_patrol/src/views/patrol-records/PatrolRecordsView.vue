<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="event-list-panel"
       data-plugin-view="patrol-records">
    <div class="event-list-panel__header">
      <span class="event-list-panel__title">违停巡逻</span>
    </div>

    <div class="event-list-panel__body">
      <div v-show="state.group"
           class="event-list-panel__list">
        <template v-if="state.group">
          <SessionGroupHeader :group="state.group" />
          <PhotoEventCard v-for="item in state.group.items"
                          :key="item.id"
                          :target-id="item.id"
                          :thumb-url="item.thumbUrl"
                          :display-name="item.displayName"
                          :display-time="item.displayTime"
                          :badge-text="item.badgeText"
                          :badge-type="item.badgeType"
                          :is-active="state.activeTargetId === item.id"
                          @select="run(() => client.selectCard({ targetId: item.id }))" />
        </template>
      </div>

      <div v-show="!state.group"
           class="event-list-panel__empty">
        暂无数据
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { onMounted, onUnmounted, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import type { RecordsClient, RecordsState } from './contract'
import SessionGroupHeader from './SessionGroupHeader.vue'
import PhotoEventCard from './PhotoEventCard.vue'

/**
 * 抓拍记录面板（左栏）。
 * 产品变更：只展示当前在飞任务的数据，不展示历史架次，无展开/收起折叠；
 * 任务结束后数据保留至下一轮任务。关键词/日期筛选与拖宽暂缓（见 ARCHITECTURE.md）。
 */
const props = defineProps<{ client: RecordsClient }>()
const client = props.client

const state = shallowRef<RecordsState>({
  group: null,
  activeTargetId: '',
})

let subscription: Disposable | undefined

onMounted(() => {
  subscription = client.state.subscribe(value => { state.value = value })
})
onUnmounted(() => subscription?.dispose())

function run (action: () => unknown): void {
  const result = action()
  if (result instanceof Promise) result.catch(() => {})
}
</script>

<style scoped>
.event-list-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  user-select: none;
  overflow: hidden;
  background: #1f1f1f;
  color: #fff;
  font-family: "Open Sans", "PingFang SC", "Microsoft YaHei", sans-serif;
}

.event-list-panel__header {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  background: #282828;
  border-bottom: 1px solid #393939;
  flex-shrink: 0;
  justify-content: center;
}
.event-list-panel__title {
  font-size: 14px;
  font-weight: 600;
  line-height: 24px;
  color: #fff;
}

.event-list-panel__body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.event-list-panel__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
}

.event-list-panel__list {
  flex: 1;
  overflow-y: auto;
  padding: 0 16px 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: #1f1f1f;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-top: 0;
  scrollbar-width: thin;
  scrollbar-color: #5f5f5f transparent;
}
.event-list-panel__list::-webkit-scrollbar {
  width: 8px;
  height: 8px;
  background-color: transparent;
}
.event-list-panel__list::-webkit-scrollbar-thumb {
  border: none;
  border-radius: 4px;
  background-color: #5f5f5f;
}
.event-list-panel__list::-webkit-scrollbar-corner {
  background: transparent;
}

</style>
