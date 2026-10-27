// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { Script } from 'node:vm'
import Ajv from 'ajv'
import type { ErrorObject } from 'ajv'
import { parseStrictJson } from '../validate/json-reader.js'
import { PROJECT_PATHS } from '../project-policy.js'
import { WINDOWS_RESERVED_NAMES } from '../capability/policy.js'
import { toCatalog } from '../workflow/core/catalog.js'
import { toGraph } from '../workflow/core/projection.js'
import { validateSemantics } from '../workflow/core/semantics.js'
import { resolveIdeActions } from '../workflow/service/catalog.js'
import { loadBackendContractFacts } from './contract-data.js'
import { discoverBackendHandlerFiles } from './discovery.js'

/** 后端插件源码 Manifest 文件名（作者侧统一命名，与前端 fh2-plugin.json 对齐）。 */
export const BACKEND_SOURCE_MANIFEST_FILE = PROJECT_PATHS.sourceManifest
/** 后端插件运行时 Manifest 文件名（dist 产物与 Worker 装载契约，不可改名）。 */
export const BACKEND_RUNTIME_MANIFEST_FILE = PROJECT_PATHS.runtimeManifest

const WINDOWS_RESERVED_ASSET_NAMES = new Set(WINDOWS_RESERVED_NAMES)

export interface WorkerBackendField {
  readonly type: 'string' | 'number' | 'boolean' | 'datetime' | 'json';
  readonly indexed?: boolean;
  readonly unique?: boolean;
}

export interface WorkerBackendEntity {
  readonly name: string;
  readonly fields: Readonly<Record<string, WorkerBackendField>>;
}

export interface WorkerBackendScript {
  readonly name?: string;
  readonly path?: string;
  readonly entry?: string;
  readonly allowlist?: readonly string[];
}

export interface WorkerBackendEventConsumer {
  readonly handler?: string;
  readonly entry?: string;
}

export interface WorkerBackendEvent {
  readonly type: string;
  readonly consumer: readonly WorkerBackendEventConsumer[];
  readonly match?: Readonly<Record<string, string>>;
}

export interface WorkerBackendConnection {
  readonly id: string;
  readonly requires?: readonly WorkerBackendConnectionRequirement[];
}

export interface WorkerBackendConnectionRequirement {
  readonly name: string;
  readonly type: 'string' | 'number' | 'bool';
}

export interface WorkerBackendEvaluator {
  readonly name: string;
  readonly path?: string;
  readonly entry?: string;
}

export interface WorkerBackendPluginManifest {
  readonly pluginId: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly puid?: string;
  readonly contractsRange?: string;
  readonly slots?: readonly string[];
  readonly flows?: readonly string[];
  readonly connections?: readonly WorkerBackendConnection[];
  readonly scripts?: readonly WorkerBackendScript[];
  readonly eventStatuses?: readonly string[];
  readonly allowlist?: readonly string[];
  readonly events?: readonly WorkerBackendEvent[];
  readonly evaluators?: readonly WorkerBackendEvaluator[];
  readonly entities?: readonly WorkerBackendEntity[];
}

export interface BackendContractDiagnostic {
  readonly code: string;
  readonly file: string;
  readonly message: string;
  readonly path?: string;
}

export interface BackendRuntimeKeys {
  readonly flows: readonly string[];
  readonly scripts: readonly string[];
  readonly connections: readonly string[];
  readonly entities: readonly string[];
}

export type BackendPluginValidationResult = {
  readonly ok: true;
  readonly manifest: WorkerBackendPluginManifest;
  readonly runtimeKeys: BackendRuntimeKeys;
  readonly diagnostics: readonly [];
} | {
  readonly ok: false;
  readonly diagnostics: readonly BackendContractDiagnostic[];
}

export class BackendContractError extends Error {
  constructor (readonly diagnostics: readonly BackendContractDiagnostic[]) {
    super(diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join('\n'))
    this.name = 'BackendContractError'
  }
}

// Source 与 Runtime Manifest 仍共用投影中的 Source Schema；Runtime 闭枚举
// Schema 仅装载验证，不在本轮切换实际校验行为。
const backendContractFacts = loadBackendContractFacts()
const ajv = new Ajv({ allErrors: true, strict: false })
const validatePluginSchema = ajv.compile(backendContractFacts.sourceManifestSchema)
const validateWorkflowSchema = ajv.compile(backendContractFacts.workflowSchema)
const pluginIdPattern = /^[A-Za-z0-9_.-]{1,64}$/
const entityNamePattern = /^[a-z][a-z0-9_]*$/
const snakeFieldPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
const camelFieldPattern = /^[a-z][a-zA-Z0-9]*$/
const knownAllowlist = new Set(backendContractFacts.capabilities)
const maxEntities = 32
const maxFieldsPerEntity = 64
const streamMatchFields = new Set([
  'event_id',
  'event_type',
  'tenant_id',
  'source',
  'status',
  'priority',
  'occurred_at',
  'flight_mission_id',
  'result_code',
  'notify_on',
  'payload',
])
const streamSeedFields = new Set([
  'eventId',
  'eventType',
  'tenantId',
  'source',
  'status',
  'priority',
  'occurredAt',
  'flightMissionId',
  'resultCode',
  'notifyOn',
  'payload',
  'lat',
  'lng',
])
const bizNotifySeedFields = new Set([
  'eventId',
  'eventKind',
  'occurredAt',
  'taskUuid',
  'projectUuid',
  'taskName',
  'taskType',
  'dockSn',
  'droneSn',
  'waylineUuid',
  'taskStatus',
])
const reservedEntityFields = new Set([
  'id',
  'tenant_id',
  'created_at',
  'updated_at',
  'tableoid',
  'xmin',
  'cmin',
  'xmax',
  'cmax',
  'ctid',
])

/**
 * Validate a backend plugin directory against the Worker contract.
 *
 * Source builds may supply an in-memory effective manifest after deriving
 * entities from schema.sql. Runtime validation still runs against the same
 * asset root and uses the existing Worker-like checks.
 */
