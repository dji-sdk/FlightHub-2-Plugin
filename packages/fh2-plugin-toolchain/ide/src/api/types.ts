// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * `fh2-plugin serve` API 契约（WebIDE/API契约.md v1 + v2 增补）的 TypeScript 映射。
 * 字段名与可选性必须与契约逐字一致，前端不得自行发明字段。
 *
 * 共享字段（Diagnostic、错误码、工作区 kind、SSE 事件、信封）统一从
 * Toolchain 内部 contracts 导入并在此重导出，与 Serve/MCP 消费同一份契约。
 */
import type {
  FsEventPayload,
  Diagnostic as ProtocolDiagnostic,
  WorkspaceKind as ProtocolWorkspaceKind,
  RunEventPayload,
  RunLogEventPayload,
  ServeEnvelope,
  WorkspaceEventPayload,
} from '../../../src/contracts/index.js'

export type { IdeFsPathData as FsPathResult } from '../../../src/contracts/ide.js'

export {
  IDE_ERROR_STATUS,
  SCHEMA_VERSION,
} from '../../../src/contracts/index.js'
export type { IdeErrorCode as ApiErrorCode, DiagnosticPhase, DiagnosticSeverity } from '../../../src/contracts/index.js'

/**
 * 知识包契约：**只重导出，不在前端复制一份**（计划 §B1）。
 *
 * ⚠️ 前端复制一份 DTO 的失真方式很具体：服务端给知识 Catalog 加了一格
 * （比如 seedNotGuaranteed），前端那份没跟上 —— 于是那格事实到不了画布，
 * 而两侧各自的类型检查都是绿的。
 */
export type {
  CatalogSource,
  CatalogSourceKind,
  KnowledgeAction,
  KnowledgeContents,
  KnowledgeField,
  KnowledgeHostApi,
  KnowledgeLanguage,
  KnowledgeStatus,
  KnowledgeTriggerAxis,
} from '../../../src/contracts/index.js'

/** Serve/HTTP 回包信封（契约 1.2）。 */
export type ApiEnvelope<T> = ServeEnvelope<T>

// ── U1/U2/U3：任务通道（Build/Pack 走 TaskService） ──

export type { TaskSnapshot, TaskEvent, TaskState, ArtifactDescriptor } from '../../../src/contracts/index.js'

export interface TaskListResult {
  readonly tasks: readonly import('../../../src/contracts/index.js').TaskSnapshot[];
}
export interface TaskLogsResult {
  readonly lines: readonly string[];
}

export type ApiDiagnostic = ProtocolDiagnostic

/**
 * 工作区 kind 词表由 Protocol 维护：旧 `capability` 值已迁移为 `capability-project`，
 * `industry-capability-workspace` 为合法值（修复历史白名单遗漏）。
 */
export type WorkspaceKind = ProtocolWorkspaceKind

export interface WorkspaceInfo {
  readonly root: string;
  readonly name: string;
  readonly kind: WorkspaceKind;
  readonly toolchainVersion: string;
  /** F5：工作区会话 id；写请求自动携带，切换后迟到写入被服务端拒绝。 */
  readonly sessionId: string;
  readonly diagnostics: readonly ApiDiagnostic[];
}

export interface TreeFileNode {
  readonly name: string;
  readonly path: string;
  readonly kind: 'file';
  readonly size?: number;
  readonly generated?: boolean;
  readonly ignored?: boolean;
}

export interface TreeDirNode {
  readonly name: string;
  readonly path: string;
  readonly kind: 'dir';
  readonly children?: readonly TreeNode[];
  readonly childrenLoaded?: boolean;
  readonly ignored?: boolean;
  /** 生成目录（node_modules / dist）：置灰展示，展开时惰性拉取子层。 */
  readonly generated?: boolean;
}

export type TreeNode = TreeFileNode | TreeDirNode

export interface TreeResult {
  readonly warnings?: readonly string[];
  readonly truncated: boolean;
  readonly tree: readonly TreeNode[];
}

export interface TreeChildrenResult {
  readonly warnings?: readonly string[];
  readonly path: string;
  readonly children: readonly TreeNode[];
}

export interface FileContent {
  readonly path: string;
  readonly content: string;
  readonly encoding: string;
  /** F2：内容 hash revision；保存时作为 expectedRevision 回传。 */
  readonly revision: string;
}

export interface WriteResult {
  readonly path: string;
  readonly bytesWritten: number;
  /** F2：本次提交的新 revision。 */
  readonly revision: string;
}

/** F2：写入冲突载荷（HTTP 409 FH2_FILE_CONFLICT 时附带当前磁盘快照）。 */
export interface FileConflictPayload {
  readonly code: 'FH2_FILE_CONFLICT';
  readonly message: string;
  readonly disk: { readonly path: string; readonly content: string; readonly revision: string };
}

export interface ValidateResult {
  readonly ok: boolean;
  readonly diagnostics: readonly ApiDiagnostic[];
  readonly durationMs: number;
}

export interface BuildResult {
  readonly ok: boolean;
  readonly diagnostics: readonly ApiDiagnostic[];
  readonly outputs: readonly string[];
  readonly durationMs: number;
}

export interface SchemaEntry {
  readonly uri: string;
  readonly fileMatch: readonly string[];
  readonly schema: unknown;
}

export interface SchemasResult {
  readonly schemas: readonly SchemaEntry[];
}

// ── 契约 §9 工作流低代码：节点菜单数据源 ──────────

/** 受审词表/脚本 io 的一个参数声明。与 worker 的 flowcheck.Field 同形。 */
export interface ActionFieldEntry {
  readonly name: string;
  readonly type: string;
  readonly required?: boolean;
  /** `dynamic` / `signal` = 这次不一定产出。 */
  readonly from?: string;
  readonly fields?: readonly ActionFieldEntry[];
}

