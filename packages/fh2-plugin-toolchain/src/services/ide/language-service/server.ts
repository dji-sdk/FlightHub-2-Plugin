// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { type ChildProcess, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { Buffer } from 'node:buffer'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import process from 'node:process'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type WebSocket, WebSocketServer } from 'ws'
import { resolveRuntimeProfile } from '../../application/runtime-profile.js'
import { looksLikeLspClientHandshake, parseLspClientHandshake } from '../../../contracts/index.js'
import type { LspClientHandshake, LspServerControlMessage, LspServerHandshake } from '../../../contracts/index.js'

/** 语言服务形态：由工程语言档案（S1b RuntimeProfile）决定。 */
export type LspServerKind = 'ts' | 'vue'

/**
 * L1/L2 + Volar：LSP over WebSocket（协议见 protocol/src/lsp.ts）。
 *
 * - 首帧是 fh2-lsp 握手（token 鉴权 + workspaceSessionId）；拒绝后关闭连接；
 * - 握手通过后，该连接上的全部帧为标准 JSON-RPC（Content-Length 分帧），
 *   桥接到本连接专属的语言服务子进程：
 *   · 纯 TS/JS 工程 → typescript-language-server --stdio；
 *   · 含 .vue 的工程 → vue-language-server --stdio（Volar：.vue 全功能 +
 *     嵌套 TS/HTML/CSS/JSON 服务；普通 .ts/.js 亦由其提供项目级诊断）。
 *     桥接端拦截 initialize 注入 initializationOptions（tsdk 指向随包
 *     TypeScript、vue.hybridMode=false 独立模式），客户端 hello-accepted
 *     携带 serverKind 供其决定激活 Volar 专属 Monaco provider；
 * - 诊断经 `textDocument/publishDiagnostics` 透传；0-based → 1-based 的行列
 *   转换在客户端 adapter 完成一次（§3.4）；
 * - 生命周期：连接关闭 → SIGTERM → 宽限 → SIGKILL；serve 退出时全部回收；
 * - P1 简化（如实记录）：每个 WebSocket 连接一个语言进程（不做跨连接的项目级
 *   LanguageServiceManager 池）；工作区切换由前端断开重连完成。
 */
export interface LspBridgeOptions {
  readonly token: string;
  /** 当前工作区会话 id（校验迟到连接）。 */
  readonly sessionId: () => string;
  /** tsserver / Volar 工作根（当前工作根）。 */
  readonly root: () => string;
  /** 注入 spawn（测试）。kind 由 resolveServerKind 决定。 */
  readonly spawnServer?: (kind: LspServerKind, root: string) => ChildProcess;
}

/** 按工程语言档案决定服务形态：任一前端成员含 .vue → vue（Volar），否则 ts。 */
export function resolveLspServerKind (root: string): LspServerKind {
  const profile = resolveRuntimeProfile(root)
  return profile.frontend.some(member => member.hasVue) ? 'vue' : 'ts'
}

export class IdeLspBridge {
  private readonly wss: WebSocketServer
  private readonly connections = new Set<LspConnection>()

  constructor (private readonly options: LspBridgeOptions) {
    this.wss = new WebSocketServer({ noServer: true })
  }

  /** HTTP upgrade 处理：只接受 /lsp 路径。 */
  handleUpgrade (req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://fh2-plugin-ide.local')
    if (url.pathname !== '/lsp') {
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const connection = new LspConnection(ws, this.options)
      this.connections.add(connection)
      void connection.closed.then(() => this.connections.delete(connection))
    })
  }

  get activeConnections (): number {
    return this.connections.size
  }

  /** 工作区切换：断开全部连接（旧 session 失效），但保留 upgrade 通道。 */
  async closeConnections (): Promise<void> {
    await Promise.all([...this.connections].map(connection => connection.close('bridge-closing')))
  }

  /** serve 退出：断开连接并关闭 upgrade 通道。 */
  async close (): Promise<void> {
    await this.closeConnections()
    this.wss.close()
  }
}

class LspConnection {
  private child: ChildProcess | null = null
  private serverKind: LspServerKind = 'ts'
  /**
   * Vue 连接附带的 tsserver（加载 @vue/typescript-plugin 的全局插件）：
   * vue-language-server 的 _vue:* 命令经 `tsserver/request` 通知发给客户端，
   * 由本桥转发给该 tsserver 并回 `tsserver/response`（VS Code 混合架构的独立版）。
   * tsserver 协议：stdin 收换行分隔 JSON、stdout 发 Content-Length 帧（与 LSP 输入不同）。
   */
  private tsChild: ChildProcess | null = null
  private tsSeq = 0
  private readonly tsPending = new Map<number, | { readonly kind: 'volar'; readonly requestId: number; readonly command: string }
    | { readonly kind: 'lsp'; readonly requestId: unknown; readonly method: string; readonly newName?: string } >()

