// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { buildBackendPlugin } from './build.js'
import { packBackendPlugin } from './pack.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('backend plugin pack', () => {
  it('bundle 后的 dist 组装为插件交付物目录 + 确定性 zip', async () => {
    const pluginRoot = await createDefaultCapabilityBackendRoot()
    await buildBackendPlugin(pluginRoot)

    const first = await packBackendPlugin({ pluginRoot })
    expect(first.warnings).toEqual([])

    const expectedFiles = [
      'plugin.json',
      'schema.sql',
      'scripts/handlers.js',
      'scripts/events.js',
      'scripts/adapter.js',
    ]
    for (const file of expectedFiles) {
      expect(await readFile(join(first.packageDir, file), 'utf8')).toBeTruthy()
    }
    const handlers = await readFile(join(first.packageDir, 'scripts/handlers.js'), 'utf8')
    expect(handlers).toContain('function h_example_create(')
    expect(handlers).not.toMatch(/\bimport\s/)
    expect(handlers).not.toMatch(/\bexport\s/)
    // build-info.json 与 sourcemap 不得进入交付物。
    await expect(readFile(join(first.packageDir, 'build-info.json'))).rejects.toMatchObject({ code: 'ENOENT' })

    const second = await packBackendPlugin({ pluginRoot })
    expect(await readFile(first.zipPath)).toEqual(await readFile(second.zipPath))
    expect(await readFile(first.zipPath)).toEqual(await readFile(first.zipPath))
    expect(createHash('sha256').update(await readFile(first.zipPath)).digest('hex'))
      .toBe(createHash('sha256').update(await readFile(second.zipPath)).digest('hex'))

    const entries = readZipEntries(await readFile(first.zipPath))
    const paths = entries.map(entry => entry.path)
    expect(paths).toContain('exp_pack_backend/plugin.json')
    expect(paths).toContain('exp_pack_backend/scripts/handlers.js')
    expect(paths.some(path => path.includes('build-info'))).toBe(false)
  })

  it('schema.sql 生成的 entities 会进入 bundle dist 与交付包', async () => {
    const pluginRoot = await createDefaultCapabilityBackendRoot()
    const manifestPath = join(pluginRoot, 'fh2-plugin.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    delete manifest.entities
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    await writeFile(join(pluginRoot, 'schema.sql'), [
      'CREATE TABLE plugin_db_example_record (',
      '  id TEXT PRIMARY KEY,',
      '  created_at TIMESTAMPTZ NOT NULL,',
      '  updated_at TIMESTAMPTZ NOT NULL,',
      '  tenant_id TEXT NULL,',
      '  record_key TEXT NOT NULL',
      ');',
      'CREATE UNIQUE INDEX uq_example_record_key ON plugin_db_example_record (record_key);',
    ].join('\n'))

    await buildBackendPlugin(pluginRoot)
    const expectedEntities = [{
      name: 'example_record',
      fields: { record_key: { type: 'string', unique: true } },
    }]
    expect(JSON.parse(await readFile(join(pluginRoot, 'dist/plugin.json'), 'utf8')).entities).toEqual(expectedEntities)

    const packed = await packBackendPlugin({ pluginRoot })
    expect(JSON.parse(await readFile(join(packed.packageDir, 'plugin.json'), 'utf8')).entities).toEqual(expectedEntities)
  })

  it('dist 缺失时明确报错', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-backend-pack-missing-'))
    roots.push(root)
    const pluginRoot = join(root, 'backend', 'exp_missing_backend')
    await mkdir(join(pluginRoot, 'handlers/items'), { recursive: true })
    await writeFile(join(pluginRoot, 'fh2-plugin.json'), JSON.stringify({
      pluginId: 'exp_missing_backend',
      name: '缺 dist',
      version: '0.1.0',
    }))
    await writeFile(join(pluginRoot, 'handlers/items/get.js'), 'function h_items_get() { return {} }\n')

    await expect(packBackendPlugin({ pluginRoot })).rejects.toMatchObject({
      diagnostic: expect.objectContaining({ code: 'FH2_BACKEND_PACK_DIST_INVALID' }),
    })
  })
})

async function createDefaultCapabilityBackendRoot (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-backend-pack-'))
  roots.push(root)
  const pluginRoot = join(root, 'backend', 'exp_pack_backend')
  const toolchainRoot = join(import.meta.dirname, '../..')
  const templateRoot = join(toolchainRoot, 'template-backend')
  const { cp } = await import('node:fs/promises')
  await cp(templateRoot, pluginRoot, { recursive: true })
  const manifest = await readFile(join(pluginRoot, 'fh2-plugin.json'), 'utf8')
  await writeFile(join(pluginRoot, 'fh2-plugin.json'), manifest
    .replaceAll('__BACKEND_PLUGIN_ID__', 'exp_pack_backend')
    .replaceAll('__BACKEND_PLUGIN_NAME__', '默认 ESM 后端'), 'utf8')
  return pluginRoot
}

interface ZipEntry {
  readonly path: string;
  readonly data: Buffer;
}

/** 解析本地无目录结构的 zip（由 createDeterministicZip 生成）。 */
function readZipEntries (archive: Buffer): readonly ZipEntry[] {
  const entries: ZipEntry[] = []
  let offset = 0
  while (offset + 30 <= archive.byteLength) {
    const signature = archive.readUInt32LE(offset)
    if (signature !== 0x04034B50) break
    const method = archive.readUInt16LE(offset + 8)
    const compressedSize = archive.readUInt32LE(offset + 18)
    const nameLength = archive.readUInt16LE(offset + 26)
    const extraLength = archive.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const path = archive.subarray(nameStart, nameStart + nameLength).toString('utf8')
    const compressed = archive.subarray(dataStart, dataStart + compressedSize)
    const data = method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed)
    entries.push({ path, data })
    offset = dataStart + compressedSize
  }
  return entries
}
