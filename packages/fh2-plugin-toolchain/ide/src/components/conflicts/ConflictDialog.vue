<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { NButton, NModal } from 'naive-ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import * as monaco from 'monaco-editor'
import { useDocumentsStore } from '../../stores/documents'
import { useIdeContext } from '../../composables/use-ide'
import { describeApiError, ideApi } from '../../api/client'
import { localCopyPath } from '../../editor/copy-path'

/**
 * F4：文件冲突 UI（外部修改 + 本地 dirty）。
 *
 * 提供四选一：Diff 对照、采用磁盘、保留本地（下一次保存为确认的覆盖写）、另存副本。
 * 默认不允许强制覆盖；保留本地不立即强写。
 */
const documents = useDocumentsStore()
const ide = useIdeContext()
const pending = ref(false)
const error = ref('')

const visible = computed(() => documents.conflictedPaths.length > 0)
const activePath = ref<string | null>(null)
const container = ref<HTMLDivElement | null>(null)
let diffEditor: monaco.editor.IDiffEditor | null = null
let diffContainer: HTMLElement | null = null
let models: monaco.editor.ITextModel[] = []

watch(() => documents.conflictedPaths, (paths) => {
  if (!paths.includes(activePath.value ?? '')) {
    activePath.value = documents.conflictedPaths[0] ?? null
  }
}, { immediate: true })

watch(() => [activePath.value, container.value, documents.revision] as const, () => {
  if (!visible.value || activePath.value === null || container.value === null) {
    disposeDiff()
    return
  }
  const path = activePath.value
  const conflict = documents.conflictOf(path)
  if (conflict === null) return
  renderDiff(path, conflict.diskContent)
}, { flush: 'post' })

function disposeDiff (): void {
  diffEditor?.dispose()
  diffEditor = null
  diffContainer = null
  for (const model of models) model.dispose()
  models = []
}
onBeforeUnmount(disposeDiff)

function renderDiff (path: string, diskContent: string): void {
  if (container.value === null) return
  if (diffContainer !== container.value) disposeDiff()
  if (diffEditor === null) {
    diffEditor = monaco.editor.createDiffEditor(container.value, {
      readOnly: true,
      renderOverviewRuler: false,
      automaticLayout: true,
      theme: 'vs-dark',
    })
    diffContainer = container.value
  }
  const local = documents.contentOf(path) ?? ''
  if (models.length === 0) {
    models = [monaco.editor.createModel(diskContent, 'plaintext'), monaco.editor.createModel(local, 'plaintext')]
    diffEditor.setModel({ original: models[0]!, modified: models[1]! })
  } else {
    if (models[0]!.getValue() !== diskContent) models[0]!.setValue(diskContent)
    if (models[1]!.getValue() !== local) models[1]!.setValue(local)
  }
}

function takeDisk (path: string): void {
  documents.takeDisk(path)
  if (activePath.value === path) activePath.value = documents.conflictedPaths[0] ?? null
}

function keepLocal (path: string): void {
  documents.keepLocal(path)
  if (activePath.value === path) activePath.value = documents.conflictedPaths[0] ?? null
}

async function saveCopy (path: string): Promise<void> {
  if (pending.value) return
  const local = documents.contentOf(path)
  if (local === null) return
  const copyPath = localCopyPath(path)
  const epoch = documents.workspaceEpoch()
  const identity = documents.modelIdentity(path)
  pending.value = true
  error.value = ''
  try {
    await ideApi.fsCreate(copyPath, 'file', local)
    if (epoch !== documents.workspaceEpoch() || documents.modelIdentity(path) !== identity) return
    // F4 设计意图（documents.ts「另存副本/放弃冲突 UI 后清理冲突标记（不动内容）」）：
    // 本地内容已完整落到副本，主文件的编辑器**保持本地内容**让用户继续编辑，
    // 只清冲突标记。此前误调 takeDisk 会把编辑器重灌成磁盘版，用户刚存走的
    // 本地内容从主 tab 里消失——正是 DAG-017-08 抓到的行为。
    if (documents.contentOf(path) === local) documents.clearConflict(path)
    await ide.refreshTree()
    await ide.openFile(copyPath)
  } catch (cause) {
    error.value = `另存 ${copyPath} 失败：${describeApiError(cause)}`
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <NModal
    :show="visible"
    preset="card"
    title="文件冲突"
    size="small"
    :mask-closable="false"
    :close-on-esc="false"
    :closable="false"
    transform-origin="center"
    style="width: min(720px, 92vw)"
  >
    <div class="conflict-body">
      <p class="conflict-hint">
        下列文件在磁盘上被外部修改，而本地有未保存的修改。默认不会覆盖任何一方，请逐个选择处理方式。
      </p>
      <ul class="conflict-list">
        <li
          v-for="path in documents.conflictedPaths"
          :key="path"
          class="conflict-item" :class="[{ active: path === activePath }]"
          @click="activePath = path"
        >
          <span class="conflict-path">{{ path }}</span>
          <span class="conflict-actions">
            <NButton size="tiny" :disabled="pending" @click.stop="takeDisk(path)">采用磁盘</NButton>
            <NButton size="tiny" :disabled="pending" @click.stop="keepLocal(path)">保留本地</NButton>
            <NButton size="tiny" :disabled="pending" @click.stop="saveCopy(path)">另存副本</NButton>
          </span>
        </li>
      </ul>
      <div v-show="activePath !== null" ref="container" class="conflict-diff" />
      <p v-if="error !== ''" class="dialog-error">
        {{ error }}
      </p>
      <p class="conflict-note">
        「保留本地」不立即写盘；下一次保存将按你的确认覆盖磁盘版本。
      </p>
    </div>
  </NModal>
</template>

<style scoped>
.conflict-hint,
.conflict-note {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 4px 0;
}

.conflict-list {
  list-style: none;
  padding: 0;
  margin: 8px 0;
  max-height: 140px;
  overflow: auto;
}

.conflict-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.conflict-item.active {
  background: #2d2d2d;
}

.conflict-path {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.conflict-actions {
  flex-shrink: 0;
  display: flex;
  gap: 6px;
}

.conflict-diff {
  height: 260px;
  border: 1px solid var(--border);
  border-radius: 4px;
  margin-top: 8px;
}
</style>
