// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { PluginManifest } from 'fh2-plugin-sdk'
import { PluginPackError } from '../pack/index.js'
import type {
  PackIndustryPluginsOptions,
  PackIndustryPluginsResult,
} from '../pack/index.js'
import type { CapabilityProject, IndustryCapabilityWorkspaceProject } from '../capability/types.js'
import type { BuildCommandOptions, BuildSignalSource } from './build-command.js'
import { runPackCommand } from './pack-command.js'

describe('pack command parser/handler', () => {
  it.each([
    ['unknown', ['--unknown']],
    ['positional', ['fixture']],
    ['removed no-build', ['--no-build']],
    ['removed config', ['--config', './rsbuild.config.ts']],
    ['missing out-dir', ['--out-dir']],
  ])('拒绝 %s 并退出 2', async (_name, args) => {
    const harness = commandHarness()
    expect(await runPackCommand({ args, cwd: '/industry', ...harness })).toBe(2)
    expect(harness.stderr.text).toContain('用法：fh2-plugin pack')
    expect(harness.discoverPluginRoots).not.toHaveBeenCalled()
    expect(harness.runBuild).not.toHaveBeenCalled()
  })

  it('help 不扫描、构建或打包', async () => {
    const harness = commandHarness()
    expect(await runPackCommand({ args: ['--help'], cwd: '/industry', ...harness })).toBe(0)
    expect(harness.discoverPluginRoots).not.toHaveBeenCalled()
    expect(harness.runBuild).not.toHaveBeenCalled()
    expect(harness.pack).not.toHaveBeenCalled()
  })

  it('扫描行业包插件，逐个构建后聚合到默认 dist', async () => {
    const harness = commandHarness()
    expect(await runPackCommand({ args: [], cwd: '/industry', ...harness })).toBe(0)
    expect(harness.discoverPluginRoots).toHaveBeenCalledWith('/industry')
    expect(harness.runBuild.mock.calls.map(([options]) => options.cwd)).toEqual([
      '/industry/plugins/a',
      '/industry/plugins/b',
    ])
    expect(harness.pack).toHaveBeenCalledWith({
      industryRoot: '/industry',
      pluginRoots: ['/industry/plugins/a', '/industry/plugins/b'],
      outputRoot: '/industry/dist',
    })
    expect(harness.stdout.text).toContain('2 个插件已聚合到 /industry/dist')
  })

  it('--out-dir 相对行业包根解析', async () => {
    const harness = commandHarness()
    expect(await runPackCommand({
      args: ['--out-dir', './release'],
      cwd: '/industry',
      ...harness,
    })).toBe(0)
    expect(harness.pack).toHaveBeenCalledWith({
      industryRoot: '/industry',
      pluginRoots: ['/industry/plugins/a', '/industry/plugins/b'],
      outputRoot: join('/industry', 'release'),
    })
  })

  it('任一插件构建失败时停止且不聚合', async () => {
    const harness = commandHarness()
    harness.runBuild.mockResolvedValueOnce(0).mockResolvedValueOnce(1)
    expect(await runPackCommand({ args: [], cwd: '/industry', ...harness })).toBe(1)
    expect(harness.pack).not.toHaveBeenCalled()
  })

  it.each([130, 0])('构建返回信号退出码 %s 时不继续聚合', async (exitCode) => {
    const harness = commandHarness()
    harness.runBuild.mockImplementation(async () => {
      harness.signals.emit(exitCode === 130 ? 'SIGINT' : 'SIGTERM')
      return exitCode
    })
    expect(await runPackCommand({ args: [], cwd: '/industry', ...harness })).toBe(exitCode)
    expect(harness.pack).not.toHaveBeenCalled()
  })

  it.each([130, 0])('聚合期间收到信号时返回 %s 且不打印成功', async (exitCode) => {
    const harness = commandHarness()
    harness.pack.mockImplementation(async () => {
      harness.signals.emit(exitCode === 130 ? 'SIGINT' : 'SIGTERM')
      return {
        outputRoot: '/industry/dist',
        packages: [],
        warnings: [],
      }
    })
    expect(await runPackCommand({ args: [], cwd: '/industry', ...harness })).toBe(exitCode)
    expect(harness.stdout.text).not.toContain('fh2-plugin pack 成功')
  })

  it('可预期的行业包校验失败退出 1', async () => {
    const harness = commandHarness()
    harness.pack.mockRejectedValue(new PluginPackError({
      code: 'FH2_PACK_TEST_INVALID',
      message: 'invalid package',
    }))
    expect(await runPackCommand({ args: [], cwd: '/industry', ...harness })).toBe(1)
    expect(harness.stderr.text).toContain('FH2_PACK_TEST_INVALID [pack]')
  })

  it('capability 根走未签名 Capability Pack，并支持 --no-build', async () => {
    const harness = commandHarness()
    const capability = capabilityFixture()
    const packCapability = vi.fn(async () => ({
      releaseRoot: '/capability/release',
      packageDir: '/capability/release/exp_package',
      capabilityDir: '/capability/release/exp_package/exp_capability',
      packageId: 'exp_package',
      zipPath: '/capability/release/exp_package.zip',
      warnings: [],
    }))

    const code = await runPackCommand({
      args: ['--no-build', '--out-dir', 'release'],
      cwd: '/capability',
      ...harness,
      resolveContext: () => capability,
      packCapability: packCapability as typeof import('../capability/pack.js').packCapability,
    })

    expect(code).toBe(0)
    expect(packCapability).toHaveBeenCalledWith({
      capability,
      noBuild: true,
      outputRoot: join('/capability', 'release'),
    })
    expect(harness.discoverPluginRoots).not.toHaveBeenCalled()
    expect(harness.stdout.text).toContain('exp_package.zip')
    expect(harness.stdout.text).toContain('UPLOAD_READY /capability/release/exp_package.zip')
  })

  it('行业 Capability 工作区委托根级 Pack，输出单个上传包', async () => {
    const harness = commandHarness()
    const workspace = workspaceFixture()
    const packIndustryCapabilityWorkspace = vi.fn(async (
      options: import('../capability/pack.js').IndustryCapabilityWorkspacePackOptions,
    ): Promise<import('../capability/pack.js').IndustryCapabilityWorkspacePackResult> => {
      for (const capability of options.workspace.capabilities) {
        options.onCapabilityEvent?.({ capability, type: 'start', diagnostics: [] })
        options.onCapabilityEvent?.({ capability, type: 'success', diagnostics: [] })
      }
      return {
        releaseRoot: '/workspace/release',
        packageDir: '/workspace/release/exp_workspace_package',
        packageId: 'exp_workspace_package',
        zipPath: '/workspace/release/exp_workspace_package.zip',
        warnings: [],
      }
    })

    const code = await runPackCommand({
      args: ['--out-dir', 'release'],
      cwd: '/workspace',
      ...harness,
      resolveContext: () => workspace,
      packIndustryCapabilityWorkspace,
    })

    expect(code).toBe(0)
    expect(packIndustryCapabilityWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      workspace,
      outputRoot: join('/workspace', 'release'),
    }))
    expect(harness.discoverPluginRoots).not.toHaveBeenCalled()
    expect(harness.stdout.text).toContain('✓ [capability exp_workspace_alpha] build success')
    expect(harness.stdout.text).toContain('UPLOAD_READY /workspace/release/exp_workspace_package.zip')
  })

  it('行业 Capability 工作区 Pack 拒绝 --no-build', async () => {
    const harness = commandHarness()
    const packIndustryCapabilityWorkspace = vi.fn()

    expect(await runPackCommand({
      args: ['--no-build'],
      cwd: '/workspace',
      ...harness,
      resolveContext: () => workspaceFixture(),
      packIndustryCapabilityWorkspace,
    })).toBe(2)
    expect(packIndustryCapabilityWorkspace).not.toHaveBeenCalled()
    expect(harness.stderr.text).toContain('始终先构建全部 Capability')
  })
})

