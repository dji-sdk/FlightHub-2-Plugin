// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { watch as watchFiles } from 'chokidar'
import type { FSWatcher } from 'chokidar'
import type { DevExecutorOptions } from '../services/tasks/executors/dev.js'
import { IdeSessionService } from '../services/ide/session.js'
import { revealWorkspaceEntry, workspacePathInfo } from '../services/ide/system-files.js'
import { TOOLCHAIN_VERSION } from '../manifest.js'
import { CONTEXT_PRECEDENCE, PROJECT_PATHS } from '../project-policy.js'
import { closeRequestAfterResponse } from '../dev/http-lifecycle.js'
import { resolveIdeActionsWithKnowledge } from '../workflow/service/actions.js'
import type { IdeActionsData, ResolveIdeActionsOptions } from '../workflow/service/catalog.js'
import { describeWorkspace, resolveOpenWorkspaceRoot, runIdeBuild, runIdeValidate } from '../services/ide/project.js'
import type { CapabilityBridgeOptions } from '../services/ide/project.js'
import { IdeLspBridge } from '../services/ide/language-service/server.js'
import { resolveIdeSchemas } from '../services/ide/schemas.js'
import type { ResolveIdeSchemasOptions } from '../services/ide/schemas.js'
import { IDE_ERROR_STATUS, IdeRequestError, ideFailure, ideSuccess } from '../contracts/ide.js'
import type {
  IdeErrorCode,
  IdeFsEvent,
  IdeRecentRoot,
  IdeRunEvent,
  IdeRunLogEvent,
  IdeSchemasData,
  IdeWorkspaceData,
  IdeWorkspaceEvent,
} from '../contracts/ide.js'
import {
  IdeFileConflictError,
  MAX_TREE_DEPTH,
  MAX_WRITE_BYTES,
  copyWorkspaceEntry,
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  isIgnoredTreeEntry,
  readTreeChildren,
  readWorkspaceFile,
  readWorkspaceTree,
  renameWorkspaceEntry,
  writeWorkspaceFile,
} from '../services/ide/files.js'
import type { RouteContext, RouteTable } from './routes/index.js'
import { knowledgeRoutes, routeKey, workflowRoutes } from './routes/index.js'
import { IdeTaskBridge } from './task-bridge.js'
import { IdeRunManager } from './run-manager.js'

/** 与 dev/static-server.ts 保持同一张表：Web IDE 产物用到的类型是它的子集。 */
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

const TOKEN_HEADER = 'x-fh2-ide-token'
/** F5：写请求携带工作区会话 id；迟到（切换后）写入被拒绝。 */
const SESSION_HEADER = 'x-fh2-ide-session'
/** 允许访问本机 IDE 的回环主机名；DNS Rebinding 的恶意域名不在其中。 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])
const API_PREFIX = '/api/'
const EVENTS_PATH = '/api/events'
/** 契约 2.8：ping 每 30s 一次保活。 */
const SSE_PING_INTERVAL_MS = 30_000
/** PUT /api/file 的请求体上限，留一点 JSON 包裹的余量。 */
const MAX_BODY_BYTES = MAX_WRITE_BYTES + 64 * 1024
/** chokidar 事件合流窗口：保存一次文件常触发多个 raw 事件。 */
const WATCH_DEBOUNCE_MS = 50
/** 契约 7.2：最近工作根只在进程内维护，留最近这么多条。 */
const MAX_RECENT_ROOTS = 10

export interface IdeServer {
  readonly url: string;
  readonly token: string;
  readonly port: number;
  /** 当前工作根。契约 7.1 允许运行期切换，所以这是个取值而不是常量。 */
  readonly root: string;
  close(): Promise<void>;
}

