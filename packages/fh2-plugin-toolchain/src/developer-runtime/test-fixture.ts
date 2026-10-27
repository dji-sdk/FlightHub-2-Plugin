// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KnowledgeEntry } from '../mcp/knowledge/types.js'
import { DEVELOPER_RUNTIME_FILES } from './types.js'
import type { DeveloperRuntimeBackend, DeveloperRuntimeManifest, DeveloperRuntimeResources } from './types.js'

export const SOURCE_CONTRACT_DIGEST = `sha256:${'a'.repeat(64)}`
export const SOURCE_BUNDLE_DIGEST = `sha256:${'b'.repeat(64)}`
export const SOURCE_BACKEND_DIGEST = `sha256:${'c'.repeat(64)}`
export const SOURCE_FACT_DIGEST = `sha256:${'d'.repeat(64)}`
export const FACT_REF = 'backend/catalog/host-api.json#capabilityGating/cache:read'
export const UNRESOLVED_REF = 'backend/runtime-readiness.json#capability/cache:read'

export interface DeveloperRuntimeFixture {
  readonly root: string;
  readonly manifest: DeveloperRuntimeManifest;
}

/** Synthetic consumer data only; no source approval or private Contract dependency. */
export async function createDeveloperRuntimeFixture (): Promise<DeveloperRuntimeFixture> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-developer-runtime-'))
  await mkdir(join(root, 'schemas'))
  const backend: DeveloperRuntimeBackend = {
    contractsVersion: '1.1.0',
    capabilities: ['cache:read'],
    forms: Object.fromEntries(['httpHandler', 'eventHandler', 'workflowAdapter'].map(form => [form, {
      globals: { cache: ['get'], log: ['info'] },
    }])),
    capabilityGating: { 'cache:read': { forms: ['httpHandler', 'eventHandler', 'workflowAdapter'], globals: { cache: ['get'] } } },
  }
  const entry: KnowledgeEntry = {
    targetId: 'backend.capability.cache:read',
    domain: 'backend',
    kind: 'capability',
    localId: 'cache:read',
    document: 'backend/knowledge/capabilities.zh-CN.json',
    sourceFactDigest: SOURCE_FACT_DIGEST,
    content: { summary: '缓存读能力。', developerAction: '申报 cache:read。', useCases: ['读取缓存'], examples: ['cache.get("k")'] },
    evidence: [FACT_REF, UNRESOLVED_REF],
    uncertainties: ['未精确解析的事实不提供源文件。'],
  }
  const resources: DeveloperRuntimeResources = {
    facts: {
      [FACT_REF]: { value: backend.capabilityGating['cache:read'], resolved: true },
      [UNRESOLVED_REF]: { value: null, resolved: false, warning: '该事实引用无法精确解析，未提供源文档。' },
    },
    files: {
      'index.json': { schemaVersion: 1, documents: { knowledge: { index: 'knowledge/index.json' }, schemas: { source: 'schemas/backend-plugin-source.schema.json' } } },
      'knowledge/index.json': {
        schemaVersion: 1,
        layoutVersion: 2,
        entries: { [entry.targetId]: { document: entry.document, factRefs: entry.evidence, sourceFactDigest: entry.sourceFactDigest } },
      },
      'schemas/backend-plugin-source.schema.json': fixtureSchema('source'),
    },
  }
  const values: Record<string, unknown> = {
    'backend.json': backend,
    'knowledge.json': { locale: 'zh-CN', entries: [entry] },
    'resources.json': resources,
    'schemas/backend-plugin-source.schema.json': fixtureSchema('source'),
    'schemas/backend-plugin-runtime.schema.json': fixtureSchema('runtime'),
    'schemas/workflow.schema.json': fixtureSchema('workflow'),
  }
  for (const [path, value] of Object.entries(values)) await writeFile(join(root, path), JSON.stringify(value))
  await writeFile(join(root, 'manifest.json'), JSON.stringify({
    kind: 'fh2-developer-runtime',
    formatVersion: 1,
    sourceVersions: {
      contract: '0.2.0-fixture',
      contractsVersion: '1.1.0',
      knowledgeStatus: 'reviewed',
      contractStatus: 'foundation-review-blocked',
      approvedEntries: 4,
      contractDigest: SOURCE_CONTRACT_DIGEST,
      bundleDigest: SOURCE_BUNDLE_DIGEST,
    },
    sourceBackendDigest: SOURCE_BACKEND_DIGEST,
    publishedEntries: 1,
  }))
  return { root, manifest: await refreshDeveloperRuntimeFixture(root) }
}

export async function refreshDeveloperRuntimeFixture (root: string, refreshFiles = true): Promise<DeveloperRuntimeManifest> {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as DeveloperRuntimeManifest
  const files = refreshFiles
    ? await Promise.all(DEVELOPER_RUNTIME_FILES.map(async (path) => {
      const bytes = await readFile(join(root, path))
      return { path, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes: bytes.length }
    }))
    : manifest.files
  const content: Record<string, unknown> = { ...manifest, files }
  delete content.projectionDigest
  const result = { ...content, projectionDigest: `sha256:${createHash('sha256').update(fixtureCanonicalJson(content)).digest('hex')}` } as DeveloperRuntimeManifest
  await writeFile(join(root, 'manifest.json'), JSON.stringify(result))
  return result
}

export async function mutateFixtureJson (root: string, path: string, mutate: (value: any) => void, refreshFiles = true): Promise<void> {
  const value = JSON.parse(await readFile(join(root, path), 'utf8'))
  mutate(value)
  await writeFile(join(root, path), JSON.stringify(value))
  await refreshDeveloperRuntimeFixture(root, refreshFiles)
}

function fixtureSchema (name: string): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `fh2://fixture/${name}`,
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: { name: { type: 'string', minLength: 1 } },
  }
}

function fixtureCanonicalJson (value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fixtureCanonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${fixtureCanonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
