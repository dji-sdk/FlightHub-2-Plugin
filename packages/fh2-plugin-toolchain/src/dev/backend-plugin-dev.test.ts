// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { EventEmitter, once } from 'node:events'
import { Server, createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runBackendPluginDev } from './backend-plugin-dev.js'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('backend plugin dev', () => {
  it.each([['SIGINT', 130], ['SIGTERM', 0]] as const)('启动本地 invoke Gateway 并完成状态闭环，%s 干净退出', async (signal, code) => {
    const fixture = await createLegacyBackendFixture()
    const signals = new EventEmitter()
    const chunks: string[] = []
    const stdout = {
      write (chunk: string) {
        chunks.push(chunk)
        return true
      },
    }
    const stderr = {
      write (chunk: string) {
        chunks.push(chunk)
        return true
      },
    }

    const exit = runBackendPluginDev({
      pluginRoot: fixture.pluginRoot,
      port: 0,
      watch: false,
      stdout,
      stderr,
      signals,
    })

    const url = await waitForGatewayUrl(chunks)
    expect(await readFile(join(fixture.pluginRoot, 'types/handler.d.ts'), 'utf8'))
      .toContain('declare const store: import(\'fh2-plugin-sdk/backend\').StoreApi')
    expect(existsSync(join(fixture.pluginRoot, 'types/entities.d.ts'))).toBe(false)
    expect(existsSync(join(fixture.pluginRoot, 'types/storage.ts'))).toBe(false)
    const invoke = async (handler: string, input: Record<string, unknown>) => await fetch(`${url}/plugin-api/plugin/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plugin-token': 'mock-plugin-token' },
      body: JSON.stringify({ pluginId: 'exp_dev_backend', handler, input }),
    })

    const getResponse = await invoke('h_items_get', {})
    expect(await getResponse.json()).toEqual({ code: 0, message: 'success', data: { total: 0 } })

    const conflictResponse = await invoke('h_items_conflict', {})
    expect(conflictResponse.status).toBe(409)
    expect(await conflictResponse.json()).toMatchObject({ code: 20001 })

    signals.emit(signal)
    await expect(exit).resolves.toBe(code)
    expect(signals.listenerCount('SIGINT')).toBe(0)
    expect(signals.listenerCount('SIGTERM')).toBe(0)
    await expectPortReleased(url)
  })

  it('未完请求体在 SIGTERM 后被回收，不让活动 HTTP 连接拖住 server.close', async () => {
    const fixture = await createLegacyBackendFixture()
    const signals = new EventEmitter()
    const chunks: string[] = []
    const exit = runBackendPluginDev({ pluginRoot: fixture.pluginRoot, port: 0, watch: false, stdout: { write: chunk => chunks.push(chunk) }, stderr: { write: chunk => chunks.push(chunk) }, signals })
    const url = await waitForGatewayUrl(chunks)
    const pending = request(`${url}/plugin-api/plugin/invoke`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1024', 'x-plugin-token': 'mock-plugin-token', expect: '100-continue' } })
    pending.on('error', () => {})
    const onExit = vi.fn()
    void exit.then(onExit)
    try {
      const continued = once(pending, 'continue')
      pending.flushHeaders()
      await continued
      pending.write('{')
      signals.emit('SIGTERM')
      await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(0))
      expect(signals.listenerCount('SIGINT')).toBe(0)
      expect(signals.listenerCount('SIGTERM')).toBe(0)
      await expectPortReleased(url)
    } finally {
      pending.destroy()
      await exit
    }
  })

  it.each([['SIGINT', 130], ['SIGTERM', 0]] as const)('server.close 尚未回调时第二次 %s 强退，不重复关闭', async (signal, code) => {
    const fixture = await createLegacyBackendFixture()
    const signals = new EventEmitter()
    const chunks: string[] = []
    const forceExit = vi.fn()
    const closeServer = Server.prototype.close
    let completeClose: (() => void) | undefined
    const close = vi.spyOn(Server.prototype, 'close').mockImplementation(function (this: Server, callback) {
      return closeServer.call(this, (error?: Error) => {
        completeClose = () => callback?.(error)
      })
    })
    const exit = runBackendPluginDev({ pluginRoot: fixture.pluginRoot, port: 0, watch: false, stdout: { write: chunk => chunks.push(chunk) }, stderr: { write: chunk => chunks.push(chunk) }, signals, forceExit })
    await waitForGatewayUrl(chunks)
    try {
      signals.emit(signal)
      await vi.waitFor(() => expect(completeClose).toBeDefined())
      signals.emit(signal)
      expect(forceExit).toHaveBeenCalledOnce()
      expect(forceExit).toHaveBeenCalledWith(code)
      expect(close).toHaveBeenCalledOnce()
    } finally {
      completeClose?.()
      await exit
      close.mockRestore()
    }
    expect(signals.listenerCount('SIGINT')).toBe(0)
    expect(signals.listenerCount('SIGTERM')).toBe(0)
  })

  it('监听端口失败返回 1 并移除 SIGINT/SIGTERM 监听', async () => {
    const fixture = await createLegacyBackendFixture()
    const occupied = createServer()
    occupied.listen(0, '127.0.0.1')
    await once(occupied, 'listening')
    const signals = new EventEmitter()
    const chunks: string[] = []
    try {
      expect(await runBackendPluginDev({ pluginRoot: fixture.pluginRoot, port: (occupied.address() as { port: number }).port, watch: false, stdout: { write: chunk => chunks.push(chunk) }, stderr: { write: chunk => chunks.push(chunk) }, signals })).toBe(1)
      expect(chunks.join('')).toContain('FH2_BACKEND_DEV_START_FAILED')
      expect(signals.listenerCount('SIGINT')).toBe(0)
      expect(signals.listenerCount('SIGTERM')).toBe(0)
    } finally {
      await new Promise<void>(resolveClose => occupied.close(() => resolveClose()))
    }
  })

  it('build 失败时报 FH2_BACKEND_DEV_START_FAILED 并返回 1', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-backend-dev-bad-'))
    roots.push(root)
    const pluginRoot = join(root, 'backend', 'exp_bad_backend')
    await mkdir(join(pluginRoot, 'handlers/items'), { recursive: true })
    await writeFile(join(pluginRoot, 'handlers/items/get.js'), 'function h_items_get() { return {} }\n')
    // flows 指向不存在的 Workflow 文件 → 契约校验失败 → Build 抛 PluginBuildError。
    await writeFile(join(pluginRoot, 'fh2-plugin.json'), JSON.stringify({
      pluginId: 'exp_bad_backend',
      name: '坏插件',
      version: '0.1.0',
      flows: ['workflows/missing.json'],
      allowlist: ['data:read'],
      entities: [{ name: 'item', fields: { title: { type: 'string' } } }],
    }))

    const signals = new EventEmitter()
    const stderrChunks: string[] = []
    const exit = runBackendPluginDev({
      pluginRoot,
      port: 0,
      watch: false,
      stdout: { write: () => true },
      stderr: {
        write (chunk: string) {
          stderrChunks.push(chunk)
          return true
        },
      },
      signals,
    })

    await expect(exit).resolves.toBe(1)
    expect(stderrChunks.join('')).toContain('FH2_BACKEND_DEV_START_FAILED')
  })
})

async function expectPortReleased (url: string): Promise<void> {
  const server = createServer()
  try {
    server.listen(Number(new URL(url).port), '127.0.0.1')
    await once(server, 'listening')
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  }
}

async function waitForGatewayUrl (chunks: readonly string[]): Promise<string> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const match = chunks.join('').match(/http:\/\/127\.0\.0\.1:(\d+)/)
    if (match !== null) return match[0]!
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
  throw new Error(`Gateway 未在超时内启动：${chunks.join('')}`)
}

async function createLegacyBackendFixture (): Promise<{ readonly pluginRoot: string }> {
  const capabilityRoot = await mkdtemp(join(tmpdir(), 'fh2-backend-dev-'))
  roots.push(capabilityRoot)
  await mkdir(join(capabilityRoot, 'mock/fixtures'), { recursive: true })
  await writeFile(join(capabilityRoot, 'mock/fixtures/default.json'), JSON.stringify({ entities: { item: [] } }))
  const pluginRoot = join(capabilityRoot, 'backend', 'exp_dev_backend')
  await mkdir(join(pluginRoot, 'handlers/items'), { recursive: true })
  await writeFile(join(pluginRoot, 'fh2-plugin.json'), JSON.stringify({
    pluginId: 'exp_dev_backend',
    name: '后端 Dev 演示',
    version: '0.1.0',
    allowlist: ['data:read', 'data:write'],
    entities: [{ name: 'item', fields: { title: { type: 'string' } } }],
  }))
  await writeFile(join(pluginRoot, 'handlers/items/get.js'), `
function h_items_get(_input, _ctx) {
  var page = store.query('item', {}, { limit: 10 });
  if (!page.ok) throw { code: 'INTERNAL', message: '查询失败' };
  return { total: page.data.total };
}
`)
  await writeFile(join(pluginRoot, 'handlers/items/conflict.js'), `
function h_items_conflict(_input, _ctx) {
  throw { code: 'CONFLICT', message: '当前状态不允许执行该操作' };
}
`)
  return { pluginRoot }
}