export function validateBackendPlugin (
  pluginRoot: string,
  effectiveManifestJson?: unknown,
  manifestFileName: string = BACKEND_RUNTIME_MANIFEST_FILE,
): BackendPluginValidationResult {
  const root = resolve(pluginRoot)
  const manifestPath = resolve(root, manifestFileName)
  const manifestFile = relativeFile(root, manifestPath)
  let manifestJson = effectiveManifestJson
  if (manifestJson === undefined) {
    let source: string
    try {
      source = readFileSync(manifestPath, 'utf8')
    } catch (error) {
      return invalid([diagnostic(
        'FH2_BACKEND_MANIFEST_INVALID',
        manifestFile,
        `无法读取后端 ${manifestFile}：${message(error)}`,
      )])
    }

    const parsed = parseStrictJson(source, manifestFile)
    if (!parsed.ok) {
      return invalid(parsed.diagnostics.map(item => diagnostic(
        'FH2_BACKEND_MANIFEST_INVALID',
        manifestFile,
        item.message,
        item.path,
      )))
    }
    manifestJson = parsed.parsed.value
  }
  if (!validatePluginSchema(manifestJson)) {
    return invalid((validatePluginSchema.errors ?? []).map(error => schemaDiagnostic(manifestFile, error)))
  }

  const manifest = manifestJson as unknown as WorkerBackendPluginManifest
  const diagnostics: BackendContractDiagnostic[] = []
  validateBackendAssetNames(root, diagnostics)
  validateManifest(root, manifest, diagnostics, manifestFile)
  return diagnostics.length === 0
    ? { ok: true, manifest, runtimeKeys: collectBackendRuntimeKeys(root, manifest), diagnostics: [] }
    : invalid(diagnostics)
}

export function readBackendPluginContract (pluginRoot: string): WorkerBackendPluginManifest {
  const result = validateBackendPlugin(pluginRoot)
  if (!result.ok) throw new BackendContractError(result.diagnostics)
  return result.manifest
}

export function collectBackendRuntimeKeys (
  pluginRoot: string,
  manifest: WorkerBackendPluginManifest,
): BackendRuntimeKeys {
  const root = resolve(pluginRoot)
  const flows = new Set<string>()
  const requestedScripts = new Set<string>()
  for (const path of manifest.flows ?? []) {
    const asset = resolveAssetFile(root, path, '.json')
    if (!asset.ok) continue
    try {
      const parsed = parseStrictJson(readFileSync(asset.absolutePath, 'utf8'), asset.file)
      if (!parsed.ok || !isRecord(parsed.parsed.value)) continue
      if (typeof parsed.parsed.value.name === 'string') flows.add(parsed.parsed.value.name)
      if (Array.isArray(parsed.parsed.value.steps)) {
        for (const step of parsed.parsed.value.steps) {
          if (!isRecord(step) || step.action !== 'run_script' || !isRecord(step.inputs)) continue
          const reference = constantString(step.inputs.script)
          if (reference !== undefined) requestedScripts.add(reference)
        }
      }
    } catch {
      // This helper only runs after validateBackendPlugin has accepted the same assets.
    }
  }
  const scripts = new Set((manifest.scripts ?? []).map(scriptReference))
  const missingScripts = [...requestedScripts].filter(reference => !scripts.has(reference))
  if ((manifest.scripts?.length ?? 0) === 0
    && missingScripts.length === 1
    && findPackedJavaScriptEntry(root, 'handle') !== undefined) {
    scripts.add(missingScripts[0]!)
  }
  return Object.freeze({
    flows: Object.freeze([...flows].sort(compareText)),
    scripts: Object.freeze([...scripts].sort(compareText)),
    connections: Object.freeze((manifest.connections ?? []).map(connection => connection.id).sort(compareText)),
    entities: Object.freeze((manifest.entities ?? []).map(entity => entity.name).sort(compareText)),
  })
}

function validateManifest (
  root: string,
  manifest: WorkerBackendPluginManifest,
  diagnostics: BackendContractDiagnostic[],
  manifestFile: string = BACKEND_RUNTIME_MANIFEST_FILE,
): void {
  if (!pluginIdPattern.test(manifest.pluginId)) {
    diagnostics.push(diagnostic(
      'FH2_BACKEND_MANIFEST_INVALID',
      manifestFile,
      `pluginId ${JSON.stringify(manifest.pluginId)} 只允许 [A-Za-z0-9_.-]，且最长 64 字符。`,
      'pluginId',
    ))
  }
  validateContractsRange(manifest.contractsRange, diagnostics)
  validateEntities(manifest.entities ?? [], diagnostics)
  validateAllowlist(manifest.allowlist ?? [], manifestFile, 'allowlist', diagnostics)
  validateEventStatuses(manifest.eventStatuses ?? [], diagnostics)

  const connections = new Set<string>()
  for (const connection of manifest.connections ?? []) {
    if (connections.has(connection.id)) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_MANIFEST_INVALID',
        manifestFile,
        `connections.id 重复：${connection.id}。`,
      ))
    }
    connections.add(connection.id)
    const requirementNames = new Set<string>()
    for (const requirement of connection.requires ?? []) {
      if (requirementNames.has(requirement.name)) {
        diagnostics.push(diagnostic(
          'FH2_BACKEND_MANIFEST_INVALID',
          manifestFile,
          `Connection ${connection.id} 的 requires.name 重复：${requirement.name}。`,
        ))
      }
      requirementNames.add(requirement.name)
    }
  }

  const scriptRefs = new Set<string>()
  for (const script of manifest.scripts ?? []) {
    const reference = scriptReference(script)
    if (scriptRefs.has(reference)) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_MANIFEST_INVALID',
        manifestFile,
        `scripts 的寻址名重复：${reference}。`,
      ))
    }
    scriptRefs.add(reference)
    validateAllowlist(script.allowlist ?? manifest.allowlist ?? [], manifestFile, 'scripts.allowlist', diagnostics)
    validateJavaScriptAsset(
      root,
      script.path,
      script.entry ?? 'handle',
      'FH2_BACKEND_SCRIPT_INVALID',
      diagnostics,
      { allowPackedFallback: script.entry !== undefined },
    )
  }

  const eventTypes = new Set<string>()
  for (const event of manifest.events ?? []) {
    if (eventTypes.has(event.type)) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_EVENT_INVALID',
        manifestFile,
        `events.type 重复：${event.type}。`,
      ))
    }
    eventTypes.add(event.type)
    for (const key of Object.keys(event.match ?? {})) {
      if (key.trim() === '') {
        diagnostics.push(diagnostic(
          'FH2_BACKEND_EVENT_INVALID',
          manifestFile,
          `events.${event.type}.match 不能包含空白键名。`,
        ))
      }
    }
    for (const consumer of event.consumer) {
      validateJavaScriptAsset(
        root,
        consumer.handler,
        consumer.entry ?? 'handle',
        'FH2_BACKEND_EVENT_INVALID',
        diagnostics,
        { allowPackedFallback: consumer.entry !== undefined },
      )
    }
  }

  const evaluators = new Set<string>()
  for (const evaluator of manifest.evaluators ?? []) {
    if (evaluators.has(evaluator.name)) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_MANIFEST_INVALID',
        manifestFile,
        `evaluators.name 重复：${evaluator.name}。`,
      ))
    }
    evaluators.add(evaluator.name)
    validateJavaScriptAsset(
      root,
      evaluator.path,
      evaluator.entry ?? 'handle',
      'FH2_BACKEND_SCRIPT_INVALID',
      diagnostics,
      { allowPackedFallback: evaluator.entry !== undefined },
    )
  }

  validateHandlers(root, manifest, diagnostics)
  validateFlows(root, manifest, scriptRefs, connections, diagnostics)

  const effectiveAllowlist = [
    ...(manifest.allowlist ?? []),
    ...(manifest.scripts ?? []).flatMap(script => script.allowlist ?? []),
  ]
  if ((manifest.entities?.length ?? 0) === 0
    && effectiveAllowlist.some(item => item === 'data:read' || item === 'data:write')) {
    diagnostics.push(diagnostic(
      'FH2_BACKEND_PERMISSION_INVALID',
      manifestFile,
      '声明 data:read 或 data:write 时必须声明 entities。',
      'allowlist',
    ))
  }
}

