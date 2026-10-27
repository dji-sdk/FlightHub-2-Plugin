<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { CloseCircleOutline, InformationCircleOutline, WarningOutline } from '@vicons/ionicons5'
import { NIcon, NTag } from 'naive-ui'
import { computed } from 'vue'
import { useIdeContext } from '../../composables/use-ide'
import { useProblemsStore } from '../../stores/problems'
import type { ProblemItem, ProblemSource } from '../../stores/problems'
import { useUiStore } from '../../stores/ui'

/**
 * 问题列表：双源数据（Monaco markers + 能力层诊断）的合并在 problems store。
 *
 * 点击行为按结构化目标分派（P2-2）：工作流问题直接定位到画布节点与具体输入，
 * 文件问题跳编辑器行列；文件行也保留双击跳转。来源标签用任务语言
 * （代码编辑器 / 工作流检查 / 工程校验 / 构建）。
 */
const ide = useIdeContext()
const problems = useProblemsStore()
const ui = useUiStore()

const SEVERITY_META = {
  error: { icon: CloseCircleOutline, label: '错误' },
  warning: { icon: WarningOutline, label: '警告' },
  info: { icon: InformationCircleOutline, label: '提示' },
} as const

function sourceOf (problem: ProblemItem): ProblemSource {
  if (problem.source !== undefined) return problem.source
  if (problem.origin === 'editor') return 'editor'
  if (problem.origin === 'workflow') return 'workflow'
  return 'validate'
}

const items = computed(() => {
  if (ui.problemSourceFilter === 'all') return problems.items
  return problems.items.filter(problem => sourceOf(problem) === ui.problemSourceFilter)
})

/** 来源标签：任务语言，而不是内部代号（P2-2 来源标签）。 */
function sourceLabel (problem: ProblemItem): string {
  switch (sourceOf(problem)) {
    case 'workflow': return '工作流检查'
    case 'validate': return '工程校验'
    case 'build': return '构建'
    case 'lsp': return '语言服务'
    case 'task': return '任务'
    default: return '代码编辑器'
  }
}

function onProblemClick (problem: ProblemItem): void {
  if (problem.target?.kind === 'workflow-node') {
    void ide.revealWorkflowNode(problem.target.workflowPath, problem.target.nodeId, problem.target.inputKey)
    return
  }
  void ide.jumpTo(problem.path, problem.line, problem.column)
}
</script>

<template>
  <div class="problems-list panel-pane" :class="[{ active: ui.panelTab === 'problems' }]">
    <div v-if="items.length === 0" class="panel-empty">
      {{ ui.problemSourceFilter === 'all' ? '未发现问题' : '当前来源没有问题' }}
    </div>
    <div
      v-for="(problem, index) in items"
      :key="`${problem.origin}-${problem.path}-${problem.line}-${index}`"
      class="problem" :class="[`problem-${problem.severity}`]"
      :data-path="problem.path"
      :data-line="problem.line"
      :data-node-id="problem.target?.kind === 'workflow-node' ? problem.target.nodeId : undefined"
      @click="onProblemClick(problem)"
    >
      <span
        class="problem-sev"
        :data-severity="problem.severity"
        :title="SEVERITY_META[problem.severity].label"
        :aria-label="SEVERITY_META[problem.severity].label"
      >
        <NIcon :component="SEVERITY_META[problem.severity].icon" />
      </span>
      <NTag class="problem-origin" :class="[`origin-${problem.origin}`]" size="small" :bordered="false">
        {{ sourceLabel(problem) }}
      </NTag>
      <span
        class="problem-loc"
        :title="`${problem.path}:${problem.line}:${problem.column}（双击打开）`"
        @dblclick="void ide.jumpTo(problem.path, problem.line, problem.column)"
      >{{ problem.path }}:{{ problem.line }}:{{ problem.column }}</span>
      <span class="problem-body">
        <span class="problem-msg">{{ problem.message }}</span>
        <span v-if="problem.hint !== undefined" class="problem-hint">提示：{{ problem.hint }}</span>
      </span>
      <span class="problem-code" :title="problem.code">{{ problem.code }}</span>
    </div>
  </div>
</template>
