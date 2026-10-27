// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { createTaskService } from '../tasks/factory.js'
import type { Diagnostic } from '../../contracts/index.js'
import { buildBackendPlugin } from '../../backend/build.js'
import type { BuildDiagnostic } from '../../build/types.js'
import { buildCapability } from '../../capability/build.js'
import { tryDiscoverCommandContext } from '../../capability/discovery.js'
import { CapabilityError } from '../../capability/types.js'
import type { CommandContext } from '../../capability/types.js'
import { createPluginBuildRunner } from '../../build/runner.js'
import { PluginBuildError } from '../../build/types.js'
import { inspectProject } from '../application/inspect.js'
import { validateProject } from '../application/validate.js'
import { IdeRequestError } from '../../contracts/ide.js'
import type { IdeBuildData, IdeDiagnostic, IdeValidateData, IdeWorkspaceData } from '../../contracts/ide.js'
import { resolveWorkspacePath } from './files.js'

export interface CapabilityBridgeOptions {
  readonly root: string;
  readonly toolchainVersion: string;
  /** F5：工作区会话 id，随工作根切换更新。 */
  readonly sessionId?: string;
  readonly resolveContext?: typeof tryDiscoverCommandContext;
  readonly validateProject?: typeof validateProject;
  readonly buildCapability?: typeof buildCapability;
  readonly buildBackendPlugin?: typeof buildBackendPlugin;
  readonly createRunner?: typeof createPluginBuildRunner;
}

/** 契约 2.1：工作根信息。marker 决定身份，严格上下文失败作为诊断返回。 */
export function describeWorkspace (options: CapabilityBridgeOptions): IdeWorkspaceData {
  const root = resolve(options.root)
  const inspection = inspectProject(root, options.resolveContext === undefined ? {} : { resolveContext: options.resolveContext })
  return {
    root,
    name: basename(root),
    kind: inspection.kind,
    toolchainVersion: options.toolchainVersion,
    sessionId: options.sessionId ?? '',
    diagnostics: inspection.diagnostics,
  }
}

/**
 * 契约 7.1：校验 `POST /api/workspace/open` 的 `root`。
 *
 * `root` 是整套 API 里唯一允许的绝对路径入参——它选择的是工作区本身而不是工作区
 * 内的某个位置，所以 {@link resolveWorkspacePath} 那套「收敛回工作根」的规则在这里
 * 不适用，只能自成一环：必须绝对、必须存在、必须被能力层认出来。
 */
export function resolveOpenWorkspaceRoot (
  options: Pick<CapabilityBridgeOptions, 'resolveContext'>,
  rawRoot: unknown,
): string {
  if (typeof rawRoot !== 'string' || rawRoot.trim() === '') {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', '缺少 root 参数。Missing "root" parameter.')
  }
  if (rawRoot.includes('\0')) {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', 'root 含非法字符。The "root" parameter contains an illegal character.')
  }
  if (!isAbsolute(rawRoot)) {
    throw new IdeRequestError(
      'FH2_IDE_BAD_REQUEST',
      `root 必须是绝对路径：${rawRoot}。The "root" parameter must be an absolute path: ${rawRoot}.`,
    )
  }
  const root = resolve(rawRoot)
  const invalid = (detail: string, detailEn: string): IdeRequestError => new IdeRequestError(
    'FH2_IDE_ROOT_INVALID',
    `${detail}：${root}。${detailEn}: ${root}.`,
  )
  let stats
  try {
    stats = statSync(root)
  } catch {
    throw invalid('工作根不存在', 'Workspace root does not exist')
  }
  if (!stats.isDirectory()) throw invalid('工作根不是目录', 'Workspace root is not a directory')
  const inspection = inspectProject(root, options.resolveContext === undefined ? {} : { resolveContext: options.resolveContext })
  if (inspection.kind === 'unknown') {
    throw invalid(
      '工作根不是 Capability、前端插件或后端插件',
      'Workspace root is not a capability, frontend plugin, or backend plugin',
    )
  }
  return root
}

/**
 * 契约 2.5：调用 Application Service 校验（S2）。
 *
 * Validate 统一走 `validateProject`（含行业工作区 fan-out），Serve 只做路径解析、
 * 前缀折算与错误映射；不再各自维护一份 discovery 分发。
 */
