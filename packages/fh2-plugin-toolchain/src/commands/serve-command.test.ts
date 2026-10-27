// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { IdeAssetsMissingError } from '../serve/ide-server.js'
import type { IdeServer, IdeServerOptions } from '../serve/ide-server.js'
import { parseServeArguments, runServeCommand } from './serve-command.js'
import type { ServeSignalSource } from './serve-command.js'

describe('serve command parser', () => {
  it('默认使用随机空闲端口与当前目录', () => {
    expect(parseServeArguments([], '/command/cwd')).toEqual({
      port: 0,
      root: '/command/cwd',
      noOpen: false,
      help: false,
    })
  })

  it('支持分离与等号两种参数形式，root 相对 cwd 解析', () => {
    expect(parseServeArguments(['--port', '35300', '--root', 'examples/demo'], '/command/cwd')).toEqual({
      port: 35_300,
      root: join('/command/cwd', 'examples/demo'),
      noOpen: false,
      help: false,
    })
    expect(parseServeArguments(['--port=35301', '--root=./demo', '--no-open'], '/command/cwd')).toEqual({
      port: 35_301,
      root: join('/command/cwd', 'demo'),
      noOpen: true,
      help: false,
    })
  })

  it.each([
    ['非数字', ['--port', 'abc']],
    ['零', ['--port', '0']],
    ['越界', ['--port', '65536']],
  ])('拒绝%s端口', (_name, args) => {
    expect(() => parseServeArguments(args, '/command/cwd')).toThrow('--port 必须是 1..65535 的整数')
  })

  it.each([
    ['未知参数', ['--unknown']],
    ['位置参数', ['serve.json']],
    ['缺值', ['--port']],
    ['重复', ['--root=a', '--root', 'b']],
    ['boolean 带值', ['--no-open=true']],
  ])('拒绝%s', (_name, args) => {
    expect(() => parseServeArguments(args, '/command/cwd')).toThrow()
  })
})

describe('serve command handler', () => {
  it('参数错误写 stderr 并退出 2', async () => {
    const io = capturedIo()
    const serve = vi.fn()
    const code = await runServeCommand({
      args: ['--port', 'abc'],
      cwd: '/cwd',
      ...io,
      signals: noopSignals(),
      serve,
    })
    expect(code).toBe(2)
    expect(serve).not.toHaveBeenCalled()
    expect(io.stdout.text).toBe('')
    expect(io.stderr.text).toContain('用法：fh2-plugin serve')
  })

  it('help 不启动服务', async () => {
    const io = capturedIo()
    const serve = vi.fn()
    const code = await runServeCommand({
      args: ['--help'],
      cwd: '/cwd',
      ...io,
      signals: noopSignals(),
      serve,
    })
    expect(code).toBe(0)
    expect(serve).not.toHaveBeenCalled()
    expect(io.stdout.text).toContain('用法：fh2-plugin serve')
    expect(io.stdout.text).toContain('--no-open')
  })

  it('前端产物缺失时给出可操作的报错并退出 1', async () => {
    const io = capturedIo()
    const code = await runServeCommand({
      args: ['--no-open'],
      cwd: '/cwd',
      ...io,
      signals: noopSignals(),
      resolveWebRoot: () => '/missing/web',
      serve: () => {
        throw new IdeAssetsMissingError('Web IDE 前端产物缺失：/missing/web/index.html')
      },
    })
    expect(code).toBe(1)
    expect(io.stderr.text).toContain('FH2_IDE_ASSETS_MISSING')
    expect(io.stderr.text).toContain('Web IDE 前端产物缺失')
  })

  it('端口占用等启动失败退出 1', async () => {
    const io = capturedIo()
    const code = await runServeCommand({
      args: ['--no-open', '--port', '35300'],
      cwd: '/cwd',
      ...io,
      signals: noopSignals(),
      resolveWebRoot: () => '/web',
      serve: () => {
        throw new Error('端口 35300 被占用，请释放或用 --port 指定其他端口')
      },
    })
    expect(code).toBe(1)
    expect(io.stderr.text).toContain('serve 启动失败')
    expect(io.stderr.text).toContain('35300 被占用')
  })

  it('打印地址与工作根，但绝不打印 token', async () => {
    const io = capturedIo()
    const signals = recordingSignals()
    const server = fakeServer()
    const run = runServeCommand({
      args: ['--no-open', '--root', 'demo'],
      cwd: '/cwd',
      ...io,
      signals,
      resolveWebRoot: () => '/web',
      serve: async (options: IdeServerOptions) => {
        expect(options).toMatchObject({ root: join('/cwd', 'demo'), webRoot: '/web', port: 0 })
        return server
      },
    })
    await server.started
    expect(io.stdout.text).toContain('Web IDE 已启动：http://127.0.0.1:35310')
    expect(io.stdout.text).toContain(join('/cwd', 'demo'))
    // token 只经由首页 HTML 下发，终端里不能出现，避免进日志或回滚缓冲。
    expect(io.stdout.text).not.toContain(server.token)
    expect(io.stderr.text).not.toContain(server.token)

    signals.emit('SIGINT')
    expect(await run).toBe(130)
    expect(server.closeCount).toBe(1)
  })

  it('默认打开浏览器，--no-open 时不打开', async () => {
    const openBrowser = vi.fn(async () => undefined)
    const signals = recordingSignals()
    const server = fakeServer()
    const run = runServeCommand({
      args: [],
      cwd: '/cwd',
      ...capturedIo(),
      signals,
      resolveWebRoot: () => '/web',
      serve: async () => server,
      openBrowser,
    })
    await server.started
    expect(openBrowser).toHaveBeenCalledWith('http://127.0.0.1:35310')
    signals.emit('SIGTERM')
    expect(await run).toBe(0)

    const skipped = vi.fn(async () => undefined)
    const otherSignals = recordingSignals()
    const otherServer = fakeServer()
    const skippedRun = runServeCommand({
      args: ['--no-open'],
      cwd: '/cwd',
      ...capturedIo(),
      signals: otherSignals,
      resolveWebRoot: () => '/web',
      serve: async () => otherServer,
      openBrowser: skipped,
    })
    await otherServer.started
    expect(skipped).not.toHaveBeenCalled()
    otherSignals.emit('SIGINT')
    await skippedRun
  })

  it('打开浏览器失败只告警，不影响服务运行', async () => {
    const io = capturedIo()
    const signals = recordingSignals()
    const server = fakeServer()
    const run = runServeCommand({
      args: [],
      cwd: '/cwd',
      ...io,
      signals,
      resolveWebRoot: () => '/web',
      serve: async () => server,
      openBrowser: async () => {
        throw new Error('no browser')
      },
    })
    await server.started
    expect(io.stderr.text).toContain('打开浏览器失败：no browser')
    expect(io.stdout.text).toContain('Web IDE 已启动')
    signals.emit('SIGINT')
    expect(await run).toBe(130)
  })

  it('第二个信号强制退出，并在退出时注销信号监听', async () => {
    const signals = recordingSignals()
    const server = fakeServer(true)
    const forceExit = vi.fn()
    const run = runServeCommand({
      args: ['--no-open'],
      cwd: '/cwd',
      ...capturedIo(),
      signals,
      resolveWebRoot: () => '/web',
      serve: async () => server,
      forceExit,
    })
    await server.started
    signals.emit('SIGINT')
    signals.emit('SIGINT')
    expect(forceExit).toHaveBeenCalledWith(130)

    server.release()
    expect(await run).toBe(130)
    expect(signals.listenerCount()).toBe(0)
  })
})

