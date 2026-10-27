// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadBackendContractFacts } from '../../backend/contract-data.js'
import { loadDeveloperRuntime } from '../../developer-runtime/loader.js'
import { loadKnowledgeBundle, resolveContractRoot } from './loader.js'
import { factResourceUri } from './repository.js'
import { KnowledgeArgumentError, createKnowledgeService } from './service.js'

const bundle = loadKnowledgeBundle(resolveContractRoot())
const service = createKnowledgeService(bundle)

/**
 * 版本断言基准：主仓断言完整契约包版本（投影滞后时失败，提醒重跑 refresh-runtime）；
 * 公开源码树没有契约包，退回运行投影自带的 contract 版本，只锁服务报告值。
 * 判定（本文件深 5 级）：公开树根带 public-distribution.json 自标识（主仓根没有），
 * 且主仓的契约包位于 packages/ 下私有契约目录（相对本目录上溯 4 级）。
 */
const expectedContractVersion = (() => {
  if (existsSync(join(import.meta.dirname, '../../../..', '../..', 'public-distribution.json'))
    || !existsSync(join(import.meta.dirname, '..', '..', '..', '..', 'fh2-plugin-contract', 'package.json'))) {
    return bundle.versions.contract
  }
  const contractPackageJson = JSON.parse(readFileSync(
    join(import.meta.dirname, '..', '..', '..', '..', 'fh2-plugin-contract', 'package.json'),
    'utf8',
  )) as { version: string }
  return contractPackageJson.version
})()

