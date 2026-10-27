<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="rename-dialog" data-plugin-view="lane-change-rename-dialog">
    <input ref="input"
           v-model="name"
           class="rename-input"
           type="text"
           maxlength="32"
           data-testid="rename-input"
           @keydown.enter="confirm"
           @keydown.esc="cancel">
    <div class="rename-actions">
      <button class="op-btn" type="button" data-testid="rename-cancel" @click="cancel">取消</button>
      <button class="op-btn primary" type="button" data-testid="rename-confirm" @click="confirm">确定</button>
    </div>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import type { LaneChangeRenameDialogClient, LaneChangeRenameDialogState } from './contract'

const props = defineProps<{ client: LaneChangeRenameDialogClient }>()
const state = shallowRef<LaneChangeRenameDialogState>({ initialName: '' })
const name = ref('')
const input = ref<HTMLInputElement>()
let subscription: Disposable | undefined

onMounted(() => {
  subscription = props.client.state.subscribe(value => {
    state.value = value
    name.value = value.initialName
  })
  void nextTick(() => input.value?.focus())
})
onUnmounted(() => subscription?.dispose())

function confirm (): void {
  void props.client.confirm({ name: name.value })
}

function cancel (): void {
  void props.client.cancel()
}
</script>

<style scoped>
* { box-sizing: border-box; }
.rename-dialog { background: #1f1f1fd9; display: flex; width: 100%; height: 100%; flex-direction: column; gap: 12px; padding: 16px; font: 12px/1.4 system-ui, sans-serif; }
.rename-input { width: 100%; height: 32px; padding: 0 8px; border: 1px solid rgba(255, 255, 255, .15); border-radius: 4px; background: rgba(255, 255, 255, .08); color: #fff; font-size: 13px; outline: none; }
.rename-input:focus { border-color: #0075ff; }
.rename-actions { display: flex; justify-content: flex-end; gap: 8px; }
.rename-actions .op-btn { flex: none; min-width: 64px; padding: 6px 8px; border: 1px solid rgba(255, 255, 255, .15); border-radius: 4px; background: #2b2b2b; color: #fff; font-size: 12px; cursor: pointer; }
.rename-actions .op-btn:hover { border-color: #5b7fd4; }
.rename-actions .op-btn.primary { background: #0075ff; color: #ffffff; }
</style>
