// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateBackendSourcePlugin } from './source-contract.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('validateBackendSourcePlugin', () => {
  it('接受合法 ESM 源码（import/export）', async () => {
    const root = await createSourceFixture()
    const result = validateBackendSourcePlugin(root)
    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual([])
    expect(result.manifestJson).toBeDefined()
    expect((result.manifestJson as Record<string, unknown>).pluginId).toBe('exp_backend_bundle')
  })

  it('在未声明 entities 时从 schema.sql 注入有效 manifest', async () => {
    const root = await createSourceFixture({ 'schema.sql': schemaSql('schema_record') })
    await removeManifestEntities(root)

    const result = validateBackendSourcePlugin(root)

    expect(result.ok, result.ok ? '' : result.diagnostics.map(diagnostic => diagnostic.message).join('; ')).toBe(true)
    expect(result.generatedEntities).toBe(true)
    expect(result.manifest?.entities).toEqual([
      {
        name: 'schema_record',
        fields: {
          record_key: { type: 'string', unique: true },
          happened_at: { type: 'datetime', indexed: true },
        },
      },
    ])
    expect((result.manifestJson as Record<string, unknown>).entities).toEqual(result.manifest?.entities)
  })

  it('在 source manifest 已声明 entities 时保留其声明', async () => {
    const root = await createSourceFixture({ 'schema.sql': schemaSql('other_record') })

    const result = validateBackendSourcePlugin(root)

    expect(result.ok).toBe(true)
    expect(result.generatedEntities).toBeUndefined()
    expect(result.manifest?.entities?.map(entity => entity.name)).toEqual(['demo_entity'])
  })

  it('将 schema.sql 解析错误返回为后端契约诊断', async () => {
    const root = await createSourceFixture({ 'schema.sql': 'DELETE FROM plugin_db_schema_record;\n' })
    await removeManifestEntities(root)

    const result = validateBackendSourcePlugin(root)

    expect(result.ok).toBe(false)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'FH2_SCHEMA_SQL_INVALID',
      file: 'schema.sql',
    }))
    expect(result.diagnostics.map(diagnostic => diagnostic.message).join('\n')).toContain('第 1 行第 1 列')
  })

  it('允许 enum、namespace 与 decorator TypeScript 源码', async () => {
    const root = await createSourceFixture({
      'shared/types.ts': [
        'function decorate (_target: unknown) {}',
        '@decorate',
        'export class Decorated {}',
        'export enum Status { Ready = "ready" }',
        'export namespace Metadata { export const label = Status.Ready }',
      ].join('\n'),
    })
    const result = validateBackendSourcePlugin(root)
    expect(result.ok, result.ok ? '' : result.diagnostics.map(diagnostic => diagnostic.message).join('; ')).toBe(true)
    expect(result.diagnostics).toEqual([])
  })

  it('拒绝 Node 内置模块 import', async () => {
    const root = await createSourceFixture({
      'handlers/a.js': 'import { readFile } from "node:fs"\nexport function h_a() { return readFile }\n',
    })
    const result = validateBackendSourcePlugin(root)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some(d => d.code === 'FH2_BACKEND_NODE_IMPORT_FORBIDDEN')).toBe(true)
  })

  it('拒绝裸 npm 包 import', async () => {
    const root = await createSourceFixture({
      'handlers/a.js': 'import _ from "lodash"\nexport function h_a() { return _ }\n',
    })
    const result = validateBackendSourcePlugin(root)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some(d => d.code === 'FH2_BACKEND_BARE_IMPORT_FORBIDDEN')).toBe(true)
  })

  it('拒绝动态 import', async () => {
    const root = await createSourceFixture({
      'handlers/a.js': 'export async function h_a() { return import("./shared/db.js") }\n',
    })
    const result = validateBackendSourcePlugin(root)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some(d => d.code === 'FH2_BACKEND_DYNAMIC_IMPORT_FORBIDDEN')).toBe(true)
  })

  it('拒绝 require', async () => {
    const root = await createSourceFixture({
      'handlers/a.js': 'const db = require("./shared/db.js")\nexport function h_a() { return db }\n',
    })
    const result = validateBackendSourcePlugin(root)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some(d => d.code === 'FH2_BACKEND_REQUIRE_FORBIDDEN')).toBe(true)
  })

  it('拒绝 import.meta', async () => {
    const root = await createSourceFixture({
      'handlers/a.js': 'export function h_a() { return import.meta.url }\n',
    })
    const result = validateBackendSourcePlugin(root)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some(d => d.code === 'FH2_BACKEND_IMPORT_META_FORBIDDEN')).toBe(true)
  })

  it('拒绝 setTimeout（Goja 无 Event Loop）', async () => {
    const root = await createSourceFixture({
      'handlers/a.js': 'export function h_a() { setTimeout(function () {}, 100) }\n',
    })
    const result = validateBackendSourcePlugin(root)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some(d => d.code === 'FH2_BACKEND_TIMER_FORBIDDEN')).toBe(true)
  })

  it('字符串中的 setTimeout 不误报', async () => {
    const root = await createSourceFixture({
      'handlers/a.js': 'export function h_a() { return "setTimeout(100)" }\n',
    })
    const result = validateBackendSourcePlugin(root)
    expect(result.ok).toBe(true)
  })

  it('evaluator 含 ESM 时拒绝（Phase 1 原样复制策略）', async () => {
    const root = await createSourceFixture({
      'evaluators/check.js': 'import { x } from "../shared/x.js"\nexport function check() { return x }\n',
    })
    await mkdir(join(root, 'shared'), { recursive: true })
    await writeFile(join(root, 'shared/x.js'), 'export const x = 1\n')
    const manifestPath = join(root, 'fh2-plugin.json')
    const manifest = JSON.parse(await readFileUtf8(manifestPath))
    manifest.evaluators = [{ name: 'check', path: 'evaluators/check.js', entry: 'check' }]
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

    const result = validateBackendSourcePlugin(root)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some(d => d.code === 'FH2_BACKEND_EVALUATOR_ESM_UNSUPPORTED')).toBe(true)
  })

  it('evaluator 普通 JS 原样复制时通过', async () => {
    const root = await createSourceFixture({
      'evaluators/check.js': 'function check(input) { return { ok: true } }\n',
    })
    const manifestPath = join(root, 'fh2-plugin.json')
    const manifest = JSON.parse(await readFileUtf8(manifestPath))
    manifest.evaluators = [{ name: 'check', path: 'evaluators/check.js', entry: 'check' }]
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

    const result = validateBackendSourcePlugin(root)
    expect(result.ok).toBe(true)
  })
})

