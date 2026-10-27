// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readContractJson } from '../contract/root.js'
import { loadDeveloperRuntime, resetDeveloperRuntimeCache } from '../developer-runtime/loader.js'
import { SOURCE_BACKEND_DIGEST, SOURCE_CONTRACT_DIGEST, createDeveloperRuntimeFixture, mutateFixtureJson } from '../developer-runtime/test-fixture.js'
import { loadKnowledgeBundle } from '../mcp/knowledge/loader.js'
import * as contractData from './contract-data.js'
import { loadBackendContractFacts } from './contract-data.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  resetDeveloperRuntimeCache()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('后端运行投影 adapter', () => {
  it('仅提供校验和注入面需要的字段，区分来源与投影摘要', async () => {
    const { root, manifest } = await createDeveloperRuntimeFixture()
    roots.push(root)
    const facts = loadBackendContractFacts({ root })
    expect(facts.contractsVersion).toBe('1.1.0')
    expect(facts.contractStatus).toBe('foundation-review-blocked')
    expect(facts.capabilities).toEqual(['cache:read'])
    expect(Object.keys(facts.hostApi).sort()).toEqual(['capabilities', 'capabilityGating', 'contractsVersion', 'forms'])
    expect(facts.contractDigest).toBe(SOURCE_CONTRACT_DIGEST)
    expect(facts.sourceBackendDigest).toBe(SOURCE_BACKEND_DIGEST)
    expect(facts.projectionDigest).toBe(manifest.projectionDigest)
    expect(facts).not.toHaveProperty('storeErrorCodes')
    expect(facts).not.toHaveProperty('cacheErrorCodes')
  })

  it('backend 与 MCP 共享唯一加载缓存与只读数据', async () => {
    const { root } = await createDeveloperRuntimeFixture()
    roots.push(root)
    const facts = loadBackendContractFacts({ root })
    const runtime = loadDeveloperRuntime({ root })
    const bundle = loadKnowledgeBundle(root)
    expect(loadDeveloperRuntime({ root })).toBe(runtime)
    expect(loadBackendContractFacts({ root }).hostApi).toBe(facts.hostApi)
    expect(facts.hostApi).toBe(runtime.backend)
    expect(bundle.entries).toBe(runtime.knowledge.entries)
    expect(bundle.resources).toBe(runtime.resources)
    expect(Object.isFrozen(facts.hostApi.forms)).toBe(true)
  })

  it('装载三份 Schema，通用 JSON 入口只读公开别名', async () => {
    const { root } = await createDeveloperRuntimeFixture()
    roots.push(root)
    const facts = loadBackendContractFacts({ root })
    expect(facts.sourceManifestSchema.additionalProperties).toBe(false)
    expect(facts.runtimeManifestSchema.additionalProperties).toBe(false)
    expect(facts.workflowSchema.additionalProperties).toBe(false)
    expect(readContractJson(root, 'index.json')).toHaveProperty('documents.knowledge.index')
    expect(() => readContractJson(root, 'release.json')).toThrow('未发布')
    expect(() => readContractJson(root, '../private.json')).toThrow('越界')
  })

  it('源码与运行清单仍用 Source Schema 校验，不启用更严格 Runtime Schema', async () => {
    const { root } = await createDeveloperRuntimeFixture()
    const plugin = await mkdtemp(join(tmpdir(), 'fh2-backend-schema-selection-'))
    roots.push(root, plugin)
    await mutateFixtureJson(root, 'schemas/backend-plugin-source.schema.json', (value) => {
      value.properties.pluginId = { type: 'string' }
      value.properties.version = { type: 'string' }
      value.required = ['pluginId', 'name', 'version']
    })
    await mutateFixtureJson(root, 'schemas/backend-plugin-runtime.schema.json', value => value.required.push('runtimeOnly'))
    vi.spyOn(contractData, 'loadBackendContractFacts').mockReturnValue(loadBackendContractFacts({ root }))
    const { validateBackendPlugin } = await import('./contract.js')
    const manifest = { pluginId: 'exp_fixture', name: 'Fixture', version: '0.1.0' }
    expect(validateBackendPlugin(plugin, manifest, 'fh2-plugin.json').ok).toBe(true)
    expect(validateBackendPlugin(plugin, manifest, 'plugin.json').ok).toBe(true)
    const invalid = validateBackendPlugin(plugin, { ...manifest, extra: true }, 'plugin.json')
    expect(invalid).toMatchObject({ ok: false, diagnostics: [{ code: 'FH2_BACKEND_MANIFEST_INVALID', file: 'plugin.json' }] })
  })
})
