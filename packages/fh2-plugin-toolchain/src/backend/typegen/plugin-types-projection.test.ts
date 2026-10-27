// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetDeveloperRuntimeCache } from '../../developer-runtime/loader.js'
import { SOURCE_CONTRACT_DIGEST, createDeveloperRuntimeFixture, mutateFixtureJson } from '../../developer-runtime/test-fixture.js'
import * as contractData from '../contract-data.js'
import { generatePluginTypes } from './plugin-types.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  resetDeveloperRuntimeCache()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('插件 ambient 消费运行投影', () => {
  it('输出字节及来源头部仍使用 source contractDigest，不使用 projectionDigest', async () => {
    const runtime = await createDeveloperRuntimeFixture()
    const plugin = await mkdtemp(join(tmpdir(), 'fh2-plugin-types-projection-'))
    roots.push(runtime.root, plugin)
    const facts = contractData.loadBackendContractFacts({ root: runtime.root })
    vi.spyOn(contractData, 'loadBackendContractFacts').mockReturnValue(facts)
    await mkdir(join(plugin, 'handlers'))
    await writeFile(join(plugin, 'handlers/test.ts'), 'export function handle() { return cache.get("k") }')
    await writeFile(join(plugin, 'fh2-plugin.json'), JSON.stringify({ allowlist: ['cache:read'] }))
    const first = generatePluginTypes(plugin)
    expect(first.worlds.get('handlers/test.ts')).toEqual(['cache', 'log'])
    const header = `// 本文件由 fh2-plugin types 生成,勿手改。\n// 世界规则:文件可用的全局 = 会加载它的沙箱注入面交集(∩ 本插件 allowlist)。\n// 来源契约: 1.1.0 / ${SOURCE_CONTRACT_DIGEST}\n\n`
    expect(first.files.get('handler.d.ts')).toBe(`${header}declare const cache: import('fh2-plugin-sdk/backend').CacheApi\n\ndeclare const log: import('fh2-plugin-sdk/backend').LogApi\n\ndeclare const ctx: import('fh2-plugin-sdk/backend').HandlerCtx\n`)
    expect([...generatePluginTypes(plugin).files]).toEqual([...first.files])
    expect(first.warnings).toEqual([])
    expect([...first.files.values()].join('\n')).not.toContain(runtime.manifest.projectionDigest)
    await writeFile(join(plugin, 'fh2-plugin.json'), JSON.stringify({ allowlist: [] }))
    const narrowed = generatePluginTypes(plugin)
    expect(narrowed.worlds.get('handlers/test.ts')).toEqual(['log'])
    expect(narrowed.files.get('handler.d.ts')).not.toContain('declare const cache')
  })

  it('正常未知全局仍生成 unknown 声明，并提供一条明确警告', async () => {
    const runtime = await createDeveloperRuntimeFixture()
    const plugin = await mkdtemp(join(tmpdir(), 'fh2-plugin-types-unknown-'))
    roots.push(runtime.root, plugin)
    await mutateFixtureJson(runtime.root, 'backend.json', (value) => {
      for (const form of Object.keys(value.forms)) value.forms[form].globals.futureApi = ['call']
    })
    vi.spyOn(contractData, 'loadBackendContractFacts').mockReturnValue(contractData.loadBackendContractFacts({ root: runtime.root }))
    await mkdir(join(plugin, 'handlers'))
    await writeFile(join(plugin, 'handlers/test.ts'), 'export function handle() {}')
    await writeFile(join(plugin, 'fh2-plugin.json'), '{}')
    const result = generatePluginTypes(plugin)
    expect(result.files.get('handler.d.ts')).toContain('declare const futureApi: unknown // 契约里没有该全局的模板映射(typegen 需补)')
    expect(result.warnings).toEqual(['全局 futureApi 缺少 SDK 类型映射，已生成 unknown 声明，请更新 typegen。'])
  })

  it.each(['toString', 'constructor', '__proto__'])('模板查找只认自身属性，不把 %s 的原型函数写入 ambient', async (global) => {
    const runtime = await createDeveloperRuntimeFixture()
    const plugin = await mkdtemp(join(tmpdir(), 'fh2-plugin-types-prototype-'))
    roots.push(runtime.root, plugin)
    const facts = contractData.loadBackendContractFacts({ root: runtime.root })
    // Isolate the template lookup from the loader's separate rejection of these names.
    vi.spyOn(contractData, 'loadBackendContractFacts').mockReturnValue({
      ...facts,
      hostApi: {
        ...facts.hostApi,
        forms: Object.fromEntries(Object.entries(facts.hostApi.forms).map(([form, surface]) => [form, { globals: { ...surface.globals, [global]: ['call'] } }])),
      },
    })
    await mkdir(join(plugin, 'handlers'))
    await writeFile(join(plugin, 'handlers/test.ts'), 'export function handle() {}')
    await writeFile(join(plugin, 'fh2-plugin.json'), '{}')
    const result = generatePluginTypes(plugin)
    expect(result.files.get('handler.d.ts')).toContain(`declare const ${global}: unknown`)
    expect([...result.files.values()].join('\n')).not.toContain('[native code]')
  })
})