async function readFileUtf8 (path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf8')
}

async function removeManifestEntities (root: string): Promise<void> {
  const manifestPath = join(root, 'fh2-plugin.json')
  const manifest = JSON.parse(await readFileUtf8(manifestPath)) as Record<string, unknown>
  delete manifest.entities
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
}

function schemaSql (entity: string): string {
  return [
    `CREATE TABLE plugin_db_${entity} (`,
    '  id TEXT PRIMARY KEY,',
    '  created_at TIMESTAMPTZ NOT NULL,',
    '  updated_at TIMESTAMPTZ NOT NULL,',
    '  tenant_id TEXT NULL,',
    '  record_key TEXT NOT NULL,',
    '  happened_at TIMESTAMPTZ NULL',
    ');',
    `CREATE UNIQUE INDEX uq_${entity}_key ON plugin_db_${entity} (record_key);`,
    `CREATE INDEX ix_${entity}_happened_at ON plugin_db_${entity} (happened_at);`,
  ].join('\n')
}

async function createSourceFixture (overrides?: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-backend-source-'))
  roots.push(root)

  const files: Record<string, string> = {
    'fh2-plugin.json': JSON.stringify({
      pluginId: 'exp_backend_bundle',
      name: 'Source 测试',
      version: '0.1.0',
      contractsRange: '>=1.1.0 <2.0.0',
      scripts: [
        { name: 'postprocess', path: 'adapters/postprocess.js', entry: 'handle' },
      ],
      events: [
        { type: 'media.video_created', consumer: [{ handler: 'events/on-video.js', entry: 'onVideo' }] },
      ],
      entities: [
        { name: 'demo_entity', fields: { key: { type: 'string', unique: true } } },
      ],
      allowlist: ['data:read', 'data:write'],
    }, null, 2),
    'adapters/postprocess.js': 'import { dbQuery } from "../shared/db.js"\nexport function handle(input) { return dbQuery(input) }\n',
    'events/on-video.js': 'export function onVideo(input) { return { ok: true } }\n',
    'handlers/a.js': 'import { dbQuery } from "../shared/db.js"\nexport function h_a(input) { return dbQuery(input) }\n',
    'handlers/b.js': 'import { dbQuery } from "../shared/db.js"\nexport function h_b(input) { return dbQuery(input) }\n',
    'shared/db.js': 'export function dbQuery(input) { return { ok: true, input } }\n',
    ...overrides,
  }

  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  return root
}
