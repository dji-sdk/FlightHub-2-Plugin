// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DevSignalSource, WorkbenchDistPaths } from '../commands/dev-command.js'
import type { DevStaticServer } from '../dev/static-server.js'
import { MOCK_PLUGIN_TOKEN } from '../dev/gateway.js'
import type { CapabilityBuildWatchSession } from './build.js'
import type { CapabilityProject } from './types.js'
import { runCapabilityDev } from './dev.js'

describe('capability dev', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })
  it('复用多前端目录、Capability catalog 和 Build Watch 启动 Workbench', async () => {
    const signals = new FakeSignals()
    const server = new FakeServer()
    const watch = watchSession()
    const watchCapability = vi.fn(async () => watch.session)
    const serve = vi.fn(async () => server)
    const runtime = { reload: vi.fn(), close: vi.fn(), snapshot: vi.fn(), dispatchMockEvents: vi.fn(async () => {}) }
    const capability = capabilityFixture()
    const stdout = new CaptureWriter()
    const result = runCapabilityDev({
      capability,
      parsed: {
        workbenchMode: 'all',
        manifestPath: '/capability/fh2-plugin.json',
        projectRoot: '/capability',
        pluginsDir: [],
        port: 0,
        watch: true,
        frontendOnly: false,
        help: false,
      },
      stdout,
      stderr: new CaptureWriter(),
      signals,
      watchCapability: watchCapability as typeof import('./build.js').watchCapability,
      serve,
      resolveWorkbench: () => workbench(),
      createBackendRuntime: () => runtime as never,
    })

    await vi.waitFor(() => expect(serve).toHaveBeenCalled())
    await vi.waitFor(() => expect(stdout.text).toContain(`x-plugin-token: ${MOCK_PLUGIN_TOKEN}`))
    expect(stdout.text).toContain(`本地后端 Gateway URL：${new URL(server.url).origin}`)
    expect(watchCapability).toHaveBeenCalledWith(expect.objectContaining({
      capability: expect.objectContaining({
        frontend: capability.frontend,
        backend: capability.backend,
      }),
    }))
    expect(serve).toHaveBeenCalledWith(expect.objectContaining({
      pluginsDir: ['/capability/frontend/exp_frontend_a/dist', '/capability/frontend/exp_frontend_b/dist'],
      pluginCatalog: [
        { pluginId: 'exp_frontend_a', root: '/capability/frontend/exp_frontend_a/dist' },
        { pluginId: 'exp_frontend_b', root: '/capability/frontend/exp_frontend_b/dist' },
      ],
      backendMode: 'fullstack',
    }))
    signals.emit('SIGTERM')
    expect(await result).toBe(0)
    expect(watch.close).toHaveBeenCalledOnce()
    expect(server.close).toHaveBeenCalledOnce()
  })

  it('frontend-only 不创建本地多后端 Runtime', async () => {
    const signals = new FakeSignals()
    const server = new FakeServer()
    const buildCapability = vi.fn(async () => ({ ok: true, diagnostics: [] }))
    const createBackendRuntime = vi.fn()
    const stdout = new CaptureWriter()
    const result = runCapabilityDev({
      capability: capabilityFixture(),
      parsed: {
        workbenchMode: 'all',
        manifestPath: '/capability/fh2-plugin.json',
        projectRoot: '/capability',
        pluginsDir: [],
        port: 0,
        watch: false,
        frontendOnly: true,
        help: false,
      },
      stdout,
      stderr: new CaptureWriter(),
      signals,
      buildCapability: buildCapability as typeof import('./build.js').buildCapability,
      serve: async () => server,
      resolveWorkbench: () => workbench(),
      createBackendRuntime,
    })

    await vi.waitFor(() => expect(buildCapability).toHaveBeenCalled())
    expect(createBackendRuntime).not.toHaveBeenCalled()
    signals.emit('SIGTERM')
    expect(await result).toBe(0)
    expect(stdout.text).not.toContain('本地调用凭据')
  })

  it('真实 Gateway 经 Capability Runtime 完成 Handler 和 Event Fixture 闭环', async () => {
    const fixture = await realFixture()
    roots.push(fixture.parent)
    const signals = new FakeSignals()
    const stdout = new CaptureWriter()
    const result = runCapabilityDev({
      capability: fixture.capability,
      parsed: {
        workbenchMode: 'all',
        manifestPath: join(fixture.root, 'fh2-plugin.json'),
        projectRoot: fixture.root,
        pluginsDir: [],
        port: 0,
        watch: false,
        frontendOnly: false,
        help: false,
      },
      stdout,
      stderr: new CaptureWriter(),
      signals,
      buildCapability: async () => ({ ok: true, diagnostics: [] }),
      resolveWorkbench: () => fixture.workbench,
    })
    await vi.waitFor(() => expect(stdout.text).toContain('Capability Workbench 已启动'))
    const url = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout.text)?.[0]
    expect(url).toBeDefined()
    const invoke = await fetch(`${url}/plugin-api/plugin/invoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-plugin-token': 'mock-plugin-token',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ pluginId: 'exp_runtime_backend', handler: 'items.create', input: { title: 'created' } }),
    })
    expect(await invoke.json()).toEqual({ code: 0, message: 'success', data: { title: 'created' } })
    const event = await fetch(`${url}/plugin-api/mock/backend/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ type: 'fixture.event', data: { value: 'event' } }),
    })
    expect(await event.json()).toEqual({ code: 0, message: 'success', data: { value: 'event' } })
    signals.emit('SIGTERM')
    expect(await result).toBe(0)
  })
})

