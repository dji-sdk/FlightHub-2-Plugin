// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendPluginBuildResult } from '../backend/build.js'
import { PluginBuildError } from '../build/types.js'
import type { PluginBuildRunnerOptions, PluginBuildSession } from '../build/types.js'
import type { CapabilityProject, IndustryCapabilityWorkspaceProject } from './types.js'
import { buildCapability, buildIndustryCapabilityWorkspace, isBackendWatchIgnored, watchCapability } from './build.js'
import { digestSourceDirectory } from './build-report.js'
import type { CapabilityValidationResult } from './validate.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('capability build', () => {
  it('在所有候选产物成功后一起提交并写入 Build Report', async () => {
    const fixture = await createFixture()
    const createFrontendRunner = fakeFrontendRunner(fixture.frontendRoot, 'new frontend')
    const buildBackend = vi.fn(() => fakeBackendBuild(fixture.backendRoot, 'new backend'))

    const result = await buildCapability({
      capability: fixture.capability,
      createFrontendRunner,
      buildBackend: buildBackend as unknown as typeof import('../backend/build.js').buildBackendPlugin,
      validate: validValidation,
    })

    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    expect(createFrontendRunner).toHaveBeenCalledWith(expect.objectContaining({
      includeBackend: false,
      deferCommit: true,
      watch: false,
    }))
    expect(await readFile(join(fixture.frontendRoot, 'dist/payload.txt'), 'utf8')).toBe('new frontend')
    expect(await readFile(join(fixture.backendRoot, 'dist/payload.txt'), 'utf8')).toBe('new backend')
    const report = JSON.parse(await readFile(join(fixture.root, '.fh2/build-report.json'), 'utf8'))
    expect(report).toMatchObject({
      capabilityId: 'exp_capability_build',
      frontend: { exp_capability_frontend: { status: 'success', version: '0.1.0' } },
      backend: { exp_capability_backend: { status: 'success', version: '0.1.0' } },
    })
    expect(report.frontend.exp_capability_frontend.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('行业 Capability 工作区继续 fan-out 后续 Capability，并逐项报告结果', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-workspace-build-'))
    roots.push(root)
    const capabilities = ['exp_workspace_alpha', 'exp_workspace_beta'].map((capabilityId): CapabilityProject => ({
      kind: 'capability-project',
      root: join(root, capabilityId),
      capabilityId,
      metadataPath: join(root, capabilityId, 'capabilities.json'),
      metadata: { name: capabilityId, description: 'workspace build test' },
      frontend: [],
      backend: [],
    }))
    const workspace: IndustryCapabilityWorkspaceProject = {
      kind: 'industry-capability-workspace',
      root,
      packageManifestPath: join(root, 'packages.json'),
      packageManifest: {
        packageId: 'exp_workspace_package',
        name: 'Workspace Package',
        capabilityIds: capabilities.map(capability => capability.capabilityId),
      },
      capabilities,
    }
    const calls: string[] = []
    const events: string[] = []

    const result = await buildIndustryCapabilityWorkspace({
      workspace,
      buildCapability: async ({ capability }) => {
        calls.push(capability.capabilityId)
        return capability.capabilityId === 'exp_workspace_alpha'
          ? {
              ok: false,
              diagnostics: [{ code: 'FH2_TEST_FAILURE', phase: 'compile', message: 'alpha failed' }],
            }
          : { ok: true, diagnostics: [] }
      },
      onCapabilityEvent: event => events.push(`${event.capability.capabilityId}:${event.type}`),
    })

    expect(result.ok).toBe(false)
    expect(calls).toEqual(['exp_workspace_alpha', 'exp_workspace_beta'])
    expect(events).toEqual([
      'exp_workspace_alpha:start',
      'exp_workspace_alpha:failure',
      'exp_workspace_beta:start',
      'exp_workspace_beta:success',
    ])
    expect(result.capabilities.map(item => item.result.ok)).toEqual([false, true])
  })

  it('memberFilters：跳过未选中的 Capability，选中的只构建指定侧别成员', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-workspace-build-'))
    roots.push(root)
    const toProjects = (ids: readonly string[]) => ids.map(id => ({
      id,
      root: join(root, 'cap', id),
      manifestPath: join(root, 'cap', id, 'fh2-plugin.json'),
    }))
    const capabilities: CapabilityProject[] = [
      {
        kind: 'capability-project',
        root: join(root, 'cap_a'),
        capabilityId: 'cap_a',
        metadataPath: join(root, 'cap_a', 'capabilities.json'),
        metadata: { name: 'cap_a', description: 'member filter test' },
        frontend: toProjects(['cap_a_fe', 'cap_a_fe2']),
        backend: toProjects(['cap_a_be']),
      },
      {
        kind: 'capability-project',
        root: join(root, 'cap_b'),
        capabilityId: 'cap_b',
        metadataPath: join(root, 'cap_b', 'capabilities.json'),
        metadata: { name: 'cap_b', description: 'member filter test' },
        frontend: toProjects(['cap_b_fe']),
        backend: toProjects(['cap_b_be']),
      },
    ]
    const workspace: IndustryCapabilityWorkspaceProject = {
      kind: 'industry-capability-workspace',
      root,
      packageManifestPath: join(root, 'packages.json'),
      packageManifest: {
        packageId: 'exp_workspace_package',
        name: 'Workspace Package',
        capabilityIds: ['cap_a', 'cap_b'],
      },
      capabilities,
    }
    const buildCalls: Array<{ capabilityId: string; frontendFilter?: ReadonlySet<string>; backendFilter?: ReadonlySet<string> }> = []

    const result = await buildIndustryCapabilityWorkspace({
      workspace,
      // 只选 cap_a 的 frontend 单成员 cap_a_fe 与 backend 全部（等价全量构建 cap_a）
      memberFilters: new Map([['cap_a', {
        frontend: new Set(['cap_a_fe']),
        backend: new Set(['cap_a_be']),
      }]]),
      buildCapability: async ({ capability, frontendFilter, backendFilter }) => {
        buildCalls.push({
          capabilityId: capability.capabilityId,
          ...(frontendFilter === undefined ? {} : { frontendFilter }),
          ...(backendFilter === undefined ? {} : { backendFilter }),
        })
        return { ok: true, diagnostics: [] }
      },
    })

    expect(result.ok).toBe(true)
    // cap_b 未选中：不构建、不进结果
    expect(buildCalls.map(call => call.capabilityId)).toEqual(['cap_a'])
    expect(buildCalls[0]!.frontendFilter).toEqual(new Set(['cap_a_fe']))
    expect(buildCalls[0]!.backendFilter).toEqual(new Set(['cap_a_be']))
    expect(result.capabilities.map(item => item.capability.capabilityId)).toEqual(['cap_a'])
  })

  it('过滤空集跳过对应侧，另一侧照常构建', async () => {
    const fixture = await createFixture()
    const createFrontendRunner = vi.fn()
    const result = await buildCapability({
      capability: fixture.capability,
      frontendFilter: new Set(),
      backendFilter: new Set(['exp_capability_backend']),
      createFrontendRunner: createFrontendRunner as never,
      buildBackend: (() => fakeBackendBuild(fixture.backendRoot, 'new backend')) as unknown as typeof import('../backend/build.js').buildBackendPlugin,
      validate: validValidation,
    })

    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    expect(createFrontendRunner).not.toHaveBeenCalled()
    expect(await readFile(join(fixture.frontendRoot, 'dist/payload.txt'), 'utf8')).toBe('old frontend')
    expect(await readFile(join(fixture.backendRoot, 'dist/payload.txt'), 'utf8')).toBe('new backend')
  })

  it('后端失败时删除前端候选产物并保留所有旧 dist', async () => {
    const fixture = await createFixture()
    let candidateRoot = ''
    const createFrontendRunner = fakeFrontendRunner(fixture.frontendRoot, 'new frontend', (candidate) => {
      candidateRoot = candidate
    })
    const buildBackend = vi.fn(() => {
      throw new PluginBuildError([{
        code: 'FH2_BACKEND_BUILD_FAILED',
        phase: 'config',
        message: 'backend failure',
      }])
    })

    const result = await buildCapability({
      capability: fixture.capability,
      createFrontendRunner,
      buildBackend: buildBackend as unknown as typeof import('../backend/build.js').buildBackendPlugin,
      validate: validValidation,
    })

    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'FH2_BACKEND_BUILD_FAILED' }),
    ]))
    expect(await readFile(join(fixture.frontendRoot, 'dist/payload.txt'), 'utf8')).toBe('old frontend')
    expect(await readFile(join(fixture.backendRoot, 'dist/payload.txt'), 'utf8')).toBe('old backend')
    expect(existsSync(candidateRoot)).toBe(false)
    expect(existsSync(join(fixture.root, '.fh2/build-report.json'))).toBe(false)
  })

  it('记录 Capability 根外的前端构建依赖，禁止 --no-build 复用', async () => {
    const fixture = await createFixture()
    const externalDependency = join(fixture.root, '..', 'shared-outside.ts')
    await writeFile(externalDependency, 'export const value = 1\n')
    const result = await buildCapability({
      capability: fixture.capability,
      createFrontendRunner: fakeFrontendRunner(fixture.frontendRoot, 'new frontend', undefined, [externalDependency]),
      buildBackend: (() => fakeBackendBuild(fixture.backendRoot, 'new backend')) as unknown as typeof import('../backend/build.js').buildBackendPlugin,
      validate: validValidation,
    })

    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    expect(result.report?.frontend.exp_capability_frontend).toMatchObject({ hasExternalSourceDependencies: true })
  })

  it('记录默认 Rsbuild 配置的 Capability 外依赖', async () => {
    const fixture = await createFixture()
    const configPath = join(fixture.frontendRoot, 'rsbuild.config.ts')
    await writeFile(join(fixture.root, 'frontend/shared-config.ts'), 'export const shared = {}\n')
    await writeFile(configPath, 'import { shared } from \'../shared-config\'\nexport default shared\n')
    const result = await buildCapability({
      capability: fixture.capability,
      createFrontendRunner: fakeFrontendRunner(fixture.frontendRoot, 'new frontend', undefined, [], configPath),
      buildBackend: (() => fakeBackendBuild(fixture.backendRoot, 'new backend')) as unknown as typeof import('../backend/build.js').buildBackendPlugin,
      validate: validValidation,
    })

    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    expect(result.report?.frontend.exp_capability_frontend).toMatchObject({ hasExternalConfigDependencies: true })
  })

  it('在每个候选产物完成时记录源码指纹', async () => {
    const fixture = await createFixture()
    const sourcePath = join(fixture.frontendRoot, 'src/value.ts')
    await mkdir(join(fixture.frontendRoot, 'src'), { recursive: true })
    await writeFile(sourcePath, 'export const value = 1\n')
    const result = await buildCapability({
      capability: fixture.capability,
      createFrontendRunner: fakeFrontendRunner(fixture.frontendRoot, 'new frontend'),
      buildBackend: (() => {
        writeFileSync(sourcePath, 'export const value = 2\n')
        return fakeBackendBuild(fixture.backendRoot, 'new backend')
      }) as unknown as typeof import('../backend/build.js').buildBackendPlugin,
      validate: validValidation,
    })

    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    expect(result.report?.frontend.exp_capability_frontend?.sourceDigest).not.toBe(digestSourceDirectory(fixture.frontendRoot))
  })

  it('capabilities.json 在 Build 期间变化时回滚候选产物', async () => {
    const fixture = await createFixture()
    const result = await buildCapability({
      capability: fixture.capability,
      createFrontendRunner: fakeFrontendRunner(fixture.frontendRoot, 'new frontend'),
      buildBackend: (() => {
        writeFileSync(fixture.capability.metadataPath, JSON.stringify({ name: '已变更', description: '中途修改' }))
        return fakeBackendBuild(fixture.backendRoot, 'new backend')
      }) as unknown as typeof import('../backend/build.js').buildBackendPlugin,
      validate: validValidation,
    })

    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'FH2_CAPABILITY_BUILD_INPUT_CHANGED' }),
    ]))
    expect(await readFile(join(fixture.frontendRoot, 'dist/payload.txt'), 'utf8')).toBe('old frontend')
  })

  it('源码在候选产物生成期间变化时标记 Build Report 不可复用', async () => {
    const fixture = await createFixture()
    const sourcePath = join(fixture.frontendRoot, 'src/concurrent.ts')
    await mkdir(join(fixture.frontendRoot, 'src'), { recursive: true })
    await writeFile(sourcePath, 'export const value = 1\n')
    const result = await buildCapability({
      capability: fixture.capability,
      createFrontendRunner: fakeFrontendRunner(fixture.frontendRoot, 'new frontend', () => {
        writeFileSync(sourcePath, 'export const value = 2\n')
      }),
      buildBackend: (() => fakeBackendBuild(fixture.backendRoot, 'new backend')) as unknown as typeof import('../backend/build.js').buildBackendPlugin,
      validate: validValidation,
    })

    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    expect(result.report?.frontend.exp_capability_frontend).toMatchObject({ sourceChangedDuringBuild: true })
  })

  it('build report 候选创建失败时回滚所有插件候选产物', async () => {
    const fixture = await createFixture()
    let frontendCandidate = ''
    const createFrontendRunner = fakeFrontendRunner(fixture.frontendRoot, 'new frontend', (candidate) => {
      frontendCandidate = candidate
    })
    const buildBackend = vi.fn(() => fakeBackendBuild(fixture.backendRoot, 'new backend'))

    const result = await buildCapability({
      capability: fixture.capability,
      createFrontendRunner,
      buildBackend: buildBackend as unknown as typeof import('../backend/build.js').buildBackendPlugin,
      validate: validValidation,
      createReportCandidate: () => {
        throw new Error('report candidate failure')
      },
    })

    expect(result.ok).toBe(false)
    expect(await readFile(join(fixture.frontendRoot, 'dist/payload.txt'), 'utf8')).toBe('old frontend')
    expect(await readFile(join(fixture.backendRoot, 'dist/payload.txt'), 'utf8')).toBe('old backend')
    expect(existsSync(frontendCandidate)).toBe(false)
    expect(existsSync(join(fixture.backendRoot, '.dist.fh2-next-capability-test'))).toBe(false)
  })

  it('build report 提交失败时回滚已提交的 dist', async () => {
    const fixture = await createFixture()
    const result = await buildCapability({
      capability: fixture.capability,
      createFrontendRunner: fakeFrontendRunner(fixture.frontendRoot, 'new frontend'),
      buildBackend: (() => fakeBackendBuild(fixture.backendRoot, 'new backend')) as unknown as typeof import('../backend/build.js').buildBackendPlugin,
      validate: validValidation,
      createReportCandidate: () => ({
        candidatePath: join(fixture.root, '.fh2/missing-report.tmp'),
        reportPath: join(fixture.root, '.fh2/build-report.json'),
      }),
    })

    expect(result.ok).toBe(false)
    expect(await readFile(join(fixture.frontendRoot, 'dist/payload.txt'), 'utf8')).toBe('old frontend')
    expect(await readFile(join(fixture.backendRoot, 'dist/payload.txt'), 'utf8')).toBe('old backend')
  })

  it('拒绝指向 Capability 根外的 .fh2 符号链接', async () => {
    const fixture = await createFixture()
    const external = join(fixture.root, '..', 'external-report')
    await mkdir(external)
    await writeFile(join(external, 'build-report.json'), 'keep')
    await symlink(external, join(fixture.root, '.fh2'), 'dir')

    const result = await buildCapability({
      capability: fixture.capability,
      createFrontendRunner: fakeFrontendRunner(fixture.frontendRoot, 'new frontend'),
      buildBackend: (() => fakeBackendBuild(fixture.backendRoot, 'new backend')) as unknown as typeof import('../backend/build.js').buildBackendPlugin,
      validate: validValidation,
    })

    expect(result.ok).toBe(false)
    expect(await readFile(join(external, 'build-report.json'), 'utf8')).toBe('keep')
  })

  it('watch coordinator 在关闭时释放前端 Session 和后端 Watcher', async () => {
    const fixture = await createFixture()
    const initialRunner = fakeFrontendRunner(fixture.frontendRoot, 'new frontend')
    const watcherDone = deferred<{ readonly reason: 'closed' }>()
    const frontendClose = vi.fn(async () => {
      watcherDone.resolve({ reason: 'closed' })
    })
    const createFrontendRunner = vi.fn(async (options: PluginBuildRunnerOptions) => options.watch
      ? {
          firstBuild: Promise.resolve(),
          done: watcherDone.promise,
          close: frontendClose,
        }
      : await initialRunner(options))
    const backendWatcherClose = vi.fn(async () => {})

    const session = await watchCapability({
      capability: fixture.capability,
      createFrontendRunner,
      buildBackend: (() => fakeBackendBuild(fixture.backendRoot, 'new backend')) as unknown as typeof import('../backend/build.js').buildBackendPlugin,
      validate: validValidation,
      createBackendWatcher: () => ({ close: backendWatcherClose }),
    })
    await session.firstBuild
    expect(existsSync(join(fixture.root, '.fh2/build-report.json'))).toBe(false)
    await session.close()

    expect(frontendClose).toHaveBeenCalledTimes(1)
    expect(backendWatcherClose).toHaveBeenCalledTimes(1)
    await expect(session.done).resolves.toEqual({ reason: 'closed' })
  })

  it('在前端 Watch 首轮完成前已经监听后端源码', async () => {
    const fixture = await createFixture()
    const initialRunner = fakeFrontendRunner(fixture.frontendRoot, 'new frontend')
    const firstBuild = deferred<void>()
    const done = deferred<{ readonly reason: 'closed' }>()
    const createFrontendRunner = vi.fn(async (options: PluginBuildRunnerOptions) => options.watch
      ? {
          firstBuild: firstBuild.promise,
          done: done.promise,
          close: async () => done.resolve({ reason: 'closed' }),
        }
      : await initialRunner(options))
    const createBackendWatcher = vi.fn(() => ({ close: async () => {} }))

    const pending = watchCapability({
      capability: fixture.capability,
      createFrontendRunner,
      buildBackend: (() => fakeBackendBuild(fixture.backendRoot, 'new backend')) as unknown as typeof import('../backend/build.js').buildBackendPlugin,
      createBackendWatcher,
      validate: validValidation,
    })

    await vi.waitFor(() => expect(createBackendWatcher).toHaveBeenCalledOnce())
    firstBuild.resolve()
    const session = await pending
    await session.close()
  })

  it('backend watch 忽略 dist、候选和备份目录', () => {
    expect(isBackendWatchIgnored('/cap/backend/dist/plugin.json')).toBe(true)
    expect(isBackendWatchIgnored('/cap/backend/.dist.fh2-next-id/plugin.json')).toBe(true)
    expect(isBackendWatchIgnored('/cap/backend/.dist.fh2-capability-backup-id/plugin.json')).toBe(true)
    expect(isBackendWatchIgnored('/cap/backend/adapters/example.js')).toBe(false)
  })
})

