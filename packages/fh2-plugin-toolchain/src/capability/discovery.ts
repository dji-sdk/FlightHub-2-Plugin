// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { WorkspaceKind } from '../contracts/index.js'
import { readPackageManifest } from '../package/manifest.js'
import { PackageError, packageManifestPath } from '../package/types.js'
import { CAPABILITY_METADATA_FIELDS, CONTEXT_PRECEDENCE, MANIFEST_SIDE_DETECTION, PROJECT_PATHS, manifestSide } from '../project-policy.js'
import { parseStrictJson } from '../validate/json-reader.js'
import { CapabilityError } from './types.js'
import type {
  BackendPluginProject,
  CapabilityMetadata,
  CapabilityProject,
  CommandContext,
  FrontendPluginProject,
  IndustryCapabilityWorkspaceProject,
} from './types.js'

const CAPABILITIES_FILE = PROJECT_PATHS.capabilityMetadata
const FRONTEND_MANIFEST_FILE = PROJECT_PATHS.sourceManifest
const BACKEND_MANIFEST_FILE = PROJECT_PATHS.sourceManifest

/** Only inspect the requested directory; precedence and markers come from project-policy. */
export function discoverCommandContext (root: string): CommandContext {
  const resolvedRoot = resolve(root)
  for (const step of CONTEXT_PRECEDENCE) {
    if (!existsSync(join(resolvedRoot, step.markerFile))) continue
    if (step.contextIds.includes('industry-capability-workspace')) return discoverIndustryCapabilityWorkspace(resolvedRoot)
    if (step.contextIds.includes('capability-project')) return discoverCapability(resolvedRoot)
    // 前后端共用 fh2-plugin.json 标记：按清单内容判别 side（规则与字段清单来自 manifestSideDetection）。
    return discoverPluginContextByManifest(resolvedRoot, join(resolvedRoot, step.markerFile))
  }
  throw new CapabilityError(
    'FH2_CONTEXT_NOT_FOUND',
    `当前目录不是 Capability、前端插件或后端插件：${resolvedRoot}`,
  )
}

/**
 * 前后端源码清单统一为 fh2-plugin.json 后，裸插件目录的 side 判别依据清单内容。
 * 标志字段清单、判定规则与缺省 side 全部来自 project-policy.ts；
 * 两类标志字段取值域不相交，缺两者时按前端处理（前端 schema 会给出具体报错）。
 */
function discoverPluginContextByManifest (root: string, manifestPath: string): CommandContext {
  const manifest = readJsonObject(manifestPath, 'FH2_CONTEXT_NOT_FOUND')
  return manifestSide(manifest) === 'backend'
    ? { kind: 'backend-plugin', root, manifestPath }
    : { kind: 'frontend-plugin', root, manifestPath }
}

/** 没有任何上下文标志文件时返回 undefined，供旧单插件命令保留原有报错。 */
export function tryDiscoverCommandContext (root: string): CommandContext | undefined {
  const resolvedRoot = resolve(root)
  if (!CONTEXT_PRECEDENCE.some(step => existsSync(join(resolvedRoot, step.markerFile)))) {
    return undefined
  }
  return discoverCommandContext(resolvedRoot)
}

/**
 * 只根据根目录标志文件判断工程身份，不要求工程配置已经通过严格 discovery。
 * Web IDE 依赖它打开并修复损坏的工程；Build/Validate 等命令仍使用上面的严格上下文。
 */
export function detectCommandContextKind (root: string): Exclude<WorkspaceKind, 'unknown'> | undefined {
  const resolvedRoot = resolve(root)
  for (const step of CONTEXT_PRECEDENCE) {
    const markerPath = join(resolvedRoot, step.markerFile)
    if (!existsSync(markerPath)) continue
    if (step.contextIds.includes('industry-capability-workspace')) return 'industry-capability-workspace'
    if (step.contextIds.includes('capability-project')) return 'capability-project'
    try {
      const manifest = readJsonObject(markerPath, 'FH2_CONTEXT_NOT_FOUND')
      return manifestSide(manifest) === 'backend'
        ? 'backend-plugin'
        : 'frontend-plugin'
    } catch {
      // 无法解析 side 时沿用既有契约的 frontend fallback，让 Schema 给出具体错误。
      return (MANIFEST_SIDE_DETECTION.fallbackSide as string) === 'backend'
        ? 'backend-plugin'
        : 'frontend-plugin'
    }
  }
  return undefined
}

