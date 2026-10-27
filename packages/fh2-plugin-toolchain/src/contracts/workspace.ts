// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 工作区 kind 与能力矩阵（实施计划 §3.2）。
 *
 * - 旧工作区 kind 值 `capability` 已一次性迁移为 `capability-project`（Wave 0 / C2），
 *   不保留旧值；`CapabilityProject` 等业务词汇不受影响。
 * - `industry-capability-workspace` 是合法 kind，前端事件白名单必须包含（修复历史遗漏）。
 */
export type WorkspaceKind =
  | 'capability-project'
  | 'industry-capability-workspace'
  | 'frontend-plugin'
  | 'backend-plugin'
  | 'unknown'

export const WORKSPACE_KINDS: readonly WorkspaceKind[] = [
  'capability-project',
  'industry-capability-workspace',
  'frontend-plugin',
  'backend-plugin',
  'unknown',
]

export interface WorkspaceInfo {
  readonly root: string;
  readonly name: string;
  readonly kind: WorkspaceKind;
  readonly toolchainVersion: string;
}

/**
 * 宽容解析：不在词表内的 kind 落到 `unknown`。
 * 这是 kind 的既有语义（与 schemaVersion 的严格失败不同）；调用方无需把未知 kind 当错误。
 */
export function parseWorkspaceKind (value: unknown): WorkspaceKind {
  return typeof value === 'string' && (WORKSPACE_KINDS as readonly string[]).includes(value)
    ? value as WorkspaceKind
    : 'unknown'
}

export type WorkspaceOperation =
  | 'inspect'
  | 'validate'
  | 'generate'
  | 'build'
  | 'pack'
  | 'dev'
  | 'preview'

export const WORKSPACE_OPERATIONS: readonly WorkspaceOperation[] = [
  'inspect',
  'validate',
  'generate',
  'build',
  'pack',
  'dev',
  'preview',
]

export type WorkspaceCapabilityMatrix = Readonly<Record<WorkspaceOperation, boolean>>

/**
 * 冻结的工作区能力矩阵（§3.2）：
 *
 * | 操作      | capability-project | industry-capability-workspace | frontend-plugin | backend-plugin | unknown |
 * |-----------|----|----|----|----|----|
 * | Inspect   | ✓  | ✓  | ✓  | ✓  | ✓（只读识别） |
 * | Validate  | ✓  | ✓  | ✓  | ✓  | ✗ |
 * | Generate  | ✓  | ✓  | ✓  | ✓  | ✗ |
 * | Build     | ✓  | ✓  | ✓  | ✓  | ✗ |
 * | Pack      | ✓  | ✓  | ✓  | ✓  | ✗ |
 * | Dev       | ✓  | 首版不支持 | ✓  | ✗  | ✗ |
 * | Preview   | ✓（前端） | 首版不支持 | ✓（前端） | ✗ | ✗ |
 */
export const WORKSPACE_CAPABILITIES: Readonly<Record<WorkspaceKind, WorkspaceCapabilityMatrix>> = {
  'capability-project': {
    inspect: true,
    validate: true,
    generate: true,
    build: true,
    pack: true,
    dev: true,
    preview: true,
  },
  'industry-capability-workspace': {
    inspect: true,
    validate: true,
    generate: true,
    build: true,
    pack: true,
    dev: false,
    preview: false,
  },
  'frontend-plugin': {
    inspect: true,
    validate: true,
    generate: true,
    build: true,
    pack: true,
    dev: true,
    preview: true,
  },
  'backend-plugin': {
    inspect: true,
    validate: true,
    generate: true,
    build: true,
    pack: true,
    dev: false,
    preview: false,
  },
  unknown: {
    inspect: true,
    validate: false,
    generate: false,
    build: false,
    pack: false,
    dev: false,
    preview: false,
  },
}

export function supportsWorkspaceOperation (kind: WorkspaceKind, operation: WorkspaceOperation): boolean {
  return WORKSPACE_CAPABILITIES[kind][operation]
}