export interface IdeServerOptions {
  /** 初始工作根：所有 path 参数相对它解析，可经 `POST /api/workspace/open` 切换。 */
  readonly root: string;
  /** Web IDE 构建产物目录（含 index.html）。 */
  readonly webRoot: string;
  /** 0 = 让内核分配随机空闲端口。 */
  readonly port: number;
  readonly token?: string;
  readonly toolchainVersion?: string;
  readonly bridge?: Omit<CapabilityBridgeOptions, 'root' | 'toolchainVersion'>;
  readonly resolveSchemas?: (options?: ResolveIdeSchemasOptions) => IdeSchemasData;
  /**
   * 注入 `GET /api/actions` 的词表解析，仅测试使用。
   * 允许回 Promise：默认实现要读项目知识锁（异步），注入的桩可以是同步的。
   */
  readonly resolveActions?: (options: ResolveIdeActionsOptions) => IdeActionsData | Promise<IdeActionsData>;
  /** 注入任务桥（含 TaskService/executor），仅测试使用。 */
  readonly taskBridge?: IdeTaskBridge;
  /** 注入 LSP 子进程 spawn（测试），kind 由桥的 resolveLspServerKind 决定。 */
  readonly lspSpawnServer?: import('../services/ide/language-service/server.js').LspBridgeOptions['spawnServer'];
  /** 关闭文件监听，仅测试使用（避免 watcher 拖住进程）。 */
  readonly watch?: boolean;
  /** 注入运行进程的 spawn 与 CLI 入口，仅测试使用。 */
  readonly run?: DevExecutorOptions;
}

export class IdeAssetsMissingError extends Error {
  readonly code = 'FH2_IDE_ASSETS_MISSING'

  constructor (message: string) {
    super(message)
    this.name = 'IdeAssetsMissingError'
  }
}

