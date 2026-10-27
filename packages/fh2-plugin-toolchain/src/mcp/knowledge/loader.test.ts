// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resetDeveloperRuntimeCache } from '../../developer-runtime/loader.js'
import { FACT_REF, SOURCE_BUNDLE_DIGEST, SOURCE_CONTRACT_DIGEST, SOURCE_FACT_DIGEST, createDeveloperRuntimeFixture, mutateFixtureJson } from '../../developer-runtime/test-fixture.js'
import { loadKnowledgeBundle } from './loader.js'
import { createKnowledgeService } from './service.js'

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

describe('运行投影知识 loader fail-closed', () => {
  it('返回既有 DTO、来源版本、公开计数与独立投影摘要', async () => {
    const bundle = loadKnowledgeBundle(await fixture())
    expect(bundle.entries).toHaveLength(1)
    expect(bundle.domains).toEqual(['backend'])
    expect(bundle.kinds).toEqual(['capability'])
    expect(bundle.versions).toMatchObject({ contract: '0.2.0-fixture', approvedEntries: 4, contractDigest: SOURCE_CONTRACT_DIGEST, bundleDigest: SOURCE_BUNDLE_DIGEST })
    expect(bundle.projection.publishedEntries).toBe(1)
    expect(bundle.projection.projectionDigest).not.toBe(SOURCE_CONTRACT_DIGEST)
    expect(bundle.entries[0]?.sourceFactDigest).toBe(SOURCE_FACT_DIGEST)
  })

  it('document 是逻辑标识，不需要同名私有分片文件', async () => {
    const root = await fixture()
    const document = 'custom/shards/capabilities.json'
    await mutateFixtureJson(root, 'knowledge.json', value => value.entries[0].document = document)
    await mutateFixtureJson(root, 'resources.json', value => value.files['knowledge/index.json'].entries['backend.capability.cache:read'].document = document)
    const service = createKnowledgeService(loadKnowledgeBundle(root))
    expect(service.kindsByDomain).toEqual({ backend: ['capability'] })
    expect(service.list({ domain: 'backend', kind: 'capability' }).total).toBe(1)
  })

  it('非法知识来源状态与 formatVersion 均拒绝', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'manifest.json', value => value.sourceVersions.knowledgeStatus = 'proposed')
    expect(() => loadKnowledgeBundle(root)).toThrow('knowledgeStatus')
    await mutateFixtureJson(root, 'manifest.json', (value) => {
      value.sourceVersions.knowledgeStatus = 'reviewed'
      value.formatVersion = 2
    })
    expect(() => loadKnowledgeBundle(root)).toThrow('formatVersion')
  })

  it('条目数按 publishedEntries 对账，不覆盖来源 approvedEntries', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'manifest.json', value => value.publishedEntries = 2)
    expect(() => loadKnowledgeBundle(root)).toThrow('publishedEntries')
  })

  it('sourceFactDigest 与公开路由不一致拒绝', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'knowledge.json', value => value.entries[0].sourceFactDigest = SOURCE_BUNDLE_DIGEST)
    expect(() => loadKnowledgeBundle(root)).toThrow('sourceFactDigest')
  })

  it('evidence 必须具有精确公开事实映射', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'resources.json', value => delete value.facts[FACT_REF])
    expect(() => loadKnowledgeBundle(root)).toThrow('evidence')
  })

  it('缺少正文必填字段或空数组元素拒绝', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'knowledge.json', value => value.entries[0].content.examples = [''])
    expect(() => loadKnowledgeBundle(root)).toThrow('examples')
  })

  it('domain/kind/localId 必须与 targetId 一致', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'knowledge.json', value => value.entries[0].domain = 'frontend')
    expect(() => loadKnowledgeBundle(root)).toThrow('domain/kind/localId')
  })

  it('重复 targetId 与未对账公开索引均拒绝', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'knowledge.json', value => value.entries.push(value.entries[0]))
    await mutateFixtureJson(root, 'manifest.json', value => value.publishedEntries = 2)
    expect(() => loadKnowledgeBundle(root)).toThrow('重复')
    await mutateFixtureJson(root, 'knowledge.json', value => value.entries.pop())
    await mutateFixtureJson(root, 'manifest.json', value => value.publishedEntries = 1)
    await mutateFixtureJson(root, 'resources.json', value => value.files['knowledge/index.json'].entries.orphan = value.files['knowledge/index.json'].entries['backend.capability.cache:read'])
    expect(() => loadKnowledgeBundle(root)).toThrow('索引')
  })

  it('逻辑路径穿越与投影目录中的符号链接均拒绝', async () => {
    const root = await fixture()
    await mutateFixtureJson(root, 'knowledge.json', value => value.entries[0].document = '../private.json')
    expect(() => loadKnowledgeBundle(root)).toThrow('相对路径')
    const root2 = await fixture()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'private.json'), '{"private":true}')
    await symlink(outside, join(root2, 'leak'), 'dir')
    expect(() => loadKnowledgeBundle(root2)).toThrow('符号链接')
  })
})
