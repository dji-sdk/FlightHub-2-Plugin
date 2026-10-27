// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor'
import { LSP_MARKER_OWNER, LspDiagnosticsClient, configurationResponse, toMonacoCompletionList, toMonacoHover, toMonacoLocations, toMonacoMarker, toMonacoSemanticTokens, toMonacoWorkspaceEdit } from './client.js'

afterEach(() => {
  vi.unstubAllGlobals()
  for (const model of monaco.editor.getModels()) model.dispose()
})

describe('lSP Monaco adapter', () => {
  it('只向 TypeScript/Volar 同步所属文档，并关闭历史 SQL 文档', () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 })
    const sent: string[] = []
    const diagnostics: unknown[] = []
    const client = new LspDiagnosticsClient({
      url: 'ws://localhost/lsp',
      token: 'token',
      sessionId: 'session',
      rootUri: 'file:///work',
      onDiagnostics: value => diagnostics.push(value),
    })
    client.setDocumentsProvider(() => [
      { path: 'src/main.ts', content: 'export {}', languageId: 'typescript' },
      { path: 'src/App.vue', content: '<script setup lang="ts"></script>', languageId: 'html' },
      { path: 'schema.sql', content: 'CREATE TABLE demo ();', languageId: 'pgsql' },
      { path: 'fh2-plugin.json', content: '{}', languageId: 'json' },
    ])

    const sqlUri = monaco.Uri.parse('file:///work/schema.sql')
    const sqlModel = monaco.editor.createModel('CREATE TABLE demo ();', 'pgsql', sqlUri)
    monaco.editor.setModelMarkers(sqlModel, LSP_MARKER_OWNER, [{
      severity: monaco.MarkerSeverity.Error,
      message: 'Unexpected keyword or identifier.',
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 7,
    }])

    const internals = client as unknown as {
      initialized: boolean;
      socket: WebSocket;
      documentStates: Map<string, { version: number; content: string }>;
      syncDocuments: (forceOpen?: boolean) => void;
      publishDiagnostics: (value: unknown) => void;
    }
    internals.initialized = true
    internals.socket = { readyState: WebSocket.OPEN, send: (data: string) => sent.push(data) } as unknown as WebSocket
    internals.documentStates.set('schema.sql', { version: 1, content: 'CREATE TABLE demo ();' })
    internals.syncDocuments(true)

    const messages = sent.map(frame => JSON.parse(frame.slice(frame.indexOf('\r\n\r\n') + 4)) as {
      method: string;
      params: { textDocument: { uri: string; languageId?: string } };
    })
    const opened = messages.filter(message => message.method === 'textDocument/didOpen')
    expect(opened.map(message => message.params.textDocument)).toEqual([
      expect.objectContaining({ uri: 'file:///work/src/main.ts', languageId: 'typescript' }),
      expect.objectContaining({ uri: 'file:///work/src/App.vue', languageId: 'vue' }),
    ])
    expect(messages).toContainEqual(expect.objectContaining({
      method: 'textDocument/didClose',
      params: { textDocument: { uri: 'file:///work/schema.sql' } },
    }))
    expect(monaco.editor.getModelMarkers({ owner: LSP_MARKER_OWNER, resource: sqlUri })).toEqual([])

    internals.publishDiagnostics({
      uri: 'file:///work/schema.sql',
      diagnostics: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
        severity: 1,
        code: 1435,
        message: 'Unknown keyword or identifier.',
      }],
    })
    expect(monaco.editor.getModelMarkers({ owner: LSP_MARKER_OWNER, resource: sqlUri })).toEqual([])
    expect(diagnostics.at(-1)).toEqual([])
  })

  it('补全项保留 label/detail/snippet 且总有可见文字', () => {
    const model = monaco.editor.createModel('cons', 'typescript', monaco.Uri.parse('file:///work/src/a.ts'))
    const snippet = ['console.', '{1:log}'].join('$')
    const result = toMonacoCompletionList({ items: [{ label: 'console', kind: 6, detail: 'var console', insertText: snippet, insertTextFormat: 2 }] }, model, new monaco.Position(1, 5))
    expect(result.suggestions[0]).toMatchObject({ label: 'console', detail: 'var console', insertText: snippet })
    expect(result.suggestions[0]?.range).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 })
  })

  it('语义请求前立即同步最新文档，不等待去抖定时器', () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 })
    const sent: string[] = []
    const client = new LspDiagnosticsClient({
      url: 'ws://localhost/lsp',
      token: 'token',
      sessionId: 'session',
      rootUri: 'file:///work',
      onDiagnostics: () => undefined,
    })
    client.setDocumentsProvider(() => [{
      path: 'src/IssueDialog.vue',
      content: '<script setup lang="ts">client.state.</script>',
      languageId: 'html',
    }])
    const model = monaco.editor.createModel(
      '<script setup lang="ts">client.state.</script>',
      'html',
      monaco.Uri.parse('file:///work/src/IssueDialog.vue'),
    )
    const internals = client as unknown as {
      initialized: boolean;
      socket: WebSocket;
      documentStates: Map<string, { version: number; content: string }>;
      syncBeforeRequest: (model: monaco.editor.ITextModel) => boolean;
    }
    internals.initialized = true
    internals.socket = { readyState: WebSocket.OPEN, send: (data: string) => sent.push(data) } as unknown as WebSocket
    internals.documentStates.set('src/IssueDialog.vue', {
      version: 1,
      content: '<script setup lang="ts">client.</script>',
    })

    expect(internals.syncBeforeRequest(model)).toBe(true)
    const message = JSON.parse(sent[0]!.slice(sent[0]!.indexOf('\r\n\r\n') + 4)) as {
      method: string;
      params: { textDocument: { version: number };contentChanges: { text: string }[] };
    }
    expect(message).toMatchObject({
      method: 'textDocument/didChange',
      params: {
        textDocument: { version: 2 },
        contentChanges: [{ text: '<script setup lang="ts">client.state.</script>' }],
      },
    })
  })

  it('将 LSP semantic tokens 转为 Monaco 编码并拒绝非法数据', () => {
    const converted = toMonacoSemanticTokens({ resultId: 'v1', data: [0, 2, 8, 10, 1] })
    expect(converted?.resultId).toBe('v1')
    expect([...converted!.data]).toEqual([0, 2, 8, 10, 1])
    expect(toMonacoSemanticTokens({ data: [0, -1, 3, 4, 0] })).toBeNull()
    expect(toMonacoSemanticTokens({ data: 'invalid' })).toBeNull()
  })

  it('hover、定义与重命名编辑转换为 1-based Monaco 坐标', () => {
    expect(toMonacoHover({ contents: { kind: 'markdown', value: '**number**' }, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } }))
      .toMatchObject({ contents: [{ value: '**number**' }], range: { startLineNumber: 2, startColumn: 3 } })
    expect(toMonacoLocations({ uri: 'file:///work/src/b.ts', range: { start: { line: 2, character: 3 }, end: { line: 2, character: 4 } } })?.[0])
      .toMatchObject({ uri: { path: '/work/src/b.ts' }, range: { startLineNumber: 3, startColumn: 4 } })
    expect(toMonacoWorkspaceEdit({ changes: { 'file:///work/src/a.ts': [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'b' }] } }).edits[0])
      .toMatchObject({ resource: { path: '/work/src/a.ts' }, textEdit: { text: 'b', range: { startLineNumber: 1, startColumn: 1 } } })
  })

  it('诊断转换为 Monaco marker，并让未配置的 LSP 配置项使用 null 默认值', () => {
    expect(toMonacoMarker({
      range: { start: { line: 2, character: 3 }, end: { line: 2, character: 8 } },
      severity: 1,
      code: 2322,
      message: 'Type mismatch',
    })).toEqual({
      startLineNumber: 3,
      startColumn: 4,
      endLineNumber: 3,
      endColumn: 9,
      severity: monaco.MarkerSeverity.Error,
      code: '2322',
      message: 'Type mismatch',
    })
    expect(configurationResponse({ items: [{ section: 'css.customData' }, { section: 'typescript' }] })).toEqual([null, null])
    expect(configurationResponse(null)).toEqual([])
  })
})
