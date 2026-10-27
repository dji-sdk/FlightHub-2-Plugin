// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginManifest } from 'fh2-plugin-sdk'
import { PluginBuildError } from '../build/types.js'
import type { PluginBuildRunnerOptions, PluginBuildSession } from '../build/types.js'
import { runBuildCommand } from './build-command.js'
import type { BuildSignalSource } from './build-command.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const distManifest: PluginManifest = {
  manifestVersion: 1,
  id: 'exp_command',
  name: '命令测试',
  version: '1.0.0',
  engines: { platform: '>=1.0.0-alpha.0 <2.0.0' },
  entry: './plugin.12345678.js',
  extensions: [],
  buildInfo: { sdkVersion: '1.0.0-alpha.0', toolchainVersion: '1.0.0-alpha.0' },
}

describe('build command parser/handler', () => {
  it.each([
    ['unknown', ['--unknown']],
    ['positional', ['fixture']],
    ['missing config', ['--config']],
    ['duplicate config', ['--config=a', '--config', 'b']],
    ['duplicate watch alias', ['--watch', '-w']],
    ['boolean value', ['--watch=true']],
  ])('拒绝 %s 并退出 2', async (_name, args) => {
    const harness = commandHarness()
    expect(await runBuildCommand({ operationLockHeld: true, args, cwd: '/project', ...harness })).toBe(2)
    expect(harness.stderr.text).toContain('用法：fh2-plugin build')
    expect(harness.createRunner).not.toHaveBeenCalled()
  })

  it('help 不创建 Runner、不读取 config/Manifest', async () => {
    const harness = commandHarness()
    expect(await runBuildCommand({ operationLockHeld: true, args: ['--help'], cwd: '/project', ...harness })).toBe(0)
    expect(harness.createRunner).not.toHaveBeenCalled()
    expect(harness.stdout.text).toContain('用法：fh2-plugin build')
  })

  it.each([
    [['--config', 'config/custom.ts'], false],
    [['--config=config/custom.ts', '-w'], true],
  ] as const)('支持 config 两种形式与 watch alias', async (args, watch) => {
    const root = await pluginRoot()
    const harness = commandHarness()
    harness.createRunner.mockImplementation(async (options) => {
      options.onEvent?.({ type: 'success', buildId: 1, diagnostics: [], distManifest })
      return resolvedSession()
    })
    expect(await runBuildCommand({ operationLockHeld: true, args, cwd: root, ...harness })).toBe(0)
    expect(harness.createRunner).toHaveBeenCalledWith(expect.objectContaining({
      cwd: root,
      configPath: join(root, 'config/custom.ts'),
      watch,
    }))
    expect(harness.stdout.text).toContain('exp_command')
  })

  it('输入/构建失败退出 1，未预期 handler 异常退出 3', async () => {
    const root = await pluginRoot()
    const expected = commandHarness()
    expected.createRunner.mockResolvedValue({
      firstBuild: Promise.reject(new PluginBuildError([{
        code: 'FH2_TEST_FAILURE',
        phase: 'compile',
        message: 'expected failure',
      }])),
      done: Promise.resolve({ reason: 'closed' }),
      close: async () => {},
    })
    expect(await runBuildCommand({ operationLockHeld: true, args: [], cwd: root, ...expected })).toBe(1)
    expect(expected.stderr.text).toContain('FH2_TEST_FAILURE')

    const unexpected = commandHarness()
    unexpected.createRunner.mockRejectedValue(new Error('boom'))
    expect(await runBuildCommand({ operationLockHeld: true, args: [], cwd: root, ...unexpected })).toBe(3)
    expect(unexpected.stderr.text).toContain('内部错误：boom')
  })

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 0],
  ] as const)('%s 等待异步 close 并返回约定退出码', async (signal, exitCode) => {
    const root = await pluginRoot()
    const harness = commandHarness()
    const terminal = deferred<{ reason: 'closed' }>()
    const close = vi.fn(async () => terminal.resolve({ reason: 'closed' }))
    harness.createRunner.mockResolvedValue({
      firstBuild: Promise.resolve(),
      done: terminal.promise,
      close,
    })
    const result = runBuildCommand({ operationLockHeld: true, args: ['--watch'], cwd: root, ...harness })
    await vi.waitFor(() => expect(harness.createRunner).toHaveBeenCalled())
    harness.signals.emit(signal)
    expect(await result).toBe(exitCode)
    expect(close).toHaveBeenCalledTimes(1)
    expect(harness.signals.listenerCount(signal)).toBe(0)
  })

  it.each([
    ['SIGINT', 130, '首轮 pending'],
    ['SIGTERM', 0, '首轮 pending'],
    ['SIGINT', 130, 'session assignment 前'],
    ['SIGTERM', 0, 'session assignment 前'],
  ] as const)('%s 在%s时仍清理并返回约定退出码', async (signal, exitCode, timing) => {
    const root = await pluginRoot()
    const harness = commandHarness()
    const pending = pendingSession()
    const runner = deferred<PluginBuildSession>()
    if (timing === 'session assignment 前')
      harness.createRunner.mockImplementation(async () => runner.promise)
    else
      harness.createRunner.mockResolvedValue(pending.session)

    const result = runBuildCommand({ operationLockHeld: true, args: ['--watch'], cwd: root, ...harness })
    await vi.waitFor(() => expect(harness.signals.listenerCount(signal)).toBe(1))
    if (timing === '首轮 pending')
      await vi.waitFor(() => expect(harness.createRunner).toHaveBeenCalled())
    harness.signals.emit(signal)
    if (timing === 'session assignment 前') runner.resolve(pending.session)

    expect(await result).toBe(exitCode)
    expect(pending.close).toHaveBeenCalledTimes(1)
    expect(harness.signals.listenerCount(signal)).toBe(0)
  })

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 0],
  ] as const)('%s 遇到 session.close 拒绝仍返回信号退出码', async (signal, exitCode) => {
    const root = await pluginRoot()
    const harness = commandHarness()
    const pending = pendingSession(new Error('watcher close rejected'))
    harness.createRunner.mockResolvedValue(pending.session)
    const result = runBuildCommand({ operationLockHeld: true, args: ['--watch'], cwd: root, ...harness })
    await vi.waitFor(() => expect(harness.createRunner).toHaveBeenCalled())
    harness.signals.emit(signal)
    expect(await result).toBe(exitCode)
    expect(pending.close).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 0],
  ] as const)('普通 Build 收到 %s 也关闭 Session 并返回约定退出码', async (signal, exitCode) => {
    const root = await pluginRoot()
    const harness = commandHarness()
    const pending = pendingSession()
    harness.createRunner.mockResolvedValue(pending.session)
    const result = runBuildCommand({ operationLockHeld: true, args: [], cwd: root, ...harness })
    await vi.waitFor(() => expect(harness.createRunner).toHaveBeenCalled())
    harness.signals.emit(signal)
    expect(await result).toBe(exitCode)
    expect(pending.close).toHaveBeenCalledTimes(1)
  })

  it('首轮成功后的 Runner fatal 退出 1', async () => {
    const root = await pluginRoot()
    const harness = commandHarness()
    harness.createRunner.mockResolvedValue({
      firstBuild: Promise.resolve(),
      done: Promise.resolve({
        reason: 'fatal',
        diagnostics: [{ code: 'FH2_FATAL', phase: 'config', message: 'fatal' }],
      }),
      close: async () => {},
    })
    expect(await runBuildCommand({ operationLockHeld: true, args: ['--watch'], cwd: root, ...harness })).toBe(1)
  })

  it('capability 根聚合前后端过滤参数并走专用 Coordinator', async () => {
    const root = await capabilityRoot()
    const harness = commandHarness()
    const buildCapability = vi.fn(async () => ({ ok: true, diagnostics: [] }))

    const code = await runBuildCommand({ operationLockHeld: true, args: ['--frontend', 'exp_capability_frontend', '--backend=exp_capability_backend'], cwd: root, ...harness, buildCapability: buildCapability as typeof import('../capability/build.js').buildCapability })

    expect(code).toBe(0)
    expect(buildCapability).toHaveBeenCalledWith(expect.objectContaining({
      frontendFilter: new Set(['exp_capability_frontend']),
      backendFilter: new Set(['exp_capability_backend']),
    }))
    expect(harness.createRunner).not.toHaveBeenCalled()
    expect(harness.stdout.text).toContain('[capability exp_capability_build] build success')
  })

  it('capability 过滤单侧时另一侧显式跳过', async () => {
    const root = await capabilityRoot()
    const buildCapability = vi.fn(async () => ({ ok: true, diagnostics: [] }))

    await runBuildCommand({ operationLockHeld: true, args: ['--frontend', 'exp_capability_frontend'], cwd: root, ...commandHarness(), buildCapability: buildCapability as typeof import('../capability/build.js').buildCapability })
    expect(buildCapability).toHaveBeenLastCalledWith(expect.objectContaining({
      frontendFilter: new Set(['exp_capability_frontend']),
      backendFilter: new Set(),
    }))

    await runBuildCommand({ operationLockHeld: true, args: ['--backend', 'exp_capability_backend'], cwd: root, ...commandHarness(), buildCapability: buildCapability as typeof import('../capability/build.js').buildCapability })
    expect(buildCapability).toHaveBeenLastCalledWith(expect.objectContaining({
      frontendFilter: new Set(),
      backendFilter: new Set(['exp_capability_backend']),
    }))

    await runBuildCommand({ operationLockHeld: true, args: [], cwd: root, ...commandHarness(), buildCapability: buildCapability as typeof import('../capability/build.js').buildCapability })
    const lastCall = buildCapability.mock.calls.at(-1) as unknown as readonly [Record<string, unknown>] | undefined
    expect(lastCall).toBeDefined()
    expect(lastCall?.[0]).not.toHaveProperty('frontendFilter')
    expect(lastCall?.[0]).not.toHaveProperty('backendFilter')
  })

  it('容忍包管理器透传的裸 -- 分隔符', async () => {
    const root = await capabilityRoot()
    const harness = commandHarness()
    const buildCapability = vi.fn(async () => ({ ok: true, diagnostics: [] }))

    const code = await runBuildCommand({ operationLockHeld: true, args: ['--', '--frontend', 'exp_capability_frontend'], cwd: root, ...harness, buildCapability: buildCapability as typeof import('../capability/build.js').buildCapability })

    expect(code).toBe(0)
    expect(buildCapability).toHaveBeenCalledWith(expect.objectContaining({
      frontendFilter: new Set(['exp_capability_frontend']),
      backendFilter: new Set(),
    }))
  })

  it('capability build --watch 交给 Watch Coordinator 并响应 SIGINT', async () => {
    const root = await capabilityRoot()
    const harness = commandHarness()
    const terminal = deferred<{ readonly reason: 'closed' }>()
    const close = vi.fn(async () => {
      terminal.resolve({ reason: 'closed' })
    })
    const watchCapability = vi.fn(async () => ({
      firstBuild: Promise.resolve(),
      done: terminal.promise,
      close,
    }))

    const result = runBuildCommand({ operationLockHeld: true, args: ['--watch'], cwd: root, ...harness, watchCapability: watchCapability as typeof import('../capability/build.js').watchCapability })
    await vi.waitFor(() => expect(watchCapability).toHaveBeenCalled())
    harness.signals.emit('SIGINT')

    expect(await result).toBe(130)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('capability 根在单前端过滤时把 --config 传给 Coordinator', async () => {
    const root = await capabilityRoot()
    const harness = commandHarness()
    const buildCapability = vi.fn(async () => ({ ok: true, diagnostics: [] }))

    const code = await runBuildCommand({ operationLockHeld: true, args: ['--frontend', 'exp_capability_frontend', '--config', 'frontend.config.ts'], cwd: root, ...harness, buildCapability: buildCapability as typeof import('../capability/build.js').buildCapability })

    expect(code).toBe(0)
    expect(buildCapability).toHaveBeenCalledWith(expect.objectContaining({
      frontendConfigPath: join(root, 'frontend.config.ts'),
    }))
  })

  it('行业 Capability 工作区按清单顺序 fan-out 构建，并支持 --root', async () => {
    const root = await workspaceRoot()
    const harness = commandHarness()
    const buildIndustryCapabilityWorkspace = vi.fn(async (
      options: import('../capability/build.js').IndustryCapabilityWorkspaceBuildOptions,
    ): Promise<import('../capability/build.js').IndustryCapabilityWorkspaceBuildResult> => {
      for (const capability of options.workspace.capabilities) {
        options.onCapabilityEvent?.({ capability, type: 'start', diagnostics: [] })
        options.onCapabilityEvent?.({ capability, type: 'success', diagnostics: [] })
      }
      return {
        ok: true,
        capabilities: options.workspace.capabilities.map(capability => ({
          capability,
          result: { ok: true, diagnostics: [] },
        })),
        diagnostics: [],
      }
    })

    const code = await runBuildCommand({ operationLockHeld: true, args: ['--root', root], cwd: '/outside-workspace', ...harness, buildIndustryCapabilityWorkspace })

    expect(code).toBe(0)
    expect(buildIndustryCapabilityWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      workspace: expect.objectContaining({ root }),
    }))
    expect(harness.stdout.text).toContain('[capability exp_workspace_alpha] build started')
    expect(harness.stdout.text).toContain('✓ [capability exp_workspace_alpha] build success')
    expect(harness.stdout.text).toContain('✓ [capability exp_workspace_beta] build success')
    expect(harness.stdout.text).toContain('[workspace exp_workspace_package] build success')
  })

  it.each([
    ['--watch'],
    ['--config', 'rsbuild.config.ts'],
    ['--frontend', 'exp_workspace_alpha'],
  ])('行业 Capability 工作区拒绝未支持的 Build 参数 %s', async (...args) => {
    const root = await workspaceRoot()
    const harness = commandHarness()

    expect(await runBuildCommand({ operationLockHeld: true, args: [...args, '--root', root], cwd: '/project', ...harness })).toBe(2)
    expect(harness.stderr.text).toContain('行业 Capability 工作区')
  })

  it('目录没有任何可构建内容时明确报错，不进入 Rsbuild fallback', async () => {
    const emptyDir = await createEmptyRoot()
    const harness = commandHarness()

    expect(await runBuildCommand({ operationLockHeld: true, args: [], cwd: emptyDir, ...harness })).toBe(1)
    expect(harness.stderr.text).toContain('FH2_CONTEXT_NOT_FOUND')
    expect(harness.stderr.text).toContain('没有可构建内容')
    expect(harness.stderr.text).toContain(emptyDir)
    expect(harness.stderr.text).not.toContain('FH2_ADAPTER_COUNT_INVALID')
    expect(harness.createRunner).not.toHaveBeenCalled()
  })

  it('--root 指向无可构建内容目录时同样明确报错', async () => {
    const emptyDir = await createEmptyRoot()
    const harness = commandHarness()

    expect(await runBuildCommand({ operationLockHeld: true, args: ['--root', emptyDir], cwd: '/elsewhere', ...harness })).toBe(1)
    expect(harness.stderr.text).toContain('FH2_CONTEXT_NOT_FOUND')
    expect(harness.createRunner).not.toHaveBeenCalled()
  })

  it('裸前端插件目录仍进入通用 Rsbuild Runner', async () => {
    const root = await pluginRoot()
    const harness = commandHarness()
    harness.createRunner.mockImplementation(async (options) => {
      options.onEvent?.({ type: 'success', buildId: 1, diagnostics: [], distManifest })
      return resolvedSession()
    })

    expect(await runBuildCommand({ operationLockHeld: true, args: [], cwd: root, ...harness })).toBe(0)
    expect(harness.createRunner).toHaveBeenCalledWith(expect.objectContaining({ cwd: root }))
  })
})

