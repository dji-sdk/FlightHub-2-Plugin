// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import * as monaco from 'monaco-editor'
import type { Diagnostic, LspServerControlMessage } from '../../../src/contracts/index.js'
import { parseLspServerControlMessage, parseLspServerHandshake } from '../../../src/contracts/index.js'

export type LspClientStatus = 'connecting' | 'starting' | 'open' | 'closed' | 'failed'

export interface LspClientOptions {
  readonly url: string;
  readonly token: string;
  readonly sessionId: string;
  readonly rootUri: string;
  readonly onDiagnostics: (diagnostics: readonly Diagnostic[]) => void;
  readonly onStatus?: (status: LspClientStatus, detail?: string) => void;
  readonly onLog?: (entry: LspServerControlMessage & { readonly type: 'server-log' }) => void;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { readonly code?: number; readonly message?: string };
}

interface LspPosition {
  readonly line: number;
  readonly character: number;
}
interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}
interface LspLocation {
  readonly uri: string;
  readonly range: LspRange;
}
interface LspTextEdit {
  readonly range: LspRange;
  readonly newText: string;
}
interface LspDiagnostic {
  readonly range: LspRange;
  readonly severity?: number;
  readonly code?: number | string;
  readonly message: string;
}
interface LspCompletionItem {
  readonly label: string;
  readonly kind?: number;
  readonly detail?: string;
  readonly documentation?: string | { readonly value?: string };
  readonly insertText?: string;
  readonly insertTextFormat?: number;
  readonly sortText?: string;
  readonly filterText?: string;
  readonly textEdit?: LspTextEdit;
}

interface LspSemanticTokensLegend {
  readonly tokenTypes: readonly string[];
  readonly tokenModifiers: readonly string[];
}

interface LspSemanticTokens {
  readonly resultId?: string;
  readonly data: readonly number[];
}

const SEMANTIC_TOKEN_TYPES = [
  'namespace',
  'type',
  'class',
  'enum',
  'interface',
  'struct',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'macro',
  'label',
  'comment',
  'string',
  'keyword',
  'number',
  'regexp',
  'operator',
  'decorator',
  'component',
]
const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration',
  'definition',
  'readonly',
  'static',
  'deprecated',
  'abstract',
  'async',
  'modification',
  'documentation',
  'defaultLibrary',
  'local',
]

const DEBOUNCE_MS = 300
const MAX_BACKOFF_MS = 15_000
export const LSP_MARKER_OWNER = 'fh2-lsp'

const LSP_LANGUAGE_SELECTORS: readonly (string | monaco.languages.LanguageFilter)[] = [
  'typescript',
  'javascript',
  // .vue model 保持 html 语言以复用现有高亮，但语义能力必须只来自 Volar。
  // exclusive 会在这些文件上排除 Monaco 内置 HTML provider，避免 script 中混入 onclick/onblur。
  { language: 'html', scheme: 'file', pattern: '**/*.vue', exclusive: true },
]

/**
 * WebSocket LSP 客户端：用服务端能力驱动 Monaco 的补全、hover、定义、引用和重命名。
 *
 * 仓库使用原生 Monaco model/document store，没有初始化 monaco-vscode-api 的整套
 * workbench service。因此不直接启动 MonacoLanguageClient（v10 强依赖该 service graph），
 * 而是复用标准 LSP 协议，将所需 provider 精确映射到现有 Monaco 实例。
 */
export class LspDiagnosticsClient {
  private socket: WebSocket | null = null
  private stopped = false
  private initialized = false
  private backoffMs = 500
  private nextId = 1
  private bytes = new Uint8Array()
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly documentStates = new Map<string, { version: number; content: string }>()
  private readonly diagnostics = new Map<string, readonly Diagnostic[]>()
  private syncTimer: number | null = null
  private retryTimer: number | null = null
  private disposables: monaco.IDisposable[] = []
  private semanticTokensDisposable: monaco.IDisposable | null = null
  private documentsProvider: () => readonly { path: string; content: string; languageId: string }[] = () => []

  constructor (private readonly options: LspClientOptions) {}

  setDocumentsProvider (provider: () => readonly { path: string; content: string; languageId: string }[]): void {
    this.documentsProvider = provider
  }

  start (): void {
    this.stopped = false
    disableBuiltInTypeScriptLanguageFeatures()
    this.registerProviders()
    this.connect()
  }

