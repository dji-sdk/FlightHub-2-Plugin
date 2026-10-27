// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverCommandContext, tryDiscoverCommandContext } from '../capability/discovery.js'
import {
  CONTEXT_DISCOVERY_CONTRACT,
  type ContextMarkerStep,
  contextDescriptor,
  contextMarkerFiles,
  detectManifestSide,
  serializeContextDiscoveryContract,
  supportedCommandsForContext,
} from './context.js'
import { CLI_CONTRACT } from './cli.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('context discovery contract', () => {
  it('契约覆盖五个上下文且 ID 唯一', () => {
    expect(CONTEXT_DISCOVERY_CONTRACT.contexts.map(context => context.id)).toEqual([
      'backend-plugin',
      'capability-project',
      'frontend-plugin',
      'industry-capability-workspace',
      'legacy-industry-plugins-root',
    ])
    for (const id of CONTEXT_DISCOVERY_CONTRACT.contexts.map(context => context.id)) {
      expect(contextDescriptor(CONTEXT_DISCOVERY_CONTRACT, id).id).toBe(id)
    }
  })

  it('projects support from execution command metadata, including workspace validate/generate', () => {
    for (const context of CONTEXT_DISCOVERY_CONTRACT.contexts) {
      expect(context.supportedCommands).toEqual(CLI_CONTRACT.commands
        .filter(command => command.contexts.includes(context.id)).map(command => command.name).sort())
    }
    const workspace = contextDescriptor(CONTEXT_DISCOVERY_CONTRACT, 'industry-capability-workspace')
    expect(workspace.supportedCommands).toContain('validate')
    expect(workspace.supportedCommands).toContain('generate')
    const changed = CLI_CONTRACT.commands.map(command => command.name === 'generate'
      ? { ...command, contexts: command.contexts.filter(context => context !== 'industry-capability-workspace') }
      : command)
    expect(supportedCommandsForContext('industry-capability-workspace', changed)).not.toContain('generate')
  })

  it('precedence 与 discovery.ts 实际判定顺序一致（fixture 行为验证）', async () => {
    // 三个标记文件并存 → capability-project（precedence 首个命中标记的 contextIds 覆盖实际结果）。
    const allMarkers = await createCapabilityRoot()
    await writePluginManifest(allMarkers, { contractsRange: '>=1.0.0 <2.0.0' })
    await writeFile(join(allMarkers, 'packages.json'), '[]')
    expect(firstMatchingStep(allMarkers).markerFile).toBe('capabilities.json')
    expect(firstMatchingStep(allMarkers).contextIds).toContain(discoverCommandContext(allMarkers).kind)

    // fh2-plugin.json 与 packages.json 并存 → 插件（fh2-plugin.json 优先于 packages.json）。
    const pluginWithPackage = await createTemporaryRoot()
    await writePluginManifest(pluginWithPackage, { pluginId: 'exp_backend', contractsRange: '>=1.0.0 <2.0.0' })
    await writeFile(join(pluginWithPackage, 'packages.json'), '[]')
    expect(firstMatchingStep(pluginWithPackage).markerFile).toBe('fh2-plugin.json')
    expect(firstMatchingStep(pluginWithPackage).contextIds).toContain(discoverCommandContext(pluginWithPackage).kind)

    // 仅 packages.json → 行业 Capability 工作区。
    const workspace = await createWorkspaceRoot()
    expect(firstMatchingStep(workspace).markerFile).toBe('packages.json')
    expect(firstMatchingStep(workspace).contextIds).toContain(discoverCommandContext(workspace).kind)

    // 无任何标记 → tryDiscover 返回 undefined，discover 抛 FH2_CONTEXT_NOT_FOUND。
    const empty = await createTemporaryRoot()
    expect(contextMarkerFiles(CONTEXT_DISCOVERY_CONTRACT).some(file => existsSync(join(empty, file)))).toBe(false)
    expect(tryDiscoverCommandContext(empty)).toBeUndefined()
    expect(() => discoverCommandContext(empty)).toThrow(/FH2_CONTEXT_NOT_FOUND|不是 Capability/)
  })

  it('manifestSideDetection 与 side 判别行为一致', async () => {
    const frontend = await createTemporaryRoot()
    await writePluginManifest(frontend, { id: 'exp_frontend', entry: './plugin.js', extensions: [] })
    expect(detectManifestSide({ entry: './plugin.js' })).toBe('frontend')
    expect(discoverCommandContext(frontend).kind).toBe('frontend-plugin')

    const backend = await createTemporaryRoot()
    await writePluginManifest(backend, { pluginId: 'exp_backend', contractsRange: '>=1.0.0 <2.0.0' })
    expect(detectManifestSide({ contractsRange: '>=1.0.0 <2.0.0' })).toBe('backend')
    expect(discoverCommandContext(backend).kind).toBe('backend-plugin')

    // 前后端标志并存 → fallbackSide（前端）；两者皆缺 → 同样按前端处理。
    expect(detectManifestSide({ entry: './plugin.js', contractsRange: '>=1.0.0 <2.0.0' }))
      .toBe(CONTEXT_DISCOVERY_CONTRACT.manifestSideDetection.fallbackSide)
    expect(detectManifestSide({ id: 'exp_frontend', name: '无标志字段' })).toBe('frontend')

    const both = await createTemporaryRoot()
    await writePluginManifest(both, { id: 'exp_frontend', entry: './plugin.js', contractsRange: '>=1.0.0 <2.0.0' })
    expect(discoverCommandContext(both).kind).toBe('frontend-plugin')
  })

  it('序列化双跑字节一致且契约对象冻结', () => {
    expect(serializeContextDiscoveryContract()).toBe(serializeContextDiscoveryContract())
    expect(Object.isFrozen(CONTEXT_DISCOVERY_CONTRACT)).toBe(true)
    expect(Object.isFrozen(CONTEXT_DISCOVERY_CONTRACT.contexts)).toBe(true)
    expect(Object.isFrozen(CONTEXT_DISCOVERY_CONTRACT.membershipRules)).toBe(true)
  })
})