export interface FixedStepEntry {
  readonly action: string;
  readonly capability?: string;
  readonly isFlight?: boolean;
  readonly kind: 'activity' | 'await_signal';
  readonly owner: 'platform' | 'plugin';
  readonly nonIdempotent?: boolean;
  readonly inputs: readonly ActionFieldEntry[];
  readonly outputs: readonly ActionFieldEntry[];
  readonly description?: string;
}

export interface ScriptEntry {
  readonly id: string;
  readonly entry?: string;
  /** 清单里原样的 path（相对清单所在目录）。 */
  readonly path?: string;
  /** 工作区相对路径，可直接喂给 /api/file。 */
  readonly filePath?: string;
  readonly allowlist: readonly string[];
  readonly inputs: readonly ActionFieldEntry[];
  readonly outputs: readonly ActionFieldEntry[];
  readonly description?: string;
}

export interface TriggerSeedEntry {
  readonly available: readonly string[];
  readonly notGuaranteed: readonly string[];
  /** 平台已知键的值类型；api/job 自定键与未带 seedTypes 的知识包没有这一项。 */
  readonly types?: Readonly<Record<string, string>>;
}

export interface ActionsResult {
  readonly fixedSteps: readonly FixedStepEntry[];
  readonly scripts: readonly ScriptEntry[];
  readonly triggerSeeds: Readonly<Record<string, TriggerSeedEntry>>;
  readonly runRoot: readonly string[];
  readonly scriptAction: string;
  readonly pluginActionPrefix: string;
  readonly stepStates: readonly string[];
  readonly conditionOps: readonly string[];
  readonly stepTriggers: readonly string[];
  readonly grantableCaps: readonly string[];
  readonly pluginManifestFound: boolean;
  readonly pluginManifestPath?: string;
  readonly catalogRevision: string;
  /**
   * 这份 Catalog 从哪来。**界面必须显示它**：`builtin-snapshot` 是 Toolchain 内建
   * 手抄快照，可能与目标 worker 版本已漂移；`knowledge` 才是与 revision 绑定的事实。
   * 两者显示成一个样子就是假绿灯（计划 §11.9）。
   */
  readonly catalogSource: import('../../../src/contracts/index.js').CatalogSource;
}

/**
 * 计划 §C2：多文件保存的请求/回包。
 * ⓘ 与 `src/services/ide/save.ts` 的 SaveItem / SaveResult 同构；
 *   这里重新声明是因为前端不 import Node 侧模块（那会把 fs 拖进浏览器包）。
 */
export interface SaveRequestItem {
  readonly path: string;
  readonly kind: 'write' | 'create' | 'delete';
  readonly content?: string;
  readonly expectedDiskHash?: string;
}

export interface SaveItemResult {
  readonly path: string;
  readonly kind: 'write' | 'create' | 'delete';
  readonly ok: boolean;
  readonly revision?: string;
  readonly errorCode?: string;
  readonly message?: string;
  readonly conflict?: { readonly diskContent: string; readonly diskRevision: string };
}

export interface SaveResponse {
  readonly ok: boolean;
  readonly partial: boolean;
  readonly items: readonly SaveItemResult[];
}

/** 契约 §6.1：SSE `event: fs`（词表与版本校验见 Protocol）。 */
export type FsEvent = FsEventPayload

// ── 契约 §6 文件管理 ─────────────────────────────

export type FsEntryKind = 'file' | 'dir'

export interface FsCreateResult {
  readonly path: string;
  readonly kind: FsEntryKind;
}

export interface FsDeleteResult {
  readonly path: string;
  readonly kind: FsEntryKind;
}

export interface FsRenameResult {
  readonly from: string;
  readonly to: string;
}

export interface FsCopyResult {
  readonly from: string;
  readonly to: string;
}

// ── 契约 §7 工作区切换 ───────────────────────────

export interface RecentWorkspace {
  readonly root: string;
  readonly name: string;
  readonly kind: WorkspaceKind;
}

export interface RecentWorkspacesResult {
  readonly roots: readonly RecentWorkspace[];
}

/** 契约 §7.3：SSE `event: workspace` 的 payload，与 §2.1 同构但不含 toolchainVersion。 */
export type WorkspaceEvent = WorkspaceEventPayload

// ── 契约 §8 运行 / 预览 ──────────────────────────

export type RunMode = 'dev' | 'preview'
export type RunStatus = 'running' | 'starting' | 'stopped' | 'failed'

export interface RunProcess {
  readonly mode: RunMode;
  readonly status: RunStatus;
  readonly url?: string;
  readonly since?: number;
  readonly projectPath?: string;
  readonly detail?: string;
}

export interface RunTarget {
  readonly projectPath: string;
  readonly label: string;
  readonly kind: WorkspaceKind;
  readonly modes: readonly RunMode[];
}

export interface RunTargetsResult {
  readonly targets: readonly RunTarget[];
}
export interface RunLogsResult {
  readonly lines: readonly RunLogEvent[];
}

export interface RunStatusResult {
  readonly processes: readonly RunProcess[];
}

export interface RunStartResult {
  readonly mode: RunMode;
  readonly status: RunStatus;
  readonly url?: string;
  readonly projectPath: string;
  readonly portConflict?: import('../../../src/contracts/ide.js').IdeRunPortConflict;
}

export interface RunStopResult {
  readonly mode: RunMode;
  readonly status: RunStatus;
}

/** 契约 §8.4：SSE `event: run`。 */
export type RunEvent = RunEventPayload

/** 契约 §8.4：SSE `event: run-log`。 */
export type RunLogEvent = RunLogEventPayload
