<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { NScrollbar } from 'naive-ui'
import { computed, nextTick, ref, watch } from 'vue'
import { useIdeContext } from '../../composables/use-ide'
import { useDocumentsStore } from '../../stores/documents'
import { useStatusStore } from '../../stores/status'
import { closeTargets } from '../../editor/tab-actions'
import { showContextMenu } from '../../services/context-menu'
import type { MenuEntry } from '../../services/context-menu'
import { confirmDialog } from '../../services/dialog'
import { fileIconOf } from '../tree/tree-icons'

/**
 * 编辑器 Tab 条：图标与文件树共用 fileIconOf；
 * 横向滚动用 NScrollbar（悬浮滚动条不挤压 tab 高度）；
 * 右键菜单支持 关闭 / 关闭右侧 / 关闭其他。
 * dirty 圆点占住关闭按钮的位置，hover 才换成 ×（CSS）。
 */
const ide = useIdeContext()
const documents = useDocumentsStore()
const status = useStatusStore()
const root = ref<HTMLElement | null>(null)
watch(() => documents.active, async (path) => {
  await nextTick()
  if (path !== null) root.value?.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
})

const tabs = computed(() => documents.openPaths.map((path) => {
  const name = path.split('/').pop() ?? path
  return {
    path,
    name,
    icon: fileIconOf(name),
    dirty: documents.isDirty(path),
    active: path === documents.active,
  }
}))

function select (path: string): void {
  documents.pendingClosePath = null
  void ide.openFile(path)
}

function close (path: string): void {
  ide.closeFile(path)
}

/** 批量关闭：遇脏文件一次确认；确认后绕过单文件的两次点击流直接关。 */
async function closeMany (targets: readonly string[], what: string): Promise<void> {
  if (targets.length === 0) return
  const dirty = targets.filter(path => documents.isDirty(path))
  if (dirty.length > 0) {
    const confirmed = await confirmDialog({
      title: `关闭${what}标签页会丢弃未保存的修改`,
      body: [`以下文件有未保存的修改：${dirty.join('、')}`, '继续将永久丢弃这些改动。'],
      confirmLabel: '丢弃并关闭',
      danger: true,
    })
    if (!confirmed) return
  }
  // pendingClosePath 指向的是两次点击流的中间态，批量关闭后作废，避免同一文件重开后跳过确认
  documents.pendingClosePath = null
  for (const path of targets) documents.close(path)
  status.set(`已关闭 ${targets.length} 个标签页`)
}

function onContextMenu (path: string, event: MouseEvent): void {
  event.preventDefault()
  const right = closeTargets(documents.openPaths, path, 'right')
  const others = closeTargets(documents.openPaths, path, 'others')
  const entries: MenuEntry[] = [
    { label: '关闭', onSelect: () => ide.closeFile(path) },
    { label: '关闭右侧标签页', disabled: right.length === 0, onSelect: () => void closeMany(right, '右侧') },
    { label: '关闭其他标签页', disabled: others.length === 0, onSelect: () => void closeMany(others, '其他') },
  ]
  showContextMenu(event.clientX, event.clientY, entries)
}
</script>

<template>
  <div ref="root" class="tabs">
    <NScrollbar x-scrollable class="tabs-scrollbar">
      <div class="tabs-track">
        <div
          v-for="tab in tabs"
          :key="tab.path"
          class="tab" :class="[{ active: tab.active }]"
          :data-path="tab.path"
          :title="tab.path"
          @click="select(tab.path)"
          @contextmenu="onContextMenu(tab.path, $event)"
        >
          <component :is="tab.icon.component" class="tree-icon" :class="[tab.icon.cls]" />
          <span class="tab-label">{{ tab.name }}</span>
          <span
            class="tab-close" :class="[{ 'tab-dirty': tab.dirty }]"
            @click.stop="close(tab.path)"
          >{{ tab.dirty ? '●' : '×' }}</span>
        </div>
      </div>
    </NScrollbar>
  </div>
</template>