export function discoverCapability (root: string): CapabilityProject {
  return discoverCapabilityProject(root, false)
}

/**
 * 行业工作区只由根级 packages.json 和其直接 Capability 子目录定义。
 * 不向上查找，也不把普通目录误当成 Capability。
 */
export function discoverIndustryCapabilityWorkspace (root: string): IndustryCapabilityWorkspaceProject {
  const resolvedRoot = resolve(root)
  const manifestPath = packageManifestPath(resolvedRoot)
  let packageManifest
  try {
    packageManifest = readPackageManifest(resolvedRoot)
  } catch (error) {
    if (error instanceof PackageError) throw new CapabilityError(error.code, error.message, error.file)
    throw error
  }

  const declaredDirectories = new Map<string, string>()
  const missingDirectories: string[] = []
  const missingMetadata: string[] = []
  for (const capabilityId of packageManifest.capabilityIds) {
    const directory = resolve(resolvedRoot, capabilityId)
    if (!isDirectChild(resolvedRoot, directory, capabilityId)) {
      throw new CapabilityError(
        'FH2_INDUSTRY_CAPABILITY_WORKSPACE_INVALID',
        `${manifestPath} 的 capabilityIds 必须是工作区直接子目录名：${capabilityId}。`,
        manifestPath,
      )
    }
    if (!existsSync(directory)) {
      missingDirectories.push(capabilityId)
      continue
    }
    const stat = lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new CapabilityError(
        'FH2_INDUSTRY_CAPABILITY_WORKSPACE_PATH_UNSAFE',
        `工作区 Capability 目录必须是普通直接子目录：${directory}。`,
        directory,
      )
    }
    if (!existsSync(join(directory, CAPABILITIES_FILE))) {
      missingMetadata.push(capabilityId)
      continue
    }
    declaredDirectories.set(capabilityId, directory)
  }

  const actualCapabilityDirectories = discoverDirectCapabilityDirectories(resolvedRoot)
  const declared = new Set(packageManifest.capabilityIds)
  const unknownDirectories = actualCapabilityDirectories.filter(id => !declared.has(id))
  if (missingDirectories.length > 0 || missingMetadata.length > 0 || unknownDirectories.length > 0) {
    const details = [
      ...(missingDirectories.length === 0 ? [] : [`清单声明但目录不存在：${missingDirectories.join(', ')}`]),
      ...(missingMetadata.length === 0 ? [] : [`清单声明但缺少 capabilities.json：${missingMetadata.join(', ')}`]),
      ...(unknownDirectories.length === 0 ? [] : [`存在未在 capabilityIds 声明的 Capability 目录：${unknownDirectories.join(', ')}`]),
    ]
    throw new CapabilityError(
      'FH2_INDUSTRY_CAPABILITY_WORKSPACE_MEMBERSHIP_MISMATCH',
      `${manifestPath} 的 capabilityIds 与工作区直接 Capability 目录必须双向一致；${details.join('；')}。`,
      manifestPath,
    )
  }

  return Object.freeze({
    kind: 'industry-capability-workspace',
    root: resolvedRoot,
    packageManifestPath: manifestPath,
    packageManifest,
    // 工作区成员由 packages.json 的顺序定义；Capability 内部插件仍按目录名排序。
    capabilities: Object.freeze(packageManifest.capabilityIds.map(capabilityId =>
      discoverCapabilityProject(declaredDirectories.get(capabilityId)!, true))),
  })
}

function discoverCapabilityProject (root: string, allowEmpty: boolean): CapabilityProject {
  const resolvedRoot = resolve(root)
  const metadataPath = join(resolvedRoot, CAPABILITIES_FILE)
  const metadata = readCapabilityMetadata(metadataPath)
  const frontend = discoverFrontendProjects(resolvedRoot)
  const backend = discoverBackendProjects(resolvedRoot)
  if (!allowEmpty && frontend.length === 0 && backend.length === 0) {
    throw new CapabilityError(
      'FH2_CAPABILITY_EMPTY',
      `Capability ${basename(resolvedRoot)} 未发现 frontend/*/fh2-plugin.json 或 backend/*/fh2-plugin.json。`,
      metadataPath,
    )
  }
  assertUniquePluginIds([...frontend, ...backend], resolvedRoot)
  return Object.freeze({
    kind: 'capability-project',
    root: resolvedRoot,
    capabilityId: basename(resolvedRoot),
    metadataPath,
    metadata,
    frontend,
    backend,
  })
}

