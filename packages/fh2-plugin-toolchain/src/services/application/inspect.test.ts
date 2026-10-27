// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectProject } from './inspect.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('inspectProject（S1a）', () => {
  it('普通目录返回 unknown，不报错', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-inspect-plain-'))
    roots.push(root)

    const result = inspectProject(root)

    expect(result.kind).toBe('unknown')
    expect(result.members).toEqual([])
    expect(result.capabilities).toEqual([])
    expect(result.diagnostics).toEqual([])
  })

  it('capability 根返回直接成员', async () => {
    const root = await createCapabilityRoot()
    await writeFrontend(root, 'exp_front_a')
    await writeBackend(root, 'exp_back_a')

    const result = inspectProject(root)

    expect(result.kind).toBe('capability-project')
    expect(result.name).toBe(basename(root))
    expect(result.members.map(member => member.id)).toEqual(['exp_front_a', 'exp_back_a'])
    expect(result.members[0]).toMatchObject({ side: 'frontend', relativePath: 'frontend/exp_front_a' })
  })

  it('行业工作区成员与单独打开成员 Capability 结果一致', async () => {
    const workspace = await createWorkspaceRoot(['exp_alpha', 'exp_beta'])
    await writeFrontend(join(workspace, 'exp_alpha'), 'exp_alpha_frontend')
    await writeBackend(join(workspace, 'exp_beta'), 'exp_beta_backend')

    const workspaceResult = inspectProject(workspace)
    expect(workspaceResult.kind).toBe('industry-capability-workspace')
    expect(workspaceResult.capabilities.map(capability => capability.id)).toEqual(['exp_alpha', 'exp_beta'])

    const alpha = workspaceResult.capabilities[0]!
    const direct = inspectProject(join(workspace, 'exp_alpha'))
    expect(direct.kind).toBe('capability-project')
    // 成员清单同源一致；相对路径按各自检查根计算，工作区视图带 Capability 前缀。
    expect(alpha.members.map(member => member.id)).toEqual(direct.members.map(member => member.id))
    expect(alpha.members.map(member => member.side)).toEqual(direct.members.map(member => member.side))
    expect(alpha.members[0]!.relativePath).toBe('exp_alpha/frontend/exp_alpha_frontend')
  })

  it('capabilities.json 损坏时保留 Capability 身份并携带可定位诊断', async () => {
    const root = await createCapabilityRoot()
    await writeFile(join(root, 'capabilities.json'), '{ not json')

    const result = inspectProject(root)

    expect(result.kind).toBe('capability-project')
    expect(result.diagnostics.length).toBe(1)
    expect(result.diagnostics[0]).toMatchObject({
      severity: 'error',
      file: 'capabilities.json',
    })
  })

  it('行业工作区成员元数据损坏时仍保留工作区身份', async () => {
    const root = await createWorkspaceRoot(['exp_alpha', 'exp_beta'])
    await writeFile(join(root, 'exp_beta', 'capabilities.json'), JSON.stringify({
      name: '损坏能力',
      description2: '未知字段',
    }))

    const result = inspectProject(root)

    expect(result.kind).toBe('industry-capability-workspace')
    expect(result.capabilities).toEqual([])
    expect(result.diagnostics[0]).toMatchObject({
      code: 'FH2_CAPABILITY_METADATA_INVALID',
      file: 'exp_beta/capabilities.json',
      severity: 'error',
    })
  })

  it('插件根返回清单相对路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-inspect-plugin-'))
    roots.push(root)
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_plugin', entry: './plugin.js', extensions: [] }))

    const result = inspectProject(root)

    expect(result.kind).toBe('frontend-plugin')
    expect(result.manifestPath).toBe('fh2-plugin.json')
  })
})

async function createCapabilityRoot (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-inspect-capability-'))
  roots.push(root)
  await writeFile(join(root, 'capabilities.json'), JSON.stringify({ name: '能力测试', description: '用于测试' }))
  return root
}

async function writeFrontend (root: string, id: string): Promise<void> {
  const projectRoot = join(root, 'frontend', id)
  await mkdir(projectRoot, { recursive: true })
  await writeFile(join(projectRoot, 'fh2-plugin.json'), JSON.stringify({ id }))
}

async function writeBackend (root: string, id: string): Promise<void> {
  const projectRoot = join(root, 'backend', id)
  await mkdir(projectRoot, { recursive: true })
  await writeFile(join(projectRoot, 'fh2-plugin.json'), JSON.stringify({ pluginId: id }))
}

async function createWorkspaceRoot (capabilityIds: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-inspect-workspace-'))
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
