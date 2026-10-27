<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <section class="issue-dialog" data-plugin-view="issue-dialog">
    <main>
      <label>
        <span>问题标题</span>
        <input v-model.trim="title" maxlength="100" placeholder="例如：机场入口发现占道物">
      </label>
      <label>
        <span>问题等级</span>
        <select v-model="severity">
          <option value="low">一般</option>
          <option value="medium">重要</option>
          <option value="high">紧急</option>
        </select>
      </label>
      <label>
        <span>问题描述</span>
        <textarea v-model.trim="description" maxlength="500" rows="4" placeholder="描述现场情况和处理建议" />
      </label>
    </main>
    <footer>
      <button :disabled="state.pending" @click="run(client.cancel)">
        取消
      </button>
      <button class="primary" :disabled="!canSubmit" @click="submit">
        {{ state.pending ? '提交中…' : '确认上报' }}
      </button>
    </footer>
  </section>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import type { IssueDialogClient, IssueDialogState } from './contract'

const props = defineProps<{ client: IssueDialogClient }>()
const client = props.client
const state = shallowRef<IssueDialogState>({ pending: false })
const title = ref('')
const description = ref('')
const severity = ref<'low' | 'medium' | 'high'>('medium')
const canSubmit = computed(() => !state.value.pending && title.value.length > 0 && description.value.length > 0)
let subscription: Disposable | undefined

onMounted(() => {
  subscription = client.state.subscribe((value) => {
    state.value = value
  })
})
onUnmounted(() => subscription?.dispose())

function submit (): void {
  if (!canSubmit.value)
    return
  run(() => client.submit({ title: title.value, description: description.value, severity: severity.value }))
}

function run (operation: () => unknown): void {
  const result = operation()
  if (result instanceof Promise)
    result.catch(() => {})
}
</script>

<style scoped>
.issue-dialog { display: flex; flex-direction: column; min-height: 340px; color: #fff; background: #17191d; font: 14px/1.5 "Open Sans", "PingFang SC", sans-serif; }
.issue-dialog * { box-sizing: border-box; } main { display: grid; gap: 16px; padding: 24px 28px; } label { display: grid; gap: 7px; } label span { color: rgba(255,255,255,.7); }
input, select, textarea { width: 100%; padding: 9px 10px; color: #fff; background: #25282e; border: 1px solid rgba(255,255,255,.14); border-radius: 4px; outline: none; } textarea { resize: vertical; }
input:focus, select:focus, textarea:focus { border-color: #2b8cff; }
footer { display: flex; gap: 10px; justify-content: flex-end; padding: 14px 28px; border-top: 1px solid rgba(255,255,255,.08); }
button { min-width: 96px; height: 34px; color: #fff; cursor: pointer; background: #343a43; border: 0; border-radius: 4px; } button:disabled { cursor: not-allowed; opacity: .45; }.primary { background: #0075ff; }
</style>