export async function startIdeServer (options: IdeServerOptions): Promise<IdeServer> {
  const webRoot = resolve(options.webRoot)
  assertWebAssets(webRoot)
  // 32 字节 hex，契约 0 节要求。每次 serve 启动重新生成，不落盘。
  const token = options.token ?? randomBytes(32).toString('hex')
  const toolchainVersion = options.toolchainVersion ?? TOOLCHAIN_VERSION
  const resolveSchemas = options.resolveSchemas ?? resolveIdeSchemas
  const resolveActions = options.resolveActions ?? resolveIdeActionsWithKnowledge

  /**
   * 已模块化的路由表（计划 §C3）。装配一次，请求期只查表。
   * ⓘ `resolveSchemas` / `resolveActions` 的注入点仍在 options 上（测试要桩），
   *   故表里那两条在被注入时由下面的 override 接管。
   */
  const moduleRoutes: RouteTable = {
    ...knowledgeRoutes(),
    ...workflowRoutes(),
    ...(options.resolveSchemas === undefined
      ? {}
      : { [routeKey('GET', '/api/schemas')]: (context: RouteContext) => resolveSchemas({ root: context.root }) }),
    ...(options.resolveActions === undefined
      ? {}
      : {
          [routeKey('GET', '/api/actions')]: async (context: RouteContext) => {
            const path = context.query.get('path')
            return await resolveActions({ root: context.root, ...(path === null ? {} : { workflowPath: path }) })
          },
        }),
  }

  const sessions = new IdeSessionService(options.root)
  const root = (): string => sessions.snapshot().root
  const sessionId = (): string => sessions.snapshot().id
  const bridge = (): CapabilityBridgeOptions => ({ ...options.bridge, root: root(), toolchainVersion, sessionId: sessionId() })
  const recentRoots: IdeRecentRoot[] = []

  const sseClients = new Set<ServerResponse>()
  let watcher: FSWatcher | undefined
  let pingTimer: NodeJS.Timeout | undefined
  let closePromise: Promise<void> | undefined

  const broadcast = (event: string, data: unknown): void => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of [...sseClients]) {
      try {
        client.write(payload)
      } catch {
        sseClients.delete(client)
      }
    }
  }

  const taskBridge = options.taskBridge ?? new IdeTaskBridge({}, options.run)
  taskBridge.setSession(sessionId())
  taskBridge.subscribe(event => broadcast('task', event))
  const runManager = new IdeRunManager({
    tasks: taskBridge,
    resolveRoot: root,
    onEvent: (event: IdeRunEvent) => broadcast('run', event),
    onLog: (event: IdeRunLogEvent) => broadcast('run-log', { ...event, workspaceSessionId: sessionId() }),
  })

  // L1/L2 + Volar：LSP WebSocket 桥（握手鉴权 + workspaceSessionId；切根后旧连接被拒）。
  const lspBridge = new IdeLspBridge({ token, sessionId, root, ...(options.lspSpawnServer === undefined ? {} : { spawnServer: options.lspSpawnServer }) })

  const rememberRecentRoot = (workspace: IdeWorkspaceData): void => {
    const index = recentRoots.findIndex(entry => entry.root === workspace.root)
    if (index >= 0) recentRoots.splice(index, 1)
    recentRoots.unshift({ root: workspace.root, name: workspace.name, kind: workspace.kind })
    if (recentRoots.length > MAX_RECENT_ROOTS) recentRoots.length = MAX_RECENT_ROOTS
  }

  /**
   * 契约 7.1 + F5：替换工作区。串行编排：拦新写入 → 等待已受理写入完成 →
   * 停止本 session 任务 → 关闭旧 watcher → 发布新 root/session。
   */
  const openWorkspace = async (rawRoot: unknown): Promise<IdeWorkspaceData> => {
    const nextRoot = resolveOpenWorkspaceRoot(bridge(), rawRoot)
    await sessions.switchRoot(nextRoot, async () => {
      await runManager.stopAll()
      await taskBridge.stopAll()
      await watcher?.close()
      watcher = undefined
      await lspBridge.closeConnections()
      if (options.watch !== false) watcher = createWorkspaceWatcher(nextRoot, broadcast)
    })
    taskBridge.setSession(sessionId())
    const workspace = describeWorkspace(bridge())
    rememberRecentRoot(workspace)
    broadcast('workspace', {
      schemaVersion: 1,
      root: workspace.root,
      name: workspace.name,
      kind: workspace.kind,
    } satisfies IdeWorkspaceEvent)
    return workspace
  }

  const handleApi = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> => {
    const method = req.method ?? 'GET'
    const pathname = url.pathname
    // F5：请求处理开始即捕获 root，不在 await 之后改用全局当前 root。
    const requestSession = sessions.snapshot()
    const requestRoot = requestSession.root
    const withWriteGuard = <T>(operation: () => Promise<T>): Promise<T> => {
      const supplied = singleHeader(req.headers[SESSION_HEADER])
      if (supplied !== undefined) sessions.assertCurrent(supplied)
      return sessions.accept(requestSession.id, operation)
    }

    /**
     * 表驱动分发（计划 §C3）：已搬出成模块的那几组先走这里。
     *
     * ★ 放在 if 链**之前**：搬迁是逐步的，表里有的以表为准，剩下的继续走下面的链。
     *   反过来（表在后）会让搬出来的模块永远不被命中 —— 那才是真正的死代码。
     *
     * ⚠️ body 只在有请求体的方法上读：对 GET 调 readJsonBody 会把请求挂住。
     */
    const handler = moduleRoutes[routeKey(method, pathname)]
    if (handler !== undefined) {
      const routeContext: RouteContext = {
        root: requestRoot,
        query: url.searchParams,
        body: method === 'GET' || method === 'HEAD' ? {} : await readJsonBody(req),
        withWriteGuard,
      }
      sendJson(res, 200, ideSuccess(await handler(routeContext)))
      return
    }

    if (pathname === '/api/workspace' && method === 'GET') {
      sendJson(res, 200, ideSuccess(describeWorkspace(bridge())))
      return
    }
    if (pathname === '/api/tree' && method === 'GET') {
      sendJson(res, 200, ideSuccess(await readWorkspaceTree({ root: requestRoot })))
      return
    }
    // 生成目录（node_modules/dist）等目录的惰性单层子树
    if (pathname === '/api/tree/children' && method === 'GET') {
      sendJson(res, 200, ideSuccess(await readTreeChildren(requestRoot, url.searchParams.get('path') ?? undefined)))
      return
    }
    if (pathname === '/api/file' && method === 'GET') {
      sendJson(res, 200, ideSuccess(await readWorkspaceFile(requestRoot, url.searchParams.get('path') ?? undefined)))
      return
    }
    if (pathname === '/api/file' && method === 'PUT') {
      // F2/F5：写入走会话校验 + expectedRevision + 同路径串行区。
      const body = await readJsonBody(req)
      sendJson(res, 200, ideSuccess(await withWriteGuard(() =>
        writeWorkspaceFile(requestRoot, body.path, body.content, { expectedRevision: body.expectedRevision }))))
      return
    }
    if (pathname === '/api/validate' && method === 'POST') {
      const body = await readJsonBody(req)
      sendJson(res, 200, ideSuccess(await runIdeValidate({ ...bridge(), root: requestRoot }, body.path)))
      return
    }
    if (pathname === '/api/build' && method === 'POST') {
      await readJsonBody(req)
      sendJson(res, 200, ideSuccess(await withWriteGuard(() => runIdeBuild({ ...bridge(), root: requestRoot }))))
      return
    }

    // 契约 6：文件管理（F5：均经会话校验与写入守卫）。
    if (pathname === '/api/fs/path' && method === 'GET') {
      const supplied = singleHeader(req.headers[SESSION_HEADER])
      if (supplied !== undefined) sessions.assertCurrent(supplied)
      sendJson(res, 200, ideSuccess(workspacePathInfo(requestRoot, url.searchParams.get('path') ?? undefined)))
      return
    }
    if (pathname === '/api/fs/reveal' && method === 'POST') {
      const body = await readJsonBody(req)
      sendJson(res, 200, ideSuccess(await withWriteGuard(() => revealWorkspaceEntry(requestRoot, body.path))))
      return
    }
    if (pathname === '/api/fs/create' && method === 'POST') {
      const body = await readJsonBody(req)
      sendJson(res, 200, ideSuccess(await withWriteGuard(() =>
        createWorkspaceEntry(requestRoot, body.path, body.kind, body.content))))
      return
    }
    if (pathname === '/api/fs/delete' && method === 'POST') {
      const body = await readJsonBody(req)
      sendJson(res, 200, ideSuccess(await withWriteGuard(() =>
        deleteWorkspaceEntry(requestRoot, body.path, body.recursive))))
      return
    }
    if (pathname === '/api/fs/rename' && method === 'POST') {
      const body = await readJsonBody(req)
      sendJson(res, 200, ideSuccess(await withWriteGuard(() =>
        renameWorkspaceEntry(requestRoot, body.from, body.to, body.overwrite))))
      return
    }
    if (pathname === '/api/fs/copy' && method === 'POST') {
      const body = await readJsonBody(req)
      sendJson(res, 200, ideSuccess(await withWriteGuard(() =>
        copyWorkspaceEntry(requestRoot, body.from, body.to))))
      return
    }

    // 契约 7：工作区切换。
    if (pathname === '/api/workspace/open' && method === 'POST') {
      const body = await readJsonBody(req)
      sessions.assertCurrent(requestSession.id)
      sendJson(res, 200, ideSuccess(await openWorkspace(body.root)))
      return
    }
    if (pathname === '/api/workspace/recent' && method === 'GET') {
      sendJson(res, 200, ideSuccess({ roots: [...recentRoots] }))
      return
    }

    // 契约 8：运行 / 预览。
    if (pathname === '/api/run/targets' && method === 'GET') {
      sendJson(res, 200, ideSuccess(runManager.targets()))
      return
    }
    if (pathname === '/api/run/logs' && method === 'GET') {
      const rawMode = url.searchParams.get('mode')
      if (rawMode !== null && rawMode !== 'dev' && rawMode !== 'preview') {
        throw new IdeRequestError('FH2_IDE_BAD_REQUEST', `未知运行模式：${rawMode}。Unknown run mode.`)
      }
      sendJson(res, 200, ideSuccess(runManager.logs(rawMode ?? undefined)))
      return
    }
    if (pathname === '/api/run/start' && method === 'POST') {
      const body = await readJsonBody(req)
      sendJson(res, 200, ideSuccess(await withWriteGuard(() => runManager.start(body))))
      return
    }
    if (pathname === '/api/run/stop' && method === 'POST') {
      const body = await readJsonBody(req)
      sendJson(res, 200, ideSuccess(await withWriteGuard(() => runManager.stop(body))))
      return
    }
    if (pathname === '/api/run/status' && method === 'GET') {
      sendJson(res, 200, ideSuccess(runManager.status()))
      return
    }

    // U1/U2/U3：任务通道（Build/Pack）。root 在请求处理开始时捕获。
    // params 透传给 executor（契约 TaskRequest.params：值只允许 string|number|boolean）。
    if (pathname === '/api/tasks' && method === 'POST') {
      const body = await readJsonBody(req)
      sendJson(res, 200, ideSuccess(await withWriteGuard(() => taskBridge.start(requestRoot, body.kind, sanitizeTaskParams(body.params)))))
      return
    }
    // N3：Start Center 的创建入口（同步生成 + 可选 install 任务）；成功后前端再显式 Open。
    if (pathname === '/api/workspace/create' && method === 'POST') {
      const body = await readJsonBody(req)
      sendJson(res, 200, ideSuccess(await withWriteGuard(() => taskBridge.create(requestRoot, body))))
      return
    }
    // S8：工作流语义校验的服务入口（IDE 画布同步消费同一 Core 实现；此处供 CLI/MCP/外部用）。
    if (pathname === '/api/tasks' && method === 'GET') {
      sendJson(res, 200, ideSuccess({ tasks: taskBridge.list() }))
      return
    }
    const taskMatch = /^\/api\/tasks\/([^/]+)(?:\/(logs|cancel|artifacts\/[^/]+))?$/.exec(pathname)
    if (taskMatch !== null) {
      const taskId = decodeURIComponent(taskMatch[1] ?? '')
      const action = taskMatch[2]
      if (action === undefined && method === 'GET') {
        sendJson(res, 200, ideSuccess(taskBridge.get(taskId)))
        return
      }
      if (action === 'cancel' && method === 'POST') {
        sendJson(res, 200, ideSuccess(await withWriteGuard(() => taskBridge.cancel(taskId))))
        return
      }
      if (action === 'logs' && method === 'GET') {
        sendJson(res, 200, ideSuccess({ lines: taskBridge.logs(taskId) }))
        return
      }
      if (action !== undefined && action.startsWith('artifacts/') && method === 'GET') {
        // U3：经鉴权的产物下载（digest 校验在 bridge 内完成）。
        const artifactId = decodeURIComponent(action.slice('artifacts/'.length))
        const { bytes, fileName } = taskBridge.readArtifact(requestRoot, taskId, artifactId)
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': String(bytes.byteLength),
          'content-disposition': `attachment; filename="${fileName}"`,
          'cache-control': 'no-store',
        })
        res.end(bytes)
        return
      }
    }

    throw new IdeRequestError(
      'FH2_IDE_NOT_FOUND',
      `未知接口：${method} ${pathname}。Unknown endpoint: ${method} ${pathname}.`,
    )
  }

  // DNS Rebinding 防护：只接受本机回环 Host，且端口必须是本次监听的端口。
  let expectedPort = options.port
  const isAllowedHost = (req: IncomingMessage): boolean => {
    const raw = req.headers.host
    if (typeof raw !== 'string' || raw.length === 0) return false
    let parsed: URL
    try {
      parsed = new URL(`http://${raw}`)
    } catch {
      return false
    }
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return false
    const port = parsed.port || (parsed.protocol === 'http:' ? '80' : '443')
    return port === String(expectedPort)
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // DNS Rebinding 防护：只接受本机回环 Host，且端口必须是本次监听的端口。
    // 必须在 token 校验与静态资源之前，避免任意 Host 读到注入 token 的 index.html。
    if (!isAllowedHost(req)) {
      sendError(res, 'FH2_IDE_FORBIDDEN_HOST', 'Host 不在允许范围。Unexpected Host header.')
      return
    }
    const url = new URL(req.url ?? '/', 'http://fh2-plugin-ide.local')
    const pathname = url.pathname

    // SSE 走 query token：EventSource 无法设置自定义头（契约 2.8）。
    if (pathname === EVENTS_PATH) {
      if (!isTokenEqual(url.searchParams.get('token'), token)) {
        closeRequestAfterResponse(req, res)
        sendError(res, 'FH2_IDE_UNAUTHORIZED', 'token 缺失或不匹配。Missing or invalid token.')
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      sseClients.add(res)
      req.once('close', () => sseClients.delete(res))
      return
    }

    if (pathname === API_PREFIX.slice(0, -1) || pathname.startsWith(API_PREFIX)) {
      if (!isTokenEqual(singleHeader(req.headers[TOKEN_HEADER]), token)) {
        closeRequestAfterResponse(req, res)
        sendError(res, 'FH2_IDE_UNAUTHORIZED', 'token 缺失或不匹配。Missing or invalid token.')
        return
      }
      try {
        await handleApi(req, res, url)
      } catch (error) {
        if (error instanceof IdeFileConflictError) {
          // F2：冲突回包附带当前磁盘快照，前端据此弹出冲突 UI（Diff/采用磁盘/保留本地/副本）。
          if (res.destroyed || res.writableEnded) return
          sendJson(res, IDE_ERROR_STATUS.FH2_FILE_CONFLICT, ideFailure(
            'FH2_FILE_CONFLICT',
            error.message,
            { code: 'FH2_FILE_CONFLICT', message: error.message, disk: error.disk },
          ))
          return
        }
        if (error instanceof IdeRequestError) {
          sendError(res, error.code, error.message)
          return
        }
        sendError(
          res,
          'FH2_IDE_INTERNAL',
          `内部错误：${errorMessage(error)}。Internal error: ${errorMessage(error)}.`,
        )
      }
      return
    }

    await serveWebAsset(res, webRoot, pathname, token)
  }

  const server = createHttpServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      if (res.destroyed || res.writableEnded) return
      sendError(res, 'FH2_IDE_INTERNAL', '内部错误。Internal error.')
    })
  })
  // WebSocket upgrade：/lsp（LSP 桥）；其它路径拒绝。
  server.on('upgrade', (req, socket, head) => {
    if (!isAllowedHost(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    lspBridge.handleUpgrade(req, socket, head as Buffer)
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'EADDRINUSE') {
        rejectListen(new Error(`端口 ${options.port} 被占用，请释放或用 --port 指定其他端口`))
      } else {
        rejectListen(error)
      }
    }
    server.once('error', onError)
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', onError)
      resolveListen()
    })
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : options.port
  expectedPort = actualPort

  const initialWorkspace = describeWorkspace(bridge())
  if (options.watch !== false) {
    // unknown 根只是 Start Center 的创建起点：这里不监听整个目录，
    // 否则在大目录下会递归扫描全部文件，拖垮 serve 启动。
    if (initialWorkspace.kind !== 'unknown') watcher = createWorkspaceWatcher(root(), broadcast)
    pingTimer = setInterval(() => {
      broadcast('ping', { schemaVersion: 1, ts: Date.now() })
    }, SSE_PING_INTERVAL_MS)
    pingTimer.unref()
  }

  // 初始工作根也记入进程内最近列表（契约 7.2 的 API 仍保留）。
  rememberRecentRoot(initialWorkspace)

  return {
    url: `http://127.0.0.1:${actualPort}`,
    token,
    port: actualPort,
    get root () {
      return root()
    },
    close () {
      if (closePromise !== undefined) return closePromise
      closePromise = (async () => {
        if (pingTimer !== undefined) clearInterval(pingTimer)
        // 子进程与任务先于 HTTP 服务收掉：serve 退出绝不能留下 dev/preview 孤儿或悬挂任务。
        await runManager.stopAll()
        await taskBridge.stopAll()
        await lspBridge.close()
        await watcher?.close()
        for (const client of sseClients) client.end()
        sseClients.clear()
        if (!server.listening) return
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close(error => error === undefined ? resolveClose() : rejectClose(error))
          server.closeAllConnections()
        })
      })()
      return closePromise
    },
  }
}

