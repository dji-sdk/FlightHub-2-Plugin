// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type {
  ActionsResult,
  ApiEnvelope,
  BuildResult,
  FileConflictPayload,
  FileContent,
  FsCopyResult,
  FsCreateResult,
  FsDeleteResult,
  FsEntryKind,
  FsPathResult,
  FsRenameResult,
  KnowledgeStatus,
  RecentWorkspacesResult,
  RunLogsResult,
  RunMode,
  RunStartResult,
  RunStatusResult,
  RunStopResult,
  RunTargetsResult,
  SaveRequestItem,
  SaveResponse,
  SchemasResult,
  TaskListResult,
  TaskLogsResult,
  TaskSnapshot,
  TreeChildrenResult,
  TreeResult,
  ValidateResult,
  WorkspaceInfo,
  WriteResult,
} from './types.js'

declare global {
  interface Window {
    __FH2_IDE_TOKEN__?: string;
    __FH2_IDE_BASE__?: string;
  }
}

export class IdeApiError extends Error {
  readonly code: string
  readonly httpStatus: number
  /** F2：409 冲突时携带的当前磁盘快照。 */
  readonly conflict?: FileConflictPayload

  constructor (code: string, message: string, httpStatus: number, conflict?: FileConflictPayload) {
    super(message)
    this.name = 'IdeApiError'
    this.code = code
    this.httpStatus = httpStatus
    if (conflict !== undefined) this.conflict = conflict
  }

  get unauthorized (): boolean {
    return this.code === 'FH2_IDE_UNAUTHORIZED' || this.httpStatus === 401
  }

  get fileConflict (): boolean {
    return this.code === 'FH2_FILE_CONFLICT'
  }
}

/** 契约 §0：token 由 serve 注入首页；本地 `vite dev` 无注入时退回固定 dev token。 */
function readToken (): string {
  return window.__FH2_IDE_TOKEN__ ?? 'dev-token'
}

/** F5：当前工作区会话 id；写请求自动携带，迟到写入由服务端拒绝。 */
let workspaceSession: string | null = null

export function setWorkspaceSession (sessionId: string | null): void {
  workspaceSession = sessionId
}

function sessionHeaders (): Record<string, string> {
  return workspaceSession === null ? {} : { 'x-fh2-ide-session': workspaceSession }
}

/**
 * 契约 §3 的 `__FH2_IDE_BASE__` 可能带或不带尾斜杠，统一归一成「不带尾斜杠」，
 * 拼接时一律 `${base}/api/x`，避免出现 `//api`。
 */
function readBase (): string {
  const raw = window.__FH2_IDE_BASE__ ?? ''
  return raw.replace(/\/+$/, '')
}

function apiUrl (path: string, query?: Record<string, string>): string {
  const url = new URL(`${readBase()}${path}`, window.location.href)
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
  return url.toString()
}

async function request<T> (path: string, init?: RequestInit, query?: Record<string, string>): Promise<T> {
  let response: Response
  try {
    response = await fetch(apiUrl(path, query), {
      ...init,
      headers: {
        'x-fh2-ide-token': readToken(),
        ...sessionHeaders(),
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init?.headers,
      },
    })
  } catch (cause) {
    throw new IdeApiError(
      'FH2_IDE_INTERNAL',
      `无法连接 fh2-plugin serve：${cause instanceof Error ? cause.message : String(cause)}`,
      0,
    )
  }

  let envelope: ApiEnvelope<T> & { conflict?: FileConflictPayload }
  try {
    envelope = await response.json() as ApiEnvelope<T> & { conflict?: FileConflictPayload }
  } catch {
    // 非 JSON 响应说明打到了静态回退或反代，按内部错误暴露，不静默吞掉
    throw new IdeApiError('FH2_IDE_INTERNAL', `响应不是 JSON（HTTP ${response.status}）`, response.status)
  }

  if (!envelope.ok) {
    throw new IdeApiError(envelope.error.code, envelope.error.message, response.status, envelope.conflict)
  }
  return envelope.data
}

