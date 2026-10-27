// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildBackendAssets } from './manifest.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('backend assets', () => {
  it('校验并复制 Handler/Event，生成摘要清单', async () => {
    const root = await createBackendFixture()
    const candidate = join(root, '.dist-next')
    await mkdir(candidate)
    const result = buildBackendAssets({ projectRoot: root, candidateRoot: candidate, frontendPluginId: 'exp_backend_test' })
    expect(result?.manifest.handlers[0]?.name).toBe('issue.create')
    expect(JSON.parse(await readFile(join(candidate, 'backend/asset-manifest.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      assets: [
        { kind: 'handler', path: 'handlers/issue.js', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { kind: 'event', path: 'events/photo-created.js', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ],
    })
  })

  it('拒绝前后端 ID 不一致和越界路径', async () => {
    const root = await createBackendFixture()
    const candidate = join(root, '.dist-next')
    await mkdir(candidate)
    expect(() => buildBackendAssets({ projectRoot: root, candidateRoot: candidate, frontendPluginId: 'exp_other' }))
      .toThrow(/前后端 pluginId 必须一致/)

    const manifestPath = join(root, 'backend/fh2-plugin.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.handlers[0].path = '../outside.js'
    await writeFile(manifestPath, JSON.stringify(manifest))
    expect(() => buildBackendAssets({ projectRoot: root, candidateRoot: candidate, frontendPluginId: 'exp_backend_test' }))
      .toThrow(/路径不安全/)
  })
})

async function createBackendFixture (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-backend-build-'))
  roots.push(root)
  await mkdir(join(root, 'backend/handlers'), { recursive: true })
  await mkdir(join(root, 'backend/events'), { recursive: true })
  await writeFile(join(root, 'backend/fh2-plugin.json'), JSON.stringify({
    pluginId: 'exp_backend_test',
    name: '后端测试',
    version: '0.1.0',
    handlers: [{ name: 'issue.create', path: 'handlers/issue.js', entry: 'createIssue', allowlist: ['data:write'] }],
    events: [{ type: 'media.photo_created', handler: 'events/photo-created.js', allowlist: ['data:write'] }],
    entities: [{ name: 'issue', fields: [{ name: 'title', type: 'string', required: true }] }],
  }))
  await writeFile(join(root, 'backend/handlers/issue.js'), 'function createIssue(input) { return { title: input.title } }\n')
  await writeFile(join(root, 'backend/events/photo-created.js'), 'function handle(event) { return { id: event.id } }\n')
  return root
}
