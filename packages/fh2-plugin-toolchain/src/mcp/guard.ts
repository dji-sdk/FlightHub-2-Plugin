// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * M1：MCP Workspace Guard（实施计划 §3.5）。
 *
 * - 对所有路径执行 resolve/realpath/symlink 边界校验；它是路径边界，不是构建沙箱；
 * - 双模式（v3.9）：open（默认）允许任意绝对路径与相对 baseDir 的路径，无边界；
 *   contained（--root）把工具 path 入参收纳在冻结的 allowed root 内（root 内
 *   绝对路径放行）；
 * - 目标可以不存在（inspect 空目录合法）；contained 模式下存在时必须真实路径
 *   落在 root 内；
 * - contained 不是沙箱：内部锁会写到工程归属根（可能是 root 外的 Capability/
 *   工作区根），create 也会向上探测平台仓——root 只约束工具入参路径。
 */

export class McpGuardError extends Error {
  constructor (
    readonly code: 'FH2_MCP_BAD_REQUEST' | 'FH2_MCP_PATH_ESCAPE' | 'FH2_MCP_ROOT_INVALID',
    message: string,
  ) {
    super(message)
    this.name = 'McpGuardError'
  }
}

/** 工作区访问模式（v3.9 §3）：open 为默认，contained 由 --root 显式开启。 */
export type WorkspaceAccess =
  | { readonly mode: 'open'; readonly baseDir: string }
  | { readonly mode: 'contained'; readonly root: string }

export interface GuardedPath {
  /** 归一化后的绝对目标路径。 */
  readonly absolutePath: string;
}

/**
 * allowed root 的唯一规范化入口：resolve → stat（必须存在且是目录；symlink 指向
 * 目录被解析、指向文件拒绝）→ realpath 返回真实绝对路径。
 * main.ts（收纳模式冻结 --root）与 resolveGuardedPath（每次调用复核）共用同一
 * 规则，消除「启动接受、工具拒绝」的双重校验漂移。边界语义不变：冻结/校验的
 * 都是真实路径，root 内部 symlink 越界仍由 anchor 复核拒绝。
 */
export function canonicalizeAllowedRoot (rawRoot: string): string {
  const root = resolve(rawRoot)
  let rootStat
  try {
    rootStat = statSync(root)
  } catch {
    throw new McpGuardError('FH2_MCP_ROOT_INVALID', `allowed root 不可访问：${root}。Allowed root is not accessible: ${root}.`)
  }
  if (!rootStat.isDirectory()) {
    throw new McpGuardError('FH2_MCP_ROOT_INVALID', `allowed root 必须是目录：${root}。Allowed root must be a directory: ${root}.`)
  }
  return realpathSync(root)
}

export function resolveGuardedPath (access: WorkspaceAccess, rawPath: unknown): GuardedPath {
  if (rawPath !== undefined && rawPath !== null && typeof rawPath !== 'string') {
    throw new McpGuardError('FH2_MCP_BAD_REQUEST', 'path 必须是字符串。"path" must be a string.')
  }
  const value = rawPath === undefined || rawPath === null ? '' : rawPath
  if (value.includes('\0')) {
    throw new McpGuardError('FH2_MCP_BAD_REQUEST', 'path 含非法字符。"path" contains illegal characters.')
  }
  if (value.includes('\\')) {
    throw new McpGuardError('FH2_MCP_BAD_REQUEST', 'path 必须使用 / 分隔的 POSIX 相对路径。"path" must be a POSIX relative path.')
  }

  if (access.mode === 'open') {
    // 开放模式：相对路径基于启动 cwd（baseDir）解析；绝对路径允许；越界仅指
    // 相对路径 resolve 后逃逸 baseDir 之外（无上界，永远合法）。
    const absolutePath = resolve(access.baseDir, value === '' ? '.' : value)
    return { absolutePath }
  }

  // contained 模式：相对路径基于冻结 root；绝对路径仅 root 内放行。
  const root = resolve(access.root)
  const realRoot = canonicalizeAllowedRoot(root)
  if (value !== '' && isAbsolute(value)) {
    const absolutePath = resolve(value)
    if (!isInside(root, absolutePath)) {
      throw new McpGuardError('FH2_MCP_PATH_ESCAPE', `绝对路径越出 allowed root：${absolutePath}。Absolute path escapes the allowed root.`)
    }
  } else if (value !== '' && value !== '.') {
    const normalized = resolve(value).split(sep).join('/')
    if (normalized === '..' || normalized.startsWith('../')) {
      throw new McpGuardError('FH2_MCP_PATH_ESCAPE', 'path 逃逸出 allowed root。Path escapes the allowed root.')
    }
  }

  // '.' 与空串 = allowed root 自身；其余必须收敛在 root 内。
  const absolutePath = resolve(root, value === '' || value === '.' ? '.' : value)
  if (!isInside(root, absolutePath)) {
    throw new McpGuardError('FH2_MCP_PATH_ESCAPE', 'path 逃逸出 allowed root。Path escapes the allowed root.')
  }

  // symlink 复核：目标可能不存在（新建/inspect 空目录），退回最近已存在祖先取真实路径。
  const anchor = nearestExistingAncestor(absolutePath)
  if (anchor === undefined) {
    throw new McpGuardError('FH2_MCP_PATH_ESCAPE', 'path 逃逸出 allowed root。Path escapes the allowed root.')
  }
  const realAnchor = realpathSync(anchor)
  const suffix = relative(anchor, absolutePath)
  const realTarget = suffix === '' ? realAnchor : resolve(realAnchor, suffix)
  if (!isInside(realRoot, realTarget)) {
    throw new McpGuardError(
      'FH2_MCP_PATH_ESCAPE',
      `path 经符号链接越出 allowed root（被 --root 边界拦截；目标属于边界外工程时请去掉 --root 或更换 root 后重启）。Path escapes the allowed root via symlink.`,
    )
  }
  return { absolutePath }
}

function isInside (root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (!fromRoot.startsWith('..') && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

function nearestExistingAncestor (absolutePath: string): string | undefined {
  let current = absolutePath
  for (;;) {
    if (existsLstat(current)) return current
    const parent = resolve(current, '..')
    if (parent === current) return undefined
    current = parent
  }
}

function existsLstat (path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
