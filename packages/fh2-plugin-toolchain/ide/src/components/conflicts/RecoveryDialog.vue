<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { NButton, NModal } from 'naive-ui'
import { ref } from 'vue'
import { describeApiError, ideApi } from '../../api/client'
import { useIdeContext } from '../../composables/use-ide'
import { localCopyPath } from '../../editor/copy-path'
import { useDocumentsStore } from '../../stores/documents'
import { useRecoveryStore } from '../../stores/recovery'
import type { RecoveryFile } from '../../stores/recovery'
import { useWorkspaceStore } from '../../stores/workspace'

const recovery = useRecoveryStore()
const documents = useDocumentsStore()
const workspace = useWorkspaceStore()
const ide = useIdeContext()
const pending = ref(false)
const error = ref('')
const expanded = ref<RecoveryFile | null>(null)

async function copy (file: RecoveryFile): Promise<void> {
  try {
    await navigator.clipboard.writeText(file.content)
  } catch {
    error.value = '无法复制，请展开内容后手动复制或下载。'
  }
}
function download (file: RecoveryFile): void {
  const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.path.split('/').at(-1) ?? '恢复文件'
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
async function restore (file: RecoveryFile, asCopy: boolean): Promise<void> {
  if (pending.value || workspace.info?.sessionId !== file.session) return
  const path = asCopy ? localCopyPath(file.path) : file.path
  const identity = documents.modelIdentity(file.path)
  pending.value = true
  error.value = ''
  try {
    await ideApi.fsCreate(path, 'file', file.content)
    if (workspace.info?.sessionId !== file.session) return
    const disk = await ideApi.readFile(path)
    if (workspace.info?.sessionId !== file.session) return
    if (!asCopy && documents.modelIdentity(path) === identity) documents.markSaved(path, file.content, disk.revision)
    const current = documents.contentOf(file.path)
    if (asCopy && current === file.content && documents.modelIdentity(file.path) === identity) {
      documents.markSavedContentOnly(file.path, file.content)
      documents.close(file.path)
    } else if (asCopy && current !== null && documents.isDirty(file.path)) {
      recovery.retain({ ...file, content: current })
    }
    recovery.dismiss(file)
    await ide.refreshTree()
    await ide.openFile(path)
  } catch (cause) {
    error.value = `恢复 ${path} 失败：${describeApiError(cause)}`
  } finally {
    pending.value = false
  }
}
function discard (file: RecoveryFile): void {
  if (file.deleted && workspace.info?.sessionId === file.session) {
    const content = documents.contentOf(file.path)
    if (content === file.content) {
      documents.markSavedContentOnly(file.path, content)
      documents.close(file.path)
    } else if (content !== null && documents.isDirty(file.path)) {
      recovery.retain({ ...file, content })
    }
  }
  recovery.dismiss(file)
}
</script>

<template>
  <NModal :show="recovery.files.length > 0" preset="card" title="未保存文件恢复" :mask-closable="false" :close-on-esc="false" :closable="false" style="width: min(760px, 92vw)">
    <p class="recovery-hint">
      工作区已切换或文件已删除。内容保留在当前页面，可查看、复制或下载；关闭浏览器前请保存副本。
    </p>
    <section v-for="(file, index) in recovery.files" :key="`${file.session}/${file.path}/${index}`" class="recovery-file">
      <p class="recovery-path">
        {{ file.root }} / {{ file.path }}
      </p>
      <div class="recovery-actions">
        <NButton size="small" @click="expanded = expanded === file ? null : file">
          查看内容
        </NButton>
        <NButton size="small" @click="copy(file)">
          复制
        </NButton>
        <NButton size="small" @click="download(file)">
          下载
        </NButton>
        <template v-if="file.deleted && workspace.info?.sessionId === file.session">
          <NButton size="small" :disabled="pending" @click="restore(file, false)">
            重新创建
          </NButton>
          <NButton size="small" :disabled="pending" @click="restore(file, true)">
            另存副本
          </NButton>
        </template>
        <NButton size="small" type="error" :disabled="pending" @click="discard(file)">
          丢弃恢复内容
        </NButton>
      </div>
      <pre v-if="expanded === file" class="recovery-content">{{ file.content }}</pre>
    </section>
    <p v-if="error" class="dialog-error">
      {{ error }}
    </p>
  </NModal>
</template>

<style scoped>
.recovery-hint { color: var(--fg-muted); margin-bottom: 12px; }
.recovery-file { margin: 8px 0; }
.recovery-path { overflow-wrap: anywhere; margin-bottom: 6px; }
.recovery-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.recovery-content { max-height: 280px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; margin-top: 8px; }
</style>
