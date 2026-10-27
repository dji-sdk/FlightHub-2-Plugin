// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginManifest } from 'fh2-plugin-sdk'
import { PluginBuildError } from '../build/types.js'
import type { PluginBuildRunnerOptions, PluginBuildSession } from '../build/types.js'
import type { CapabilityProject } from '../capability/types.js'
import type { DevGateway, ProxyGatewayOptions } from '../dev/gateway.js'
import type { DevBuildEvent, DevStaticServer, DevStaticServerOptions } from '../dev/static-server.js'
import { parseDevArguments, runDevCommand } from './dev-command.js'
import type { DevSignalSource } from './dev-command.js'

const distManifest: PluginManifest = {
  manifestVersion: 1,
  id: 'exp_dev_command',
  name: 'Dev 命令测试',
  version: '1.0.0',
  engines: { platform: '>=1.0.0-alpha.0 <2.0.0' },
  entry: './plugin.hash.js',
  extensions: [],
  buildInfo: { sdkVersion: '1.0.0-alpha.0', toolchainVersion: '1.0.0-alpha.0' },
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('dev command parser', () => {
  it.each([
    [[], true],
    [['--watch'], true],
    [['-w'], true],
    [['--no-watch'], false],
  ] as const)('解析 watch 模式 %j', (args, watch) => {
    expect(parseDevArguments(args, '/command/cwd')).toMatchObject({ watch, port: 5175, workbenchMode: 'all' })
  })

  it('只允许 dev 的首个位置参数选择 Cockpit Workbench', () => {
    expect(parseDevArguments(['cockpit'], '/command/cwd')).toMatchObject({
      workbenchMode: 'cockpit',
      port: 5176,
    })
    expect(parseDevArguments(['cockpit', '--port', '5180'], '/command/cwd')).toMatchObject({
      workbenchMode: 'cockpit',
      port: 5180,
    })
    expect(() => parseDevArguments(['--port', '5180', 'cockpit'], '/command/cwd')).toThrow('不允许位置参数')
    expect(() => parseDevArguments(['plan'], '/command/cwd')).toThrow('不允许位置参数')
  })

  it('支持全部值参数的分离和 assignment 形式，并遵守路径根规则', () => {
    expect(parseDevArguments([
      '--manifest=plugin/fh2-plugin.json',
      '--config',
      'configs/rsbuild.ts',
      '--port=65535',
      '--gateway-target',
      'https://backend.example.com',
      '--plugins-dir=fixtures/plugins',
    ], '/command/cwd')).toEqual({
      workbenchMode: 'all',
      manifestPath: join('/command/cwd', 'plugin/fh2-plugin.json'),
      manifestExplicit: true,
      projectRoot: join('/command/cwd', 'plugin'),
      configPath: join('/command/cwd', 'configs/rsbuild.ts'),
      pluginsDir: [join('/command/cwd', 'fixtures/plugins')],
      port: 65535,
      watch: true,
      frontendOnly: false,
      pluginsDirExplicit: true,
      help: false,
      gatewayTarget: 'https://backend.example.com',
    })

    expect(parseDevArguments(['--manifest', 'plugin/fh2-plugin.json'], '/command/cwd').pluginsDir)
      .toEqual([join('/command/cwd', 'plugin/dist')])
  })

  it('支持全栈工程显式只运行前端', () => {
    expect(parseDevArguments(['cockpit', '--frontend-only'], '/command/cwd')).toMatchObject({
      workbenchMode: 'cockpit',
      frontendOnly: true,
      port: 5176,
    })
  })

  it('解析 Capability 过滤与 backend-only 参数', () => {
    expect(parseDevArguments([
      '--frontend',
      'exp_alpha',
      '--frontend=exp_beta',
      '--backend',
      'exp_server',
      '--backend-only',
      '--root',
      'capability',
    ], '/command/cwd')).toMatchObject({
      frontend: ['exp_alpha', 'exp_beta'],
      backend: ['exp_server'],
      backendOnly: true,
      root: join('/command/cwd', 'capability'),
    })
  })

  it.each([
    ['unknown', ['--unknown']],
    ['positional', ['fixture']],
    ['missing value', ['--manifest']],
    ['duplicate value', ['--port=1', '--port', '2']],
    ['duplicate alias', ['--watch', '-w']],
    ['watch conflict', ['--watch', '--no-watch']],
    ['boolean assignment', ['--no-watch=true']],
    ['zero port', ['--port', '0']],
    ['large port', ['--port', '65536']],
    ['decimal port', ['--port', '1.5']],
  ])('拒绝 %s', (_name, args) => {
    expect(() => parseDevArguments(args, '/project')).toThrow()
  })
})

describe('dev command lifecycle', () => {
  it.each([false, true])('行业 Pack 根拒绝前端 fallback 并给出真实目录指引（--root=%s）', async (explicitRoot) => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-industry-dev-'))
    temporaryRoots.push(root)
    const packRoot = join(root, 'industry')
    await mkdir(join(packRoot, 'exp_dev_capability/frontend/exp_frontend'), { recursive: true })
    await mkdir(join(packRoot, 'exp_dev_capability/backend/exp_backend'), { recursive: true })
    await writeFile(join(packRoot, 'packages.json'), JSON.stringify([{ packageId: 'industry', name: 'Industry', capabilityIds: ['exp_dev_capability'] }]))
    await writeFile(join(packRoot, 'exp_dev_capability/capabilities.json'), JSON.stringify({ name: 'Capability', description: 'fixture' }))
    await writeFile(join(packRoot, 'exp_dev_capability/frontend/exp_frontend/fh2-plugin.json'), JSON.stringify({ id: 'exp_frontend', entry: './plugin.js' }))
    await writeFile(join(packRoot, 'exp_dev_capability/backend/exp_backend/fh2-plugin.json'), JSON.stringify({ pluginId: 'exp_backend', flows: [] }))
    const harness = commandHarness()
    harness.createRunner.mockRejectedValue(new Error('industry Pack must not fall back to frontend build'))
    const resolveWorkbench = vi.fn(harness.resolveWorkbench)
    const runCapabilityDev = vi.fn(async () => 0)
    const runBackendPluginDev = vi.fn(async () => 0)

    expect(await runDevCommand({ args: explicitRoot ? ['--root', 'industry'] : [], cwd: explicitRoot ? root : packRoot, operationLockHeld: true, ...harness, resolveWorkbench, runCapabilityDev, runBackendPluginDev })).toBe(2)
    expect(harness.stderr.text).toContain('dev 不支持在行业 Capability 工作区根执行')
    expect(harness.stderr.text).toContain('<capability-id>/frontend/<plugin-id>')
    expect(harness.stderr.text).toContain('<capability-id>/backend/<plugin-id>')
    expect(harness.stderr.text).toContain('capabilities.json')
    expect(harness.stderr.text).toContain('--root')
    expect(harness.stderr.text).not.toContain('packages/<plugin>')
    expect(resolveWorkbench).not.toHaveBeenCalled()
    expect(harness.createRunner).not.toHaveBeenCalled()
    expect(harness.serve).not.toHaveBeenCalled()
    expect(runCapabilityDev).not.toHaveBeenCalled()
    expect(runBackendPluginDev).not.toHaveBeenCalled()
  })

  it('后端 Dev 委派透传 forceExit，保持 SIGTERM/SIGINT 的强退策略', async () => {
    const harness = commandHarness()
    const forceExit = vi.fn()
    const runBackendPluginDev = vi.fn(async () => 0)

    expect(await runDevCommand({ args: [], cwd: '/backend', operationLockHeld: true, ...harness, forceExit, resolveContext: () => ({ kind: 'backend-plugin', root: '/backend', manifestPath: '/backend/fh2-plugin.json' }), runBackendPluginDev })).toBe(0)
    expect(runBackendPluginDev).toHaveBeenCalledWith(expect.objectContaining({ pluginRoot: '/backend', signals: harness.signals, forceExit }))
    expect(harness.createRunner).not.toHaveBeenCalled()
  })

  it('help 退出 0 且不读取环境或创建 Runner', async () => {
    const harness = commandHarness()
    const env = new Proxy({ FH2_DEV_LOGIN_TOKEN: 'secret' }, {
      get () {
        throw new Error('env should not be read')
      },
    })
    expect(await runDevCommand({ args: ['--help'], cwd: '/project', env, operationLockHeld: true, ...harness })).toBe(0)
    expect(harness.createRunner).not.toHaveBeenCalled()
    expect(harness.stdout.text).toContain('用法：fh2-plugin dev')
  })

  it('参数错误退出 2，不创建 Runner', async () => {
    const harness = commandHarness()
    expect(await runDevCommand({ args: ['--port', 'x'], cwd: '/project', operationLockHeld: true, ...harness })).toBe(2)
    expect(harness.createRunner).not.toHaveBeenCalled()
  })

  it('传入 Manifest 项目根、cwd 相对 config、expectedManifestPath 和默认 watch', async () => {
    const harness = commandHarness()
    const running = controllableSession()
    harness.createRunner.mockImplementation(async (runnerOptions) => {
      runnerOptions.onEvent?.({ type: 'success', buildId: 1, diagnostics: [], distManifest })
      return running.session
    })
    const result = runDevCommand({
      args: ['--manifest=plugins/demo/fh2-plugin.json', '--config=configs/custom.ts'],
      cwd: '/repo',
      operationLockHeld: true,
      ...harness,
    })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())
    expect(harness.createRunner).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo/plugins/demo',
      configPath: '/repo/configs/custom.ts',
      expectedManifestPath: '/repo/plugins/demo/fh2-plugin.json',
      includeBackend: true,
      watch: true,
    }))
    expect(harness.serve).toHaveBeenCalledWith(expect.objectContaining({
      pluginsDir: ['/repo/plugins/demo/dist'],
      workbenchMode: 'all',
      watch: true,
    }))
    harness.signals.emit('SIGTERM')
    expect(await result).toBe(0)
  })

  it('--frontend-only 跳过后端构建并向 Workbench 暴露前端模式', async () => {
    const harness = commandHarness()
    const running = controllableSession()
    harness.createRunner.mockResolvedValue(running.session)
    const result = runDevCommand({ args: ['--frontend-only'], cwd: '/project', operationLockHeld: true, ...harness })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())
    expect(harness.createRunner).toHaveBeenCalledWith(expect.objectContaining({ includeBackend: false }))
    expect(harness.serve).toHaveBeenCalledWith(expect.objectContaining({ backendMode: 'frontend' }))
    harness.signals.emit('SIGTERM')
    expect(await result).toBe(0)
  })

  it('把 cockpit profile 传给 Dev Server', async () => {
    const harness = commandHarness()
    const running = controllableSession()
    harness.createRunner.mockResolvedValue(running.session)
    const result = runDevCommand({ args: ['cockpit'], cwd: '/project', operationLockHeld: true, ...harness })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())
    expect(harness.serve).toHaveBeenCalledWith(expect.objectContaining({ workbenchMode: 'cockpit' }))
    harness.signals.emit('SIGTERM')
    expect(await result).toBe(0)
  })

  it('--no-watch 仍先构建一次再服务，且不发送首轮 reload', async () => {
    const harness = commandHarness()
    const running = controllableSession()
    harness.createRunner.mockImplementation(async (runnerOptions) => {
      runnerOptions.onEvent?.({ type: 'success', buildId: 1, diagnostics: [], distManifest })
      return running.session
    })
    const result = runDevCommand({ args: ['--no-watch'], cwd: '/project', operationLockHeld: true, ...harness })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())
    expect(harness.createRunner).toHaveBeenCalledWith(expect.objectContaining({ watch: false }))
    expect(harness.serve).toHaveBeenCalledWith(expect.objectContaining({ watch: false }))
    expect(harness.server.events).toEqual([])
    harness.signals.emit('SIGTERM')
    expect(await result).toBe(0)
  })

  it('首轮构建完成前不启动 Server', async () => {
    const harness = commandHarness()
    const firstBuild = deferred<void>()
    const running = controllableSession()
    harness.createRunner.mockResolvedValue({ ...running.session, firstBuild: firstBuild.promise })
    const result = runDevCommand({ args: [], cwd: '/project', operationLockHeld: true, ...harness })
    await vi.waitFor(() => expect(harness.createRunner).toHaveBeenCalled())
    expect(harness.serve).not.toHaveBeenCalled()
    firstBuild.resolve()
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())
    harness.signals.emit('SIGTERM')
    expect(await result).toBe(0)
  })

  it('server 启动后才转发后续 success/failure，恢复成功继续 reload', async () => {
    const harness = commandHarness()
    const running = controllableSession()
    let runnerOptions: PluginBuildRunnerOptions | undefined
    harness.createRunner.mockImplementation(async (options) => {
      runnerOptions = options
      options.onEvent?.({ type: 'success', buildId: 1, diagnostics: [], distManifest })
      return running.session
    })
    const result = runDevCommand({ args: [], cwd: '/project', operationLockHeld: true, ...harness })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())
    runnerOptions?.onEvent?.({
      type: 'failure',
      buildId: 2,
      diagnostics: [{ code: 'FH2_COMPILE', phase: 'compile', message: '/project/src failed\nsecret detail' }],
    })
    runnerOptions?.onEvent?.({ type: 'success', buildId: 3, diagnostics: [], distManifest })
    expect(harness.server.events).toEqual([
      { schemaVersion: 1, type: 'error', buildId: 2, diagnosticCode: 'FH2_COMPILE' },
      { schemaVersion: 1, type: 'reload', buildId: 3 },
    ])
    expect(JSON.stringify(harness.server.events[0])).not.toContain('/project')
    expect(JSON.stringify(harness.server.events[0])).not.toContain('secret detail')
    expect(harness.stderr.text).toContain('/project/src failed')
    harness.signals.emit('SIGTERM')
    expect(await result).toBe(0)
  })

  it('proxy 启动前捕获并删除 Token，且 config 加载阶段不可再读取', async () => {
    const harness = commandHarness()
    const running = controllableSession()
    const env: NodeJS.ProcessEnv = { FH2_DEV_LOGIN_TOKEN: 'login-secret' }
    harness.createRunner.mockImplementation(async (runnerOptions) => {
      expect(env.FH2_DEV_LOGIN_TOKEN).toBeUndefined()
      runnerOptions.onEvent?.({ type: 'success', buildId: 1, diagnostics: [], distManifest })
      return running.session
    })
    const createProxy = vi.fn((_proxyOptions: ProxyGatewayOptions): DevGateway => fakeGateway('proxy'))
    const result = runDevCommand({
      args: ['--gateway-target=http://127.0.0.1:9000'],
      cwd: '/project',
      env,
      createProxy,
      operationLockHeld: true,
      ...harness,
    })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())
    expect(createProxy).toHaveBeenCalledWith(expect.objectContaining({ loginToken: 'login-secret' }))
    expect(env.FH2_DEV_LOGIN_TOKEN).toBeUndefined()
    expect(harness.serve).toHaveBeenCalledWith(expect.objectContaining({
      gateway: expect.objectContaining({ apiMode: 'proxy' }),
    }))
    harness.signals.emit('SIGTERM')
    expect(await result).toBe(0)
  })

  it('mock 模式也在加载 config 前删除并丢弃登录 Token', async () => {
    const harness = commandHarness()
    const running = controllableSession()
    const env: NodeJS.ProcessEnv = { FH2_DEV_LOGIN_TOKEN: 'unused-login-secret' }
    const createProxy = vi.fn((_proxyOptions: ProxyGatewayOptions): DevGateway => fakeGateway('proxy'))
    harness.createRunner.mockImplementation(async () => {
      expect(env.FH2_DEV_LOGIN_TOKEN).toBeUndefined()
      return running.session
    })
    const result = runDevCommand({ args: [], cwd: '/project', env, createProxy, operationLockHeld: true, ...harness })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())
    expect(env.FH2_DEV_LOGIN_TOKEN).toBeUndefined()
    expect(createProxy).not.toHaveBeenCalled()
    expect(harness.serve).toHaveBeenCalledWith(expect.not.objectContaining({ gateway: expect.anything() }))
    harness.signals.emit('SIGTERM')
    expect(await result).toBe(0)
  })

  it('非法 proxy target 也先删除登录 Token', async () => {
    const harness = commandHarness()
    const env: NodeJS.ProcessEnv = { FH2_DEV_LOGIN_TOKEN: 'unused-login-secret' }
    expect(await runDevCommand({
      args: ['--gateway-target=http://backend.example.com'],
      cwd: '/project',
      env,
      operationLockHeld: true,
      ...harness,
    })).toBe(1)
    expect(env.FH2_DEV_LOGIN_TOKEN).toBeUndefined()
    expect(harness.createRunner).not.toHaveBeenCalled()
  })

  it.each([
    [['--gateway-target=http://backend.example.com'], { FH2_DEV_LOGIN_TOKEN: 'secret' }],
    [['--gateway-target=https://backend.example.com'], {}],
  ] as const)('非法代理配置退出 1 且不加载用户 config', async (args, env) => {
    const harness = commandHarness()
    expect(await runDevCommand({ args, cwd: '/project', env: { ...env }, operationLockHeld: true, ...harness })).toBe(1)
    expect(harness.createRunner).not.toHaveBeenCalled()
  })

  it('首次 Build 失败退出 1，不启动 Server，并关闭 Session', async () => {
    const harness = commandHarness()
    const error = new PluginBuildError([{ code: 'FH2_INITIAL', phase: 'compile', message: 'initial failed' }])
    const close = vi.fn(async () => {})
    harness.createRunner.mockResolvedValue({
      firstBuild: Promise.reject(error),
      done: Promise.resolve({ reason: 'closed' }),
      close,
    })
    expect(await runDevCommand({ args: [], cwd: '/project', operationLockHeld: true, ...harness })).toBe(1)
    expect(harness.serve).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('server 启动失败回滚 Build Session 并退出 1', async () => {
    const harness = commandHarness()
    const running = controllableSession()
    harness.createRunner.mockResolvedValue(running.session)
    harness.serve.mockRejectedValue(new Error('listen failed'))
    expect(await runDevCommand({ args: [], cwd: '/project', operationLockHeld: true, ...harness })).toBe(1)
    expect(running.close).toHaveBeenCalledOnce()
  })

  it('首轮成功后的 session fatal 关闭 Server 并退出 1', async () => {
    const harness = commandHarness()
    const running = controllableSession()
    harness.createRunner.mockResolvedValue(running.session)
    const result = runDevCommand({ args: [], cwd: '/project', operationLockHeld: true, ...harness })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())
    running.done.resolve({
      reason: 'fatal',
      diagnostics: [{ code: 'FH2_FATAL', phase: 'config', message: 'watch fatal' }],
    })
    expect(await result).toBe(1)
    expect(harness.server.close).toHaveBeenCalledOnce()
  })

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 0],
  ] as const)('%s 等待异步幂等 shutdown 并返回约定退出码', async (signal, exitCode) => {
    const harness = commandHarness()
    const running = controllableSession()
    const closeGate = deferred<void>()
    running.close.mockImplementation(async () => {
      await closeGate.promise
      running.done.resolve({ reason: 'closed' })
    })
    harness.createRunner.mockResolvedValue(running.session)
    const result = runDevCommand({ args: [], cwd: '/project', operationLockHeld: true, ...harness })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())
    harness.signals.emit(signal)
    await Promise.resolve()
    expect(harness.server.close).not.toHaveBeenCalled()
    closeGate.resolve()
    expect(await result).toBe(exitCode)
    expect(running.close).toHaveBeenCalledOnce()
    expect(harness.server.close).toHaveBeenCalledOnce()
    expect(harness.signals.listenerCount(signal)).toBe(0)
  })

  it('runner assignment 前收到 SIGINT，assignment 后立即关闭且不启动 Server', async () => {
    const harness = commandHarness()
    const runner = deferred<PluginBuildSession>()
    const running = controllableSession()
    harness.createRunner.mockImplementation(async () => runner.promise)
    const result = runDevCommand({ args: [], cwd: '/project', operationLockHeld: true, ...harness })
    await vi.waitFor(() => expect(harness.signals.listenerCount('SIGINT')).toBe(1))
    harness.signals.emit('SIGINT')
    runner.resolve(running.session)
    expect(await result).toBe(130)
    expect(running.close).toHaveBeenCalledOnce()
    expect(harness.serve).not.toHaveBeenCalled()
  })

  it('第二次信号调用强制退出注入，不重复创建 shutdown', async () => {
    const harness = commandHarness()
    const running = controllableSession()
    const closeGate = deferred<void>()
    running.close.mockImplementation(async () => closeGate.promise)
    harness.createRunner.mockResolvedValue(running.session)
    const forceExit = vi.fn()
    const result = runDevCommand({ args: [], cwd: '/project', forceExit, operationLockHeld: true, ...harness })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())
    harness.signals.emit('SIGINT')
    harness.signals.emit('SIGINT')
    expect(forceExit).toHaveBeenCalledWith(130)
    closeGate.resolve()
    running.done.resolve({ reason: 'closed' })
    expect(await result).toBe(130)
    expect(running.close).toHaveBeenCalledOnce()
  })

  it('未预期 Runner 异常退出 3', async () => {
    const harness = commandHarness()
    harness.createRunner.mockRejectedValue(new Error('internal'))
    expect(await runDevCommand({ args: [], cwd: '/project', operationLockHeld: true, ...harness })).toBe(3)
  })

  it('capability 根委派给 Capability Dev Coordinator', async () => {
    const harness = commandHarness()
    const capability = capabilityFixture()
    const runCapabilityDev = vi.fn(async () => 0)

    const code = await runDevCommand({
      args: [],
      cwd: '/capability',
      operationLockHeld: true,
      ...harness,
      resolveContext: () => capability,
      runCapabilityDev: runCapabilityDev as typeof import('../capability/dev.js').runCapabilityDev,
    })

    expect(code).toBe(0)
    expect(runCapabilityDev).toHaveBeenCalledWith(expect.objectContaining({ capability }))
    expect(harness.createRunner).not.toHaveBeenCalled()
  })

  it('capability 根显式 --manifest 时只启动指定前端插件', async () => {
    const harness = commandHarness()
    const running = controllableSession()
    harness.createRunner.mockResolvedValue(running.session)
    const capability = capabilityFixture()
    const frontendRoot = '/capability/frontend/exp_frontend'
    const resolveContext = vi.fn((root: string) => root === frontendRoot
      ? { kind: 'frontend-plugin' as const, root: frontendRoot, manifestPath: `${frontendRoot}/fh2-plugin.json` }
      : capability)
    const runCapabilityDev = vi.fn(async () => 0)

    const result = runDevCommand({
      args: ['--manifest', 'frontend/exp_frontend/fh2-plugin.json'],
      cwd: '/capability',
      operationLockHeld: true,
      ...harness,
      resolveContext: resolveContext as typeof import('../capability/discovery.js').tryDiscoverCommandContext,
      runCapabilityDev: runCapabilityDev as typeof import('../capability/dev.js').runCapabilityDev,
    })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())

    expect(resolveContext).toHaveBeenCalledWith(frontendRoot)
    expect(runCapabilityDev).not.toHaveBeenCalled()
    expect(harness.createRunner).toHaveBeenCalledWith(expect.objectContaining({ cwd: frontendRoot }))
    harness.signals.emit('SIGTERM')
    expect(await result).toBe(0)
  })
})

