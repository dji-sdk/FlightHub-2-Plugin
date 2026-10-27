// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * Web IDE API 契约类型（docs：WebIDE/API契约.md v1 + v2 增补）。
 *
 * 共享字段（Diagnostic、错误码与状态映射、工作区 kind、SSE 事件载荷、信封）统一从
 * Toolchain 内部 contracts 导入并在此重导出；本模块只保留 Serve 专属类型。
 * 前端与本模块独立实现、共用同一份契约，所以这里的字段名一律照抄契约，
 * 不做「更合理」的重命名——任何偏差都会直接打断联调。
 *
 * v2 只增不改：v1 的类型与字段语义保持原样，新增端点复用同一个响应信封。
 */
import type {
  Diagnostic,
  FsEventPayload,
  IdeErrorCode,
  RunEventPayload,
  RunLogEventPayload,
  WorkspaceEventPayload,
  WorkspaceKind,
} from './index.js'

export {
  IDE_ERROR_STATUS,
  SCHEMA_VERSION as IDE_SCHEMA_VERSION,
  serveFailure as ideFailure,
  serveSuccess as ideSuccess,
} from './index.js'
export type { IdeErrorCode } from './index.js'

/** 契约 1.3：与 Toolchain Validate 诊断对齐（phase/severity 词表见 Protocol）。 */
export type IdeDiagnostic = Diagnostic

/** 兼容导出：phase 词表已随 Protocol 扩展（新增 build 阶段 typecheck/bundle/goja-verify）。 */
export type IdeDiagnosticPhase = Diagnostic['phase']

export interface IdeWorkspaceData {
  readonly root: string;
  readonly name: string;
  /** 工作区 kind 词表见 Protocol；旧 `capability` 值已迁移为 `capability-project`。 */
  readonly kind: WorkspaceKind;
  readonly toolchainVersion: string;
  /** F5：工作区会话 id；每次打开/切换根目录生成，写请求携带用于丢弃迟到写入。 */
  readonly sessionId: string;
  /** 严格 discovery 失败时保留工程身份，并返回可定位的配置诊断。 */
  readonly diagnostics: readonly IdeDiagnostic[];
}

export type IdeTreeNode = {
  readonly name: string;
  readonly path: string;
  readonly kind: 'dir';
  readonly children: readonly IdeTreeNode[];
  /** false表示内容尚未完整读取，展开时拉取单层；true可表示已加载的空目录。 */
  readonly childrenLoaded?: boolean;
  readonly ignored?: boolean;
  /**
   * 位于生成目录（node_modules / dist）内，前端置灰；加载状态由childrenLoaded表达。
   */
  readonly generated?: boolean;
} | {
  readonly name: string;
  readonly path: string;
  readonly kind: 'file';
  readonly size: number;
  readonly generated?: boolean;
  readonly ignored?: boolean;
}

export interface IdeTreeData {
  readonly truncated: boolean;
  readonly tree: readonly IdeTreeNode[];
  readonly warnings?: readonly string[];
}

/** GET /api/tree/children：生成目录（或任意目录）的惰性单层子树。 */
export interface IdeTreeChildrenData {
  readonly path: string;
  readonly children: readonly IdeTreeNode[];
  readonly warnings?: readonly string[];
}

export interface IdeFileData {
  readonly path: string;
  readonly content: string;
  readonly encoding: 'utf-8';
  /** F2：内容 hash revision；保存时作为 expectedRevision 回传。 */
  readonly revision: string;
}

export interface IdeWriteData {
  readonly path: string;
  readonly bytesWritten: number;
  /** F2：本次提交内容的新 revision；前端据此推进磁盘基线。 */
  readonly revision: string;
}

export interface IdeValidateData {
  readonly ok: boolean;
  readonly diagnostics: readonly IdeDiagnostic[];
  readonly durationMs: number;
}

export interface IdeBuildData {
  readonly ok: boolean;
  readonly diagnostics: readonly IdeDiagnostic[];
  readonly outputs: readonly string[];
  readonly durationMs: number;
}

export interface IdeSchemaEntry {
  readonly uri: string;
  readonly fileMatch: readonly string[];
  readonly schema: unknown;
}