async function realFixture (): Promise<{
  readonly parent: string;
  readonly root: string;
  readonly capability: CapabilityProject;
  readonly workbench: WorkbenchDistPaths;
}> {
  const parent = await mkdtemp(join(tmpdir(), 'fh2-capability-dev-'))
  const root = join(parent, 'exp_runtime_capability')
  const frontendRoot = join(root, 'frontend/exp_runtime_frontend')
  const backendRoot = join(root, 'backend/exp_runtime_backend')
  const shell = join(parent, 'shell')
  const vue3 = join(parent, 'vue3')
  const vue2 = join(parent, 'vue2')
  await mkdir(join(frontendRoot, 'dist'), { recursive: true })
  await mkdir(join(backendRoot, 'dist/handlers/items'), { recursive: true })
  await mkdir(join(backendRoot, 'dist/events'), { recursive: true })
  await mkdir(join(root, 'mock/fixtures'), { recursive: true })
  await mkdir(shell, { recursive: true })
  await mkdir(vue3, { recursive: true })
  await mkdir(vue2, { recursive: true })
  await writeFile(join(shell, 'index.html'), '<html><head></head><body>shell</body></html>')
  await writeFile(join(vue3, 'container.html'), 'vue3')
  await writeFile(join(vue2, 'container.html'), 'vue2')
  await writeFile(join(frontendRoot, 'dist/fh2-plugin.json'), JSON.stringify({ id: 'exp_runtime_frontend' }))
  await writeFile(join(backendRoot, 'dist/plugin.json'), JSON.stringify({
    pluginId: 'exp_runtime_backend',
    name: 'Runtime Backend',
    version: '0.1.0',
    events: [{ type: 'fixture.event', consumer: [{ handler: 'events/fixture.js', entry: 'onFixtureEvent' }] }],
  }))
  await writeFile(join(backendRoot, 'dist/handlers/items/create.js'), 'function handle(input) { return { title: String(input.title || "") } }\n')
  await writeFile(join(backendRoot, 'dist/events/fixture.js'), 'function onFixtureEvent(event) { return { value: String(event.data.value || "") } }\n')
  await writeFile(join(root, 'mock/fixtures/default.json'), JSON.stringify({ entities: {} }))
  await writeFile(join(root, 'capabilities.json'), JSON.stringify({ name: 'Runtime Capability', description: 'Dev integration' }))
  return {
    parent,
    root,
    capability: {
      kind: 'capability-project',
      root,
      capabilityId: 'exp_runtime_capability',
      metadataPath: join(root, 'capabilities.json'),
      metadata: { name: 'Runtime Capability', description: 'Dev integration' },
      frontend: [{ id: 'exp_runtime_frontend', root: frontendRoot, manifestPath: join(frontendRoot, 'fh2-plugin.json') }],
      backend: [{ id: 'exp_runtime_backend', root: backendRoot, manifestPath: join(backendRoot, 'fh2-plugin.json') }],
    },
    workbench: { shell, vue3, vue2 },
  }
}

function capabilityFixture (): CapabilityProject {
  return {
    kind: 'capability-project',
    root: '/capability',
    capabilityId: 'exp_capability',
    metadataPath: '/capability/capabilities.json',
    metadata: { name: 'Capability', description: '测试' },
    frontend: [
      { id: 'exp_frontend_a', root: '/capability/frontend/exp_frontend_a', manifestPath: '/capability/frontend/exp_frontend_a/fh2-plugin.json' },
      { id: 'exp_frontend_b', root: '/capability/frontend/exp_frontend_b', manifestPath: '/capability/frontend/exp_frontend_b/fh2-plugin.json' },
    ],
    backend: [{ id: 'exp_backend', root: '/capability/backend/exp_backend', manifestPath: '/capability/backend/exp_backend/plugin.json' }],
  }
}

function workbench (): WorkbenchDistPaths {
  return { shell: '/workbench/shell', vue3: '/workbench/vue3', vue2: '/workbench/vue2' }
}

function watchSession (): {
  readonly session: CapabilityBuildWatchSession;
  readonly close: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  const done = deferred<{ readonly reason: 'closed' }>()
  const close = vi.fn(async () => {
    done.resolve({ reason: 'closed' })
  })
  return {
    session: { firstBuild: Promise.resolve(), done: done.promise, close },
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

class FakeServer implements DevStaticServer {
  readonly url = 'http://127.0.0.1:5175'
  readonly apiMode = 'mock' as const
  readonly close = vi.fn(async () => {})

  publishBuildEvent (): void {}
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
