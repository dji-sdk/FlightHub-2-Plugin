<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="patrol-task-panel"
       :class="state.phase ? `phase-${state.phase}` : 'phase-preparing'"
       data-plugin-view="patrol-task-panel">
    <div class="ptp-header">
      <span class="ptp-title">违停抓拍</span>
      <button v-if="state.isReview"
              class="ptp-close-x"
              aria-label="关闭面板"
              @click="run(client.dismiss)">
        <svg viewBox="0 0 12 12" width="12" height="12">
          <path d="M1.5 1.5L10.5 10.5M10.5 1.5L1.5 10.5"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <div class="ptp-content">
      <div class="ptp-route">
        <div class="ptp-route-label-row">
          <span class="ptp-route-label">巡逻路段</span>
        </div>
        <div class="ptp-select">
          <span class="ptp-select-text"
                :class="{ placeholder: !state.routeName }"
                :title="state.routeName">
            {{ state.routeName || '—' }}
          </span>
        </div>
      </div>

      <div v-if="state.preparing"
           class="ptp-preparing">
        <span class="ptp-preparing-text">正在准备巡逻…</span>
      </div>

      <div v-else-if="state.rejected"
           class="ptp-rejected">
        <span class="ptp-rejected-text">{{ state.rejectText }}</span>
      </div>

      <div v-else-if="state.showProgress"
           class="ptp-progress">
        <div class="ptp-progress-row">
          <div class="ptp-progress-label"
               :class="state.initialActive ? 'active' : 'inactive'">
            {{ state.initialLabel }}
          </div>
          <div class="ptp-bar">
            <div class="ptp-bar-track" />
            <div class="ptp-bar-fill"
                 :style="{ width: state.initialPercent + '%' }" />
          </div>
        </div>
        <div class="ptp-progress-row">
          <div class="ptp-progress-label"
               :class="state.recheckActive ? 'active' : 'inactive'">
            {{ state.recheckLabel }}
          </div>
          <div class="ptp-bar">
            <div class="ptp-bar-track" />
            <div class="ptp-bar-fill"
                 :style="{ width: state.recheckPercent + '%' }" />
          </div>
        </div>
      </div>

      <button v-if="state.showEndButton"
              class="ptp-btn ptp-btn-danger"
              :disabled="state.endButtonDisabled"
              @click="run(client.requestEndTask)">
        {{ state.endButtonText }}
      </button>

      <div v-if="state.isReview"
           class="ptp-review-bar">
        <span class="ptp-review-text">{{ state.reviewText }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { onMounted, onUnmounted, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import type { TaskPanelClient, TaskPanelState } from './contract'

/**
 * 违停巡逻任务面板（悬浮于直播画面左下角，280px）。
 * 巡逻路段为只读展示（新版契约：航线在计划库选定）。
 */
const props = defineProps<{ client: TaskPanelClient }>()
const client = props.client

const state = shallowRef<TaskPanelState>({
  phase: null,
  preparing: true,
  rejected: false,
  rejectText: '',
  routeName: '',
  showProgress: false,
  initialLabel: '初检 — 已执行航点（0/0）',
  recheckLabel: '复检 — 已处理车辆（0/0）',
  initialPercent: 0,
  recheckPercent: 0,
  initialActive: false,
  recheckActive: false,
  showEndButton: false,
  endButtonDisabled: true,
  endButtonText: '终止巡逻',
  isReview: false,
  reviewText: '',
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
.patrol-task-panel {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  background: rgba(31, 31, 31, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  font-family: "Open Sans", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #fff;
}

.ptp-header {
  height: 32px;
  position: relative;
  flex-shrink: 0;
}
.ptp-title {
  position: absolute;
  left: 12px;
  top: 8px;
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
  color: rgba(255, 255, 255, 0.7);
}
.ptp-close-x {
  position: absolute;
  right: 8px;
  top: 6px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.3);
  cursor: pointer;
  border-radius: 4px;
  transition: color 0.15s, background 0.15s;
}
.ptp-close-x:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.08);
}

.ptp-content {
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ptp-route {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ptp-route-label-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.ptp-route-label {
  font-size: 14px;
  font-weight: 400;
  line-height: 24px;
  color: rgba(255, 255, 255, 0.7);
}

.ptp-select {
  box-sizing: border-box;
  height: 32px;
  background: rgba(42, 42, 42, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 4px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.ptp-select-text {
  font-size: 14px;
  line-height: 24px;
  color: #fff;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ptp-select-text.placeholder {
  color: rgba(255, 255, 255, 0.7);
}

.ptp-preparing,
.ptp-rejected {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
  padding: 4px 0;
}
.ptp-preparing-text {
  font-size: 14px;
  line-height: 24px;
  color: rgba(255, 255, 255, 0.7);
}
.ptp-rejected-text {
  font-size: 14px;
  line-height: 22px;
  color: #ff9300;
  text-align: center;
}

.ptp-progress {
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 0;
  overflow: hidden;
}
.ptp-progress-row {
  padding: 4px 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ptp-progress-label {
  height: 24px;
  line-height: 24px;
  text-align: center;
  padding: 0 12px;
  font-size: 14px;
  font-weight: 400;
}
.ptp-progress-label.active { color: #fff; }
.ptp-progress-label.inactive { color: rgba(255, 255, 255, 0.3); }

.ptp-bar {
  position: relative;
  width: 100%;
  height: 2px;
}
.ptp-bar-track {
  position: absolute;
  inset: 0;
  height: 2px;
  background: #505050;
}
.ptp-bar-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 2px;
  background: #19be6b;
  transition: width 0.3s ease;
}

.ptp-btn {
  height: 32px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  line-height: 24px;
  width: 100%;
  transition: background 0.15s, opacity 0.15s;
}
.ptp-btn-danger {
  background: transparent;
  color: #e41f29;
}
.ptp-btn-danger:hover { background: rgba(228, 31, 41, 0.1); }
.ptp-btn-danger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ptp-btn-danger:disabled:hover { background: transparent; }

.ptp-review-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 32px;
}
.ptp-review-text {
  font-size: 14px;
  font-weight: 400;
  line-height: 24px;
  color: rgba(255, 255, 255, 0.7);
}
</style>
