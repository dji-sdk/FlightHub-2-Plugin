// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { resolve } from 'node:path'
import type { Diagnostic } from '../../contracts/index.js'
import { createPluginProject } from '../../create/run.js'

/**
 * S4：Create Application Service。
 *
 * - 同步只生成工程（不安装依赖）：安装走 `install` Task（T7）；
 * - 复用 CLI 的模板机制（create/run.ts 是唯一事实源，不复制模板规则）；
 * - 已存在不覆盖、非法 ID 不落半成品（由 create 事务/staging 保证）；
 * - MCP 固定 `install=false`。
 */
export interface CreateProjectParams {
  /** Plugin ID（official_/exp_ 前缀小写短名）。 */
  readonly pluginId: string;
  /** 相对 root 的目标目录名（默认 = pluginId）。 */
  readonly directory?: string;
  /** 模板：默认 fullstack（独立前后端 Capability Workspace）。 */
  readonly template?: 'capability-fullstack' | 'frontend-basic' | 'backend-basic';
}

export interface CreateProjectResult {
  readonly ok: boolean;
  /** 创建的工程根（绝对路径）；失败时 undefined。 */
  readonly projectRoot?: string;
  readonly diagnostics: readonly Diagnostic[];
  /** create 机器的原始输出行（作为日志/诊断补充）。 */
  readonly log: readonly string[];
}

export async function createProject (rawRoot: string, params: CreateProjectParams): Promise<CreateProjectResult> {
  const root = resolve(rawRoot)
  const log: string[] = []
  const writer = {
    write (chunk: string) {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== '') log.push(line)
      }
      return true
    },
  }
  let projectRoot: string
  try {
    const result = await createPluginProject({
      directory: params.directory ?? params.pluginId,
      pluginId: params.pluginId,
      template: params.template ?? 'frontend-basic',
      install: false,
    }, { cwd: root, stdinIsTTY: false, enforceDependencySource: true, stderr: writer })
    projectRoot = result.targetDir
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{ code: 'FH2_CREATE_FAILED', phase: 'parse', file: '.', message: error instanceof Error ? error.message : String(error), severity: 'error' }],
      log,
    }
  }
  return {
    ok: true,
    projectRoot,
    diagnostics: [],
    log,
  }
}
