<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <PluginViewProvider :style-target="styleTarget">
    <section class="dispatch-workspace" data-plugin-view="alert-dispatch-workspace" data-testid="alert-workspace-root">
      <header class="workspace-header">
        <strong>警情派遣 · 工作区</strong>
        <span class="workspace-tag">测试渲染</span>
      </header>

      <div class="workspace-body">
        <div class="status-grid">
          <div class="status-card">
            <span class="status-label">提交状态</span>
            <span class="status-value" data-testid="alert-workspace-submitting">
              {{ state.submitting ? '提交中' : '空闲' }}
            </span>
          </div>
          <div class="status-card">
            <span class="status-label">最近派发事件</span>
            <span class="status-value" data-testid="alert-workspace-event-id">
              {{ state.lastEventId ?? '尚未派发' }}
            </span>
          </div>
          <div class="status-card" :class="{ 'status-card--error': state.error !== null }">
            <span class="status-label">错误信息</span>
            <span class="status-value" data-testid="alert-workspace-error">
              {{ state.error ?? '无' }}
            </span>
          </div>
        </div>

        <p class="workspace-hint">
          在左侧「派遣事故快处警情」表单提交后，此处状态实时同步——用于人工验证左侧 panel
          与右侧工作区同时渲染且共享同一份派发状态。
        </p>
      </div>
    </section>
  </PluginViewProvider>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { onMounted, onUnmounted, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import PluginViewProvider from '../shared/PluginViewProvider.vue'
import type { DispatchWorkspaceViewClient } from './contract'
import type { DispatchFormState } from '../dispatch-form/contract'

const props = defineProps<{
  client: DispatchWorkspaceViewClient;
  styleTarget: ShadowRoot | HTMLHeadElement;
  overlayElement: HTMLElement;
}>()

const state = shallowRef<DispatchFormState>({ submitting: false, lastEventId: null, error: null })

let subscription: Disposable | undefined
onMounted(() => { subscription = props.client.state.subscribe(value => { state.value = value }) })
onUnmounted(() => subscription?.dispose())
</script>

<style scoped>
.dispatch-workspace {
  display: flex;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: #151515;
  color: rgba(255, 255, 255, 1);
  font-size: 14px;
}
.workspace-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 16px;
  font-weight: 600;
}
.workspace-tag {
  padding: 2px 10px;
  border-radius: 10px;
  background: rgba(0, 117, 255, 0.25);
  color: #69b1ff;
  font-size: 12px;
  font-weight: 400;
}
.workspace-body {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 24px;
  padding: 24px 20px;
  overflow-y: auto;
}
.status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}
.status-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: #1f1f1f;
}
.status-card--error {
  border-color: rgba(240, 72, 75, 0.6);
}
.status-label {
  color: rgba(255, 255, 255, 0.55);
  font-size: 12px;
}
.status-value {
  overflow-wrap: anywhere;
  font-size: 16px;
}
.status-card--error .status-value {
  color: rgba(240, 72, 75, 1);
}
.workspace-hint {
  margin: 0;
  color: rgba(255, 255, 255, 0.45);
  font-size: 12px;
  line-height: 20px;
}
</style>
