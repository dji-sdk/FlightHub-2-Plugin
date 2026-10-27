// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'
import Ajv from 'ajv'
import type { ValidateFunction } from 'ajv'
import { parseTargetId } from '../mcp/knowledge/types.js'
import { parseStrictJson } from '../validate/json-reader.js'
import { BACKEND_FORM_ROOTS, DEVELOPER_RUNTIME_FILES, DEVELOPER_RUNTIME_PACKAGE_NAME } from './types.js'
import type { DeveloperRuntime, DeveloperRuntimeBackend, DeveloperRuntimeManifest, DeveloperRuntimeOptions, DeveloperRuntimeResources } from './types.js'

const text = { type: 'string', minLength: 1 }
const digest = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' }
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const strings = { type: 'array', items: text }
const stringSet = { ...strings, minItems: 1, uniqueItems: true }
const formNames = BACKEND_FORM_ROOTS.map(root => root.form)
const globals = {
  type: 'object',
  minProperties: 1,
  propertyNames: { pattern: '^[A-Za-z_$][A-Za-z0-9_$]*$' },
  additionalProperties: { ...stringSet, items: { type: 'string', pattern: '^[A-Za-z_$][A-Za-z0-9_$]*$' } },
}
const dataAjv = new Ajv({ allErrors: true, strict: false })
const validateManifest = dataAjv.compile<DeveloperRuntimeManifest>(closedObject({
  kind: { const: 'fh2-developer-runtime' },
  formatVersion: { const: 1 },
  sourceVersions: closedObject({
    contract: text,
    contractsVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    knowledgeStatus: { const: 'reviewed' },
    contractStatus: text,
    approvedEntries: count,
    contractDigest: digest,
    bundleDigest: digest,
  }),
  sourceBackendDigest: digest,
  publishedEntries: count,
  files: { type: 'array', items: closedObject({ path: text, sha256: digest, bytes: count }) },
  projectionDigest: digest,
}))
const validateBackend = dataAjv.compile<DeveloperRuntimeBackend>(closedObject({
  contractsVersion: text,
  capabilities: stringSet,
  forms: closedObject(Object.fromEntries(formNames.map(form => [form, closedObject({ globals })]))),
  capabilityGating: {
    type: 'object',
    minProperties: 1,
    propertyNames: text,
    additionalProperties: closedObject({ forms: { ...stringSet, items: { enum: formNames } }, globals }),
  },
}))
const validateKnowledge = dataAjv.compile<DeveloperRuntime['knowledge']>(closedObject({
  locale: text,
  entries: {
    type: 'array',
    minItems: 1,
    items: closedObject({
      targetId: text,
      domain: text,
      kind: text,
      localId: text,
      document: text,
      sourceFactDigest: digest,
      content: closedObject({ summary: text, developerAction: text, useCases: strings, examples: strings }),
      evidence: stringSet,
      uncertainties: strings,
    }),
  },
}))
const validateResources = dataAjv.compile<DeveloperRuntimeResources>(closedObject({
  facts: {
    type: 'object',
    propertyNames: text,
    additionalProperties: {
      ...closedObject({ value: {}, resolved: { type: 'boolean' }, warning: text }, ['value', 'resolved']),
      if: { properties: { resolved: { const: false } } },
      then: { properties: { value: { type: 'null' } }, required: ['warning'] },
    },
  },
  files: { type: 'object', propertyNames: text, additionalProperties: true },
}))
const validateKnowledgeIndex = dataAjv.compile<{
  entries: Record<string, { document: string; factRefs: string[]; sourceFactDigest: string }>;
}>(closedObject({
  schemaVersion: { const: 1 },
  layoutVersion: { const: 2 },
  entries: {
    type: 'object',
    additionalProperties: closedObject({ document: text, factRefs: stringSet, sourceFactDigest: digest }),
  },
}))
const cached = new Map<string, DeveloperRuntime>()

/** Locate the same package-local projection in source and bundled entry layouts. */
export function resolveDeveloperRuntimeRoot (): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const packagePath = join(directory, 'package.json')
    if (existsSync(packagePath)) {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: unknown }
      if (pkg.name === DEVELOPER_RUNTIME_PACKAGE_NAME) return join(directory, 'developer-runtime')
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error('无法定位 Toolchain 包内 developer-runtime 目录。')
    directory = parent
  }
}

