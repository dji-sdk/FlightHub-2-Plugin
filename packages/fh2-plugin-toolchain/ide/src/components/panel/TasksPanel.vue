<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed } from 'vue'
import { useIdeContext } from '../../composables/use-ide'
import type { TaskSnapshot } from '../../api/types'
import { TASK_STATE_LABEL, useTasksStore } from '../../stores/tasks'
import { useUiStore } from '../../stores/ui'

/**
 * U1/U2/U3：任务面板 —— Build/Pack 任务列表（状态、日志、产物下载、取消）。
 * 事件经 tasks store 的 sequence 去重；产物为不可变快照（旧任务不受后续构建影响）。
 */
const ide = useIdeContext()
const tasks = useTasksStore()
const ui = useUiStore()

const stateClass = (state: string): string => `task-state-${state}`

const artifactKindLabel: Record<string, string> = {
  'frontend-dist': '前端产物',
  'backend-dist': '后端产物',
  'generated-types': '生成类型',
  'capability-package': '上传包',
}

const sortedTasks = computed(() => tasks.tasks.slice(0, 20))

/** 任务时间：未开始显示创建时间，进行中/终态显示 startedAt（缺失回落 createdAt）。 */
function taskTime (task: TaskSnapshot): string {
  const stamp = task.startedAt ?? task.createdAt
  return new Date(stamp).toLocaleTimeString('zh-CN', { hour12: false })
}
</script>

<template>
  <div class="tasks-list panel-pane" :class="[{ active: ui.panelTab === 'tasks' }]">
    <div v-if="tasks.tasks.length === 0" class="panel-empty">
      暂无任务 —— 构建与打包会在这里显示进度、日志与产物
    </div>
    <section v-for="task of sortedTasks" :key="task.taskId" class="task-card">
      <header class="task-header">
        <span class="task-state" :class="[stateClass(task.state)]">{{ TASK_STATE_LABEL[task.state] }}</span>
        <span class="task-kind">{{ task.kind === 'build' ? '构建' : '打包' }}</span>
        <span class="task-time" :title="new Date(task.startedAt ?? task.createdAt).toLocaleString()">{{ taskTime(task) }}</span>
        <span class="task-id" :title="task.taskId">{{ task.taskId.slice(0, 18) }}</span>
        <span v-if="task.stale === true" class="task-stale" title="构建期间源码被修改">stale</span>
        <span v-if="task.state === 'queued' || task.state === 'running'">
          <button type="button" class="ghost small" @click="void ide.cancelTask(task.taskId)">取消</button>
        </span>
      </header>
      <div v-if="task.sourceRevision !== undefined" class="task-revision">
        源码 {{ task.sourceRevision.slice(0, 12) }}<template v-if="task.artifacts.length > 0 && task.artifacts.every(a => a.typechecked)">
          · typechecked
        </template>
      </div>
      <div v-if="task.artifacts.length > 0" class="task-artifacts">
        <span v-for="artifact of task.artifacts" :key="artifact.id" class="task-artifact">
          <button
            type="button"
            class="ghost small"
            :title="`${artifact.digest.slice(0, 16)}… · ${(artifact.size / 1024).toFixed(1)} KiB · 点击下载（上传司空为手动步骤）`"
            @click="void ide.downloadArtifact(task.taskId, artifact.id)"
          >⬇ {{ artifactKindLabel[artifact.kind] ?? artifact.kind }}</button>
        </span>
      </div>
      <pre v-if="tasks.logsOf(task.taskId).length > 0" class="task-logs">{{ tasks.logsOf(task.taskId).slice(-8).join('\n') }}</pre>
    </section>
  </div>
</template>
