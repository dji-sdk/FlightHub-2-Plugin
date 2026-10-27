// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

/**
 * C0a（LSP 前置验证）：typescript-language-server 真实 stdio 链路。
 *
 * 验证事实（记录进 findings）：
 * - tsserver 经 typescript-language-server 暴露 LSP：initialize/didOpen/publishDiagnostics 可用；
 * - 诊断行列是 0-based（LSP 语义），进入统一 Problems 前须 +1 转换；
 * - Monaco 0.52.2（web-ide 锁定）与 monaco-languageclient@10.7.0 组合的客户端接线是 L3 范围，
 *   本测试只锁服务端事实。
 */
const require = createRequire(import.meta.url)

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Diagnostic {
  range: { start: { line: number; character: number } };
  message: string;
  severity: number;
}

function createLspReader (onMessage: (message: JsonRpcMessage) => void): (chunk: Buffer) => void {
  let buffer: Buffer = Buffer.alloc(0)
  return (chunk) => {
    // Content-Length 按字节计数，完整帧收到后才解码，避免截断 UTF-8 字符。
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const index = buffer.indexOf('\r\n\r\n')
      if (index === -1) break
      const header = buffer.subarray(0, index).toString('ascii')
      const lengthMatch = /Content-Length:\s*(\d+)/.exec(header)
      if (lengthMatch === null) {
        buffer = buffer.subarray(index + 4)
        continue
      }
      const length = Number(lengthMatch[1])
      if (buffer.length < index + 4 + length) break
      const body = buffer.subarray(index + 4, index + 4 + length)
      buffer = buffer.subarray(index + 4 + length)
      try {
        onMessage(JSON.parse(body.toString('utf8')) as JsonRpcMessage)
      } catch {
        // 非 JSON 帧：忽略
      }
    }
  }
}

function findDocumentDiagnostics (notifications: JsonRpcMessage[], uri: string): Diagnostic[] | undefined {
  const notification = notifications.find((item) => {
    const params = item.params as { uri?: string; diagnostics?: Diagnostic[] } | undefined
    return item.method === 'textDocument/publishDiagnostics'
      && params?.uri === uri
      && (params.diagnostics?.length ?? 0) > 0
  })
  return (notification?.params as { diagnostics: Diagnostic[] } | undefined)?.diagnostics
}

describe('lsp 诊断通知选择', () => {
  const uri = 'file:///fixture/src/main.ts'
  const diagnostics: Diagnostic[] = [{ range: { start: { line: 0, character: 6 } }, message: 'not assignable', severity: 1 }]
  const publish = (uri: string, diagnostics: Diagnostic[]): JsonRpcMessage => ({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: { uri, diagnostics },
  })

  it('首帧为空或属于其他文件时，仍能读取后续目标文件的非空诊断', () => {
    expect(findDocumentDiagnostics([
      publish(uri, []),
      publish('file:///fixture/src/other.ts', [{ ...diagnostics[0]!, message: 'other file' }]),
      publish(uri, diagnostics),
    ], uri)).toEqual(diagnostics)
  })

  it('其他文件先发非空诊断时，读取目标文件的诊断', () => {
    expect(findDocumentDiagnostics([
      publish('file:///fixture/src/other.ts', [{ ...diagnostics[0]!, message: 'other file' }]),
      publish(uri, diagnostics),
    ], uri)).toEqual(diagnostics)
  })

  it('目标文件尚无非空诊断时继续等待', () => {
    expect(findDocumentDiagnostics([
      publish('file:///fixture/src/other.ts', diagnostics),
      publish(uri, []),
    ], uri)).toBeUndefined()
  })
})

