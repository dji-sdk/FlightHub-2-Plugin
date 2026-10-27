// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginManifest } from 'fh2-plugin-sdk'
import type { PluginBuildRunnerOptions, PluginBuildSession } from '../build/types.js'
import { PluginBuildError } from '../build/types.js'
import type { PreviewStaticServer, PreviewStaticServerOptions } from '../preview/static-server.js'
import { previewProject } from '../services/application/preview.js'
import {
  PREVIEW_CLI_METADATA,
  PREVIEW_HELP,
  parsePreviewArguments,
  resolvePreviewTarget,
  runPreviewCommand,
  withPluginDebugQuery,
} from './preview-command.js'
import type { PreviewSignalSource } from './preview-command.js'

const manifest: PluginManifest = {
  id: 'exp_preview',
  name: 'Preview',
  version: '1.0.0',
  entry: './plugin.js',
  extensions: [],
}
const temporaryRoots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('preview HTTP-only regression', () => {
  it.each([
    ['--local-protocol=auto'],
    ['--local-protocol=http'],
    ['--local-protocol=https'],
    ['--cert=local.pem', '--key=local-key.pem'],
  ])('拒绝已撤销的 TLS/协议参数 %j', (...args) => {
    expect(() => parsePreviewArguments(args, '/repo')).toThrow('未知参数')
  })

  it.each([undefined, '/unused-key.pem'])('不消费遗留证书环境变量 key=%s', (key) => {
    vi.stubEnv('FH2_PLUGIN_PREVIEW_CERT', '/unused-cert.pem')
    vi.stubEnv('FH2_PLUGIN_PREVIEW_KEY', key)
    const parsed = parsePreviewArguments([], '/repo')
    expect(parsed).not.toHaveProperty('localProtocol')
    expect(parsed).not.toHaveProperty('certPath')
    expect(parsed).not.toHaveProperty('keyPath')
  })

  it('帮助不发布 TLS 参数，HTTP PAC 手填指南仍明确属于人工说明', () => {
    expect(PREVIEW_HELP).toContain('完整 HTTP URL')
    expect(PREVIEW_HELP).not.toMatch(/--local-protocol|--cert|--key|FH2_PLUGIN_PREVIEW_(?:CERT|KEY)/)
    expect(PREVIEW_CLI_METADATA.behaviorKind).toBe('manual-description')
    expect(PREVIEW_CLI_METADATA.notes?.join('\n')).toMatch(/HTTP.*PAC.*手动/)
  })

  it('https 目标明确拒绝，不引导证书安装或协议降级', () => {
    expect(() => resolvePreviewTarget('https://fh2.example/project')).toThrow('Preview 仅支持完整 HTTP URL，不支持 HTTPS 目标')
  })

  it('面板地址删除所有旧来源/session query，保留其他参数、路径与 hash', () => {
    const target = new URL('http://fh2.example:8080/project?org=1&fh2-plugin-preview-source=old&x=1&fh2-plugin-preview-session=old&fh2-plugin-preview-source=other&x=2&fh2-plugin-debug=0#/cockpit')
    const original = target.href
    expect(withPluginDebugQuery(target).href).toBe('http://fh2.example:8080/project?org=1&x=1&x=2&fh2-plugin-debug=1#/cockpit')
    expect(target.href).toBe(original)
  })

  it('https 命令在构建和代理启动前失败', async () => {
    const harness = commandHarness()
    expect(await runPreviewCommand({
      args: ['--fh2-url=https://fh2.example/project'],
      cwd: '/project',
      operationLockHeld: true,
      ...harness,
    })).toBe(2)
    expect(harness.stderr.text).toContain('Preview 仅支持完整 HTTP URL，不支持 HTTPS 目标')
    expect(harness.stderr.text).not.toMatch(/证书|mkcert|降级/)
    expect(harness.createRunner).not.toHaveBeenCalled()
    expect(harness.serve).not.toHaveBeenCalled()
    expect(harness.openBrowser).not.toHaveBeenCalled()
  })

  it('--no-open 仍打印 HTTP PAC、仅 debug 面板地址与完整手填来源流程', async () => {
    const harness = commandHarness()
    const server: PreviewStaticServer = {
      url: 'http://127.0.0.1:4317',
      sourceUrl: 'http://fh2.example:8080/.fh2-plugin-preview/0123456789abcdef0123456789abcdef/plugins',
      sessionToken: '0123456789abcdef0123456789abcdef',
      pacUrl: 'http://127.0.0.1:4317/proxy.pac?session=0123456789abcdef0123456789abcdef',
      close: vi.fn(async () => {}),
    }
    harness.serve.mockResolvedValue(server)
    const onReady = vi.fn()
    const result = runPreviewCommand({
      args: ['--fh2-url=http://fh2.example:8080/project?org=1&fh2-plugin-preview-source=old&fh2-plugin-preview-session=old#/team', '--no-open'],
      cwd: '/project',
      operationLockHeld: true,
      onReady,
      ...harness,
    })
    await vi.waitFor(() => expect(onReady).toHaveBeenCalled())
    try {
      expect(harness.serve).toHaveBeenCalledWith({
        plugins: [{ pluginId: manifest.id, pluginsDir: '/project/dist' }],
        targetOrigin: 'http://fh2.example:8080',
        port: 4317,
      })
      expect(harness.openBrowser).not.toHaveBeenCalled()
      expect(onReady).toHaveBeenCalledWith('http://fh2.example:8080/project?org=1&fh2-plugin-debug=1#/team')
      expect(harness.stdout.text).toContain('本地前端构建和 HTTP Origin Proxy 已就绪')
      expect(harness.stdout.text).toContain('调试面板地址：http://fh2.example:8080/project?org=1&fh2-plugin-debug=1#/team')
      expect(harness.stdout.text).toContain(`请手动填写的插件来源URL：${server.sourceUrl}`)
      expect(harness.stdout.text).toMatch(/1\. .*PAC[\s\S]*2\. .*同一 Origin.*登录.*项目[\s\S]*3\. .*调试面板地址[\s\S]*4\. .*手动.*插件来源URL[\s\S]*5\. .*校验.*勾选.*同意.*确认.*重载/)
      expect(harness.stdout.text).not.toMatch(/fh2-plugin-preview-source|fh2-plugin-preview-session|\.js|fh2-plugin\.json|证书|预览已就绪|已加载/)
    } finally {
      harness.signals.emit('SIGTERM')
      expect(await result).toBe(0)
    }
  })
})

