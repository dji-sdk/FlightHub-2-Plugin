// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { serializePackageManifest } from '../package/manifest.js'
import { digestBuildDirectory, digestFile, digestSourceDirectory, writeBuildReport } from './build-report.js'
import { discoverIndustryCapabilityWorkspace } from './discovery.js'
import { packCapability, packIndustryCapabilityWorkspace } from './pack.js'
import type { CapabilityProject, IndustryCapabilityWorkspaceProject } from './types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('capability pack', () => {
  it('聚合前后端 dist，排除开发元数据并生成稳定 zip', async () => {
    const fixture = await createFixture()
    writeFreshReport(fixture)

    const first = await packCapability({ capability: fixture.capability, noBuild: true })
    const firstZip = readFileSync(first.zipPath)
    const second = await packCapability({ capability: fixture.capability, noBuild: true })
    const secondZip = readFileSync(second.zipPath)

    expect(firstZip.equals(secondZip)).toBe(true)
    const zipNames = firstZip.toString('latin1')
    expect(zipNames).toContain('packages.json')
    expect(zipNames).toContain('exp_pack_capability/capabilities.json')
    expect(zipNames).toContain('exp_pack_capability/frontend/exp_pack_frontend/plugin.json')
    expect(zipNames).toContain('exp_pack_capability/backend/exp_pack_backend/schema.sql')
    expect(first.zipPath).toBe(join(realpathSync(fixture.root), 'release', 'exp_pack_package.zip'))
    expect(first.packageDir).toBe(join(realpathSync(fixture.root), 'release', 'exp_pack_package'))
    expect(first.capabilityDir).toBe(join(realpathSync(fixture.root), 'release', 'exp_pack_package', 'exp_pack_capability'))
    expect(JSON.parse(await readFile(join(first.packageDir, 'packages.json'), 'utf8'))).toEqual([{
      packageId: 'exp_pack_package',
      name: 'Pack Package',
      capabilityIds: ['exp_pack_capability'],
    }])
    expect(await readFile(join(first.capabilityDir, 'capabilities.json'), 'utf8')).toContain('Pack Capability')
    const frontendPackage = JSON.parse(await readFile(join(first.capabilityDir, 'frontend/exp_pack_frontend/plugin.json'), 'utf8'))
    expect(frontendPackage).not.toHaveProperty('side')
    expect(frontendPackage.manifest.entry).toBe('./dist/plugin.js')
    expect(existsSync(join(first.capabilityDir, 'backend/exp_pack_backend/plugin.json'))).toBe(true)
    expect(existsSync(join(first.capabilityDir, 'backend/exp_pack_backend/workflows/example.json'))).toBe(true)
    expect(existsSync(join(first.capabilityDir, 'backend/exp_pack_backend/handlers/items/create.js'))).toBe(true)
    expect(existsSync(join(first.capabilityDir, 'backend/exp_pack_backend/handlers/items/create.js.map'))).toBe(false)
    expect(zipNames).not.toContain('handlers/items/create.js.map')
    expect(existsSync(join(first.capabilityDir, 'backend/exp_pack_backend/build-info.json'))).toBe(false)
    expect(existsSync(join(first.capabilityDir, 'backend/exp_pack_backend/schema.sql'))).toBe(true)
    expect(await readFile(join(first.capabilityDir, 'backend/exp_pack_backend/schema.sql'), 'utf8'))
      .toBe(await readFile(join(fixture.backendRoot, 'dist/schema.sql'), 'utf8'))
    expect(existsSync(join(first.capabilityDir, 'packages.json'))).toBe(false)
    expect(existsSync(join(first.capabilityDir, 'SIGNATURE'))).toBe(false)
    expect(existsSync(join(first.packageDir, 'SIGNATURE'))).toBe(false)
    expect(await readFile(join(first.capabilityDir, 'backend/exp_pack_backend/workflows/example.json'), 'utf8'))
      .toBe(await readFile(join(fixture.backendRoot, 'dist/workflows/example.json'), 'utf8'))
  })

  it('packages.json 缺失或 capabilityIds 不匹配时拒绝 Pack', async () => {
    const fixture = await createFixture()
    writeFreshReport(fixture)
    await rm(join(fixture.root, 'packages.json'))

    await expect(packCapability({ capability: fixture.capability, noBuild: true }))
      .rejects.toMatchObject({ diagnostic: { code: 'FH2_PACKAGE_MANIFEST_NOT_FOUND' } })

    const mismatch = await createFixture()
    writeFreshReport(mismatch)
    await writeFile(join(mismatch.root, 'packages.json'), JSON.stringify([{
      packageId: 'exp_pack_package',
      name: 'Pack Package',
      capabilityIds: ['exp_other_capability'],
    }]))
    await expect(packCapability({ capability: mismatch.capability, noBuild: true }))
      .rejects.toMatchObject({ diagnostic: { code: 'FH2_PACKAGE_CAPABILITY_MISMATCH' } })
  })

  it('无本地 packages.json 时从父工作区清单派生单能力上传包', async () => {
    const fixture = await createFixture()
    await rm(join(fixture.root, 'packages.json'))
    const workspaceRoot = dirname(fixture.root)
    await writeFile(join(workspaceRoot, 'packages.json'), JSON.stringify([{
      packageId: 'exp_pack_package',
      name: 'Workspace Package',
      capabilityIds: ['exp_pack_capability', 'exp_workspace_other'],
    }]))
    writeFreshReportWithDigest(fixture, derivedWorkspaceDigest('exp_pack_package', 'Workspace Package', 'exp_pack_capability'))

    const packed = await packCapability({ capability: fixture.capability, noBuild: true })

    expect(JSON.parse(await readFile(join(packed.packageDir, 'packages.json'), 'utf8'))).toEqual([{
      packageId: 'exp_pack_package',
      name: 'Workspace Package',
      capabilityIds: ['exp_pack_capability'],
    }])
    expect(existsSync(join(packed.capabilityDir, 'packages.json'))).toBe(false)
  })

  it('父工作区清单未声明本能力时拒绝 Pack', async () => {
    const fixture = await createFixture()
    await rm(join(fixture.root, 'packages.json'))
    const workspaceRoot = dirname(fixture.root)
    await writeFile(join(workspaceRoot, 'packages.json'), JSON.stringify([{
      packageId: 'exp_pack_package',
      name: 'Workspace Package',
      capabilityIds: ['exp_workspace_other'],
    }]))

    await expect(packCapability({ capability: fixture.capability, noBuild: true }))
      .rejects.toMatchObject({ diagnostic: { code: 'FH2_PACKAGE_CAPABILITY_MISMATCH' } })
  })

  it('父工作区清单的包身份变化时拒绝 --no-build', async () => {
    const fixture = await createFixture()
    await rm(join(fixture.root, 'packages.json'))
    const workspaceRoot = dirname(fixture.root)
    await writeFile(join(workspaceRoot, 'packages.json'), JSON.stringify([{
      packageId: 'exp_pack_package',
      name: 'Workspace Package',
      capabilityIds: ['exp_pack_capability', 'exp_workspace_other'],
    }]))
    writeFreshReportWithDigest(fixture, derivedWorkspaceDigest('exp_pack_package', 'Workspace Package', 'exp_pack_capability'))
    await writeFile(join(workspaceRoot, 'packages.json'), JSON.stringify([{
      packageId: 'exp_pack_package',
      name: 'Renamed Package',
      capabilityIds: ['exp_pack_capability', 'exp_workspace_other'],
    }]))

    await expect(packCapability({ capability: fixture.capability, noBuild: true }))
      .rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_BUILD_STALE' } })
  })

  it('packages.json 变化时拒绝 --no-build', async () => {
    const fixture = await createFixture()
    writeFreshReport(fixture)
    await writeFile(join(fixture.root, 'packages.json'), JSON.stringify([{
      packageId: 'exp_pack_package',
      name: 'Changed Package',
      capabilityIds: ['exp_pack_capability'],
    }]))

    await expect(packCapability({ capability: fixture.capability, noBuild: true }))
      .rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_BUILD_STALE' } })
  })

  it('build report 与产物或源码不一致时拒绝 --no-build', async () => {
    const fixture = await createFixture()
    const source = join(fixture.frontendRoot, 'src-changed.ts')
    await writeFile(source, 'before build')
    writeFreshReport(fixture)
    await unlink(source)

    await expect(packCapability({ capability: fixture.capability, noBuild: true }))
      .rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_BUILD_STALE' } })
  })

  it('capabilities.json 变化时拒绝 --no-build', async () => {
    const fixture = await createFixture()
    writeFreshReport(fixture)
    await writeFile(fixture.capability.metadataPath, JSON.stringify({ name: 'Changed', description: 'pack test' }))

    await expect(packCapability({ capability: fixture.capability, noBuild: true }))
      .rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_BUILD_STALE' } })
  })

  it('构建使用自定义 Rsbuild 配置时拒绝 --no-build', async () => {
    const fixture = await createFixture()
    const configPath = join(fixture.root, 'custom.rsbuild.ts')
    await writeFile(configPath, 'export default {}\n')
    writeFreshReport(fixture, configPath)

    await expect(packCapability({ capability: fixture.capability, noBuild: true }))
      .rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_BUILD_STALE' } })
  })

  it('构建使用 Capability 外源码依赖时拒绝 --no-build', async () => {
    const fixture = await createFixture()
    writeFreshReport(fixture, undefined, false, true)

    await expect(packCapability({ capability: fixture.capability, noBuild: true }))
      .rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_BUILD_STALE' } })
  })

  it('隐藏 dist 文件或已删除插件的 Report 条目变化时拒绝 --no-build', async () => {
    const hiddenFixture = await createFixture()
    writeFreshReport(hiddenFixture)
    await writeFile(join(hiddenFixture.frontendRoot, 'dist/.env'), 'must-not-bypass-freshness')

    await expect(packCapability({ capability: hiddenFixture.capability, noBuild: true }))
      .rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_BUILD_STALE' } })

    const removedFixture = await createFixture()
    writeFreshReport(removedFixture, undefined, true)
    await expect(packCapability({ capability: removedFixture.capability, noBuild: true }))
      .rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_BUILD_STALE' } })
  })

  it('前端源码顶层 release 目录变化时拒绝 --no-build', async () => {
    const fixture = await createFixture()
    const sourcePath = join(fixture.frontendRoot, 'release/value.ts')
    await mkdir(join(fixture.frontendRoot, 'release'), { recursive: true })
    await writeFile(sourcePath, 'export const value = 1\n')
    writeFreshReport(fixture)
    await writeFile(sourcePath, 'export const value = 2\n')

    await expect(packCapability({ capability: fixture.capability, noBuild: true }))
      .rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_BUILD_STALE' } })
  })

  it('拒绝位于源码目录或经符号链接越界的输出目录', async () => {
    const fixture = await createFixture()
    await expect(packCapability({
      capability: fixture.capability,
      outputRoot: fixture.frontendRoot,
      noBuild: true,
    })).rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_PACK_OUTPUT_UNSAFE' } })

    await symlink(fixture.frontendRoot, join(fixture.root, 'release'), 'dir')
    await expect(packCapability({ capability: fixture.capability, noBuild: true }))
      .rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_PACK_OUTPUT_UNSAFE' } })
  })

  it('拒绝 Platform 所有的签名和包索引文件', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.frontendRoot, 'dist/SIGNATURE'), 'platform-owned')
    writeFreshReport(fixture)

    await expect(packCapability({ capability: fixture.capability, noBuild: true }))
      .rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_PACK_PLATFORM_FILE_FORBIDDEN' } })
  })

  it('拒绝 dist 中的本地开发缓存目录', async () => {
    const fixture = await createFixture()
    await mkdir(join(fixture.frontendRoot, 'dist/.fh2'), { recursive: true })
    await writeFile(join(fixture.frontendRoot, 'dist/.fh2/cache.json'), '{}')
    writeFreshReport(fixture)

    await expect(packCapability({ capability: fixture.capability, noBuild: true }))
      .rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_PACK_DEVELOPMENT_FILE_FORBIDDEN' } })
  })

  it('拒绝 dist 中的符号链接资产', async () => {
    const fixture = await createFixture()
    await symlink(join(fixture.frontendRoot, 'dist/plugin.js'), join(fixture.frontendRoot, 'dist/linked.js'))
    writeFreshReport(fixture)

    await expect(packCapability({ capability: fixture.capability, noBuild: true }))
      .rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_PACK_PATH_UNSAFE' } })
  })

  it('拒绝符号链接形式的 dist 根目录', async () => {
    const fixture = await createFixture()
    const distRoot = join(fixture.frontendRoot, 'dist')
    const target = join(fixture.root, 'frontend-dist-target')
    await rename(distRoot, target)
    await symlink(target, distRoot, 'dir')

    await expect(packCapability({
      capability: fixture.capability,
      build: async () => ({ ok: true, diagnostics: [] }),
    })).rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_PACK_PATH_UNSAFE' } })
  })

  it('工作区 Pack 先构建全部 Capability，再生成一个确定性的 GT 风格 zip', async () => {
    const fixture = await createWorkspaceFixture()
    let buildCalls = 0
    const build = async (
      options: import('./build.js').IndustryCapabilityWorkspaceBuildOptions,
    ): Promise<import('./build.js').IndustryCapabilityWorkspaceBuildResult> => {
      buildCalls += 1
      for (const capability of options.workspace.capabilities)
        options.onCapabilityEvent?.({ capability, type: 'success', diagnostics: [] })
      return {
        ok: true,
        capabilities: options.workspace.capabilities.map(capability => ({
          capability,
          result: { ok: true, diagnostics: [] },
        })),
        diagnostics: [],
      }
    }

    const first = await packIndustryCapabilityWorkspace({ workspace: fixture.workspace, build })
    const firstZip = readFileSync(first.zipPath)
    const second = await packIndustryCapabilityWorkspace({ workspace: fixture.workspace, build })
    const secondZip = readFileSync(second.zipPath)

    expect(buildCalls).toBe(2)
    expect(firstZip.equals(secondZip)).toBe(true)
    expect(first.packageDir).toBe(join(realpathSync(fixture.root), 'release', 'exp_workspace_package'))
    expect(JSON.parse(await readFile(join(first.packageDir, 'packages.json'), 'utf8'))).toEqual([{
      packageId: 'exp_workspace_package',
      name: 'Workspace Package',
      capabilityIds: ['exp_workspace_alpha', 'exp_workspace_beta'],
    }])
    for (const capabilityId of fixture.workspace.packageManifest.capabilityIds) {
      const capabilityDir = join(first.packageDir, capabilityId)
      expect(existsSync(join(capabilityDir, 'capabilities.json'))).toBe(true)
      expect(existsSync(join(capabilityDir, `frontend/${capabilityId}_frontend/plugin.json`))).toBe(true)
      expect(existsSync(join(capabilityDir, `frontend/${capabilityId}_frontend/dist/fh2-plugin.json`))).toBe(true)
      expect(existsSync(join(capabilityDir, `backend/${capabilityId}_backend/plugin.json`))).toBe(true)
      expect(existsSync(join(capabilityDir, `backend/${capabilityId}_backend/workflows/example.json`))).toBe(true)
      expect(existsSync(join(capabilityDir, `frontend/${capabilityId}_frontend/src/not-for-upload.ts`))).toBe(false)
      expect(existsSync(join(capabilityDir, `backend/${capabilityId}_backend/build-info.json`))).toBe(false)
      expect(existsSync(join(capabilityDir, `backend/${capabilityId}_backend/scripts/handlers.js`))).toBe(true)
      expect(existsSync(join(capabilityDir, `backend/${capabilityId}_backend/scripts/handlers.js.map`))).toBe(false)
    }
    expect(firstZip.toString('latin1')).not.toContain('scripts/handlers.js.map')
    expect(existsSync(join(first.packageDir, 'SIGNATURE'))).toBe(false)
    expect(firstZip.toString('latin1')).toContain('exp_workspace_alpha/frontend/exp_workspace_alpha_frontend/plugin.json')
    expect(firstZip.toString('latin1')).toContain('exp_workspace_beta/backend/exp_workspace_beta_backend/schema.sql')
  })

  it('工作区 Pack 在任一 Capability Build 失败时不提交上传包', async () => {
    const fixture = await createWorkspaceFixture()

    await expect(packIndustryCapabilityWorkspace({
      workspace: fixture.workspace,
      build: async options => ({
        ok: false,
        capabilities: [{
          capability: options.workspace.capabilities[0]!,
          result: {
            ok: false,
            diagnostics: [{
              code: 'FH2_TEST_BUILD_FAILED',
              phase: 'compile',
              message: 'expected workspace build failure',
            }],
          },
        }],
        diagnostics: [],
      }),
    })).rejects.toMatchObject({ diagnostic: { code: 'FH2_INDUSTRY_CAPABILITY_WORKSPACE_PACK_BUILD_FAILED' } })
    expect(existsSync(join(fixture.root, 'release/exp_workspace_package'))).toBe(false)
  })

  it('members 过滤：只装选中的成员（noBuild 路径拒绝组合，走 build stub）', async () => {
    const fixture = await createFixture()
    const build = async (): Promise<import('./build.js').CapabilityBuildResult> => ({ ok: true, diagnostics: [] })

    const result = await packCapability({
      capability: fixture.capability,
      members: new Set(['exp_pack_frontend']),
      build,
    })

    const zipNames = readFileSync(result.zipPath).toString('latin1')
    expect(zipNames).toContain('exp_pack_capability/frontend/exp_pack_frontend/plugin.json')
    expect(zipNames).not.toContain('exp_pack_capability/backend/exp_pack_backend/plugin.json')
    // 选中成员之外的内容不进包（目录级验证）
    expect(existsSync(join(result.capabilityDir, 'frontend/exp_pack_frontend/plugin.json'))).toBe(true)
    expect(existsSync(join(result.capabilityDir, 'backend/exp_pack_backend'))).toBe(false)
  })

  it('members 与 noBuild 同时使用时拒绝', async () => {
    const fixture = await createFixture()
    writeFreshReport(fixture)
    await expect(packCapability({
      capability: fixture.capability,
      members: new Set(['exp_pack_frontend']),
      noBuild: true,
    })).rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_PACK_MEMBERS_NO_BUILD' } })
  })

  it('members 引用不存在的插件时拒绝', async () => {
    const fixture = await createFixture()
    const build = async (): Promise<import('./build.js').CapabilityBuildResult> => ({ ok: true, diagnostics: [] })
    await expect(packCapability({
      capability: fixture.capability,
      members: new Set(['no_such_member']),
      build,
    })).rejects.toMatchObject({ diagnostic: { code: 'FH2_CAPABILITY_PLUGIN_DISCOVERY_FAILED' } })
  })

  it('工作区 members：整选 capability + 单选另一 capability 的单个成员', async () => {
    const fixture = await createWorkspaceFixture()
    const build = async (
      options: import('./build.js').IndustryCapabilityWorkspaceBuildOptions,
    ): Promise<import('./build.js').IndustryCapabilityWorkspaceBuildResult> => ({
      ok: true,
      capabilities: options.workspace.capabilities.map(capability => ({
        capability,
        result: { ok: true, diagnostics: [] },
      })),
      diagnostics: [],
    })

    const result = await packIndustryCapabilityWorkspace({
      workspace: fixture.workspace,
      members: new Set(['exp_workspace_alpha', 'exp_workspace_beta/exp_workspace_beta_frontend']),
      build,
    })

    const zipNames = readFileSync(result.zipPath).toString('latin1')
    // alpha 整选：frontend + backend 都在
    expect(zipNames).toContain('exp_workspace_alpha/frontend/exp_workspace_alpha_frontend/plugin.json')
    expect(zipNames).toContain('exp_workspace_alpha/backend/exp_workspace_alpha_backend/plugin.json')
    // beta 只选了 frontend：backend 不进包
    expect(zipNames).toContain('exp_workspace_beta/frontend/exp_workspace_beta_frontend/plugin.json')
    expect(zipNames).not.toContain('exp_workspace_beta/backend/exp_workspace_beta_backend/plugin.json')
  })

  it('工作区 members：没有任何成员选中的 capability 整个不进包', async () => {
    const fixture = await createWorkspaceFixture()
    const build = async (
      options: import('./build.js').IndustryCapabilityWorkspaceBuildOptions,
    ): Promise<import('./build.js').IndustryCapabilityWorkspaceBuildResult> => ({
      ok: true,
      capabilities: options.workspace.capabilities.map(capability => ({
        capability,
        result: { ok: true, diagnostics: [] },
      })),
      diagnostics: [],
    })

    const result = await packIndustryCapabilityWorkspace({
      workspace: fixture.workspace,
      members: new Set(['exp_workspace_alpha/exp_workspace_alpha_backend']),
      build,
    })

    const zipNames = readFileSync(result.zipPath).toString('latin1')
    expect(zipNames).not.toContain('exp_workspace_beta/')
    expect(zipNames).toContain('exp_workspace_alpha/backend/exp_workspace_alpha_backend/plugin.json')
    expect(zipNames).not.toContain('exp_workspace_alpha/frontend/exp_workspace_alpha_frontend/plugin.json')
  })

  it('工作区 members：构建范围与装包范围一致（memberFilters 下发给 build）', async () => {
    const fixture = await createWorkspaceFixture()
    const seenFilters: Array<Map<string, import('./build.js').IndustryCapabilityWorkspaceMemberFilter> | undefined> = []
    const build = async (
      options: import('./build.js').IndustryCapabilityWorkspaceBuildOptions,
    ): Promise<import('./build.js').IndustryCapabilityWorkspaceBuildResult> => {
      seenFilters.push(options.memberFilters === undefined ? undefined : new Map(options.memberFilters))
      return {
        ok: true,
        capabilities: options.workspace.capabilities.map(capability => ({
          capability,
          result: { ok: true, diagnostics: [] },
        })),
        diagnostics: [],
      }
    }

    await packIndustryCapabilityWorkspace({
      workspace: fixture.workspace,
      members: new Set(['exp_workspace_beta/exp_workspace_beta_frontend']),
      build,
    })
    await packIndustryCapabilityWorkspace({
      workspace: fixture.workspace,
      build,
    })

    // members 打包：alpha 未选不构建，beta 只构建选中的 frontend 成员
    const filtered = seenFilters[0]!
    expect([...filtered.keys()]).toEqual(['exp_workspace_beta'])
    expect(filtered.get('exp_workspace_beta')!.frontend).toEqual(new Set(['exp_workspace_beta_frontend']))
    expect(filtered.get('exp_workspace_beta')!.backend).toEqual(new Set())
    // 全量打包（members 缺省）：不下发 memberFilters，维持旧行为
    expect(seenFilters[1]).toBeUndefined()
  })

  it('工作区 members 引用不存在的成员时拒绝', async () => {
    const fixture = await createWorkspaceFixture()
    const build = async (
      options: import('./build.js').IndustryCapabilityWorkspaceBuildOptions,
    ): Promise<import('./build.js').IndustryCapabilityWorkspaceBuildResult> => ({
      ok: true,
      capabilities: options.workspace.capabilities.map(capability => ({
        capability,
        result: { ok: true, diagnostics: [] },
      })),
      diagnostics: [],
    })

    await expect(packIndustryCapabilityWorkspace({
      workspace: fixture.workspace,
      members: new Set(['exp_workspace_alpha/no_such_member']),
      build,
    })).rejects.toMatchObject({ diagnostic: { code: 'FH2_INDUSTRY_CAPABILITY_WORKSPACE_PACK_MEMBER_NOT_FOUND' } })
  })
})