  private tsOut = ''
  /** vue server stdout 的帧重组缓冲（帧可能跨 chunk 分裂）。 */
  private vueOut = ''
  /** 语义诊断来源：companion tsserver 的 Diag 事件按文件累积（syntax/semantic/suggestion 合并后发布）。 */
  private readonly diagByFile = new Map<string, { syntax: unknown[]; semantic: unknown[]; suggestion: unknown[] }>()
  private readonly closedResolve: (reason: string) => void
  readonly closed: Promise<string>
  private closedState = false
  /** 握手前的缓冲：JSON-RPC 帧早于握手应答时暂存，握手通过后转发。 */
  private buffered: Buffer[] = []

  constructor (
    private readonly ws: WebSocket,
    private readonly options: LspBridgeOptions,
  ) {
    let resolveClose!: (reason: string) => void
    this.closed = new Promise<string>((resolve) => {
      resolveClose = resolve
    })
    this.closedResolve = resolveClose
    ws.on('message', data => void this.onMessage(data as Buffer))
    ws.on('close', () => void this.close('socket-closed'))
    ws.on('error', () => void this.close('socket-error'))
  }

  private async onMessage (data: Buffer): Promise<void> {
    if (this.closedState) return
    if (this.child === null) {
      // 握手帧（也可能是提前到达的 JSON-RPC：暂存）。
      let parsed: unknown
      try {
        parsed = JSON.parse(data.toString('utf8'))
      } catch {
        this.rejectAndClose('bad-request', '握手帧不是合法 JSON。Handshake frame is not valid JSON.')
        return
      }
      const handshake = parseLspClientHandshake(parsed)
      if (handshake !== null) {
        this.handleHandshake(handshake)
        return
      }
      // 形似握手但 token 缺失/为空：不是 JSON-RPC，不能缓冲——按无效凭据显式拒绝并关闭。
      if (looksLikeLspClientHandshake(parsed)) {
        this.rejectAndClose('unauthorized', '握手帧缺少有效 token。Handshake frame has no valid token.')
        return
      }
      // JSON-RPC 早到：握手通过后按序转发。
      this.buffered.push(data)
      return
    }
    const frame = parseFrame(data)
    // 镜像文档生命周期到附带的 tsserver（触发项目加载，插件随之注册 _vue:* 命令）。
    // P1 边界：不镜像内容变更（tsserver 读磁盘；诊断来自 vue server 的内存文档）。
    if (this.tsChild !== null && frame !== null && typeof frame.method === 'string') {
      const params = frame.params as {
        textDocument?: { uri?: string; text?: string; version?: number };
        contentChanges?: readonly { text?: string }[];
      } | undefined
      const uri = params?.textDocument?.uri
      if (uri !== undefined) {
        const file = fileUriToPath(uri)
        // 非 file:// 或非法 URI（如 untitled:）：跳过 tsserver 镜像，帧仍原样转发。
        if (file !== undefined) {
          if (frame.method === 'textDocument/didOpen') {
            const text = params?.textDocument?.text
            this.tsCommand('open', { file, ...(typeof text === 'string' ? { fileContent: text } : {}) })
            this.requestDiagnostics(file)
          } else if (frame.method === 'textDocument/didChange') {
            // 全量内容变更：close+open 重建快照（change 命令的行级编辑协议繁琐，不值得）。
            const text = params?.contentChanges?.[0]?.text
            this.tsCommand('close', { file })
            if (typeof text === 'string') this.tsCommand('open', { file, fileContent: text })
            else this.tsCommand('open', { file })
            this.requestDiagnostics(file)
          } else if (frame.method === 'textDocument/didClose') {
            this.tsCommand('close', { file })
          }
        }
      }
    }
    // Volar 3.x 的 language-server 不再内置 TypeScript 语义 provider；
    // 官方架构由客户端 TS 扩展 + @vue/typescript-plugin 提供。这里已有同等
    // companion tsserver，因此在桥上接管五类语义请求，其余 Vue/HTML 能力仍交给 Volar。
    if (this.tsChild !== null && frame !== null && frame.id !== undefined && isCompanionSemanticMethod(frame.method)) {
      this.requestCompanionSemantic(frame)
      return
    }
    this.child.stdin?.write(this.prepareClientFrame(data))
  }

