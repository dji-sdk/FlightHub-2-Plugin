<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import {
  AddOutline,
  CheckmarkCircleOutline,
  CloseCircleOutline,
  ExpandOutline,
  InformationCircleOutline,
  OpenOutline,
  RefreshOutline,
  RemoveOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import { NBadge, NButton, NDropdown, NIcon, NPopover, NSelect } from 'naive-ui'
import type { DropdownOption } from 'naive-ui'
import { computed, ref } from 'vue'
import { useIdeContext } from '../../../composables/use-ide'
import { useUiStore } from '../../../stores/ui.js'
import { useWorkflowStore } from '../store.js'
import NodePalette from './NodePalette.vue'
import WorkflowCanvasHost from './WorkflowCanvasHost.vue'
import WorkflowInspector from './WorkflowInspector.vue'

/**
 * 工作流低代码视图（契约 §9）：文件 ↔ 图模型 ↔ 画布 的编排。
 * 状态与动作在 workflow store；画布（SVG 交互）与脚本源码（Monaco）
 * 是命令式控件，由宿主组件包裹。
 *
 * 顶部动作按「主操作直接可见、次要操作收进更多」组织：
 * 检查不落盘 / 保存当前工作流（含脚本与清单）/ 保存工作区全部改动。
 */
const ui = useUiStore()
const workflow = useWorkflowStore()
const ide = useIdeContext()

const saveRelatedDisabled = computed(() => !workflow.loaded || !workflow.relatedDirty)
const saveAllDisabled = computed(() => workflow.dirtyDocumentCount === 0)
const saving = ref(false)

const fileOptions = computed(() => workflow.candidates.map(candidate => ({
  label: candidate,
  value: candidate,
})))

const moreOptions = computed<DropdownOption[]>(() => [
  {
    key: 'save-all',
    label: workflow.dirtyDocumentCount > 0
      ? `保存全部改动（${workflow.dirtyDocumentCount}）`
      : '保存全部改动',
    disabled: saveAllDisabled.value || saving.value,
    props: { id: 'wf-save-all' },
  },
  {
    key: 'reload',
    label: '刷新画布',
    disabled: workflow.path === null,
    props: { id: 'wf-reload' },
  },
  {
    key: 'reload-disk',
    label: '从磁盘重新载入',
    disabled: workflow.path === null,
    props: { id: 'wf-reload-disk' },
  },
])

const structuralIssueCount = computed(() => workflow.model?.issues.length ?? 0)
const errorCount = computed(() => structuralIssueCount.value + workflow.errorIssueCount)
const warningCount = computed(() => workflow.warningIssueCount)
const losslessMessage = computed(() => workflow.noticeMessages.find(message => message.kind === 'lossless'))
const hasIssues = computed(() => errorCount.value > 0 || warningCount.value > 0)

const noticeLevel = computed<'error' | 'warning' | 'info'>(() => {
  if (workflow.noticeOverride !== null || errorCount.value > 0) return 'error'
  if (warningCount.value > 0 || losslessMessage.value !== undefined) return 'warning'
  return 'info'
})

const noticeIcon = computed(() => {
  if (noticeLevel.value === 'error') return CloseCircleOutline
  if (noticeLevel.value === 'warning') return WarningOutline
  return CheckmarkCircleOutline
})

const noticeText = computed(() => {
  if (workflow.noticeOverride !== null) return workflow.noticeOverride
  if (hasIssues.value) {
    const parts = [`${errorCount.value} 个错误`]
    if (warningCount.value > 0) parts.push(`${warningCount.value} 个警告`)
    return `当前仅执行本地快速检查：${parts.join(' · ')}`
  }
  if (losslessMessage.value !== undefined) {
    return `当前仅执行本地快速检查：${losslessMessage.value.text}`
  }
  return '当前仅执行本地快速检查：未发现问题'
})

/** 文件下拉选择即载入。 */
function onFileChange (value: string | null): void {
  if (value !== null && value !== '') void workflow.load(value)
}

/** 「添加步骤」与「更多」共用 Naive Dropdown，避免两套菜单视觉。 */
const addStepEntries = computed(() => workflow.addStepEntries().filter(entry => entry !== 'separator'))
const addStepOptions = computed<DropdownOption[]>(() => addStepEntries.value.map((entry, index) => ({
  key: String(index),
  label: entry.label,
  disabled: entry.disabled === true,
})))

function onAddStepSelect (key: string): void {
  addStepEntries.value[Number(key)]?.onSelect()
}

async function saveAll (): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    await workflow.save()
  } finally {
    saving.value = false
  }
}

async function saveRelated (): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    await workflow.saveRelated()
  } finally {
    saving.value = false
  }
}

function onMoreSelect (key: string): void {
  if (key === 'save-all') {
    void saveAll()
    return
  }
  if (key === 'reload') {
    workflow.refreshCanvas()
    return
  }
  if (key === 'reload-disk') void workflow.reloadFromDisk()
}

/** 重排提示的行内动作：切回编辑器打开同一份文件（model 共享，改动不丢）。 */
async function openInEditor (): Promise<void> {
  const path = workflow.path
  if (path === null) return
  await ide.switchView('editor')
  await ide.openFile(path)
}

