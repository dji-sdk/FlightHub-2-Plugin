// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { ArtifactDescriptor, Diagnostic } from '../../contracts/index.js'
import { packBackendPlugin, packStandaloneFrontendPlugin } from '../../backend/pack.js'
import { tryDiscoverCommandContext } from '../../capability/discovery.js'
import type { CommandContext } from '../../capability/types.js'
import { packCapability, packIndustryCapabilityWorkspace } from '../../capability/pack.js'
import { computeSourceRevision } from '../source-revision.js'
import { typecheckBackendProject, typecheckFrontendProject } from '../typecheck/run.js'
import { resolveRuntimeProfile } from './runtime-profile.js'
import { relativeToRoot } from './shared.js'
import type { MemberOutcome } from './shared.js'
import { buildProject } from './build.js'

/**
 * S7：Pack Application Service（实施计划 §3.4）。
 *
 * - Typecheck 前置门禁与 Build 一致：类型错误阻止 Pack（production Artifact）；
 * - 复用现有 ZIP/hash 与候选目录事务；成员失败不产包；
 * - Artifact：capability-package（Capability/工作区）或插件交付物，digest 为 zip sha256；
 * - 上传始终是手动步骤：不生成/处理 SIGNATURE。
 */

export interface PackProjectOptions {
  /** 跳过内部 Build（--no-build）；仍执行 Typecheck 门禁。 */
  readonly noBuild?: boolean;
  readonly outputRoot?: string;
  readonly sourceRevision?: string;
  /** T6 executor 持锁调用：内部 pack 不二次抢锁。 */
  readonly operationLockHeld?: boolean;
  /**
   * U2 打包范围：选中成员限定 id（单 Capability 根：`<memberId>`；
   * 行业工作区：`<capabilityId>` 或 `<capabilityId>/<memberId>`）。
   * undefined = 全量；与 noBuild 互斥。
   */
  readonly members?: ReadonlySet<string>;
  /** 取消传播：中断 typecheck 与内部 build 的挂起子进程（IDE-014-06）。 */
  readonly abortSignal?: AbortSignal;
}

export interface PackProjectResult {
  readonly root: string;
  readonly kind: import('../../contracts/index.js').WorkspaceKind;
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly members: readonly MemberOutcome[];
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly typechecked: boolean;
}

export async function packProject (rawRoot: string, options: PackProjectOptions = {}): Promise<PackProjectResult> {
  const root = resolve(rawRoot)
  const sourceRevision = options.sourceRevision ?? computeSourceRevision(root)
  const context = tryDiscoverCommandContext(root)
  if (context === undefined) {
    return {
      root,
      kind: 'unknown',
      ok: false,
      diagnostics: [unrecognizedDiagnostic()],
      members: [],
      artifacts: [],
      typechecked: false,
    }
  }
  // U2：成员范围只对 Capability / 行业工作区根有效；插件根带 members 视为非法请求。
  const memberScopeValid = context.kind === 'capability-project' || context.kind === 'industry-capability-workspace'
  if (options.members !== undefined && !memberScopeValid) {
    return {
      root,
      kind: context.kind,
      ok: false,
      diagnostics: [memberScopeDiagnostic(root, '打包范围参数只支持 Capability 或行业工作区根。Member selection requires a Capability or workspace root.')],
      members: [],
      artifacts: [],
      typechecked: false,
    }
  }
  const members = memberScopeValid ? options.members : undefined
  if (options.members !== undefined && options.noBuild === true) {
    return {
      root,
      kind: context.kind,
      ok: false,
      diagnostics: [memberScopeDiagnostic(root, '按成员打包与 --no-build 不能同时使用：部分成员打包必须执行完整构建。Members filter cannot be combined with --no-build.')],
      members: [],
      artifacts: [],
      typechecked: false,
    }
  }

  // Typecheck 前置门禁：类型错误阻止 production Artifact 交付；只查选中成员。
  if (options.abortSignal?.aborted) throw new Error('Pack 已被取消。Pack was aborted.')
  const profile = resolveRuntimeProfile(root)
  const gate = await typecheckGate(root, profile, membersOfProfile(profile, context.kind, members), options.abortSignal)
  if (!gate.ok) {
    return { root, kind: context.kind, ok: false, diagnostics: gate.diagnostics, members: gate.members, artifacts: [], typechecked: false }
  }

  if (context.kind === 'industry-capability-workspace') {
    const result = await packIndustryCapabilityWorkspace({
      workspace: context,
      ...(options.outputRoot ? { outputRoot: options.outputRoot } : {}),
      ...(options.operationLockHeld === true ? { operationLockHeld: true } : {}),
      ...(members === undefined ? {} : { members }),
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    })
    return {
      root,
      kind: 'industry-capability-workspace',
      ok: true,
      diagnostics: result.warnings.map(warning => packWarning(root, warning)),
      members: [],
      artifacts: [zipArtifact('capability-package', result.zipPath, root, 'workspace', result.packageId, sourceRevision)],
      typechecked: true,
    }
  }
  if (context.kind === 'capability-project') {
    const result = await packCapability({
      capability: context,
      ...(options.outputRoot ? { outputRoot: options.outputRoot } : {}),
      ...(options.noBuild === true ? { noBuild: true } : {}),
      ...(options.operationLockHeld === true ? { operationLockHeld: true } : {}),
      ...(members === undefined ? {} : { members }),
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    })
    return {
      root,
      kind: 'capability-project',
      ok: true,
      diagnostics: result.warnings.map(warning => packWarning(root, warning)),
      members: [],
      artifacts: [zipArtifact('capability-package', result.zipPath, root, 'capability', result.packageId, sourceRevision)],
      typechecked: true,
    }
  }

  // 插件级 Pack：先 Build（含 Typecheck，S6），再打插件交付物。
  if (options.noBuild !== true) {
    const built = await buildProject(root, {
      // Pack 已在上方完成一次 Typecheck 前置门禁；内部 Build 只负责候选产物提交，避免重复检查。
      typecheck: false,
      ...(options.sourceRevision === undefined ? {} : { sourceRevision: options.sourceRevision }),
      ...(options.operationLockHeld === true ? { operationLockHeld: true } : {}),
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    })
    if (!built.ok) {
      return { root, kind: context.kind, ok: false, diagnostics: built.diagnostics, members: built.members, artifacts: [], typechecked: built.typechecked }
    }
  }
  const outputRoot = options.outputRoot ?? resolve(context.root, 'release')
  const result = context.kind === 'frontend-plugin'
    ? await packStandaloneFrontendPlugin({ projectRoot: context.root, outputRoot })
    : await packBackendPlugin({ pluginRoot: context.root, ...(outputRoot === undefined ? {} : { outputRoot }) })
  return {
    root,
    kind: context.kind,
    ok: true,
    diagnostics: result.warnings.map(warning => packWarning(root, warning)),
    members: [],
    artifacts: [zipArtifact('capability-package', result.zipPath, root, 'plugin', basename(result.zipPath, '.zip'), sourceRevision)],
    typechecked: true,
  }
}

