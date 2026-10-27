// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { ArtifactDescriptor, Diagnostic } from '../../contracts/index.js'
import { buildBackendPlugin } from '../../backend/build.js'
import { tryDiscoverCommandContext } from '../../capability/discovery.js'
import type { CommandContext } from '../../capability/types.js'
import { buildCapability, buildIndustryCapabilityWorkspace } from '../../capability/build.js'
import { CapabilityError } from '../../capability/types.js'
import { createPluginBuildRunner } from '../../build/runner.js'
import { isCapabilityBuildConfigSelection } from '../../build/policy.js'
import { PluginBuildError } from '../../build/types.js'
import type { BuildDiagnostic } from '../../build/types.js'
import { computeSourceRevision } from '../source-revision.js'
import { typecheckBackendProject, typecheckFrontendProject } from '../typecheck/run.js'
import { resolveRuntimeProfile } from './runtime-profile.js'
import type { BackendLanguageProfile, FrontendLanguageProfile } from './runtime-profile.js'
import { relativeToRoot } from './shared.js'
import type { MemberOutcome } from './shared.js'

/**
 * S6：Build Application Service（实施计划 §3.4）。
 *
 * - 用户显式 Build 与 production Build 默认执行 Typecheck；类型错误使任务失败
 *   （提交前拦截，不产出新 dist）；
 * - 缺少必要配置/工具时返回明确诊断，不标 typechecked；
 * - 覆盖四类根目录：Capability / 行业工作区 / 前端插件 / 后端插件；
 * - 复用既有候选目录/事务提交与 fan-out；扇出成员业务失败不中断后续成员，
 *   整体 ok = 全部成员成功；
 * - ArtifactDescriptor 使用 dist 内容摘要；sourceRevision 由 executor（T6）注入。
 */

export interface BuildProjectOptions {
  /** production 默认 true（§3.4）；显式 false 仅用于内部调试链路。 */
  readonly typecheck?: boolean;
  readonly frontend?: readonly string[];
  readonly backend?: readonly string[];
  readonly configPath?: string;
  /** executor 注入的 initialRevision；回显到 Artifact。 */
  readonly sourceRevision?: string;
  /** T6 executor 持锁调用：内部 buildCapability 不二次抢锁。 */
  readonly operationLockHeld?: boolean;
  readonly abortSignal?: AbortSignal;
}

export interface BuildProjectResult {
  readonly root: string;
  readonly kind: import('../../contracts/index.js').WorkspaceKind;
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly members: readonly MemberOutcome[];
  /** dist 根相对 root 的 POSIX 路径。 */
  readonly outputs: readonly string[];
  readonly artifacts: readonly ArtifactDescriptor[];
  /** 全部适用成员都真实执行并通过 Typecheck。 */
  readonly typechecked: boolean;
}

export async function buildProject (rawRoot: string, options: BuildProjectOptions = {}): Promise<BuildProjectResult> {
  const root = resolve(rawRoot)
  const runTypecheck = options.typecheck !== false
  // ArtifactDescriptor.sourceRevision 为必填契约：executor 注入 initialRevision，
  // 直接调用（Serve/CLI 同步路径）时在入口计算一次。
  const sourceRevision = options.sourceRevision ?? computeSourceRevision(root)
  let context = tryDiscoverCommandContext(root)
  if (context === undefined) {
    return unrecognizedResult(root)
  }

  const filtered = (options.frontend?.length ?? 0) > 0 || (options.backend?.length ?? 0) > 0
  if (filtered && context.kind !== 'capability-project') throw new Error('--frontend/--backend 只能在 Capability 根使用。')
  if (options.configPath && context.kind === 'industry-capability-workspace') throw new Error('行业工作区不支持 --config。')
  if (context.kind === 'capability-project') {
    if (options.configPath && !isCapabilityBuildConfigSelection(new Set(options.frontend))) throw new Error('Capability 自定义 config 需要选择一个前端插件。')
    if (filtered) {
      for (const id of options.frontend ?? []) {
        if (!context.frontend.some(project => project.id === id)) throw new Error(`未知前端插件：${id}`)
      }
      for (const id of options.backend ?? []) {
        if (!context.backend.some(project => project.id === id)) throw new Error(`未知后端插件：${id}`)
      }
      context = { ...context, frontend: context.frontend.filter(project => options.frontend?.includes(project.id)), backend: context.backend.filter(project => options.backend?.includes(project.id)) }
    }
  }

  if (runTypecheck) {
    const gate = await typecheckGate(root, context.kind === 'capability-project' ? new Set([...context.frontend, ...context.backend].map(project => project.root)) : undefined)
    if (!gate.ok) {
      return {
        root,
        kind: context.kind,
        ok: false,
        diagnostics: gate.diagnostics,
        members: gate.members,
        outputs: [],
        artifacts: [],
        typechecked: false,
      }
    }
  }

  if (context.kind === 'industry-capability-workspace') {
    return await buildWorkspace(context, options, sourceRevision)
  }
  if (context.kind === 'capability-project') {
    return await buildCapabilityRoot(context, options, runTypecheck, sourceRevision)
  }
  if (context.kind === 'backend-plugin') {
    let result: Awaited<ReturnType<typeof buildBackendPlugin>>
    try {
      result = await buildBackendPlugin(context.root)
    } catch (error) {
      if (error instanceof PluginBuildError) return failedBuildResult(root, 'backend-plugin', error.diagnostics)
      throw error
    }
    return {
      root,
      kind: 'backend-plugin',
      ok: true,
      diagnostics: result.diagnostics.map(diagnostic => fromBuildDiagnostic(root, diagnostic)),
      members: [],
      outputs: [joinRelativeTo(root, context.root, 'dist')],
      artifacts: [distArtifact('backend-dist', context.root, root, 'backend', context.root, sourceRevision, runTypecheck)],
      typechecked: runTypecheck,
    }
  }
  // frontend-plugin：单插件走既有 Runner（候选目录 + 原子提交）。
  let session: Awaited<ReturnType<typeof createPluginBuildRunner>> | undefined
  try {
    session = await createPluginBuildRunner({ cwd: context.root, expectedManifestPath: context.manifestPath, watch: false, ...(options.configPath ? { configPath: options.configPath } : {}) })
    await session.firstBuild
  } catch (error) {
    if (error instanceof PluginBuildError) return failedBuildResult(root, 'frontend-plugin', error.diagnostics)
    throw error
  } finally {
    await session?.close()
  }
  return {
    root,
    kind: 'frontend-plugin',
    ok: true,
    diagnostics: [],
    members: [],
    outputs: [joinRelativeTo(root, context.root, 'dist')],
    artifacts: [distArtifact('frontend-dist', context.root, root, 'frontend', context.root, sourceRevision, runTypecheck)],
    typechecked: runTypecheck,
  }
}