async function capabilityRoot (): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'fh2-build-command-'))
  const root = join(parent, 'exp_capability_build')
  temporaryRoots.push(parent)
  await mkdir(join(root, 'frontend/exp_capability_frontend'), { recursive: true })
  await mkdir(join(root, 'backend/exp_capability_backend'), { recursive: true })
  await writeFile(join(root, 'capabilities.json'), JSON.stringify({ name: '构建命令', description: '命令测试' }))
  await writeFile(join(root, 'frontend/exp_capability_frontend/fh2-plugin.json'), JSON.stringify({ id: 'exp_capability_frontend' }))
  await writeFile(join(root, 'backend/exp_capability_backend/fh2-plugin.json'), JSON.stringify({ pluginId: 'exp_capability_backend' }))
  return root
}

/** 裸前端插件目录：只有 fh2-plugin.json（entry 标记），用于验证 legacy 通用 Runner 分发。 */
async function pluginRoot (): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'fh2-build-command-plugin-'))
  temporaryRoots.push(parent)
  const root = join(parent, 'exp_command_plugin')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({
    id: 'exp_command_plugin',
    name: '命令测试',
    version: '1.0.0',
    entry: './plugin.js',
    extensions: [],
  }))
  return root
}

async function createEmptyRoot (): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'fh2-build-command-empty-'))
  temporaryRoots.push(parent)
  return join(parent, 'empty')
}

