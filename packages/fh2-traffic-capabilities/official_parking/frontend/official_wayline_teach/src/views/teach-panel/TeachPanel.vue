<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <section
    class="teach-panel"
    data-plugin-view="teach-panel"
  >
    <template v-if="state.phase !== 'generated'">
      <header class="teach-header">
        <strong>示教航线</strong>
        <span v-if="state.mockMode" class="mock-status">模拟</span>
      </header>

      <div class="teach-params">
        <div class="teach-param">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 18.5V7.8a3.3 3.3 0 0 1 6.6 0v8.4a3.3 3.3 0 0 0 6.6 0V5.5" />
            <circle cx="4" cy="18.5" r="2" />
            <circle cx="17.2" cy="5.5" r="2" />
          </svg>
          <strong>{{ state.routeDistance }}</strong>
        </div>
        <div class="teach-param-divider" />
        <div class="teach-param">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3 4.5 15h15L12 3Z" />
            <path d="M12 10.5v8" />
          </svg>
          <strong>{{ state.waypoints.length }}</strong>
        </div>
      </div>

      <div class="teach-actions">
        <div class="record-button-wrapper">
          <button
            class="secondary"
            :title="recordDisabledReason"
            :disabled="!canRecord"
            @click="run(client.recordWaypoint)"
          >
            <span v-if="state.busy" class="spinner" />
            {{ state.busy ? '处理中...' : '新增航点' }}
          </button>
          <span class="hotkey-badge">H</span>
        </div>
        <button
          class="primary"
          :disabled="!canGenerate"
          @click="run(client.requestGenerate)"
        >
          示教完成
        </button>
      </div>
    </template>

    <section
      v-else
      class="generated"
    >
      <header class="teach-header">
        <strong>示教航线</strong>
        <div class="generated-header-actions">
          <span class="generated-status">{{ isMockResult ? '模拟生成' : '已生成' }}</span>
          <button
            class="teach-close-button"
            aria-label="关闭示教面板"
            @click="run(client.dismiss)"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m3 3 10 10M13 3 3 13" />
            </svg>
          </button>
        </div>
      </header>
      <div class="generated-body">
        <div class="generated-mark">KMZ</div>
        <strong class="generated-name" :title="state.routeName">{{ state.routeName }}</strong>
        <span class="generated-tip">{{ isMockResult ? '模拟结果不会生成真实 KMZ' : '航点已清除，当前航线不可再修改' }}</span>
      </div>
      <dl>
        <div><dt>航点数</dt><dd>{{ state.waypointCount }}</dd></div>
        <div><dt>全局速度</dt><dd>{{ state.globalSpeed }}m/s</dd></div>
        <div><dt>航点速度</dt><dd>{{ state.waypointSpeed }}m/s</dd></div>
        <div><dt>文件 ID</dt><dd>{{ state.waylineFileId || '待文件服务返回' }}</dd></div>
      </dl>
      <button
        class="primary new-teach"
        @click="run(client.startNewTeaching)"
      >
        新建示教
      </button>
    </section>
  </section>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, onMounted, onUnmounted, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import type { TeachPanelClient, TeachPanelState } from './contract'

const props = defineProps<{ client: TeachPanelClient }>()
const client = props.client
const state = shallowRef<TeachPanelState>({
  phase: 'idle',
  ready: false,
  disabledReason: '等待驾驶舱数据',
  busy: false,
  mockMode: false,
  routeName: '',
  routeDistance: '0m',
  globalSpeed: 15,
  waypointSpeed: 5,
  waylineUuid: null,
  waylineFileId: null,
  waypointCount: 0,
  screenshotBytes: 0,
  screenshotQuotaBytes: 80 * 1024 * 1024,
  waypoints: [],
  selectedCount: 0,
})
let subscription: Disposable | undefined

const quotaPercent = computed(() => Math.min(100, state.value.screenshotBytes / state.value.screenshotQuotaBytes * 100))
const canRecord = computed(() => state.value.ready && !state.value.busy
  && (state.value.phase === 'idle' || state.value.phase === 'recording') && quotaPercent.value < 100)