/** One fail-closed source for backend, IDE and MCP. Failed loads are never cached. */
export function loadDeveloperRuntime (options: DeveloperRuntimeOptions = {}): DeveloperRuntime {
  const root = resolve(options.root ?? resolveDeveloperRuntimeRoot())
  const existing = cached.get(root)
  if (existing !== undefined) return existing
  assertFileTree(root)
  const manifest = readJson(readFileSync(join(root, 'manifest.json')), 'manifest.json')
  assertData('manifest.json', validateManifest, manifest)
  if (manifest.files.length !== DEVELOPER_RUNTIME_FILES.length
    || manifest.files.some((file, index) => file.path !== DEVELOPER_RUNTIME_FILES[index])) {
    throw new Error('开发者运行数据 manifest.files 必须是固定文件清单，并按 ASCII 路径顺序排列。')
  }
  const { projectionDigest, ...manifestContent } = manifest
  if (sha256(canonicalJson(manifestContent)) !== projectionDigest) throw new Error('开发者运行数据 projectionDigest 不一致。')

  const values: Record<string, unknown> = {}
  for (const file of manifest.files) {
    const bytes = readFileSync(join(root, file.path))
    if (bytes.length !== file.bytes) throw new Error(`开发者运行数据 ${file.path} bytes 不一致。`)
    if (sha256(bytes) !== file.sha256) throw new Error(`开发者运行数据 ${file.path} sha256 不一致。`)
    values[file.path] = readJson(bytes, file.path)
  }
  const backend = values['backend.json']
  const knowledge = values['knowledge.json']
  const resources = values['resources.json']
  assertData('backend.json', validateBackend, backend)
  assertData('knowledge.json', validateKnowledge, knowledge)
  assertData('resources.json', validateResources, resources)
  if (backend.contractsVersion !== manifest.sourceVersions.contractsVersion) throw new Error('backend.json contractsVersion 与 sourceVersions 不一致。')
  assertInjection(backend)
  if (knowledge.entries.length !== manifest.publishedEntries) throw new Error('knowledge.json 条目数与 publishedEntries 不一致。')
  if (manifest.publishedEntries > manifest.sourceVersions.approvedEntries) throw new Error('publishedEntries 不能大于来源 approvedEntries。')

  const aliases = new Set<string>()
  for (const alias of Object.keys(resources.files)) {
    assertRelativePath(alias)
    if (!alias.endsWith('.json')) throw new Error(`公开文件别名不是 JSON：${alias}。`)
    if (aliases.has(alias.toLowerCase())) throw new Error(`公开文件别名大小写冲突：${alias}。`)
    aliases.add(alias.toLowerCase())
  }
  for (const ref of Object.keys(resources.facts)) assertRelativePath(ref.split('#')[0]!)
  const targets = new Set<string>()
  for (const entry of knowledge.entries) {
    const parsed = parseTargetId(entry.targetId)
    if (parsed === undefined || parsed.domain !== entry.domain || parsed.kind !== entry.kind || parsed.localId !== entry.localId) {
      throw new Error(`知识条目 ${entry.targetId} 的 domain/kind/localId 与 targetId 不一致。`)
    }
    if (targets.has(entry.targetId)) throw new Error(`知识 targetId 重复：${entry.targetId}。`)
    targets.add(entry.targetId)
    assertRelativePath(entry.document)
    for (const ref of entry.evidence) {
      if (!Object.hasOwn(resources.facts, ref)) throw new Error(`知识条目 ${entry.targetId} 的 evidence 缺少公开事实映射：${ref}。`)
    }
  }

  const rootIndexPath = 'index.json'
  const rootIndex = resources.files[rootIndexPath]
  if (!isRecord(rootIndex) || rootIndex.schemaVersion !== 1 || !isRecord(rootIndex.documents)
    || !isRecord(rootIndex.documents.knowledge) || typeof rootIndex.documents.knowledge.index !== 'string') {
    throw new Error('公开 index.json 缺少有效的 documents.knowledge.index。')
  }
  assertAliases(rootIndex.documents, resources.files)
  const knowledgeIndexPath = rootIndex.documents.knowledge.index
  const knowledgeIndex = resources.files[knowledgeIndexPath]
  assertData(knowledgeIndexPath, validateKnowledgeIndex, knowledgeIndex)
  if (Object.keys(knowledgeIndex.entries).length !== knowledge.entries.length) throw new Error('公开知识索引与知识条目数不一致。')
  for (const entry of knowledge.entries) {
    const route = knowledgeIndex.entries[entry.targetId]
    if (route === undefined || route.document !== entry.document || route.sourceFactDigest !== entry.sourceFactDigest
      || canonicalJson([...route.factRefs].sort()) !== canonicalJson([...entry.evidence].sort())) {
      throw new Error(`公开知识索引与条目 ${entry.targetId} 的 document/sourceFactDigest/factRefs 不一致。`)
    }
  }

  const schemaAjv = new Ajv({ allErrors: true, strict: false })
  const schemas: Record<string, Record<string, unknown>> = {}
  for (const path of DEVELOPER_RUNTIME_FILES.filter(path => path.startsWith('schemas/'))) {
    const schema = values[path]
    if (!isRecord(schema) || schema.$schema !== 'http://json-schema.org/draft-07/schema#'
      || typeof schema.$id !== 'string' || schema.$id.length === 0) {
      throw new Error(`开发者运行数据 ${path} 的 Schema 版本或 $id 非法。`)
    }
    try {
      schemaAjv.addSchema(schema, path)
    } catch (error) {
      throw new Error(`开发者运行数据 ${path} Schema 无法编译：${message(error)}`)
    }
    schemas[path] = schema
  }
  for (const path of Object.keys(schemas)) {
    try {
      // AJV resolves references only against this registry, never against adjacent files.
      assertSchemaReferences(schemas[path], schemas[path]!.$id as string, schemaAjv)
      schemaAjv.getSchema(path)
    } catch (error) {
      throw new Error(`开发者运行数据 ${path} Schema 引用不闭合或无法编译：${message(error)}`)
    }
  }
  const result = freeze({
    root: realpathSync(root),
    manifest,
    backend,
    knowledge,
    resources,
    schemas: {
      sourceManifest: schemas['schemas/backend-plugin-source.schema.json']!,
      runtimeManifest: schemas['schemas/backend-plugin-runtime.schema.json']!,
      workflow: schemas['schemas/workflow.schema.json']!,
    },
    rootIndexPath,
    knowledgeIndexPath,
  })
  cached.set(root, result)
  cached.set(result.root, result)
  return result
}

