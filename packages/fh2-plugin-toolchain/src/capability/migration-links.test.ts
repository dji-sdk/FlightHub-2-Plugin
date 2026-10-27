// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildIndustryCapabilityWorkspace } from './build.js'
import type { CapabilityBuildResult, IndustryCapabilityWorkspaceBuildResult } from './build.js'
import { discoverIndustryCapabilityWorkspace } from './discovery.js'
import { validateIndustryMigrationLinks } from './migration-links.js'
import { packIndustryCapabilityWorkspace } from './pack.js'
import { CapabilityError } from './types.js'
import type { IndustryCapabilityWorkspaceProject } from './types.js'

const roots: string[] = []
const capabilityId = 'exp_migration_capability'
const frontendIds = ['exp_migration_frontend_one', 'exp_migration_frontend_two']
const backendId = 'exp_migration_backend'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('industry workspace migration links', () => {
  it('文件缺失时不影响行业工作区 Build', async () => {
    const fixture = await createWorkspaceFixture()
    const buildCapability = vi.fn(async (): Promise<CapabilityBuildResult> => ({ ok: true, diagnostics: [] }))

    const result = await buildIndustryCapabilityWorkspace({
      workspace: fixture.workspace,
      buildCapability,
    })

    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    expect(buildCapability).toHaveBeenCalledTimes(1)
  })

  it('允许同一 Capability 的两个 frontend 复用一个 backend，且不读取前端业务源码', async () => {
    const fixture = await createWorkspaceFixture()
    await writeLinks(fixture.root, migrationLinks(capabilityId, frontendIds, [backendId], ['primary-flow', 'secondary-flow']))

    expect(() => validateIndustryMigrationLinks(fixture.workspace)).not.toThrow()
  })

  it('拒绝不支持的 schemaVersion', async () => {
    const fixture = await createWorkspaceFixture()
    await writeLinks(fixture.root, {
      ...migrationLinks(capabilityId, frontendIds, [backendId], ['primary-flow']),
      schemaVersion: 2,
    })

    const error = expectMigrationError(() => validateIndustryMigrationLinks(fixture.workspace), 'FH2_MIGRATION_LINKS_SCHEMA_INVALID')
    expect(error.message).toContain('schemaVersion')
  })

  it('拒绝工作区外的 Capability key', async () => {
    const fixture = await createWorkspaceFixture()
    await writeLinks(fixture.root, migrationLinks('exp_unknown_capability', frontendIds, [backendId], ['primary-flow']))

    const error = expectMigrationError(() => validateIndustryMigrationLinks(fixture.workspace), 'FH2_MIGRATION_LINKS_CAPABILITY_UNKNOWN')
    expect(error.message).toContain('exp_unknown_capability')
  })

  it('拒绝未发现的 frontend 和 backend 成员', async () => {
    const frontendFixture = await createWorkspaceFixture()
    await writeLinks(frontendFixture.root, migrationLinks(capabilityId, ['exp_unknown_frontend'], [backendId], []))
    expectMigrationError(() => validateIndustryMigrationLinks(frontendFixture.workspace), 'FH2_MIGRATION_LINKS_FRONTEND_NOT_FOUND')

    const backendFixture = await createWorkspaceFixture()
    await writeLinks(backendFixture.root, migrationLinks(capabilityId, frontendIds, ['exp_unknown_backend'], []))
    expectMigrationError(() => validateIndustryMigrationLinks(backendFixture.workspace), 'FH2_MIGRATION_LINKS_BACKEND_NOT_FOUND')
  })

  it('拒绝后端 workflow JSON 中不存在的 flow name', async () => {
    const fixture = await createWorkspaceFixture()
    await writeLinks(fixture.root, migrationLinks(capabilityId, frontendIds, [backendId], ['missing-flow']))

    const error = expectMigrationError(() => validateIndustryMigrationLinks(fixture.workspace), 'FH2_MIGRATION_LINKS_FLOW_NOT_FOUND')
    expect(error.message).toContain('missing-flow')
    expect(error.message).toContain('primary-flow')
  })

  it('在 workspace Build 前阻断错误映射，不启动任何 Capability Build', async () => {
    const fixture = await createWorkspaceFixture()
    await writeLinks(fixture.root, migrationLinks(capabilityId, frontendIds, [backendId], ['missing-flow']))
    const buildCapability = vi.fn(async (): Promise<CapabilityBuildResult> => ({ ok: true, diagnostics: [] }))

    const result = await buildIndustryCapabilityWorkspace({ workspace: fixture.workspace, buildCapability })

    expect(result.ok).toBe(false)
    expect(result.capabilities).toEqual([])
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'FH2_MIGRATION_LINKS_FLOW_NOT_FOUND' }),
    ]))
    expect(buildCapability).not.toHaveBeenCalled()
  })

  it('在 workspace Pack 前阻断错误映射，即使调用方替换了 Build 实现', async () => {
    const fixture = await createWorkspaceFixture()
    await writeLinks(fixture.root, migrationLinks(capabilityId, frontendIds, [backendId], ['missing-flow']))
    const build = vi.fn(async (): Promise<IndustryCapabilityWorkspaceBuildResult> => ({
      ok: true,
      capabilities: [],
      diagnostics: [],
    }))

    await expect(packIndustryCapabilityWorkspace({ workspace: fixture.workspace, build }))
      .rejects.toMatchObject({ code: 'FH2_MIGRATION_LINKS_FLOW_NOT_FOUND' })
    expect(build).not.toHaveBeenCalled()
  })
})

