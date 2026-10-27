<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, onMounted, ref } from 'vue'
import { useIdeContext } from '../../composables/use-ide'
import { useFileTreeStore } from '../../stores/file-tree'
import { fileIconOf } from '../tree/tree-icons'

/**
 * 文件名搜索面板：对 fileTree.allFiles 做大小写不敏感的包含匹配，
 * 点击结果在编辑器打开。数据源与文件树同源（file-tree store）。
 */
const ide = useIdeContext()
const tree = useFileTreeStore()
const query = ref('')
const input = ref<HTMLInputElement | null>(null)

const MAX_RESULTS = 200

const keyword = computed(() => query.value.trim().toLowerCase())
const matches = computed(() =>
  keyword.value === '' ? [] : tree.allFiles.filter(path => path.toLowerCase().includes(keyword.value)))

const results = computed(() => matches.value
  .slice(0, MAX_RESULTS)
  .map(path => ({ path, icon: fileIconOf(path.split('/').pop() ?? path) })))

onMounted(() => {
  input.value?.focus()
})
</script>

<template>
  <div class="search-pane">
    <input
      ref="input"
      v-model="query"
      class="search-input"
      type="text"
      placeholder="按文件名过滤…"
      spellcheck="false"
    >
    <div v-if="query.trim() === ''" class="panel-empty">
      输入关键字按文件名过滤工作区文件。
    </div>
    <div v-else-if="results.length === 0" class="panel-empty">
      没有匹配的文件。
    </div>
    <div v-else class="search-results">
      <div
        v-for="row in results"
        :key="row.path"
        class="search-result"
        :title="row.path"
        tabindex="0"
        @click="void ide.openFile(row.path)"
        @keydown.enter="void ide.openFile(row.path)"
      >
        <component :is="row.icon.component" class="tree-icon" :class="[row.icon.cls]" />
        <span class="search-path">{{ row.path }}</span>
      </div>
      <div v-if="matches.length > results.length" class="search-truncated">
        结果过多，仅显示前 {{ MAX_RESULTS }} 条。
      </div>
    </div>
  </div>
</template>