/** 首个标记文件命中的 precedence 步（与 discovery.ts 的判定顺序同构）。 */
function firstMatchingStep (root: string): ContextMarkerStep {
  const step = CONTEXT_DISCOVERY_CONTRACT.precedence.find(item => existsSync(join(root, item.markerFile)))
  if (step === undefined) throw new Error(`fixture 缺少标记文件：${root}`)
  return step
}

async function createTemporaryRoot (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'exp_context_contract-'))
  roots.push(root)
  return root
}

/** 最小可发现的 Capability：capabilities.json + 一个前端插件成员。 */
async function createCapabilityRoot (): Promise<string> {
  const root = await createTemporaryRoot()
  await writeFile(join(root, 'capabilities.json'), JSON.stringify({
    name: '契约测试',
    description: 'precedence fixture',
  }))
  await mkdir(join(root, 'frontend/exp_contract_frontend'), { recursive: true })
  await writeFile(join(root, 'frontend/exp_contract_frontend/fh2-plugin.json'), JSON.stringify({
    id: 'exp_contract_frontend',
  }))
  return root
}

/** 最小可发现的行业 Capability 工作区：packages.json + 一个 Capability 成员（允许无插件）。 */
async function createWorkspaceRoot (): Promise<string> {
  const root = await createTemporaryRoot()
  await writeFile(join(root, 'packages.json'), JSON.stringify([{
    packageId: 'exp_contract_package',
    name: 'Workspace',
    capabilityIds: ['exp_contract_alpha'],
  }]))
  await mkdir(join(root, 'exp_contract_alpha'), { recursive: true })
  await writeFile(join(root, 'exp_contract_alpha/capabilities.json'), JSON.stringify({
    name: 'Alpha',
    description: 'workspace member',
  }))
  return root
}

async function writePluginManifest (root: string, manifest: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify(manifest))
}