function validateBackendAssetNames (root: string, diagnostics: BackendContractDiagnostic[]): void {
  const windowsPaths = new Map<string, string>()
  const visit = (directory: string, prefix: string): void => {
    let entries: readonly Dirent<string>[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_MANIFEST_INVALID',
        prefix || 'plugin.json',
        `无法遍历后端插件资产：${message(error)}`,
      ))
      return
    }
    for (const entry of entries) {
      // node_modules 不属于插件交付资产：source 校验遍历工程根时会扫到依赖安装目录
      // （npm 消费场景下含 @swc/helpers/src/_*.mjs、Toolchain 模板 _gitignore 等），
      // 而打包复制阶段本就排除 node_modules（DEVELOPMENT_ONLY_DIRECTORIES）——
      // 校验口径必须与交付口径一致，否则依赖布局差异（pnpm hoist vs npm 工程内安装）
      // 会改变校验结果。符号链接（pnpm workspace 的包链接）同理不进资产集合。
      if (entry.name === 'node_modules') continue
      if (entry.isSymbolicLink()) continue
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.name.startsWith('_')) {
        diagnostics.push(diagnostic(
          'FH2_BACKEND_MANIFEST_INVALID',
          path,
          `后端插件资产路径不能包含以 _ 开头的段：${path}。`,
        ))
        continue
      }
      if (!isPortableAssetSegment(entry.name)) {
        diagnostics.push(diagnostic(
          'FH2_BACKEND_MANIFEST_INVALID',
          path,
          `后端插件资产路径不兼容跨平台上传包：${path}。`,
        ))
        continue
      }
      const windowsPath = path.toLowerCase()
      const existingPath = windowsPaths.get(windowsPath)
      if (existingPath !== undefined) {
        diagnostics.push(diagnostic(
          'FH2_BACKEND_MANIFEST_INVALID',
          path,
          `后端插件资产路径在 Windows 上冲突：${existingPath} / ${path}。`,
        ))
      } else {
        windowsPaths.set(windowsPath, path)
      }
      if (entry.isDirectory()) visit(resolve(directory, entry.name), path)
    }
  }
  visit(root, '')
}

function validateContractsRange (range: string | undefined, diagnostics: BackendContractDiagnostic[]): void {
  if (range === undefined || range.trim() === '') return
  const runtime = parseVersion(backendContractFacts.contractsVersion)
  const expressions = range.trim().split(/\s+/)
  for (const expression of expressions) {
    const match = /^(>=|<=|==|>|<|=)(\d+\.\d+\.\d+)$/.exec(expression)
    if (match === null) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_MANIFEST_INVALID',
        'plugin.json',
        `contractsRange ${JSON.stringify(range)} 只支持以空格分隔的 >=、>、<=、<、=、== 三段版本比较。`,
        'contractsRange',
      ))
      return
    }
    const expected = parseVersion(match[2]!)
    if (!matchesVersion(runtime, match[1]!, expected)) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_MANIFEST_INVALID',
        'plugin.json',
        `contractsRange ${JSON.stringify(range)} 与 Toolchain 支持的 ${backendContractFacts.contractsVersion} 不兼容。`,
        'contractsRange',
      ))
      return
    }
  }
}