function discoverDirectCapabilityDirectories (root: string): readonly string[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    throw new CapabilityError(
      'FH2_INDUSTRY_CAPABILITY_WORKSPACE_INVALID',
      `无法读取行业 Capability 工作区目录 ${root}：${message(error)}。`,
      root,
    )
  }
  const capabilityIds: string[] = []
  for (const entry of entries) {
    const directory = join(root, entry.name)
    if (entry.isSymbolicLink()) {
      if (existsSync(join(directory, CAPABILITIES_FILE))) {
        throw new CapabilityError(
          'FH2_INDUSTRY_CAPABILITY_WORKSPACE_PATH_UNSAFE',
          `工作区 Capability 目录不能使用符号链接：${directory}。`,
          directory,
        )
      }
      continue
    }
    if (entry.isDirectory() && existsSync(join(directory, CAPABILITIES_FILE))) capabilityIds.push(entry.name)
  }
  return capabilityIds.sort(compareText)
}

function isDirectChild (root: string, directory: string, capabilityId: string): boolean {
  const fromRoot = relative(root, directory)
  return fromRoot === capabilityId
    && !isAbsolute(fromRoot)
    && capabilityId !== '.'
    && capabilityId !== '..'
}

/** Preview 只读取 Capability 元数据和 frontend/*，不触碰 backend/*。 */
export function discoverCapabilityFrontendOnly (root: string): {
  readonly root: string;
  readonly capabilityId: string;
  readonly frontend: readonly FrontendPluginProject[];
} {
  const resolvedRoot = resolve(root)
  const metadataPath = join(resolvedRoot, CAPABILITIES_FILE)
  void readCapabilityMetadata(metadataPath)
  const frontend = discoverFrontendProjects(resolvedRoot)
  if (frontend.length === 0) {
    throw new CapabilityError(
      'FH2_CAPABILITY_EMPTY',
      `Capability ${basename(resolvedRoot)} 未发现 frontend/*/fh2-plugin.json。`,
      metadataPath,
    )
  }
  return Object.freeze({
    root: resolvedRoot,
    capabilityId: basename(resolvedRoot),
    frontend,
  })
}

function readCapabilityMetadata (metadataPath: string): CapabilityMetadata {
  const value = readJsonObject(metadataPath, 'FH2_CAPABILITY_METADATA_INVALID')
  const unknown = Object.keys(value).filter(key => !CAPABILITY_METADATA_FIELDS.includes(key))
  if (unknown.length > 0) {
    throw new CapabilityError(
      'FH2_CAPABILITY_METADATA_INVALID',
      `capabilities.json 包含未知字段：${unknown.join(', ')}。`,
      metadataPath,
    )
  }
  if (typeof value.name !== 'string' || value.name.trim() === '') {
    throw new CapabilityError('FH2_CAPABILITY_METADATA_INVALID', 'capabilities.json 缺少非空 name。', metadataPath)
  }
  if (typeof value.description !== 'string' || value.description.trim() === '') {
    throw new CapabilityError('FH2_CAPABILITY_METADATA_INVALID', 'capabilities.json 缺少非空 description。', metadataPath)
  }
  return Object.freeze({ name: value.name, description: value.description })
}

function discoverFrontendProjects (root: string): readonly FrontendPluginProject[] {
  const container = join(root, PROJECT_PATHS.frontend)
  return discoverPluginDirectories(container, FRONTEND_MANIFEST_FILE).map(({ directory, manifestPath }) => {
    const manifest = readJsonObject(manifestPath, 'FH2_CAPABILITY_PLUGIN_DISCOVERY_FAILED')
    const id = readPluginId(manifest, 'id', manifestPath)
    if (basename(directory) !== id) {
      throw new CapabilityError(
        'FH2_CAPABILITY_FRONTEND_ID_MISMATCH',
        `前端插件目录名必须与 fh2-plugin.json.id 一致：目录=${basename(directory)}，id=${id}。`,
        manifestPath,
      )
    }
    return Object.freeze({ id, root: directory, manifestPath })
  })
}