async function buildCapabilityRoot (
  context: Extract<CommandContext, { kind: 'capability-project' }>,
  options: BuildProjectOptions,
  typechecked: boolean,
  sourceRevision: string,
): Promise<BuildProjectResult> {
  const root = context.root
  try {
    const result = await buildCapability({
      capability: context,
      ...(options.configPath ? { frontendConfigPath: options.configPath } : {}),
      ...(options.operationLockHeld === true ? { operationLockHeld: true } : {}),
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    })
    const outputs = result.ok
      ? [...context.frontend, ...context.backend]
          .map(project => joinRelativeTo(root, root, `${project.root}/dist`))
          .sort()
      : []
    return {
      root,
      kind: 'capability-project',
      ok: result.ok,
      diagnostics: result.diagnostics.map(diagnostic => fromBuildDiagnostic(root, diagnostic)),
      members: [],
      outputs,
      artifacts: result.ok
        ? [...context.frontend, ...context.backend].map(project =>
            distArtifact(
              project.manifestPath.includes('/backend/') ? 'backend-dist' : 'frontend-dist',
              project.root,
              root,
              project.manifestPath.includes('/backend/') ? 'backend' : 'frontend',
              project.root,
              sourceRevision,
              typechecked,
            ))
        : [],
      typechecked,
    }
  } catch (error) {
    if (error instanceof PluginBuildError) {
      return failedBuildResult(root, 'capability-project', error.diagnostics)
    }
    throw error
  }
}

async function buildWorkspace (
  context: Extract<CommandContext, { kind: 'industry-capability-workspace' }>,
  options: BuildProjectOptions,
  sourceRevision: string,
): Promise<BuildProjectResult> {
  const root = context.root
  try {
    const result = await buildIndustryCapabilityWorkspace({
      workspace: context,
      ...(options.operationLockHeld === true ? { operationLockHeld: true } : {}),
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    })
    const outputs: string[] = []
    if (result.ok) {
      for (const capability of context.capabilities) {
        for (const project of [...capability.frontend, ...capability.backend]) {
          outputs.push(joinRelativeTo(root, root, `${project.root}/dist`))
        }
      }
    }
    return {
      root,
      kind: 'industry-capability-workspace',
      ok: result.ok,
      diagnostics: result.diagnostics.map(diagnostic => fromBuildDiagnostic(root, diagnostic)),
      members: result.capabilities.map(entry => ({
        label: entry.capability.capabilityId,
        ok: entry.result.ok,
        diagnostics: entry.result.diagnostics.map(diagnostic => fromBuildDiagnostic(root, diagnostic)),
      })),
      outputs: outputs.sort(),
      artifacts: result.ok
        ? context.capabilities.flatMap(capability => [...capability.frontend, ...capability.backend].map(project =>
            distArtifact(
              project.manifestPath.includes('/backend/') ? 'backend-dist' : 'frontend-dist',
              project.root,
              root,
              'workspace',
              project.root,
              sourceRevision,
              true,
            )))
        : [],
      typechecked: true,
    }
  } catch (error) {
    if (error instanceof PluginBuildError) {
      return failedBuildResult(root, 'industry-capability-workspace', error.diagnostics)
    }
    throw error
  }
}