describe('开发者运行投影真数据', () => {
  it('完整实际注入面由公共 backend 数据提供，三个入口均保留 62 方法', () => {
    const facts = loadBackendContractFacts()
    const runtime = loadDeveloperRuntime()
    expect(facts.hostApi).toBe(runtime.backend)
    expect(facts.hostApi.capabilities).toHaveLength(19)
    expect(Object.keys(facts.hostApi.forms).sort()).toEqual(['eventHandler', 'httpHandler', 'workflowAdapter'])
    for (const form of Object.values(facts.hostApi.forms)) {
      expect(Object.values(form.globals).flat()).toHaveLength(62)
      expect(form.globals.log).toEqual(['error', 'info', 'warn'])
      expect(form.globals.connector).toEqual(['fetch', 'invoke'])
    }
    expect(Object.keys(facts.hostApi).sort()).toEqual(['capabilities', 'capabilityGating', 'contractsVersion', 'forms'])
    expect(facts.hostApi.capabilityGating['integration:write']?.globals.connector).toEqual(['invoke'])
    expect(facts.hostApi.capabilityGating['integration.gis:read']?.globals.connector).toEqual(['invoke'])
    expect(facts.contractDigest).toBe(bundle.versions.contractDigest)
    expect(facts.sourceBackendDigest).toBe(bundle.projection.sourceBackendDigest)
    expect(facts.projectionDigest).toBe(bundle.projection.projectionDigest)
  })

  it('条目数与 publishedEntries 一致，domain/kind 从投影动态派生', () => {
    expect(service.size).toBe(bundle.projection.publishedEntries)
    expect(service.versions.approvedEntries).toBeGreaterThanOrEqual(service.size)
    expect(service.size).toBeGreaterThan(0)
    expect(service.domains).toEqual(['backend', 'frontend', 'tooling'])
    expect(service.kinds).toContain('point')
    expect(service.kinds).toContain('capability')
    expect(service.kindsByDomain.frontend).toContain('point')
    expect(service.kindsByDomain.backend).not.toContain('point')
    for (const entry of bundle.entries) expect(service.kindsByDomain[entry.domain]).toContain(entry.kind)
  })

  it('versions 提供内容来源指纹', () => {
    expect(service.versions).toMatchObject({
      contract: expectedContractVersion,
      knowledgeStatus: 'reviewed',
      contractStatus: expect.stringMatching(/^(ready-for-review|foundation-review-blocked)$/),
      approvedEntries: bundle.versions.approvedEntries,
    })
    expect(service.versions.contractDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(service.versions.bundleDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(bundle.projection.projectionDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(bundle.projection.sourceBackendDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(bundle.projection.projectionDigest).not.toBe(service.versions.contractDigest)
  })

  it('全部 targetId 精确查询均 Top 1 且 Resource URI 可回读', () => {
    for (const entry of bundle.entries) {
      const hit = service.search({ query: entry.targetId, limit: 1 }).items[0]
      expect(hit?.targetId).toBe(entry.targetId)
      expect(hit?.resourceUri).toBe(`fh2-contract://knowledge/${encodeURIComponent(entry.targetId)}`)
      expect(service.readContract(hit!.resourceUri).value).toMatchObject({ targetId: entry.targetId })
    }
  })

  it('结构化枚举 backend capability 完整、稳定且可分页', () => {
    const all = service.list({ domain: 'backend', kind: 'capability' })
    expect(all.total).toBe(19)
    expect(all.items).toHaveLength(19)
    expect(all.items.map(item => item.targetId)).toEqual([...all.items.map(item => item.targetId)].sort())
    expect(all.items.every(item => item.resourceUri.startsWith('fh2-contract://knowledge/'))).toBe(true)

    const page = service.list({ domain: 'backend', kind: 'capability', offset: 5, limit: 5 })
    expect(page.items).toEqual(all.items.slice(5, 10))
    expect(page.nextOffset).toBe(10)
    expect(service.list({ domain: 'backend', kind: 'capability', offset: 100 }).items).toEqual([])
    expect(service.list({ kind: 'point' }).total).toBe(11)
    expect(() => service.list({ domain: 'backend', kind: 'point' })).toThrow('backend 可用 kind')
    expect(() => service.list({ domain: 'backend', kind: 'host' })).toThrow(KnowledgeArgumentError)
    expect(() => service.list({ offset: -1 })).toThrow(KnowledgeArgumentError)
  })

  it('代表性查询覆盖 backend/frontend/tooling', () => {
    // 2026-10-15 知识再生成（run knowledge-20261015-014744）后 cache:read 摘要以英文
    // 「cache」描述（不再含中文「缓存」），代表性查询词随之对齐。
    expect(service.search({ query: '插件 cache 读', domain: 'backend' }).items.map(item => item.targetId)).toContain('backend.capability.cache:read')
    expect(service.search({ query: '如何使用后端 cache', domain: 'backend' }).items.slice(0, 5).map(item => item.targetId)).toContain('backend.capability.cache:read')
    expect(service.search({ query: '飞行动作按钮', domain: 'frontend' }).items.map(item => item.targetId)).toContain('frontend.point.cockpit.ui.flight-actions')
    expect(service.search({ query: 'tooling.command.build', domain: 'tooling', kind: 'command' }).items[0]?.targetId).toBe('tooling.command.build')
    expect(service.search({ query: 'tooling.restriction.backend-sandbox', domain: 'tooling' }).items[0]?.targetId).toBe('tooling.restriction.backend-sandbox')
  })

  it('全部 factRef 可安全读取；无法精确解析的 runtime-readiness 引用不返回源文件', () => {
    const uniqueRefs = new Set(bundle.entries.flatMap(entry => entry.evidence))
    const unresolved = [...uniqueRefs].map(ref => service.readContract(ref)).filter(result => !result.resolved)
    expect(uniqueRefs.size).toBeGreaterThan(0)
    expect(unresolved.length).toBeGreaterThan(0)
    expect(unresolved.every(result => result.ref.startsWith('backend/runtime-readiness.json#capability/'))).toBe(true)
    expect(unresolved.every(result => result.value === null && typeof result.warning === 'string' && result.warning.length > 0)).toBe(true)
    for (const ref of uniqueRefs) {
      const result = service.readContract(ref)
      expect(service.readContract(factResourceUri(ref))).toEqual(result)
      expect(result).toMatchObject(bundle.resources.facts[ref]!)
    }
  })

  it('代表性机器事实精确解析', () => {
    expect(service.readContract('backend/catalog/host-api.json#methods/cache.get')).toMatchObject({ resolved: true })
    expect(service.readContract('tooling/cli-commands.json#commands/build').value).toMatchObject({ name: 'build' })
    expect(service.readContract('tooling/source-restrictions.json#restrictions/backend-imports').value).toMatchObject({ id: 'backend-imports' })
    expect(service.readContract('frontend/bindings/points.json#cockpit/cockpit.ui.flight-actions').value).toMatchObject({ pointId: 'cockpit.ui.flight-actions' })
  })

  it('非法过滤与越界路径返回明确参数错误', () => {
    expect(() => service.search({ query: 'x', domain: 'server' })).toThrow(KnowledgeArgumentError)
    expect(() => service.search({ query: 'x', kind: 'host' })).toThrow(KnowledgeArgumentError)
    expect(() => service.search({ query: '扩展点', domain: 'backend', kind: 'point' })).toThrow('kind "point" 不属于 domain "backend"')
    expect(() => service.readContract('../../etc/passwd')).toThrow('未发布')
    expect(() => service.readContract('unknown.target.id')).toThrow('未发布')
    expect(() => service.readContract('approval/final.approval.json')).toThrow('未发布')
  })
})
