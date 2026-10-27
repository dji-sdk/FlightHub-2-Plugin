<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { AlertCircleOutline, ChevronDownOutline, ChevronUpOutline, CodeSlashOutline, ListOutline, TerminalOutline, TrashOutline } from '@vicons/ionicons5'
import { NButton, NIcon, NSelect } from 'naive-ui'
import { computed } from 'vue'
import { useIdeContext } from '../../composables/use-ide'
import { useProblemsStore } from '../../stores/problems'
import type { ProblemItem, ProblemSource } from '../../stores/problems'
import { STATUS_LABEL, useRunStore } from '../../stores/run'
import { useTasksStore } from '../../stores/tasks'
import { useUiStore } from '../../stores/ui'
import ProblemsList from '../panel/ProblemsList.vue'
import RunTerminal from '../panel/RunTerminal.vue'
import TasksPanel from '../panel/TasksPanel.vue'
import LspOutput from '../panel/LspOutput.vue'

/**
 * 底部面板（问题 / 运行日志）：tab 切换、进程摘要、来源过滤器与折叠。
 */
const ide = useIdeContext()
const ui = useUiStore()
const problems = useProblemsStore()
const run = useRunStore()
const tasks = useTasksStore()

const problemFilterOptions: { label: string, value: ProblemSource | 'all' }[] = [
  { label: '全部来源', value: 'all' },
  { label: '工作流检查', value: 'workflow' },
  { label: '代码编辑器', value: 'editor' },
  { label: '工程校验', value: 'validate' },
  { label: '构建', value: 'build' },
  { label: '语言服务', value: 'lsp' },
  { label: '任务', value: 'task' },
]

const runFilterOptions: { label: string, value: '' | 'dev' | 'preview' }[] = [
  { label: '全部来源', value: '' },
  { label: '仅 dev', value: 'dev' },
  { label: '仅 preview', value: 'preview' },
]

function sourceOf (problem: ProblemItem): ProblemSource {
  if (problem.source !== undefined) return problem.source
  if (problem.origin === 'editor') return 'editor'
  if (problem.origin === 'workflow') return 'workflow'
  return 'validate'
}

const problemSummary = computed(() => {
  const items = ui.problemSourceFilter === 'all'
    ? problems.items
    : problems.items.filter(problem => sourceOf(problem) === ui.problemSourceFilter)
  return `${items.filter(problem => problem.severity === 'error').length} 个错误 · ${items.filter(problem => problem.severity === 'warning').length} 个警告`
})

function setRunFilter (value: string | number | null): void {
  run.setFilter(value === '' || value === null ? null : value as 'dev' | 'preview')
}
</script>

<template>
  <div class="panel" :class="[{ 'collapsed': ui.panelCollapsed, 'run-mode': ui.panelTab === 'run' }]">
    <div class="panel-header">
      <div class="panel-tabs">
        <button
          id="panel-tab-problems"
          type="button"
          class="panel-tab" :class="[{ active: ui.panelTab === 'problems' }]"
          title="问题"
          @click="ui.switchPanelTab('problems')"
        >
          <NIcon :component="AlertCircleOutline" />
          <span class="panel-tab-label">问题</span>
        </button>
        <button
          id="panel-tab-lsp"
          type="button"
          class="panel-tab" :class="[{ active: ui.panelTab === 'lsp' }]"
          title="语言服务"
          @click="ui.switchPanelTab('lsp')"
        >
          <NIcon :component="CodeSlashOutline" />
          <span class="panel-tab-label">语言服务</span>
        </button>
        <button
          id="panel-tab-run"
          type="button"
          class="panel-tab" :class="[{ active: ui.panelTab === 'run' }]"
          title="运行日志"
          @click="ui.switchPanelTab('run')"
        >
          <NIcon :component="TerminalOutline" />
          <span class="panel-tab-label">运行日志</span>
        </button>
        <button
          id="panel-tab-tasks"
          type="button"
          class="panel-tab" :class="[{ active: ui.panelTab === 'tasks' }]"
          title="任务"
          @click="ui.switchPanelTab('tasks')"
        >
          <NIcon :component="ListOutline" />
          <span class="panel-tab-label">任务</span>
          <span v-if="tasks.activeTasks.length > 0" class="panel-tab-count">{{ tasks.activeTasks.length }}</span>
        </button>
      </div>

      <span v-if="ui.panelTab === 'problems'" class="problems-count">{{ problemSummary }}</span>

      <div v-if="ui.panelTab === 'run'" class="run-summary">
        <span v-if="run.activeProcesses.length === 0" class="run-summary-idle">无运行中的进程</span>
        <div v-for="process of run.activeProcesses" :key="process.mode" class="run-process">
          <span
            class="run-chip" :class="[`run-chip-${process.status}`]"
            :title="[process.projectPath, process.detail].filter(Boolean).join(' · ')"
          >
            {{ process.mode }} · {{ STATUS_LABEL[process.status] }}
          </span>
          <button
            v-if="process.url !== undefined && process.url !== ''"
            type="button"
            class="run-open-link"
            :title="process.url"
            @click="ide.openRunUrl(process.url)"
          >
            <span>打开</span><span class="run-url"> {{ process.url }}</span>
          </button>
        </div>
      </div>

      <span class="toolbar-spacer" />

      <NSelect
        v-if="ui.panelTab === 'problems'"
        id="problems-filter"
        class="panel-filter"
        size="tiny"
        :value="ui.problemSourceFilter"
        :options="problemFilterOptions"
        :consistent-menu-width="false"
        @update:value="ui.setProblemSourceFilter"
      />
      <NButton
        v-if="ui.panelTab === 'problems'"
        id="btn-problems-clear"
        quaternary
        circle
        size="tiny"
        title="清空问题列表"
        @click="problems.clearAll()"
      >
        <template #icon>
          <NIcon :component="TrashOutline" />
        </template>
      </NButton>

      <NSelect
        v-if="ui.panelTab === 'run'"
        id="run-filter"
        class="panel-filter"
        size="tiny"
        :value="run.filter ?? ''"
        :options="runFilterOptions"
        :consistent-menu-width="false"
        @update:value="setRunFilter"
      />
      <NButton
        v-if="ui.panelTab === 'run'"
        id="btn-run-clear"
        quaternary
        circle
        size="tiny"
        title="清空运行日志"
        @click="run.clear()"
      >
        <template #icon>
          <NIcon :component="TrashOutline" />
        </template>
      </NButton>
      <NButton
        id="btn-panel-toggle"
        quaternary
        circle
        size="tiny"
        :title="ui.panelCollapsed ? '展开面板' : '收起面板'"
        @click="ui.togglePanel()"
      >
        <template #icon>
          <NIcon :component="ui.panelCollapsed ? ChevronUpOutline : ChevronDownOutline" />
        </template>
      </NButton>
    </div>
    <ProblemsList />
    <RunTerminal />
    <TasksPanel />
    <LspOutput />
  </div>
</template>