/** Typecheck 前置门禁：任一适用成员失败则不启动任何构建提交。 */
async function typecheckGate (root: string, selected?: ReadonlySet<string>): Promise<{ ok: boolean; diagnostics: readonly Diagnostic[]; members: readonly MemberOutcome[] }> {
  const resolvedProfile = resolveRuntimeProfile(root)
  const profile = { ...resolvedProfile, frontend: resolvedProfile.frontend.filter(item => !selected || selected.has(item.root)), backend: resolvedProfile.backend.filter(item => !selected || selected.has(item.root)) }
  const diagnostics: Diagnostic[] = []
  const members: MemberOutcome[] = []
  const applicable: readonly (FrontendLanguageProfile | BackendLanguageProfile)[] = [
    ...profile.frontend,
    ...profile.backend.filter(member => member.sourceLanguage === 'typescript'),
  ]
  let ok = true
  for (const member of applicable) {
    const result = 'hasVue' in member
      ? await typecheckFrontendProject({ projectRoot: member.root, tsconfigPath: member.tsconfigPath, hasVue: member.hasVue })
      : await typecheckBackendProject({ projectRoot: member.root, tsconfigPath: member.tsconfigPath })
    if (!result.ok) ok = false
    diagnostics.push(...result.diagnostics)
    members.push({ label: member.id, ok: result.ok, diagnostics: result.diagnostics })
  }
  return { ok, diagnostics, members }
}

function distArtifact (
  kind: 'frontend-dist' | 'backend-dist',
  projectRoot: string,
  root: string,
  scope: string,
  idScope: string,
  sourceRevision: string,
  typechecked: boolean,
): ArtifactDescriptor {
  const distRoot = resolve(projectRoot, 'dist')
  const stats = directoryStats(distRoot)
  const base = {
    id: `${scope}-${idScope.replaceAll('/', '-').replaceAll('\\', '-')}-${kind}`,
    kind,
    path: relativeToRoot(root, distRoot),
    digest: stats.digest,
    size: stats.bytes,
    typechecked,
    stale: false,
  }
  return { ...base, sourceRevision }
}

/** dist 目录内容摘要与字节数（S7「用现有 hash 生成 ArtifactDescriptor」）。 */
export function directoryStats (root: string): { digest: string; bytes: number } {
  const files = collectFiles(root, root)
  files.sort()
  const digest = createHash('sha256')
  let bytes = 0
  for (const file of files) {
    const content = readFileSync(resolve(root, file))
    digest.update(file).update('\0').update(content).update('\n')
    bytes += content.byteLength
  }
  return { digest: digest.digest('hex'), bytes }
}

function collectFiles (root: string, directory: string, files: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      collectFiles(root, path, files)
      continue
    }
    if (!entry.isFile() || !statSync(path).isFile()) continue
    files.push(relative(root, path))
  }
  return files
}

function fromBuildDiagnostic (root: string, diagnostic: BuildDiagnostic): Diagnostic {
  return {
    code: diagnostic.code,
    phase: diagnostic.phase === 'compile' ? 'bundle' : 'code',
    file: diagnostic.file === undefined ? '.' : relativeToRoot(root, diagnostic.file),
    message: diagnostic.message,
    ...(diagnostic.hint === undefined ? {} : { hint: diagnostic.hint }),
    ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
    ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
    severity: diagnostic.severity ?? 'error',
  }
}

function joinRelativeTo (root: string, base: string, path: string): string {
  void base
  const value = relativeToRoot(root, path)
  return value.replaceAll('\\', '/')
}

function failedBuildResult (root: string, kind: import('../../contracts/index.js').WorkspaceKind, diagnostics: readonly BuildDiagnostic[]): BuildProjectResult {
  return {
    root,
    kind,
    ok: false,
    diagnostics: diagnostics.map(diagnostic => fromBuildDiagnostic(root, diagnostic)),
    members: [],
    outputs: [],
    artifacts: [],
    typechecked: false,
  }
}

function unrecognizedResult (root: string): BuildProjectResult {
  return {
    root,
    kind: 'unknown',
    ok: false,
    diagnostics: [{
      code: 'FH2_PROJECT_NOT_RECOGNIZED',
      phase: 'semantic',
      file: '.',
      message: '目标目录不是 Capability、前端插件或后端插件，无法构建。Target is not a buildable project.',
      severity: 'error',
    }],
    members: [],
    outputs: [],
    artifacts: [],
    typechecked: false,
  }
}

export { CapabilityError }
