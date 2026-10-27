// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.

import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveContractRoot } from '../contract/root.js'
import { loadDeveloperRuntime, resetDeveloperRuntimeCache, resolveDeveloperRuntimeRoot } from './loader.js'
import { FACT_REF, UNRESOLVED_REF, createDeveloperRuntimeFixture, mutateFixtureJson, refreshDeveloperRuntimeFixture } from './test-fixture.js'
import { DEVELOPER_RUNTIME_FILES } from './types.js'

const roots: string[] = []
afterEach(async () => {
  resetDeveloperRuntimeCache()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture (): Promise<string> {
  const { root } = await createDeveloperRuntimeFixture()
  roots.push(root)
  return root
}

describe('开发者运行数据完整性', () => {
  it('从 Toolchain 包定位，且仅装载固定 ASCII 清单', async () => {
    const expected = fileURLToPath(new URL('../../developer-runtime', import.meta.url))
    expect(resolveDeveloperRuntimeRoot()).toBe(expected)
    expect(resolveContractRoot()).toBe(expected)
    const root = await fixture()
    const runtime = loadDeveloperRuntime({ root })
    expect(runtime.manifest.files.map(file => file.path)).toEqual(DEVELOPER_RUNTIME_FILES)
    expect(runtime.manifest.files.map(file => file.path)).toEqual([...DEVELOPER_RUNTIME_FILES].sort())
    for (const file of runtime.manifest.files) {
      const bytes = await readFile(join(root, file.path))
      expect(file.bytes).toBe(bytes.length)
      expect(file.sha256).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`)
    }
  })

  it('canonical 摘要不依赖对象键顺序或 JSON 空白，来源字段仍受摘要保护', async () => {
    const root = await fixture()
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
    const reordered = Object.fromEntries(Object.entries(manifest).reverse().map(([key, value]) => [
      key,
      key === 'sourceVersions' ? Object.fromEntries(Object.entries(value as object).reverse()) : value,
    ]))
    await writeFile(join(root, 'manifest.json'), JSON.stringify(reordered, null, 4))
    expect(loadDeveloperRuntime({ root }).manifest.projectionDigest).toBe(manifest.projectionDigest)
    resetDeveloperRuntimeCache()
    reordered.publishedEntries = 2
    await writeFile(join(root, 'manifest.json'), JSON.stringify(reordered))
    expect(() => loadDeveloperRuntime({ root })).toThrow('projectionDigest')
  })

  it('缓存仅包含完整成功加载的数据，嵌套值只读且可测试重置', async () => {
    const root = await fixture()
    const first = loadDeveloperRuntime({ root })
    expect(loadDeveloperRuntime({ root })).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.resources.facts[FACT_REF]?.value)).toBe(true)
    expect(Object.isFrozen(first.knowledge.entries[0]?.content.examples)).toBe(true)
    expect(Object.isFrozen(first.schemas.sourceManifest.properties)).toBe(true)
    await writeFile(join(root, 'backend.json'), '{}')
    expect(loadDeveloperRuntime({ root })).toBe(first)
    resetDeveloperRuntimeCache()
    expect(() => loadDeveloperRuntime({ root })).toThrow('bytes')
  })

  it('进程启动快照保持稳定，缓存重置后的读取会发现 manifest 漂移', async () => {
    const root = await fixture()
    const snapshot = loadDeveloperRuntime({ root })
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
    manifest.sourceVersions.contractStatus = 'changed-after-startup'
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
    expect(loadDeveloperRuntime({ root })).toBe(snapshot)
    expect(snapshot.manifest.sourceVersions.contractStatus).toBe('foundation-review-blocked')
    resetDeveloperRuntimeCache()
    expect(() => loadDeveloperRuntime({ root })).toThrow('projectionDigest')
  })

  it('失败不进入缓存，修复后可重试，显式夹具根互不串数据', async () => {
    const root = await fixture()
    const second = await fixture()
    await mutateFixtureJson(root, 'backend.json', value => value.capabilities.push('cache:write'))
    expect(() => loadDeveloperRuntime({ root })).toThrow('集合')
    const other = loadDeveloperRuntime({ root: second })
    await mutateFixtureJson(root, 'backend.json', value => value.capabilities.pop())
    const repaired = loadDeveloperRuntime({ root })
    expect(repaired).not.toBe(other)
    expect(repaired.root).toBe(await realpath(root))
    expect(other.root).toBe(await realpath(second))
    expect(loadDeveloperRuntime({ root: repaired.root })).toBe(repaired)
    expect(loadDeveloperRuntime({ root: second })).toBe(other)
  })

  it.each(['bytes', 'sha256'] as const)('拒绝错误文件 %s，即使 manifest 自身摘要已重算', async (field) => {
    const root = await fixture()
    await mutateFixtureJson(root, 'manifest.json', (value) => {
      value.files[0][field] = field === 'bytes' ? value.files[0].bytes + 1 : `sha256:${'0'.repeat(64)}`
    }, false)
    expect(() => loadDeveloperRuntime({ root })).toThrow(field)
  })

  it.each(['../backend.json', '/backend.json', 'schemas\\workflow.schema.json', 'extra.json'])('拒绝 manifest 路径 %s', async (path) => {
    const root = await fixture()
    await mutateFixtureJson(root, 'manifest.json', value => value.files[0].path = path, false)
    expect(() => loadDeveloperRuntime({ root })).toThrow('固定文件清单')
  })

  it('拒绝乱序或重复文件清单', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'manifest.json', value => value.files.reverse(), false)
    expect(() => loadDeveloperRuntime({ root })).toThrow('ASCII')
    await mutateFixtureJson(root, 'manifest.json', (value) => {
      value.files.reverse()
      value.files[1] = value.files[0]
    }, false)
    expect(() => loadDeveloperRuntime({ root })).toThrow('固定文件清单')
  })

  it('缺失和额外文件、空额外目录都拒绝', async () => {
    const root = await fixture()
    await rm(join(root, 'backend.json'))
    expect(() => loadDeveloperRuntime({ root })).toThrow('文件树')
    const extra = await fixture()
    await writeFile(join(extra, 'private.json'), '{}')
    expect(() => loadDeveloperRuntime({ root: extra })).toThrow('额外文件')
    const directory = await fixture()
    await mkdir(join(directory, 'empty'))
    expect(() => loadDeveloperRuntime({ root: directory })).toThrow('额外目录')
  })

  it('文件、目录和根目录符号链接都不作为数据源', async () => {
    const root = await fixture()
    await rm(join(root, 'backend.json'))
    await symlink(join(root, 'knowledge.json'), join(root, 'backend.json'))
    expect(() => loadDeveloperRuntime({ root })).toThrow('符号链接')
    const directory = await fixture()
    await rm(join(directory, 'schemas'), { recursive: true })
    await symlink(join(root, 'schemas'), join(directory, 'schemas'), 'dir')
    expect(() => loadDeveloperRuntime({ root: directory })).toThrow('符号链接')
    const alias = join(directory, 'root-alias')
    await symlink(root, alias, 'dir')
    expect(() => loadDeveloperRuntime({ root: alias })).toThrow('普通目录')
  })

  it('拒绝非严格 JSON、重复键和无效 UTF-8', async () => {
    const root = await fixture()
    await writeFile(join(root, 'backend.json'), '{"contractsVersion":"1.1.0","contractsVersion":"1.1.0"}')
    await refreshDeveloperRuntimeFixture(root)
    expect(() => loadDeveloperRuntime({ root })).toThrow('重复')
    await writeFile(join(root, 'backend.json'), '{/*comment*/}')
    await refreshDeveloperRuntimeFixture(root)
    expect(() => loadDeveloperRuntime({ root })).toThrow('严格 JSON')
    await writeFile(join(root, 'backend.json'), new Uint8Array([0xFF]))
    await refreshDeveloperRuntimeFixture(root)
    expect(() => loadDeveloperRuntime({ root })).toThrow('JSON')
  })
})

describe('开发者运行数据契约', () => {
  it.each([
    ['kind', (value: any) => value.kind = 'fh2-private-contract'],
    ['sourceBackendDigest', (value: any) => value.sourceBackendDigest = 'sha256:invalid'],
    ['approvedEntries', (value: any) => value.sourceVersions.approvedEntries = -1],
    ['contractDigest', (value: any) => value.sourceVersions.contractDigest = 'missing'],
    ['additional properties', (value: any) => value.approval = { reviewer: 'not-a-public-field' }],
  ])('拒绝非法 manifest %s', async (error, mutate) => {
    const root = await fixture()
    await mutateFixtureJson(root, 'manifest.json', mutate as (value: any) => void)
    expect(() => loadDeveloperRuntime({ root })).toThrow(error as string)
  })

  it('不接受空知识替代必需数据，也不允许公开计数冒充来源批准计数', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'knowledge.json', value => value.entries = [])
    await mutateFixtureJson(root, 'manifest.json', value => value.publishedEntries = 0)
    expect(() => loadDeveloperRuntime({ root })).toThrow('knowledge.json')
    const count = await fixture()
    await mutateFixtureJson(count, 'manifest.json', value => value.sourceVersions.approvedEntries = 0)
    expect(() => loadDeveloperRuntime({ root: count })).toThrow('approvedEntries')
  })

  it('拒绝旧完整 Host facts 字段与版本失配', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'backend.json', value => value.methodParams = {})
    expect(() => loadDeveloperRuntime({ root })).toThrow('additional properties')
    await mutateFixtureJson(root, 'backend.json', (value) => {
      delete value.methodParams
      value.contractsVersion = '2.0.0'
    })
    expect(() => loadDeveloperRuntime({ root })).toThrow('contractsVersion')
  })

  it.each([
    ['缺失入口形态', (value: any) => delete value.forms.httpHandler, 'httpHandler'],
    ['未知门控形态', (value: any) => value.capabilityGating['cache:read'].forms.push('other'), 'capabilityGating'],
    ['漏掉门控形态', (value: any) => value.capabilityGating['cache:read'].forms.pop(), '完整方法'],
    ['能力集合失配', (value: any) => value.capabilities.push('cache:write'), '集合'],
    ['未知门控方法', (value: any) => value.capabilityGating['cache:read'].globals.cache.push('set'), '注入面'],
    ['漏掉门控方法', (value: any) => value.forms.httpHandler.globals.cache.push('set'), '完整方法'],
    ['重复方法', (value: any) => value.forms.httpHandler.globals.cache.push('get'), 'duplicate'],
  ])('拒绝 %s', async (_label, mutate, error) => {
    const root = await fixture()
    await mutateFixtureJson(root, 'backend.json', mutate as (value: any) => void)
    expect(() => loadDeveloperRuntime({ root })).toThrow(error as string)
  })

  it.each(['toString', 'constructor', 'prototype', '__proto__', 'hasOwnProperty'])('拒绝重新计算摘要后的原型保留全局名 %s', async (global) => {
    const root = await fixture()
    await mutateFixtureJson(root, 'backend.json', (value) => {
      for (const form of Object.keys(value.forms)) value.forms[form].globals = { ...value.forms[form].globals, [global]: ['call'] }
    })
    expect(() => loadDeveloperRuntime({ root })).toThrow('原型')
  })

  it.each(['facts', 'files'] as const)('递归拒绝重新计算摘要后的 %s 原型污染键', async (resource) => {
    const root = await fixture()
    for (const unsafe of [
      JSON.parse('{"__proto__":{"polluted":true}}'),
      { constructor: { prototype: { polluted: true } } },
    ]) {
      await mutateFixtureJson(root, 'resources.json', (value) => {
        const payload = { nested: [unsafe] }
        if (resource === 'facts') value.facts[FACT_REF].value = payload
        else value.files['business.json'] = payload
      })
      expect(() => loadDeveloperRuntime({ root })).toThrow('不安全的原型键')
    }
  })

  it('schema 注释中的原型污染键同样在解析后拒绝', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'schemas/workflow.schema.json', value => value.examples = [{ constructor: { prototype: { polluted: true } } }])
    expect(() => loadDeveloperRuntime({ root })).toThrow('不安全的原型键')
  })

  it.each([
    'schemas/backend-plugin-source.schema.json',
    'schemas/backend-plugin-runtime.schema.json',
    'schemas/workflow.schema.json',
    'resources.json',
  ])('在 AJV 和缓存之前拒绝重新计算摘要的 %s 原始 1e999 数值', async (path) => {
    const root = await fixture()
    await mutateFixtureJson(root, path, (value) => {
      if (path === 'resources.json') value.facts[FACT_REF].value = { nested: ['overflow'] }
      else value.properties.name.minLength = 'overflow'
    })
    const source = (await readFile(join(root, path), 'utf8')).replace('"overflow"', '1e999')
    await writeFile(join(root, path), source)
    await refreshDeveloperRuntimeFixture(root)
    expect(() => loadDeveloperRuntime({ root })).toThrow('非有限数值')
  })

  it('文件资源数组中的负向指数溢出同样拒绝', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'resources.json', value => value.files['numbers.json'] = [0, { amount: 'overflow' }])
    const source = (await readFile(join(root, 'resources.json'), 'utf8')).replace('"overflow"', '-1e999')
    await writeFile(join(root, 'resources.json'), source)
    await refreshDeveloperRuntimeFixture(root)
    expect(() => loadDeveloperRuntime({ root })).toThrow('非有限数值')
  })

  it('保留普通业务 constructor/prototype/toString 键、Schema 属性名与有限数值', async () => {
    const root = await fixture()
    const business = { constructor: { name: 'Widget' }, prototype: { label: 'Example' }, toString: 'description', values: [1e100, -1e100] }
    await mutateFixtureJson(root, 'resources.json', value => value.files['business.json'] = business)
    await mutateFixtureJson(root, 'schemas/workflow.schema.json', (value) => {
      for (const name of ['constructor', 'prototype', 'toString']) value.properties[name] = { type: 'string' }
    })
    const runtime = loadDeveloperRuntime({ root })
    expect(runtime.resources.files['business.json']).toEqual(business)
    expect(runtime.schemas.workflow.properties).toMatchObject({ constructor: { type: 'string' }, prototype: { type: 'string' }, toString: { type: 'string' } })
  })

  it('能力贡献按方法集合合并，共享方法不重复计数，未门控的基线保留', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'backend.json', (value) => {
      value.capabilities.push('egress:fetch', 'integration:write', 'integration.gis:read')
      const forms = Object.keys(value.forms)
      for (const form of forms) value.forms[form].globals.connector = ['fetch', 'invoke']
      value.capabilityGating['egress:fetch'] = { forms, globals: { connector: ['fetch'] } }
      value.capabilityGating['integration:write'] = { forms, globals: { connector: ['invoke'] } }
      value.capabilityGating['integration.gis:read'] = { forms, globals: { connector: ['invoke'] } }
    })
    const runtime = loadDeveloperRuntime({ root })
    expect(runtime.backend.forms.httpHandler?.globals.connector).toEqual(['fetch', 'invoke'])
    expect(runtime.backend.forms.httpHandler?.globals.log).toEqual(['info'])
  })

  it('非法 targetId 在解构 domain/kind 前明确拒绝', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'knowledge.json', value => value.entries[0].targetId = 'invalid')
    expect(() => loadDeveloperRuntime({ root })).toThrow('domain/kind/localId')
  })

  it('未解析事实必须为 null 且有 warning，公开别名不能穿越', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'resources.json', value => value.facts[UNRESOLVED_REF].value = { private: true })
    expect(() => loadDeveloperRuntime({ root })).toThrow('resources.json')
    await mutateFixtureJson(root, 'resources.json', (value) => {
      value.facts[UNRESOLVED_REF].value = null
      delete value.facts[UNRESOLVED_REF].warning
    })
    expect(() => loadDeveloperRuntime({ root })).toThrow('warning')
    await mutateFixtureJson(root, 'resources.json', (value) => {
      value.facts[UNRESOLVED_REF].warning = '未解析'
      value.files['../private.json'] = {}
    })
    expect(() => loadDeveloperRuntime({ root })).toThrow('相对路径')
  })

  it('公开索引只允许引用已发布文件别名', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'resources.json', value => value.files['index.json'].documents.private = 'approval/final.approval.json')
    expect(() => loadDeveloperRuntime({ root })).toThrow('未发布文件别名')
  })

  it('公开别名不允许大小写冲突', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'resources.json', value => value.files['Index.json'] = {})
    expect(() => loadDeveloperRuntime({ root })).toThrow('大小写冲突')
  })

  it('缺少、未知版本或不可编译的 Schema 均拒绝', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'schemas/workflow.schema.json', value => value.$schema = 'https://json-schema.org/draft/2020-12/schema')
    expect(() => loadDeveloperRuntime({ root })).toThrow('Schema 版本')
    await mutateFixtureJson(root, 'schemas/workflow.schema.json', (value) => {
      value.$schema = 'http://json-schema.org/draft-07/schema#'
      value.type = 'not-a-json-schema-type'
    })
    expect(() => loadDeveloperRuntime({ root })).toThrow('无法编译')
    await rm(join(root, 'schemas/workflow.schema.json'))
    expect(() => loadDeveloperRuntime({ root })).toThrow('文件树')
  })

  it('未使用 definitions 中的引用也必须闭合，不读同级私有文件', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'schemas/workflow.schema.json', value => value.definitions = { unused: { $ref: 'private.schema.json' } })
    expect(() => loadDeveloperRuntime({ root })).toThrow('引用')
  })

  it('保留完整 Schema 约束、局部引用及已加载 Schema 间的引用', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'schemas/workflow.schema.json', (value) => {
      value.definitions = { name: { type: 'string', minLength: 2 } }
      value.properties.name = { $ref: '#/definitions/name' }
      value.allOf = [{ $ref: 'fh2://fixture/runtime' }]
    })
    const workflow = loadDeveloperRuntime({ root }).schemas.workflow
    expect(workflow.definitions).toEqual({ name: { type: 'string', minLength: 2 } })
    expect(workflow.allOf).toEqual([{ $ref: 'fh2://fixture/runtime' }])
  })

  it('注释、示例和 const 中的 $ref 只是 JSON 值，不当作 Schema 引用或删除', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'schemas/workflow.schema.json', (value) => {
      value.definitions = { literal: { const: { $ref: 'example-only.json' } } }
      value.examples = [{ $ref: 'example-only.json' }]
      value['x-example'] = { $ref: 'example-only.json' }
    })
    const schema = loadDeveloperRuntime({ root }).schemas.workflow
    expect(schema.definitions).toEqual({ literal: { const: { $ref: 'example-only.json' } } })
    expect(schema.examples).toEqual([{ $ref: 'example-only.json' }])
    expect(schema['x-example']).toEqual({ $ref: 'example-only.json' })
  })
})
