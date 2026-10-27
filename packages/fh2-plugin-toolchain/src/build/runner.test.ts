// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { createRsbuild, loadConfig } from '@rsbuild/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginManifest } from 'fh2-plugin-sdk'
import { fh2Plugin } from '../rsbuild/plugin.js'
import {
  createPluginBuildRunnerWithDependencies,
  isIgnoredWatchPath,
} from './runner.js'
import type { BuildRunnerDependencies } from './runner.js'
import { resolveBuildDescriptor } from './paths.js'
import { PluginBuildError } from './types.js'
import type { PluginBuildEvent } from './types.js'

const directories: string[] = []
const resultManifest: PluginManifest = {
  manifestVersion: 1,
  id: 'exp_runner',
  name: 'Runner 测试',
  version: '1.0.0',
  engines: { platform: '>=1.0.0-alpha.0 <2.0.0' },
  entry: './plugin.hash.js',
  extensions: [],
  buildInfo: { sdkVersion: '1.0.0-alpha.0', toolchainVersion: '1.0.0-alpha.0' },
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('pluginBuildSession watch 生命周期', () => {
  it('串行报告后续 failure，保留 session 并在恢复后发 success', async () => {
    const root = project()
    const watcher = new FakeWatcher()
    const events: PluginBuildEvent[] = []
    const externalDependency = join(root, 'linked-package/index.ts')
    const generatedFile = join(resolveBuildDescriptor(root, {}).typesOutDir, 'plugin-types.ts')
    let round = 0
    const executeRound = vi.fn(async () => {
      round += 1
      if (round === 2) {
        throw new PluginBuildError([{
          code: 'FH2_RSPACK_COMPILE_ERROR',
          phase: 'compile',
          message: 'temporary failure',
        }])
      }
      return successfulRound([externalDependency, generatedFile])
    })
    const session = await createPluginBuildRunnerWithDependencies(
      { cwd: root, watch: true, onEvent: event => events.push(event) },
      dependencies(root, watcher, executeRound),
    )
    await session.firstBuild
    expect(events.map(event => event.type)).toEqual(['success'])
    expect(watcher.add).toHaveBeenCalledWith([externalDependency])

    watcher.emit('all', 'change', externalDependency)
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[1]).toMatchObject({ type: 'failure', buildId: 2 })

    watcher.emit('all', 'change', join(root, 'src/plugin.ts'))
    await vi.waitFor(() => expect(events).toHaveLength(3))
    expect(events[2]).toMatchObject({ type: 'success', buildId: 3 })
    expect(executeRound).toHaveBeenCalledTimes(3)

    await Promise.all([session.close(), session.close()])
    await expect(session.done).resolves.toEqual({ reason: 'closed' })
    expect(watcher.close).toHaveBeenCalledTimes(1)
  })

  it('首轮失败 reject firstBuild、关闭 watcher，并完成 done', async () => {
    const root = project()
    const watcher = new FakeWatcher()
    const session = await createPluginBuildRunnerWithDependencies(
      { cwd: root, watch: true },
      dependencies(root, watcher, async () => {
        throw new PluginBuildError([{ code: 'FH2_INITIAL', phase: 'resolve', message: 'missing' }])
      }),
    )
    await expect(session.firstBuild).rejects.toBeInstanceOf(PluginBuildError)
    await expect(session.done).resolves.toEqual({ reason: 'closed' })
    expect(watcher.close).toHaveBeenCalledTimes(1)
  })

  it('ready 前立即 close 可取消 baseline 等待且不留下 pending promise', async () => {
    const root = project()
    const watcher = new FakeWatcher()
    const executeRound = vi.fn(async () => successfulRound())
    const session = await createPluginBuildRunnerWithDependencies(
      { cwd: root, watch: true },
      dependencies(root, watcher, executeRound, undefined, false),
    )
    const firstResult = session.firstBuild.catch(error => error)
    await vi.waitFor(() => expect(watcher.started).toBe(true))
    expect(watcher.ready).toBe(false)
    await Promise.all([session.close(), session.close()])
    expect(await firstResult).toBeInstanceOf(PluginBuildError)
    await expect(session.done).resolves.toEqual({ reason: 'closed' })
    expect(executeRound).not.toHaveBeenCalled()
  })

  it('首轮成功后的 watcher fatal 发 fatal event 并终止 done', async () => {
    const root = project()
    const watcher = new FakeWatcher()
    const events: PluginBuildEvent[] = []
    const session = await createPluginBuildRunnerWithDependencies(
      { cwd: root, watch: true, onEvent: event => events.push(event) },
      dependencies(root, watcher, async () => successfulRound()),
    )
    await session.firstBuild
    watcher.emit('error', new Error('watch failed'))
    await expect(session.done).resolves.toMatchObject({ reason: 'fatal' })
    expect(events.at(-1)).toMatchObject({ type: 'fatal' })
  })

  it('首轮成功后的 partial stats/no-errors 基础设施崩溃终止为 fatal', async () => {
    const root = project()
    const watcher = new FakeWatcher()
    const events: PluginBuildEvent[] = []
    let round = 0
    const session = await createPluginBuildRunnerWithDependencies(
      { cwd: root, watch: true, onEvent: event => events.push(event) },
      dependencies(root, watcher, async () => {
        round += 1
        if (round === 1) return successfulRound()
        throw new PluginBuildError([{
          code: 'FH2_RSBUILD_INFRASTRUCTURE_FAILED',
          phase: 'compile',
          message: 'compiler infrastructure failed',
        }])
      }),
    )
    await session.firstBuild
    watcher.emit('all', 'change', join(root, 'src/plugin.ts'))
    await expect(session.done).resolves.toMatchObject({ reason: 'fatal' })
    expect(events.map(event => event.type)).toEqual(['success', 'fatal'])
    expect(watcher.close).toHaveBeenCalledTimes(1)
  })

  it('首轮成功后的 BuildResult close 失败终止为 fatal', async () => {
    const root = project()
    const watcher = new FakeWatcher()
    let round = 0
    const session = await createPluginBuildRunnerWithDependencies(
      { cwd: root, watch: true },
      dependencies(root, watcher, async () => {
        round += 1
        if (round === 1) return successfulRound()
        throw new PluginBuildError([{
          code: 'FH2_BUILD_RESULT_CLOSE_FAILED',
          phase: 'compile',
          message: 'close failed',
        }])
      }),
    )
    await session.firstBuild
    watcher.emit('all', 'change', join(root, 'src/plugin.ts'))
    await expect(session.done).resolves.toMatchObject({ reason: 'fatal' })
  })

  it('首轮失败时 watcher.close 拒绝仍 settle firstBuild 与 done', async () => {
    const root = project()
    const watcher = new FakeWatcher()
    watcher.close.mockRejectedValueOnce(new Error('close rejected'))
    const session = await createPluginBuildRunnerWithDependencies(
      { cwd: root, watch: true },
      dependencies(root, watcher, async () => {
        throw new PluginBuildError([{ code: 'FH2_INITIAL', phase: 'resolve', message: 'missing' }])
      }),
    )
    await expect(session.firstBuild).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'FH2_BUILD_WATCHER_CLOSE_FAILED' }),
      ]),
    })
    await expect(session.done).resolves.toEqual({ reason: 'closed' })
  })

  it('显式 close 时 watcher.close 拒绝仍先 settle terminal promises', async () => {
    const root = project()
    const watcher = new FakeWatcher()
    const session = await createPluginBuildRunnerWithDependencies(
      { cwd: root, watch: true },
      dependencies(root, watcher, async () => successfulRound()),
    )
    await session.firstBuild
    watcher.close.mockRejectedValueOnce(new Error('close rejected'))
    await expect(session.close()).rejects.toThrow('close rejected')
    await expect(session.done).resolves.toEqual({ reason: 'closed' })
  })

  it('fatal watcher 的 close 拒绝仍 settle done 并保留关闭诊断', async () => {
    const root = project()
    const watcher = new FakeWatcher()
    const session = await createPluginBuildRunnerWithDependencies(
      { cwd: root, watch: true },
      dependencies(root, watcher, async () => successfulRound()),
    )
    await session.firstBuild
    watcher.close.mockRejectedValueOnce(new Error('close rejected'))
    watcher.emit('error', new Error('watch failed'))
    await expect(session.done).resolves.toMatchObject({
      reason: 'fatal',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'FH2_BUILD_WATCHER_CLOSE_FAILED' }),
      ]),
    })
  })

  it('并发 close 共享同一 Promise，并共同等待延迟 watcher.close', async () => {
    const root = project()
    const watcher = new FakeWatcher()
    const session = await createPluginBuildRunnerWithDependencies(
      { cwd: root, watch: true },
      dependencies(root, watcher, async () => successfulRound()),
    )
    await session.firstBuild
    const closeGate = deferred<void>()
    watcher.close.mockImplementationOnce(async () => closeGate.promise)
    const firstClose = session.close()
    const secondClose = session.close()
    expect(secondClose).toBe(firstClose)
    let settled = false
    void firstClose.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    closeGate.resolve()
    await Promise.all([firstClose, secondClose])
    expect(settled).toBe(true)
    expect(watcher.close).toHaveBeenCalledTimes(1)
  })

  it.each(['fatal', 'close'] as const)('%s 先发起时赢得 terminal race', async (winner) => {
    const root = project()
    const watcher = new FakeWatcher()
    const session = await createPluginBuildRunnerWithDependencies(
      { cwd: root, watch: true },
      dependencies(root, watcher, async () => successfulRound()),
    )
    await session.firstBuild
    const closeGate = deferred<void>()
    watcher.close.mockImplementationOnce(async () => closeGate.promise)
    if (winner === 'fatal') {
      watcher.emit('error', new Error('fatal first'))
      const closing = session.close()
      closeGate.resolve()
      await closing
      await expect(session.done).resolves.toMatchObject({ reason: 'fatal' })
    } else {
      const closing = session.close()
      watcher.emit('error', new Error('ignored after close claim'))
      closeGate.resolve()
      await closing
      await expect(session.done).resolves.toEqual({ reason: 'closed' })
    }
  })

  it('recoverable failure 先添加 outside missing dependency，再由 add 事件恢复', async () => {
    const root = project()
    const watcher = new FakeWatcher()
    const events: PluginBuildEvent[] = []
    const missingDependency = join(root, 'outside/missing.ts')
    let round = 0
    const session = await createPluginBuildRunnerWithDependencies(
      { cwd: root, watch: true, onEvent: event => events.push(event) },
      dependencies(root, watcher, async () => {
        round += 1
        if (round === 2) {
          throw new PluginBuildError([{
            code: 'FH2_RSPACK_COMPILE_ERROR',
            phase: 'compile',
            message: 'missing import',
          }], [missingDependency])
        }
        return successfulRound()
      }),
    )
    await session.firstBuild
    watcher.emit('all', 'change', join(root, 'src/plugin.ts'))
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('failure'))
    expect(watcher.add).toHaveBeenCalledWith([missingDependency])
    mkdirSync(join(root, 'outside'), { recursive: true })
    writeFileSync(missingDependency, 'export const recovered = true\n')
    watcher.emit('all', 'add', missingDependency)
    await vi.waitFor(() => expect(events.map(event => event.type)).toEqual(['success', 'failure', 'success']))
    await session.close()
  })
})