  stop (): void {
    this.stopped = true
    this.initialized = false
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer)
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer)
    this.syncTimer = null
    this.retryTimer = null
    this.socket?.close()
    this.socket = null
    this.rejectPending('语言服务已停止')
    for (const uri of this.diagnostics.keys()) this.clearMarkers(uri)
    this.diagnostics.clear()
    this.options.onDiagnostics([])
    this.semanticTokensDisposable?.dispose()
    this.semanticTokensDisposable = null
    for (const disposable of this.disposables.splice(0)) disposable.dispose()
    this.options.onStatus?.('closed')
  }

  scheduleSync (): void {
    if (!this.initialized) return
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer)
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null
      this.syncDocuments()
    }, DEBOUNCE_MS)
  }

  private connect (): void {
    if (this.stopped) return
    this.options.onStatus?.('connecting')
    const socket = new WebSocket(this.options.url)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    socket.onopen = () => {
      this.backoffMs = 500
      socket.send(JSON.stringify({
        type: 'hello',
        protocol: 'fh2-lsp',
        protocolVersion: 1,
        token: this.options.token,
        workspaceSessionId: this.options.sessionId,
      }))
    }
    socket.onmessage = event => this.consumeSocketData(event.data)
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.initialized = false
      this.bytes = new Uint8Array()
      this.documentStates.clear()
      this.rejectPending('语言服务连接已断开')
      this.options.onStatus?.('closed')
      if (!this.stopped) {
        this.retryTimer = window.setTimeout(() => this.connect(), this.backoffMs)
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
      }
    }
    socket.onerror = () => undefined
  }

  private consumeSocketData (data: unknown): void {
    if (typeof data === 'string') {
      this.handleJson(data)
      return
    }
    if (!(data instanceof ArrayBuffer)) return
    const next = new Uint8Array(this.bytes.length + data.byteLength)
    next.set(this.bytes)
    next.set(new Uint8Array(data), this.bytes.length)
    this.bytes = next
    for (;;) {
      const headerEnd = findHeaderEnd(this.bytes)
      if (headerEnd === -1) break
      const header = new TextDecoder().decode(this.bytes.slice(0, headerEnd))
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (match === null) {
        this.bytes = this.bytes.slice(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const bodyStart = headerEnd + 4
      if (this.bytes.length < bodyStart + length) break
      const body = new TextDecoder().decode(this.bytes.slice(bodyStart, bodyStart + length))
      this.bytes = this.bytes.slice(bodyStart + length)
      this.handleJson(body)
    }
  }

  private handleJson (body: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return
    }
    const handshake = parseLspServerHandshake(parsed)
    if (handshake !== null) {
      if (handshake.type === 'rejected') {
        this.options.onStatus?.('failed', handshake.message)
        this.stop()
      } else {
        const serverKind = 'serverKind' in handshake ? handshake.serverKind : undefined
        this.options.onStatus?.('starting', serverKind === 'vue' ? 'Volar' : 'TypeScript')
        void this.initialize()
      }
      return
    }
    const control = parseLspServerControlMessage(parsed)
    if (control !== null) {
      if (control.type === 'server-log') {
        this.options.onLog?.(control)
      } else {
        this.options.onStatus?.(
          control.status === 'running' ? 'starting' : control.status === 'stopped' ? 'closed' : control.status,
          control.message,
        )
      }
      return
    }
    const message = parsed as JsonRpcMessage
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(message.error.message ?? `LSP ${String(message.error.code)}`))
      else pending.resolve(message.result)
      return
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      this.publishDiagnostics(message.params)
      return
    }
    if (message.method === 'window/logMessage' || message.method === 'window/showMessage') {
      const params = message.params as { message?: unknown }
      if (typeof params?.message === 'string') {
        this.options.onLog?.({ type: 'server-log', protocol: 'fh2-lsp', stream: 'stderr', source: 'typescript-language-server', message: params.message })
      }
      return
    }
    if (message.id !== undefined && message.method !== undefined) this.respondToServer(message)
  }

  private async initialize (): Promise<void> {
    try {
      const initializeResult = await this.request('initialize', {
        processId: null,
        rootUri: this.options.rootUri,
        workspaceFolders: [{ uri: this.options.rootUri, name: this.options.rootUri.split('/').at(-1) ?? 'workspace' }],
        capabilities: {
          workspace: { workspaceFolders: true, configuration: true, applyEdit: true },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: true },
            publishDiagnostics: { relatedInformation: true, versionSupport: true },
            completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], resolveSupport: { properties: ['detail', 'documentation', 'textEdit'] } } },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: true },
            references: {},
            rename: { prepareSupport: true },
            semanticTokens: {
              dynamicRegistration: false,
              requests: { full: true, range: false },
              tokenTypes: SEMANTIC_TOKEN_TYPES,
              tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
              formats: ['relative'],
              overlappingTokenSupport: false,
              multilineTokenSupport: false,
            },
          },
        },
      })
      this.notify('initialized', {})
      this.initialized = true
      this.syncDocuments(true)
      // 先 initialized + didOpen，再注册 provider；注册会立即触发当前 model 的 token 请求。
      this.registerSemanticTokensProvider(semanticTokensLegend(initializeResult))
      this.options.onStatus?.('open')
    } catch (error) {
      this.options.onStatus?.('failed', error instanceof Error ? error.message : String(error))
    }
  }

  private publishDiagnostics (value: unknown): void {
    const params = value as { uri?: string; diagnostics?: readonly LspDiagnostic[] }
    if (params.uri === undefined || !Array.isArray(params.diagnostics)) return
    if (![...this.documentStates.keys()].some(path => documentUri(this.options.rootUri, path) === params.uri)) {
      this.clearMarkers(params.uri)
      this.diagnostics.delete(params.uri)
      this.options.onDiagnostics([...this.diagnostics.values()].flat())
      return
    }
    const model = monaco.editor.getModel(monaco.Uri.parse(params.uri))
    if (model !== null) {
      monaco.editor.setModelMarkers(model, LSP_MARKER_OWNER, params.diagnostics.map(toMonacoMarker))
    }
    this.diagnostics.set(params.uri, params.diagnostics.map(diagnostic => toProblemDiagnostic(params.uri!, diagnostic, this.options.rootUri)))
    this.options.onDiagnostics([...this.diagnostics.values()].flat())
  }

  private clearMarkers (uri: string): void {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri))
    if (model !== null) monaco.editor.setModelMarkers(model, LSP_MARKER_OWNER, [])
  }

  private respondToServer (message: JsonRpcMessage): void {
    let result: unknown = null
    if (message.method === 'workspace/configuration') {
      result = configurationResponse(message.params)
    } else if (message.method === 'workspace/workspaceFolders') {
      result = [{ uri: this.options.rootUri, name: this.options.rootUri.split('/').at(-1) ?? 'workspace' }]
    } else if (message.method === 'workspace/applyEdit') {
      result = { applied: false, failureReason: '当前 IDE 不允许语言服务主动修改未打开文件' }
    }
    this.send({ jsonrpc: '2.0', id: message.id, result })
  }

  private syncDocuments (forceOpen = false): void {
    if (!this.initialized) return
    const documents = this.documentsProvider().filter(isLspDocument)
    const seen = new Set<string>()
    for (const document of documents) {
      seen.add(document.path)
      const uri = documentUri(this.options.rootUri, document.path)
      const existing = this.documentStates.get(document.path)
      if (existing === undefined || forceOpen) {
        const version = (existing?.version ?? 0) + 1
        this.documentStates.set(document.path, { version, content: document.content })
        this.notify('textDocument/didOpen', { textDocument: {
          uri,
          languageId: document.path.endsWith('.vue') ? 'vue' : document.languageId,
          version,
          text: document.content,
        } })
      } else if (existing.content !== document.content) {
        existing.version += 1
        existing.content = document.content
        this.notify('textDocument/didChange', {
          textDocument: { uri, version: existing.version },
          contentChanges: [{ text: document.content }],
        })
      }
    }
    for (const path of [...this.documentStates.keys()]) {
      if (seen.has(path)) continue
      this.documentStates.delete(path)
      const uri = documentUri(this.options.rootUri, path)
      this.notify('textDocument/didClose', { textDocument: { uri } })
      this.clearMarkers(uri)
      this.diagnostics.delete(uri)
    }
    this.options.onDiagnostics([...this.diagnostics.values()].flat())
  }

  private registerProviders (): void {
    const positionParams = (model: monaco.editor.ITextModel, position: monaco.Position) => ({
      textDocument: { uri: model.uri.toString() },
      position: { line: position.lineNumber - 1, character: position.column - 1 },
    })
    for (const selector of LSP_LANGUAGE_SELECTORS) {
      this.disposables.push(monaco.languages.registerCompletionItemProvider(selector, {
        triggerCharacters: ['.', '/', '"', '\'', '@', '<'],
        provideCompletionItems: async (model, position, context) => {
          if (!this.syncBeforeRequest(model)) return { suggestions: [] }
          return toMonacoCompletionList(await this.safeRequest('textDocument/completion', { ...positionParams(model, position), context }), model, position)
        },
      }))
      this.disposables.push(monaco.languages.registerHoverProvider(selector, {
        provideHover: async (model, position) => this.syncBeforeRequest(model)
          ? toMonacoHover(await this.safeRequest('textDocument/hover', positionParams(model, position)))
          : null,
      }))
      this.disposables.push(monaco.languages.registerDefinitionProvider(selector, {
        provideDefinition: async (model, position) => this.syncBeforeRequest(model)
          ? toMonacoLocations(await this.safeRequest('textDocument/definition', positionParams(model, position)))
          : null,
      }))
      this.disposables.push(monaco.languages.registerReferenceProvider(selector, {
        provideReferences: async (model, position, context) => this.syncBeforeRequest(model)
          ? toMonacoLocations(await this.safeRequest('textDocument/references', { ...positionParams(model, position), context }))
          : null,
      }))
      this.disposables.push(monaco.languages.registerRenameProvider(selector, {
        provideRenameEdits: async (model, position, newName) => this.syncBeforeRequest(model)
          ? toMonacoWorkspaceEdit(await this.safeRequest('textDocument/rename', { ...positionParams(model, position), newName }))
          : { edits: [] },
      }))
    }
  }

  private registerSemanticTokensProvider (legend: LspSemanticTokensLegend | null): void {
    this.semanticTokensDisposable?.dispose()
    this.semanticTokensDisposable = null
    if (legend === null) return
    this.semanticTokensDisposable = monaco.languages.registerDocumentSemanticTokensProvider(LSP_LANGUAGE_SELECTORS, {
      getLegend: () => ({ tokenTypes: [...legend.tokenTypes], tokenModifiers: [...legend.tokenModifiers] }),
      provideDocumentSemanticTokens: async (model, _lastResultId, token) => {
        if (token.isCancellationRequested || !this.syncBeforeRequest(model)) return null
        const result = toMonacoSemanticTokens(await this.safeRequest('textDocument/semanticTokens/full', {
          textDocument: { uri: model.uri.toString() },
        }))
        return token.isCancellationRequested ? null : result
      },
      releaseDocumentSemanticTokens: () => undefined,
    })
  }

  /**
   * Monaco 会在输入后立即请求补全；如果仍等 300ms 去抖，服务端就会用
   * 旧文本解释新光标位置。语义请求前先全量同步已打开文档，WebSocket 顺序
   * 保证 didChange 先于随后的 request 到达。
   */
  private syncBeforeRequest (model: monaco.editor.ITextModel): boolean {
    if (!this.owns(model) || !this.initialized) return false
    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer)
      this.syncTimer = null
    }
    this.syncDocuments()
    return [...this.documentStates.keys()].some(path => documentUri(this.options.rootUri, path) === model.uri.toString())
  }

  private owns (model: monaco.editor.ITextModel): boolean {
    return model.uri.scheme === 'file' && model.uri.toString().startsWith(`${this.options.rootUri}/`)
  }

  private async safeRequest (method: string, params: unknown): Promise<unknown> {
    if (!this.initialized) return null
    try {
      return await this.request(method, params)
    } catch (error) {
      this.options.onStatus?.('failed', `${method}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  private request (method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      if (!this.send({ jsonrpc: '2.0', id, method, params })) {
        this.pending.delete(id)
        reject(new Error('语言服务未连接'))
      }
    })
  }

  private notify (method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private send (payload: unknown): boolean {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) return false
    const body = JSON.stringify(payload)
    this.socket.send(`Content-Length: ${new TextEncoder().encode(body).length}\r\n\r\n${body}`)
    return true
  }

  private rejectPending (message: string): void {
    for (const pending of this.pending.values()) pending.reject(new Error(message))
    this.pending.clear()
  }
}

export function configurationResponse (value: unknown): null[] {
  const items = (value as { items?: unknown[] } | null)?.items
  return Array.isArray(items) ? items.map(() => null) : []
}

/** TypeScript/Volar 服务只拥有 TS、JS 与 Vue；其他语言由各自的 Monaco provider 处理。 */
export function isLspDocument (document: { readonly path: string; readonly languageId: string }): boolean {
  return document.languageId === 'typescript'
    || document.languageId === 'javascript'
    || document.path.toLowerCase().endsWith('.vue')
}

function semanticTokensLegend (value: unknown): LspSemanticTokensLegend | null {
  const provider = (value as {
    capabilities?: { semanticTokensProvider?: { legend?: Partial<LspSemanticTokensLegend> } };
  } | null)?.capabilities?.semanticTokensProvider
  const tokenTypes = provider?.legend?.tokenTypes
  const tokenModifiers = provider?.legend?.tokenModifiers
  return Array.isArray(tokenTypes) && tokenTypes.every(item => typeof item === 'string')
    && Array.isArray(tokenModifiers) && tokenModifiers.every(item => typeof item === 'string')
    ? { tokenTypes, tokenModifiers }
    : null
}

/**
 * TS/JS 的项目语义由真实 tsserver/Volar 提供。内置 worker 看不到 node_modules，
 * 同时开启会产生虚假 2307 和两份补全候选，所以只保留它的文档符号/格式化等本地能力。
 */
function disableBuiltInTypeScriptLanguageFeatures (): void {
  for (const defaults of [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults]) {
    defaults.setModeConfiguration({
      ...defaults.modeConfiguration,
      completionItems: false,
      hovers: false,
      definitions: false,
      references: false,
      rename: false,
      diagnostics: false,
    })
  }
}

function findHeaderEnd (bytes: Uint8Array): number {
  for (let index = 0; index <= bytes.length - 4; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) return index
  }
  return -1
}

function documentUri (rootUri: string, path: string): string {
  return `${rootUri}/${path.split('/').map(encodeURIComponent).join('/')}`
}

function toRange (range: LspRange): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  }
}

export function toMonacoMarker (diagnostic: LspDiagnostic): monaco.editor.IMarkerData {
  return {
    severity: diagnostic.severity === 2
      ? monaco.MarkerSeverity.Warning
      : diagnostic.severity === 3
        ? monaco.MarkerSeverity.Info
        : diagnostic.severity === 4
          ? monaco.MarkerSeverity.Hint
          : monaco.MarkerSeverity.Error,
    message: diagnostic.message,
    ...(diagnostic.code === undefined ? {} : { code: String(diagnostic.code) }),
    ...toRange(diagnostic.range),
  }
}

function markdown (value: unknown): monaco.IMarkdownString[] {
  const values = Array.isArray(value) ? value : [value]
  return values.flatMap((item): monaco.IMarkdownString[] => {
    if (typeof item === 'string') return [{ value: item }]
    if (typeof item === 'object' && item !== null) {
      const record = item as { language?: unknown; value?: unknown }
      if (typeof record.value !== 'string') return []
      return [{ value: typeof record.language === 'string' ? `\`\`\`${record.language}\n${record.value}\n\`\`\`` : record.value }]
    }
    return []
  })
}

