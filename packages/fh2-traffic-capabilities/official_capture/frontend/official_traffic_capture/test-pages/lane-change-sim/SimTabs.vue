<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="sim-tabs-root">
    <header class="sim-tabs-bar">
      <nav class="sim-tabs-nav">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="sim-tab-btn"
          :class="{ active: activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </nav>
    </header>

    <div class="sim-tab-body" v-show="activeTab === 'synthetic'">
      <App />
    </div>
    <div class="sim-tab-body" v-show="activeTab === 'video'">
      <VideoApp />
    </div>
  </div>
</template>

<script lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { defineComponent, ref } from 'vue'
import App from './App.vue'
import VideoApp from './video/VideoApp.vue'

/**
 * 模拟器顶层 tab 壳：合成场景页（原有 App.vue，不改动）与
 * 真机录像验证页相互独立，各自持有 SimRunner；v-show 保证切换不丢状态。
 */
export default defineComponent({
  name: 'SimTabs',
  components: { App, VideoApp },
  setup () {
    const tabs = [
      { id: 'synthetic' as const, label: '合成场景模拟器' },
      { id: 'video' as const, label: '真机录像验证' },
    ]
    const activeTab = ref<'synthetic' | 'video'>('synthetic')

    return { tabs, activeTab }
  },
})
</script>

<style scoped>
.sim-tabs-root {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #050607;
}

.sim-tabs-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  padding: 4px 8px 0;
  background: #050607;
  border-bottom: 1px solid rgba(60, 67, 78, 0.92);
}

.sim-tabs-nav {
  display: flex;
  gap: 4px;
}

.sim-tab-btn {
  padding: 6px 16px;
  font-size: 12px;
  font-weight: 600;
  color: #94a3b8;
  background: rgba(17, 21, 29, 0.9);
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-bottom: none;
  border-radius: 4px 4px 0 0;
  cursor: pointer;
}

.sim-tab-btn:hover {
  color: #e2e8f0;
}

.sim-tab-btn.active {
  color: #7dd3fc;
  background: #0b0f17;
  border-color: rgba(56, 189, 248, 0.42);
}

.sim-tab-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}
</style>