/** Test-only reset shared by all consumers. */
export function resetDeveloperRuntimeCache (): void {
  cached.clear()
}

function closedObject (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, properties, required }
}

function assertData<T> (path: string, validate: ValidateFunction<T>, value: unknown): asserts value is T {
  if (!validate(value)) throw new Error(`开发者运行数据 ${path} 非法：${dataAjv.errorsText(validate.errors)}。`)
}

function assertFileTree (root: string): void {
  try {
    if (!lstatSync(root).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error('缺少 developer-runtime 普通目录，拒绝回退其他数据源。')
  }
  const paths: string[] = []
  const seen = new Set<string>()
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const path = `${prefix}${entry.name}`
      if (entry.isSymbolicLink()) throw new Error(`开发者运行数据禁止符号链接：${path}。`)
      if (seen.has(path.toLowerCase())) throw new Error(`开发者运行数据路径大小写冲突：${path}。`)
      seen.add(path.toLowerCase())
      if (entry.isDirectory()) {
        if (path !== 'schemas') throw new Error(`开发者运行数据存在额外目录：${path}。`)
        visit(join(directory, entry.name), `${path}/`)
      } else if (entry.isFile()) {
        paths.push(path)
      } else {
        throw new Error(`开发者运行数据不是普通文件：${path}。`)
      }
    }
  }
  visit(root, '')
  const expected = ['manifest.json', ...DEVELOPER_RUNTIME_FILES].sort()
  paths.sort()
  if (canonicalJson(paths) !== canonicalJson(expected)) throw new Error('开发者运行数据文件树不完整或存在额外文件。')
}