export async function runIdeValidate (
  options: CapabilityBridgeOptions,
  rawPath: unknown,
): Promise<IdeValidateData> {
  const started = Date.now()
  const targetRoot = rawPath === undefined || rawPath === null
    ? resolve(options.root)
    : resolveWorkspacePath(options.root, rawPath).absolutePath
  let result: ReturnType<typeof validateProject>
  try {
    result = (options.validateProject ?? validateProject)(targetRoot)
  } catch (error) {
    if (error instanceof CapabilityError) {
      throw new IdeRequestError('FH2_IDE_COMMAND_FAILED', `${error.code}：${error.message}`)
    }
    throw error
  }
  if (result.kind === 'unknown') {
    // 保持既有 Serve 契约码：目标不可识别时返回 FH2_IDE_CONTEXT_NOT_FOUND。
    return {
      ok: false,
      diagnostics: [{
        code: 'FH2_IDE_CONTEXT_NOT_FOUND',
        phase: 'semantic',
        file: relativeToRoot(options.root, targetRoot),
        message: '目标目录不是 Capability、前端插件或后端插件。Target is not a capability, frontend plugin, or backend plugin.',
        hint: '确认目录下存在 capabilities.json、fh2-plugin.json 或 plugin.json。',
        severity: 'error',
      }],
      durationMs: Date.now() - started,
    }
  }
  const prefix = relativeToRoot(options.root, targetRoot)
  const diagnostics = result.diagnostics.map(diagnostic => prefixDiagnostic(diagnostic, prefix))
  return {
    ok: result.ok && diagnostics.every(diagnostic => diagnostic.severity !== 'error'),
    diagnostics,
    durationMs: Date.now() - started,
  }
}

/** 把相对 targetRoot 的诊断 file 折算为相对工作根。 */
function prefixDiagnostic (diagnostic: Diagnostic, prefix: string): IdeDiagnostic {
  if (prefix === '' || prefix === '.') return diagnostic
  return { ...diagnostic, file: joinRelative(prefix, diagnostic.file) }
}

/**
 * 契约 2.6：调用能力层构建。
 *
 * `outputs` 取各插件 dist 根相对工作根的路径——契约示例给的是文件级路径，
 * 但能力层不回传文件清单，退而给出稳定的产物目录，语义上仍是「本次构建的产出」。
 */
export async function runIdeBuild (options: CapabilityBridgeOptions): Promise<IdeBuildData> {
  const started = Date.now()
  const root = resolve(options.root)
  if (!options.buildCapability && !options.buildBackendPlugin && !options.createRunner && !options.resolveContext) {
    const tasks = createTaskService()
    const owner = { ownerId: 'ide-build' }
    const task = await tasks.start(owner, { kind: 'build', root, params: {} })
    const result = await tasks.settle(owner, task.taskId)
    return { ok: result.state === 'succeeded', diagnostics: result.diagnostics, outputs: result.artifacts.map(artifact => artifact.path), durationMs: Date.now() - started }
  }
  const context = discoverContext(options, root)
  if (context === undefined) {
    return {
      ok: false,
      diagnostics: [{
        code: 'FH2_IDE_CONTEXT_NOT_FOUND',
        phase: 'semantic',
        file: '.',
        message: '工作根不是 Capability、前端插件或后端插件。Workspace root is not a capability, frontend plugin, or backend plugin.',
        severity: 'error',
      }],
      outputs: [],
      durationMs: Date.now() - started,
    }
  }

  if (context.kind === 'industry-capability-workspace') {
    return {
      ok: false,
      diagnostics: [workspaceRootUnsupportedDiagnostic('.')],
      outputs: [],
      durationMs: Date.now() - started,
    }
  }

  try {
    if (context.kind === 'capability-project') {
      const result = await (options.buildCapability ?? buildCapability)({ capability: context })
      const outputs = result.ok
        ? [...context.frontend, ...context.backend]
            .map(project => joinRelative(relativeToRoot(root, project.root), 'dist'))
            .sort()
        : []
      return {
        ok: result.ok,
        diagnostics: result.diagnostics.map(diagnostic => fromBuildDiagnostic(diagnostic)),
        outputs,
        durationMs: Date.now() - started,
      }
    }

    if (context.kind === 'backend-plugin') {
      const result = await (options.buildBackendPlugin ?? buildBackendPlugin)(context.root)
      return {
        ok: true,
        diagnostics: result.diagnostics.map(diagnostic => fromBuildDiagnostic(diagnostic)),
        outputs: [joinRelative(relativeToRoot(root, context.root), 'dist')],
        durationMs: Date.now() - started,
      }
    }

    const session = await (options.createRunner ?? createPluginBuildRunner)({
      cwd: context.root,
      expectedManifestPath: context.manifestPath,
      watch: false,
    })
    try {
      await session.firstBuild
    } finally {
      await session.close()
    }
    return {
      ok: true,
      diagnostics: [],
      outputs: [joinRelative(relativeToRoot(root, context.root), 'dist')],
      durationMs: Date.now() - started,
    }
  } catch (error) {
    if (error instanceof PluginBuildError) {
      return {
        ok: false,
        diagnostics: error.diagnostics.map(diagnostic => fromBuildDiagnostic(diagnostic)),
        outputs: [],
        durationMs: Date.now() - started,
      }
    }
    if (error instanceof CapabilityError) {
      return {
        ok: false,
        diagnostics: [{
          code: error.code,
          phase: 'contract',
          file: error.file === undefined ? '.' : relativeToRoot(root, error.file),
          message: error.message,
          severity: 'error',
        }],
        outputs: [],
        durationMs: Date.now() - started,
      }
    }
    throw new IdeRequestError(
      'FH2_IDE_COMMAND_FAILED',
      `构建失败：${errorMessage(error)}。Build failed: ${errorMessage(error)}.`,
    )
  }
}

