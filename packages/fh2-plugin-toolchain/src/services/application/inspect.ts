// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { basename, resolve } from 'node:path'
import type { Diagnostic } from '../../contracts/index.js'
import { detectCommandContextKind, tryDiscoverCommandContext } from '../../capability/discovery.js'
import { CapabilityError } from '../../capability/types.js'
import type { CommandContext } from '../../capability/types.js'
import { relativeToRoot } from './shared.js'

/**
 * S1a：项目 Inspect Application Service。
 *
 * - 复用现有 discovery，不另建识别规则；
 * - 普通目录返回 `unknown`，不报错（Web IDE 仍需打开目录去修它）；
 * - 行业工作区成员与单独打开成员 Capability 的结果一致（成员列表同源）。
 */

export interface InspectMember {
  /** 插件 ID。 */
  readonly id: string;
  /** 相对被检查根的 POSIX 路径。 */
  readonly relativePath: string;
  readonly side: 'frontend' | 'backend';
  readonly manifestPath: string;
}

export interface InspectCapability {
  /** Capability ID（目录名）。 */
  readonly id: string;
  readonly relativePath: string;
  readonly members: readonly InspectMember[];
}

export interface InspectResult {
  /** 解析后的绝对根。 */
  readonly root: string;
  readonly kind: import('../../contracts/index.js').WorkspaceKind;
  readonly name: string;
  /** 插件根的清单相对路径；Capability/工作区根为 undefined。 */
  readonly manifestPath?: string;
  /** Capability 根的直接成员；插件根为空。 */
  readonly members: readonly InspectMember[];
  /** 行业工作区的成员 Capability；其他根为空。 */
  readonly capabilities: readonly InspectCapability[];
  /** discovery 失败（如 capabilities.json 损坏）时的诊断；kind 仍由根目录标志文件确定。 */
  readonly diagnostics: readonly Diagnostic[];
}

export interface InspectProjectOptions {
  readonly resolveContext?: typeof tryDiscoverCommandContext;
}

export function inspectProject (rawRoot: string, options: InspectProjectOptions = {}): InspectResult {
  const root = resolve(rawRoot)
  let context: CommandContext | undefined
  try {
    context = (options.resolveContext ?? tryDiscoverCommandContext)(root)
  } catch (error) {
    return {
      root,
      kind: detectCommandContextKind(root) ?? 'unknown',
      name: basename(root),
      members: [],
      capabilities: [],
      diagnostics: [discoveryFailureDiagnostic(root, error)],
    }
  }
  if (context === undefined) {
    return { root, kind: 'unknown', name: basename(root), members: [], capabilities: [], diagnostics: [] }
  }
  if (context.kind === 'capability-project') {
    return {
      root,
      kind: 'capability-project',
      name: context.capabilityId,
      members: pluginMembers(root, context.frontend, 'frontend', context.backend, 'backend'),
      capabilities: [],
      diagnostics: [],
    }
  }
  if (context.kind === 'industry-capability-workspace') {
    const capabilities = context.capabilities.map(capability => ({
      id: capability.capabilityId,
      relativePath: relativeToRoot(root, capability.root),
      members: pluginMembers(
        root,
        capability.frontend,
        'frontend',
        capability.backend,
        'backend',
      ),
    }))
    return { root, kind: 'industry-capability-workspace', name: basename(root), members: [], capabilities, diagnostics: [] }
  }
  return {
    root,
    kind: context.kind,
    name: basename(root),
    manifestPath: relativeToRoot(root, context.manifestPath),
    members: [],
    capabilities: [],
    diagnostics: [],
  }
}

function pluginMembers (
  root: string,
  frontend: readonly { readonly id: string; readonly root: string; readonly manifestPath: string }[],
  frontendSide: 'frontend',
  backend: readonly { readonly id: string; readonly root: string; readonly manifestPath: string }[],
  backendSide: 'backend',
): readonly InspectMember[] {
  return [
    ...frontend.map(project => member(root, project, frontendSide)),
    ...backend.map(project => member(root, project, backendSide)),
  ]
}

function member (
  root: string,
  project: { readonly id: string; readonly root: string; readonly manifestPath: string },
  side: 'frontend' | 'backend',
): InspectMember {
  return {
    id: project.id,
    side,
    relativePath: relativeToRoot(root, project.root),
    manifestPath: relativeToRoot(root, project.manifestPath),
  }
}

function discoveryFailureDiagnostic (root: string, error: unknown): Diagnostic {
  const message = error instanceof Error ? error.message : String(error)
  return {
    code: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'FH2_PROJECT_DISCOVERY_FAILED',
    phase: 'schema',
    file: error instanceof CapabilityError && error.file !== undefined
      ? relativeToRoot(root, error.file)
      : '.',
    message: `项目识别失败：${message} Project discovery failed: ${message}`,
    hint: root,
    severity: 'error',
  }
}