  private requestCompanionSemantic (frame: { id?: unknown; method?: string; params?: unknown }): void {
    const method = frame.method
    const params = frame.params as { textDocument?: { uri?: string };position?: { line?: number;character?: number };newName?: string } | undefined
    const uri = params?.textDocument?.uri
    const line = params?.position?.line
    const character = params?.position?.character
    const newName = params?.newName
    if (frame.id === undefined || method === undefined || uri === undefined || line === undefined || character === undefined) {
      this.sendLsp({ jsonrpc: '2.0', id: frame.id ?? null, result: null })
      return
    }
    const command = companionCommand(method)
    if (command === null) {
      this.sendLsp({ jsonrpc: '2.0', id: frame.id, result: null })
      return
    }
    const file = fileUriToPath(uri)
    // 非 file:// 或非法 URI：语义请求没有可作用的本地文件，返回空结果而非崩溃。
    if (file === undefined) {
      this.sendLsp({ jsonrpc: '2.0', id: frame.id, result: null })
      return
    }
    const arguments_: Record<string, unknown> = {
      file,
      line: line + 1,
      offset: character + 1,
    }
    if (command === 'completionInfo') {
      arguments_.includeExternalModuleExports = true
      arguments_.includeInsertTextCompletions = true
    } else if (command === 'references') {
      arguments_.includeDeclaration = true
    } else if (command === 'rename') {
      arguments_.findInStrings = false
      arguments_.findInComments = false
    }
    this.tsSeq += 1
    this.tsPending.set(this.tsSeq, {
      kind: 'lsp',
      requestId: frame.id,
      method,
      ...(newName === undefined ? {} : { newName }),
    })
    this.tsChild?.stdin?.write(`${JSON.stringify({ seq: this.tsSeq, type: 'request', command, arguments: arguments_ })}\n`)
  }

  /**
   * 请求 companion tsserver 校验文件（触发 syntax/semantic/suggestion Diag 事件）。
   * 'open' 后项目对文件的挂载是异步的，立即 geterr 会静默无事件——延迟 + 重试。
   */
  private requestDiagnostics (file: string): void {
    const send = (): void => {
      this.tsCommand('geterr', { delay: 0, files: [file] })
    }
    const first = setTimeout(() => {
      send()
      // 2.5s 后若该文件仍无任何诊断事件，重试一次（覆盖慢加载的项目）。
      const second = setTimeout(() => {
        const entry = this.diagByFile.get(file)
        if (entry === undefined || (entry.syntax.length === 0 && entry.semantic.length === 0 && entry.suggestion.length === 0)) send()
      }, 2500)
      second.unref?.()
    }, 500)
    first.unref?.()
  }

  /** 向附带 tsserver 发一条协议命令（换行 JSON）。 */
  private tsCommand (command: string, arguments_: Record<string, unknown>): void {
    const child = this.tsChild
    if (child === null || child.stdin === null) return
    this.tsSeq += 1
    child.stdin.write(`${JSON.stringify({ seq: this.tsSeq, type: 'request', command, arguments: arguments_ })}\n`)
  }

  /**
   * 客户端 → 服务端帧处理。Volar 连接需把 initialize 的
   * initializationOptions 补齐（tsdk / hybridMode），否则 vue-language-server
   * 找不到 TypeScript SDK、且默认按 VS Code 混合模式工作。ts 连接原样透传。
   */
  private prepareClientFrame (data: Buffer): Buffer {
    if (this.serverKind !== 'vue') return data
    const frame = parseFrame(data)
    if (frame === null || frame.method !== 'initialize') return data
    const params = (frame.params ?? {}) as Record<string, unknown>
    frame.params = {
      ...params,
      initializationOptions: {
        ...(isRecord(params.initializationOptions) ? params.initializationOptions : {}),
        typescript: {
          tsdk: resolveTypeScriptTsdk(),
          ...(isRecord((params.initializationOptions as { typescript?: unknown } | undefined)?.typescript)
            ? (params.initializationOptions as { typescript: Record<string, unknown> }).typescript
            : {}),
        },
        vue: { hybridMode: false },
      },
    }
    return serializeFrame(frame)
  }

