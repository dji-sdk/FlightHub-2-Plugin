<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="records-view" data-plugin-view="capture-records">
    <header class="records-view__header">交通违章抓拍</header>
    <main class="records-view__body">
      <nav class="kind-tabs" :data-active-panel="state.activePanel">
        <button type="button" :class="{ active: state.activePanel === 'person-road' }" data-testid="records-tab-person-road" @click="setActivePanel('person-road')">行人上路</button>
        <button type="button" :class="{ active: state.activePanel === 'lane-change' }" data-testid="records-tab-lane-change" @click="setActivePanel('lane-change')">违章变道</button>
      </nav>
      <PersonRoadRecordsPanel v-if="state.activePanel === 'person-road'" :state="state.personRoad" @select="selectPersonRoadRecord" />
      <LaneChangeRecordsPanel v-else :state="state.laneChange" @select="selectLaneChangeRecord" />
    </main>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { onMounted, onUnmounted, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import type { CaptureRecordsClient, CaptureRecordsPanel, CaptureRecordsState } from './contract'
import LaneChangeRecordsPanel from './lane-change/LaneChangeRecordsPanel.vue'
import PersonRoadRecordsPanel from './person-road/PersonRoadRecordsPanel.vue'

const props = defineProps<{ client: CaptureRecordsClient }>()
const state = shallowRef<CaptureRecordsState>({
  activePanel: 'lane-change',
  laneChange: { records: [], selectedEventKey: '' },
  personRoad: { records: [], selectedTrackingId: '' },
})
let subscription: Disposable | undefined
onMounted(() => { subscription = props.client.state.subscribe(value => { state.value = value }) })
onUnmounted(() => subscription?.dispose())

function setActivePanel (panel: CaptureRecordsPanel): void { props.client.setActivePanel({ panel }) }
function selectLaneChangeRecord (eventKey: string): void { props.client.selectLaneChangeRecord({ eventKey }) }
function selectPersonRoadRecord (trackingId: string): void { props.client.selectPersonRoadRecord({ trackingId }) }
</script>

<style scoped>
.records-view { position: absolute; inset: 0; display: flex; overflow: hidden; flex-direction: column; background: #1f1f1f; color: #fff; user-select: none; font-family: "Open Sans", "PingFang SC", "Microsoft YaHei", sans-serif; }
.records-view__header { padding: 8px 12px; flex-shrink: 0; border-bottom: 1px solid #393939; background: #282828; font-size: 14px; font-weight: 600; line-height: 24px; }
.records-view__body { display: flex; overflow-y: auto; flex: 1; flex-direction: column; gap: 12px; padding: 0 16px 8px; border: 1px solid rgba(255,255,255,.08); border-top: 0; scrollbar-width: thin; scrollbar-color: #5f5f5f transparent; }
.records-view__body::-webkit-scrollbar { width: 8px; height: 8px; background-color: transparent; }
.records-view__body::-webkit-scrollbar-thumb { border: none; border-radius: 4px; background-color: #5f5f5f; }
.records-view__body::-webkit-scrollbar-corner { background: transparent; }
.kind-tabs { display: flex; gap: 16px; border-bottom: 1px solid rgba(255,255,255,.1); }
.kind-tabs button { padding: 8px 0 6px; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; background: transparent; color: rgba(255,255,255,.7); font-size: 14px; font-weight: 600; cursor: pointer; }
.kind-tabs button.active { border-bottom-color: #fff; color: #fff; }
</style>