function discoverContext (options: CapabilityBridgeOptions, root: string): CommandContext | undefined {
  try {
    return (options.resolveContext ?? tryDiscoverCommandContext)(root)
  } catch (error) {
    if (error instanceof CapabilityError) {
      throw new IdeRequestError('FH2_IDE_COMMAND_FAILED', `${error.code}：${error.message}`)
    }
    throw error
  }
}

/**
 * 行业工作区根的构建暂不支持（S6/T6 将改为 TaskService fan-out）；
 * Validate 已由 Application Service 支持行业工作区（S2）。
 */
function workspaceRootUnsupportedDiagnostic (file: string): IdeDiagnostic {
  return {
    code: 'FH2_IDE_WORKSPACE_ROOT_UNSUPPORTED',
    phase: 'semantic',
    file,
    message: '行业 Capability 工作区根不直接参与构建，请打开具体 Capability 或前端插件目录。Industry capability workspace root is not directly buildable; open a capability or frontend plugin directory instead.',
    hint: '可在左侧文件树进入 backend/*/fh2-plugin.json 或 frontend/*/fh2-plugin.json 后重试。',
    severity: 'error',
  }
}

function fromBuildDiagnostic (diagnostic: BuildDiagnostic): IdeDiagnostic {
  return {
    code: diagnostic.code,
    // BuildPhase（config/generate/…）不在契约枚举里，构建期诊断统一落到 code。
    phase: 'code',
    file: diagnostic.file ?? '.',
    message: diagnostic.message,
    ...(diagnostic.hint === undefined ? {} : { hint: diagnostic.hint }),
    severity: 'error',
  }
}

/**
 * 把绝对路径折算成相对工作根的 POSIX 路径。
 *
 * 诊断里的 file 可能是绝对路径（Capability 聚合诊断）、也可能已经是相对文件名
 * （单插件诊断只给 basename），两种都要能落到前端可定位的相对路径上。
 */
function relativeToRoot (root: string, file: string): string {
  const resolvedRoot = resolve(root)
  const resolvedFile = resolve(resolvedRoot, file)
  const fromRoot = relative(resolvedRoot, resolvedFile)
  if (fromRoot === '') return '.'
  // 越界的诊断路径（例如 monorepo 里的外部依赖）原样保留，前端会当成不可跳转。
  return fromRoot.startsWith('..') ? file.replaceAll(sep, '/') : fromRoot.replaceAll(sep, '/')
}

function joinRelative (prefix: string, file: string): string {
  if (prefix === '' || prefix === '.') return file.replaceAll(sep, '/')
  return `${prefix}/${file.replaceAll(sep, '/')}`
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
