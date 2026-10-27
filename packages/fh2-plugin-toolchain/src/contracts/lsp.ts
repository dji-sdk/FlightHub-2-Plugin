// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * LSP WebSocket 握手/鉴权/session/重连协议（Wave 0 冻结，供 A3/A4 并行实现）。
 *
 * - 同一 WebSocket 上，握手帧（带 `type` 字段）之外均为标准 LSP JSON-RPC 消息，
 *   原样透传，不在本协议层包装；
 * - 所有文档 URI 必须是绝对 `file://` URI（见 {@link AbsoluteFileUri}）；
 * - `workspaceSessionId` 是 Web IDE 传输字段：每次打开/切换根目录生成，
 *   旧 session 的消息（含迟到读写回包）必须被丢弃；
 * - P1 不做事件回放：resume 成功后客户端重新 didOpen 并重拉诊断。
 */

export const LSP_PROTOCOL_ID = 'fh2-lsp' as const

export const LSP_PROTOCOL_VERSION = 1 as const

/** 每次打开/切换工作区根目录生成；旧 session 的读写与事件一律丢弃。 */
export type WorkspaceSessionId = string

/** LSP 会话 id：服务端在握手成功后分配，重连时用于 resume。 */
export type LspSessionId = string

// ── 绝对 file URI ────────────────────────────────────────────────

declare const absoluteFileUriBrand: unique symbol

/** 绝对 `file://` URI（branded string，运行时用 {@link asAbsoluteFileUri} 校验构造）。 */
export type AbsoluteFileUri = string & { readonly [absoluteFileUriBrand]: true }

export function isAbsoluteFileUri (value: string): boolean {
  if (!value.startsWith('file://')) return false
  const rest = value.slice('file://'.length)
  // file:///abs/path（本地绝对路径）或 file://localhost/path
  return rest.startsWith('/') || rest.startsWith('localhost/')
}

export function asAbsoluteFileUri (value: string): AbsoluteFileUri | null {
  return isAbsoluteFileUri(value) ? value as AbsoluteFileUri : null
}

// ── 客户端 → 服务端 ─────────────────────────────────────────────

export interface LspClientHello {
  readonly type: 'hello';
  readonly protocol: typeof LSP_PROTOCOL_ID;
  readonly protocolVersion: number;
  /** Serve Token 鉴权；与 Serve HTTP 相同的 Token。 */
  readonly token: string;
  readonly workspaceSessionId: WorkspaceSessionId;
}

export interface LspClientResume {
  readonly type: 'resume';
  readonly protocol: typeof LSP_PROTOCOL_ID;
  readonly protocolVersion: number;
  readonly token: string;
  readonly workspaceSessionId: WorkspaceSessionId;
  readonly sessionId: LspSessionId;
}

export type LspClientHandshake = LspClientHello | LspClientResume

// ── 服务端 → 客户端 ─────────────────────────────────────────────

export interface LspServerHelloAccepted {
  readonly type: 'hello-accepted';
  readonly protocol: typeof LSP_PROTOCOL_ID;
  readonly protocolVersion: number;
  readonly sessionId: LspSessionId;
  /**
   * Volar 引入（向后兼容的可选字段）：桥接端实际拉起的语言服务形态。
   * `vue` = vue-language-server（.vue 全功能 + 嵌套 TS/HTML/CSS）；
   * `ts` = typescript-language-server（纯 TS/JS 工程默认）。
   * 客户端据此决定是否激活 Volar 专属的 Monaco provider。
   */
  readonly serverKind?: 'ts' | 'vue';
}

export interface LspServerResumeAccepted {
  readonly type: 'resume-accepted';
  readonly protocol: typeof LSP_PROTOCOL_ID;
  readonly protocolVersion: number;
  readonly sessionId: LspSessionId;
}

export type LspRejectReason =
  | 'unauthorized'
  | 'session-mismatch'
  | 'version-unsupported'
  | 'unknown-session'
  | 'bad-request'

export interface LspServerRejected {
  readonly type: 'rejected';
  readonly protocol: typeof LSP_PROTOCOL_ID;
  readonly reason: LspRejectReason;
  readonly message: string;
}

