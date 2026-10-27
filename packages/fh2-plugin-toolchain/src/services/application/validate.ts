// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { resolve } from 'node:path'
import type { Diagnostic } from '../../contracts/index.js'
import { validateBackendSourcePlugin } from '../../backend/source-contract.js'
import type { BackendSourceValidationResult } from '../../backend/source-contract.js'
import { tryDiscoverCommandContext } from '../../capability/discovery.js'
import type { CapabilityProject, CommandContext } from '../../capability/types.js'
import { validateCapability } from '../../capability/validate.js'
import type { CapabilityValidationDiagnostic, CapabilityValidationResult } from '../../capability/validate.js'
import { checkSourceCodeConsistency, isBlockingCodeConsistencyDiagnostic } from '../../validate/code-consistency.js'
import { validateSourceManifest } from '../../validate/index.js'
import type { ValidationDiagnostic, ValidationResult } from '../../validate/index.js'
import { relativeToRoot, toPosixRelative } from './shared.js'
import type { MemberOutcome } from './shared.js'

/**
 * S2：Validate Application Service。
 *
 * 三端（CLI / Serve / MCP）共用的校验入口：按 discovery 分发到 Capability /
 * 行业工作区 fan-out / 后端 Source Contract / 前端 Manifest + code 一致性。
 * 业务失败仍收集各成员诊断（fan-out 不因单成员失败中断）。
 */

export interface ValidateProjectResult {
  readonly root: string;
  readonly kind: import('../../contracts/index.js').WorkspaceKind;
  readonly ok: boolean;
  /** 统一 Protocol 诊断；file 为相对 root 的 POSIX 路径。 */
  readonly diagnostics: readonly Diagnostic[];
  /** 多成员工程（行业工作区）的逐成员结果。 */
  readonly members: readonly MemberOutcome[];
  /** capability-project 范围的原始结果，供 CLI 既有格式化复用。 */
  readonly capability?: CapabilityValidationResult;
  /** backend-plugin 范围的原始结果。 */
  readonly backend?: { readonly root: string; readonly result: BackendSourceValidationResult };
  /** frontend-plugin 范围的 manifest 校验与 code 一致性警告。 */
  readonly frontend?: {
    readonly manifestPath: string;
    readonly result: ValidationResult;
    readonly warnings: readonly ValidationDiagnostic[];
  };
}

export interface ValidateProjectOptions {
  readonly validateFrontend?: typeof validateSourceManifest;
  readonly checkCode?: typeof checkSourceCodeConsistency;
}

export function validateProject (rawRoot: string, options: ValidateProjectOptions = {}): ValidateProjectResult {
  const root = resolveRoot(rawRoot)
  const context = discover(root)
  const validateFrontend = options.validateFrontend ?? validateSourceManifest
  const checkCode = options.checkCode ?? checkSourceCodeConsistency

  if (context === undefined) {
    return {
      root,
      kind: 'unknown',
      ok: false,
      members: [],
      diagnostics: [notRecognizedDiagnostic()],
    }
  }
  if (context.kind === 'industry-capability-workspace') {
    return validateWorkspace(context, validateFrontend)
  }
  if (context.kind === 'capability-project') {
    const capability = validateCapability(context, validateFrontend)
    const diagnostics = capability.diagnostics.map(diagnostic => fromCapabilityDiagnostic(root, diagnostic, context))
    return { root, kind: 'capability-project', ok: capability.ok, members: [], diagnostics, capability }
  }
  if (context.kind === 'backend-plugin') {
    const result = validateBackendSourcePlugin(context.root)
    const diagnostics: Diagnostic[] = result.ok
      ? []
      : result.diagnostics.map(diagnostic => ({
          code: diagnostic.code,
          phase: 'contract' as const,
          file: joinRelative(relativeToRoot(root, context.root), diagnostic.file),
          ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
          message: diagnostic.message,
          severity: 'error' as const,
        }))
    return { root, kind: 'backend-plugin', ok: result.ok, members: [], diagnostics, backend: { root: context.root, result } }
  }

  const result = validateFrontend({ manifestPath: context.manifestPath })
  const prefix = relativeToRoot(root, context.root)
  if (!result.ok) {
    const diagnostics = result.diagnostics.map(diagnostic => fromValidationDiagnostic(prefix, diagnostic, 'error'))
    return { root, kind: 'frontend-plugin', ok: false, members: [], diagnostics, frontend: { manifestPath: context.manifestPath, result, warnings: [] } }
  }
  const warnings = checkCode({ manifest: result.manifest, manifestPath: context.manifestPath })
  const diagnostics = [
    ...result.warnings.map(warning => fromValidationDiagnostic(prefix, warning, 'warning')),
    ...warnings.map(diagnostic => fromValidationDiagnostic(
      prefix,
      diagnostic,
      isBlockingCodeConsistencyDiagnostic(diagnostic) ? 'error' : 'warning',
    )),
  ]
  const ok = diagnostics.every(diagnostic => diagnostic.severity !== 'error')
  return {
    root,
    kind: 'frontend-plugin',
    ok,
    members: [],
    diagnostics,
    frontend: { manifestPath: context.manifestPath, result, warnings },
  }
}

