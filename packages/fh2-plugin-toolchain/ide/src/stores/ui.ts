// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ProblemSource } from './problems.js'

/** 顶层视图 Tab（契约 §9 的「工作流低代码」是其中之一）。 */
export type IdeView = 'editor' | 'workflow' | 'start'

/** 底部面板 Tab。 */
export type BottomTab = 'problems' | 'run' | 'tasks' | 'lsp'

/** 侧栏内容视图（活动栏切换）。 */
export type SidebarView = 'files' | 'search'

/**
 * 纯 UI 形态状态（视图/面板/busy/致命错误页）。
 * 业务数据一律在各领域 store。
 */
export const useUiStore = defineStore('ui', () => {
  const view = ref<IdeView>('editor')
  const panelTab = ref<BottomTab>('problems')
  const problemSourceFilter = ref<ProblemSource | 'all'>('all')
  const panelCollapsed = ref(false)
  /** 底部面板在横向分割里的占比（%）；拖拽后持久，折叠再展开不丢。 */
  const panelSizePct = ref(22)
  const sidebarView = ref<SidebarView>('files')
  /** 能力层命令互斥：validate / pack 同一时间只能跑一个（构建并入打包）。 */
  const busy = ref<'validate' | 'pack' | null>(null)
  const fatal = ref<{ readonly title: string; readonly lines: readonly string[] } | null>(null)

  function setView (next: IdeView): void {
    view.value = next
  }

  function setSidebarView (next: SidebarView): void {
    sidebarView.value = next
  }

  /** 切底部 tab 顺带展开面板（对齐原行为：切 tab 必展开）。 */
  function switchPanelTab (tab: BottomTab): void {
    panelTab.value = tab
    panelCollapsed.value = false
  }

  function togglePanel (): void {
    panelCollapsed.value = !panelCollapsed.value
  }

  function setProblemSourceFilter (source: ProblemSource | 'all'): void {
    problemSourceFilter.value = source
  }

  function setFatal (title: string, lines: readonly string[]): void {
    fatal.value = { title, lines }
  }

  return { view, panelTab, problemSourceFilter, panelCollapsed, panelSizePct, sidebarView, busy, fatal, setView, setSidebarView, setProblemSourceFilter, switchPanelTab, togglePanel, setFatal }
})
