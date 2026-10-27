// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import * as monaco from 'monaco-editor'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ApiDiagnostic } from '../api/types.js'
import { workspacePathToUri } from '../editor/document-store.js'
import { diagnosticsToProblems, markersToProblems, useProblemsStore } from './problems.js'

function diagnostic (overrides: Partial<ApiDiagnostic>): ApiDiagnostic {
  return {
    code: 'X1',
    phase: 'schema',
    file: 'fh2-plugin.json',
    message: '出错了',
    severity: 'error',
    ...overrides,
  }
}

describe('diagnosticsToProblems', () => {
  it('映射字段，line/column 缺省为 1，hint 透传', () => {
    const [item] = diagnosticsToProblems([diagnostic({ line: 3, column: 7, hint: '看文档' })])
    expect(item).toMatchObject({
      origin: 'api',
      severity: 'error',
      path: 'fh2-plugin.json',
      line: 3,
      column: 7,
      code: 'X1',
      message: '出错了',
      hint: '看文档',
    })
    const bare = diagnosticsToProblems([diagnostic({})])[0]
    expect(bare).toMatchObject({ line: 1, column: 1 })
    expect(bare?.hint).toBeUndefined()
  })
})

describe('markersToProblems', () => {
  it('绝对工作区 marker 转成工作区相对路径，而不是去掉前导斜杠的 Users/...', () => {
    const root = '/workspace/plugin workspace'
    const path = 'official_accident/backend/official_accident_plugin/fh2-plugin.json'
    const marker = {
      resource: workspacePathToUri(root, path),
      owner: 'json',
      code: '252',
      severity: monaco.MarkerSeverity.Error,
      message: 'Property allowlist2 is not allowed.',
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 2,
    } as monaco.editor.IMarker

    expect(markersToProblems([marker], root)[0]).toMatchObject({
      path,
      source: 'editor',
      message: 'Property allowlist2 is not allowed.',
    })
  })
})

describe('problems store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('双源合并：severity 优先，其次 path，再 line', () => {
    const problems = useProblemsStore()
    problems.setApiProblems(diagnosticsToProblems([
      diagnostic({ file: 'b.ts', severity: 'warning', line: 9 }),
      diagnostic({ file: 'a.ts', severity: 'error', line: 2 }),
    ]))
    problems.setEditorProblems([
      { origin: 'editor', severity: 'error', path: 'a.ts', line: 1, column: 1, code: 'TS1', message: 'm' },
      { origin: 'editor', severity: 'info', path: 'a.ts', line: 1, column: 1, code: 'TS2', message: 'm' },
    ])
    expect(problems.items.map(item => [item.origin, item.path, item.line, item.severity])).toEqual([
      ['editor', 'a.ts', 1, 'error'],
      ['api', 'a.ts', 2, 'error'],
      ['api', 'b.ts', 9, 'warning'],
      ['editor', 'a.ts', 1, 'info'],
    ])
  })

  it('errorCount / warningCount / summaryText', () => {
    const problems = useProblemsStore()
    problems.setApiProblems(diagnosticsToProblems([
      diagnostic({ severity: 'error' }),
      diagnostic({ severity: 'error', file: 'x.ts' }),
      diagnostic({ severity: 'warning', file: 'y.ts' }),
    ]))
    expect(problems.errorCount).toBe(2)
    expect(problems.warningCount).toBe(1)
    expect(problems.summaryText).toBe('2 个错误 · 1 个警告')
  })

  it('clearApiProblems 只清能力层来源', () => {
    const problems = useProblemsStore()
    problems.setApiProblems(diagnosticsToProblems([diagnostic({})]))
    problems.setEditorProblems([
      { origin: 'editor', severity: 'error', path: 'a.ts', line: 1, column: 1, code: 'TS1', message: 'm' },
    ])
    problems.clearApiProblems()
    expect(problems.apiProblems).toEqual([])
    expect(problems.items).toHaveLength(1)
    expect(problems.items[0]?.origin).toBe('editor')
  })
})

it('按文件 owner 更新和清理 Workflow，不清除其他文档或 LSP', () => {
  setActivePinia(createPinia())
  const problems = useProblemsStore()
  const item = { origin: 'workflow', severity: 'error', path: 'a.json', line: 1, column: 1, code: 'WF', message: 'm' } as const
  problems.setProblems('workflow', [item], 'a.json')
  problems.setProblems('workflow', [{ ...item, path: 'b.json' }], 'b.json')
  problems.setProblems('lsp', [{ ...item, path: 'a.ts' }])
  problems.clearProblems('workflow', 'a.json')
  expect(problems.items.map(value => value.path)).toEqual(['a.ts', 'b.json'])
})
