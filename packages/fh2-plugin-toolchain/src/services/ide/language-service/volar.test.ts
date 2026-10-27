// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { companionResponseToLsp, resolveLspServerKind } from './server.js'

/** spawn 决策测试：不真起进程，注入假 child。 */
afterEach(() => {
  // 无需清理（未真 spawn）
})

describe('resolveLspServerKind（Volar 引入决策）', () => {
  it('纯 TS 工程选择 ts；含 .vue 的工程选择 vue', async () => {
    const tsRoot = await mkdtemp(join(tmpdir(), 'fh2-lsp-kind-ts-'))
    try {
      await mkdir(join(tsRoot, 'src'), { recursive: true })
      await writeFile(join(tsRoot, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_kind_ts', entry: './src/plugin.js', extensions: [] }))
      await writeFile(join(tsRoot, 'src/main.ts'), 'export const a = 1\n')
      expect(resolveLspServerKind(tsRoot)).toBe('ts')
    } finally {
      await rm(tsRoot, { recursive: true, force: true })
    }

    const vueRoot = await mkdtemp(join(tmpdir(), 'fh2-lsp-kind-vue-'))
    try {
      await mkdir(join(vueRoot, 'src'), { recursive: true })
      await writeFile(join(vueRoot, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_kind_vue', entry: './src/plugin.js', extensions: [] }))
      await writeFile(join(vueRoot, 'src/App.vue'), '<template><div/></template>\n')
      expect(resolveLspServerKind(vueRoot)).toBe('vue')
    } finally {
      await rm(vueRoot, { recursive: true, force: true })
    }
  })

  it('unknown 根（非工程）选择 ts（tsserver 对普通目录仍可用）', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'fh2-lsp-kind-plain-'))
    try {
      expect(resolveLspServerKind(plain)).toBe('ts')
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })

  it('握手注入 tsdk：含 .vue 工程的 initialize 帧被改写（不真起 Volar）', async () => {
    // 通过真实 spawn 但替换为回显 tsdk 的假 server：直接测试 prepareClientFrame 不可行（私有），
    // 这里用注入 spawnServer 的假进程捕获 stdin，断言转发的 initialize 携带 tsdk。
    const vueRoot = await mkdtemp(join(tmpdir(), 'fh2-lsp-inject-'))
    try {
      await mkdir(join(vueRoot, 'src'), { recursive: true })
      await writeFile(join(vueRoot, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_inject', entry: './src/plugin.js', extensions: [] }))
      await writeFile(join(vueRoot, 'src/App.vue'), '<template><div/></template>\n')

      const { startIdeServer } = await import('../../../serve/ide-server.js')
      const received: string[] = []
      const fakeChild = Object.assign(new EventEmitter(), {
        stdin: { write: (data: Buffer): boolean => {
          received.push(data.toString('utf8'))
          return true
        } },
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        exitCode: null,
        kill: (): boolean => {
          fakeChild.emit('exit', 0)
          return true
        },
      }) as unknown as ChildProcess

      const webRoot = await mkdtemp(join(tmpdir(), 'fh2-lsp-inject-web-'))
      await writeFile(join(webRoot, 'index.html'), '<html><head></head><body>ide</body></html>')
      try {
        const server = await startIdeServer({
          root: vueRoot,
          webRoot,
          port: 0,
          watch: false,
          lspSpawnServer: () => fakeChild,
        } as Parameters<typeof startIdeServer>[0])
        try {
          const WebSocket = (await import('ws')).default
          const ws = new WebSocket(`ws://127.0.0.1:${server.port}/lsp`)
          const frames: unknown[] = []
          // hello-accepted 是明确的 WebSocket text 控制帧。
          ws.on('message', (data, isBinary) => {
            void isBinary
            try {
              frames.push(JSON.parse(data.toString('utf8')))
            } catch { /* ignore */ }
          })
          await new Promise<void>(resolve => ws.on('open', resolve))
          const workspace = await (await fetch(`${server.url}/api/workspace`, {
            headers: { 'x-fh2-ide-token': server.token },
          })).json() as { data?: { sessionId?: string } }

          ws.send(JSON.stringify({
            type: 'hello',
            protocol: 'fh2-lsp',
            protocolVersion: 1,
            token: server.token,
            workspaceSessionId: workspace.data?.sessionId ?? '',
          }))
          await new Promise<void>(resolve => setTimeout(resolve, 300))

          // 客户端发 initialize：桥应改写后转发给（假）服务进程。
          const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: `file://${vueRoot}`, capabilities: {} } })
          ws.send(`Content-Length: ${Buffer.byteLength(initBody)}\r\n\r\n${initBody}`)
          await new Promise<void>(resolve => setTimeout(resolve, 300))

          // hello-accepted 携带 serverKind=vue
          const accepted = frames.find(frame => (frame as { type?: string }).type === 'hello-accepted') as { serverKind?: string } | undefined
          expect(accepted?.serverKind).toBe('vue')

          // 转发到子进程的 initialize 含 tsdk + hybridMode:false
          const initFrame = received.find(text => text.includes('"initialize"'))
          expect(initFrame).toBeDefined()
          const initParams = JSON.parse(initFrame!.slice(initFrame!.indexOf('\r\n\r\n') + 4)) as { params: { initializationOptions?: { typescript?: { tsdk?: string };vue?: { hybridMode?: boolean } } } }
          expect(initParams.params.initializationOptions?.typescript?.tsdk).toMatch(/typescript\/lib|typescript$/)
          expect(initParams.params.initializationOptions?.vue?.hybridMode).toBe(false)

          ws.close()
        } finally {
          await server.close()
        }
      } finally {
        await rm(webRoot, { recursive: true, force: true })
      }
    } finally {
      await rm(vueRoot, { recursive: true, force: true })
    }
    // ⓘ 超时放宽到 30s：本用例要起真实 HTTP + WebSocket 服务端并跑完一次 LSP 握手，
    //   默认 5s 在并行度高的整仓跑里会被 CPU 抢占拖超（现象是 5000ms 超时，
    //   而单独跑这个文件恒过）。放宽的是**等待上限**，断言一个字没松。
  }, 30_000)
})

describe('companion tsserver 语义结果适配', () => {
  const span = { start: { line: 2, offset: 3 }, end: { line: 2, offset: 6 } }

  it('补全和 hover 转为标准 LSP 结果', () => {
    expect(companionResponseToLsp('textDocument/completion', {
      isIncomplete: true,
      entries: [{ name: 'count', kind: 'property', sortText: '11', replacementSpan: span }],
    })).toEqual({
      isIncomplete: true,
      items: [{ label: 'count', kind: 10, sortText: '11', textEdit: { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, newText: 'count' } }],
    })
    expect(companionResponseToLsp('textDocument/hover', {
      displayString: '(property) count: number',
      documentation: [{ text: '计数' }],
      ...span,
    })).toEqual({
      contents: { kind: 'markdown', value: '```typescript\n(property) count: number\n```\n\n计数' },
      range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
    })
  })

  it('定义、引用和重命名保留文件与 0-based 坐标', () => {
    const location = { uri: 'file:///work/src/value.ts', range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } }
    expect(companionResponseToLsp('textDocument/definition', { definitions: [{ file: '/work/src/value.ts', ...span }] })).toEqual([location])
    expect(companionResponseToLsp('textDocument/references', { refs: [{ file: '/work/src/value.ts', ...span }] })).toEqual([location])
    expect(companionResponseToLsp('textDocument/rename', { info: { canRename: true }, locs: [{ file: '/work/src/value.ts', locs: [span] }] }, 'total')).toEqual({
      changes: { 'file:///work/src/value.ts': [{ range: location.range, newText: 'total' }] },
    })
    expect(companionResponseToLsp('textDocument/rename', { info: { canRename: false } }, 'total')).toBeNull()
  })
})