async function createFixture (): Promise<{
  readonly root: string;
  readonly frontendRoot: string;
  readonly backendRoot: string;
  readonly capability: CapabilityProject;
}> {
  const parent = await mkdtemp(join(tmpdir(), 'fh2-capability-pack-'))
  const root = join(parent, 'exp_pack_capability')
  const frontendRoot = join(root, 'frontend/exp_pack_frontend')
  const backendRoot = join(root, 'backend/exp_pack_backend')
  roots.push(parent)
  await mkdir(join(frontendRoot, 'dist'), { recursive: true })
  await mkdir(join(backendRoot, 'dist/workflows'), { recursive: true })
  await mkdir(join(backendRoot, 'dist/handlers/items'), { recursive: true })
  await writeFile(join(root, 'capabilities.json'), JSON.stringify({ name: 'Pack Capability', description: 'pack test' }))
  await writeFile(join(root, 'packages.json'), JSON.stringify([{
    packageId: 'exp_pack_package',
    name: 'Pack Package',
    capabilityIds: ['exp_pack_capability'],
  }]))
  await writeFile(join(frontendRoot, 'dist/fh2-plugin.json'), JSON.stringify({
    id: 'exp_pack_frontend',
    name: 'Pack Frontend',
    version: '0.1.0',
    manifestVersion: 1,
    engines: { platform: '>=1.0.0-alpha.0 <2.0.0' },
    entry: './plugin.js',
    extensions: [],
    buildInfo: { sdkVersion: '1.0.0-alpha.0', toolchainVersion: '1.0.0-alpha.0' },
  }))
  await writeFile(join(frontendRoot, 'dist/plugin.js'), 'export default {}\n')
  await writeFile(join(backendRoot, 'dist/plugin.json'), JSON.stringify({
    pluginId: 'exp_pack_backend',
    name: 'Pack Backend',
    version: '0.1.0',
    flows: ['workflows/example.json'],
    // 空步骤流程自图校验进发布期（DAG-006-06）起被拒：pack 的验证与
    // precheck 同一套规则，fixture 也要给一条立得住的流程。
    scripts: [{ name: 'example', path: 'handlers/items/create.js', entry: 'handle', io: { inputs: [], outputs: [] } }],
  }))
  await writeFile(join(backendRoot, 'dist/workflows/example.json'), JSON.stringify({ name: 'pack-flow', trigger: { api: {} }, steps: [{ id: 'example', action: 'run_script', inputs: { script: { const: 'example' } } }] }))
  await writeFile(join(backendRoot, 'dist/handlers/items/create.js'), 'function handle() { return {} }\n')
  await writeFile(join(backendRoot, 'dist/handlers/items/create.js.map'), JSON.stringify({
    version: 3,
    sources: ['handlers/items/create.ts'],
    sourcesContent: ['export function handle() { return {} }'],
    mappings: '',
  }))
  await writeFile(join(backendRoot, 'dist/build-info.json'), JSON.stringify({ toolchainVersion: '1.0.0-alpha.0' }))
  await writeFile(join(backendRoot, 'dist/schema.sql'), 'CREATE TABLE ignored;\n')
  const capability: CapabilityProject = {
    kind: 'capability-project',
    root,
    capabilityId: 'exp_pack_capability',
    metadataPath: join(root, 'capabilities.json'),
    metadata: { name: 'Pack Capability', description: 'pack test' },
    frontend: [{ id: 'exp_pack_frontend', root: frontendRoot, manifestPath: join(frontendRoot, 'fh2-plugin.json') }],
    backend: [{ id: 'exp_pack_backend', root: backendRoot, manifestPath: join(backendRoot, 'fh2-plugin.json') }],
  }
  return { root, frontendRoot, backendRoot, capability }
}

