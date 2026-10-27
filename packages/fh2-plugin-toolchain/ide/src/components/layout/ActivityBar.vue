<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { FolderOpenOutline, SearchOutline, SettingsOutline } from '@vicons/ionicons5'
import { showDialog } from '../../services/dialog'
import { useSettingsStore } from '../../stores/settings'
import { useUiStore } from '../../stores/ui'
import type { SidebarView } from '../../stores/ui'

/**
 * 左侧活动栏（VSCode 式）：头部切换 资源管理器/搜索 视图，底部设置入口。
 * 不实现侧栏折叠：点击当前活动 icon 仅维持高亮。
 */
const ui = useUiStore()
const settings = useSettingsStore()

const FONT_SIZES: readonly number[] = [12, 13, 14, 16, 18]

function switchSidebar (view: SidebarView): void {
  ui.setSidebarView(view)
}

async function openSettings (): Promise<void> {
  const result = await showDialog({
    title: '编辑器设置',
    body: ['设置确认后立即生效，并保存在浏览器本地。'],
    fields: [
      {
        kind: 'select',
        name: 'fontSize',
        label: '字号',
        value: String(settings.fontSize),
        options: FONT_SIZES.map(size => ({ value: String(size), label: `${size} px` })),
      },
      {
        kind: 'checkbox',
        name: 'wordWrap',
        label: '自动换行',
        value: settings.wordWrap,
        hint: '超长行在视口宽度处折行显示。',
      },
      {
        kind: 'checkbox',
        name: 'autoSave',
        label: '自动保存',
        value: settings.autoSave,
        hint: '停止输入约 1 秒后自动保存修改；Ctrl+S 手动保存仍然可用。',
      },
    ],
    confirmLabel: '应用',
  })
  if (result === null) return
  settings.setFontSize(Number(result.fontSize))
  settings.setWordWrap(result.wordWrap === true)
  settings.setAutoSave(result.autoSave === true)
}
</script>

<template>
  <div class="activitybar">
    <div class="activitybar-group">
      <button
        type="button"
        class="activity-item" :class="[{ active: ui.sidebarView === 'files' }]"
        title="资源管理器"
        @click="switchSidebar('files')"
      >
        <FolderOpenOutline />
      </button>
      <button
        type="button"
        class="activity-item" :class="[{ active: ui.sidebarView === 'search' }]"
        title="搜索文件"
        @click="switchSidebar('search')"
      >
        <SearchOutline />
      </button>
    </div>
    <div class="activitybar-group">
      <button
        type="button"
        class="activity-item"
        title="设置"
        @click="void openSettings()"
      >
        <SettingsOutline />
      </button>
    </div>
  </div>
</template>
