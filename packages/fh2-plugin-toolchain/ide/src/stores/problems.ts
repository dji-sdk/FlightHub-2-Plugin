// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import * as monaco from 'monaco-editor'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ApiDiagnostic } from '../api/types.js'
import { uriToPath, uriToWorkspacePath } from '../editor/document-store.js'

/**
 * L4：Problems 按 source 分源更新/清理。
 *
 * 每个来源只替换/清理自己的诊断：Validate、Build、LSP、Workflow、Task 互不清除。
 * `setEditorProblems`/`setApiProblems` 是历史便捷入口（editor / validate 源）。
 */
export type ProblemSource = 'editor' | 'workspace' | 'validate' | 'build' | 'lsp' | 'workflow' | 'task'

export type ProblemOrigin = 'editor' | 'api' | 'workflow'

export interface ProblemItem {
  readonly origin: ProblemOrigin;
  readonly severity: 'error' | 'warning' | 'info';
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  /** 产生该问题的来源标签（面板分组展示用）。 */
  readonly source?: ProblemSource;
  /**
   * 结构化定位目标（P2-2）：file = 文件行列；workflow-node = 画布节点/具体输入。
   * 点击行为按它分派 —— 没有 target 的回退 file 行为（path/line/column）。
   */
  readonly target?: ProblemTarget;
}

export type ProblemTarget =
  | { readonly kind: 'file'; readonly path: string; readonly line?: number; readonly column?: number }
  | { readonly kind: 'workflow-node'; readonly workflowPath: string; readonly nodeId: string; readonly inputKey?: string }

function severityOfMarker (severity: monaco.MarkerSeverity): ProblemItem['severity'] {
  if (severity === monaco.MarkerSeverity.Error) return 'error'
  if (severity === monaco.MarkerSeverity.Warning) return 'warning'
  return 'info'
}

function markerCode (marker: monaco.editor.IMarker): string {
  if (marker.code === undefined) return marker.owner
  return typeof marker.code === 'string' ? marker.code : marker.code.value
}

export function markersToProblems (
  markers: readonly monaco.editor.IMarker[],
  workspaceRoot?: string | null,
): ProblemItem[] {
  return markers
    // Monaco 的 Hint 级别基本是「可以这样写更好」，塞进问题面板只会淹没真错误
    .filter(marker => marker.severity !== monaco.MarkerSeverity.Hint)
    .map(marker => ({
      origin: 'editor' as const,
      severity: severityOfMarker(marker.severity),
      path: workspaceRoot === undefined || workspaceRoot === null
        ? uriToPath(marker.resource)
        : uriToWorkspacePath(marker.resource, workspaceRoot),
      line: marker.startLineNumber,
      column: marker.startColumn,
      code: markerCode(marker),
      message: marker.message,
      source: 'editor' as const,
    }))
}

export function diagnosticsToProblems (diagnostics: readonly ApiDiagnostic[], source: ProblemSource = 'validate'): ProblemItem[] {
  return diagnostics.map(diagnostic => ({
    origin: 'api' as const,
    severity: diagnostic.severity,
    path: diagnostic.file,
    line: diagnostic.line ?? 1,
    column: diagnostic.column ?? 1,
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.hint === undefined ? {} : { hint: diagnostic.hint }),
    source,
  }))
}

const SEVERITY_ORDER: Record<ProblemItem['severity'], number> = { error: 0, warning: 1, info: 2 }

/**
 * 问题面板的多源数据：Monaco markers（编辑器实态）+ 各能力源诊断（Validate/Build/Workflow…）。
 * 合并与排序在这里完成，UI 只负责渲染行；来源之间互不清除。
 */
export const useProblemsStore = defineStore('problems', () => {
  /** 各来源的问题集合；来源自身整体替换。 */
  const sources = ref<ReadonlyMap<string, readonly ProblemItem[]>>(new Map())

  function setProblems (source: ProblemSource, problems: readonly ProblemItem[], owner = ''): void {
    const next = new Map(sources.value)
    next.set(owner === '' ? source : `${source}\0${owner}`, problems)
    sources.value = next
  }

  function clearProblems (source: ProblemSource, owner?: string): void {
    const next = new Map(sources.value)
    for (const key of next.keys()) {
      if (owner === undefined ? key === source || key.startsWith(`${source}\0`) : key === (owner === '' ? source : `${source}\0${owner}`)) next.delete(key)
    }
    sources.value = next
  }

  function clearAll (): void {
    sources.value = new Map()
  }

  const items = computed(() => {
    const all: ProblemItem[] = []
    for (const list of sources.value.values()) all.push(...list)
    return all.sort((a, b) => {
      const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
      if (bySeverity !== 0) return bySeverity
      const byPath = a.path.localeCompare(b.path)
      return byPath === 0 ? a.line - b.line : byPath
    })
  })

  const errorCount = computed(() => items.value.filter(problem => problem.severity === 'error').length)
  const warningCount = computed(() => items.value.filter(problem => problem.severity === 'warning').length)
  const summaryText = computed(() => `${errorCount.value} 个错误 · ${warningCount.value} 个警告`)

  // 历史便捷入口（向后兼容）：editor markers 与 validate 诊断。
  const editorProblems = computed(() => sources.value.get('editor') ?? [])
  const apiProblems = computed(() => [
    ...(sources.value.get('validate') ?? []),
    ...(sources.value.get('build') ?? []),
  ])

  function setEditorProblems (problems: readonly ProblemItem[]): void {
    setProblems('editor', problems)
  }

  function setApiProblems (problems: readonly ProblemItem[]): void {
    setProblems('validate', problems)
  }

  function clearApiProblems (): void {
    clearProblems('validate')
  }

  return {
    sources,
    items,
    errorCount,
    warningCount,
    summaryText,
    editorProblems,
    apiProblems,
    setProblems,
    clearProblems,
    clearAll,
    setEditorProblems,
    setApiProblems,
    clearApiProblems,
  }
})
