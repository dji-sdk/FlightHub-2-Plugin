// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverCapability, discoverCommandContext, discoverIndustryCapabilityWorkspace } from './discovery.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('capability discovery', () => {
  it('发现多个前后端插件，忽略隐藏目录', async () => {
    const root = await createCapabilityRoot()
    await writeFrontend(root, 'exp_first_frontend')
    await writeFrontend(root, 'exp_second_frontend')
    await writeBackend(root, 'exp_first_backend')
    await mkdir(join(root, 'frontend/.cache'), { recursive: true })

    const result = discoverCapability(root)

    expect(result.capabilityId).toBe('exp_capability_test')
    expect(result.frontend.map(project => project.id)).toEqual(['exp_first_frontend', 'exp_second_frontend'])
    expect(result.backend.map(project => project.id)).toEqual(['exp_first_backend'])
  })

  it('容器下缺少清单的插件目录响亮报错，不再静默跳过', async () => {
    const root = await createCapabilityRoot()
    await writeFrontend(root, 'exp_first_frontend')
    await mkdir(join(root, 'backend/not-a-plugin'), { recursive: true })

    expect(() => discoverCapability(root)).toThrow(/FH2_CAPABILITY_PLUGIN_MANIFEST_MISSING|缺少 fh2-plugin\.json/)
  })

  it('拒绝目录名与 Manifest ID 不一致和跨侧 ID 冲突', async () => {
    const mismatchRoot = await createCapabilityRoot()
    await writeFrontend(mismatchRoot, 'exp_manifest_id', 'exp_directory_id')
    expect(() => discoverCapability(mismatchRoot)).toThrow(/FH2_CAPABILITY_FRONTEND_ID_MISMATCH|目录名必须与/)

    const conflictRoot = await createCapabilityRoot()
    await writeFrontend(conflictRoot, 'exp_shared')
    await writeBackend(conflictRoot, 'exp_shared')
    expect(() => discoverCapability(conflictRoot)).toThrow(/FH2_CAPABILITY_PLUGIN_ID_CONFLICT|pluginId 重复/)
  })

  it('不向上查找 Capability 根', async () => {
    const root = await createCapabilityRoot()
    await writeFrontend(root, 'exp_frontend')
    const child = join(root, 'nested')
    await mkdir(child)

    expect(() => discoverCommandContext(child)).toThrow(/FH2_CONTEXT_NOT_FOUND|不是 Capability/)
  })

  it('拒绝指向 Capability 根外的 frontend/backend 符号链接容器', async () => {
    const root = await createCapabilityRoot()
    const external = join(root, '..', 'external-frontend')
    await mkdir(external)
    await symlink(external, join(root, 'frontend'), 'dir')

    expect(() => discoverCapability(root)).toThrow(/符号链接|普通目录/)
  })

  it('以根级 packages.json 和直接 Capability 子目录识别行业 Capability 工作区', async () => {
    const root = await createWorkspaceRoot(['exp_workspace_alpha', 'exp_workspace_beta'])

    const result = discoverCommandContext(root)

    expect(result.kind).toBe('industry-capability-workspace')
    if (result.kind !== 'industry-capability-workspace') throw new Error('expected workspace context')
    expect(result.packageManifest.packageId).toBe('exp_workspace_package')
    expect(result.capabilities.map(capability => capability.capabilityId)).toEqual([
      'exp_workspace_alpha',
      'exp_workspace_beta',
    ])
    expect(Object.isFrozen(result.capabilities)).toBe(true)
  })

  it('按清单内容区分前端与后端插件上下文', async () => {
    const frontendRoot = await mkdtemp(join(tmpdir(), 'exp_workspace_frontend-'))
    const backendRoot = await mkdtemp(join(tmpdir(), 'exp_workspace_backend-'))
    roots.push(frontendRoot, backendRoot)
    await writeFile(join(frontendRoot, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_existing_frontend', entry: './plugin.js', extensions: [] }))
    await writeFile(join(frontendRoot, 'packages.json'), '[]')
    await writeFile(join(backendRoot, 'fh2-plugin.json'), JSON.stringify({ pluginId: 'exp_existing_backend', contractsRange: '>=1.1.0 <2.0.0' }))
    await writeFile(join(backendRoot, 'packages.json'), '[]')

    expect(discoverCommandContext(frontendRoot).kind).toBe('frontend-plugin')
    expect(discoverCommandContext(backendRoot).kind).toBe('backend-plugin')
  })

  it('拒绝 packages.json 与直接 Capability 子目录不一致', async () => {
    const root = await createWorkspaceRoot(['exp_workspace_declared'])
    await mkdir(join(root, 'exp_workspace_unknown'))
    await writeFile(join(root, 'exp_workspace_unknown/capabilities.json'), JSON.stringify({
      name: 'Unknown',
      description: 'must be declared',
    }))
    await rm(join(root, 'exp_workspace_declared'), { recursive: true })

    try {
      discoverIndustryCapabilityWorkspace(root)
      throw new Error('expected workspace membership validation to fail')
    } catch (error) {
      expect(error).toMatchObject({ code: 'FH2_INDUSTRY_CAPABILITY_WORKSPACE_MEMBERSHIP_MISMATCH' })
      expect((error as Error).message).toContain('目录不存在：exp_workspace_declared')
      expect((error as Error).message).toContain('exp_workspace_unknown')
    }
  })

  it('复用 packages.json 的单包限制并拒绝 Capability 符号链接目录', async () => {
    const root = await createWorkspaceRoot(['exp_workspace_alpha'])
    await writeFile(join(root, 'packages.json'), JSON.stringify([
      { packageId: 'exp_workspace_package', name: 'Workspace', capabilityIds: ['exp_workspace_alpha'] },
      { packageId: 'exp_workspace_other', name: 'Other', capabilityIds: ['exp_workspace_other'] },
    ]))
    expect(() => discoverIndustryCapabilityWorkspace(root)).toThrow(/只允许一个包条目/)

    await writeFile(join(root, 'packages.json'), JSON.stringify([
      { packageId: 'exp_workspace_package', name: 'Workspace', capabilityIds: ['exp_workspace_alpha'] },
    ]))
    await rm(join(root, 'exp_workspace_alpha'), { recursive: true })
    const external = join(root, '..', 'workspace-alpha-target')
    roots.push(external)
    await mkdir(external)
    await writeFile(join(external, 'capabilities.json'), JSON.stringify({ name: 'Alpha', description: 'target' }))
    await symlink(external, join(root, 'exp_workspace_alpha'), 'dir')

    expect(() => discoverIndustryCapabilityWorkspace(root)).toThrow(/符号链接|普通直接子目录/)
  })
})