describe('真实 Volar 纵切', () => {
  it('vue-language-server：didOpen .vue（script setup TS 错误）→ publishDiagnostics', async () => {
    const vueRoot = await mkdtemp(join(tmpdir(), 'fh2-volar-e2e-'))
    const webRoot = await mkdtemp(join(tmpdir(), 'fh2-volar-e2e-web-'))
    await writeFile(join(webRoot, 'index.html'), '<html><head></head><body>ide</body></html>')
    try {
      await mkdir(join(vueRoot, 'src'), { recursive: true })
      await writeFile(join(vueRoot, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_volar', entry: './src/plugin.js', extensions: [] }))
      await writeFile(join(vueRoot, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
        include: ['src/**/*.ts', 'src/**/*.vue'],
      }))
      await mkdir(join(vueRoot, 'node_modules/fh2-plugin-sdk/dist/backend'), { recursive: true })
      await writeFile(join(vueRoot, 'node_modules/fh2-plugin-sdk/package.json'), JSON.stringify({
        name: 'fh2-plugin-sdk',
        type: 'module',
        exports: { './backend': { types: './dist/backend/index.d.ts', import: './dist/backend/index.js' } },
      }))
      await writeFile(join(vueRoot, 'node_modules/fh2-plugin-sdk/dist/backend/index.d.ts'), 'export interface HandlerCtx { traceId: string }\n')
      await writeFile(join(vueRoot, 'src/HelloPanel.vue'), '<template><div>Hello</div></template>\n')
      const appSource = '<script setup lang="ts">\nimport HelloPanel from "./HelloPanel.vue"\nimport type { HandlerCtx } from "fh2-plugin-sdk/backend"\ndeclare function onMounted(hook: () => void): void\ndeclare function onUnmounted(hook: () => void): void\nconst value: number = "boom"\nconst state = { count: 1 }\nstate.co\nconst ctx = {} as HandlerCtx\nctx.tra\nonMounted(() => undefined)\nonUnmounted(() => undefined)\n</script>\n<template><HelloPanel />{{ value }}</template>\n'
      await writeFile(join(vueRoot, 'src/App.vue'), appSource)

      const { startIdeServer } = await import('../../../serve/ide-server.js')
      const server = await startIdeServer({ root: vueRoot, webRoot, port: 0, watch: false })
      try {
        const WebSocket = (await import('ws')).default
        const workspace = await (await fetch(`${server.url}/api/workspace`, {
          headers: { 'x-fh2-ide-token': server.token },
        })).json() as { data?: { sessionId?: string } }

        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/lsp`)
        const reader = new FrameReader()
        const opened = new Promise<void>(resolve => ws.on('open', resolve))
        ws.on('message', (data, isBinary) => {
          // 二进制帧可能含 Content-Length JSON-RPC，也可能是握手应答的裸 JSON Buffer；
          // 两条路径都走 push（Content-Length 解析失败时退回裸 JSON）。
          void isBinary
          reader.push(data as Buffer)
        })
        await opened

        ws.send(JSON.stringify({
          type: 'hello',
          protocol: 'fh2-lsp',
          protocolVersion: 1,
          token: server.token,
          workspaceSessionId: workspace.data?.sessionId ?? '',
        }))
        await waitFor(() => reader.all.find(frame => (frame as { type?: string }).type === 'hello-accepted'), 15_000)
        const accepted = reader.all.find(frame => (frame as { type?: string }).type === 'hello-accepted') as { serverKind?: string } | undefined
        expect(accepted, 'hello-accepted 帧未到达').toBeDefined()
        expect(accepted!.serverKind).toBe('vue')

        const rpcFrame = (payload: unknown): Buffer => {
          const body = JSON.stringify(payload)
          return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
        }
        ws.send(rpcFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
          processId: process.pid,
          rootUri: `file://${vueRoot}`,
          capabilities: {
            textDocument: {
              publishDiagnostics: {},
              completion: {},
              hover: {},
              semanticTokens: {
                requests: { full: true },
                tokenTypes: ['variable', 'property', 'function'],
                tokenModifiers: ['declaration', 'readonly'],
                formats: ['relative'],
              },
            },
          },
        } }))
        const initialized = await waitFor(() => reader.all.find(frame => (frame as { id?: number }).id === 1), 30_000) as {
          result?: { capabilities?: { semanticTokensProvider?: { legend?: { tokenTypes?: string[] } } } };
        }
        const semanticTokenTypes = initialized.result?.capabilities?.semanticTokensProvider?.legend?.tokenTypes ?? []
        expect(semanticTokenTypes).toContain('function')
        expect(semanticTokenTypes).toContain('variable')
        expect(semanticTokenTypes).toContain('property')
        ws.send(rpcFrame({ jsonrpc: '2.0', method: 'initialized', params: {} }))
        ws.send(rpcFrame({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
          textDocument: { uri: `file://${join(vueRoot, 'src/App.vue')}`, languageId: 'vue', version: 1, text: appSource },
        } }))
        // Volar 冷启动较慢：等待 App.vue 的非空诊断。
        const found = await waitFor(() => {
          const notification = reader.all.find(frame => (frame as { method?: string }).method === 'textDocument/publishDiagnostics'
            && String((frame as { params?: { uri?: string } }).params?.uri ?? '').endsWith('App.vue')
            && Array.isArray((frame as { params?: { diagnostics?: unknown[] } }).params?.diagnostics)
            && ((frame as { params: { diagnostics: { message?: string }[] } }).params.diagnostics
              .some(diagnostic => diagnostic.message?.includes('not assignable') === true)))
          return notification
        }, 90_000)

        const params = (found as { params: { diagnostics: { range: { start: { line: number } };message: string }[] } }).params
        expect(params.diagnostics.some(diagnostic => diagnostic.message.includes('not assignable')), `diagnostics=${JSON.stringify(params.diagnostics)}`).toBe(true)
        expect(params.diagnostics.some(diagnostic => diagnostic.message.includes('Cannot find module \'./HelloPanel.vue\''))).toBe(false)
        expect(params.diagnostics.some(diagnostic => diagnostic.message.includes('Cannot find module \'fh2-plugin-sdk/backend\''))).toBe(false)
        // LSP 0-based：script 内第 2 行错误 → 0-based line 1。
        expect(params.diagnostics[0]!.range.start.line).toBeGreaterThanOrEqual(1)

        // 等项目加载和首轮诊断完成后再验证 script setup 补全。
        await waitFor(() => reader.all.find(frame => (frame as { type?: string;message?: string }).type === 'server-log'
          && (frame as { message?: string }).message?.includes('项目已就绪') === true), 30_000)
        ws.send(rpcFrame({ jsonrpc: '2.0', id: 2, method: 'textDocument/completion', params: {
          textDocument: { uri: `file://${join(vueRoot, 'src/App.vue')}` },
          position: { line: 7, character: 8 },
          context: { triggerKind: 1 },
        } }))
        const completion = await waitFor(() => reader.all.find(frame => (frame as { id?: number }).id === 2), 60_000)
          .catch((error) => {
            throw new Error(`${String(error)}; frames=${JSON.stringify(reader.all.slice(-12))}`)
          }) as { result?: unknown }
        const completionRecord = completion.result as { items?: { label?: string }[] } | { label?: string }[] | undefined
        const items = Array.isArray(completionRecord) ? completionRecord : completionRecord?.items ?? []
        expect(items.some(item => item.label === 'count'), `completion=${JSON.stringify(completion.result)}`).toBe(true)
        ws.send(rpcFrame({ jsonrpc: '2.0', id: 3, method: 'textDocument/completion', params: {
          textDocument: { uri: `file://${join(vueRoot, 'src/App.vue')}` },
          position: { line: 9, character: 7 },
          context: { triggerKind: 1 },
        } }))
        const sdkCompletion = await waitFor(() => reader.all.find(frame => (frame as { id?: number }).id === 3), 60_000) as { result?: unknown }
        const sdkRecord = sdkCompletion.result as { items?: { label?: string }[] } | { label?: string }[] | undefined
        const sdkItems = Array.isArray(sdkRecord) ? sdkRecord : sdkRecord?.items ?? []
        expect(sdkItems.some(item => item.label === 'traceId'), `completion=${JSON.stringify(sdkCompletion.result)}`).toBe(true)

        ws.send(rpcFrame({ jsonrpc: '2.0', id: 4, method: 'textDocument/semanticTokens/full', params: {
          textDocument: { uri: `file://${join(vueRoot, 'src/App.vue')}` },
        } }))
        const semanticResponse = await waitFor(() => reader.all.find(frame => (frame as { id?: number }).id === 4), 60_000) as {
          result?: { data?: number[] };
        }
        const semanticTokens = decodeSemanticTokens(appSource, semanticResponse.result?.data ?? [], semanticTokenTypes)
        expect(semanticTokens).toEqual(expect.arrayContaining([
          expect.objectContaining({ text: 'onMounted', type: 'function' }),
          expect.objectContaining({ text: 'onUnmounted', type: 'function' }),
          expect.objectContaining({ text: 'state', type: 'variable' }),
          expect.objectContaining({ text: 'count', type: 'property' }),
        ]))
        ws.close()
      } finally {
        await server.close()
      }
    } finally {
      await rm(vueRoot, { recursive: true, force: true })
      await rm(webRoot, { recursive: true, force: true })
    }
  }, 150_000)
})

function decodeSemanticTokens (source: string, data: readonly number[], tokenTypes: readonly string[]): readonly { text: string;type: string }[] {
  const lines = source.split('\n')
  const tokens: { text: string;type: string }[] = []
  let line = 0
  let character = 0
  for (let index = 0; index + 4 < data.length; index += 5) {
    const deltaLine = data[index]!
    line += deltaLine
    character = deltaLine === 0 ? character + data[index + 1]! : data[index + 1]!
    const length = data[index + 2]!
    tokens.push({
      text: lines[line]?.slice(character, character + length) ?? '',
      type: tokenTypes[data[index + 3]!] ?? 'unknown',
    })
  }
  return tokens
}

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
    // 裸 JSON 帧（握手应答）：整包解析。
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

async function waitFor<T> (predicate: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

void existsSync