describe('preview command parser', () => {
  it('解析真实司空 HTTP 地址和前端构建选项', () => {
    const cwd = resolve('repo')
    expect(parsePreviewArguments([
      '--manifest=plugin/fh2-plugin.json',
      '--config',
      'configs/rsbuild.ts',
      '--fh2-url',
      'http://fh2.example/project?org=1',
      '--port=4318',
      '--no-watch',
      '--no-open',
    ], cwd)).toEqual({
      projects: [{
        manifestPath: resolve(cwd, 'plugin/fh2-plugin.json'),
        projectRoot: resolve(cwd, 'plugin'),
        pluginsDir: resolve(cwd, 'plugin/dist'),
        configPath: resolve(cwd, 'configs/rsbuild.ts'),
      }],
      fh2Url: 'http://fh2.example/project?org=1',
      port: 4318,
      watch: false,
      noOpen: true,
      help: false,
    })
  })

  it.each([
    [['--port', '0']],
    [['--port', '443']],
    [['--watch', '--no-watch']],
    [['--cert', 'local.pem']],
    [['--key', 'local-key.pem']],
    [['--local-protocol', 'tcp']],
    [['--unknown']],
  ])('拒绝非法参数 %j', (args) => {
    expect(() => parsePreviewArguments(args, '/repo')).toThrow()
  })

  it('默认开启 watch 和浏览器，保持 HTTP 代理默认端口', () => {
    expect(parsePreviewArguments([], '/repo')).toEqual({
      projects: [{ manifestPath: '/repo/fh2-plugin.json', projectRoot: '/repo', pluginsDir: '/repo/dist' }],
      port: 4317,
      watch: true,
      noOpen: false,
      help: false,
    })
  })

  it('支持重复 --plugin 并保持声明顺序', () => {
    const cwd = resolve('repo')
    expect(parsePreviewArguments([
      '--plugin',
      'plugins/alpha',
      '--plugin=plugins/beta',
    ], cwd).projects).toEqual([
      {
        manifestPath: resolve(cwd, 'plugins/alpha/fh2-plugin.json'),
        projectRoot: resolve(cwd, 'plugins/alpha'),
        pluginsDir: resolve(cwd, 'plugins/alpha/dist'),
      },
      {
        manifestPath: resolve(cwd, 'plugins/beta/fh2-plugin.json'),
        projectRoot: resolve(cwd, 'plugins/beta'),
        pluginsDir: resolve(cwd, 'plugins/beta/dist'),
      },
    ])
  })

  it('多插件模式拒绝同时指定 --manifest 或 --config', () => {
    expect(() => parsePreviewArguments(['--plugin', 'alpha', '--manifest', 'plugin.json'], '/repo'))
      .toThrow('不能与 --manifest')
  })

  it('--plugin accepts flag-looking paths only in the equals form', () => {
    expect(parsePreviewArguments(['--plugin=--example'], '/repo').projects).toEqual([{
      manifestPath: '/repo/--example/fh2-plugin.json',
      projectRoot: '/repo/--example',
      pluginsDir: '/repo/--example/dist',
    }])
    expect(() => parsePreviewArguments(['--plugin', '--example'], '/repo')).toThrow('缺少值')
  })
})