function validateWorkspace (
  context: Extract<CommandContext, { kind: 'industry-capability-workspace' }>,
  validateFrontend: typeof validateSourceManifest,
): ValidateProjectResult {
  const members: MemberOutcome[] = []
  const diagnostics: Diagnostic[] = []
  // 扇出：任一成员业务失败不中断后续成员，最终整体 ok = 全部成员通过。
  for (const capability of context.capabilities) {
    const result = validateCapability(capability, validateFrontend)
    const memberDiagnostics = result.diagnostics.map(diagnostic => fromCapabilityDiagnostic(context.root, diagnostic, capability, capability.capabilityId))
    members.push({ label: capability.capabilityId, ok: result.ok, diagnostics: memberDiagnostics })
    diagnostics.push(...memberDiagnostics)
  }
  return {
    root: context.root,
    kind: 'industry-capability-workspace',
    ok: members.every(member => member.ok),
    members,
    diagnostics,
  }
}

function fromCapabilityDiagnostic (
  root: string,
  diagnostic: CapabilityValidationDiagnostic,
  capability: CapabilityProject,
  memberPrefix?: string,
): Diagnostic {
  const file = diagnostic.file === undefined
    ? '.'
    : relativeToRoot(root, resolveMemberFile(capability, diagnostic))
  return {
    code: diagnostic.code,
    phase: 'contract',
    file,
    message: diagnostic.pluginId === undefined
      ? diagnostic.message
      : (memberPrefix === undefined || memberPrefix === diagnostic.pluginId || memberPrefix.startsWith(`${diagnostic.pluginId}/`)
          ? `[${diagnostic.side} ${diagnostic.pluginId}] ${diagnostic.message}`
          : `[${memberPrefix}/${diagnostic.side} ${diagnostic.pluginId}] ${diagnostic.message}`),
    severity: 'error',
  }
}

/**
 * 成员插件的诊断 `file` 相对该插件根，而 Capability/工作区诊断需要相对校验根。
 * 先按 side + pluginId 找到真实插件根再折算，避免把 `workflows/x.json` 当成
 * 工作区根下的同名文件（IDE 会因此跳到不存在的路径）。
 */
function resolveMemberFile (
  capability: CapabilityProject,
  diagnostic: CapabilityValidationDiagnostic,
): string {
  const projects: readonly { readonly id: string; readonly root: string }[]
    = diagnostic.side === 'frontend'
      ? capability.frontend
      : diagnostic.side === 'backend'
        ? capability.backend
        : []
  const project = diagnostic.pluginId === undefined
    ? undefined
    : projects.find(item => item.id === diagnostic.pluginId)
  const file = diagnostic.file!
  return project === undefined ? file : resolve(project.root, file)
}

function fromValidationDiagnostic (
  prefix: string,
  diagnostic: ValidationDiagnostic,
  severity: 'error' | 'warning',
): Diagnostic {
  return {
    code: diagnostic.code,
    phase: diagnostic.phase,
    file: joinRelative(prefix, diagnostic.file),
    ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
    ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
    ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
    message: diagnostic.message,
    ...(diagnostic.hint === undefined ? {} : { hint: diagnostic.hint }),
    severity,
  }
}

function joinRelative (prefix: string, file: string): string {
  const posix = toPosixRelative(file)
  if (prefix === '' || prefix === '.') return posix
  return `${toPosixRelative(prefix)}/${posix}`
}

function notRecognizedDiagnostic (): Diagnostic {
  return {
    code: 'FH2_PROJECT_NOT_RECOGNIZED',
    phase: 'semantic',
    file: '.',
    message: '目标目录不是 Capability、前端插件或后端插件。Target is not a capability, frontend plugin, or backend plugin.',
    hint: '确认目录下存在 capabilities.json、packages.json 或 fh2-plugin.json。',
    severity: 'error',
  }
}

function resolveRoot (rawRoot: string): string {
  return resolve(rawRoot)
}

function discover (root: string): CommandContext | undefined {
  return tryDiscoverCommandContext(root)
}