export function toMonacoCompletionList (value: unknown, model: monaco.editor.ITextModel, position: monaco.Position): monaco.languages.CompletionList {
  const record = value as { items?: unknown[]; isIncomplete?: boolean } | null
  const items = Array.isArray(value) ? value : (Array.isArray(record?.items) ? record.items : [])
  const word = model.getWordUntilPosition(position)
  const fallbackRange: monaco.IRange = {
    startLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endLineNumber: position.lineNumber,
    endColumn: word.endColumn,
  }
  return {
    incomplete: record?.isIncomplete === true,
    suggestions: items.flatMap((raw): monaco.languages.CompletionItem[] => {
      if (typeof raw !== 'object' || raw === null || typeof (raw as LspCompletionItem).label !== 'string') return []
      const item = raw as LspCompletionItem
      return [{
        label: item.label,
        kind: completionKind(item.kind),
        insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
        range: item.textEdit === undefined ? fallbackRange : toRange(item.textEdit.range),
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        ...(item.documentation === undefined ? {} : { documentation: markdown(item.documentation)[0] }),
        ...(item.sortText === undefined ? {} : { sortText: item.sortText }),
        ...(item.filterText === undefined ? {} : { filterText: item.filterText }),
        ...(item.insertTextFormat === 2 ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet } : {}),
      }]
    }),
  }
}