describe('preview target', () => {
  it('保留原 URL 参数和 hash，只追加固定调试 query', () => {
    const target = resolvePreviewTarget('http://fh2.example/project?org=1#/cockpit')
    expect(withPluginDebugQuery(target).href)
      .toBe('http://fh2.example/project?org=1&fh2-plugin-debug=1#/cockpit')
  })

  it('空来源/session query 也删除，重复处理面板 URL 保持稳定', () => {
    const target = resolvePreviewTarget('http://fh2-preview.example.com/project?fh2-plugin-preview-source=&fh2-plugin-preview-session=')
    const panel = withPluginDebugQuery(target)
    expect(panel.href).toBe('http://fh2-preview.example.com/project?fh2-plugin-debug=1')
    expect(withPluginDebugQuery(panel).href).toBe(panel.href)
  })

  it.each([
    'javascript:alert(1)',
    'file:///tmp/index.html',
    'http://user:pass@fh2.example/',
    'http:fh2.example/project',
    'http:/fh2.example/project',
    'http:///fh2.example/project',
    '//fh2.example/project',
    'not-a-url',
  ])('拒绝危险地址 %s', (value) => {
    expect(() => resolvePreviewTarget(value)).toThrow()
  })
})

describe('preview command lifecycle', () => {
  it.each(['cwd', 'root', 'manifest', 'plugins-first', 'plugins-last'] as const)('后端 Preview 在 prompt/build 前拒绝：%s', async (entry) => {
    const root = await capabilityRoot()
    const backendRoot = join(root, 'backend/exp_preview_backend')
    await mkdir(backendRoot, { recursive: true })
    const backendManifest = { pluginId: 'exp_preview_backend', contractsRange: '>=1.0.0 <2.0.0' }
    await writeFile(join(backendRoot, 'fh2-plugin.json'), JSON.stringify(backendManifest))
    await writeFile(join(backendRoot, 'custom.json'), JSON.stringify(backendManifest))
    const args = entry === 'root'
      ? ['--root', 'backend/exp_preview_backend']
      : entry === 'manifest'
        ? ['--manifest', 'backend/exp_preview_backend/custom.json']
        : entry.startsWith('plugins-')
          ? (entry === 'plugins-first'
              ? ['--plugin', 'backend/exp_preview_backend', '--plugin', 'frontend/exp_preview_alpha']
              : ['--plugin', 'frontend/exp_preview_alpha', '--plugin', 'backend/exp_preview_backend'])
          : []
    const harness = commandHarness()

    expect(await runPreviewCommand({ args, cwd: entry === 'cwd' ? backendRoot : root, operationLockHeld: true, ...harness })).toBe(2)
    expect(harness.stderr.text).toContain('后端插件目录不支持 Preview')
    expect(harness.stderr.text).toContain(entry === 'manifest' ? join(backendRoot, 'custom.json') : join(backendRoot, 'fh2-plugin.json'))
    expect(harness.stderr.text).toContain('fh2-plugin dev')
    expect(harness.prompt).not.toHaveBeenCalled()
    expect(harness.createRunner).not.toHaveBeenCalled()
    expect(harness.loadSourceManifest).not.toHaveBeenCalled()
    expect(harness.serve).not.toHaveBeenCalled()
    expect(harness.openBrowser).not.toHaveBeenCalled()
  })

  it('共享 Preview 服务按已解析 projects 预检，不依赖 CLI cwd 或完整 Capability discovery', async () => {
    const root = await capabilityRoot()
    const manifestPath = join(root, 'backend/custom.json')
    await writeFile(manifestPath, JSON.stringify({ pluginId: 'exp_preview_backend', flows: [] }))
    const harness = commandHarness()
    const parsed = parsePreviewArguments([], '/unrelated')

    expect(await previewProject({ ...parsed, projects: [{ projectRoot: join(root, 'backend'), manifestPath, pluginsDir: join(root, 'backend/dist') }] }, { cwd: '/unrelated', operationLockHeld: true, ...harness })).toBe(2)
    expect(harness.stderr.text).toContain('后端插件目录不支持 Preview')
    expect(harness.prompt).not.toHaveBeenCalled()
    expect(harness.createRunner).not.toHaveBeenCalled()
  })

  it('未传 URL 时交互读取，构建仅含前端并自动打开带调试 query 的浏览器', async () => {
    const harness = commandHarness()
    const cwd = resolve('project')
    const result = runPreviewCommand({ args: [], cwd, operationLockHeld: true, ...harness })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())

    expect(harness.prompt).toHaveBeenCalledWith('请输入司空预览地址：')
    expect(harness.createRunner).toHaveBeenCalledWith(expect.objectContaining({
      cwd,
      expectedManifestPath: resolve(cwd, 'fh2-plugin.json'),
      includeBackend: false,
      watch: true,
    }))
    expect(harness.serve).toHaveBeenCalledWith(expect.objectContaining({
      plugins: [{ pluginId: 'exp_preview', pluginsDir: resolve(cwd, 'dist') }],
      targetOrigin: 'http://fh2.example',
      port: 4317,
    }))
    expect(harness.openBrowser).toHaveBeenCalledWith(
      'http://fh2.example/project?org=1&fh2-plugin-debug=1',
    )
    harness.signals.emit('SIGTERM')
    expect(await result).toBe(0)
    expect(harness.server.close).toHaveBeenCalledOnce()
  })

  it('--fh2-url 跳过交互，--no-open 不打开浏览器', async () => {
    const harness = commandHarness()
    const result = runPreviewCommand({
      args: ['--fh2-url=http://fh2.example', '--no-open'],
      cwd: '/project',
      operationLockHeld: true,
      ...harness,
    })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())
    expect(harness.prompt).not.toHaveBeenCalled()
    expect(harness.openBrowser).not.toHaveBeenCalled()
    try {
      expect(harness.stdout.text).toContain('手动填写上述完整“请手动填写的插件来源URL”')
      expect(harness.stdout.text).toContain('本地来源只提供前端插件产物，不运行或替代真实后端')
      expect(harness.stdout.text).toContain('SwitchyOmega PAC')
      const printedUrl = new URL(harness.stdout.text.match(/调试面板地址：([^\n]+)/)![1]!)
      expect(printedUrl.searchParams.get('fh2-plugin-preview-source')).toBeNull()
      expect(printedUrl.searchParams.get('fh2-plugin-preview-session')).toBeNull()
      expect(harness.stdout.text).toContain(`请手动填写的插件来源URL：${harness.server.sourceUrl}`)
    } finally {
      harness.signals.emit('SIGTERM')
      expect(await result).toBe(0)
    }
  })

  it('多插件项目分别构建并由同一 HTTP Origin Proxy 提供', async () => {
    const harness = commandHarness()
    harness.loadSourceManifest.mockImplementation((manifestPath: string) => ({
      ...manifest,
      id: manifestPath.includes('alpha') ? 'exp_alpha' : 'exp_beta',
    }))
    const cwd = resolve('repo')
    const result = runPreviewCommand({
      args: [
        '--plugin',
        'plugins/alpha',
        '--plugin',
        'plugins/beta',
        '--fh2-url=http://fh2.example',
        '--no-open',
      ],
      cwd,
      operationLockHeld: true,
      ...harness,
    })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())
    expect(harness.createRunner).toHaveBeenCalledTimes(2)
    expect(harness.serve).toHaveBeenCalledWith(expect.objectContaining({
      plugins: [
        { pluginId: 'exp_alpha', pluginsDir: resolve(cwd, 'plugins/alpha/dist') },
        { pluginId: 'exp_beta', pluginsDir: resolve(cwd, 'plugins/beta/dist') },
      ],
    }))
    expect(harness.stdout.text).toContain('exp_alpha, exp_beta')
    harness.signals.emit('SIGTERM')
    expect(await result).toBe(0)
  })

  it('capability preview 只发现 frontend，不读取无效 backend', async () => {
    const root = await capabilityRoot()
    const harness = commandHarness()
    harness.loadSourceManifest.mockImplementation((manifestPath: string) => ({
      ...manifest,
      id: manifestPath.includes('exp_preview_alpha') ? 'exp_preview_alpha' : 'exp_preview_beta',
    }))
    const result = runPreviewCommand({
      args: ['--fh2-url=http://fh2.example', '--no-open', '--no-watch'],
      cwd: root,
      operationLockHeld: true,
      ...harness,
    })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())

    expect(harness.createRunner).toHaveBeenCalledTimes(2)
    expect(harness.serve).toHaveBeenCalledWith(expect.objectContaining({
      plugins: [
        { pluginId: 'exp_preview_alpha', pluginsDir: join(root, 'frontend/exp_preview_alpha/dist') },
        { pluginId: 'exp_preview_beta', pluginsDir: join(root, 'frontend/exp_preview_beta/dist') },
      ],
    }))
    expect(harness.stdout.text).toContain('Capability Preview 仅使用本地前端')
    harness.signals.emit('SIGTERM')
    expect(await result).toBe(0)
  })

  it('--root 从工作区根解析 capability 子目录，无需 cd', async () => {
    const root = await capabilityRoot()
    const workspaceRoot = dirname(root)
    const harness = commandHarness()
    harness.loadSourceManifest.mockImplementation((manifestPath: string) => ({
      ...manifest,
      id: manifestPath.includes('exp_preview_alpha') ? 'exp_preview_alpha' : 'exp_preview_beta',
    }))
    const result = runPreviewCommand({
      args: ['--root', 'exp_preview_capability', '--fh2-url=http://fh2.example', '--no-open', '--no-watch'],
      cwd: workspaceRoot,
      operationLockHeld: true,
      ...harness,
    })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())

    expect(harness.createRunner).toHaveBeenCalledTimes(2)
    expect(harness.serve).toHaveBeenCalledWith(expect.objectContaining({
      plugins: [
        { pluginId: 'exp_preview_alpha', pluginsDir: join(root, 'frontend/exp_preview_alpha/dist') },
        { pluginId: 'exp_preview_beta', pluginsDir: join(root, 'frontend/exp_preview_beta/dist') },
      ],
    }))
    harness.signals.emit('SIGTERM')
    expect(await result).toBe(0)
  })

  it('浏览器打开失败只警告，Preview Server 继续运行', async () => {
    const harness = commandHarness()
    harness.openBrowser.mockRejectedValue(new Error('launcher missing'))
    const result = runPreviewCommand({
      args: ['--fh2-url=http://fh2.example'],
      cwd: '/project',
      operationLockHeld: true,
      ...harness,
    })
    await vi.waitFor(() => expect(harness.stderr.text).toContain('BROWSER_OPEN_FAILED'))
    expect(harness.server.close).not.toHaveBeenCalled()
    harness.signals.emit('SIGTERM')
    expect(await result).toBe(0)
  })

  it('第二次中断信号调用强制退出，不重复等待关闭', async () => {
    const harness = commandHarness()
    const closeGate = deferred<void>()
    harness.createRunner.mockResolvedValue({
      firstBuild: Promise.resolve(),
      done: new Promise(() => {}),
      close: async () => closeGate.promise,
    })
    const forceExit = vi.fn()
    const result = runPreviewCommand({
      args: ['--fh2-url=http://fh2.example', '--no-open'],
      cwd: '/project',
      forceExit,
      operationLockHeld: true,
      ...harness,
    })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())
    harness.signals.emit('SIGINT')
    harness.signals.emit('SIGINT')
    expect(forceExit).toHaveBeenCalledWith(130)
    closeGate.resolve()
    expect(await result).toBe(130)
  })

  it('首次构建未完成时收到退出信号会先关闭 Build Session，不等待 Server', async () => {
    const harness = commandHarness()
    const firstBuild = deferred<void>()
    const close = vi.fn(async () => firstBuild.resolve())
    harness.createRunner.mockResolvedValue({
      firstBuild: firstBuild.promise,
      done: new Promise(() => {}),
      close,
    })
    const result = runPreviewCommand({
      args: ['--fh2-url=http://fh2.example', '--no-open'],
      cwd: '/project',
      operationLockHeld: true,
      ...harness,
    })
    await vi.waitFor(() => expect(harness.createRunner).toHaveBeenCalled())
    harness.signals.emit('SIGTERM')

    expect(await result).toBe(0)
    expect(close).toHaveBeenCalledOnce()
    expect(harness.serve).not.toHaveBeenCalled()
  })

  it('watch 中插件 ID 变化时关闭 Preview，避免元数据路由漂移', async () => {
    const harness = commandHarness()
    let runnerOptions: PluginBuildRunnerOptions | undefined
    harness.createRunner.mockImplementation(async (options) => {
      runnerOptions = options
      return controllableSession()
    })
    const result = runPreviewCommand({
      args: ['--fh2-url=http://fh2.example', '--no-open'],
      cwd: '/project',
      operationLockHeld: true,
      ...harness,
    })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())
    runnerOptions?.onEvent?.({
      type: 'success',
      buildId: 2,
      diagnostics: [],
      distManifest: { ...manifest, id: 'exp_changed' },
    })

    expect(await result).toBe(1)
    expect(harness.stderr.text).toContain('PREVIEW_PLUGIN_ID_CHANGED')
    expect(harness.server.close).toHaveBeenCalledOnce()
  })

  it('首次构建失败时关闭 Build，不启动代理或打开浏览器', async () => {
    const harness = commandHarness()
    const session = controllableSession()
    const close = vi.fn(session.close)
    harness.createRunner.mockImplementation(async () => ({
      ...session,
      firstBuild: Promise.reject(new PluginBuildError([{ code: 'BUILD_FAILED', phase: 'compile', message: 'entry build failed' }])),
      close,
    }))
    expect(await runPreviewCommand({
      args: ['--fh2-url', 'http://fh2.example'],
      cwd: '/project',
      operationLockHeld: true,
      ...harness,
    })).toBe(1)
    expect(harness.stderr.text).toContain('BUILD_FAILED')
    expect(close).toHaveBeenCalledOnce()
    expect(harness.serve).not.toHaveBeenCalled()
    expect(harness.openBrowser).not.toHaveBeenCalled()
  })

  it('http 司空仅使用受限代理并打印同 Origin 的完整插件来源', async () => {
    const harness = commandHarness()
    const proxyServer: PreviewStaticServer = {
      url: 'http://127.0.0.1:4317',
      sourceUrl: 'http://fh2-preview.example.com/.fh2-plugin-preview/0123456789abcdef0123456789abcdef/plugins',
      sessionToken: '0123456789abcdef0123456789abcdef',
      pacUrl: 'http://127.0.0.1:4317/proxy.pac?session=0123456789abcdef0123456789abcdef',
      close: vi.fn(async () => {}),
    }
    harness.serve.mockResolvedValue(proxyServer)
    const result = runPreviewCommand({
      args: ['--fh2-url=http://fh2-preview.example.com', '--no-open'],
      cwd: '/project',
      operationLockHeld: true,
      ...harness,
    })
    await vi.waitFor(() => expect(harness.serve).toHaveBeenCalled())
    expect(harness.serve.mock.calls[0]?.[0]).not.toHaveProperty('certificate')
    expect(harness.stdout.text).toContain(
      'SwitchyOmega PAC：http://127.0.0.1:4317/proxy.pac?session=0123456789abcdef0123456789abcdef',
    )
    try {
      expect(harness.stdout.text).toContain('在 SwitchyOmega 的 PAC 情景模式中填入上述 PAC 地址，应用并选择该模式，按 PAC 规则自动切换')
      expect(harness.stdout.text).toContain('仅目标 Origin http://fh2-preview.example.com（协议/主机/端口）经本地受限代理 http://127.0.0.1:4317，其他 Origin 直连')
      expect(harness.stdout.text).toContain('手动填写上述完整“请手动填写的插件来源URL”')
      expect(harness.stdout.text).toContain('只有本次来源路径读取本地产物，页面和业务请求继续转发目标司空环境')
      expect(harness.stdout.text).toContain('本地来源只提供前端插件产物，不运行或替代真实后端')
      expect(harness.stdout.text).not.toContain('HTTPS 本地来源需使用浏览器信任的证书')
      const printedUrl = new URL(harness.stdout.text.match(/调试面板地址：([^\n]+)/)![1]!)
      expect(printedUrl.searchParams.get('fh2-plugin-preview-source')).toBeNull()
      expect(printedUrl.searchParams.get('fh2-plugin-preview-session')).toBeNull()
      expect(harness.stdout.text).toContain(`请手动填写的插件来源URL：${proxyServer.sourceUrl}`)
    } finally {
      harness.signals.emit('SIGTERM')
      expect(await result).toBe(0)
    }
  })

  it.each([
    ['--local-protocol=auto'],
    ['--local-protocol=http'],
    ['--local-protocol=https'],
    ['--cert=local.pem', '--key=local-key.pem'],
  ])('旧协议/TLS 参数在 prompt/build 前拒绝 %j', async (...args) => {
    const harness = commandHarness()
    expect(await runPreviewCommand({
      args,
      cwd: '/project',
      operationLockHeld: true,
      ...harness,
    })).toBe(2)
    expect(harness.stderr.text).toContain('未知参数')
    expect(harness.prompt).not.toHaveBeenCalled()
    expect(harness.createRunner).not.toHaveBeenCalled()
    expect(harness.serve).not.toHaveBeenCalled()
    expect(harness.openBrowser).not.toHaveBeenCalled()
  })

  it('代理启动失败时关闭已有构建会话并返回 1', async () => {
    const harness = commandHarness()
    const session = controllableSession()
    const close = vi.fn(session.close)
    harness.createRunner.mockResolvedValue({ ...session, close })
    harness.serve.mockRejectedValue(new Error('port is occupied'))
    expect(await runPreviewCommand({
      args: ['--fh2-url=http://fh2.example'],
      cwd: '/project',
      operationLockHeld: true,
      ...harness,
    })).toBe(1)
    expect(harness.stderr.text).toContain('port is occupied')
    expect(close).toHaveBeenCalledOnce()
    expect(harness.openBrowser).not.toHaveBeenCalled()
  })

  it('无 URL 且无交互输入器时明确失败', async () => {
    const harness = commandHarness()
    const { prompt: _prompt, ...nonInteractiveHarness } = harness
    expect(await runPreviewCommand({
      args: [],
      cwd: '/project',
      operationLockHeld: true,
      ...nonInteractiveHarness,
    })).toBe(2)
    expect(harness.stderr.text).toContain('--fh2-url')
  })
})

