// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FSWatcher } from 'chokidar'
import { CONTEXT_PRECEDENCE, PROJECT_PATHS } from '../project-policy.js'
import { isWatchIgnored, startIdeServer } from './ide-server.js'
import type { IdeServer } from './ide-server.js'

const { watches, ready } = vi.hoisted(() => ({
  watches: [] as FSWatcher[],
  ready: [] as Promise<void>[],
}))

vi.mock('chokidar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('chokidar')>()
  const watch: typeof actual.watch = (paths, options) => {
    const watcher = actual.watch(paths, options)
    watches.push(watcher)
    ready.push(new Promise(resolveReady => watcher.once('ready', resolveReady)))
    return watcher
  }
  return { ...actual, watch }
})

const roots: string[] = []
const servers: IdeServer[] = []

function fixture (): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'fh2-watcher-output-')))
  roots.push(base)
  return base
}

function write (root: string, file: string, content: string): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(watches.splice(0).map(watcher => watcher.close()))
  ready.splice(0)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('工程产物监听范围', () => {
  it.each(CONTEXT_PRECEDENCE.map(({ markerFile }) => markerFile))('仅排除 %s 标记工程根的生成目录', (marker) => {
    const root = fixture()
    write(root, marker, '{ incomplete manifest')
    for (const directory of ['release', '.dist.fh2-next-id', '.dist.fh2-backup-id', '.dist.fh2-capability-backup-id']) {
      write(root, `${directory}/asset.js`, 'generated')
      expect(isWatchIgnored(root, join(root, directory))).toBe(true)
      expect(isWatchIgnored(root, join(root, directory, 'asset.js'))).toBe(true)
    }
    for (const path of ['src/release/main.ts', 'handlers/release/get.ts', 'src/.dist.fh2-notes.ts', '.dist.fh2-notes.ts', 'release.md']) {
      write(root, path, 'source')
      expect(isWatchIgnored(root, join(root, path))).toBe(false)
    }
    expect(isWatchIgnored(root, join(root, 'src/release'))).toBe(false)
    expect(isWatchIgnored(root, join(root, 'handlers/release'))).toBe(false)
  })

  it('普通目录下的 release 以及名为 release 的文件不是工程产物', () => {
    const root = fixture()
    write(root, 'release/source.ts', 'source')
    expect(isWatchIgnored(root, join(root, 'release'))).toBe(false)
    expect(isWatchIgnored(root, join(root, 'release/source.ts'))).toBe(false)
    const plugin = join(root, 'plugin')
    write(plugin, PROJECT_PATHS.sourceManifest, '{}')
    write(plugin, 'release', 'ordinary file')
    expect(isWatchIgnored(root, join(plugin, 'release'))).toBe(false)
  })

  it('从损坏工作区真实监听时仍排除内层能力和前后端成员的默认产物', async () => {
    const root = fixture()
    write(root, PROJECT_PATHS.packageManifest, '{ incomplete manifest')
    write(root, 'exp_cap/capabilities.json', '{}')
    const generatedDirectories: string[] = []
    for (const side of [PROJECT_PATHS.frontend, PROJECT_PATHS.backend]) {
      const plugin = join(root, 'exp_cap', side, `exp_${side}`)
      write(plugin, PROJECT_PATHS.sourceManifest, '{}')
      for (const generated of ['release', '.dist.fh2-next-id']) {
        write(plugin, `${generated}/file.js`, 'generated')
        expect(isWatchIgnored(root, join(plugin, generated))).toBe(true)
        expect(isWatchIgnored(root, join(plugin, generated, 'file.js'))).toBe(true)
        generatedDirectories.push(join(plugin, generated))
      }
      write(plugin, 'src/release/main.ts', 'source')
      expect(isWatchIgnored(root, join(plugin, 'src/release/main.ts'))).toBe(false)
    }
    write(root, 'exp_cap/release/package.zip', 'generated')
    expect(isWatchIgnored(root, join(root, 'exp_cap/release'))).toBe(true)
    generatedDirectories.push(join(root, 'exp_cap/release'))
    write(root, 'web/index.html', '<html><head></head><body></body></html>')
    const server = await startIdeServer({ root, webRoot: join(root, 'web'), port: 0 })
    servers.push(server)
    await ready[0]
    const watched = Object.keys(watches[0]!.getWatched()).map(path => resolve(path))
    for (const generated of generatedDirectories) {
      expect(watched.some(path => path === generated || path.startsWith(`${generated}/`) || path.startsWith(`${generated}\\`))).toBe(false)
    }
    for (const side of [PROJECT_PATHS.frontend, PROJECT_PATHS.backend]) {
      expect(watched).toContain(join(root, 'exp_cap', side, `exp_${side}`, 'src/release'))
    }
  })

  it('真实 watcher 不为生成目录建立监听，源码变化与 IDE 原子保存仍推送 SSE', async () => {
    const base = fixture()
    const root = join(base, 'exp_watch')
    const webRoot = join(base, 'web')
    write(root, PROJECT_PATHS.sourceManifest, '{"id":"exp_watch"}')
    const source = 'src/release/main.ts'
    const backendSource = 'handlers/release/get.ts'
    write(root, source, 'export const value = 0\n')
    write(root, backendSource, 'export const get = 0\n')
    write(root, 'release/exp_package/workflows/flow.json', '{}')
    write(root, '.dist.fh2-next-initial/views/view.js', 'generated')
    write(webRoot, 'index.html', '<html><head></head><body></body></html>')
    const server = await startIdeServer({ root, webRoot, port: 0 })
    servers.push(server)
    await ready[0]
    const watcher = watches[0]!
    const watched = Object.keys(watcher.getWatched()).map(path => relative(root, resolve(path)).replaceAll('\\', '/'))
    expect(watched).toContain('src/release')
    expect(watched).toContain('handlers/release')
    expect(watched.some(path => path === 'release' || path.startsWith('release/') || path.startsWith('.dist.fh2-'))).toBe(false)

    const abort = new AbortController()
    const response = await fetch(`${server.url}/api/events?token=${server.token}`, { signal: abort.signal })
    const reader = response.body!.getReader()
    const received: string[] = []
    const decoder = new TextDecoder()
    const reading = (async () => {
      let buffer = ''
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            if (/^event: fs$/m.test(frame)) {
              const data = /^data: (.+)$/m.exec(frame)![1]!
              received.push(JSON.parse(data).path)
            }
            boundary = buffer.indexOf('\n\n')
          }
        }
      } catch {
        if (!abort.signal.aborted) throw new Error('SSE unexpectedly closed')
      }
    })()

    const api = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, {
      ...init,
      headers: { 'x-fh2-ide-token': server.token, 'content-type': 'application/json', ...init.headers },
    })
    try {
      write(root, source, 'export const value = 1\n')
      write(root, backendSource, 'export const get = 1\n')
      await vi.waitFor(() => {
        expect(received).toContain(source)
        expect(received).toContain(backendSource)
      })
      const old = await (await api(`/api/file?path=${encodeURIComponent(source)}`)).json()
      received.length = 0
      const content = 'export const value = 2\n'
      const saved = await api('/api/file', {
        method: 'PUT',
        body: JSON.stringify({ path: source, content, expectedRevision: old.data.revision }),
      })
      expect(saved.status).toBe(200)
      await vi.waitFor(() => expect(received).toContain(source))
      expect(readFileSync(join(root, source), 'utf8')).toBe(content)
      const conflict = await api('/api/file', {
        method: 'PUT',
        body: JSON.stringify({ path: source, content: 'stale', expectedRevision: old.data.revision }),
      })
      expect(conflict.status).toBe(409)

      // 连续模拟两轮候选/旧产物提交；不暂停正常源码监听，也不改生产 Build/Pack。
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const candidate = `.dist.fh2-next-${cycle}`
        write(root, `${candidate}/views/view.js`, `build-${cycle}`)
        const output = join(root, 'dist')
        if (cycle > 0) renameSync(output, join(root, `.dist.fh2-backup-${cycle}`))
        renameSync(join(root, candidate), output)
        write(root, `release/.exp_package.fh2-pack-next-${cycle}/workflows/flow.json`, '{}')
        renameSync(join(root, 'release/exp_package'), join(root, `release/.exp_package.fh2-pack-backup-${cycle}`))
        renameSync(join(root, `release/.exp_package.fh2-pack-next-${cycle}`), join(root, 'release/exp_package'))
        received.length = 0
        write(root, source, `export const value = ${cycle + 3}\n`)
        await vi.waitFor(() => expect(received).toContain(source))
        const outputs = Object.keys(watcher.getWatched()).map(path => relative(root, resolve(path)).replaceAll('\\', '/'))
        expect(outputs.some(path => /^(?:release|dist)(?:\/|$)|^\.dist\.fh2-/.test(path))).toBe(false)
      }
    } finally {
      abort.abort()
      await reading
    }
  }, 20_000)
})