function derivedWorkspaceDigest (packageId: string, name: string, capabilityId: string): string {
  return createHash('sha256')
    .update(Buffer.from(serializePackageManifest({ packageId, name, capabilityIds: [capabilityId] }), 'utf8'))
    .digest('hex')
}

function writeFreshReportWithDigest (
  fixture: Awaited<ReturnType<typeof createFixture>>,
  packageManifestDigest: string,
): void {
  writeBuildReport(fixture.root, {
    capabilityId: fixture.capability.capabilityId,
    metadataDigest: digestFile(fixture.capability.metadataPath),
    packageManifestDigest,
    frontend: {
      exp_pack_frontend: {
        status: 'success',
        version: '0.1.0',
        digest: digestBuildDirectory(join(fixture.frontendRoot, 'dist')),
        sourceDigest: digestSourceDirectory(fixture.frontendRoot),
      },
    },
    backend: {
      exp_pack_backend: {
        status: 'success',
        version: '0.1.0',
        digest: digestBuildDirectory(join(fixture.backendRoot, 'dist')),
        sourceDigest: digestSourceDirectory(fixture.backendRoot),
      },
    },
  })
}

function writeFreshReport (
  fixture: Awaited<ReturnType<typeof createFixture>>,
  configPath?: string,
  includeRemovedPlugin = false,
  hasExternalSourceDependencies = false,
): void {
  writeBuildReport(fixture.root, {
    capabilityId: fixture.capability.capabilityId,
    metadataDigest: digestFile(fixture.capability.metadataPath),
    packageManifestDigest: digestFile(join(fixture.root, 'packages.json')),
    frontend: {
      exp_pack_frontend: {
        status: 'success',
        version: '0.1.0',
        digest: digestBuildDirectory(join(fixture.frontendRoot, 'dist')),
        sourceDigest: digestSourceDirectory(fixture.frontendRoot),
        ...(configPath === undefined
          ? {}
          : {
              configPath,
              configDigest: digestFile(configPath),
            }),
        ...(hasExternalSourceDependencies ? { hasExternalSourceDependencies: true } : {}),
      },
      ...(includeRemovedPlugin
        ? {
            exp_removed_frontend: {
              status: 'success' as const,
              version: '0.1.0',
              digest: digestBuildDirectory(join(fixture.frontendRoot, 'dist')),
              sourceDigest: digestSourceDirectory(fixture.frontendRoot),
            },
          }
        : {}),
    },
    backend: {
      exp_pack_backend: {
        status: 'success',
        version: '0.1.0',
        digest: digestBuildDirectory(join(fixture.backendRoot, 'dist')),
        sourceDigest: digestSourceDirectory(fixture.backendRoot),
      },
    },
  })
}