function validateEntities (entities: readonly WorkerBackendEntity[], diagnostics: BackendContractDiagnostic[]): void {
  if (entities.length > maxEntities) {
    diagnostics.push(diagnostic(
      'FH2_BACKEND_MANIFEST_INVALID',
      'plugin.json',
      `entities 最多声明 ${maxEntities} 个 Entity，实际为 ${entities.length}。`,
    ))
  }
  const names = new Set<string>()
  for (const entity of entities) {
    if (!entityNamePattern.test(entity.name)) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_MANIFEST_INVALID',
        'plugin.json',
        `Entity 名 ${JSON.stringify(entity.name)} 必须匹配 ^[a-z][a-z0-9_]*$。`,
      ))
    }
    if (names.has(entity.name)) {
      diagnostics.push(diagnostic('FH2_BACKEND_MANIFEST_INVALID', 'plugin.json', `Entity 重复：${entity.name}。`))
    }
    names.add(entity.name)
    if (`plugin_db_${entity.name}`.length > 63) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_MANIFEST_INVALID',
        'plugin.json',
        `Entity ${entity.name} 加上物理表前缀后超过 PostgreSQL 63 字符限制。`,
      ))
    }
    const normalized = new Map<string, string>()
    const fieldNames = Object.keys(entity.fields)
    if (fieldNames.length > maxFieldsPerEntity) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_MANIFEST_INVALID',
        'plugin.json',
        `Entity ${entity.name} 最多声明 ${maxFieldsPerEntity} 个字段，实际为 ${fieldNames.length}。`,
      ))
    }
    for (const fieldName of fieldNames) {
      if (!snakeFieldPattern.test(fieldName) && !camelFieldPattern.test(fieldName)) {
        diagnostics.push(diagnostic(
          'FH2_BACKEND_MANIFEST_INVALID',
          'plugin.json',
          `Entity ${entity.name} 的字段 ${fieldName} 必须是 lowerCamelCase 或小写 snake_case。`,
        ))
        continue
      }
      const normalizedName = normalizeFieldName(fieldName)
      if (normalizedName.length > 63) {
        diagnostics.push(diagnostic(
          'FH2_BACKEND_MANIFEST_INVALID',
          'plugin.json',
          `Entity ${entity.name} 的字段 ${fieldName} 转换后超过 PostgreSQL 63 字符限制。`,
        ))
      }
      if (reservedEntityFields.has(normalizedName)) {
        diagnostics.push(diagnostic(
          'FH2_BACKEND_MANIFEST_INVALID',
          'plugin.json',
          `Entity ${entity.name} 的字段 ${fieldName} 是平台保留字段。`,
        ))
      }
      const previous = normalized.get(normalizedName)
      if (previous !== undefined) {
        diagnostics.push(diagnostic(
          'FH2_BACKEND_MANIFEST_INVALID',
          'plugin.json',
          `Entity ${entity.name} 的字段 ${previous} 与 ${fieldName} 转换后冲突。`,
        ))
      }
      normalized.set(normalizedName, fieldName)
    }
  }
}

function validateEventStatuses (statuses: readonly string[], diagnostics: BackendContractDiagnostic[]): void {
  const seen = new Set<string>()
  for (const status of statuses) {
    if (seen.has(status)) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_MANIFEST_INVALID',
        'plugin.json',
        `eventStatuses 重复：${status}。`,
      ))
    }
    seen.add(status)
  }
}

function validateAllowlist (
  values: readonly string[],
  file: string,
  path: string,
  diagnostics: BackendContractDiagnostic[],
): void {
  for (const value of values) {
    if (!knownAllowlist.has(value)) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_PERMISSION_INVALID',
        file,
        `Allowlist 包含 Worker 不支持的能力：${value}。`,
        path,
      ))
    }
  }
}

function validateHandlers (
  root: string,
  manifest: WorkerBackendPluginManifest,
  diagnostics: BackendContractDiagnostic[],
): void {
  let handlers: ReturnType<typeof discoverBackendHandlerFiles>
  try {
    handlers = discoverBackendHandlerFiles(root)
  } catch (error) {
    diagnostics.push(diagnostic('FH2_BACKEND_HANDLER_INVALID', 'handlers', message(error)))
    return
  }
  const claimedEntries = new Set<string>()
  const claimedFiles = new Set<string>()
  for (const script of manifest.scripts ?? []) {
    if (script.entry !== undefined && script.entry !== '') claimedEntries.add(script.entry)
    else if (script.path !== undefined) claimedFiles.add(script.path)
  }
  for (const event of manifest.events ?? []) {
    for (const consumer of event.consumer) {
      if (consumer.entry !== undefined && consumer.entry !== '') claimedEntries.add(consumer.entry)
      else if (consumer.handler !== undefined) claimedFiles.add(consumer.handler)
    }
  }
  const names = new Set<string>()
  for (const handler of handlers) {
    if (claimedFiles.has(handler.path)) continue
    const source = validateJavaScriptAsset(
      root,
      handler.path,
      'handle',
      'FH2_BACKEND_HANDLER_INVALID',
      diagnostics,
      { requireEntry: false },
    )
    if (source === undefined) continue
    const entries = handlerEntries(source)
    if (entries.length === 0 && handler.kind === 'packed') continue
    if (entries.length === 0 && !hasEntry(source, 'handle') && !hasAnyExportedFunction(source)) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_HANDLER_INVALID',
        handler.path,
        'Handler 源码必须声明 handle，或声明一个以上 h_ 顶层入口。',
      ))
      continue
    }
    const handlerNames = (entries.length === 0 && handler.name !== undefined ? [handler.name] : entries)
      .filter(name => !claimedEntries.has(name))
    for (const name of handlerNames) {
      if (names.has(name)) {
        diagnostics.push(diagnostic(
          'FH2_BACKEND_HANDLER_INVALID',
          handler.path,
          `Handler 名重复：${name}。`,
        ))
      }
      names.add(name)
    }
  }
}