  private handleHandshake (handshake: LspClientHandshake): void {
    if (!tokenEquals(handshake.token, this.options.token)) {
      this.rejectAndClose('unauthorized', 'token 校验失败。Invalid token.')
      return
    }
    if (handshake.workspaceSessionId !== this.options.sessionId()) {
      this.rejectAndClose('session-mismatch', '工作区会话不匹配（工作根已切换）。Workspace session mismatch.')
      return
    }
    this.serverKind = resolveLspServerKind(this.options.root())
    const child = (this.options.spawnServer ?? defaultSpawnLanguageServer)(this.serverKind, this.options.root())
    this.child = child
    child.stdout?.on('data', chunk => this.forwardServerFrame(chunk as Buffer))
    child.stderr?.on('data', chunk => this.sendControl({
      type: 'server-log',
      protocol: 'fh2-lsp',
      stream: 'stderr',
      source: this.serverKind === 'vue' ? 'vue-language-server' : 'typescript-language-server',
      message: chunk.toString('utf8'),
    }))
    child.on('error', (error) => {
      this.sendStatus('failed', error.message)
      void this.close('language-server-error')
    })
    child.on('exit', (code, signal) => {
      if (!this.closedState) this.sendStatus(code === 0 ? 'stopped' : 'failed', `进程退出：code=${String(code)} signal=${String(signal)}`)
      void this.close('language-server-exited')
    })
    if (this.serverKind === 'vue') {
      this.startCompanionTsserver(this.options.root())
    }

    const sessionId = `lsp-${Date.now().toString(36)}`
    const accepted: LspServerHandshake = handshake.type === 'hello'
      ? { type: 'hello-accepted', protocol: 'fh2-lsp', protocolVersion: 1, sessionId, serverKind: this.serverKind }
      : { type: 'resume-accepted', protocol: 'fh2-lsp', protocolVersion: 1, sessionId }
    this.sendJson(accepted)
    this.sendStatus('running')
    // P1 不做事件回放：resume 也重新 didOpen（由客户端负责）。
    for (const buffered of this.buffered) this.child.stdin?.write(this.prepareClientFrame(buffered))
    this.buffered = []
  }

