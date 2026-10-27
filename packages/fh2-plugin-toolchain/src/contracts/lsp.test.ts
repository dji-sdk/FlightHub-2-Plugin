// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import {
  LSP_PROTOCOL_ID,
  LSP_PROTOCOL_VERSION,
  asAbsoluteFileUri,
  parseLspClientHandshake,
  parseLspServerControlMessage,
  parseLspServerHandshake,
} from './lsp.js'

const token = 'serve-token'
const session = 'ws-session-1'

describe('lSP 客户端握手', () => {
  it('hello 帧字段完整', () => {
    const hello = {
      type: 'hello',
      protocol: LSP_PROTOCOL_ID,
      protocolVersion: LSP_PROTOCOL_VERSION,
      token,
      workspaceSessionId: session,
    }
    expect(parseLspClientHandshake(hello)).toEqual(hello)
  })

  it('resume 帧携带旧 sessionId', () => {
    const resume = {
      type: 'resume',
      protocol: LSP_PROTOCOL_ID,
      protocolVersion: LSP_PROTOCOL_VERSION,
      token,
      workspaceSessionId: session,
      sessionId: 'lsp-1',
    }
    expect(parseLspClientHandshake(resume)).toEqual(resume)
  })

  it('协议 id/版本不符或缺失字段拒绝（服务端回 bad-request）', () => {
    expect(parseLspClientHandshake({ type: 'hello', protocol: 'other', protocolVersion: 1, token, workspaceSessionId: session })).toBeNull()
    expect(parseLspClientHandshake({ type: 'hello', protocol: LSP_PROTOCOL_ID, protocolVersion: 2, token, workspaceSessionId: session })).toBeNull()
    expect(parseLspClientHandshake({ type: 'hello', protocol: LSP_PROTOCOL_ID, protocolVersion: 1, token: '', workspaceSessionId: session })).toBeNull()
    expect(parseLspClientHandshake({ type: 'resume', protocol: LSP_PROTOCOL_ID, protocolVersion: 1, token, workspaceSessionId: session })).toBeNull()
  })
})

describe('lSP 服务端应答', () => {
  it('hello-accepted/resume-accepted 携带 sessionId', () => {
    expect(parseLspServerHandshake({ type: 'hello-accepted', protocol: LSP_PROTOCOL_ID, protocolVersion: 1, sessionId: 'lsp-1' }))
      .toEqual({ type: 'hello-accepted', protocol: LSP_PROTOCOL_ID, protocolVersion: 1, sessionId: 'lsp-1' })
    expect(parseLspServerHandshake({ type: 'resume-accepted', protocol: LSP_PROTOCOL_ID, protocolVersion: 1, sessionId: 'lsp-1' })?.type)
      .toBe('resume-accepted')
  })

  it('rejected 帧理由受词表约束', () => {
    const rejected = { type: 'rejected', protocol: LSP_PROTOCOL_ID, reason: 'session-mismatch', message: '会话不匹配' }
    expect(parseLspServerHandshake(rejected)).toEqual(rejected)
    expect(parseLspServerHandshake({ type: 'rejected', protocol: LSP_PROTOCOL_ID, reason: 'whatever', message: 'x' })).toBeNull()
    expect(parseLspServerHandshake({ type: 'rejected', protocol: LSP_PROTOCOL_ID, reason: 'unauthorized' })).toBeNull()
  })
})

describe('lSP 可观察控制帧', () => {
  it('只接受受控状态与 stderr 来源', () => {
    const status = { type: 'server-status', protocol: LSP_PROTOCOL_ID, status: 'running', serverKind: 'vue' }
    expect(parseLspServerControlMessage(status)).toEqual(status)
    const log = { type: 'server-log', protocol: LSP_PROTOCOL_ID, stream: 'stderr', source: 'vue-language-server', message: 'ready' }
    expect(parseLspServerControlMessage(log)).toEqual(log)
    expect(parseLspServerControlMessage({ ...status, status: 'unknown' })).toBeNull()
    expect(parseLspServerControlMessage({ ...log, source: 'shell' })).toBeNull()
  })
})

describe('绝对 file URI', () => {
  it('接受绝对 file URI', () => {
    expect(asAbsoluteFileUri('file:///w/demo/src/main.ts')).toBe('file:///w/demo/src/main.ts')
    expect(asAbsoluteFileUri('file:///w/')).toBe('file:///w/')
  })

  it('拒绝相对路径与其它 scheme', () => {
    expect(asAbsoluteFileUri('src/main.ts')).toBeNull()
    expect(asAbsoluteFileUri('http://host/a.ts')).toBeNull()
    expect(asAbsoluteFileUri('file://')).toBeNull()
  })
})