describe('runner adapter 数量门禁', () => {
  it.each([
    ['缺失', []],
    ['重复', [fh2Plugin(), fh2Plugin()]],
  ])('%s adapter 时首轮配置失败', async (_name, plugins) => {
    const root = project()
    const watcher = new FakeWatcher()
    const deps = dependencies(root, watcher, async () => successfulRound(), plugins)
    const session = await createPluginBuildRunnerWithDependencies({ cwd: root, watch: false }, deps)
    await expect(session.firstBuild).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'FH2_ADAPTER_COUNT_INVALID' })],
    })
    await expect(session.done).resolves.toEqual({ reason: 'closed' })
  })

  it('expectedManifestPath 与 adapter Manifest realpath 不一致时立即失败', async () => {
    const root = project()
    writeFileSync(join(root, 'other.json'), '{}')
    const watcher = new FakeWatcher()
    const session = await createPluginBuildRunnerWithDependencies(
      { cwd: root, expectedManifestPath: './other.json', watch: false },
      dependencies(root, watcher, async () => successfulRound()),
    )
    await expect(session.firstBuild).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'FH2_EXPECTED_MANIFEST_MISMATCH' })],
    })
  })
})

describe('watch ignore predicate', () => {
  it('仅忽略 generated 文件而不忽略 typesOutDir 本身或其他源码', () => {
    const root = project()
    const descriptor = resolveBuildDescriptor(root, { typesOutDir: '.' })
    const projectRoot = descriptor.projectRoot
    expect(isIgnoredWatchPath(projectRoot, descriptor)).toBe(false)
    expect(isIgnoredWatchPath(join(projectRoot, 'feature.ts'), descriptor)).toBe(false)
    expect(isIgnoredWatchPath(join(projectRoot, 'plugin-types.ts'), descriptor)).toBe(true)
    expect(isIgnoredWatchPath(join(projectRoot, '.plugin-types.ts.123.uuid.tmp'), descriptor)).toBe(true)
    expect(isIgnoredWatchPath(join(projectRoot, 'other-generated.ts'), descriptor)).toBe(false)
    expect(isIgnoredWatchPath(join(projectRoot, 'dist/plugin.js'), descriptor)).toBe(true)
    expect(isIgnoredWatchPath(join(projectRoot, '.dist.fh2-next-test/plugin.js'), descriptor)).toBe(true)
  })

  it('node_modules（含 pnpm symlink 展开形态）一律忽略', () => {
    const root = project()
    const descriptor = resolveBuildDescriptor(root, { typesOutDir: '.' })
    const projectRoot = descriptor.projectRoot
    expect(isIgnoredWatchPath(join(projectRoot, 'node_modules/vue/index.js'), descriptor)).toBe(true)
    expect(isIgnoredWatchPath(
      join(projectRoot, 'node_modules/.pnpm/vue@3.5.13/node_modules/vue/dist/vue.runtime.esm-bundler.mjs'),
      descriptor,
    )).toBe(true)
    expect(isIgnoredWatchPath(join(projectRoot, 'src/foo.ts'), descriptor)).toBe(false)
  })
})

