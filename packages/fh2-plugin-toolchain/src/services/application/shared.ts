// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { relative, resolve, sep } from 'node:path'
import type { Diagnostic, WorkspaceKind } from '../../contracts/index.js'

/**
 * Application Service 层共享类型（实施计划 §3.7 A2 行）。
 *
 * 服务层是 CLI / Serve / MCP 共用的唯一能力内核：入参是绝对 root（或工作区内相对路径），
 * 出参是结构化结果（Protocol Diagnostic 等），不打印、不格式化、不解析 CLI 文案。
 */
export type { Diagnostic, WorkspaceKind }

/** 长任务的输出适配由调用方注入；应用服务不依赖 CLI。 */
export interface OutputWriter {
  write(chunk: string): unknown;
}

/** 多成员工程（Capability / 行业工作区）的逐成员结果。 */
export interface MemberOutcome {
  /** 成员标签：Capability ID 或插件 ID。 */
  readonly label: string;
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * 把绝对路径折算成相对 root 的 POSIX 路径。
 * 越界路径（外部依赖等）原样保留，消费方按不可跳转处理。
 */
export function relativeToRoot (root: string, file: string): string {
  const resolvedRoot = resolve(root)
  const resolvedFile = resolve(resolvedRoot, file)
  const fromRoot = relative(resolvedRoot, resolvedFile)
  if (fromRoot === '') return '.'
  return fromRoot.startsWith('..') ? file.replaceAll(sep, '/') : fromRoot.replaceAll(sep, '/')
}

export function toPosixRelative (value: string): string {
  return value.replaceAll(sep, '/')
}
