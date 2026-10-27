<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed } from 'vue'
import { useIdeContext } from '../../composables/use-ide'
import { useUiStore } from '../../stores/ui'
import FileTree from '../tree/FileTree.vue'
import SearchPane from './SearchPane.vue'

/** 资源管理器侧栏：按活动栏视图切换 文件树 / 文件搜索。 */
const ide = useIdeContext()
const ui = useUiStore()

const title = computed(() => ui.sidebarView === 'files' ? '资源管理器' : '搜索')
</script>

<template>
  <div class="sidebar">
    <div class="sidebar-title">
      <span>{{ title }}</span>
      <div v-if="ui.sidebarView === 'files'" class="sidebar-actions">
        <button id="btn-new-file" type="button" class="ghost icon" title="在当前文件同级新建文件" @click="void ide.promptCreate('file')">
          ＋文件
        </button>
        <button id="btn-new-dir" type="button" class="ghost icon" title="在当前文件同级新建目录" @click="void ide.promptCreate('dir')">
          ＋目录
        </button>
        <button id="btn-refresh" type="button" class="ghost icon" @click="void ide.refreshTree()">
          刷新
        </button>
      </div>
    </div>
    <FileTree v-if="ui.sidebarView === 'files'" />
    <SearchPane v-else />
  </div>
</template>