export type LspServerHandshake = LspServerHelloAccepted | LspServerResumeAccepted | LspServerRejected

/** 非 JSON-RPC 的运维信息：只用于 IDE 展示，不会转发给 language server。 */
export interface LspServerStatusMessage {
  readonly type: 'server-status';
  readonly protocol: typeof LSP_PROTOCOL_ID;
  readonly status: 'starting' | 'running' | 'stopped' | 'failed';
  readonly serverKind: 'ts' | 'vue';
  readonly message?: string;
}

export interface LspServerLogMessage {
  readonly type: 'server-log';
  readonly protocol: typeof LSP_PROTOCOL_ID;
  readonly stream: 'stderr';
  readonly source: 'typescript-language-server' | 'vue-language-server' | 'companion-tsserver';
  readonly message: string;
}

export type LspServerControlMessage = LspServerStatusMessage | LspServerLogMessage

// ── 解析器 ──────────────────────────────────────────────────────

/**
 * 识别「形似握手帧」：协议 id 与版本都对，本意是 hello/resume，但 token 缺失/为空/非字符串。
 * 这类帧不是 JSON-RPC（协议字段对不上），不能走早到缓冲——否则缺/空 token 的连接永远得不到拒绝。
 */
export function looksLikeLspClientHandshake (value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.protocol !== LSP_PROTOCOL_ID) return false
  if (record.protocolVersion !== LSP_PROTOCOL_VERSION) return false
  if (record.type !== 'hello' && record.type !== 'resume') return false
  // token 缺失/为空/非字符串：本意是握手但凭据无效（有 token 的走 parseLspClientHandshake 正常校验）
  return typeof record.token !== 'string' || record.token === ''
}

/** 解析客户端首帧；协议 id/版本不符或字段缺失返回 null（服务端回 `bad-request`）。 */
export function parseLspClientHandshake (value: unknown): LspClientHandshake | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.protocol !== LSP_PROTOCOL_ID) return null
  if (record.protocolVersion !== LSP_PROTOCOL_VERSION) return null
  if (typeof record.token !== 'string' || record.token === '') return null
  if (typeof record.workspaceSessionId !== 'string' || record.workspaceSessionId === '') return null
  if (record.type === 'hello') return { ...record } as unknown as LspClientHello
  if (record.type === 'resume') {
    if (typeof record.sessionId !== 'string' || record.sessionId === '') return null
    return { ...record } as unknown as LspClientResume
  }
  return null
}

/** 解析服务端握手应答帧。 */
export function parseLspServerHandshake (value: unknown): LspServerHandshake | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.protocol !== LSP_PROTOCOL_ID) return null
  if (record.type === 'hello-accepted' || record.type === 'resume-accepted') {
    if (typeof record.sessionId !== 'string' || record.sessionId === '') return null
    if (record.serverKind !== undefined && record.serverKind !== 'ts' && record.serverKind !== 'vue') return null
    return { ...record } as unknown as LspServerHandshake
  }
  if (record.type === 'rejected') {
    const reasons: readonly string[] = ['unauthorized', 'session-mismatch', 'version-unsupported', 'unknown-session', 'bad-request']
    if (typeof record.reason !== 'string' || !reasons.includes(record.reason)) return null
    if (typeof record.message !== 'string') return null
    return { ...record } as unknown as LspServerRejected
  }
  return null
}

export function parseLspServerControlMessage (value: unknown): LspServerControlMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.protocol !== LSP_PROTOCOL_ID) return null
  if (record.type === 'server-status') {
    if (!['starting', 'running', 'stopped', 'failed'].includes(String(record.status))) return null
    if (record.serverKind !== 'ts' && record.serverKind !== 'vue') return null
    if (record.message !== undefined && typeof record.message !== 'string') return null
    return { ...record } as unknown as LspServerStatusMessage
  }
  if (record.type === 'server-log') {
    if (record.stream !== 'stderr') return null
    if (!['typescript-language-server', 'vue-language-server', 'companion-tsserver'].includes(String(record.source))) return null
    if (typeof record.message !== 'string') return null
    return { ...record } as unknown as LspServerLogMessage
  }
  return null
}