export function toMonacoSemanticTokens (value: unknown): monaco.languages.SemanticTokens | null {
  const record = value as Partial<LspSemanticTokens> | null
  if (!Array.isArray(record?.data)
    || record.data.some(item => !Number.isSafeInteger(item) || item < 0)) {
    return null
  }
  return {
    data: Uint32Array.from(record.data),
    ...(typeof record.resultId === 'string' ? { resultId: record.resultId } : {}),
  }
}

function completionKind (kind?: number): monaco.languages.CompletionItemKind {
  const kinds = monaco.languages.CompletionItemKind
  return ({
    1: kinds.Text,
    2: kinds.Method,
    3: kinds.Function,
    4: kinds.Constructor,
    5: kinds.Field,
    6: kinds.Variable,
    7: kinds.Class,
    8: kinds.Interface,
    9: kinds.Module,
    10: kinds.Property,
    11: kinds.Unit,
    12: kinds.Value,
    13: kinds.Enum,
    14: kinds.Keyword,
    15: kinds.Snippet,
    16: kinds.Color,
    17: kinds.File,
    18: kinds.Reference,
    19: kinds.Folder,
    20: kinds.EnumMember,
    21: kinds.Constant,
    22: kinds.Struct,
    23: kinds.Event,
    24: kinds.Operator,
    25: kinds.TypeParameter,
  } as Record<number, monaco.languages.CompletionItemKind>)[kind ?? 0] ?? kinds.Text
}

