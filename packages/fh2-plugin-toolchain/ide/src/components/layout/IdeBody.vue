<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { Pane, Splitpanes } from 'splitpanes'
import { useStartupStore } from '../../stores/startup'
import { useUiStore } from '../../stores/ui'
import StartCenter from '../startup/StartCenter.vue'
import ActivityBar from './ActivityBar.vue'
import MainArea from './MainArea.vue'
import SideBar from './SideBar.vue'

/** 主体区：活动栏 + 侧栏/主区 纵向分割。由 App.vue 在两种面板布局态下复用；N2：无工程时为 Start Center。 */
const ui = useUiStore()
const startup = useStartupStore()
</script>

<template>
  <StartCenter v-if="ui.view === 'start' && startup.showStartCenter" />
  <div v-else class="ide-body">
    <ActivityBar />
    <Splitpanes class="default-theme fh2-split">
      <Pane :size="17" :min-size="10" :max-size="45" class="fh2-split-sidebar">
        <SideBar />
      </Pane>
      <Pane :size="83">
        <MainArea />
      </Pane>
    </Splitpanes>
  </div>
</template>