function dependencies (
  root: string,
  watcher: FakeWatcher,
  executeRound: BuildRunnerDependencies['executeRound'],
  plugins = [fh2Plugin()],
  emitReady = true,
): BuildRunnerDependencies {
  return {
    loadConfig: vi.fn(async () => ({
      content: { plugins },
      filePath: join(root, 'rsbuild.config.ts'),
    })) as unknown as typeof loadConfig,
    createRsbuild: vi.fn() as unknown as typeof createRsbuild,
    watch: () => {
      watcher.started = true
      if (emitReady) {
        queueMicrotask(() => {
          watcher.ready = true
          watcher.emit('ready')
        })
      }
      return watcher as never
    },
    executeRound,
    validate: vi.fn() as never,
    generate: vi.fn() as never,
  }
}

class FakeWatcher extends EventEmitter {
  started = false
  ready = false
  add = vi.fn((_paths: string | string[]) => this)
  close = vi.fn(async () => {
    this.removeAllListeners()
  })
}

function successfulRound (watchDependencies: readonly string[] = []): {
  readonly manifest: PluginManifest;
  readonly diagnostics: readonly [];
  readonly watchDependencies: readonly string[];
} {
  return { manifest: resultManifest, diagnostics: [], watchDependencies }
}

function deferred<T> (): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function project (): string {
  const root = mkdtempSync(join(tmpdir(), 'fh2-build-runner-'))
  directories.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'fh2-plugin.json'), '{}')
  writeFileSync(join(root, 'src/plugin.ts'), '')
  return root
}
