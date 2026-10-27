// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { resetDeveloperRuntimeCache } from '../../developer-runtime/loader.js'
import { FACT_REF, SOURCE_BUNDLE_DIGEST, SOURCE_CONTRACT_DIGEST, UNRESOLVED_REF, createDeveloperRuntimeFixture } from '../../developer-runtime/test-fixture.js'
import { createFh2McpServer } from '../server.js'
import { loadKnowledgeBundle } from './loader.js'
import { createContractRepository, factResourceUri, knowledgeResourceUri } from './repository.js'
import { KnowledgeArgumentError, createKnowledgeService } from './service.js'

const roots: string[] = []
afterEach(async () => {
  resetDeveloperRuntimeCache()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture () {
  const { root } = await createDeveloperRuntimeFixture()
  roots.push(root)
  return loadKnowledgeBundle(root)
}

describe('公开资源精确映射读取', () => {
  it('保留知识、事实与公开文件 URI 和现有 DTO', async () => {
    const bundle = await fixture()
    const repository = createContractRepository(bundle)
    const entry = bundle.entries[0]!
    expect(repository.read(entry.targetId).value).toBe(entry)
    expect(repository.read(knowledgeResourceUri(entry.targetId))).toEqual(repository.readKnowledge(entry.targetId))
    expect(repository.read(FACT_REF)).toEqual(repository.read(factResourceUri(FACT_REF)))
    expect(repository.readFact(FACT_REF)).toMatchObject({ ref: FACT_REF, mimeType: 'application/json', resolved: true, value: { globals: { cache: ['get'] } } })
    const index = repository.readFile('index.json')
    expect(repository.read(index.resourceUri)).toEqual(index)
    expect(index.value).toBe(bundle.resources.files['index.json'])
  })

  it('无法精确解析的已发布事实返回 null/false/warning，不返回源文件', async () => {
    const repository = createContractRepository(await fixture())
    const result = repository.read(UNRESOLVED_REF)
    expect(result).toMatchObject({ value: null, resolved: false, warning: expect.stringContaining('无法精确解析') })
    expect(repository.read(factResourceUri(UNRESOLVED_REF))).toEqual(result)
  })

  it('任何未发布路径和片段都拒绝，即使磁盘上存在完整源文件', async () => {
    const bundle = await fixture()
    await mkdir(join(bundle.contractRoot, 'backend/catalog'), { recursive: true })
    await writeFile(join(bundle.contractRoot, 'backend/catalog/host-api.json'), '{"private":"never-return"}')
    await writeFile(join(bundle.contractRoot, 'release.json'), '{"approval":"never-return"}')
    const repository = createContractRepository(bundle)
    for (const ref of ['backend/catalog/host-api.json', 'backend/catalog/host-api.json#private', 'release.json', '../private.json', 'toString']) {
      expect(() => repository.read(ref)).toThrow('未发布')
      expect(() => repository.read(`fh2-contract://file/${encodeURIComponent(ref)}`)).toThrow('未发布')
      expect(() => repository.read(factResourceUri(ref))).toThrow('未发布')
    }
    expect(repository.readFact(FACT_REF).value).not.toHaveProperty('private')
  })

  it('repository 不依赖磁盘根存在；服务保留 INVALID_ARGUMENT 错误', async () => {
    const bundle = await fixture()
    const unavailableRoot = { ...bundle, contractRoot: join(bundle.contractRoot, 'absent') }
    const service = createKnowledgeService(unavailableRoot)
    expect(service.readContract('index.json').resolved).toBe(true)
    expect(() => service.readContract('private.json')).toThrow(KnowledgeArgumentError)
    expect(() => service.readContract('private.json')).toThrow('未发布')
  })

  it('mCP 仍注册 12 个工具，资源 URI 与成功/错误信封保持不变', async () => {
    const bundle = await fixture()
    const server = createFh2McpServer({ access: { mode: 'open', baseDir: bundle.contractRoot }, version: 'fixture', knowledge: createKnowledgeService(bundle) })
    const client = new Client({ name: 'projection-test', version: 'fixture' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const tools = await client.listTools()
      expect(tools.tools.map(tool => tool.name).sort()).toEqual([
        'build',
        'cancel_task',
        'create',
        'generate',
        'get_task',
        'inspect',
        'list_knowledge',
        'pack',
        'read_contract',
        'search_knowledge',
        'start_dev',
        'validate',
      ])
      const result = await client.callTool({ name: 'read_contract', arguments: { ref: factResourceUri(UNRESOLVED_REF) } })
      expect(result.structuredContent).toMatchObject({
        ok: true,
        data: {
          value: null,
          resolved: false,
          warning: expect.any(String),
          versions: { toolchain: 'fixture', contract: '0.2.0-fixture', approvedEntries: 4, contractDigest: SOURCE_CONTRACT_DIGEST, bundleDigest: SOURCE_BUNDLE_DIGEST, projection: bundle.projection },
        },
      })
      const failure = await client.callTool({ name: 'read_contract', arguments: { ref: 'approval/final.approval.json' } })
      expect(failure.isError).toBe(true)
      expect(failure.structuredContent).toMatchObject({ ok: false, error: { code: 'FH2_MCP_INVALID_ARGUMENT' } })
      const resources = await client.listResources()
      expect(resources.resources.map(resource => resource.uri)).toEqual(expect.arrayContaining(['fh2-contract://meta', 'fh2-contract://index', 'fh2-contract://knowledge-index', knowledgeResourceUri(bundle.entries[0]!.targetId)]))
      const index = await client.readResource({ uri: 'fh2-contract://index' })
      expect(JSON.parse((index.contents[0] as { text: string }).text)).toEqual(bundle.resources.files['index.json'])
      const knowledgeIndex = await client.readResource({ uri: 'fh2-contract://knowledge-index' })
      expect(JSON.parse((knowledgeIndex.contents[0] as { text: string }).text)).toEqual(bundle.resources.files['knowledge/index.json'])
      const meta = await client.readResource({ uri: 'fh2-contract://meta' })
      expect(JSON.parse((meta.contents[0] as { text: string }).text)).toMatchObject({
        ...bundle.versions,
        projection: { ...bundle.projection, publishedEntries: 1 },
        domains: ['backend'],
      })
      for (const [name, args] of [
        ['list_knowledge', { domain: 'backend' }],
        ['search_knowledge', { query: 'cache:read' }],
      ] as const) {
        const response = await client.callTool({ name, arguments: args })
        expect(response.structuredContent).toMatchObject({ ok: true, data: { versions: { ...bundle.versions, projection: bundle.projection } } })
      }
    } finally {
      await client.close()
      await server.close()
    }
  })
})