/** 契约 2.8：监听工作根并把变更合流后广播成 `event: fs`。 */
function createWorkspaceWatcher (root: string, broadcast: (event: string, data: unknown) => void): FSWatcher {
  let pending: NodeJS.Timeout | undefined
  const queued = new Map<string, IdeFsEvent['type']>()
  const flush = (): void => {
    pending = undefined
    for (const [path, type] of queued) broadcast('fs', { schemaVersion: 1, type, path } satisfies IdeFsEvent)
    queued.clear()
  }
  const watcher = watchFiles(root, {
    ignoreInitial: true,
    // 文件树不跟随符号链接：监听也不跟随，避免链接环与大目录外溢。
    followSymlinks: false,
    // 与文件树深度契约一致，避免为不可见的深层目录建立监听。
    depth: MAX_TREE_DEPTH,
    ignored: (path: string) => isWatchIgnored(root, path),
  })
  watcher.on('all', (event, path) => {
    if (!isFsEventType(event)) return
    const relativePath = relative(root, path).replaceAll(sep, '/')
    if (relativePath === '' || relativePath.startsWith('..')) return
    queued.set(relativePath, event)
    if (pending === undefined) pending = setTimeout(flush, WATCH_DEBOUNCE_MS)
  })
  // watcher 报错不应终止 serve：Web IDE 退化成「不推送变更」仍然可用。
  watcher.on('error', () => undefined)
  return watcher
}