interface PackWarning {
  readonly code: string;
  readonly file?: string;
  readonly message: string;
}

function packWarning (root: string, warning: PackWarning): Diagnostic {
  return {
    code: warning.code,
    phase: 'bundle',
    file: warning.file === undefined ? '.' : relativeToRoot(root, warning.file),
    message: warning.message,
    severity: 'warning',
  }
}

function zipArtifact (
  kind: 'capability-package',
  zipPath: string,
  root: string,
  scope: string,
  name: string,
  sourceRevision: string,
): ArtifactDescriptor {
  const bytes = readFileSync(zipPath)
  const base = {
    id: `${scope}-${name.replaceAll('/', '-').replaceAll('\\', '-')}-${kind}`,
    kind,
    path: relativeToRoot(root, zipPath),
    digest: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
    typechecked: true,
    stale: false,
  }
  return { ...base, sourceRevision }
}

async function typecheckGate (
  root: string,
  profile: ReturnType<typeof resolveRuntimeProfile>,
  memberFilter: ReadonlySet<string> | undefined,
  abortSignal?: AbortSignal,
): Promise<{ ok: boolean; diagnostics: readonly Diagnostic[]; members: readonly MemberOutcome[] }> {
  const diagnostics: Diagnostic[] = []
  const members: MemberOutcome[] = []
  const applicable = [
    ...profile.frontend,
    ...profile.backend.filter(member => member.sourceLanguage === 'typescript'),
  ].filter(member => memberFilter === undefined || memberFilter.has(member.id))
  let ok = true
  for (const member of applicable) {
    if (abortSignal?.aborted) throw new Error('Pack 已被取消。Pack was aborted.')
    const result = 'hasVue' in member
      ? await typecheckFrontendProject({ projectRoot: member.root, tsconfigPath: member.tsconfigPath, hasVue: member.hasVue, ...(abortSignal === undefined ? {} : { abortSignal }) })
      : await typecheckBackendProject({ projectRoot: member.root, tsconfigPath: member.tsconfigPath, ...(abortSignal === undefined ? {} : { abortSignal }) })
    if (!result.ok) ok = false
    diagnostics.push(...result.diagnostics)
    members.push({ label: member.id, ok: result.ok, diagnostics: result.diagnostics })
  }
  return { ok, diagnostics, members }
}

function memberScopeDiagnostic (root: string, messageText: string): Diagnostic {
  return {
    code: 'FH2_PACK_MEMBERS_INVALID',
    phase: 'semantic',
    file: relativeToRoot(root, root),
    message: messageText,
    severity: 'error',
  }
}

/**
 * 把「选中成员限定 id」翻译成 runtime profile 的成员 id 集合：
 * - 单 Capability 根：限定 id 即成员 id，原样使用；
 * - 行业工作区：`<capId>` 展开为该 Capability 的全部成员 id（无前缀），
 *   `<capId>/<memberId>` 取其 memberId 部分。
 */
function membersOfProfile (
  profile: ReturnType<typeof resolveRuntimeProfile>,
  kind: import('../../contracts/index.js').WorkspaceKind,
  members: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  if (members === undefined) return undefined
  if (kind !== 'industry-capability-workspace') return members
  const applicable = new Set([
    ...profile.frontend.map(member => member.id),
    ...profile.backend.map(member => member.id),
  ])
  const selected = new Set<string>()
  for (const id of members) {
    const [capabilityId, memberId = ''] = id.split('/')
    if (memberId !== '') {
      selected.add(memberId)
      continue
    }
    // 整选 capability：无法从 profile 区分成员归属（id 无前缀），交给调用方上下文；
    // 这里保守包含全部已知成员 —— capability 级展开由 pack 装包层精确控制，
    // typecheck 多查几个成员只影响时间，不影响正确性。
    void capabilityId
    for (const known of applicable) selected.add(known)
  }
  return selected
}

function unrecognizedDiagnostic (): Diagnostic {
  return {
    code: 'FH2_PROJECT_NOT_RECOGNIZED',
    phase: 'semantic',
    file: '.',
    message: '目标目录不是 Capability、前端插件或后端插件，无法打包。Target is not a packable project.',
    severity: 'error',
  }
}

export type { CommandContext }
