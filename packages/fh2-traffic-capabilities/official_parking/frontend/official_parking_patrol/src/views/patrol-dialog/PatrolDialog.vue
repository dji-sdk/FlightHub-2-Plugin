<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="patrol-dialog"
       data-plugin-view="patrol-dialog">
    <div class="patrol-dialog-body">
      <div class="patrol-dialog-icon-title">
        <div class="patrol-dialog-icon"
             :class="`icon-${state.iconType}`">
          <svg v-if="state.iconType === 'warning'"
               width="20" height="20" viewBox="0 0 35 35" fill="none"
               xmlns="http://www.w3.org/2000/svg">
            <rect x="15.625" y="6.8994" width="3.75" height="15" rx="0.5" fill="white" />
            <rect x="15.625" y="24.3506" width="3.75" height="3.75" rx="0.5" fill="white" />
          </svg>
          <svg v-else
               width="20" height="17" viewBox="0 0 20 17" fill="none"
               xmlns="http://www.w3.org/2000/svg">
            <path d="M9.68804 14.3083L7.19771 16.7589L7.04682 16.9252M7.02878 16.9252L0 10.0094L2.65925 7.39291L6.88464 11.5503L17.3415 0L20 2.61684L9.68804 14.3083" fill="white" />
          </svg>
        </div>
        <div class="patrol-dialog-title">{{ state.title }}</div>
      </div>
      <div v-if="state.description"
           class="patrol-dialog-desc">{{ state.description }}</div>
    </div>
    <div class="patrol-dialog-btn-group">
      <button class="patrol-dialog-btn secondary"
              :disabled="state.confirmPending || state.cancelDisabled"
              @click="run(client.cancel)">
        {{ state.cancelText }}
      </button>
      <button class="patrol-dialog-btn primary"
              :disabled="state.confirmPending || state.confirmDisabled"
              @click="run(client.confirm)">
        {{ confirmDisplayText }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, onMounted, onUnmounted, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import type { PatrolDialogClient, PatrolDialogState } from './contract'

/**
 * 确认弹窗（288×248 两段式布局）
 * 遮罩与 ESC 由宿主 platform:dialog 提供；按钮事件回传 Entry。
 */
const props = defineProps<{ client: PatrolDialogClient }>()
const client = props.client

const state = shallowRef<PatrolDialogState>({
  kind: 'end-task',
  iconType: 'warning',
  title: '',
  description: '',
  cancelText: '取消',
  confirmText: '确定',
  countdown: 0,
  confirmPending: false,
  cancelDisabled: false,
  confirmDisabled: false,
})

let subscription: Disposable | undefined

onMounted(() => {
  subscription = client.state.subscribe(value => { state.value = value })
})
onUnmounted(() => subscription?.dispose())

const confirmDisplayText = computed(() =>
  state.value.countdown > 0 ? `${state.value.confirmText}(${state.value.countdown}s)` : state.value.confirmText,
)

function run (action: () => unknown): void {
  const result = action()
  if (result instanceof Promise) result.catch(() => {})
}
</script>

<style scoped>
.patrol-dialog {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  background: #1f1f1f;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: "Open Sans", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #fff;
}

.patrol-dialog-body {
  box-sizing: border-box;
  flex: 1;
  min-height: 184px;
  padding: 32px 16px 16px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 12px;
  flex-shrink: 1;
}

.patrol-dialog-icon-title {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 16px;
}

.patrol-dialog-icon {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.patrol-dialog-icon.icon-warning { background: #ff9300; }
.patrol-dialog-icon.icon-success { background: #19be6b; }

.patrol-dialog-title {
  font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 16px;
  font-weight: 600;
  line-height: 24px;
  color: #fff;
  text-align: center;
}

.patrol-dialog-desc {
  font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  color: #fff;
  text-align: center;
  width: 256px;
  flex-shrink: 1;
  white-space: pre-line;
}

.patrol-dialog-btn-group {
  box-sizing: border-box;
  height: 64px;
  background: #1f1f1f;
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  gap: 16px;
  padding: 16px;
  flex-shrink: 0;
}

.patrol-dialog-btn {
  box-sizing: border-box;
  width: 120px;
  height: 32px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px 16px;
  font-family: "Open Sans", "PingFang SC", sans-serif;
  font-size: 14px;
  font-weight: 600;
  line-height: 24px;
  color: #fff;
  transition: opacity 0.15s;
}
.patrol-dialog-btn:hover { opacity: 0.85; }
.patrol-dialog-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.patrol-dialog-btn.secondary {
  background: #2a2a2a;
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.patrol-dialog-btn.primary {
  background: #0075ff;
}
</style>
