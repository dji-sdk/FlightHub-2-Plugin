// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveRuntimeProfile } from './runtime-profile.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('resolveRuntimeProfile（S1b）', () => {
  it('普通目录无语言环境', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-profile-plain-'))
    roots.push(root)

    const profile = resolveRuntimeProfile(root)

    expect(profile.kind).toBe('unknown')
    expect(profile.frontend).toEqual([])
    expect(profile.backend).toEqual([])
  })

  it('后端语言判定：深层 .ts 源判 typescript；.js 源码优先于 .d.ts 声明（DAG-020-03）', async () => {
    const root = await createCapabilityRoot()
    // 变体一：TS 源放在三层深的目录里 + types/ 下有 .d.ts 干扰
    const deep = join(root, 'backend/exp_back')
    await mkdir(deep, { recursive: true })
    await writeFile(join(deep, 'fh2-plugin.json'), JSON.stringify({ pluginId: 'exp_back' }))
    await mkdir(join(deep, 'adapters/nested/deep'), { recursive: true })
    await writeFile(join(deep, 'adapters/nested/deep/probe.ts'), 'export function handle() {}\n')
    await mkdir(join(deep, 'types/nested'), { recursive: true })
    await writeFile(join(deep, 'types/nested/probe.d.ts'), 'declare const diagnosticOnly: number;\n')
    expect(resolveRuntimeProfile(root).backend[0]).toMatchObject({ sourceLanguage: 'typescript' })

    // 变体二：只有 .js 源码时，types/ 下的 .d.ts 不能把工程拉成 typescript
    await rm(join(deep, 'adapters'), { recursive: true, force: true })
    await mkdir(join(deep, 'adapters'), { recursive: true })
    await writeFile(join(deep, 'adapters/probe.js'), 'function handle() {}\n')
    expect(resolveRuntimeProfile(root).backend[0]).toMatchObject({ sourceLanguage: 'javascript' })
  })

  it('capability 前后端环境彼此隔离：Vue 归前端、TS/类型目录归后端', async () => {
    const root = await createCapabilityRoot()
    await mkdir(join(root, 'frontend/exp_front/src'), { recursive: true })
    await writeFile(join(root, 'frontend/exp_front/fh2-plugin.json'), JSON.stringify({ id: 'exp_front' }))
    await writeFile(join(root, 'frontend/exp_front/src/App.vue'), '<template><div/></template>')
    await writeFile(join(root, 'frontend/exp_front/tsconfig.json'), '{}')
    await mkdir(join(root, 'backend/exp_back'), { recursive: true })
    await writeFile(join(root, 'backend/exp_back/fh2-plugin.json'), JSON.stringify({ pluginId: 'exp_back' }))
    await writeFile(join(root, 'backend/exp_back/tsconfig.json'), '{}')
    await mkdir(join(root, 'backend/exp_back/types'), { recursive: true })
    await writeFile(join(root, 'backend/exp_back/types/handler.d.ts'), 'declare const ctx: unknown\n')
    await mkdir(join(root, 'backend/exp_back/handlers'), { recursive: true })
    await writeFile(join(root, 'backend/exp_back/handlers/issue.ts'), 'export function createIssue(): number { return 1 }\n')
    await writeFile(join(root, 'backend/exp_back/schema.sql'), 'CREATE TABLE issue(id TEXT);')

    const profile = resolveRuntimeProfile(root)

    expect(profile.kind).toBe('capability-project')
    expect(profile.frontend).toHaveLength(1)
    expect(profile.frontend[0]).toMatchObject({ id: 'exp_front', hasVue: true })
    expect(profile.frontend[0]!.generatedTypesPath).toBeUndefined()
    expect(profile.backend).toHaveLength(1)
    expect(profile.backend[0]).toMatchObject({
      id: 'exp_back',
      sourceLanguage: 'typescript',
      typesDir: join(root, 'backend/exp_back/types'),
      schemaSqlPath: join(root, 'backend/exp_back/schema.sql'),
    })
  })

  it('后端纯 JS 源码识别为 javascript，不误报 typescript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-profile-backend-js-'))
    roots.push(root)
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({ pluginId: 'exp_js_backend', contractsRange: '>=1.0.0 <2.0.0' }))
    await mkdir(join(root, 'handlers'), { recursive: true })
    await writeFile(join(root, 'handlers/issue.js'), 'export function createIssue() {}\n')

    const profile = resolveRuntimeProfile(root)

    expect(profile.kind).toBe('backend-plugin')
    expect(profile.backend[0]!.sourceLanguage).toBe('javascript')
  })

  it('后端只有声明文件时不识别为 typescript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-profile-declarations-'))
    roots.push(root)
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({ pluginId: 'exp_declarations', flows: [] }))
    await writeFile(join(root, 'index.d.ts'), 'declare const value: number\n')
    await mkdir(join(root, 'types'), { recursive: true })
    await writeFile(join(root, 'types/handler.d.ts'), 'declare const ctx: unknown\n')
    await writeFile(join(root, 'types/module.d.mts'), 'export declare const value: number\n')
    await mkdir(join(root, 'types/nested/deep'), { recursive: true })
    await writeFile(join(root, 'types/nested/deep/value.d.ts'), 'declare const value: number\n')

    expect(resolveRuntimeProfile(root).backend[0]).toMatchObject({
      sourceLanguage: 'javascript',
      typesDir: join(root, 'types'),
    })
  })

  it('不扩大后端 TypeScript 判定到 .mts 源码', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-profile-mts-'))
    roots.push(root)
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({ pluginId: 'exp_mts', flows: [] }))
    await mkdir(join(root, 'handlers'), { recursive: true })
    await writeFile(join(root, 'handlers/issue.mts'), 'export const value: number = 1\n')

    expect(resolveRuntimeProfile(root).backend[0]!.sourceLanguage).toBe('javascript')
  })

  it.each(['handlers/demo/create.ts', 'handlers/demo/nested/deep/create.ts'])('后端递归识别真实嵌套源码 %s', async (path) => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-profile-nested-ts-'))
    roots.push(root)
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({ pluginId: 'exp_nested_ts', flows: [] }))
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), 'export function h_create(): number { return 1 }\n')

    expect(resolveRuntimeProfile(root).backend[0]!.sourceLanguage).toBe('typescript')
  })

  it.each(['node_modules', 'dist', '.fh2'])('后端递归仍跳过 %s 目录', async (directory) => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-profile-excluded-ts-'))
    roots.push(root)
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({ pluginId: 'exp_excluded_ts', flows: [] }))
    await mkdir(join(root, 'handlers/nested', directory, 'deep'), { recursive: true })
    await writeFile(join(root, 'handlers/nested', directory, 'deep/ignored.ts'), 'export const value: number = 1\n')

    expect(resolveRuntimeProfile(root).backend[0]!.sourceLanguage).toBe('javascript')
  })

  it('后端递归不跟随目录符号链接或循环链接', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-profile-symlink-'))
    const external = await mkdtemp(join(tmpdir(), 'fh2-profile-external-'))
    roots.push(root, external)
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({ pluginId: 'exp_symlink', flows: [] }))
    await writeFile(join(external, 'source.ts'), 'export const value: number = 1\n')
    await symlink(external, join(root, 'linked'), 'dir')
    await symlink(root, join(root, 'loop'), 'dir')

    expect(resolveRuntimeProfile(root).backend[0]!.sourceLanguage).toBe('javascript')
  })

  it.each([
    { path: 'src/one/two/three/App.vue', hasVue: true },
    { path: 'src/one/two/three/four/App.vue', hasVue: false },
  ])('前端 Vue 扫描仍保持四层：$path', async ({ path, hasVue }) => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-profile-vue-depth-'))
    roots.push(root)
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_vue_depth', entry: './plugin.js' }))
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), '<template><div/></template>')

    expect(resolveRuntimeProfile(root).frontend[0]!.hasVue).toBe(hasVue)
  })
})

async function createCapabilityRoot (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-profile-capability-'))
  roots.push(root)
  await writeFile(join(root, 'capabilities.json'), JSON.stringify({ name: '能力测试', description: '用于测试' }))
  return root
}
