// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityBuildOptions } from '../capability/build.js'
import { runCapabilityDev } from '../capability/dev.js'
import { parseDevArguments } from '../commands/dev-command.js'
import { runBackendPluginDev } from '../dev/backend-plugin-dev.js'
import { CLI_CONTRACT } from './cli.js'

const roots: string[] = []
const { watchersReady } = vi.hoisted(() => ({ watchersReady: [] as Promise<void>[] }))

vi.mock('chokidar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('chokidar')>()
  const watch: typeof actual.watch = (paths, options) => {
    const watcher = actual.watch(paths, options)
    watchersReady.push(new Promise<void>(resolveReady => watcher.once('ready', resolveReady)))
    return watcher
  }
  return { ...actual, watch }
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('developer usage watch boundaries', () => {
  it('capability frontend success publishes page reload, backend success only reloads Runtime', async () => {
    const signals = new EventEmitter()
    const publish = vi.fn()
    const reload = vi.fn()
    let onPluginEvent: CapabilityBuildOptions['onPluginEvent']
    let closeWatch!: () => void
    const done = new Promise<{ reason: 'closed' }>((resolveClosed) => {
      closeWatch = () => resolveClosed({ reason: 'closed' })
    })
    let output = ''
    let errors = ''
    const run = runCapabilityDev({
      capability: {
        kind: 'capability-project',
        root: '/watch-capability',
        capabilityId: 'exp_watch',
        metadataPath: '/watch-capability/capabilities.json',
        metadata: { name: 'Watch', description: 'local event-dispatch test' },
        frontend: [{ id: 'exp_watch_frontend', root: '/watch-capability/frontend/exp_watch_frontend', manifestPath: '/watch-capability/frontend/exp_watch_frontend/fh2-plugin.json' }],
        backend: [{ id: 'exp_watch_backend', root: '/watch-capability/backend/exp_watch_backend', manifestPath: '/watch-capability/backend/exp_watch_backend/fh2-plugin.json' }],
      },
      parsed: parseDevArguments([], '/watch-capability'),
      signals,
      stdout: { write: (chunk) => {
        output += chunk
      } },
      stderr: { write: (chunk) => {
        errors += chunk
      } },
      watchCapability: async (options) => {
        onPluginEvent = options.onPluginEvent
        return { firstBuild: Promise.resolve(), done, close: async () => closeWatch() }
      },
      createBackendRuntime: () => ({ reload, close: () => {} }) as never,
      serve: async () => ({ url: 'http://127.0.0.1:5175', apiMode: 'mock', publishBuildEvent: publish, close: async () => {} }),
      resolveWorkbench: () => ({ shell: '/watch-shell', vue3: '/watch-vue3', vue2: '/watch-vue2' }),
    })
    try {
      await vi.waitFor(() => expect(output).toContain('Capability Workbench'))
      onPluginEvent!({ side: 'backend', pluginId: 'exp_watch_backend', type: 'success', diagnostics: [] })
      expect(reload).toHaveBeenCalledWith('exp_watch_backend')
      expect(publish).not.toHaveBeenCalled()
      onPluginEvent!({ side: 'frontend', pluginId: 'exp_watch_frontend', type: 'success', diagnostics: [] })
      expect(publish).toHaveBeenCalledOnce()
      expect(publish).toHaveBeenLastCalledWith({ schemaVersion: 1, type: 'reload', buildId: 1 })
      onPluginEvent!({ side: 'backend', pluginId: 'exp_watch_backend', type: 'failure', diagnostics: [{ code: 'FH2_BUILD_FAILED', phase: 'compile', message: 'local failure event' }] })
      expect(publish).toHaveBeenLastCalledWith({ schemaVersion: 1, type: 'error', buildId: 2, diagnosticCode: 'FH2_BUILD_FAILED' })
      expect(errors).toContain('dev build failed')
      const usage = CLI_CONTRACT.commands.find(command => command.name === 'dev')!.usage![0]!
      expect(usage.steps.join('\n')).toContain('前端源码重建成功会触发页面刷新')
      expect(usage.steps.join('\n')).toContain('只会重载本地后端，不刷新页面')
    } finally {
      signals.emit('SIGTERM')
      expect(await run).toBe(0)
    }
  })

  it('standalone backend watches real source changes, reloads Runtime on success and reports failure only in stderr', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-backend-watch-usage-'))
    roots.push(root)
    const pluginRoot = join(root, 'backend')
    await mkdir(join(pluginRoot, 'handlers/watch'), { recursive: true })
    await writeFile(join(pluginRoot, 'fh2-plugin.json'), JSON.stringify({ pluginId: 'exp_watch_backend', name: 'Watch', version: '0.1.0', allowlist: [] }))
    const entry = join(pluginRoot, 'handlers/watch/observe.js')
    await writeFile(entry, 'function h_watch_observe () { return { value: 1 } }\n')
    const signals = new EventEmitter()
    const reload = vi.fn()
    let output = ''
    let errors = ''
    let url = ''
    const run = runBackendPluginDev({
      pluginRoot,
      port: 0,
      watch: true,
      signals,
      onReady: (ready) => {
        url = ready
      },
      stdout: { write: (chunk) => {
        output += chunk
      } },
      stderr: { write: (chunk) => {
        errors += chunk
      } },
      createRuntime: () => ({ reload, close: () => {}, invoke: async () => ({}), dispatchEvent: async () => ({}), snapshot: () => ({ pluginId: 'exp_watch_backend', version: '0.1.0', entities: {} }), reset: () => ({ pluginId: 'exp_watch_backend', version: '0.1.0', entities: {} }) }),
    })
    try {
      await vi.waitFor(() => expect(url).not.toBe(''), { timeout: 10_000 })
      expect(watchersReady).toHaveLength(1)
      await watchersReady.shift()
      await writeFile(entry, 'function h_watch_observe () { return { value: 2 } }\n')
      await vi.waitFor(() => expect(output).toContain('Runtime 已 reload'), { timeout: 10_000 })
      expect(reload).toHaveBeenCalledOnce()
      const rebuildOutput = output
      await writeFile(entry, 'function h_watch_observe () { invalid syntax\n')
      await vi.waitFor(() => expect(errors).toContain('dev 重建失败'), { timeout: 10_000 })
      expect(errors).toContain('dev 重建失败')
      expect(reload).toHaveBeenCalledOnce()
      expect(output).toBe(rebuildOutput)
      expect((await fetch(`${url}/__live_reload__`)).status).toBe(404)
      const usage = CLI_CONTRACT.commands.find(command => command.name === 'dev')!.usage![0]!
      expect(usage.steps.join('\n')).toContain('独立后端重建失败只写终端错误输出')
    } finally {
      signals.emit('SIGTERM')
      expect(await run).toBe(0)
    }
  }, 30_000)
})
