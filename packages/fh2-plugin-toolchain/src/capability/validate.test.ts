// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverCapability } from './discovery.js'
import { validateCapability } from './validate.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('capability validation', () => {
  it('拒绝两个后端插件在 Worker 全局命名空间中的冲突', async () => {
    const root = await createCapabilityRoot()
    await writeBackend(root, 'exp_alpha_backend')
    await writeBackend(root, 'exp_beta_backend')

    const result = validateCapability(discoverCapability(root))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      const conflicts = result.diagnostics.filter(item => item.code === 'FH2_CAPABILITY_BACKEND_NAMESPACE_CONFLICT')
      expect(conflicts).toHaveLength(4)
      expect(conflicts.map(item => item.message).join('\n')).toContain('shared-flow')
      expect(conflicts.map(item => item.message).join('\n')).toContain('shared-script')
      expect(conflicts.map(item => item.message).join('\n')).toContain('shared-connection')
      expect(conflicts.map(item => item.message).join('\n')).toContain('shared_entity')
    }
  })
})

async function createCapabilityRoot (): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'fh2-capability-validate-'))
  const root = join(parent, 'exp_multi_backend')
  roots.push(parent)
  await mkdir(root)
  await writeFile(join(root, 'capabilities.json'), JSON.stringify({
    name: '多后端测试',
    description: '验证 Worker 全局命名空间',
  }))
  return root
}

async function writeBackend (capabilityRoot: string, pluginId: string): Promise<void> {
  const root = join(capabilityRoot, 'backend', pluginId)
  await mkdir(join(root, 'workflows'), { recursive: true })
  await mkdir(join(root, 'adapters'), { recursive: true })
  await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({
    pluginId,
    name: pluginId,
    version: '0.1.0',
    flows: ['workflows/shared.json'],
    connections: [{ id: 'shared-connection' }],
    scripts: [{ name: 'shared-script', path: 'adapters/shared.js', entry: 'handle' }],
    entities: [{
      name: 'shared_entity',
      fields: { value: { type: 'string' } },
    }],
  }))
  await writeFile(join(root, 'workflows/shared.json'), JSON.stringify({
    name: 'shared-flow',
    trigger: { api: {} },
    steps: [{
      id: 'run-shared-script',
      action: 'run_script',
      inputs: { script: { const: 'shared-script' } },
    }],
  }))
  await writeFile(join(root, 'adapters/shared.js'), 'function handle() { return {} }\n')
}
