// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildBackendPlugin } from './build.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('capability backend build', () => {
  it('校验后原样复制运行资产并写入 build-info', async () => {
    const root = await createBackendPlugin()

    const result = await buildBackendPlugin(root)

    expect(result.pluginId).toBe('exp_backend_build')
    expect(result.candidateRoot).toBeUndefined()
    expect(result.assets.map(asset => asset.path)).toEqual(expect.arrayContaining([
      'plugin.json',
      'schema.sql',
      'workflows/example-flow.json',
      'handlers/example/create.js',
      'events/example-created.js',
      'adapters/example-script.js',
      'scripts/.handlers.js',
    ]))
    for (const path of [
      'schema.sql',
      'workflows/example-flow.json',
      'handlers/example/create.js',
      'events/example-created.js',
      'adapters/example-script.js',
      'scripts/.handlers.js',
    ]) {
      expect(await readFile(join(root, 'dist', path), 'utf8')).toBe(await readFile(join(root, path), 'utf8'))
    }
    expect(await readFile(join(root, 'dist/plugin.json'), 'utf8')).toBe(await readFile(join(root, 'fh2-plugin.json'), 'utf8'))
    expect(JSON.parse(await readFile(join(root, 'dist/build-info.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      pluginId: 'exp_backend_build',
      version: '0.1.0',
    })
  })

  it('后端缺少 schema.sql 时构建仍通过且 dist 不含该文件', async () => {
    const root = await createBackendPlugin()
    await rm(join(root, 'schema.sql'))

    const result = await buildBackendPlugin(root)

    expect(result.pluginId).toBe('exp_backend_build')
    expect(existsSync(join(root, 'dist/schema.sql'))).toBe(false)
  })

  it('legacy copy 在 schema.sql 生成 entities 后写入有效 plugin.json 并监督 schema 变化', async () => {
    const root = await createBackendPlugin()
    const manifestPath = join(root, 'fh2-plugin.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    delete manifest.entities
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    await writeFile(join(root, 'schema.sql'), [
      'CREATE TABLE plugin_db_example_record (',
      '  id TEXT PRIMARY KEY,',
      '  created_at TIMESTAMPTZ NOT NULL,',
      '  updated_at TIMESTAMPTZ NOT NULL,',
      '  tenant_id TEXT NULL,',
      '  title TEXT NOT NULL',
      ');',
      'CREATE INDEX ix_example_record_title ON plugin_db_example_record (title);',
    ].join('\n'))

    const result = await buildBackendPlugin(root, { legacyCopyMode: true })
    const distManifest = JSON.parse(await readFile(join(root, 'dist/plugin.json'), 'utf8')) as Record<string, unknown>

    expect(distManifest.entities).toEqual([{
      name: 'example_record',
      fields: { title: { type: 'string', indexed: true } },
    }])
    expect(result.watchDependencies.some(path => path.endsWith('/schema.sql'))).toBe(true)
  })

  it('延迟提交时保留候选产物且不替换现有 dist', async () => {
    const root = await createBackendPlugin()
    await mkdir(join(root, 'dist'))
    await writeFile(join(root, 'dist/previous.txt'), 'old')

    const result = await buildBackendPlugin(root, { commit: false })

    expect(result.candidateRoot).toBeDefined()
    expect(await readFile(join(root, 'dist/previous.txt'), 'utf8')).toBe('old')
    expect(existsSync(join(result.candidateRoot!, 'plugin.json'))).toBe(true)
  })
})

async function createBackendPlugin (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-capability-backend-build-'))
  roots.push(root)
  await mkdir(join(root, 'workflows'), { recursive: true })
  await mkdir(join(root, 'handlers/example'), { recursive: true })
  await mkdir(join(root, 'events'), { recursive: true })
  await mkdir(join(root, 'adapters'), { recursive: true })
  await mkdir(join(root, 'scripts'), { recursive: true })
  await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({
    pluginId: 'exp_backend_build',
    name: '后端构建测试',
    version: '0.1.0',
    allowlist: ['data:read', 'data:write'],
    entities: [{
      name: 'example_record',
      fields: { title: { type: 'string' } },
    }],
    flows: ['workflows/example-flow.json'],
    scripts: [{ name: 'example-script', path: 'adapters/example-script.js', entry: 'handle' }],
    events: [{
      type: 'example.created',
      consumer: [{ handler: 'events/example-created.js', entry: 'handle' }],
    }],
  }))
  await writeFile(join(root, 'workflows/example-flow.json'), JSON.stringify({
    name: 'example-flow',
    trigger: { api: {} },
    steps: [{
      id: 'run-example',
      action: 'run_script',
      inputs: { script: { const: 'example-script' } },
    }],
  }))
  await writeFile(join(root, 'handlers/example/create.js'), 'function handle() { return {} }\n')
  await writeFile(join(root, 'events/example-created.js'), 'function handle() { return {} }\n')
  await writeFile(join(root, 'adapters/example-script.js'), 'function handle() { return {} }\n')
  await writeFile(join(root, 'scripts/.handlers.js'), 'function h_hidden_handler() { return {} }\n')
  await writeFile(join(root, 'schema.sql'), 'CREATE TABLE example_record (title TEXT);\n')
  return root
}