export interface IdeSchemasData {
  readonly schemas: readonly IdeSchemaEntry[];
}

/** 契约 2.8：SSE `event: fs` 的 data 结构（词表与版本校验见 Protocol）。 */
export type IdeFsEvent = FsEventPayload

/** 契约 6.1：`POST /api/fs/create` 的回包。 */
export interface IdeFsCreateData {
  readonly path: string;
  readonly kind: 'file' | 'dir';
}

/** 契约 6.2：`POST /api/fs/delete` 的回包，`kind` 是被删除对象的实际类型。 */
export interface IdeFsDeleteData {
  readonly path: string;
  readonly kind: 'file' | 'dir';
}

/** 契约 6.3：`POST /api/fs/rename` 的回包。 */
export interface IdeFsRenameData {
  readonly from: string;
  readonly to: string;
}

/** 契约 6.4：`POST /api/fs/copy` 的回包（文件或目录递归复制，二进制保真）。 */
export interface IdeFsCopyData {
  readonly from: string;
  readonly to: string;
}

/** 文件树系统菜单的路径回包；absolutePath采用服务器系统格式。 */
export interface IdeFsPathData {
  readonly absolutePath: string;
  readonly relativePath: string;
}

/** 契约 7.2：最近打开过的工作根，进程内维护，不落盘。 */
export interface IdeRecentRoot {
  readonly root: string;
  readonly name: string;
  readonly kind: IdeWorkspaceData['kind'];
}

export interface IdeRecentData {
  readonly roots: readonly IdeRecentRoot[];
}

/** 契约 7.3：SSE `event: workspace` 的 data 结构（与 §2.1 同构但不含 toolchainVersion）。 */
export type IdeWorkspaceEvent = WorkspaceEventPayload

/** 契约 8：`dev` 走本地 Mock Host，`preview` 走真实司空受控预览。 */
export type IdeRunMode = 'dev' | 'preview'

export type IdeRunStatus = 'starting' | 'running' | 'stopped' | 'failed'

/** 契约 8.3：单个运行进程的快照；`url` 在拿到子进程输出前不存在。 */
export interface IdeRunProcess {
  readonly mode: IdeRunMode;
  readonly status: IdeRunStatus;
  readonly url?: string;
  readonly since: number;
  readonly projectPath?: string;
  readonly detail?: string;
}

export interface IdeRunTarget {
  /** 相对 IDE 工作根；`.` 表示工作根本身。 */
  readonly projectPath: string;
  readonly label: string;
  readonly kind: WorkspaceKind;
  readonly modes: readonly IdeRunMode[];
}

export interface IdeRunTargetsData {
  readonly targets: readonly IdeRunTarget[];
}

export interface IdeRunLogsData {
  readonly lines: readonly IdeRunLogEvent[];
}

export interface IdeRunStatusData {
  readonly processes: readonly IdeRunProcess[];
}

/** 契约 8.1：start 是异步的，回包只表示「已受理」，真实状态走 SSE。 */
export interface IdeRunStartData {
  readonly mode: IdeRunMode;
  readonly status: IdeRunStatus;
  readonly url?: string;
  readonly projectPath: string;
  /** dev任务受理前检测到端口冲突；确认后携带token重试，不接受客户端PID。 */
  readonly portConflict?: IdeRunPortConflict;
}

export interface IdeRunPortConflict {
  readonly port: number;
  readonly processes: readonly { readonly pid: number; readonly command: string }[];
  readonly confirmationToken?: string;
  readonly message: string;
}

export interface IdeRunStopData {
  readonly mode: IdeRunMode;
  readonly status: 'stopped';
}

/** 契约 8.4：SSE `event: run`。 */
export type IdeRunEvent = RunEventPayload

/** 契约 8.4：SSE `event: run-log`。 */
export type IdeRunLogEvent = RunLogEventPayload

/**
 * 端点内部抛出的受控失败；由路由层统一翻译成契约 1.2 的错误响应。
 *
 * message 一律「中文。English.」双语——契约要求前端可直接展示。
 */
export class IdeRequestError extends Error {
  constructor (
    readonly code: IdeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'IdeRequestError'
  }
}