const canGenerate = computed(() => state.value.phase === 'recording' && state.value.waypoints.length > 0 && !state.value.busy)
const isMockResult = computed(() => state.value.waylineUuid?.startsWith('mock-') === true)
const recordDisabledReason = computed(() => quotaPercent.value >= 100
  ? '本条航线的截图空间已用尽（80MB）'
  : state.value.disabledReason || '')

onMounted(() => {
  subscription = client.state.subscribe(value => { state.value = value })
})
onUnmounted(() => {
  subscription?.dispose()
})

function run (action: () => unknown): void {
  const result = action()
  if (result instanceof Promise) result.catch(() => {})
}
</script>

<style scoped>
.teach-panel { width: 240px; color: #fff; overflow: hidden; background: rgba(31,31,31,.9); border: 1px solid rgba(255,255,255,.08); border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,.3); backdrop-filter: blur(12px); font: 14px/1.4 "Open Sans", "PingFang SC", sans-serif; }
.teach-panel * { box-sizing: border-box; }
.teach-header { display: flex; align-items: center; justify-content: space-between; box-sizing: border-box; width: 100%; height: 40px; padding: 0 16px; background: rgba(31,31,31,.95); }
.teach-header strong { font-size: 14px; font-weight: 600; }
.generated-header-actions { display: flex; align-items: center; gap: 8px; }
.mock-status { padding: 1px 5px; color: #ffbd71; background: rgba(255,189,113,.12); border-radius: 2px; font-size: 10px; }
.teach-params { display: flex; min-height: 70px; padding: 12px 0; background: rgba(31,31,31,.85); }
.teach-param { display: flex; flex: 1; flex-direction: column; gap: 6px; align-items: center; justify-content: center; }
.teach-param svg { width: 24px; height: 24px; overflow: visible; fill: none; stroke: #fff; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.6; }
.teach-param strong { font-size: 16px; font-weight: 500; }
.teach-param-divider { width: 1px; background: rgba(255,255,255,.1); }
.teach-actions { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; background: rgba(31,31,31,.9); }
.record-button-wrapper { position: relative; width: 100%; }
.teach-actions button,.new-teach { width: 100%; height: 32px; color: rgba(255,255,255,.9); cursor: pointer; border: 1px solid rgba(255,255,255,.12); border-radius: 4px; font: inherit; }
.teach-actions button:disabled { cursor: not-allowed; opacity: .4; }
.secondary { background: rgba(255,255,255,.06); }
.secondary:not(:disabled):hover { background: rgba(255,255,255,.12); }
.primary { background: #0075ff; border-color: #0075ff !important; }
.primary:not(:disabled):hover { background: #268aff; }
.hotkey-badge { position: absolute; bottom: 23px; left: 100%; display: flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; color: rgba(255,255,255,.65); background: #1f1f1f; border: 1px solid rgba(255,255,255,.08); border-radius: 9px; font-size: 12px; font-weight: 600; line-height: 18px; transform: translateX(-50%); }
.spinner { display: inline-block; width: 12px; height: 12px; margin-right: 5px; vertical-align: -2px; border: 1px solid rgba(255,255,255,.35); border-top-color: #fff; border-radius: 50%; animation: spin .8s linear infinite; }
.generated-status { color: #69a9ff; font-size: 12px; }
.teach-close-button { display: grid; width: 20px; height: 20px; padding: 2px; color: rgba(255,255,255,.65); cursor: pointer; background: transparent; border: 0; border-radius: 3px; place-items: center; }
.teach-close-button:hover { color: #fff; background: rgba(255,255,255,.12); }
.teach-close-button svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-width: 1.5; }
.generated-body { display: flex; flex-direction: column; align-items: center; padding: 18px 16px 10px; text-align: center; }
.generated-mark { display: grid; place-items: center; width: 42px; height: 42px; margin-bottom: 10px; color: #70b3ff; background: rgba(0,117,255,.18); border-radius: 50%; font-size: 12px; font-weight: 700; }
.generated-name { display: block; max-width: 100%; overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.generated-tip { margin-top: 5px; color: rgba(255,255,255,.45); font-size: 11px; }
.generated dl { margin: 0; padding: 0 16px 12px; font-size: 12px; }
.generated dl div { display: flex; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,.07); }
.generated dt { color: rgba(255,255,255,.55); }
.generated dd { max-width: 135px; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.new-teach { width: calc(100% - 32px); margin: 0 16px 14px; background: #0075ff; border: 0; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
