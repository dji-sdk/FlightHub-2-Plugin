// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Ajv from 'ajv'
import { loadDeveloperRuntime, resetDeveloperRuntimeCache } from '../../developer-runtime/loader.js'
import { createDeveloperRuntimeFixture, mutateFixtureJson } from '../../developer-runtime/test-fixture.js'
import { resolveIdeSchemas } from './schemas.js'

const roots: string[] = []
let developerRuntimeRoot: string

beforeEach(async () => {
  const fixture = await createDeveloperRuntimeFixture()
  developerRuntimeRoot = fixture.root
  roots.push(fixture.root)
})

afterEach(async () => {
  resetDeveloperRuntimeCache()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('iDE Schema fileMatch', () => {
  it('行业工作区只为真实后端成员生成嵌套 Workflow glob', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-schema-workspace-'))
    roots.push(root)
    await writeFile(join(root, 'packages.json'), JSON.stringify([{
      packageId: 'official_test_package',
      name: 'Test',
      capabilityIds: ['official_accident', 'official_frontend_only'],
    }]))
    await createCapability(root, 'official_accident')
    await createCapability(root, 'official_frontend_only')
    await createBackend(root, 'official_accident', 'official_accident_backend')
    await createFrontend(root, 'official_accident', 'official_accident_frontend')
    await createFrontend(root, 'official_frontend_only', 'official_frontend_only_ui')

    const workflow = resolveIdeSchemas({ root, developerRuntimeRoot }).schemas.find(schema => schema.uri === 'fh2://schema/workflow')

    expect(workflow?.fileMatch).toEqual([
      '**/official_accident/backend/official_accident_backend/workflows/*.json',
      '**/official_accident/backend/official_accident_backend/flows/*.json',
      '**/official_accident/backend/official_accident_backend/*.flow.json',
    ])
    expect(workflow?.fileMatch.join('\n')).not.toContain('official_accident_frontend')
    expect(workflow?.fileMatch.join('\n')).not.toContain('official_frontend_only')
    const capability = resolveIdeSchemas({ root, developerRuntimeRoot }).schemas.find(schema => schema.uri === 'fh2://schema/capability-metadata')
    expect(capability?.fileMatch).toEqual([
      join(root, 'official_accident/capabilities.json'),
      join(root, 'official_frontend_only/capabilities.json'),
    ])
  })

  it('capabilities.json 损坏时仍关联自身及嵌套前后端 Manifest Schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-schema-invalid-capability-'))
    roots.push(root)
    await writeFile(join(root, 'capabilities.json'), JSON.stringify({ name: '临时能力', description: '待破坏' }))
    await createBackend(root, '.', 'official_backend')
    await createFrontend(root, '.', 'official_frontend')
    await writeFile(join(root, 'capabilities.json'), JSON.stringify({
      name: '损坏能力',
      description2: '未知字段且缺 description',
    }))

    const schemas = resolveIdeSchemas({ root, developerRuntimeRoot }).schemas
    const capability = schemas.find(schema => schema.uri === 'fh2://schema/capability-metadata')
    const frontend = schemas.find(schema => schema.uri === 'fh2://schema/manifest')
    const backend = schemas.find(schema => schema.uri === 'fh2://schema/backend-plugin')

    expect(capability?.fileMatch).toEqual([join(root, 'capabilities.json')])
    expect(frontend?.fileMatch).toEqual([join(root, 'frontend/official_frontend/fh2-plugin.json')])
    expect(backend?.fileMatch).toEqual([join(root, 'backend/official_backend/fh2-plugin.json')])
    const validate = new Ajv({ allErrors: true }).compile(capability!.schema as object)
    expect(validate({ name: '损坏能力', description: '有效描述' })).toBe(true)
    expect(validate({ name: '   ', description: '\n' })).toBe(false)
    expect(validate.errors?.map(error => error.keyword)).toEqual(['pattern', 'pattern'])
    expect(validate({ name: '损坏能力', description2: '错误字段' })).toBe(false)
    expect(validate.errors?.map(error => error.keyword)).toEqual(expect.arrayContaining(['required', 'additionalProperties']))
  })

  it('独立后端插件根仍匹配根级 workflows/flows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-schema-backend-'))
    roots.push(root)
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({
      pluginId: 'official_backend_test',
      contractsRange: '>=1.1.0 <2.0.0',
    }))

    const workflow = resolveIdeSchemas({ root, developerRuntimeRoot }).schemas.find(schema => schema.uri === 'fh2://schema/workflow')

    expect(workflow?.fileMatch).toEqual([
      '**/workflows/*.json',
      '**/flows/*.json',
      '**/*.flow.json',
    ])
  })

  it('内联使用同源 Source/Workflow Schema，保持既有 URI 与默认匹配', () => {
    const runtime = loadDeveloperRuntime({ root: developerRuntimeRoot })
    const schemas = resolveIdeSchemas({ developerRuntimeRoot }).schemas
    const backend = schemas.find(schema => schema.uri === 'fh2://schema/backend-plugin')!
    const workflow = schemas.find(schema => schema.uri === 'fh2://schema/workflow')!
    expect(backend.schema).toBe(runtime.schemas.sourceManifest)
    expect(backend.schema).not.toBe(runtime.schemas.runtimeManifest)
    expect(backend.fileMatch).toEqual(['plugin.json'])
    expect(workflow.schema).toBe(runtime.schemas.workflow)
    expect(workflow.fileMatch).toEqual(['workflows/*.json', 'flows/*.json', '*.flow.json'])
    const validate = new Ajv({ allErrors: true }).compile(backend.schema as object)
    expect(validate({ name: 'valid' })).toBe(true)
    expect(validate({})).toBe(false)
    expect(validate({ name: 'valid', extra: true })).toBe(false)
  })

  it('后端成员同时匹配源码与运行清单，前端同名清单不误绑定', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-schema-backend-manifests-'))
    roots.push(root)
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({ pluginId: 'official_backend', contractsRange: '>=1.1.0' }))
    await writeFile(join(root, 'plugin.json'), JSON.stringify({ pluginId: 'official_backend' }))
    const schemas = resolveIdeSchemas({ root, developerRuntimeRoot }).schemas
    expect(schemas.find(schema => schema.uri === 'fh2://schema/backend-plugin')?.fileMatch).toEqual([
      join(root, 'fh2-plugin.json'),
      join(root, 'plugin.json'),
    ])
    expect(schemas.find(schema => schema.uri === 'fh2://schema/manifest')?.fileMatch).toEqual([])
  })

  it('缺少必需投影时明确失败，不静默少挂后端 Schema', () => {
    expect(() => resolveIdeSchemas({ developerRuntimeRoot: join(developerRuntimeRoot, 'missing') })).toThrow('developer-runtime')
  })

  it('损坏或不可编译的投影 Schema 不降级', async () => {
    await mutateFixtureJson(developerRuntimeRoot, 'schemas/workflow.schema.json', value => value.properties.name.$ref = '#/definitions/missing')
    expect(() => resolveIdeSchemas({ developerRuntimeRoot })).toThrow('Schema')
    await writeFile(join(developerRuntimeRoot, 'schemas/workflow.schema.json'), '{invalid')
    expect(() => resolveIdeSchemas({ developerRuntimeRoot })).toThrow('bytes')
  })
})

async function createCapability (root: string, id: string): Promise<void> {
  const capability = join(root, id)
  await mkdir(capability)
  await writeFile(join(capability, 'capabilities.json'), JSON.stringify({
    name: id,
    description: `Capability ${id}`,
  }))
}

async function createBackend (root: string, capabilityId: string, pluginId: string): Promise<void> {
  const plugin = join(root, capabilityId, 'backend', pluginId)
  await mkdir(plugin, { recursive: true })
  await writeFile(join(plugin, 'fh2-plugin.json'), JSON.stringify({ pluginId }))
}

async function createFrontend (root: string, capabilityId: string, pluginId: string): Promise<void> {
  const plugin = join(root, capabilityId, 'frontend', pluginId)
  await mkdir(plugin, { recursive: true })
  await writeFile(join(plugin, 'fh2-plugin.json'), JSON.stringify({ id: pluginId }))
}
