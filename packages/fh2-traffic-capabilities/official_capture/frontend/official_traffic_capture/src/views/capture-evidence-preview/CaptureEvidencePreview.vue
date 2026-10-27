<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="capture-preview" data-plugin-view="capture-evidence-preview">
    <PersonRoadPreview v-if="state.activePanel === 'person-road'" :state="state.personRoad" @select-photo="selectPersonRoadPhoto" @open-media-library="openPersonRoadMediaLibrary" />
    <LaneChangePreview v-else-if="state.activePanel === 'lane-change'" :state="state.laneChange" />
    <p v-else>暂无数据</p>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { onMounted, onUnmounted, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import type { CaptureEvidencePreviewClient, CaptureEvidencePreviewState } from './contract'
import LaneChangePreview from './lane-change/LaneChangePreview.vue'
import PersonRoadPreview from './person-road/PersonRoadPreview.vue'

const props = defineProps<{ client: CaptureEvidencePreviewClient }>()
const state = shallowRef<CaptureEvidencePreviewState>({
  activePanel: null,
  laneChange: { record: null, screenshotUrl: null },
  personRoad: { record: null, photos: [], activeIndex: 0, loading: false, loadError: null },
})
let subscription: Disposable | undefined
onMounted(() => { subscription = props.client.state.subscribe(value => { state.value = value }) })
onUnmounted(() => { subscription?.dispose(); props.client.close() })
function selectPersonRoadPhoto (index: number): void { props.client.selectPersonRoadPhoto({ index }) }
function openPersonRoadMediaLibrary (): void { void props.client.openPersonRoadMediaLibrary() }
</script>

<style scoped>
.capture-preview { height: calc(100% - 20px); background: #000; color: #fff; font-family: "Open Sans", "PingFang SC", "Microsoft YaHei", sans-serif; }
.capture-preview > p { display: flex; height: 100%; align-items: center; justify-content: center; margin: 0; color: rgba(255,255,255,.7); font-size: 12px; }
</style>