function validateFlows (
  root: string,
  manifest: WorkerBackendPluginManifest,
  scriptRefs: ReadonlySet<string>,
  connections: ReadonlySet<string>,
  diagnostics: BackendContractDiagnostic[],
): void {
  const flowNames = new Set<string>()
  const workflows: LoadedWorkflow[] = []
  for (const path of manifest.flows ?? []) {
    const asset = resolveAssetFile(root, path, '.json')
    if (!asset.ok) {
      diagnostics.push(diagnostic(
        asset.reason === 'unsafe' ? 'FH2_BACKEND_WORKFLOW_INVALID' : 'FH2_BACKEND_REFERENCE_MISSING',
        path,
        asset.reason === 'unsafe' ? `Workflow 路径不安全：${path}。` : `Workflow 文件不存在：${path}。`,
        asset.reason === 'unsafe' ? 'flows' : undefined,
      ))
      continue
    }
    let source: string
    try {
      source = readFileSync(asset.absolutePath, 'utf8')
    } catch (error) {
      diagnostics.push(diagnostic('FH2_BACKEND_REFERENCE_MISSING', asset.file, `无法读取 Workflow：${message(error)}`))
      continue
    }
    const parsed = parseStrictJson(source, asset.file)
    if (!parsed.ok) {
      for (const item of parsed.diagnostics) {
        diagnostics.push(diagnostic('FH2_BACKEND_WORKFLOW_INVALID', asset.file, item.message, item.path))
      }
      continue
    }
    if (!validateWorkflowSchema(parsed.parsed.value)) {
      for (const error of validateWorkflowSchema.errors ?? []) {
        diagnostics.push(schemaDiagnostic(asset.file, error, 'FH2_BACKEND_WORKFLOW_INVALID'))
      }
      continue
    }
    const workflow = parsed.parsed.value as Record<string, unknown>
    const name = workflow.name
    if (typeof name === 'string') {
      if (flowNames.has(name)) {
        diagnostics.push(diagnostic('FH2_BACKEND_WORKFLOW_INVALID', asset.file, `Workflow name 重复：${name}。`))
      }
      flowNames.add(name)
    }
    if (!hasTriggerKind(workflow)) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_WORKFLOW_INVALID',
        asset.file,
        'Workflow trigger 至少声明 api、schedule、stream、bizNotify 或 job 之一。',
      ))
      continue
    }
    validateWorkflowTrigger(asset.file, workflow, manifest.eventStatuses ?? [], diagnostics)
    validateWorkflowInterrupts(asset.file, workflow, diagnostics)
    // 交付门此前只做 Schema/引用校验：环、悬空 needs、重复条目、重复/保留 id、
    // 空 steps 这些「图立不住」的问题一路绿到发布。这里把与画布、预检同一套
    // 结构与语义判据接进 CLI，三道门口径一致。
    for (const issue of toGraph({ raw: workflow }).issues) {
      diagnostics.push(diagnostic('FH2_BACKEND_WORKFLOW_INVALID', asset.file, `Workflow 结构错误：${issue.message}`))
    }
    // 词表按 flow 路径解析（与浏览器预检同口径）。脚本可达性除外：packed 形态
    // （无 manifest 登记、靠打包兜底）进不了词表，而 validateWorkflowReferences
    // 已结合打包兜底判过一次，这里重复判只会误伤。
    const catalog = toCatalog(resolveIdeActions({ root, workflowPath: path }))
    if (catalog.available) {
      for (const issue of validateSemantics(catalog, { raw: workflow })) {
        if (issue.level === 'error' && issue.rule !== 'SCRIPT_MISSING') {
          diagnostics.push(diagnostic('FH2_BACKEND_WORKFLOW_INVALID', asset.file, `Workflow 语义错误（${issue.rule}）：${issue.message}`))
        }
      }
    }
    workflows.push({ file: asset.file, workflow })
  }

  const effectiveScriptRefs = new Set(scriptRefs)
  const requestedScriptRefs = collectWorkflowScriptReferences(workflows)
  const missingScriptRefs = [...requestedScriptRefs].filter(reference => !effectiveScriptRefs.has(reference))
  if ((manifest.scripts?.length ?? 0) === 0 && missingScriptRefs.length === 1) {
    const packed = findPackedJavaScriptEntry(root, 'handle')
    if (packed !== undefined && validateJavaScriptSource(packed, 'handle', 'FH2_BACKEND_SCRIPT_INVALID', diagnostics)) {
      effectiveScriptRefs.add(missingScriptRefs[0]!)
    }
  }
  for (const item of workflows) {
    validateWorkflowReferences(item.file, item.workflow, effectiveScriptRefs, connections, manifest.eventStatuses ?? [], diagnostics)
  }
}

function validateWorkflowReferences (
  file: string,
  workflow: Record<string, unknown>,
  scriptRefs: ReadonlySet<string>,
  connections: ReadonlySet<string>,
  eventStatuses: readonly string[],
  diagnostics: BackendContractDiagnostic[],
): void {
  if (!Array.isArray(workflow.steps)) return
  const statuses = new Set(eventStatuses)
  for (const step of workflow.steps) {
    if (!isRecord(step) || !isRecord(step.inputs)) continue
    if (step.action === 'run_script') {
      const script = constantString(step.inputs.script)
      if (script === undefined) {
        diagnostics.push(diagnostic(
          'FH2_BACKEND_WORKFLOW_INVALID',
          file,
          'run_script 的 inputs.script 必须是 {"const":"<script>"}。',
        ))
      } else if (!scriptRefs.has(script)) {
        diagnostics.push(diagnostic(
          'FH2_BACKEND_REFERENCE_MISSING',
          file,
          `run_script 引用了未声明的脚本：${script}。`,
        ))
      }
      const connectorId = constantString(step.inputs.connectorId)
      if (connectorId !== undefined && !connections.has(connectorId)) {
        diagnostics.push(diagnostic(
          'FH2_BACKEND_REFERENCE_MISSING',
          file,
          `run_script 引用了未声明的 Connection：${connectorId}。`,
        ))
      }
    }
    if (step.action === 'update_event_status') {
      const status = constantString(step.inputs.status)
      if (status === undefined || !statuses.has(status)) {
        diagnostics.push(diagnostic(
          'FH2_BACKEND_WORKFLOW_INVALID',
          file,
          'update_event_status 的 inputs.status 必须是 eventStatuses 中声明的常量。',
        ))
      }
    }
  }
}