export function toMonacoHover (value: unknown): monaco.languages.Hover | null {
  if (typeof value !== 'object' || value === null) return null
  const hover = value as { contents?: unknown; range?: LspRange }
  const contents = markdown(hover.contents)
  if (contents.length === 0) return null
  return { contents, ...(hover.range === undefined ? {} : { range: toRange(hover.range) }) }
}

export function toMonacoLocations (value: unknown): monaco.languages.Location[] | null {
  if (value === null || value === undefined) return null
  const values = Array.isArray(value) ? value : [value]
  const locations = values.flatMap((raw): monaco.languages.Location[] => {
    if (typeof raw !== 'object' || raw === null) return []
    const entry = raw as LspLocation & { targetUri?: string; targetSelectionRange?: LspRange }
    const uri = entry.targetUri ?? entry.uri
    const range = entry.targetSelectionRange ?? entry.range
    return typeof uri === 'string' && range !== undefined ? [{ uri: monaco.Uri.parse(uri), range: toRange(range) }] : []
  })
  return locations.length === 0 ? null : locations
}

export function toMonacoWorkspaceEdit (value: unknown): monaco.languages.WorkspaceEdit {
  const edit = value as {
    changes?: Record<string, LspTextEdit[]>;
    documentChanges?: readonly { textDocument?: { uri?: string }; edits?: readonly LspTextEdit[] }[];
  } | null
  const edits: monaco.languages.IWorkspaceTextEdit[] = []
  for (const [uri, changes] of Object.entries(edit?.changes ?? {})) {
    for (const change of changes) edits.push({ resource: monaco.Uri.parse(uri), versionId: undefined, textEdit: { range: toRange(change.range), text: change.newText } })
  }
  for (const documentChange of edit?.documentChanges ?? []) {
    const uri = documentChange.textDocument?.uri
    if (uri === undefined) continue
    for (const change of documentChange.edits ?? []) edits.push({ resource: monaco.Uri.parse(uri), versionId: undefined, textEdit: { range: toRange(change.range), text: change.newText } })
  }
  return { edits }
}

function toProblemDiagnostic (uri: string, diagnostic: LspDiagnostic, rootUri: string): Diagnostic {
  const path = decodeURIComponent(uri.startsWith(`${rootUri}/`) ? uri.slice(rootUri.length + 1) : uri)
  const severity = diagnostic.severity === 2 ? 'warning' : diagnostic.severity === 3 || diagnostic.severity === 4 ? 'info' : 'error'
  return {
    code: diagnostic.code === undefined ? 'lsp' : String(diagnostic.code),
    phase: 'code',
    file: path,
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    message: diagnostic.message,
    severity,
  }
}