function expectMigrationError (action: () => void, code: string): CapabilityError {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityError)
    expect(error).toMatchObject({ code })
    return error as CapabilityError
  }
  throw new Error(`expected ${code}`)
}

function migrationLinks (
  id: string,
  frontend: readonly string[],
  backend: readonly string[],
  flows: readonly string[],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    packageId: 'exp_migration_package',
    capabilities: { [id]: { frontend, backend, flows } },
  }
}

async function writeLinks (root: string, links: unknown): Promise<void> {
  await writeFile(join(root, 'migration-links.json'), JSON.stringify(links, null, 2))
}

async function createWorkspaceFixture (): Promise<{
  readonly root: string;
  readonly workspace: IndustryCapabilityWorkspaceProject;
}> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-migration-links-'))
  roots.push(root)
  await writeFile(join(root, 'packages.json'), JSON.stringify([{
    packageId: 'exp_migration_package',
    name: 'Migration Links Package',
    capabilityIds: [capabilityId],
  }]))
  const capabilityRoot = join(root, capabilityId)
  await mkdir(capabilityRoot)
  await writeFile(join(capabilityRoot, 'capabilities.json'), JSON.stringify({
    name: 'Migration Links Capability',
    description: 'migration links test',
  }))
  await Promise.all(frontendIds.map(id => writeFrontend(capabilityRoot, id)))
  await writeBackend(capabilityRoot)
  return { root, workspace: discoverIndustryCapabilityWorkspace(root) }
}

async function writeFrontend (capabilityRoot: string, id: string): Promise<void> {
  const root = join(capabilityRoot, 'frontend', id)
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({ id }))
  // 这个历史字符串故意不在 migration-links 中；校验器不应扫描前端业务源码。
  await writeFile(join(root, 'src/legacy.ts'), 'const legacyBackend = \'exp_not_a_backend\'\n')
}

async function writeBackend (capabilityRoot: string): Promise<void> {
  const root = join(capabilityRoot, 'backend', backendId)
  await mkdir(join(root, 'workflows'), { recursive: true })
  await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({ pluginId: backendId }))
  await writeFile(join(root, 'workflows/primary.json'), JSON.stringify({ name: 'primary-flow' }))
  await writeFile(join(root, 'workflows/secondary.json'), JSON.stringify({ name: 'secondary-flow' }))
}
