<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <section class="issue-panel" data-plugin-view="issue-panel">
    <header>
      <div>
        <strong>现场问题</strong>
        <span>{{ activeCount }} 项待处理</span>
      </div>
      <button class="close" aria-label="关闭现场问题面板" @click="run(client.dismiss)">
        ×
      </button>
    </header>
    <div class="issue-list">
      <p v-if="state.error" class="error">
        {{ state.error }}
      </p>
      <p v-else-if="state.issues.length === 0" class="empty">
        暂无现场问题
      </p>
      <article v-for="issue in state.issues" v-else :key="issue.id">
        <div>
          <strong>{{ issue.title }}</strong>
          <small>{{ statusLabel[issue.status] }}</small>
        </div>
        <button v-if="issue.status === 'new'" @click="run(() => client.acknowledgeIssue({ id: issue.id }))">
          签收
        </button>
        <button v-else-if="issue.status !== 'resolved'" @click="run(() => client.resolveIssue({ id: issue.id }))">
          完成
        </button>
      </article>
    </div>
    <footer>
      <button class="primary" @click="run(client.requestCreate)">
        上报问题
      </button>
    </footer>
  </section>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, onMounted, onUnmounted, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import type { IssuePanelClient, IssuePanelState } from './contract'

const props = defineProps<{ client: IssuePanelClient }>()
const client = props.client
const state = shallowRef<IssuePanelState>({ issues: [], error: '' })
const activeCount = computed(() => state.value.issues.filter(issue => issue.status !== 'resolved').length)
let subscription: Disposable | undefined

onMounted(() => {
  subscription = client.state.subscribe((value) => {
    state.value = value
  })
})
onUnmounted(() => subscription?.dispose())

const statusLabel = { new: '待签收', acknowledged: '处理中', resolved: '已完成' } as const

function run (operation: () => unknown): void {
  const result = operation()
  if (result instanceof Promise)
    result.catch(() => {})
}
</script>

<style scoped>
.issue-panel { width: 280px; overflow: hidden; color: #fff; background: rgba(31,31,31,.92); border: 1px solid rgba(255,255,255,.08); border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,.3); backdrop-filter: blur(12px); font: 13px/1.4 "Open Sans", "PingFang SC", sans-serif; }
.issue-panel * { box-sizing: border-box; }
header { display: flex; align-items: center; justify-content: space-between; height: 42px; padding: 0 14px; border-bottom: 1px solid rgba(255,255,255,.08); }
header div { display: flex; align-items: baseline; gap: 8px; }
header span { color: rgba(255,255,255,.48); font-size: 11px; }
button { color: #fff; cursor: pointer; border: 0; border-radius: 4px; }
.close { padding: 2px 6px; background: transparent; font-size: 18px; }
.issue-list { max-height: 300px; padding: 6px 14px; overflow-y: auto; }
article { padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,.08); }
article div { display: flex; gap: 8px; justify-content: space-between; } article small { color: #ffbd71; }
article button { margin-top: 7px; padding: 4px 10px; background: rgba(255,255,255,.1); }
.error { color: #ff8a92; }.empty { color: rgba(255,255,255,.45); }
footer { display: flex; gap: 8px; padding: 12px 14px; } footer button { flex: 1; height: 32px; }
.primary { background: #0075ff; }
</style>