describe('c0a：typescript-language-server 真实链路', () => {
  it('initialize → didOpen → publishDiagnostics 携带 0-based 行列的真实 TS 错误', { timeout: 60_000 }, async () => {
    const messages: JsonRpcMessage[] = [
      { jsonrpc: '2.0', id: 1, result: { path: '/public source 中文/typescript' } },
      { jsonrpc: '2.0', method: 'window/logMessage', params: { message: '使用中文路径' } },
    ]
    const frames = messages.map((message) => {
      const body = JSON.stringify(message)
      return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    })
    for (const chunks of [
      frames,
      [Buffer.concat(frames)],
      Array.from(Buffer.concat(frames), byte => Buffer.from([byte])),
    ]) {
      const received: JsonRpcMessage[] = []
      const readFrame = createLspReader(message => received.push(message))
      for (const chunk of chunks.slice(0, -1)) readFrame(chunk)
      expect(received).toEqual(chunks.length === 1 ? [] : [messages[0]])
      readFrame(chunks[chunks.length - 1]!)
      expect(received).toEqual(messages)
    }

    const root = await mkdtemp(join(tmpdir(), 'fh2-lsp-spike-'))
    let childProcess: ReturnType<typeof spawn> | undefined
    const requestTimers = new Set<ReturnType<typeof setTimeout>>()
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
        include: ['src/**/*.ts'],
      }))
      const filePath = join(root, 'src/main.ts')
      await writeFile(filePath, 'const value: number = "boom"\nexport { value }\n')

      const cli = require.resolve('typescript-language-server/lib/cli.mjs')
      const child = spawn(process.execPath, [cli, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] })
      childProcess = child

      const pending = new Map<number, (result: unknown) => void>()
      const notifications: JsonRpcMessage[] = []
      let nextId = 1

      child.stdout.on('data', createLspReader((parsed) => {
        if (parsed.id !== undefined && pending.has(Number(parsed.id))) {
          pending.get(Number(parsed.id))!(parsed)
          pending.delete(Number(parsed.id))
        } else if (parsed.method !== undefined) {
          notifications.push(parsed)
        }
      }))
      let stderrText = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString('utf8')
      })

      const send = (payload: JsonRpcMessage): void => {
        const body = JSON.stringify(payload)
        child.stdin!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
      }
      const request = (method: string, params: unknown): Promise<JsonRpcMessage> =>
        new Promise((resolve, reject) => {
          const id = nextId++
          const timer = setTimeout(() => {
            requestTimers.delete(timer)
            if (pending.has(id)) {
              pending.delete(id)
              reject(new Error(`LSP 请求超时：${method}（stderr: ${stderrText.slice(0, 400)}）`))
            }
          }, 30_000)
          requestTimers.add(timer)
          pending.set(id, (result) => {
            clearTimeout(timer)
            requestTimers.delete(timer)
            resolve(result as JsonRpcMessage)
          })
          send({ jsonrpc: '2.0', id, method, params })
        })

      // initialize（rootUri 指向 fixture）
      const init = await request('initialize', {
        processId: process.pid,
        rootUri: `file://${root}`,
        // tsl 6.x 需要客户端声明 publishDiagnostics 能力才推送诊断。
        capabilities: { textDocument: { publishDiagnostics: {} } },
      })
      expect(init.error).toBeUndefined()
      send({ jsonrpc: '2.0', method: 'initialized', params: {} })

      // didOpen 一份带类型错误的文件
      send({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: `file://${filePath}`,
            languageId: 'typescript',
            version: 1,
            text: 'const value: number = "boom"\nexport { value }\n',
          },
        },
      })

      // 等待 publishDiagnostics（首帧可能带空诊断，等待有内容的帧）。
      const deadline = Date.now() + 30_000
      let diagnostics: Diagnostic[] | undefined
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 200))
        diagnostics = findDocumentDiagnostics(notifications, `file://${filePath}`)
        if (diagnostics !== undefined) break
      }
      expect(diagnostics, `LSP 诊断超时（notifications: ${JSON.stringify(notifications)}, stderr: ${stderrText.slice(0, 400)}）`).toBeDefined()
      expect(diagnostics!.length).toBeGreaterThan(0)
      // LSP 0-based：第 1 行 → line 0（转换证据）
      expect(diagnostics![0]!.range.start.line).toBe(0)
      expect(diagnostics![0]!.message).toContain('not assignable')
    } finally {
      for (const timer of requestTimers) clearTimeout(timer)
      if (childProcess !== undefined && childProcess.exitCode === null && childProcess.signalCode === null) {
        const closed = new Promise<void>(resolve => childProcess!.once('close', () => resolve()))
        childProcess.kill()
        await closed
      }
      await rm(root, { recursive: true, force: true })
    }
  })
})