  /**
   * vue server → 客户端：缓冲重组完整帧；`tsserver/request` 转给附带 tsserver，
   * 其余按原帧透传。帧可能跨 chunk 分裂，不缓冲会导致拦截失效（部分帧直通）。
   */
  private forwardServerFrame (chunk: Buffer): void {
    if (this.closedState) return
    this.vueOut += chunk.toString('utf8')
    for (;;) {
      const headerEnd = this.vueOut.indexOf('\r\n\r\n')
      if (headerEnd === -1) break
      const match = /Content-Length:\s*(\d+)/.exec(this.vueOut.slice(0, headerEnd))
      if (match === null) {
        // 非协议数据（如 stderr 混流）：丢弃头部继续。
        this.vueOut = this.vueOut.slice(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      if (this.vueOut.length < headerEnd + 4 + length) break
      const frameText = this.vueOut.slice(0, headerEnd + 4 + length)
      this.vueOut = this.vueOut.slice(headerEnd + 4 + length)
      if (this.tsChild === null) {
        this.ws.send(Buffer.from(frameText, 'utf8'))
        continue
      }
      let intercepted = false
      try {
        const frame = JSON.parse(frameText.slice(headerEnd + 4)) as { method?: string; params?: unknown }
        if (frame.method === 'tsserver/request' && Array.isArray(frame.params)) {
          // @vue/language-server 源码把 [requestId, command, args] 作为单个通知参数，
          // vscode-jsonrpc 在线上会编码为 [[...]]。同时容忍扁平形态，方便协议探针。
          const request = Array.isArray(frame.params[0]) ? frame.params[0] : frame.params
          if (typeof request[0] !== 'number' || typeof request[1] !== 'string') {
            this.ws.send(Buffer.from(frameText, 'utf8'))
            continue
          }
          const [requestId, command, args] = request as [number, string, unknown]
          this.tsSeq += 1
          const seq = this.tsSeq
          this.tsPending.set(seq, { kind: 'volar', requestId, command })
          if (process.env.FH2_LSP_TRACE === '1') this.sendCompanionLog(`请求 ${command} (seq=${seq})`)
          if (command === '_vue:projectInfo') this.sendCompanionLog('正在识别 Vue 所属 TypeScript 项目…')
          this.tsChild.stdin?.write(`${JSON.stringify({ seq, type: 'request', command, ...(args === undefined ? {} : { arguments: args }) })}\n`)
          intercepted = true
        }
      } catch {
        // 解析失败按原帧透传
      }
      if (!intercepted) this.ws.send(Buffer.from(frameText, 'utf8'))
    }
  }

  /**
   * companion tsserver 的 Diag 事件 → LSP `textDocument/publishDiagnostics`。
   * 事件坐标已是 .vue 源坐标（插件 proxy 完成虚拟→源映射），1-based line/offset 转 LSP 0-based。
   * 三类事件按文件累积合并后整体发布（每次发布替换该文件的完整诊断集）。
   */
  private publishCompanionDiagnostics (event: 'syntaxDiag' | 'semanticDiag' | 'suggestionDiag', body: { file?: string; diagnostics?: unknown[] } | undefined): void {
    if (this.closedState || this.child === null) return
    const file = body?.file
    if (typeof file !== 'string' || file === '') return
    const kind = event === 'syntaxDiag' ? 'syntax' : event === 'semanticDiag' ? 'semantic' : 'suggestion'
    const entry = this.diagByFile.get(file) ?? { syntax: [], semantic: [], suggestion: [] }
    entry[kind] = Array.isArray(body?.diagnostics) ? body!.diagnostics! : []
    this.diagByFile.set(file, entry)

    const lspDiagnostics = [...entry.syntax, ...entry.semantic, ...entry.suggestion]
      .map(item => companionDiagnosticToLsp(item))
      .filter((item): item is NonNullable<ReturnType<typeof companionDiagnosticToLsp>> => item !== null)
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: pathToFileUri(file), diagnostics: lspDiagnostics },
    })
    // 语义诊断发往客户端（不是 vue server：它是请求/响应的对端，不是通知信宿）。
    this.ws.send(Buffer.from(`Content-Length: ${Buffer.byteLength(notification)}\r\n\r\n${notification}`, 'utf8'))
  }

  /** 启动附带 tsserver（全局插件 @vue/typescript-plugin）并 open 锚点文件引导项目加载。 */
  private startCompanionTsserver (root: string): void {
    const require = createRequire(import.meta.url)
    const tsserverJs = require.resolve('typescript/lib/tsserver.js')
    const pluginPkg = require.resolve('@vue/typescript-plugin/package.json')
    const probe = resolvePluginProbeLocation(dirname(pluginPkg))
    const child = spawn(
      process.execPath,
      [tsserverJs, '--globalPlugins', '@vue/typescript-plugin', '--pluginProbeLocations', probe],
      { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    this.tsChild = child
    child.stdout?.on('data', chunk => this.consumeTsFrame(chunk as Buffer))
    child.stderr?.on('data', chunk => this.sendControl({
      type: 'server-log',
      protocol: 'fh2-lsp',
      stream: 'stderr',
      source: 'companion-tsserver',
      message: chunk.toString('utf8'),
    }))
    child.on('exit', () => {
      this.tsChild = null
    })
    // 锚点：open 根 tsconfig（或首个存在的工作区文件）触发项目加载 → 插件注册 _vue:* 命令。
    for (const anchor of companionAnchors(root)) {
      this.tsCommand('open', { file: anchor })
    }
  }

  /** 消费 tsserver stdout（Content-Length 帧）：response → `tsserver/response` 回 vue server。 */
  private consumeTsFrame (chunk: Buffer): void {
    if (this.closedState || this.child === null) return
    this.tsOut += chunk.toString('utf8')
    for (;;) {
      const index = this.tsOut.indexOf('\r\n\r\n')
      if (index === -1) break
      const match = /Content-Length:\s*(\d+)/.exec(this.tsOut.slice(0, index))
      if (match === null) {
        this.tsOut = this.tsOut.slice(index + 4)
        continue
      }
      const length = Number(match[1])
      if (this.tsOut.length < index + 4 + length) break
      const body = this.tsOut.slice(index + 4, index + 4 + length)
      this.tsOut = this.tsOut.slice(index + 4 + length)
      try {
        const message = JSON.parse(body) as {
          type?: string;
          event?: string;
          request_seq?: number;
          success?: boolean;
          body?: unknown;
        }
        if (message.type === 'response' && typeof message.request_seq === 'number' && this.tsPending.has(message.request_seq)) {
          const pending = this.tsPending.get(message.request_seq)!
          this.tsPending.delete(message.request_seq)
          const command = pending.kind === 'volar' ? pending.command : pending.method
          if (process.env.FH2_LSP_TRACE === '1') this.sendCompanionLog(`响应 ${command} (seq=${message.request_seq}, success=${String(message.success)})`)
          if (pending.kind === 'lsp') {
            this.sendLsp({
              jsonrpc: '2.0',
              id: pending.requestId,
              result: message.success === true ? companionResponseToLsp(pending.method, message.body, pending.newName) : null,
            })
            continue
          }
          if (pending.command === '_vue:projectInfo') {
            this.sendCompanionLog(message.success === true
              ? 'Vue TypeScript 项目已就绪。'
              : `Vue TypeScript 项目识别失败：${String((message as { message?: unknown }).message ?? '未知错误')}`)
          }
          // sendNotification(name, value) 的 value 是一个数组；线上 params 需保留单参数嵌套。
          const params = [[pending.requestId, message.success === true ? message.body : undefined]]
          const responseBody = JSON.stringify({ jsonrpc: '2.0', method: 'tsserver/response', params })
          this.child.stdin?.write(`Content-Length: ${Buffer.byteLength(responseBody)}\r\n\r\n${responseBody}`)
          continue
        }
        if (message.type === 'event'
          && (message.event === 'syntaxDiag' || message.event === 'semanticDiag' || message.event === 'suggestionDiag')) {
          this.publishCompanionDiagnostics(message.event, message.body as { file?: string; diagnostics?: unknown[] } | undefined)
        }
      } catch {
        // 忽略其余事件
      }
    }
  }

  private sendJson (payload: unknown): void {
    // 控制帧用 WebSocket text frame，与二进制 Content-Length JSON-RPC 帧明确分离。
    this.ws.send(JSON.stringify(payload))
  }

  private sendLsp (payload: unknown): void {
    if (this.closedState || this.ws.readyState !== this.ws.OPEN) return
    const body = JSON.stringify(payload)
    this.ws.send(Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, 'utf8'))
  }

  private sendControl (payload: LspServerControlMessage): void {
    if (!this.closedState && this.ws.readyState === this.ws.OPEN) this.sendJson(payload)
  }

  private sendCompanionLog (message: string): void {
    this.sendControl({ type: 'server-log', protocol: 'fh2-lsp', stream: 'stderr', source: 'companion-tsserver', message })
  }

  private sendStatus (status: 'starting' | 'running' | 'stopped' | 'failed', message?: string): void {
    this.sendControl({
      type: 'server-status',
      protocol: 'fh2-lsp',
      status,
      serverKind: this.serverKind,
      ...(message === undefined ? {} : { message }),
    })
  }

  private rejectAndClose (reason: string, message: string): void {
    if (this.closedState) return
    this.sendJson({ type: 'rejected', protocol: 'fh2-lsp', reason, message })
    void this.close(`rejected:${reason}`)
  }

  async close (reason: string): Promise<void> {
    if (this.closedState) return
    this.closedState = true
    const child = this.child
    this.child = null
    const tsChild = this.tsChild
    this.tsChild = null
    if (tsChild !== null && tsChild.exitCode === null) {
      tsChild.kill('SIGTERM')
      const tsKillTimer = setTimeout(() => tsChild.kill('SIGKILL'), 3000)
      tsKillTimer.unref?.()
    }
    if (child !== null && child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 3000)
        timer.unref?.()
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    try {
      this.ws.close()
    } catch {
      // 已关闭
    }
    this.closedResolve(reason)
  }
}