function capabilityFixture (): CapabilityProject {
  return {
    kind: 'capability-project',
    root: '/capability',
    capabilityId: 'exp_capability',
    metadataPath: '/capability/capabilities.json',
    metadata: { name: 'Capability', description: '测试' },
    frontend: [{ id: 'exp_frontend', root: '/capability/frontend/exp_frontend', manifestPath: '/capability/frontend/exp_frontend/fh2-plugin.json' }],
    backend: [{ id: 'exp_backend', root: '/capability/backend/exp_backend', manifestPath: '/capability/backend/exp_backend/plugin.json' }],
  }
}

function commandHarness (): {
  readonly stdout: CaptureWriter;
  readonly stderr: CaptureWriter;
  readonly signals: FakeSignals;
  readonly createRunner: ReturnType<typeof vi.fn<(options: PluginBuildRunnerOptions) => Promise<PluginBuildSession>>>;
  readonly serve: ReturnType<typeof vi.fn<(options: DevStaticServerOptions) => Promise<DevStaticServer>>>;
  readonly server: FakeServer;
  readonly resolveWorkbench: () => { shell: string; vue3: string; vue2: string };
} {
  const server = new FakeServer()
  return {
    stdout: new CaptureWriter(),
    stderr: new CaptureWriter(),
    signals: new FakeSignals(),
    createRunner: vi.fn<(options: PluginBuildRunnerOptions) => Promise<PluginBuildSession>>(),
    serve: vi.fn(async () => server),
    server,
    resolveWorkbench: () => ({ shell: '/workbench/shell', vue3: '/workbench/vue3', vue2: '/workbench/vue2' }),
  }
}

function controllableSession (): {
  readonly session: PluginBuildSession;
  readonly close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly done: ReturnType<typeof deferred<
    | { readonly reason: 'closed' }
    | { readonly reason: 'fatal'; readonly diagnostics: readonly [{ code: string; phase: 'config'; message: string }] }
  >>;
} {
  const done = deferred<
    | { readonly reason: 'closed' }
    | { readonly reason: 'fatal'; readonly diagnostics: readonly [{ code: string; phase: 'config'; message: string }] }
  >()
  const close = vi.fn(async () => done.resolve({ reason: 'closed' }))
  return {
    session: { firstBuild: Promise.resolve(), done: done.promise, close },
    close,
    done,
  }
}

class FakeServer implements DevStaticServer {
  readonly url = 'http://127.0.0.1:5175'
  readonly apiMode = 'mock' as const
  readonly events: DevBuildEvent[] = []
  readonly close = vi.fn(async () => {})

  publishBuildEvent (event: DevBuildEvent): void {
    this.events.push(event)
  }
}

function fakeGateway (apiMode: 'mock' | 'proxy'): DevGateway {
  const close = vi.fn(async () => {})
  return {
    apiMode,
    handle: async () => false,
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

class FakeSignals implements DevSignalSource {
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
} {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}
