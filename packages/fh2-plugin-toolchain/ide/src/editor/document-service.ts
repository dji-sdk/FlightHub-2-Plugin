// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { IdeApiError, ideApi } from '../api/client.js'
import type { useDocumentsStore } from '../stores/documents.js'

/** 文档消费者共用的读写入口。内容、撤销栈和冲突状态只由 DocumentStore 持有。 */
export function createDocumentService (
  documents: ReturnType<typeof useDocumentsStore>,
  sessionId: () => string | null,
) {
  const saves = new Map<string, Promise<boolean>>()
  const reads = new Map<string, { session: string | null; promise: Promise<string> }>()

  async function open (path: string): Promise<void> {
    await readDetached(path)
    documents.activate(path)
  }

  /**
   * 读一份文件进文档层，但**不激活 tab**（P2-3：画布加载依赖文件）。
   * 已打开时直接回当前内容 —— 主编辑器正开着它，复用同一份 model。
   */
  async function readDetached (path: string): Promise<string> {
    if (documents.has(path)) return documents.contentOf(path) ?? ''
    const session = sessionId()
    const existing = reads.get(path)
    if (existing?.session === session) return await existing.promise
    const epoch = documents.workspaceEpoch()
    const promise = ideApi.readFile(path).then((file) => {
      if (session !== sessionId() || epoch !== documents.workspaceEpoch()) throw new Error('工作区已切换，忽略旧文档。')
      documents.openDetached(path, file.content, file.revision)
      return documents.contentOf(path) ?? file.content
    })
    const entry = { session, promise }
    reads.set(path, entry)
    try {
      return await promise
    } finally {
      if (reads.get(path) === entry) reads.delete(path)
    }
  }

  async function saveNow (path: string, session: string | null): Promise<boolean> {
    if (session !== sessionId() || documents.conflictOf(path) !== null) return false
    const content = documents.contentOf(path)
    if (content === null || !documents.isDirty(path)) return true
    const revision = documents.expectedRevision(path)
    const identity = documents.modelIdentity(path)
    const epoch = documents.workspaceEpoch()
    const valid = (): boolean => session === sessionId() && epoch === documents.workspaceEpoch()
      && documents.modelIdentity(path) === identity
    if (revision === undefined) {
      const disk = await ideApi.readFile(path)
      if (!valid()) return false
      if (disk.content === content && documents.contentOf(path) === content) {
        documents.markSaved(path, content, disk.revision)
        return true
      }
      documents.enterConflict(path, { diskContent: disk.content, diskRevision: disk.revision })
      return false
    }
    if (session !== sessionId()) return false
    try {
      const result = await ideApi.writeFile(path, content, revision)
      if (!valid()) return false
      documents.markSaved(path, content, result.revision)
      return !documents.isDirty(path)
    } catch (error) {
      if (!valid()) return false
      if (error instanceof IdeApiError && error.fileConflict && error.conflict !== undefined) {
        documents.enterConflict(path, { diskContent: error.conflict.disk.content, diskRevision: error.conflict.disk.revision })
        return false
      }
      throw error
    }
  }

  function save (path: string): Promise<boolean> {
    const session = sessionId()
    const previous = saves.get(path) ?? Promise.resolve(true)
    const next = previous.then(() => saveNow(path, session), () => saveNow(path, session))
    saves.set(path, next)
    void next.finally(() => {
      if (saves.get(path) === next) saves.delete(path)
    }).catch(() => undefined)
    return next
  }

  async function saveAll (): Promise<boolean> {
    if (documents.conflictedPaths.length > 0) return false
    const results = await Promise.all(documents.dirtyPaths.map(save))
    return results.every(Boolean) && !documents.hasDirty && documents.conflictedPaths.length === 0
  }

  return {
    sessionId,
    open,
    readDetached,
    save,
    saveAll,
    contentOf: documents.contentOf,
    modelVersion: documents.modelVersion,
    applyEdit: documents.applyEdit,
    acquireModel: documents.acquireModel,
    subscribe: documents.subscribe,
    expectedRevision: documents.expectedRevision,
    reveal: documents.reveal,

    // ── C1 新增面：结构化命令通道 ──
    //
    // ⚠️ 这几项必须**透传到同一个 DocumentStore 实例**上。
    // 让 Workflow 那侧自己 new 一个 DocumentStore 会得到两套 model 与两套代号，
    // 于是「命令前置核验」核的是另一份文档的版本 —— 形同没有核验。
    snapshot: documents.snapshot,
    applyPrepared: documents.applyPrepared,
    generationOf: documents.generationOf,
    workspaceEpoch: documents.workspaceEpoch,

    // ── C2 保存协调要的那几项 ──
    // ⚠️ openPaths 是 Pinia 的 computed，取值要在**用的那一刻**取，不能在这里解包成
    //    一个快照数组（解包后它永远停在绑定那一刻，保存时看到的是过期的打开列表）。
    get openPaths (): readonly string[] {
      return documents.openPaths
    },
    // DAG-016-01：保存范围用 saveablePaths（含无 tab 但 dirty 的 Inspector 脚本 model）。
    get saveablePaths (): readonly string[] {
      return documents.saveablePaths
    },
    markSaved: documents.markSaved,
    enterConflict: documents.enterConflict,
    close: documents.close,
  }
}

export type DocumentService = ReturnType<typeof createDocumentService>