export const ideApi = {
  workspace: (): Promise<WorkspaceInfo> => request<WorkspaceInfo>('/api/workspace'),

  tree: (): Promise<TreeResult> => request<TreeResult>('/api/tree'),

  treeChildren: (path: string): Promise<TreeChildrenResult> =>
    request<TreeChildrenResult>(`/api/tree/children?path=${encodeURIComponent(path)}`),

  schemas: (): Promise<SchemasResult> => request<SchemasResult>('/api/schemas'),

  /**
   * 计划 §B3：当前固定的知识身份、内容清单与阻断原因。
   *
   * ⚠️ 回包里的 `checkerAvailable` 恒为 false，界面据此说明「无同版本权威 checker」——
   * 本地预检不等于可部署，也不等于真实运行已验证。
   */
  knowledge: (): Promise<KnowledgeStatus> => request<KnowledgeStatus>('/api/knowledge'),

  /**
   * 计划 §C2：多文件有序保存（脚本 → 清单 → 工作流）。
   * ⚠️ 每项自带 expectedDiskHash 做 CAS；缺它就是无条件覆盖。
   */
  save: (items: readonly SaveRequestItem[]): Promise<SaveResponse> =>
    request<SaveResponse>('/api/save', { method: 'POST', body: JSON.stringify({ items }) }),

  /** 契约 §9：画布节点菜单（受审词表 + 本工程脚本 I/O）。 */
  actions: (path?: string): Promise<ActionsResult> => request<ActionsResult>(`/api/actions${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`),

  readFile: (path: string): Promise<FileContent> => request<FileContent>('/api/file', undefined, { path }),

  /** F2：写入携带 expectedRevision；409 冲突时抛出的 IdeApiError 携带磁盘快照。 */
  writeFile: (path: string, content: string, expectedRevision?: string): Promise<WriteResult> =>
    request<WriteResult>('/api/file', {
      method: 'PUT',
      body: JSON.stringify({
        path,
        content,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
    }),

  validate: (path?: string): Promise<ValidateResult> =>
    request<ValidateResult>('/api/validate', {
      method: 'POST',
      body: JSON.stringify(path === undefined ? {} : { path }),
    }),

  build: (): Promise<BuildResult> => request<BuildResult>('/api/build', { method: 'POST', body: '{}' }),

  // ── 契约 §6 文件管理 ───────────────────────────

  fsPath: (path: string): Promise<FsPathResult> => request<FsPathResult>('/api/fs/path', undefined, { path }),

  fsReveal: (path: string): Promise<FsPathResult> =>
    request<FsPathResult>('/api/fs/reveal', { method: 'POST', body: JSON.stringify({ path }) }),

  /** 契约 §6.1：`content` 仅 `kind:"file"` 时有意义，dir 一律不带。 */
  fsCreate: (path: string, kind: FsEntryKind, content = ''): Promise<FsCreateResult> =>
    request<FsCreateResult>('/api/fs/create', {
      method: 'POST',
      body: JSON.stringify(kind === 'file' ? { path, kind, content } : { path, kind }),
    }),

  /** 契约 §6.2：`recursive` 不做默认值，调用方必须显式传。 */
  fsDelete: (path: string, recursive: boolean): Promise<FsDeleteResult> =>
    request<FsDeleteResult>('/api/fs/delete', { method: 'POST', body: JSON.stringify({ path, recursive }) }),

  /** 契约 §6.3：`overwrite` 不做默认值，调用方必须显式传。 */
  fsRename: (from: string, to: string, overwrite: boolean): Promise<FsRenameResult> =>
    request<FsRenameResult>('/api/fs/rename', { method: 'POST', body: JSON.stringify({ from, to, overwrite }) }),

  /** 契约 §6.4：复制文件 / 目录（递归，二进制保真）；目标已存在由服务端 409 拒绝。 */
  fsCopy: (from: string, to: string): Promise<FsCopyResult> =>
    request<FsCopyResult>('/api/fs/copy', { method: 'POST', body: JSON.stringify({ from, to }) }),

  // ── 契约 §7 工作区切换 ─────────────────────────

  openWorkspace: (root: string): Promise<WorkspaceInfo> =>
    request<WorkspaceInfo>('/api/workspace/open', { method: 'POST', body: JSON.stringify({ root }) }),

  /** N3：创建新工程（同步生成 + 可选 install 任务）；返回新工程根。 */
  workspaceCreate: (options: {
    readonly pluginId: string;
    readonly directory?: string;
    readonly template?: string;
    readonly install?: boolean;
    readonly packageManager?: string;
  }): Promise<{ readonly projectRoot: string; readonly log: readonly string[]; readonly installTaskId?: string }> =>
    request('/api/workspace/create', {
      method: 'POST',
      body: JSON.stringify(options),
    }),

  recentWorkspaces: (): Promise<RecentWorkspacesResult> =>
    request<RecentWorkspacesResult>('/api/workspace/recent'),

  // ── 契约 §8 运行 / 预览 ────────────────────────

  runTargets: (): Promise<RunTargetsResult> => request<RunTargetsResult>('/api/run/targets'),

  runLogs: (mode?: RunMode): Promise<RunLogsResult> =>
    request<RunLogsResult>('/api/run/logs', undefined, mode === undefined ? undefined : { mode }),

  runStart: (mode: RunMode, options?: { readonly port?: number; readonly target?: string; readonly projectPath?: string; readonly portConfirmation?: string }): Promise<RunStartResult> =>
    request<RunStartResult>('/api/run/start', {
      method: 'POST',
      body: JSON.stringify({ mode, port: options?.port ?? 0, target: options?.target ?? '', projectPath: options?.projectPath ?? '', ...(options?.portConfirmation === undefined ? {} : { portConfirmation: options.portConfirmation }) }),
    }),

  runStop: (mode: RunMode): Promise<RunStopResult> =>
    request<RunStopResult>('/api/run/stop', { method: 'POST', body: JSON.stringify({ mode }) }),

  runStatus: (): Promise<RunStatusResult> => request<RunStatusResult>('/api/run/status'),

  /** 契约 §2.8：EventSource 无法设置自定义头，token 走 query。 */
  eventsUrl: (): string => apiUrl('/api/events', { token: readToken() }),

  // ── U1/U2/U3：任务通道 ────────────────────────

  taskStart: (kind: 'build' | 'pack', params?: Readonly<Record<string, string | number | boolean>>): Promise<TaskSnapshot> =>
    request<TaskSnapshot>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ kind, ...(params === undefined ? {} : { params }) }),
    }),

  taskList: (): Promise<TaskListResult> => request<TaskListResult>('/api/tasks'),

  taskGet: (taskId: string): Promise<TaskSnapshot> => request<TaskSnapshot>(`/api/tasks/${encodeURIComponent(taskId)}`),

  taskCancel: (taskId: string): Promise<TaskSnapshot> =>
    request<TaskSnapshot>(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', body: '{}' }),

  taskLogs: (taskId: string): Promise<TaskLogsResult> =>
    request<TaskLogsResult>(`/api/tasks/${encodeURIComponent(taskId)}/logs`),

  /** U3：产物下载（fetch + blob，鉴权走请求头；digest 由服务端校验）。 */
  artifactDownload: async (taskId: string, artifactId: string): Promise<{ readonly blob: Blob; readonly fileName: string }> => {
    const response = await fetch(apiUrl(`/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`), {
      headers: { 'x-fh2-ide-token': readToken(), ...sessionHeaders() },
    })
    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText)
      throw new IdeApiError('FH2_IDE_DOWNLOAD_FAILED', `产物下载失败（HTTP ${response.status}）：${message}`, response.status)
    }
    const disposition = response.headers.get('content-disposition') ?? ''
    const match = /filename="([^"]+)"/.exec(disposition)
    return {
      blob: await response.blob(),
      fileName: match?.[1] ?? `${artifactId}.zip`,
    }
  },
}