function validateJavaScriptAsset (
  root: string,
  path: string | undefined,
  entry: string,
  code: string,
  diagnostics: BackendContractDiagnostic[],
  options: JavaScriptValidationOptions = {},
): string | undefined {
  let result: JavaScriptAssetResolution | undefined
  if (path !== undefined) result = readJavaScriptAsset(root, path)
  if (result?.ok === false && result.reason === 'unsafe') {
    diagnostics.push(diagnostic(code, 'plugin.json', `JavaScript 资产路径不安全：${path}。`))
    return undefined
  }
  if ((result === undefined || !result.ok) && options.allowPackedFallback === true) {
    const packed = findPackedJavaScriptEntry(root, entry)
    if (packed !== undefined) result = { ok: true, asset: packed }
  }
  if (result === undefined || !result.ok) {
    const label = path ?? `entry=${entry}`
    diagnostics.push(diagnostic('FH2_BACKEND_REFERENCE_MISSING', label, `JavaScript 资产不存在：${label}。`))
    return undefined
  }
  if (!validateJavaScriptSource(result.asset, entry, code, diagnostics, options.requireEntry ?? true)) return undefined
  return result.asset.source
}

interface LoadedWorkflow {
  readonly file: string;
  readonly workflow: Record<string, unknown>;
}

interface JavaScriptAsset {
  readonly file: string;
  readonly absolutePath: string;
  readonly source: string;
}

interface JavaScriptValidationOptions {
  readonly requireEntry?: boolean;
  readonly allowPackedFallback?: boolean;
}

type AssetFileResolution = {
  readonly ok: true;
  readonly absolutePath: string;
  readonly file: string;
} | {
  readonly ok: false;
  readonly reason: 'unsafe' | 'missing';
}

type JavaScriptAssetResolution = {
  readonly ok: true;
  readonly asset: JavaScriptAsset;
} | {
  readonly ok: false;
  readonly reason: 'unsafe' | 'missing';
}

function resolveAssetFile (root: string, path: string, extension: '.js' | '.ts' | '.json'): AssetFileResolution {
  if (!isSafeAssetPath(path, extension)) return { ok: false, reason: 'unsafe' }
  const absolutePath = resolve(root, path)
  if (!isPathInside(root, absolutePath) || !existsSync(absolutePath)) return { ok: false, reason: 'missing' }
  try {
    const realRoot = realpathSync(root)
    const realPath = realpathSync(absolutePath)
    if (!isPathInside(realRoot, realPath)) return { ok: false, reason: 'unsafe' }
    if (!statSync(realPath).isFile()) return { ok: false, reason: 'missing' }
    return { ok: true, absolutePath: realPath, file: relativeFile(realRoot, realPath) }
  } catch {
    return { ok: false, reason: 'missing' }
  }
}

function readJavaScriptAsset (root: string, path: string): JavaScriptAssetResolution {
  // 清单声明的路径可能是 .js 或 .ts(打包阶段两者都进同一条 esbuild 链)。
  const file = path.endsWith('.ts')
    ? resolveAssetFile(root, path, '.ts')
    : resolveAssetFile(root, path, '.js')
  if (!file.ok) return file
  try {
    return {
      ok: true,
      asset: {
        file: file.file,
        absolutePath: file.absolutePath,
        source: readFileSync(file.absolutePath, 'utf8'),
      },
    }
  } catch {
    return { ok: false, reason: 'missing' }
  }
}

function findPackedJavaScriptEntry (root: string, entry: string): JavaScriptAsset | undefined {
  let candidates: ReturnType<typeof discoverBackendHandlerFiles>
  try {
    candidates = discoverBackendHandlerFiles(root)
  } catch {
    return undefined
  }
  for (const candidate of candidates) {
    if (candidate.kind !== 'packed') continue
    const result = readJavaScriptAsset(root, candidate.path)
    if (result.ok && topLevelFunctionNames(result.asset.source).includes(entry)) return result.asset
  }
  return undefined
}

function validateJavaScriptSource (
  asset: JavaScriptAsset,
  entry: string,
  code: string,
  diagnostics: BackendContractDiagnostic[],
  requireEntry = true,
): boolean {
  // .ts 源码:vm.Script 无法解析类型语法 —— 语法合法性由 Bundle 阶段的 esbuild
  // (ts loader)裁决,这里只做入口检测。Source 阶段的策略校验在 source-contract。
  if (!asset.file.endsWith('.ts')) {
    try {
      const compiled = new Script(asset.source, { filename: asset.absolutePath })
      void compiled
    } catch (error) {
      diagnostics.push(diagnostic(code, asset.file, `JavaScript 语法错误：${message(error)}`))
      return false
    }
  }
  if (requireEntry && !hasEntry(asset.source, entry)) {
    diagnostics.push(diagnostic(code, asset.file, `JavaScript 未声明入口函数 ${entry}。`))
    return false
  }
  return true
}

function collectWorkflowScriptReferences (workflows: readonly LoadedWorkflow[]): ReadonlySet<string> {
  const references = new Set<string>()
  for (const { workflow } of workflows) {
    if (!Array.isArray(workflow.steps)) continue
    for (const step of workflow.steps) {
      if (!isRecord(step) || step.action !== 'run_script' || !isRecord(step.inputs)) continue
      const reference = constantString(step.inputs.script)
      if (reference !== undefined) references.add(reference)
    }
  }
  return references
}

function hasTriggerKind (workflow: Record<string, unknown>): boolean {
  const trigger = workflow.trigger
  if (!isRecord(trigger)) return false
  return ['api', 'schedule', 'stream', 'bizNotify', 'job'].some(kind => trigger[kind] !== undefined)
}

function validateWorkflowTrigger (
  file: string,
  workflow: Record<string, unknown>,
  eventStatuses: readonly string[],
  diagnostics: BackendContractDiagnostic[],
): void {
  const trigger = workflow.trigger
  if (!isRecord(trigger)) return
  if (isRecord(trigger.stream)) validateStreamTrigger(file, trigger.stream, eventStatuses, diagnostics)
  if (isRecord(trigger.bizNotify)) validateBizNotifyTrigger(file, trigger.bizNotify, diagnostics)
  if (isRecord(trigger.job)) validateJobTrigger(file, trigger.job, diagnostics)
}

