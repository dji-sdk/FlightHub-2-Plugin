// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { parseWorkflowDocument, serializeWorkflow } from '../../../../src/workflow/core/model.js'
import type { WorkflowDocument, WorkflowParseResult } from '../../../../src/workflow/core/model.js'
import type { DocumentService } from '../../editor/document-service.js'

/** Workflow 是统一文档的投影，自己不持有磁盘基线或保存队列。 */
export function bindWorkflowDocument (documents: DocumentService, changed: (result: WorkflowParseResult, path: string) => void) {
  let path: string | null = null
  let version: number | undefined
  let generation = 0
  let releaseModel: (() => void) | undefined
  function refresh (): void {
    if (path === null) return
    const next = documents.modelVersion(path)
    if (next === version) return
    version = next
    const content = documents.contentOf(path)
    if (content !== null) changed(parseWorkflowDocument(content), path)
  }
  const unsubscribe = documents.subscribe(refresh)
  return {
    async open (target: string): Promise<boolean> {
      const current = ++generation
      await documents.open(target)
      if (current !== generation) return false
      releaseModel?.()
      path = target
      releaseModel = documents.acquireModel(target, documents.contentOf(target) ?? '').release
      version = undefined
      refresh()
      return true
    },
    edit (document: WorkflowDocument): boolean {
      const applied = path !== null && version !== undefined && documents.applyEdit(path, serializeWorkflow(document), version)
      if (!applied) {
        version = undefined
        refresh()
      }
      return applied
    },
    reset (): void {
      ++generation
      path = null
      version = undefined
      releaseModel?.()
      releaseModel = undefined
    },
    dispose (): void {
      this.reset()
      unsubscribe()
    },
  }
}