function discoverBackendProjects (root: string): readonly BackendPluginProject[] {
  const container = join(root, PROJECT_PATHS.backend)
  return discoverPluginDirectories(container, BACKEND_MANIFEST_FILE).map(({ directory, manifestPath }) => {
    const manifest = readJsonObject(manifestPath, 'FH2_CAPABILITY_PLUGIN_DISCOVERY_FAILED')
    const id = readPluginId(manifest, 'pluginId', manifestPath)
    if (basename(directory) !== id) {
      throw new CapabilityError(
        'FH2_CAPABILITY_BACKEND_ID_MISMATCH',
        `后端插件目录名必须与 fh2-plugin.json.pluginId 一致：目录=${basename(directory)}，pluginId=${id}。`,
        manifestPath,
      )
    }
    return Object.freeze({ id, root: directory, manifestPath })
  })
}

function discoverPluginDirectories (
  container: string,
  manifestFile: string,
): readonly { readonly directory: string; readonly manifestPath: string }[] {
  if (!existsSync(container)) return []
  assertCapabilityContainer(container)
  const directories = readdirSync(container, { withFileTypes: true })
    .filter((entry) => {
      if (entry.name.startsWith('.')) return false
      if (entry.isSymbolicLink()) {
        throw new CapabilityError(
          'FH2_CAPABILITY_PLUGIN_DISCOVERY_FAILED',
          `Capability 插件目录不能使用符号链接：${join(container, entry.name)}。`,
          join(container, entry.name),
        )
      }
      return entry.isDirectory()
    })
    .map(entry => join(container, entry.name))
    .sort(compareText)
  // 收紧：容器下的普通子目录必须全部携带清单文件，缺失即报错。
  // 旧的“静默跳过”会把改名/漏文件导致的插件丢失掩盖成 build 全绿、上传后后端缺位。
  const missing = directories.filter(directory => !existsSync(join(directory, manifestFile)))
  if (missing.length > 0) {
    throw new CapabilityError(
      'FH2_CAPABILITY_PLUGIN_MANIFEST_MISSING',
      `Capability 插件目录缺少 ${manifestFile}：${missing.join(', ')}。`,
      container,
    )
  }
  return directories.map(directory => Object.freeze({ directory, manifestPath: join(directory, manifestFile) }))
}

function assertCapabilityContainer (container: string): void {
  const stat = lstatSync(container)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new CapabilityError(
      'FH2_CAPABILITY_PLUGIN_DISCOVERY_FAILED',
      `Capability frontend/backend 容器必须是普通目录：${container}。`,
      container,
    )
  }
  const parent = realpathSync(resolve(container, '..'))
  const realContainer = realpathSync(container)
  const fromParent = relative(parent, realContainer)
  if (isAbsolute(fromParent) || fromParent === '..' || fromParent.startsWith(`..${sep}`)) {
    throw new CapabilityError(
      'FH2_CAPABILITY_PLUGIN_DISCOVERY_FAILED',
      `Capability frontend/backend 容器真实路径越过 Capability 根：${container}。`,
      container,
    )
  }
}

function assertUniquePluginIds (
  projects: readonly ({ readonly id: string; readonly manifestPath: string })[],
  root: string,
): void {
  const seen = new Map<string, string>()
  for (const project of projects) {
    const previous = seen.get(project.id)
    if (previous !== undefined) {
      throw new CapabilityError(
        'FH2_CAPABILITY_PLUGIN_ID_CONFLICT',
        `Capability ${basename(root)} 内 pluginId 重复：${project.id}（${previous} 与 ${project.manifestPath}）。`,
        project.manifestPath,
      )
    }
    seen.set(project.id, project.manifestPath)
  }
}

function readJsonObject (file: string, code: string): Record<string, unknown> {
  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    throw new CapabilityError(code, `无法读取 ${file}：${message(error)}`, file)
  }
  const parsed = parseStrictJson(source, file)
  if (!parsed.ok) {
    throw new CapabilityError(code, parsed.diagnostics.map(diagnostic => diagnostic.message).join(' '), file)
  }
  if (!isRecord(parsed.parsed.value)) {
    throw new CapabilityError(code, `${file} 必须是 JSON 对象。`, file)
  }
  return parsed.parsed.value
}

function readPluginId (manifest: Record<string, unknown>, key: 'id' | 'pluginId', file: string): string {
  const value = manifest[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CapabilityError(
      'FH2_CAPABILITY_PLUGIN_DISCOVERY_FAILED',
      `${file} 缺少非空 ${key}。`,
      file,
    )
  }
  return value
}

function compareText (left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
