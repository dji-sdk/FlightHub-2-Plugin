// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ValidationResult } from '../../validate/index.js'
import { validateProject } from './validate.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('validateProject（S2）', () => {
  it('未知目录返回结构化失败诊断', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-validate-plain-'))
    roots.push(root)

    const result = validateProject(root)

    expect(result.kind).toBe('unknown')
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]).toMatchObject({ code: 'FH2_PROJECT_NOT_RECOGNIZED', severity: 'error' })
  })

  it('行业工作区 fan-out：单成员失败仍收集全部成员诊断', async () => {
    const workspace = await createWorkspaceRoot(['exp_alpha', 'exp_beta'])
    await writeFrontend(join(workspace, 'exp_alpha'), 'exp_alpha_frontend')
    await writeFrontend(join(workspace, 'exp_beta'), 'exp_beta_frontend')

    const result = validateProject(workspace, {
      validateFrontend: ((options: { manifestPath: string }) => {
        // alpha 成员业务失败，beta 成员通过；fan-out 不得因 alpha 失败而跳过 beta。
        if (options.manifestPath.includes('exp_alpha')) {
          return failingResult('FH2_TEST_ALPHA_BROKEN', 'alpha 前端清单损坏')
        }
        return passingResult(options.manifestPath)
      }) as unknown as typeof import('../../validate/index.js').validateSourceManifest,
    })

    expect(result.kind).toBe('industry-capability-workspace')
    expect(result.ok).toBe(false)
    expect(result.members.map(member => member.label)).toEqual(['exp_alpha', 'exp_beta'])
    expect(result.members[0]!.ok).toBe(false)
    expect(result.members[1]!.ok).toBe(true)
    const codes = result.diagnostics.map(diagnostic => diagnostic.code)
    expect(codes).toContain('FH2_TEST_ALPHA_BROKEN')
    expect(result.diagnostics.every(diagnostic => diagnostic.file !== '.')).toBe(true)
    expect(result.diagnostics.map(diagnostic => diagnostic.file))
      .toContain('exp_alpha/frontend/exp_alpha_frontend/fh2-plugin.json')
  })

  it('行业工作区后端 Workflow 诊断带成员前缀，路径指向真实文件', async () => {
    const workspace = await createWorkspaceRoot(['exp_alpha'])
    await writeBackendWithUnwiredInput(workspace, 'exp_alpha', 'exp_alpha_backend')

    const result = validateProject(workspace)

    expect(result.ok).toBe(false)
    const semantic = result.diagnostics.find(diagnostic => diagnostic.code === 'FH2_BACKEND_WORKFLOW_INVALID')
    expect(semantic?.file).toBe('exp_alpha/backend/exp_alpha_backend/workflows/cascade-ingest.json')
    expect(semantic?.message).toContain('R1_REQUIRED_INPUT_UNWIRED')
  })

  it('capability 根透传原始结果供 CLI 复用，诊断携带成员前缀', async () => {
    const root = await createCapabilityRoot()
    await writeFrontend(root, 'exp_front_a')

    const result = validateProject(root, {
      validateFrontend: (() => failingResult('FH2_TEST_MEMBER_BROKEN', '成员失败')) as unknown as typeof import('../../validate/index.js').validateSourceManifest,
    })

    expect(result.kind).toBe('capability-project')
    expect(result.capability).toBeDefined()
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]!.message).toContain('[frontend exp_front_a]')
    expect(result.diagnostics[0]!.file).toBe('frontend/exp_front_a/fh2-plugin.json')
  })
})

function passingResult (manifestPath: string): ValidationResult {
  // manifest.id 与插件目录名一致，避免触发 ID MISMATCH 诊断。
  const id = basename(dirname(manifestPath))
  return { ok: true, manifest: { id }, warnings: [] } as unknown as ValidationResult
}

function failingResult (code: string, message: string): ValidationResult {
  return {
    ok: false,
    diagnostics: [{ code, phase: 'schema', file: 'fh2-plugin.json', message }],
  } as unknown as ValidationResult
}

async function createCapabilityRoot (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-validate-capability-'))
  roots.push(root)
  await writeFile(join(root, 'capabilities.json'), JSON.stringify({ name: '能力测试', description: '用于测试' }))
  return root
}

async function writeFrontend (root: string, id: string): Promise<void> {
  const projectRoot = join(root, 'frontend', id)
  await mkdir(projectRoot, { recursive: true })
  await writeFile(join(projectRoot, 'fh2-plugin.json'), JSON.stringify({ id }))
}

async function writeBackendWithUnwiredInput (
  workspace: string,
  capabilityId: string,
  pluginId: string,
): Promise<void> {
  const pluginRoot = join(workspace, capabilityId, 'backend', pluginId)
  await mkdir(join(pluginRoot, 'workflows'), { recursive: true })
  await mkdir(join(pluginRoot, 'adapters'), { recursive: true })
  await writeFile(join(pluginRoot, 'fh2-plugin.json'), JSON.stringify({
    pluginId,
    name: pluginId,
    version: '0.1.0',
    flows: ['workflows/cascade-ingest.json'],
    scripts: [{
      name: 'cascade-ingest',
      path: 'adapters/cascade-ingest.js',
      entry: 'handle',
      io: {
        inputs: [{ name: 'now', type: 'string', required: true }],
      },
    }],
  }))
  await writeFile(join(pluginRoot, 'adapters/cascade-ingest.js'), 'function handle() { return {} }\n')
  // 必填入参 now 故意不接线：复现「工程校验」里 R1_REQUIRED_INPUT_UNWIRED 的跳转路径。
  await writeFile(join(pluginRoot, 'workflows/cascade-ingest.json'), JSON.stringify({
    name: 'cascade-ingest',
    trigger: { schedule: { intervalSec: 30, paused: true } },
    steps: [{
      id: 'ingest',
      action: 'run_script',
      inputs: { script: { const: 'cascade-ingest' } },
    }],
  }))
}

async function createWorkspaceRoot (capabilityIds: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-validate-workspace-'))
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
