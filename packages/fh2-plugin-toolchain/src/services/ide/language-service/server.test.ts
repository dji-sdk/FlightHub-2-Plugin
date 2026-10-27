// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startIdeServer } from '../../../serve/ide-server.js'
import type { IdeServer } from '../../../serve/ide-server.js'
import { fileUriToPath, pathToFileUri } from './server.js'

/**
 * L2 真实纵切：WebSocket 握手（token/sessionId）→ 桥接到 tsserver →
 * didOpen → publishDiagnostics 回传；非法 token / 旧 session 被拒。
 */
let server: IdeServer
let projectRoot = ''
const roots: string[] = []

beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'fh2-lsp-e2e-'))
  roots.push(projectRoot)
  await mkdir(join(projectRoot, 'src'), { recursive: true })
  await writeFile(join(projectRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
    include: ['src/**/*.ts'],
  }))
  await writeFile(join(projectRoot, 'src/main.ts'), 'const value: number = "boom"\nexport { value }\n')

  const webRoot = await mkdtemp(join(tmpdir(), 'fh2-lsp-web-'))
  roots.push(webRoot)
  await mkdir(webRoot, { recursive: true })
  await writeFile(join(webRoot, 'index.html'), '<html><head></head><body>ide</body></html>')
  server = await startIdeServer({ root: projectRoot, webRoot, port: 0, watch: false })
}, 60_000)

afterAll(async () => {
  await server?.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
}

function rpcFrame (payload: unknown): Buffer {
  const body = JSON.stringify(payload)
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

/** 从 ws 二进制流中解析 Content-Length 帧 + 握手 JSON 帧。 */
class FrameReader {
  private buffer = ''
  private frames: unknown[] = []

  push (chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    for (;;) {
      const index = this.buffer.indexOf('\r\n\r\n')
      if (index === -1) break
      const match = /Content-Length:\s*(\d+)/.exec(this.buffer.slice(0, index))
      if (match === null) {
        this.buffer = this.buffer.slice(index + 4)
        continue
      }
      const length = Number(match[1])
      if (this.buffer.length < index + 4 + length) break
      const body = this.buffer.slice(index + 4, index + 4 + length)
      this.buffer = this.buffer.slice(index + 4 + length)
      try {
        this.frames.push(JSON.parse(body))
      } catch {
        // 忽略
      }
    }
  }

  /** 非 JSON-RPC 的裸 JSON 握手帧（整包）。 */
  pushRaw (chunk: Buffer): void {
    try {
      this.frames.push(JSON.parse(chunk.toString('utf8')))
    } catch {
      // 忽略
    }
  }

  get all (): readonly unknown[] {
    return this.frames
  }
}

function connectLsp (): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${server.port}/lsp`)
}

describe('lSP WebSocket 桥（L2）', () => {
  it('握手鉴权 + didOpen → 真实 tsserver 诊断回传（0-based 行列）', { timeout: 90_000 }, async () => {
    const workspace = await (await fetch(`${server.url}/api/workspace`, {
      headers: { 'x-fh2-ide-token': server.token },
    })).json() as { data?: { sessionId?: string } }
    const sessionId = workspace.data?.sessionId ?? ''

    const ws = connectLsp()
    const reader = new FrameReader()
    const opened = new Promise<void>((resolve) => {
      ws.on('open', resolve)
    })
    // 混合流：握手帧是裸 JSON，之后的帧是 Content-Length 二进制。
    ws.on('message', (data, isBinary) => {
      if (isBinary) reader.push(data as Buffer)
      else reader.pushRaw(data as Buffer)
    })
    await opened

    ws.send(JSON.stringify({
      type: 'hello',
      protocol: 'fh2-lsp',
      protocolVersion: 1,
      token: server.token,
      workspaceSessionId: sessionId,
    }))

    // 等 hello-accepted。
    await waitFor(() => reader.all.some(frame => (frame as { type?: string }).type === 'hello-accepted'), 10_000)

    // LSP initialize + didOpen（真实 tsserver）。
    ws.send(rpcFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      processId: process.pid,
      rootUri: `file://${projectRoot}`,
      capabilities: { textDocument: { publishDiagnostics: {} } },
    } }))
    ws.send(rpcFrame({ jsonrpc: '2.0', method: 'initialized', params: {} }))
    ws.send(rpcFrame({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
      textDocument: {
        uri: `file://${join(projectRoot, 'src/main.ts')}`,
        languageId: 'typescript',
        version: 1,
        text: 'const value: number = "boom"\nexport { value }\n',
      },
    } }))

    // 等待 publishDiagnostics（非空）。
    const found = await waitFor(() => {
      const notification = reader.all.find(frame => (frame as JsonRpcMessage).method === 'textDocument/publishDiagnostics'
        && Array.isArray((frame as { params?: { diagnostics?: unknown[] } }).params?.diagnostics)
        && ((frame as { params: { diagnostics: unknown[] } }).params.diagnostics.length > 0))
      return notification
    }, 45_000)

    const params = (found as { params: { diagnostics: { range: { start: { line: number; character: number } }; message: string }[] } }).params
    expect(params.diagnostics[0]!.range.start.line).toBe(0)
    expect(params.diagnostics[0]!.message).toContain('not assignable')
    ws.close()
  })

  it('非法 token 与旧 session 的握手被拒（rejected 帧 + 连接关闭）', { timeout: 30_000 }, async () => {
    // 非法 token。
    const badToken = connectLsp()
    const badFrames: unknown[] = []
    const badClosed = new Promise<void>(resolve => badToken.on('close', resolve))
    badToken.on('message', (data) => {
      try {
        badFrames.push(JSON.parse(data.toString('utf8')))
      } catch { /* ignore */ }
    })
    await new Promise<void>(resolve => badToken.on('open', resolve))
    badToken.send(JSON.stringify({ type: 'hello', protocol: 'fh2-lsp', protocolVersion: 1, token: 'wrong', workspaceSessionId: 'any' }))
    await badClosed
    expect((badFrames[0] as { reason?: string }).reason).toBe('unauthorized')

    // 旧 session。
    const staleSession = connectLsp()
    const staleFrames: unknown[] = []
    const staleClosed = new Promise<void>(resolve => staleSession.on('close', resolve))
    staleSession.on('message', (data) => {
      try {
        staleFrames.push(JSON.parse(data.toString('utf8')))
      } catch { /* ignore */ }
    })
    await new Promise<void>(resolve => staleSession.on('open', resolve))
    staleSession.send(JSON.stringify({ type: 'hello', protocol: 'fh2-lsp', protocolVersion: 1, token: server.token, workspaceSessionId: 'stale-session' }))
    await staleClosed
    expect((staleFrames[0] as { reason?: string }).reason).toBe('session-mismatch')
  })

  it('hello/resume 缺 token 或空 token：在握手窗口内显式拒绝并关闭，不再当 JSON-RPC 缓冲', { timeout: 30_000 }, async () => {
    for (const [type, tokenField] of [
      ['hello', 'missing'],
      ['hello', 'empty'],
      ['resume', 'missing'],
      ['resume', 'empty'],
    ] as const) {
      const ws = connectLsp()
      const frames: unknown[] = []
      const closed = new Promise<void>(resolve => ws.on('close', resolve))
      ws.on('message', (data) => {
        try {
          frames.push(JSON.parse(data.toString('utf8')))
        } catch { /* ignore */ }
      })
      await new Promise<void>(resolve => ws.on('open', resolve))
      const base: Record<string, unknown> = { type, protocol: 'fh2-lsp', protocolVersion: 1, workspaceSessionId: 'any' }
      if (type === 'resume') base.sessionId = 'some-session'
      if (tokenField === 'empty') base.token = ''
      // tokenField === 'missing' 时整个字段不发送
      ws.send(JSON.stringify(base))
      await closed
      const rejected = frames.find(frame => (frame as { type?: string }).type === 'rejected')
      expect((rejected as { reason?: string }).reason).toBe('unauthorized')
      // 不得进入语言协议会话
      expect(frames.some(frame => (frame as { type?: string }).type?.endsWith('accepted'))).toBe(false)
    }
  })
})