function fakeServer (holdClose = false): IdeServer & {
  readonly started: Promise<void>;
  closeCount: number;
  release: () => void;
} {
  let markStarted!: () => void
  const started = new Promise<void>((resolveStarted) => {
    markStarted = resolveStarted
  })
  let releaseClose!: () => void
  const closeGate = new Promise<void>((resolveGate) => {
    releaseClose = resolveGate
  })
  // 服务「已启动」= 命令已经把地址写进 stdout；用 microtask 让调用方先跑完打印。
  queueMicrotask(() => setTimeout(markStarted, 0))
  const server = {
    url: 'http://127.0.0.1:35310',
    token: 'f'.repeat(64),
    port: 35_310,
    root: '/cwd/demo',
    closeCount: 0,
    started,
    release: () => releaseClose(),
    async close () {
      server.closeCount += 1
      if (holdClose) await closeGate
    },
  }
  return server
}

function noopSignals (): ServeSignalSource {
  return { on: () => undefined, off: () => undefined }
}

function recordingSignals (): ServeSignalSource & {
  emit: (signal: 'SIGINT' | 'SIGTERM') => void;
  listenerCount: () => number;
} {
  const listeners = new Map<string, Set<() => void>>()
  return {
    on (signal, listener) {
      if (!listeners.has(signal)) listeners.set(signal, new Set())
      listeners.get(signal)!.add(listener)
    },
    off (signal, listener) {
      listeners.get(signal)?.delete(listener)
    },
    emit (signal) {
      for (const listener of [...(listeners.get(signal) ?? [])]) listener()
    },
    listenerCount () {
      let total = 0
      for (const set of listeners.values()) total += set.size
      return total
    },
  }
}

function capturedIo (): {
  readonly stdout: CaptureWriter;
  readonly stderr: CaptureWriter;
} {
  return { stdout: new CaptureWriter(), stderr: new CaptureWriter() }
}

class CaptureWriter {
  text = ''

  write (chunk: string): boolean {
    this.text += chunk
    return true
  }
}