function capabilityFixture (): CapabilityProject {
  return {
    kind: 'capability-project',
    root: '/capability',
    capabilityId: 'exp_capability',
    metadataPath: '/capability/capabilities.json',
    metadata: { name: 'Capability', description: 'pack test' },
    frontend: [],
    backend: [],
  }
}

function workspaceFixture (): IndustryCapabilityWorkspaceProject {
  const capability: CapabilityProject = {
    kind: 'capability-project',
    root: '/workspace/exp_workspace_alpha',
    capabilityId: 'exp_workspace_alpha',
    metadataPath: '/workspace/exp_workspace_alpha/capabilities.json',
    metadata: { name: 'Workspace Capability', description: 'pack command test' },
    frontend: [],
    backend: [],
  }
  return {
    kind: 'industry-capability-workspace',
    root: '/workspace',
    packageManifestPath: '/workspace/packages.json',
    packageManifest: {
      packageId: 'exp_workspace_package',
      name: 'Workspace Package',
      capabilityIds: ['exp_workspace_alpha'],
    },
    capabilities: [capability],
  }
}

function commandHarness () {
  const stdout = new CaptureWriter()
  const stderr = new CaptureWriter()
  const pluginRoots = ['/industry/plugins/a', '/industry/plugins/b']
  const manifest: PluginManifest = {
    id: 'official_test',
    name: 'Test Plugin',
    version: '1.0.0',
    entry: './plugin.js',
    extensions: [],
  }
  const result: PackIndustryPluginsResult = {
    outputRoot: '/industry/dist',
    packages: pluginRoots.map((_, index) => ({
      packageRoot: `/industry/dist/official_${index}`,
      pluginJsonPath: `/industry/dist/official_${index}/plugin.json`,
      packageManifest: {
        pluginId: `official_${index}`,
        name: `Plugin ${index}`,
        description: '',
        version: '1.0.0',
        manifest,
      },
      warnings: [],
    })),
    warnings: [],
  }
  return {
    stdout,
    stderr,
    signals: new NoopSignals(),
    discoverPluginRoots: vi.fn<(industryRoot: string) => readonly string[]>(() => pluginRoots),
    runBuild: vi.fn<(options: BuildCommandOptions) => Promise<number>>(async () => 0),
    pack: vi.fn<(options: PackIndustryPluginsOptions) => Promise<PackIndustryPluginsResult>>(
      async () => result,
    ),
  }
}

class CaptureWriter {
  text = ''

  write (chunk: string): boolean {
    this.text += chunk
    return true
  }
}

class NoopSignals implements BuildSignalSource {
  private readonly listeners = new Map<'SIGINT' | 'SIGTERM', Set<() => void>>()

  on (signal: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set()
    listeners.add(listener)
    this.listeners.set(signal, listeners)
  }

  off (signal: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    this.listeners.get(signal)?.delete(listener)
  }

  emit (signal: 'SIGINT' | 'SIGTERM'): void {
    for (const listener of this.listeners.get(signal) ?? []) listener()
  }
}