function validateStreamTrigger (
  file: string,
  stream: Record<string, unknown>,
  eventStatuses: readonly string[],
  diagnostics: BackendContractDiagnostic[],
): void {
  const match = stream.match
  if (!isRecord(match) || Object.keys(match).length === 0) {
    diagnostics.push(diagnostic('FH2_BACKEND_WORKFLOW_INVALID', file, 'trigger.stream.match 不能为空。'))
  } else {
    for (const key of Object.keys(match)) {
      if (!streamMatchFields.has(key)) {
        diagnostics.push(diagnostic(
          'FH2_BACKEND_WORKFLOW_INVALID',
          file,
          `trigger.stream.match 包含不支持的字段：${key}。`,
        ))
      }
    }
    const status = match.status
    if (typeof status === 'string' && eventStatuses.length > 0 && !eventStatuses.includes(status)) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_WORKFLOW_INVALID',
        file,
        `trigger.stream.match.status ${JSON.stringify(status)} 未声明在 eventStatuses 中。`,
      ))
    }
  }
  for (const seed of stringArray(stream.seed)) {
    if (!streamSeedFields.has(seed)) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_WORKFLOW_INVALID',
        file,
        `trigger.stream.seed 包含不可播字段：${seed}。`,
      ))
    }
  }
}

function validateBizNotifyTrigger (
  file: string,
  trigger: Record<string, unknown>,
  diagnostics: BackendContractDiagnostic[],
): void {
  if (typeof trigger.subscriber !== 'string' || trigger.subscriber.trim() === '') {
    diagnostics.push(diagnostic('FH2_BACKEND_WORKFLOW_INVALID', file, 'trigger.bizNotify.subscriber 不能为空。'))
  }
  for (const seed of stringArray(trigger.seed)) {
    if (!bizNotifySeedFields.has(seed)) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_WORKFLOW_INVALID',
        file,
        `trigger.bizNotify.seed 包含不可播字段：${seed}。`,
      ))
    }
  }
  if (!isRecord(trigger.params)) return
  const targets = new Set<string>()
  for (const [name, value] of Object.entries(trigger.params)) {
    if (name.trim() === '') {
      diagnostics.push(diagnostic('FH2_BACKEND_WORKFLOW_INVALID', file, 'trigger.bizNotify.params 不能包含空键。'))
      continue
    }
    if (!isRecord(value)) continue
    const target = typeof value.as === 'string' && value.as.trim() !== '' ? value.as.trim() : name
    if (bizNotifySeedFields.has(target)) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_WORKFLOW_INVALID',
        file,
        `trigger.bizNotify.params.${name} 与任务元数据键 ${target} 冲突。`,
      ))
    }
    if (targets.has(target)) {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_WORKFLOW_INVALID',
        file,
        `trigger.bizNotify.params 有多个参数落到 ${target}。`,
      ))
    }
    targets.add(target)
    const type = value.type
    if (type !== undefined && type !== 'number' && type !== 'string' && type !== 'bool') {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_WORKFLOW_INVALID',
        file,
        `trigger.bizNotify.params.${name}.type 必须是 number、string、bool 或省略。`,
      ))
    }
    const max = value.max
    if (typeof max === 'number' && max < 0) {
      diagnostics.push(diagnostic('FH2_BACKEND_WORKFLOW_INVALID', file, `trigger.bizNotify.params.${name}.max 不能为负数。`))
    }
    if (typeof max === 'number' && max !== 0 && type !== 'number') {
      diagnostics.push(diagnostic(
        'FH2_BACKEND_WORKFLOW_INVALID',
        file,
        `trigger.bizNotify.params.${name}.max 只能与 type:number 一起使用。`,
      ))
    }
  }
}

function validateJobTrigger (
  file: string,
  trigger: Record<string, unknown>,
  diagnostics: BackendContractDiagnostic[],
): void {
  const seen = new Set<string>()
  for (const seed of stringArray(trigger.seed)) {
    if (seed.trim() === '') {
      diagnostics.push(diagnostic('FH2_BACKEND_WORKFLOW_INVALID', file, 'trigger.job.seed 不能包含空键。'))
    }
    if (seed !== seed.trim()) {
      diagnostics.push(diagnostic('FH2_BACKEND_WORKFLOW_INVALID', file, `trigger.job.seed ${JSON.stringify(seed)} 不能包含首尾空白。`))
    }
    if (seed === 'script') {
      diagnostics.push(diagnostic('FH2_BACKEND_WORKFLOW_INVALID', file, 'trigger.job.seed 不能使用保留键 script。'))
    }
    if (seen.has(seed)) {
      diagnostics.push(diagnostic('FH2_BACKEND_WORKFLOW_INVALID', file, `trigger.job.seed 重复：${seed}。`))
    }
    seen.add(seed)
  }
}

function validateWorkflowInterrupts (
  file: string,
  workflow: Record<string, unknown>,
  diagnostics: BackendContractDiagnostic[],
): void {
  if (!Array.isArray(workflow.steps)) return
  const waits = new Set<string>()
  const declarations: Record<string, unknown>[] = []
  for (const step of workflow.steps) {
    if (!isRecord(step)) continue
    for (const candidate of [step.await, step.callback]) {
      if (!isRecord(candidate)) continue
      declarations.push(candidate)
      if (typeof candidate.signal === 'string' && candidate.signal !== '') waits.add(candidate.signal)
    }
  }
  for (const declaration of declarations) {
    for (const signal of stringArray(declaration.interruptedBy)) {
      if (signal === '') {
        diagnostics.push(diagnostic('FH2_BACKEND_WORKFLOW_INVALID', file, 'await.interruptedBy 不能包含空信号名。'))
      } else if (waits.has(signal)) {
        diagnostics.push(diagnostic(
          'FH2_BACKEND_WORKFLOW_INVALID',
          file,
          `await.interruptedBy 信号 ${signal} 与某个 await/callback.signal 冲突。`,
        ))
      }
    }
  }
}

function stringArray (value: unknown): readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value as readonly string[]
    : []
}

function isSafeAssetPath (path: string, extension: '.js' | '.ts' | '.json'): boolean {
  return path !== ''
    && !isAbsolute(path)
    && !path.includes('\\')
    && path.endsWith(extension)
    && !path.split('/').some(segment => segment === '' || segment === '.' || segment === '..'
      || segment.startsWith('_') || !isPortableAssetSegment(segment))
}

