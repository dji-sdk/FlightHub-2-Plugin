// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDeterministicZip } from '../../capability/zip.js'
import { buildProject } from './build.js'
import { generateProject } from './generate.js'
import { packProject } from './pack.js'
import { resolveRuntimeProfile } from './runtime-profile.js'
import { validateProject } from './validate.js'

const roots: string[] = []
const contexts = ['backend-plugin', 'capability-project', 'industry-capability-workspace'] as const
const nestedSources = contexts.flatMap(kind => ['handlers/demo/create.ts', 'handlers/demo/nested/deep/create.ts'].map(path => ({ kind, path })))

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('flow-only 生产应用链（D2）', () => {
  it.each(contexts)('%s：生成声明后 validate/build/pack/ZIP 成功且保留成员与声明', async (kind) => {
    const { root, pluginRoot } = await createProject(kind)
    const manifest = await readFile(join(pluginRoot, 'fh2-plugin.json'))
    const workflow = await readFile(join(pluginRoot, 'workflows/example.json'))

    const generated = generateProject(root)
    expect(generated.ok, JSON.stringify(generated.diagnostics)).toBe(true)
    const typesDir = join(pluginRoot, 'types')
    const typeNames = (await readdir(typesDir)).sort()
    expect(typeNames).toEqual(['adapter.d.ts', 'event.d.ts', 'handler.d.ts'])
    const declarations = await Promise.all(typeNames.map(file => readFile(join(typesDir, file))))
    expect(resolveRuntimeProfile(root).backend[0]!.sourceLanguage).toBe('javascript')

    const validated = validateProject(root)
    expect(validated.ok, JSON.stringify(validated.diagnostics)).toBe(true)
    const built = await buildProject(root)
    expect(built.ok, JSON.stringify(built.diagnostics)).toBe(true)
    expect(built.artifacts).toHaveLength(1)
    expect(await readFile(join(pluginRoot, 'dist/plugin.json'))).toEqual(manifest)
    expect(await readFile(join(pluginRoot, 'dist/workflows/example.json'))).toEqual(workflow)

    const packed = await packProject(root)
    expect(packed.ok, JSON.stringify(packed.diagnostics)).toBe(true)
    expect(packed.artifacts).toHaveLength(1)
    const standalone = kind === 'backend-plugin'
    const packageId = standalone ? 'exp_flow_member' : 'exp_flow_package'
    const memberPrefix = standalone ? 'exp_flow_member' : 'exp_flow_capability/backend/exp_flow_member'
    const entries = [
      { path: `${memberPrefix}/plugin.json`, data: manifest },
      { path: `${memberPrefix}/workflows/example.json`, data: workflow },
    ]
    if (!standalone) {
      const packageDir = join(root, 'release', packageId)
      entries.push(
        { path: 'packages.json', data: await readFile(join(packageDir, 'packages.json')) },
        { path: 'exp_flow_capability/capabilities.json', data: await readFile(join(packageDir, 'exp_flow_capability/capabilities.json')) },
      )
    }
    const archive = await readFile(resolve(root, packed.artifacts[0]!.path))
    expect(archive).toEqual(createDeterministicZip(entries))
    expect(await readFile(join(root, 'release', packageId, standalone ? 'plugin.json' : `${memberPrefix}/plugin.json`))).toEqual(manifest)
    expect((await readdir(typesDir)).sort()).toEqual(typeNames)
    expect(await Promise.all(typeNames.map(file => readFile(join(typesDir, file))))).toEqual(declarations)
    expect(generateProject(root, { check: true }).ok).toBe(true)
    expect(await readFile(join(pluginRoot, 'fh2-plugin.json'))).toEqual(manifest)
    expect(await readFile(join(pluginRoot, 'workflows/example.json'))).toEqual(workflow)
    expect(existsSync(join(pluginRoot, 'tsconfig.json'))).toBe(false)
    expect(existsSync(join(pluginRoot, 'package.json'))).toBe(false)
  })

  it.each(contexts)('%s：真实 .ts 源码缺 tsconfig 仍拒绝 build 和 pack', async (kind) => {
    const { root, pluginRoot } = await createProject(kind)
    await mkdir(join(pluginRoot, 'handlers'))
    await writeFile(join(pluginRoot, 'handlers/issue.ts'), 'export function h_createIssue(): number { return 1 }\n')
    expect(generateProject(root).ok).toBe(true)
    expect(validateProject(root).ok).toBe(true)
    expect(resolveRuntimeProfile(root).backend[0]!.sourceLanguage).toBe('typescript')

    for (const result of [await buildProject(root), await packProject(root)]) {
      expect(result.ok).toBe(false)
      expect(result.typechecked).toBe(false)
      expect(result.artifacts).toEqual([])
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: 'FH2_TYPECHECK_CONFIG_MISSING',
        phase: 'typecheck',
        severity: 'error',
      }))
    }
    expect(existsSync(join(pluginRoot, 'tsconfig.json'))).toBe(false)
    expect(existsSync(join(pluginRoot, 'dist'))).toBe(false)
    expect(existsSync(join(root, 'release'))).toBe(false)
  })

  it.each(nestedSources)('$kind：$path 无生成声明、缺 tsconfig 时仍拒绝 build/pack', async ({ kind, path }) => {
    const { root, pluginRoot } = await createProject(kind)
    await mkdir(dirname(join(pluginRoot, path)), { recursive: true })
    await writeFile(join(pluginRoot, path), 'export function h_create(): number { return 1 }\n')
    expect(validateProject(root).ok).toBe(true)
    expect(existsSync(join(pluginRoot, 'types'))).toBe(false)

    for (const result of [await buildProject(root), await packProject(root)]) {
      expect(result.ok).toBe(false)
      expect(result.typechecked).toBe(false)
      expect(result.artifacts).toEqual([])
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: 'FH2_TYPECHECK_CONFIG_MISSING',
        phase: 'typecheck',
        severity: 'error',
      }))
    }
    expect(existsSync(join(pluginRoot, 'dist'))).toBe(false)
    expect(existsSync(join(root, 'release'))).toBe(false)
  })

  it.each(nestedSources)('$kind：$path 有 tsconfig 时真实类型错误阻止 build/pack', async ({ kind, path }) => {
    const { root, pluginRoot } = await createProject(kind)
    await mkdir(dirname(join(pluginRoot, path)), { recursive: true })
    await writeFile(join(pluginRoot, path), 'export function h_create(): number { return "wrong" }\n')
    await writeFile(join(pluginRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: 'ES2022', lib: ['ES2022'], types: [], module: 'ESNext', moduleResolution: 'Bundler' },
      include: ['handlers/**/*.ts'],
    }))
    expect(validateProject(root).ok).toBe(true)
    expect(existsSync(join(pluginRoot, 'types'))).toBe(false)

    for (const result of [await buildProject(root), await packProject(root)]) {
      expect(result.ok).toBe(false)
      expect(result.artifacts).toEqual([])
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: 'TS2322',
        phase: 'typecheck',
        file: path,
        line: 1,
        severity: 'error',
      }))
    }
    expect(existsSync(join(pluginRoot, 'dist'))).toBe(false)
    expect(existsSync(join(root, 'release'))).toBe(false)
  })
})