async function workspaceRoot (): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'fh2-workspace-build-command-'))
  const root = join(parent, 'exp_workspace_root')
  temporaryRoots.push(parent)
  const capabilityIds = ['exp_workspace_alpha', 'exp_workspace_beta']
  await mkdir(root)
  await writeFile(join(root, 'packages.json'), JSON.stringify([{
    packageId: 'exp_workspace_package',
    name: 'Workspace Package',
    capabilityIds,
  }]))
  await Promise.all(capabilityIds.map(async (capabilityId) => {
    await mkdir(join(root, capabilityId), { recursive: true })
    await writeFile(join(root, capabilityId, 'capabilities.json'), JSON.stringify({
      name: capabilityId,
      description: 'workspace command test',
    }))
  }))
  return root
}

function commandHarness (): {
  readonly stdout: CaptureWriter;
  readonly stderr: CaptureWriter;
  readonly signals: FakeSignals;
  readonly createRunner: ReturnType<typeof vi.fn<(options: PluginBuildRunnerOptions) => Promise<PluginBuildSession>>>;
} {
  return {
    stdout: new CaptureWriter(),
    stderr: new CaptureWriter(),
    signals: new FakeSignals(),
    createRunner: vi.fn<(options: PluginBuildRunnerOptions) => Promise<PluginBuildSession>>(),
  }
}

function resolvedSession (): PluginBuildSession {
  return {
    firstBuild: Promise.resolve(),
    done: Promise.resolve({ reason: 'closed' }),
    close: async () => {},
  }
}

function pendingSession (closeError?: Error): {
  readonly session: PluginBuildSession;
  readonly close: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  const first = deferred<void>()
  const done = deferred<{ reason: 'closed' }>()
  const close = vi.fn(async () => {
    first.reject(new PluginBuildError([{
      code: 'FH2_BUILD_CLOSED_BEFORE_FIRST_BUILD',
      phase: 'config',
      message: 'closed',
    }]))
    done.resolve({ reason: 'closed' })
    if (closeError !== undefined) throw closeError
  })
  return {
    session: { firstBuild: first.promise, done: done.promise, close },
    close,
  }
}

class CaptureWriter {
  text = ''

  write (chunk: string): boolean {
    this.text += chunk
    return true
  }
}

class FakeSignals implements BuildSignalSource {
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

  listenerCount (signal: 'SIGINT' | 'SIGTERM'): number {
    return this.listeners.get(signal)?.size ?? 0
  }
}

function deferred<T> (): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason?: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}