function defaultSpawnLanguageServer (kind: LspServerKind, root: string): ChildProcess {
  const require = createRequire(import.meta.url)
  const cli = kind === 'vue'
    ? require.resolve('@vue/language-server/bin/vue-language-server.js')
    : require.resolve('typescript-language-server/lib/cli.mjs')
  return spawn(process.execPath, [cli, '--stdio'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
}

/** Volar initialize 注入用的 TypeScript SDK 目录（随包依赖解析）。 */
function resolveTypeScriptTsdk (): string {
  const require = createRequire(import.meta.url)
  const typescriptJs = require.resolve('typescript/lib/typescript.js')
  return dirname(typescriptJs)
}

/** 解析单个 Content-Length JSON-RPC 帧（客户端每条 ws 消息恰为一帧）。 */
function parseFrame (data: Buffer): { jsonrpc: string; id?: unknown; method?: string; params?: unknown } | null {
  const text = data.toString('utf8')
  const headerEnd = text.indexOf('\r\n\r\n')
  if (headerEnd === -1) return null
  try {
    const parsed: unknown = JSON.parse(text.slice(headerEnd + 4))
    return typeof parsed === 'object' && parsed !== null
      ? parsed as { jsonrpc: string; id?: unknown; method?: string; params?: unknown }
      : null
  } catch {
    return null
  }
}

function serializeFrame (frame: { jsonrpc: string; id?: unknown; method?: string; params?: unknown }): Buffer {
  const body = JSON.stringify(frame)
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, 'utf8')
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从插件包位置向上找一个 node_modules 内含该插件的目录（tsserver pluginProbeLocations）。 */
function resolvePluginProbeLocation (pluginDir: string): string {
  let current = pluginDir
  for (;;) {
    if (existsSync(join(current, 'node_modules', '@vue', 'typescript-plugin'))) return current
    const parent = dirname(current)
    if (parent === current) return pluginDir
    current = parent
  }
}

/** tsserver Diag（1-based line/offset）→ LSP Diagnostic（0-based，severity 映射）。 */
function companionDiagnosticToLsp (value: unknown): {
  readonly range: { readonly start: { readonly line: number; readonly character: number }; readonly end: { readonly line: number; readonly character: number } };
  readonly severity: number;
  readonly code: number;
  readonly message: string;
  readonly source: string;
} | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as {
    start?: { line?: number; offset?: number };
    end?: { line?: number; offset?: number };
    text?: string;
    code?: number;
    category?: string;
  }
  if (typeof record.start?.line !== 'number' || typeof record.start.offset !== 'number') return null
  if (typeof record.end?.line !== 'number' || typeof record.end.offset !== 'number') return null
  if (typeof record.text !== 'string') return null
  // tsserver category：error / warning / suggestion；suggestion 归 info（LSP severity 3）。
  const severity = record.category === 'error' ? 1 : record.category === 'warning' ? 2 : 3
  return {
    range: {
      start: { line: record.start.line - 1, character: record.start.offset - 1 },
      end: { line: record.end.line - 1, character: record.end.offset - 1 },
    },
    severity,
    code: typeof record.code === 'number' ? record.code : 0,
    message: record.text,
    source: 'ts',
  }
}

/** 本地路径 → 标准 file:// URI（node:url 处理盘符、空格与非 ASCII 的编码）。导出供单测。 */
export function pathToFileUri (file: string): string {
  return pathToFileURL(file).href
}

/** file:// URI → 本地路径；非 file URI 或非法 URI 返回 undefined（调用方跳过或返回空结果）。 */
export function fileUriToPath (uri: string): string | undefined {
  if (!uri.startsWith('file:')) return undefined
  try {
    return fileURLToPath(uri)
  } catch {
    return undefined
  }
}

function isCompanionSemanticMethod (method: string | undefined): boolean {
  return method === 'textDocument/completion'
    || method === 'textDocument/hover'
    || method === 'textDocument/definition'
    || method === 'textDocument/references'
    || method === 'textDocument/rename'
}

function companionCommand (method: string): string | null {
  if (method === 'textDocument/completion') return 'completionInfo'
  if (method === 'textDocument/hover') return 'quickinfo'
  if (method === 'textDocument/definition') return 'definitionAndBoundSpan'
  if (method === 'textDocument/references') return 'references'
  if (method === 'textDocument/rename') return 'rename'
  return null
}

interface TsPosition {
  readonly line: number;
  readonly offset: number;
}
interface TsSpan {
  readonly start: TsPosition;
  readonly end: TsPosition;
}

function lspRange (span: TsSpan): { readonly start: { readonly line: number; readonly character: number };readonly end: { readonly line: number; readonly character: number } } {
  return {
    start: { line: span.start.line - 1, character: span.start.offset - 1 },
    end: { line: span.end.line - 1, character: span.end.offset - 1 },
  }
}

export function companionResponseToLsp (method: string, body: unknown, newName?: string): unknown {
  if (body === undefined || body === null) return null
  if (method === 'textDocument/completion') {
    const result = body as { isIncomplete?: boolean;entries?: readonly Record<string, unknown>[] }
    return {
      isIncomplete: result.isIncomplete === true,
      items: (result.entries ?? []).flatMap((entry) => {
        if (typeof entry.name !== 'string') return []
        const span = isTsSpan(entry.replacementSpan) ? entry.replacementSpan : undefined
        return [{
          label: entry.name,
          kind: tsCompletionKind(typeof entry.kind === 'string' ? entry.kind : ''),
          ...(typeof entry.sortText === 'string' ? { sortText: entry.sortText } : {}),
          ...(typeof entry.insertText === 'string' ? { insertText: entry.insertText } : {}),
          ...(span === undefined ? {} : { textEdit: { range: lspRange(span), newText: typeof entry.insertText === 'string' ? entry.insertText : entry.name } }),
        }]
      }),
    }
  }
  if (method === 'textDocument/hover') {
    const result = body as { displayString?: unknown;documentation?: unknown;start?: TsPosition;end?: TsPosition }
    const parts = [typeof result.displayString === 'string' ? `\`\`\`typescript\n${result.displayString}\n\`\`\`` : '', displayParts(result.documentation)].filter(Boolean)
    if (parts.length === 0) return null
    return {
      contents: { kind: 'markdown', value: parts.join('\n\n') },
      ...(result.start !== undefined && result.end !== undefined ? { range: lspRange({ start: result.start, end: result.end }) } : {}),
    }
  }
  if (method === 'textDocument/definition') {
    const result = body as { definitions?: readonly { file?: string;start?: TsPosition;end?: TsPosition }[] }
    return (result.definitions ?? []).flatMap(definition => typeof definition.file === 'string' && definition.start !== undefined && definition.end !== undefined
      ? [{ uri: pathToFileUri(definition.file), range: lspRange({ start: definition.start, end: definition.end }) }]
      : [])
  }
  if (method === 'textDocument/references') {
    const result = body as { refs?: readonly { file?: string;start?: TsPosition;end?: TsPosition }[] }
    return (result.refs ?? []).flatMap(reference => typeof reference.file === 'string' && reference.start !== undefined && reference.end !== undefined
      ? [{ uri: pathToFileUri(reference.file), range: lspRange({ start: reference.start, end: reference.end }) }]
      : [])
  }
  if (method === 'textDocument/rename') {
    const result = body as { info?: { canRename?: boolean };locs?: readonly { file?: string;locs?: readonly TsSpan[] }[] }
    if (result.info?.canRename === false || newName === undefined) return null
    const changes: Record<string, { range: ReturnType<typeof lspRange>;newText: string }[]> = {}
    for (const file of result.locs ?? []) {
      if (typeof file.file !== 'string') continue
      changes[pathToFileUri(file.file)] = (file.locs ?? []).filter(isTsSpan).map(span => ({ range: lspRange(span), newText: newName }))
    }
    return { changes }
  }
  return null
}

function isTsSpan (value: unknown): value is TsSpan {
  if (typeof value !== 'object' || value === null) return false
  const span = value as { start?: Partial<TsPosition>;end?: Partial<TsPosition> }
  return typeof span.start?.line === 'number' && typeof span.start.offset === 'number'
    && typeof span.end?.line === 'number' && typeof span.end.offset === 'number'
}

function displayParts (value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(part => typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
    ? (part as { text: string }).text
    : '').join('')
}

function tsCompletionKind (kind: string): number {
  if (kind === 'method') return 2
  if (kind === 'function') return 3
  if (kind === 'constructor') return 4
  if (kind === 'property' || kind === 'getter' || kind === 'setter') return 10
  if (kind === 'class') return 7
  if (kind === 'interface') return 8
  if (kind === 'module') return 9
  if (kind === 'enum') return 13
  if (kind === 'keyword') return 14
  if (kind === 'const') return 21
  return 6
}

/**
 * 附带 tsserver 的项目加载锚点：根 tsconfig 优先；没有 tsconfig 时用第一个源文件
 * （tsconfig include 的 .vue 不进 tsserver 的 fileNames，需要 .ts/.js 锚点或 json open 引导）。
 */
function companionAnchors (root: string): string[] {
  const anchors: string[] = []
  const tsconfig = join(root, 'tsconfig.json')
  if (existsSync(tsconfig)) anchors.push(tsconfig)
  const sourceAnchor = findFirstSourceFile(root)
  if (sourceAnchor !== null) anchors.push(sourceAnchor)
  return anchors
}

function findFirstSourceFile (directory: string, depth = 0): string | null {
  if (depth > 4) return null
  let entries: readonly string[]
  try {
    entries = [...readdirSync(directory)].sort()
  } catch {
    return null
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.fh2' || name.startsWith('.')) continue
    const path = join(directory, name)
    if (/\.(ts|mts|cts|js|mjs|cjs|vue)$/.test(name)) return path
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.fh2' || name.startsWith('.')) continue
    const path = join(directory, name)
    if (isDirectorySync(path)) {
      const found = findFirstSourceFile(path, depth + 1)
      if (found !== null) return found
    }
  }
  return null
}

function isDirectorySync (path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function tokenEquals (received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received, 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')
  if (receivedBuffer.byteLength !== expectedBuffer.byteLength) return false
  return timingSafeEqual(receivedBuffer, expectedBuffer)
}
