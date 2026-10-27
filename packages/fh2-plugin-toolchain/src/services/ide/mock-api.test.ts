// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { createDeveloperRuntimeFixture } from '../../developer-runtime/test-fixture.js'
import type { IdeSchemasData } from '../../contracts/ide.js'

const roots: string[] = []
let compiledSchemas: string

beforeAll(async () => {
  // Compile only the public schema consumer; no Toolchain build or private generators.
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./schemas.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    logLevel: 'silent',
  })
  compiledSchemas = result.outputFiles[0]!.text
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('iDE Mock API 公共 Schema 消费', () => {
  it.each(['valid', 'missing', 'tampered'] as const)('普通 Node 从同包投影加载 Schema：%s', async (state) => {
    const sandbox = await mkdtemp(join(tmpdir(), 'fh2-mock-api-schema-'))
    const runtime = await createDeveloperRuntimeFixture()
    roots.push(sandbox, runtime.root)
    const packageRoot = join(sandbox, 'packages/fh2-plugin-toolchain')
    const mockScript = join(packageRoot, 'ide/scripts/mock-api.mjs')
    await mkdir(join(packageRoot, 'ide/scripts'), { recursive: true })
    await mkdir(join(packageRoot, 'dist'))
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'fh2-plugin-toolchain', type: 'module' }))
    await writeFile(join(packageRoot, 'dist/index.js'), compiledSchemas)
    await symlink(fileURLToPath(new URL('../../../node_modules', import.meta.url)), join(packageRoot, 'node_modules'), 'dir')
    await copyFile(new URL('../../../ide/scripts/mock-api.mjs', import.meta.url), mockScript)
    await cp(runtime.root, join(packageRoot, 'developer-runtime'), { recursive: true })
    const sdkSchema = join(sandbox, 'packages/fh2-plugin-sdk/src/schema')
    await mkdir(sdkSchema, { recursive: true })
    await writeFile(join(sdkSchema, 'manifest.schema.json'), JSON.stringify({ type: 'object' }))
    if (state === 'missing') await rm(join(packageRoot, 'developer-runtime/schemas/workflow.schema.json'))
    if (state === 'tampered') await writeFile(join(packageRoot, 'developer-runtime/schemas/workflow.schema.json'), '{}')
    const workspace = join(sandbox, 'workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_frontend' }))
    const child = spawn(process.execPath, [mockScript, '--root', workspace, '--port', '0', '--token', 'fixture'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    try {
      const [ready] = await once(child.stdout, 'data')
      const url = String(ready).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
      expect(url).toBeDefined()
      const headers = { 'x-fh2-ide-token': 'fixture' }
      const response = await fetch(`${url}/api/schemas`, { headers })
      const envelope = await response.json() as { ok: boolean; data?: IdeSchemasData; error?: { code: string; message: string } }
      if (state !== 'valid') {
        expect(response.status).toBe(500)
        expect(envelope).toMatchObject({ ok: false, error: { code: 'FH2_IDE_INTERNAL' } })
        expect(envelope.error?.message).toContain(state === 'missing' ? '文件树' : 'bytes')
        return
      }
      expect(response.status).toBe(200)
      expect(envelope.ok).toBe(true)
      const schemas = envelope.data!.schemas
      expect(schemas.find(schema => schema.uri === 'fh2://schema/backend-plugin')?.schema).toMatchObject({ $id: 'fh2://fixture/source', additionalProperties: false })
      expect(schemas.find(schema => schema.uri === 'fh2://schema/workflow')?.schema).toMatchObject({ $id: 'fh2://fixture/workflow', required: ['name'] })
      expect(schemas.find(schema => schema.uri === 'fh2://schema/manifest')?.fileMatch).toEqual([join(workspace, 'fh2-plugin.json')])

      const backend = join(sandbox, 'backend-workspace')
      await mkdir(backend)
      await writeFile(join(backend, 'fh2-plugin.json'), JSON.stringify({ pluginId: 'exp_backend', contractsRange: '>=1.1.0' }))
      const opened = await fetch(`${url}/api/workspace/open`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ root: backend }) })
      expect(opened.status).toBe(200)
      const updated = await (await fetch(`${url}/api/schemas`, { headers })).json() as { data: IdeSchemasData }
      expect(updated.data.schemas.find(schema => schema.uri === 'fh2://schema/backend-plugin')?.fileMatch).toEqual([join(backend, 'fh2-plugin.json')])
      expect(updated.data.schemas.find(schema => schema.uri === 'fh2://schema/manifest')?.fileMatch).toEqual([])
    } finally {
      child.kill('SIGTERM')
      await exited
    }
  })
})