async function capabilityRoot (): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'fh2-capability-preview-'))
  const root = join(parent, 'exp_preview_capability')
  temporaryRoots.push(parent)
  await mkdir(join(root, 'frontend/exp_preview_alpha'), { recursive: true })
  await mkdir(join(root, 'frontend/exp_preview_beta'), { recursive: true })
  await mkdir(join(root, 'backend/invalid_backend'), { recursive: true })
  await writeFile(join(root, 'capabilities.json'), JSON.stringify({ name: 'Preview', description: 'frontend only' }))
  await writeFile(join(root, 'frontend/exp_preview_alpha/fh2-plugin.json'), JSON.stringify({ id: 'exp_preview_alpha' }))
  await writeFile(join(root, 'frontend/exp_preview_beta/fh2-plugin.json'), JSON.stringify({ id: 'exp_preview_beta' }))
  await writeFile(join(root, 'backend/invalid_backend/plugin.json'), '{ invalid')
  return root
}

function commandHarness (): {
  readonly stdout: CaptureWriter;
  readonly stderr: CaptureWriter;
  readonly signals: FakeSignals;
  readonly prompt: ReturnType<typeof vi.fn<(message: string) => Promise<string>>>;
  readonly createRunner: ReturnType<typeof vi.fn<(options: PluginBuildRunnerOptions) => Promise<PluginBuildSession>>>;
  readonly loadSourceManifest: ReturnType<typeof vi.fn>;
  readonly serve: ReturnType<typeof vi.fn<(options: PreviewStaticServerOptions) => Promise<PreviewStaticServer>>>;
  readonly openBrowser: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;
  readonly server: FakePreviewServer;
} {
  const server = new FakePreviewServer()
  return {
    stdout: new CaptureWriter(),
    stderr: new CaptureWriter(),
    signals: new FakeSignals(),
    prompt: vi.fn(async () => 'http://fh2.example/project?org=1'),
    createRunner: vi.fn(async () => controllableSession()),
    loadSourceManifest: vi.fn(() => manifest),
    serve: vi.fn(async () => server),
    openBrowser: vi.fn(async () => {}),
    server,
  }
}

function controllableSession (): PluginBuildSession {
  const done = deferred<{ readonly reason: 'closed' }>()
  return {
    firstBuild: Promise.resolve(),
    done: done.promise,
    close: async () => done.resolve({ reason: 'closed' }),
  }
}

class FakePreviewServer implements PreviewStaticServer {
  readonly url = 'http://127.0.0.1:4317'
  readonly sourceUrl = 'http://fh2.example/.fh2-plugin-preview/0123456789abcdef0123456789abcdef/plugins'
  readonly sessionToken = '0123456789abcdef0123456789abcdef'
  readonly pacUrl = `${this.url}/proxy.pac?session=${this.sessionToken}`
  readonly close = vi.fn(async () => {})
}

class FakeSignals implements PreviewSignalSource {
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

class CaptureWriter {
  text = ''

  write (chunk: string): boolean {
    this.text += chunk
    return true
  }
}

function deferred<T> (): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}