async function waitFor<T> (predicate: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

describe('file URI 转换（Windows 兼容，node:url 标准实现）', () => {
  it('posix 路径与 URI 往返（空格、非 ASCII 按 RFC 编码）', () => {
    const uri = pathToFileUri('/tmp/项目 x/a b.ts')
    expect(uri).toBe('file:///tmp/%E9%A1%B9%E7%9B%AE%20x/a%20b.ts')
    expect(fileUriToPath(uri)).toBe('/tmp/项目 x/a b.ts')
  })

  it('非 file:// URI 返回 undefined（如 untitled:），调用方跳过而非拿到垃圾路径', () => {
    expect(fileUriToPath('untitled:Untitled-1')).toBeUndefined()
    expect(fileUriToPath('https://example.com/x.ts')).toBeUndefined()
  })

  it('非法 file URI 返回 undefined 而非抛错（单个坏 URI 不能崩掉语言服务）', () => {
    expect(fileUriToPath('file://bad')).toBeUndefined()
    expect(fileUriToPath('file:///')).toBeDefined()
  })

  it.skipIf(process.platform !== 'win32')('win32 盘符路径往返（Windows 上激活）', () => {
    const uri = pathToFileUri('C:\\dev\\项目\\a b.ts')
    expect(uri).toBe('file:///C:/dev/%E9%A1%B9%E7%9B%AE/a%20b.ts')
    expect(fileUriToPath(uri)).toBe('C:\\dev\\项目\\a b.ts')
  })
})