async function createFixture (): Promise<{
  readonly root: string;
  readonly frontendRoot: string;
  readonly backendRoot: string;
  readonly capability: CapabilityProject;
}> {
  const parent = await mkdtemp(join(tmpdir(), 'fh2-capability-build-'))
  const root = join(parent, 'exp_capability_build')
  const frontendRoot = join(root, 'frontend/exp_capability_frontend')
  const backendRoot = join(root, 'backend/exp_capability_backend')
  roots.push(parent)
  await mkdir(join(frontendRoot, 'dist'), { recursive: true })
  await mkdir(join(backendRoot, 'dist'), { recursive: true })
  await writeFile(join(root, 'capabilities.json'), JSON.stringify({
    name: '构建测试',
    description: 'Capability 构建事务',
  }))
  await writeFile(join(frontendRoot, 'dist/payload.txt'), 'old frontend')
  await writeFile(join(backendRoot, 'dist/payload.txt'), 'old backend')
  const capability: CapabilityProject = {
    kind: 'capability-project',
    root,
    capabilityId: 'exp_capability_build',
    metadataPath: join(root, 'capabilities.json'),
    metadata: { name: '构建测试', description: 'Capability 构建事务' },
    frontend: [{
      id: 'exp_capability_frontend',
      root: frontendRoot,
      manifestPath: join(frontendRoot, 'fh2-plugin.json'),
    }],
    backend: [{
      id: 'exp_capability_backend',
      root: backendRoot,
      manifestPath: join(backendRoot, 'fh2-plugin.json'),
    }],
  }
  return { root, frontendRoot, backendRoot, capability }
}