/** 契约 §1.2 / §5 错误码 → 面向用户的中文说明。未收录的码回落到服务端原文。 */
const ERROR_HINTS: Readonly<Record<string, string>> = {
  FH2_IDE_ALREADY_EXISTS: '目标已存在。',
  FH2_IDE_NOT_EMPTY: '目录非空，需要勾选「连同内容一起删除」才能删。',
  FH2_IDE_ROOT_INVALID: '目标路径不存在，或不是可识别的插件工程（capability / 前端插件 / 后端插件）。',
  FH2_IDE_PROCESS_FAILED: '进程启动失败，详情见运行日志。',
  FH2_IDE_PROCESS_RUNNING: '同类进程已在运行，请先停止再启动。',
  FH2_IDE_NOT_FOUND: '目标不存在；若是新建，请确认父目录已存在（不会自动创建多级目录）。',
  FH2_IDE_PATH_ESCAPE: '路径越出了工作根，已拒绝。',
  FH2_IDE_TOO_LARGE: '文件超过 2 MiB 上限，Web IDE 不打开。',
  FH2_IDE_NOT_A_FILE: '目标不是可编辑的文本文件。',
}

/** 把接口错误翻成人话：优先用本地说明，再附上服务端原文以便排查。 */
export function describeApiError (error: unknown): string {
  if (!(error instanceof IdeApiError)) return error instanceof Error ? error.message : String(error)
  const hint = ERROR_HINTS[error.code]
  return hint === undefined ? error.message : `${hint}（${error.message}）`
}