async function createProject (kind: typeof contexts[number]): Promise<{ root: string; pluginRoot: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'fh2-flow-only-'))
  roots.push(workspace)
  const capabilityRoot = join(workspace, 'exp_flow_capability')
  const pluginRoot = join(capabilityRoot, 'backend/exp_flow_member')
  await mkdir(join(pluginRoot, 'workflows'), { recursive: true })
  await writeFile(join(workspace, 'packages.json'), JSON.stringify([{
    packageId: 'exp_flow_package',
    name: '纯流程回归包',
    capabilityIds: ['exp_flow_capability'],
  }]))
  await writeFile(join(capabilityRoot, 'capabilities.json'), JSON.stringify({ name: '纯流程能力', description: '生产应用链回归' }))
  await writeFile(join(pluginRoot, 'fh2-plugin.json'), JSON.stringify({
    pluginId: 'exp_flow_member',
    name: '纯流程插件',
    version: '0.1.0',
    flows: ['workflows/example.json'],
  }))
  await writeFile(join(pluginRoot, 'workflows/example.json'), JSON.stringify({
    name: 'flow-only-example',
    trigger: { api: {} },
    steps: [{ id: 'wait', action: 'wait_signal', await: { signal: 'done', timeoutSec: 1 } }],
  }))
  const root = kind === 'backend-plugin' ? pluginRoot : kind === 'capability-project' ? capabilityRoot : workspace
  return { root, pluginRoot }
}