/** 跳到统一 Problem 面板，并把来源限定为「工作流检查」。 */
function openProblems (): void {
  ui.setProblemSourceFilter('workflow')
  ui.switchPanelTab('problems')
}
</script>

<template>
  <div class="view view-workflow" :class="[{ active: ui.view === 'workflow' }]">
    <div class="wf-toolbar">
      <span class="wf-toolbar-label">工作流文件</span>
      <NSelect
        id="wf-file-select"
        class="wf-file-select"
        size="small"
        :options="fileOptions"
        :value="workflow.selectedCandidate"
        :data-selected="workflow.selectedCandidate"
        :disabled="workflow.candidates.length === 0"
        :placeholder="workflow.candidates.length === 0 ? '工作区内没有工作流文件' : '选择工作流文件'"
        :consistent-menu-width="false"
        filterable
        @update:value="onFileChange"
      />

      <NButton id="wf-create-workflow" quaternary size="small" title="新建工作流" @click="void workflow.promptCreateWorkflow()">
        新建
      </NButton>

      <span class="wf-toolbar-divider" />

      <NDropdown trigger="click" :options="addStepOptions" @select="onAddStepSelect">
        <NButton id="wf-add-step" quaternary size="small" :disabled="!workflow.loaded">
          添加步骤
        </NButton>
      </NDropdown>
      <NButton id="wf-check" quaternary size="small" :disabled="!workflow.loaded" title="只检查内存里的结构与引用，不保存任何文件" @click="workflow.checkConfig()">
        检查
      </NButton>

      <span class="wf-toolbar-divider" />

      <NButton
        id="wf-save"
        quaternary
        size="small"
        class="wf-toolbar-save"
        :disabled="saveRelatedDisabled"
        :loading="saving"
        :data-dirty="workflow.relatedDirty"
        title="保存当前工作流，以及它引用的脚本和清单"
        @click="void saveRelated()"
      >
        保存
        <NBadge v-if="workflow.relatedDirty" dot class="wf-save-dot" />
      </NButton>

      <NDropdown trigger="click" :options="moreOptions" @select="onMoreSelect">
        <NButton id="wf-more" quaternary size="small" title="更多操作">
          更多
        </NButton>
      </NDropdown>

      <span class="toolbar-spacer" />

      <div class="wf-zoom-group">
        <NButton id="wf-zoom-out" quaternary size="small" title="缩小" :disabled="!workflow.loaded" @click="workflow.zoomCanvas(1 / 1.2)">
          <template #icon>
            <NIcon :component="RemoveOutline" />
          </template>
        </NButton>
        <NButton id="wf-fit" quaternary size="small" title="适应窗口" :disabled="!workflow.loaded" @click="workflow.fitCanvas()">
          <template #icon>
            <NIcon :component="ExpandOutline" />
          </template>
        </NButton>
        <NButton id="wf-zoom-in" quaternary size="small" title="放大" :disabled="!workflow.loaded" @click="workflow.zoomCanvas(1.2)">
          <template #icon>
            <NIcon :component="AddOutline" />
          </template>
        </NButton>
      </div>
    </div>

    <div class="wf-notice" :class="[noticeLevel]" role="status" aria-live="polite">
      <NIcon class="wf-notice-icon" :component="noticeIcon" aria-hidden="true" />
      <span class="wf-notice-text" :title="noticeText">{{ noticeText }}</span>

      <NButton
        v-if="hasIssues"
        id="wf-notice-open-problems"
        text
        size="tiny"
        class="wf-notice-action"
        @click="openProblems"
      >
        查看问题
      </NButton>
      <NButton
        v-if="losslessMessage !== undefined"
        id="wf-notice-open-editor"
        text
        size="tiny"
        class="wf-notice-action"
        @click="void openInEditor()"
      >
        <template #icon>
          <NIcon :component="OpenOutline" />
        </template>
        在编辑器中打开
      </NButton>
      <NButton
        v-if="workflow.noticeOverride !== null"
        id="wf-notice-reload"
        text
        size="tiny"
        class="wf-notice-action"
        @click="void workflow.reloadFromDisk()"
      >
        <template #icon>
          <NIcon :component="RefreshOutline" />
        </template>
        重新载入
      </NButton>

      <NPopover v-if="workflow.noticeEvidence.length > 0" trigger="click" placement="bottom-end" :show-arrow="false">
        <template #trigger>
          <NButton id="wf-notice-evidence" text size="tiny" class="wf-notice-action">
            <template #icon>
              <NIcon :component="InformationCircleOutline" />
            </template>
            检查依据
          </NButton>
        </template>
        <div class="wf-evidence">
          <div class="wf-evidence-title">
            检查依据
          </div>
          <div v-for="(line, index) of workflow.noticeEvidence" :key="index" class="wf-evidence-row">
            <NIcon :component="InformationCircleOutline" class="wf-evidence-icon" aria-hidden="true" />
            <span>{{ line }}</span>
          </div>
        </div>
      </NPopover>
    </div>

    <div class="wf-body">
      <NodePalette />
      <WorkflowCanvasHost />
      <WorkflowInspector />
    </div>
  </div>
</template>