async function createCapabilityRoot (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'exp_capability_test-'))
  const capabilityRoot = join(root, 'exp_capability_test')
  roots.push(root)
  await mkdir(capabilityRoot)
  await writeFile(join(capabilityRoot, 'capabilities.json'), JSON.stringify({
    name: '能力测试',
    description: '用于测试发现规则',
  }))
  return capabilityRoot
}

async function writeFrontend (root: string, id: string, directory = id): Promise<void> {
  const projectRoot = join(root, 'frontend', directory)
  await mkdir(projectRoot, { recursive: true })
  await writeFile(join(projectRoot, 'fh2-plugin.json'), JSON.stringify({ id }))
}

async function writeBackend (root: string, id: string, directory = id): Promise<void> {
  const projectRoot = join(root, 'backend', directory)
  await mkdir(projectRoot, { recursive: true })
  await writeFile(join(projectRoot, 'fh2-plugin.json'), JSON.stringify({ pluginId: id }))
}

async function createWorkspaceRoot (capabilityIds: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'exp_capability_workspace-'))
  roots.push(root)
  await writeFile(join(root, 'packages.json'), JSON.stringify([{
    packageId: 'exp_workspace_package',
    name: 'Workspace',
    capabilityIds,
  }]))
  await Promise.all(capabilityIds.map(async (capabilityId) => {
    const capabilityRoot = join(root, capabilityId)
    await mkdir(capabilityRoot)
    await writeFile(join(capabilityRoot, 'capabilities.json'), JSON.stringify({
      name: capabilityId,
      description: `Capability ${capabilityId}`,
    }))
  }))
  return root
}
