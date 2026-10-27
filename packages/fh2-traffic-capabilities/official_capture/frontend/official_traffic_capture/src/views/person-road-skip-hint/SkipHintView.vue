<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div v-if="state.phase !== 'hidden'" class="skip-hint" data-plugin-view="person-road-skip-hint" data-testid="person-road-skip-hint">
    <template v-if="state.phase === 'confirming'">识别确认中…</template>
    <template v-else>按 <kbd>K</kbd> 退出本轮行人上路抓拍</template>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { onMounted, onUnmounted, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import type { PersonRoadSkipHintClient, PersonRoadSkipHintPhase } from './contract'

const props = defineProps<{ client: PersonRoadSkipHintClient }>()
const state = shallowRef<{ phase: PersonRoadSkipHintPhase }>({ phase: 'hidden' })
let subscription: Disposable | undefined

onMounted(() => {
  subscription = props.client.state.subscribe(value => {
    state.value = value
  })
})
onUnmounted(() => subscription?.dispose())
</script>

<style scoped>
/* 对齐原生 AIToastLiveView 的 toast 样式 */
.skip-hint { box-sizing: border-box; display: flex; width: 100%; height: 100%; align-items: center; justify-content: center; gap: 4px; background: #2a2a2a; border-radius: 4px; color: #fff; font: 14px/22px Avenir, Helvetica, Arial, sans-serif; letter-spacing: 0; text-align: center; }
.skip-hint kbd { display: flex; width: 16px; height: 16px; align-items: center; justify-content: center; border-radius: 2px; background: #e8eaec; color: rgba(0, 0, 0, .85); font: 600 11px/1 Avenir, Helvetica, Arial, sans-serif; }
</style>
