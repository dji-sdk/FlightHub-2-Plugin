// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_TREE_DEPTH } from '../services/ide/files.js'
import { startIdeServer } from './ide-server.js'

const { watchMock } = vi.hoisted(() => ({
  watchMock: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    close: vi.fn(async () => undefined),
  })),
}))

vi.mock('chokidar', () => ({ watch: watchMock }))

const roots: string[] = []

function fixtureRoot (): string {
  const root = mkdtempSync(join(tmpdir(), 'fh2-ide-watcher-'))
  roots.push(root)
  mkdirSync(join(root, 'web'), { recursive: true })
  writeFileSync(join(root, 'web/index.html'), '<html><head></head><body></body></html>')
  return root
}

afterEach(() => {
  watchMock.mockClear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('web ide watcher 启停策略', () => {
  it('unknown 根只展示 Start Center，不递归监听整个目录', async () => {
    const base = fixtureRoot()
    const unknown = join(base, 'not-a-plugin')
    mkdirSync(unknown)

    const server = await startIdeServer({
      root: unknown,
      webRoot: join(base, 'web'),
      port: 0,
    })
    try {
      expect(watchMock).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('有效工程才启动 watcher，并限制深度且不跟随符号链接', async () => {
    const base = fixtureRoot()
    const plugin = join(base, 'exp_watch')
    mkdirSync(plugin)
    writeFileSync(join(plugin, 'fh2-plugin.json'), '{"id":"exp_watch"}')

    const server = await startIdeServer({
      root: plugin,
      webRoot: join(base, 'web'),
      port: 0,
    })
    try {
      expect(watchMock).toHaveBeenCalledTimes(1)
      expect(watchMock).toHaveBeenCalledWith(plugin, expect.objectContaining({
        ignoreInitial: true,
        followSymlinks: false,
        depth: MAX_TREE_DEPTH,
      }))
    } finally {
      await server.close()
    }
  })
})