function isPortableAssetSegment (segment: string): boolean {
  if (hasWindowsForbiddenCharacter(segment) || segment.endsWith('.') || segment.endsWith(' ')) return false
  const baseName = segment.split('.')[0]?.toUpperCase()
  return baseName === undefined || !WINDOWS_RESERVED_ASSET_NAMES.has(baseName)
}

function hasWindowsForbiddenCharacter (segment: string): boolean {
  for (const character of segment) {
    if ('<>:"|?*'.includes(character) || character.charCodeAt(0) < 0x20) return true
  }
  return false
}

function isPathInside (root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`)
}

function hasEntry (source: string, entry: string): boolean {
  if (topLevelFunctionNames(source).includes(entry)) return true
  const escaped = escapeRegExp(entry)
  const clean = stripJavaScriptNoise(source)
  const pattern = new RegExp(`\\bvar\\s+${escaped}\\s*=`, 'g')
  for (const match of clean.matchAll(pattern)) {
    if (braceDepthAt(clean, match.index ?? 0) === 0) return true
  }
  return false
}

function handlerEntries (source: string): readonly string[] {
  return topLevelFunctionNames(source).filter(entry => entry.startsWith('h_'))
}

/** ESM/TS 源码里有普通 export function:入口名由 Bundle 阶段的 esbuild 提取派生。 */
function hasAnyExportedFunction (source: string): boolean {
  return /\bexport\s+(?:async\s+)?function\s+[A-Za-z_$]/.test(stripJavaScriptNoise(source))
}

function scriptReference (script: WorkerBackendScript): string {
  const name = script.name?.trim()
  if (name !== undefined && name !== '') return name
  if (script.path !== undefined) {
    // 寻址名不带扩展名;显式 name 是打包无关的正路(见 plugin.go ScriptDecl.Name)。
    return basename(script.path.replace(/\.ts$/, ''), '.js')
  }
  return script.entry ?? ''
}

function topLevelFunctionNames (source: string): readonly string[] {
  const clean = stripJavaScriptNoise(source)
  const names = new Set<string>()
  const pattern = /\bfunction\s+([A-Za-z0-9_$]+)\s*\(/g
  for (const match of clean.matchAll(pattern)) {
    if (braceDepthAt(clean, match.index ?? 0) === 0) names.add(match[1]!)
  }
  return [...names]
}

function stripJavaScriptNoise (source: string): string {
  const output = source.split('')
  const blank = (index: number): void => {
    if (output[index] !== '\n') output[index] = ' '
  }
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index]
    if (character === '"' || character === '\'' || character === '`') {
      const quote = character
      blank(index)
      for (index += 1; index < output.length; index += 1) {
        if (output[index] === '\\') {
          blank(index)
          if (index + 1 < output.length) {
            index += 1
            blank(index)
          }
          continue
        }
        const done = output[index] === quote
        blank(index)
        if (done) break
      }
      continue
    }
    if (character !== '/' || index + 1 >= output.length) continue
    if (output[index + 1] === '/') {
      for (; index < output.length && output[index] !== '\n'; index += 1) blank(index)
      continue
    }
    if (output[index + 1] === '*') {
      blank(index)
      index += 1
      blank(index)
      for (index += 1; index < output.length; index += 1) {
        if (output[index] === '*' && index + 1 < output.length && output[index + 1] === '/') {
          blank(index)
          index += 1
          blank(index)
          break
        }
        blank(index)
      }
    }
  }
  return output.join('')
}

function braceDepthAt (source: string, position: number): number {
  let depth = 0
  for (let index = 0; index < position && index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}' && depth > 0) depth -= 1
  }
  return depth
}

function escapeRegExp (value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function constantString (value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.const !== 'string') return undefined
  return value.const
}

function parseVersion (value: string): readonly [number, number, number] {
  const parts = value.split('.').map(Number)
  return [parts[0]!, parts[1]!, parts[2]!]
}

function matchesVersion (
  actual: readonly [number, number, number],
  operator: string,
  expected: readonly [number, number, number],
): boolean {
  const comparison = actual[0] === expected[0]
    ? actual[1] === expected[1]
      ? actual[2] - expected[2]
      : actual[1] - expected[1]
    : actual[0] - expected[0]
  switch (operator) {
    case '>=': return comparison >= 0
    case '>': return comparison > 0
    case '<=': return comparison <= 0
    case '<': return comparison < 0
    case '=':
    case '==': return comparison === 0
    default: return false
  }
}

function normalizeFieldName (field: string): string {
  return field.replaceAll(/[A-Z]/g, (letter, index) => {
    const previous = field[index - 1]
    const next = field[index + 1]
    const needsSeparator = (previous !== undefined && /[a-z0-9]/.test(previous))
      || (next !== undefined && /[a-z]/.test(next))
    return `${needsSeparator ? '_' : ''}${letter.toLowerCase()}`
  })
}

function schemaDiagnostic (
  file: string,
  error: ErrorObject,
  code = 'FH2_BACKEND_MANIFEST_INVALID',
): BackendContractDiagnostic {
  const path = error.keyword === 'required' && typeof error.params.missingProperty === 'string'
    ? `${error.instancePath}/${error.params.missingProperty}`
    : error.keyword === 'additionalProperties' && typeof error.params.additionalProperty === 'string'
      ? `${error.instancePath}/${error.params.additionalProperty}`
      : error.instancePath
  const location = path === '' ? '' : `（${path}）`
  return diagnostic(code, file, `后端契约 Schema 校验失败${location}：${error.message ?? error.keyword}。`, path || undefined)
}

function diagnostic (
  code: string,
  file: string,
  messageValue: string,
  path?: string,
): BackendContractDiagnostic {
  return {
    code,
    file,
    message: messageValue,
    ...(path === undefined ? {} : { path }),
  }
}

function invalid (diagnostics: readonly BackendContractDiagnostic[]): BackendPluginValidationResult {
  return { ok: false, diagnostics }
}

function relativeFile (root: string, file: string): string {
  const result = relative(root, file).split(sep).join('/')
  return result === '' ? 'plugin.json' : result
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function compareText (left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