function assertInjection (backend: DeveloperRuntimeBackend): void {
  if (canonicalJson([...backend.capabilities].sort()) !== canonicalJson(Object.keys(backend.capabilityGating).sort())) {
    throw new Error('backend.json capabilities 与 capabilityGating 集合不一致。')
  }
  for (const surface of [...Object.values(backend.forms), ...Object.values(backend.capabilityGating)]) {
    for (const global of Object.keys(surface.globals)) {
      if (global === 'prototype' || Object.hasOwn(Object.prototype, global)) {
        throw new Error(`backend.json 注入面含保留的原型全局名：${global}。`)
      }
    }
  }
  const gatedGlobals = new Set(Object.values(backend.capabilityGating).flatMap(gating => Object.keys(gating.globals)))
  for (const [form, surface] of Object.entries(backend.forms)) {
    const contributions = new Map<string, Set<string>>()
    for (const [capability, gating] of Object.entries(backend.capabilityGating)) {
      if (!gating.forms.includes(form)) continue
      for (const [global, methods] of Object.entries(gating.globals)) {
        if (methods.some(method => !surface.globals[global]?.includes(method))) {
          throw new Error(`backend.json capabilityGating ${capability} 超出 ${form}.${global} 注入面。`)
        }
        const combined = contributions.get(global) ?? new Set<string>()
        methods.forEach(method => combined.add(method))
        contributions.set(global, combined)
      }
    }
    for (const [global, methods] of Object.entries(surface.globals)) {
      if (gatedGlobals.has(global) && contributions.get(global)?.size !== methods.length) {
        throw new Error(`backend.json capabilityGating 未覆盖 ${form}.${global} 的完整方法集合。`)
      }
    }
  }
}

function assertRelativePath (path: string): void {
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path)
    || path.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error(`公开资源路径不是安全的 POSIX 相对路径：${path}。`)
  }
}

function assertAliases (value: unknown, files: DeveloperRuntimeResources['files']): void {
  if (typeof value === 'string') {
    if (!Object.hasOwn(files, value)) throw new Error(`公开索引引用了未发布文件别名：${value}。`)
  } else if (isRecord(value) || Array.isArray(value)) {
    for (const child of Object.values(value)) assertAliases(child, files)
  } else {
    throw new Error('公开索引 documents 含非法文件别名。')
  }
}

function assertSchemaReferences (value: unknown, base: string, ajv: Ajv): void {
  if (Array.isArray(value)) {
    value.forEach(child => assertSchemaReferences(child, base, ajv))
  } else if (isRecord(value)) {
    const scope = typeof value.$id === 'string' ? new URL(value.$id, base).href : base
    if (typeof value.$ref === 'string' && ajv.getSchema(new URL(value.$ref, scope).href) === undefined) {
      throw new Error(`Schema 引用未包含在运行投影中：${value.$ref}`)
    }
    // Walk schema positions, not arbitrary JSON values in examples, const or x-* metadata.
    for (const key of ['definitions', '$defs', 'properties', 'patternProperties', 'dependencies']) {
      const schemas = value[key]
      if (isRecord(schemas)) Object.values(schemas).forEach(schema => assertSchemaReferences(schema, scope, ajv))
    }
    for (const key of ['items', 'additionalItems', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'allOf', 'anyOf', 'oneOf']) {
      assertSchemaReferences(value[key], scope, ajv)
    }
  }
}

function readJson (bytes: Uint8Array, path: string): unknown {
  try {
    const parsed = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), path)
    if (!parsed.ok) throw new Error(parsed.diagnostics.map(diagnostic => diagnostic.message).join(' '))
    assertJsonValue(parsed.parsed.value, path)
    return parsed.parsed.value
  } catch (error) {
    throw new Error(`无法读取开发者运行数据 ${path} JSON：${message(error)}`)
  }
}

function assertJsonValue (value: unknown, path: string): void {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${path} 含非有限数值。`)
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, `${path}/${index}`))
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || (key === 'constructor' && isRecord(child) && Object.hasOwn(child, 'prototype'))) {
        throw new Error(`${path}/${key} 含不安全的原型键。`)
      }
      assertJsonValue(child, `${path}/${key}`)
    }
  }
}

function canonicalJson (value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function sha256 (value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function freeze<T> (value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
