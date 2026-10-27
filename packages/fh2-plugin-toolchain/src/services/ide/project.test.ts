// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../../capability/types.js'
import { describeWorkspace, resolveOpenWorkspaceRoot, runIdeBuild, runIdeValidate } from './project.js'
import type { CapabilityBridgeOptions } from './project.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const workspaceContext: CommandContext = {
  kind: 'industry-capability-workspace',
  root: '/ws',
  packageManifestPath: '/ws/packages.json',
  packageManifest: { packageId: 'exp_traffic', name: '行业工作区', capabilityIds: ['exp_demo'] },
  capabilities: [],
}

function bridgeOptions (context: CommandContext | undefined): CapabilityBridgeOptions {
  return {
    root: '/ws',
    toolchainVersion: 'test',
    resolveContext: vi.fn(() => context),
    createRunner: vi.fn(() => {
      throw new Error('不应触达前端构建 Runner')
    }),
  } as CapabilityBridgeOptions
}

describe('行业 Capability 工作区根的 IDE 契约', () => {
  it('describeWorkspace 上报 industry-capability-workspace 类型', () => {
    expect(describeWorkspace(bridgeOptions(workspaceContext))).toMatchObject({
      kind: 'industry-capability-workspace',
      diagnostics: [],
    })
  })

  it('成员配置损坏时仍描述并允许打开行业工作区', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-bridge-damaged-workspace-'))
    roots.push(root)
    await writeFile(join(root, 'packages.json'), JSON.stringify([{
      packageId: 'exp_workspace_package',
      name: 'Workspace',
      capabilityIds: ['exp_alpha'],
    }]))
    await mkdir(join(root, 'exp_alpha'))
    await writeFile(join(root, 'exp_alpha', 'capabilities.json'), JSON.stringify({
      name: '损坏能力',
      description2: '未知字段',
    }))

    const workspace = describeWorkspace({ root, toolchainVersion: 'test' })

    expect(workspace.kind).toBe('industry-capability-workspace')
    expect(workspace.diagnostics[0]).toMatchObject({ file: 'exp_alpha/capabilities.json' })
    expect(resolveOpenWorkspaceRoot({}, root)).toBe(root)
  })

  it('runIdeValidate 委托 Application Service（S2），诊断折算回工作根前缀', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-bridge-validate-'))
    roots.push(root)
    const validateProject = vi.fn(() => ({
      root,
      kind: 'industry-capability-workspace' as const,
      ok: false,
      diagnostics: [
        { code: 'FH2_TEST_MEMBER_BROKEN', phase: 'contract' as const, file: 'fh2-plugin.json', message: '成员失败', severity: 'error' as const },
      ],
      members: [{ label: 'exp_alpha', ok: false, diagnostics: [] }],
    }))
    const options: CapabilityBridgeOptions = { root, toolchainVersion: 'test', validateProject }
    const result = await runIdeValidate(options, 'exp_alpha')

    expect(validateProject).toHaveBeenCalledWith(join(root, 'exp_alpha'))
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]).toMatchObject({
      code: 'FH2_TEST_MEMBER_BROKEN',
      file: 'exp_alpha/fh2-plugin.json',
    })
  })

  it('runIdeBuild 对工作区根返回明确诊断而不触达前端构建', async () => {
    const options = bridgeOptions(workspaceContext)
    const result = await runIdeBuild(options)
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]?.code).toBe('FH2_IDE_WORKSPACE_ROOT_UNSUPPORTED')
    expect(result.outputs).toEqual([])
    expect(options.createRunner).not.toHaveBeenCalled()
  })

  it('runIdeValidate 对无法识别的目录仍返回 CONTEXT_NOT_FOUND', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-bridge-unknown-'))
    roots.push(root)
    const result = await runIdeValidate({ root, toolchainVersion: 'test' }, undefined)
    expect(result.diagnostics[0]?.code).toBe('FH2_IDE_CONTEXT_NOT_FOUND')
    expect(result.ok).toBe(false)
  })
})
