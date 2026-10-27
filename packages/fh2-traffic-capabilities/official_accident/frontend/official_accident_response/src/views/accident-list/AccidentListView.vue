<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <PluginViewProvider :style-target="styleTarget">
    <section class="accident-panel" data-plugin-view="accident-list">
      <header class="panel-header">
        <strong>报警事件</strong>
        <b v-if="state.items.length">{{ state.items.length }}</b>
      </header>

      <div class="event-list">
        <div
          v-if="state.loading && state.items.length === 0"
          class="loading-state"
        >
          <n-spin size="small" />
        </div>
        <n-empty
          v-else-if="state.items.length === 0"
          description="暂无待处理事件"
          class="empty-state"
        >
          <template #icon>
            <img :src="emptyAlertEvents" alt="" />
          </template>
        </n-empty>
        <template v-else>
          <AccidentEventCard
            v-for="item in state.items"
            :key="item.pluginEventId"
            :item="item"
            :active="state.selectedId === item.pluginEventId"
            :busy="busyId === item.pluginEventId"
            :overlay-element="overlayElement"
            @select="selectEvent"
            @handle="handle"
            @coordinates="submitCoordinates"
            @feedback="submitFeedback"
            @ignore="ignoreIncident"
          />
        </template>
      </div>

      <footer class="panel-footer">
        <n-button block @click="client.openAllEventsDialog()"
          >全部事件</n-button
        >
      </footer>
    </section>
  </PluginViewProvider>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { NButton, NEmpty, NSpin } from "naive-ui";
import { onMounted, onUnmounted, ref, shallowRef } from "vue";
import type { Disposable } from "fh2-plugin-sdk";
import emptyAlertEvents from "../../assets/empty-alert-events.svg";
import PluginViewProvider from "../shared/PluginViewProvider.vue";
import AccidentEventCard from "./AccidentEventCard.vue";
import type { AccidentListItem, AccidentListViewClient } from "./contract";

const props = defineProps<{
  client: AccidentListViewClient;
  styleTarget: ShadowRoot | HTMLHeadElement;
  overlayElement: HTMLElement;
}>();

const state = shallowRef({
  items: [] as readonly AccidentListItem[],
  loading: true,
  selectedId: "",
});
const busyId = ref("");
let subscription: Disposable | undefined;

async function run(
  id: string,
  action: () => unknown | Promise<unknown>,
): Promise<boolean> {
  busyId.value = id;
  try {
    await action();
    return true;
  } catch {
    return false;
  } finally {
    busyId.value = "";
  }
}

async function handle(pluginEventId: string): Promise<void> {
  await run(pluginEventId, () => props.client.handle({ pluginEventId }));
}

function selectEvent(pluginEventId: string): void {
  void props.client.selectEvent({ pluginEventId });
}

function submitCoordinates(pluginEventId: string, lat: number, lng: number): void {
  void run(pluginEventId, () => props.client.submitCoordinates({ pluginEventId, lat, lng }));
}

function submitFeedback(pluginEventId: string, note: string): void {
  void run(pluginEventId, () => props.client.submitFeedback({ pluginEventId, note }));
}

function ignoreIncident(pluginEventId: string): void {
  void run(pluginEventId, () => props.client.ignoreIncident({ pluginEventId }));
}

onMounted(() => {
  subscription = props.client.state.subscribe((value) => {
    state.value = value;
  });
});
onUnmounted(() => subscription?.dispose());
</script>

<style scoped>
.accident-panel {
  display: flex;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: #1f1f1f;
  color: #fff;
  font-size: 14px;
}
.panel-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 16px;
  font-size: 16px;
  line-height: 24px;
}
.panel-header b {
  color: #f0484b;
}
.event-list {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  padding: 0 16px;
  scrollbar-color: #555 transparent;
}
.loading-state {
  display: flex;
  height: 120px;
  align-items: center;
  justify-content: center;
}
.empty-state {
  flex: 1;
  justify-content: center;
  color: #fff;
}
.empty-state :deep(.n-empty__icon) {
  width: 240px;
  height: 160px;
}
.empty-state img {
  display: block;
  width: 240px;
  height: 160px;
}
.empty-state :deep(.n-empty__description) {
  color: #fff;
}
.panel-footer {
  flex: 0 0 auto;
  padding: 16px;
}
.panel-footer :deep(.n-button) {
  border: 0;
  border-radius: 8px;
  background: #3e3e3e;
  font-weight: 600;
}
</style>