/**
 * 定位 Web IDE 构建产物。
 *
 * 与 dev-command.resolveWorkbenchDist 同一套布局假设：monorepo 下在 `../../apps`，
 * 发布包下在包内 `apps/`（由 scripts/copy-web-ide.mjs 复制进来）。
 */
export function resolveWebIdeDist (): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const packageRoots = [resolve(moduleDirectory, '..'), resolve(moduleDirectory, '../..')]
  const packageRoot = packageRoots.find(candidate => existsSync(resolve(candidate, 'package.json'))) ?? packageRoots[0]!
  const appRoots = [resolve(packageRoot, 'apps')]
  const apps = appRoots.find(candidate => existsSync(resolve(candidate, 'fh2-web-ide/dist/index.html'))) ?? appRoots[0]!
  return resolve(apps, 'fh2-web-ide/dist')
}

function assertWebAssets (webRoot: string): void {
  const indexHtml = resolve(webRoot, 'index.html')
  try {
    if (statSync(indexHtml).isFile()) return
  } catch {}
  throw new IdeAssetsMissingError(
    `Web IDE 前端产物缺失：${indexHtml}\n`
    + `请先在仓库根执行 pnpm build:webide，或安装带 apps/fh2-web-ide 的完整发布包。\n`
    + `Web IDE frontend assets are missing: ${indexHtml}`,
  )
}

