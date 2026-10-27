<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { ChevronForwardOutline } from '@vicons/ionicons5'
import { useResizeObserver } from '@vueuse/core'
import { computed, nextTick, ref, watch } from 'vue'
import { NScrollbar } from 'naive-ui'
import type { ScrollbarInst } from 'naive-ui'
import { useDocumentsStore } from '../../stores/documents'
import { fileIconOf } from '../tree/tree-icons'

const documents = useDocumentsStore()
const root = ref<HTMLElement | null>(null)
const scrollbar = ref<ScrollbarInst | null>(null)
const segments = computed(() => (documents.active ?? '').split('/').filter(Boolean))
const fileIcon = computed(() => fileIconOf(segments.value.at(-1) ?? ''))

async function showCurrentFile (): Promise<void> {
  await nextTick()
  scrollbar.value?.scrollTo({ left: Number.MAX_SAFE_INTEGER })
}

watch(() => documents.active, showCurrentFile, { immediate: true })
useResizeObserver(root, () => void showCurrentFile())
</script>

<template>
  <nav v-if="documents.active !== null" ref="root" class="editor-breadcrumbs" aria-label="当前文件路径" :title="documents.active">
    <NScrollbar ref="scrollbar" x-scrollable class="breadcrumbs-scrollbar">
      <ol class="breadcrumbs-track">
        <li v-for="(segment, index) in segments" :key="index" class="breadcrumb-item">
          <ChevronForwardOutline v-if="index > 0" class="breadcrumb-separator" aria-hidden="true" />
          <span v-if="index === segments.length - 1" class="breadcrumb-file" aria-current="page">
            <component :is="fileIcon.component" class="tree-icon" :class="[fileIcon.cls]" aria-hidden="true" />
            {{ segment }}
          </span>
          <span v-else class="breadcrumb-directory">{{ segment }}</span>
        </li>
      </ol>
    </NScrollbar>
  </nav>
</template>

<style scoped>
.editor-breadcrumbs {
  min-width: 0;
  height: 22px;
  flex-shrink: 0;
  background: var(--bg);
  color: var(--fg-muted);
  font-size: 12px;
}

.breadcrumbs-scrollbar {
  height: 100%;
  min-width: 0;
}

.breadcrumbs-track {
  display: flex;
  align-items: center;
  width: max-content;
  height: 22px;
  padding: 0 12px;
  list-style: none;
  white-space: nowrap;
}

.breadcrumb-item,
.breadcrumb-file {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.breadcrumb-separator {
  width: 12px;
  height: 12px;
  margin: 0 5px;
  flex-shrink: 0;
}

.breadcrumb-file {
  gap: 5px;
  color: var(--fg);
}

.breadcrumb-file .tree-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.breadcrumb-directory:hover,
.breadcrumb-file:hover {
  color: var(--fg-strong);
}
</style>