async function createWorkspaceFixture (): Promise<{
  readonly root: string;
  readonly workspace: IndustryCapabilityWorkspaceProject;
}> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-workspace-pack-'))
  roots.push(root)
  const capabilityIds = ['exp_workspace_alpha', 'exp_workspace_beta']
  await writeFile(join(root, 'packages.json'), JSON.stringify([{
    packageId: 'exp_workspace_package',
    name: 'Workspace Package',
    capabilityIds,
  }]))
  await Promise.all(capabilityIds.map(capabilityId => writeWorkspaceCapability(root, capabilityId)))
  return { root, workspace: discoverIndustryCapabilityWorkspace(root) }
}

async function writeWorkspaceCapability (root: string, capabilityId: string): Promise<void> {
  const capabilityRoot = join(root, capabilityId)
  const frontendId = `${capabilityId}_frontend`
  const backendId = `${capabilityId}_backend`
  const frontendRoot = join(capabilityRoot, 'frontend', frontendId)
  const backendRoot = join(capabilityRoot, 'backend', backendId)
  await mkdir(join(frontendRoot, 'dist'), { recursive: true })
  await mkdir(join(backendRoot, 'dist/workflows'), { recursive: true })
  await mkdir(join(frontendRoot, 'src'), { recursive: true })
  await writeFile(join(capabilityRoot, 'capabilities.json'), JSON.stringify({
    name: capabilityId,
    description: 'workspace pack test',
  }))
  await writeFile(join(frontendRoot, 'fh2-plugin.json'), JSON.stringify({ id: frontendId }))
  await writeFile(join(backendRoot, 'fh2-plugin.json'), JSON.stringify({ pluginId: backendId }))
  await writeFile(join(frontendRoot, 'src/not-for-upload.ts'), 'export const sourceOnly = true\n')
  await writeFile(join(frontendRoot, 'dist/fh2-plugin.json'), JSON.stringify({
    id: frontendId,
    name: frontendId,
    version: '0.1.0',
    manifestVersion: 1,
    engines: { platform: '>=1.0.0-alpha.0 <2.0.0' },
    entry: './plugin.js',
    extensions: [],
    buildInfo: { sdkVersion: '1.0.0-alpha.0', toolchainVersion: '1.0.0-alpha.0' },
  }))
  await writeFile(join(frontendRoot, 'dist/plugin.js'), 'export default {}\n')
  await writeFile(join(backendRoot, 'dist/plugin.json'), JSON.stringify({
    pluginId: backendId,
    name: backendId,
    version: '0.1.0',
    flows: ['workflows/example.json'],
    // 同上：流程必须立得住（至少一个真实步骤），空 steps 会被发布期结构校验拒绝。
    scripts: [{ name: 'example', path: 'scripts/handlers.js', entry: 'handle', io: { inputs: [], outputs: [] } }],
  }))
  await writeFile(join(backendRoot, 'dist/workflows/example.json'), JSON.stringify({
    name: `${backendId}-flow`,
    trigger: { api: {} },
    steps: [{ id: 'example', action: 'run_script', inputs: { script: { const: 'example' } } }],
  }))
  await writeFile(join(backendRoot, 'dist/schema.sql'), 'CREATE TABLE workspace_record (id TEXT);\n')
  await writeFile(join(backendRoot, 'dist/build-info.json'), '{}\n')
  await mkdir(join(backendRoot, 'dist/scripts'), { recursive: true })
  await writeFile(join(backendRoot, 'dist/scripts/handlers.js'), 'function handle() { return {} }\n')
  await writeFile(join(backendRoot, 'dist/scripts/handlers.js.map'), JSON.stringify({
    version: 3,
    sources: ['handlers/create.ts'],
    sourcesContent: ['export function handle() { return {} }'],
    mappings: '',
  }))
}
