// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * `POST /api/workflow/validate`：浏览器快速预检的服务端一半（计划 §C3 搬出 ide-server）。
 *
 * ⚠️⚠️ 它做的是**语义预检**，不是权威静态裁决：
 * 本轮没有同版本 worker checker（knowledge.json 的 checkers 恒为空），
 * 故它的 `ok: true` 只说明「结构与引用在当前词表下解得开」，
 * **不说明**能部署、也不说明真机跑得通。调用方不得据此显示结论性字样。
 *
 * ⓘ 这里同步调 `resolveIdeActions`（不走知识解析的那条异步入口）：
 * 预检在编辑过程中会被高频调用，而知识包内容装好后不可变，
 * 由路由层把已解析的 Catalog 传进来更合适 —— 见 ValidateWorkflowOptions.catalog。
 */

import type { Diagnostic } from '../../contracts/index.js'
import { IdeRequestError } from '../../contracts/ide.js'
import type { ActionCatalog } from '../core/catalog.js'
import { toCatalog } from '../core/catalog.js'
import { toGraph } from '../core/projection.js'
import { validateSemantics } from '../core/semantics.js'
import { resolveIdeActions } from './catalog.js'

export interface ValidateWorkflowResult {
  /**
   * 没有 error 级问题。
   * ⚠️ 不要把它读成「可部署」：见文件头那段 ⚠️⚠️。
   */
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ValidateWorkflowOptions {
  /** 已解析好的平台 Catalog；缺省时按内建快照现算（预检不该为此变成异步）。 */
  readonly catalog?: ActionCatalog;
}

export function validateWorkflowRequest (
  requestRoot: string,
  body: Record<string, unknown>,
  options: ValidateWorkflowOptions = {},
): ValidateWorkflowResult {
  const raw = body.workflow
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', 'workflow 必须是 JSON 对象。"workflow" must be a JSON object.')
  }
  const catalog = options.catalog ?? toCatalog(resolveIdeActions({
    root: requestRoot,
    ...(typeof body.path === 'string' ? { workflowPath: body.path } : {}),
  }))
  const issues = validateSemantics(catalog, { raw: raw as Record<string, unknown> })
  const workflowPath = typeof body.path === 'string' && body.path !== '' ? body.path : '.'
  const diagnostics: Diagnostic[] = issues.map(issue => ({
    code: issue.rule,
    phase: 'semantic',
    file: workflowPath,
    ...(issue.inputKey === undefined ? {} : { path: `${workflowPath}#${issue.nodeId}:${issue.inputKey}` }),
    message: issue.message,
    severity: issue.level === 'error' ? 'error' : 'warning',
  }))
  // 结构问题（环/悬空 needs/重复条目/重复或保留 id/空 steps）此前只由画布本地报，
  // 预检不拦——交付门因此放过立不住的图。这里把 toGraph 的结构结论并进预检，
  // 与画布、CLI 校验保持同一套判据。
  for (const issue of toGraph({ raw: raw as Record<string, unknown> }).issues) {
    diagnostics.push({
      code: issue.code,
      phase: 'semantic',
      file: workflowPath,
      path: `${workflowPath}#${issue.nodeId}`,
      message: issue.message,
      severity: 'error',
    })
  }
  return { ok: diagnostics.every(diagnostic => diagnostic.severity !== 'error'), diagnostics }
}
