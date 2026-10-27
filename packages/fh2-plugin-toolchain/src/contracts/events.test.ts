// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { parseFsEvent, parseRunEvent, parseRunLogEvent, parseWorkspaceEvent } from './events.js'

describe('sSE 事件解析（严格版本）', () => {
  it('schemaVersion=1 的事件正常解析', () => {
    expect(parseFsEvent({ schemaVersion: 1, type: 'change', path: 'a.ts' }))
      .toEqual({ schemaVersion: 1, type: 'change', path: 'a.ts' })
    expect(parseWorkspaceEvent({ schemaVersion: 1, root: '/w/demo', name: 'demo', kind: 'industry-capability-workspace' }))
      .toEqual({ schemaVersion: 1, root: '/w/demo', name: 'demo', kind: 'industry-capability-workspace' })
    expect(parseRunEvent({ schemaVersion: 1, mode: 'dev', status: 'running', url: 'http://x', projectPath: 'demo', detail: 'ok' }))
      .toEqual({ schemaVersion: 1, mode: 'dev', status: 'running', url: 'http://x', projectPath: 'demo', detail: 'ok' })
    expect(parseRunLogEvent({ schemaVersion: 1, mode: 'preview', stream: 'stderr', line: 'x', sequence: 3 }))
      .toEqual({ schemaVersion: 1, mode: 'preview', stream: 'stderr', line: 'x', sequence: 3 })
  })

  it('缺失版本明确失败（不再静默按 v1 处理）', () => {
    expect(parseFsEvent({ type: 'change', path: 'a.ts' })).toBeNull()
    expect(parseWorkspaceEvent({ root: '/w', name: 'w', kind: 'frontend-plugin' })).toBeNull()
    expect(parseRunEvent({ mode: 'dev', status: 'running' })).toBeNull()
    expect(parseRunLogEvent({ mode: 'dev', stream: 'stdout', line: 'x' })).toBeNull()
  })

  it('run-log 的 workspaceSessionId 透传；空串/非字符串被剔除', () => {
    expect(parseRunLogEvent({ schemaVersion: 1, mode: 'dev', stream: 'stdout', line: 'x', workspaceSessionId: 'session-a' }))
      .toEqual({ schemaVersion: 1, mode: 'dev', stream: 'stdout', line: 'x', workspaceSessionId: 'session-a' })
    expect(parseRunLogEvent({ schemaVersion: 1, mode: 'dev', stream: 'stdout', line: 'x', workspaceSessionId: '' }))
      .toEqual({ schemaVersion: 1, mode: 'dev', stream: 'stdout', line: 'x' })
  })

  it('未知版本明确失败', () => {
    expect(parseFsEvent({ schemaVersion: 2, type: 'change', path: 'a.ts' })).toBeNull()
    expect(parseRunEvent({ schemaVersion: 99, mode: 'dev', status: 'running' })).toBeNull()
  })

  it('非法字段拒绝', () => {
    expect(parseFsEvent({ schemaVersion: 1, type: 'move', path: 'a.ts' })).toBeNull()
    expect(parseRunEvent({ schemaVersion: 1, mode: 'install', status: 'running' })).toBeNull()
    expect(parseRunEvent({ schemaVersion: 1, mode: 'dev', status: 'paused' })).toBeNull()
    expect(parseRunLogEvent({ schemaVersion: 1, mode: 'dev', stream: 'stdlog', line: 'x' })).toBeNull()
  })

  it('workspace 事件 kind 宽容落到 unknown（白名单统一由 Protocol 维护）', () => {
    expect(parseWorkspaceEvent({ schemaVersion: 1, root: '/w', name: 'w', kind: 'capability' })?.kind)
      .toBe('unknown')
    expect(parseWorkspaceEvent({ schemaVersion: 1, root: '/w', name: 'w' })?.kind)
      .toBe('unknown')
  })
})
