<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <PluginViewProvider :style-target="styleTarget">
    <div class="panel-anchor">
      <section class="return-panel">
        <header>
          <strong>沿路网返航</strong>
          <button
            class="refresh-button"
            aria-label="刷新"
            :disabled="state.phase === 'loading' || state.phase === 'executing'"
            @click="run(client.refresh)"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M8 16H3v5" />
            </svg>
          </button>
        </header>
        <n-alert v-if="state.error" type="error" :bordered="false">{{ state.error }}</n-alert>
        <div class="panel-body">
          <n-spin :show="state.phase === 'loading'">
            <div v-if="state.routes.length" class="routes">
              <button
                v-for="(route, index) in state.routes"
                :key="route.id"
                :class="{ selected: index === state.selectedIndex }"
                @click="run(() => client.selectRoute({ index }))"
              >
                <span>{{ route.label }}</span>
                <small>{{ formatRouteMeta(route) }}</small>
              </button>
            </div>
            <div v-else-if="state.phase === 'ready' || state.phase === 'error'" class="empty">暂无可用路网路线</div>
          </n-spin>
        </div>
        <footer>
          <n-button class="footer-button" secondary :disabled="state.phase === 'loading' || state.phase === 'executing'" @click="run(client.close)">关闭面板</n-button>
          <n-button class="footer-button" type="primary" :loading="state.phase === 'executing'" :disabled="!canExecute" @click="run(client.execute)">执行返航</n-button>
        </footer>
      </section>
    </div>
  </PluginViewProvider>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { NAlert, NButton, NSpin } from 'naive-ui'
import { computed, onMounted, onUnmounted, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import PluginViewProvider from '../shared/PluginViewProvider.vue'
import { canExecuteReturnRoute, formatRouteMeta } from './contract'
import type { ReturnRoutePanelState, ReturnRoutePanelViewClient } from './contract'

const props = defineProps<{ client: ReturnRoutePanelViewClient; styleTarget: ShadowRoot | HTMLHeadElement }>()
const state = shallowRef<ReturnRoutePanelState>({ phase: 'idle', routes: [], selectedIndex: -1, error: null })
const canExecute = computed(() => canExecuteReturnRoute(state.value))
const client = props.client
let subscription: Disposable | undefined
onMounted(() => { subscription = client.state.subscribe(value => { state.value = value }) })
onUnmounted(() => subscription?.dispose())

async function run (action: () => unknown | Promise<unknown>): Promise<void> {
  try { await action() } catch { /* Controller 已将错误写入 state。 */ }
}
</script>

<style scoped>
.panel-anchor { display: flex; height: 100%; min-height: 0; align-items: flex-end; justify-content: flex-end; }
.return-panel { display: flex; flex-direction: column; box-sizing: border-box; width: 290px; max-height: 100%; padding: 16px; background: #2a2a2a; color: #fff; border-radius: 4px; overflow: hidden; }
.return-panel > header { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.return-panel > header strong { font-size: 14px; font-weight: 600; line-height: 24px; }
.refresh-button { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: 0; background: transparent; color: #0075ff; cursor: pointer; }
.refresh-button:hover:not(:disabled) { color: #3d94ff; }
.refresh-button:disabled { opacity: 0.4; cursor: default; }
.return-panel > .n-alert { margin-bottom: 8px; flex-shrink: 0; }
.panel-body { flex: 0 1 auto; min-height: 48px; max-height: 40vh; overflow-y: auto; }
.panel-body :deep(.n-spin-content) { min-height: 64px; }
.routes { display: grid; gap: 8px; }
.routes button { display: flex; justify-content: space-between; gap: 8px; padding: 12px; border: 2px solid transparent; border-radius: 4px; background: #3e3e3e; color: #fff; cursor: pointer; font-size: 14px; line-height: 24px; text-align: left; transition: border-color 0.15s; }
.routes button.selected { border-color: #0075ff; }
.routes small { align-self: center; flex-shrink: 0; color: rgb(255 255 255 / 40%); font-size: 12px; }
.empty { padding: 16px 0; color: rgb(255 255 255 / 40%); font-size: 14px; text-align: center; }
.return-panel > footer { display: flex; flex-shrink: 0; gap: 12px; margin-top: 16px; }
.footer-button { flex: 1 1 0; width: 100%; }
</style>