/** 契约 3：index.html 注入 token 与 base；其余资源原样返回；未命中回落 index.html。 */
async function serveWebAsset (
  res: ServerResponse,
  webRoot: string,
  pathname: string,
  token: string,
): Promise<void> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    sendError(res, 'FH2_IDE_BAD_REQUEST', '请求路径非法。Malformed request path.')
    return
  }

  const file = decoded === '/' ? undefined : resolveWebFile(webRoot, decoded.slice(1))
  if (file === undefined) {
    await sendIndexHtml(res, webRoot, token)
    return
  }
  const mime = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  if (mime === MIME['.html']) {
    await sendIndexHtml(res, file, token, true)
    return
  }
  res.writeHead(200, { 'content-type': mime })
  res.end(await readFile(file))
}

async function sendIndexHtml (
  res: ServerResponse,
  target: string,
  token: string,
  isFile = false,
): Promise<void> {
  const file = isFile ? target : resolve(target, 'index.html')
  const html = await readFile(file, 'utf8')
  res.writeHead(200, { 'content-type': MIME['.html']!, 'cache-control': 'no-store' })
  res.end(injectIdeBootstrap(html, token))
}

/**
 * 把 token 与 base 注入首页。
 *
 * 插在 `</head>` 前，保证在任何 bundle script 之前执行；没有 `</head>` 的极简
 * HTML 则前置，总之不能让前端读不到 token。
 */
