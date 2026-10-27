// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type * as monaco from 'monaco-editor'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { DocumentStore } from '../editor/document-store.js'
import type { DocumentBatchEvent, DocumentConflict } from '../editor/document-store.js'
import type { PreparedCommand } from '../../../src/workflow/core/commands.js'

/**
 * 打开文档的 Pinia 门面：DocumentStore 本体是持有 Monaco model 的普通类
 * （model 引用不能被 reactive 代理），放在 setup 闭包里，外部只看到镜像与方法。
 * 任何文档变化都 bump revision，让 computed 重新求值。
 */
export const useDocumentsStore = defineStore('documents', () => {
  const documents = new DocumentStore()
  const revision = ref(0)
  documents.onDidChange(() => {
    revision.value += 1
  })

  const active = computed(() => {
    void revision.value
    return documents.active
  })

  const openPaths = computed(() => {
    void revision.value
    return [...documents.tabPaths]
  })

  const hasDirty = computed(() => {
    void revision.value
    return documents.hasDirty
  })

  /** F3：Save All / 操作门禁用。 */
  const dirtyPaths = computed(() => {
    void revision.value
    return documents.openPaths.filter(path => documents.isDirty(path))
  })

  /** 保存计划范围（DAG-016-01）：tab 内 ∪ 无 tab 但 dirty 的 model（Inspector 脚本）。 */
  const saveablePaths = computed(() => {
    void revision.value
    return documents.saveablePaths
  })

  /** F4：冲突文档路径（外部修改 + 本地 dirty）。 */
  const conflictedPaths = computed(() => {
    void revision.value
    return [...documents.conflictedPaths()]
  })

  /** 关脏文件需连点两次确认；记录第一次点的是哪个文件。 */
  const pendingClosePath = ref<string | null>(null)

  function has (path: string): boolean {
    return documents.has(path)
  }

  function isDirty (path: string): boolean {
    void revision.value
    return documents.isDirty(path)
  }

  /** 用户是否留有编辑史（undo 栈里还有基线之后的编辑）：watcher 静默重灌的护栏。 */
  function hasUndoHistory (path: string): boolean {
    void revision.value
    return documents.hasUndoHistory(path)
  }

  function contentOf (path: string): string | null {
    void revision.value
    return documents.contentOf(path)
  }

  function attach (editor: monaco.editor.IStandaloneCodeEditor): void {
    documents.attach(editor)
  }

  function detach (editor: monaco.editor.IStandaloneCodeEditor): void {
    documents.detach(editor)
  }

  /** W1：引用计数获取 model（Workflow 脚本编辑器与主编辑器共享同一 model）。 */
  function acquireModel (path: string, content: string): { model: monaco.editor.ITextModel; release: () => void } {
    return documents.acquireModel(path, content)
  }

  /** F1：工作根变化时重建绝对 URI 基准并关闭旧文档。 */
  function setWorkspaceRoot (root: string | null): void {
    documents.setWorkspaceRoot(root)
  }

  function open (path: string, content: string, revision?: string): void {
    documents.open(path, content, revision)
  }

  /** P2-3：打开但不激活 tab（画布读依赖文件，不抢主编辑器当前文件）。 */
  function openDetached (path: string, content: string, revision?: string): void {
    documents.openDetached(path, content, revision)
  }

  /**
   * 以「未落盘」身份打开（IDE-011-05 草稿保护）：基线为空、内容一次编辑推到位，
   * 因此 dirty=true 且走 create 计划。切根重置后把留存的草稿重新开回 tab 用它。
   */
  function openUnsaved (path: string, content: string): void {
    documents.openUnsaved(path, content)
  }

  function activate (path: string): void {
    documents.activate(path)
  }

  function expectedRevision (path: string): string | undefined {
    return documents.expectedRevision(path)
  }

  function markSaved (path: string, content: string, revision: string): void {
    documents.markSaved(path, content, revision)
  }

  function markSavedContentOnly (path: string, content: string): void {
    documents.markSavedContentOnly(path, content)
  }

  function conflictOf (path: string): DocumentConflict | null {
    void revision.value
    return documents.conflictOf(path)
  }

  function enterConflict (path: string, conflict: DocumentConflict): void {
    documents.enterConflict(path, conflict)
  }

  /** F4：采用磁盘。 */
  function takeDisk (path: string): void {
    documents.takeDisk(path)
  }

  /** F4：保留本地——下一次保存为用户确认的覆盖写。 */
  function keepLocal (path: string): void {
    documents.keepLocal(path)
  }

  /** 外删后保持 tab 与内容，仅标记磁盘不存在（下次保存走 create 重建）。 */
  function markAbsentFromDisk (path: string): void {
    documents.markAbsentFromDisk(path)
  }

  /** F4：另存副本/忽略后清理冲突标记。 */
  function clearConflict (path: string): void {
    documents.clearConflict(path)
  }

  function reloadFromDisk (path: string, content: string, revision?: string): void {
    documents.reloadFromDisk(path, content, revision)
  }

  function reveal (path: string, line: number, column: number): void {
    documents.reveal(path, line, column)
  }

  /**
   * 关闭脏文件的两次确认流。返回值告诉调用方发生了什么，
   * 由调用方决定要不要写状态栏提示。
   */
  function requestClose (path: string): 'closed' | 'needs-confirm' {
    if (documents.isDirty(path) && pendingClosePath.value !== path) {
      pendingClosePath.value = path
      return 'needs-confirm'
    }
    pendingClosePath.value = null
    documents.close(path)
    return 'closed'
  }

  /**
   * 重命名后修正已打开的文档。
   * 有未保存改动的文档不能直接关掉 —— 那等于静默丢弃用户的编辑；
   * 做法是在新路径下重开一个带着旧内容的文档并保持 dirty，用户再保存即可落到新位置。
   * 返回跟随到新路径的脏文件映射，供调用方逐条提示。
   */
  function remapOpenDocuments (from: string, to: string): readonly { readonly from: string; readonly to: string }[] {
    return documents.remap(from, to)
  }

  function close (path: string): void {
    documents.close(path)
  }

  function reset (): void {
    for (const path of [...documents.openPaths]) documents.close(path, true)
    pendingClosePath.value = null
  }

  return {
    modelIdentity: (path: string) => documents.modelIdentity(path),
    allPaths: () => [...documents.openPaths],
    modelVersion: (path: string) => documents.modelVersion(path),
    applyEdit: (path: string, content: string, version: number) => documents.applyEdit(path, content, version),

    // ── C1 新增面：结构化命令通道（见 document-store.ts 的 applyPrepared）──
    //
    // ⚠️ 全都转发到**同一个** DocumentStore 实例：另开一个实例会得到两套 model
    // 与两套代号，于是命令前置核验核的是另一份文档的版本 —— 形同没有核验。
    snapshot: (paths: readonly string[]) => documents.snapshot(paths),
    applyPrepared: (command: PreparedCommand) => documents.applyPrepared(command),
    generationOf: (path: string) => documents.generationOf(path),
    workspaceEpoch: () => documents.workspaceEpoch,
    commandHistory: () => documents.history,
    subscribe: (listener: (event?: DocumentBatchEvent) => void) => documents.onDidChange(listener),
    revision,
    active,
    openPaths,
    hasDirty,
    dirtyPaths,
    conflictedPaths,
    pendingClosePath,
    has,
    isDirty,
    hasUndoHistory,
    saveablePaths,
    contentOf,
    attach,
    detach,
    acquireModel,
    setWorkspaceRoot,
    open,
    openDetached,
    openUnsaved,
    activate,
    expectedRevision,
    markSaved,
    markSavedContentOnly,
    conflictOf,
    enterConflict,
    takeDisk,
    keepLocal,
    markAbsentFromDisk,
    clearConflict,
    reloadFromDisk,
    reveal,
    requestClose,
    remapOpenDocuments,
    close,
    reset,
  }
})