function fakeFrontendRunner (
  frontendRoot: string,
  content: string,
  onCandidate?: (candidateRoot: string) => void,
  watchDependencies: readonly string[] = [],
  configPath?: string,
): ReturnType<typeof vi.fn<(options: PluginBuildRunnerOptions) => Promise<PluginBuildSession>>> {
  return vi.fn(async (options) => {
    const candidateRoot = join(frontendRoot, '.dist.fh2-next-capability-test')
    await mkdir(candidateRoot, { recursive: true })
    await writeFile(join(candidateRoot, 'payload.txt'), content)
    onCandidate?.(candidateRoot)
    options.onEvent?.({
      type: 'success',
      buildId: 1,
      diagnostics: [],
      candidateRoot,
      watchDependencies,
      ...(configPath === undefined ? {} : { configPath }),
      distManifest: {
        manifestVersion: 1,
        id: 'exp_capability_frontend',
        name: '构建测试前端',
        version: '0.1.0',
        engines: { platform: '>=1.0.0-alpha.0 <2.0.0' },
        entry: './plugin.js',
        extensions: [],
        buildInfo: { sdkVersion: '1.0.0-alpha.0', toolchainVersion: '1.0.0-alpha.0' },
      },
    })
    return {
      firstBuild: Promise.resolve(),
      done: Promise.resolve({ reason: 'closed' }),
      close: async () => {},
    }
  })
}

function fakeBackendBuild (backendRoot: string, content: string): BackendPluginBuildResult {
  const candidateRoot = join(backendRoot, '.dist.fh2-next-capability-test')
  mkdirSync(candidateRoot, { recursive: true })
  writeFileSync(join(candidateRoot, 'payload.txt'), content)
  return {
    pluginId: 'exp_capability_backend',
    version: '0.1.0',
    distRoot: join(backendRoot, 'dist'),
    candidateRoot,
    assets: [],
    watchDependencies: [],
    diagnostics: [],
  }
}

function validValidation (capability: CapabilityProject): CapabilityValidationResult {
  return { ok: true, capability, diagnostics: [] }
}

function deferred<T> (): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolveValue) => {
    resolvePromise = resolveValue
  })
  return { promise, resolve: resolvePromise }
}