export function injectIdeBootstrap (html: string, token: string): string {
  const script = `<script>window.__FH2_IDE_TOKEN__="${token}";window.__FH2_IDE_BASE__="/";</script>`
  if (html.includes('</head>')) return html.replace('</head>', `${script}</head>`)
  return `${script}${html}`
}

function resolveWebFile (webRoot: string, relativePath: string): string | undefined {
  if (relativePath === '') return undefined
  const safe = normalize(relativePath)
  if (isAbsolute(safe) || safe === '..' || safe.startsWith(`..${sep}`)) return undefined
  const normalizedRoot = resolve(webRoot)
  const candidate = resolve(normalizedRoot, safe)
  if (!isContained(normalizedRoot, candidate) || !existsSync(candidate)) return undefined
  try {
    const realRoot = realpathSync(normalizedRoot)
    const realCandidate = realpathSync(candidate)
    if (!statSync(realCandidate).isFile()) return undefined
    if (!isContained(realRoot, realCandidate)) return undefined
    return realCandidate
  } catch {
    return undefined
  }
}

function isContained (root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

/**
 * watcher 不监听的生成目录。Windows 上被监听的子目录会阻止父目录 rename，
 * 导致 build/pack 的候选产物（.dist.fh2-next-*）与 release/ 无法原子提交（EPERM）。
 */
const WATCH_IGNORED_SEGMENTS: ReadonlySet<string> = new Set(['node_modules', PROJECT_PATHS.dist, PROJECT_PATHS.localState, '.pnpm-store'])
const WATCH_TRANSACTION_PREFIX = `.${PROJECT_PATHS.dist}.fh2-`

/** 排除固定生成树及工程根的产物目录，不将源码中的同名目录当成产物。 */
export function isWatchIgnored (root: string, path: string): boolean {
  const resolvedRoot = resolve(root)
  const fromRoot = relative(resolvedRoot, path)
  if (fromRoot === '') return false
  if (fromRoot.startsWith('..')) return true
  const segments = fromRoot.replaceAll('\\', '/').split('/')
  return segments.some((segment, index) => {
    if (isIgnoredTreeEntry(segment, index < segments.length - 1) || WATCH_IGNORED_SEGMENTS.has(segment)) return true
    if (segment !== PROJECT_PATHS.release && !segment.startsWith(WATCH_TRANSACTION_PREFIX)) return false
    const projectRoot = resolve(resolvedRoot, ...segments.slice(0, index))
    // 仅看已有工程标志，不要求清单有效，IDE 必须还能打开并修复损坏工程。
    if (!CONTEXT_PRECEDENCE.some(({ markerFile }) => existsSync(join(projectRoot, markerFile)))) return false
    if (index < segments.length - 1) return true
    try {
      // 单独叫 release 或带候选前缀的普通源码文件仍应被监听。
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * 任务 params 白名单：契约 TaskRequest.params 的值只允许 string|number|boolean，
 * 其余类型（对象/数组/null）一律丢弃，不做任何结构猜测。
 */
export function sanitizeTaskParams (raw: unknown): Readonly<Record<string, string | number | boolean>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const params: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') params[key] = value
  }
  return params
}

// workflow 校验路由（POST /api/workflow/validate）住在 routes/workflow.ts
// （本侧重构抽出；validateWorkflowRequest 的实现移到 workflow/service/validate-request.ts）。
function isFsEventType (event: string): event is IdeFsEvent['type'] {
  return event === 'change' || event === 'add' || event === 'unlink' || event === 'addDir' || event === 'unlinkDir'
}

async function readJsonBody (req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) {
      throw new IdeRequestError(
        'FH2_IDE_TOO_LARGE',
        `请求体超过 ${MAX_BODY_BYTES} 字节上限。Request body exceeds the ${MAX_BODY_BYTES}-byte limit.`,
      )
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', '请求体不是合法 JSON。Request body is not valid JSON.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', '请求体必须是 JSON 对象。Request body must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

/** 定长比较，避免把 token 的正确前缀长度泄漏给本机上的其他进程。 */
function isTokenEqual (received: string | undefined | null, expected: string): boolean {
  if (typeof received !== 'string') return false
  const receivedBuffer = Buffer.from(received, 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')
  if (receivedBuffer.byteLength !== expectedBuffer.byteLength) return false
  return timingSafeEqual(receivedBuffer, expectedBuffer)
}

function singleHeader (value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function sendJson (res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendError (res: ServerResponse, code: IdeErrorCode, message: string): void {
  if (res.destroyed || res.writableEnded) return
  sendJson(res, IDE_ERROR_STATUS[code], ideFailure(code, message))
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
