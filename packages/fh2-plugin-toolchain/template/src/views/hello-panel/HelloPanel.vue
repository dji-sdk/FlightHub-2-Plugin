<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <section class="hello-panel" data-plugin-view="hello-panel">
    <p class="eyebrow">
      FH2 PLUGIN
    </p>
    <h2>我的第一个插件 View</h2>
    <p>Entry 持有业务状态，Vue View 通过 typed channel 读取和更新。</p>
    <button type="button" @click="onIncrement">
      点击次数：{{ state.count }}
    </button>
  </section>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import type { HelloPanelState } from './contract'

defineProps<{
  state: HelloPanelState;
  onIncrement: () => Promise<HelloPanelState>;
}>()
</script>

<style scoped>
.hello-panel {
  width: 300px;
  padding: 20px;
  color: #172033;
  background: linear-gradient(145deg, #f8fbff, #e8f1ff);
  border: 1px solid #bdd2ef;
  border-radius: 12px;
  box-shadow: 0 16px 40px rgb(30 64 175 / 12%);
  font: 14px/1.6 system-ui, sans-serif;
}

.eyebrow {
  margin: 0 0 4px;
  color: #2563eb;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
}

h2 {
  margin: 0 0 8px;
  font-size: 18px;
}

button {
  margin-top: 10px;
  padding: 8px 14px;
  color: white;
  background: #1d4ed8;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
}
</style>
