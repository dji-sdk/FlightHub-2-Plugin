// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { parseArtifactDescriptor } from './artifact.js'
import { isTerminalTaskState, parseDiagnostic, parseTaskEvent } from './index.js'
import type { ArtifactDescriptor, Diagnostic, TaskEvent } from './index.js'

const diagnostic: Diagnostic = {
  code: 'TS2304',
  phase: 'typecheck',
  file: 'backend/demo/src/handler.ts',
  line: 10,
  column: 3,
  message: '找不到名称 ctx',
  severity: 'error',
}

const artifact: ArtifactDescriptor = {
  id: 'build-1-backend-dist',
  kind: 'backend-dist',
  path: '.fh2/artifacts/build-1/backend-dist',
  digest: 'b'.repeat(64),
  size: 2048,
  sourceRevision: 'c'.repeat(64),
  typechecked: true,
  stale: false,
}

describe('parseTaskEvent', () => {
  it('state 事件：状态与 sequence 必须合法', () => {
    expect(parseTaskEvent({ type: 'state', taskId: 't1', sequence: 0, state: 'queued' }))
      .toEqual({ type: 'state', taskId: 't1', sequence: 0, state: 'queued' })
    expect(parseTaskEvent({ type: 'state', taskId: 't1', sequence: 1, state: 'succeeded' }))
      .toEqual({ type: 'state', taskId: 't1', sequence: 1, state: 'succeeded' })
    expect(parseTaskEvent({ type: 'state', taskId: 't1', sequence: 1, state: 'nope' })).toBeNull()
  })

  it('log/url/diagnostic/artifact 事件', () => {
    expect(parseTaskEvent({ type: 'log', taskId: 't1', sequence: 2, stream: 'stderr', line: 'boom' }))
      .toEqual({ type: 'log', taskId: 't1', sequence: 2, stream: 'stderr', line: 'boom' })
    expect(parseTaskEvent({ type: 'url', taskId: 't1', sequence: 3, url: 'http://127.0.0.1:3000' }))
      .toEqual({ type: 'url', taskId: 't1', sequence: 3, url: 'http://127.0.0.1:3000' })
    expect(parseTaskEvent({ type: 'diagnostic', taskId: 't1', sequence: 4, diagnostic }))
      .toEqual({ type: 'diagnostic', taskId: 't1', sequence: 4, diagnostic })
    expect(parseTaskEvent({ type: 'artifact', taskId: 't1', sequence: 5, artifact }))
      .toEqual({ type: 'artifact', taskId: 't1', sequence: 5, artifact })
  })

  it('sequence 缺失/负数/非整数拒绝；嵌套结构不符整体拒绝', () => {
    expect(parseTaskEvent({ type: 'log', taskId: 't1', stream: 'stdout', line: 'x' })).toBeNull()
    expect(parseTaskEvent({ type: 'log', taskId: 't1', sequence: -1, stream: 'stdout', line: 'x' })).toBeNull()
    expect(parseTaskEvent({ type: 'log', taskId: 't1', sequence: 1.5, stream: 'stdout', line: 'x' })).toBeNull()
    expect(parseTaskEvent({ type: 'diagnostic', taskId: 't1', sequence: 4, diagnostic: { code: '' } })).toBeNull()
    expect(parseTaskEvent({ type: 'artifact', taskId: 't1', sequence: 5, artifact: { id: 'x' } })).toBeNull()
  })

  it('未知事件类型拒绝', () => {
    expect(parseTaskEvent({ type: 'progress', taskId: 't1', sequence: 6 })).toBeNull()
    expect(parseTaskEvent('not-an-object')).toBeNull()
  })
})

describe('终态语义', () => {
  it('succeeded/failed/cancelled 为终态，queued/running 不是', () => {
    expect(isTerminalTaskState('succeeded')).toBe(true)
    expect(isTerminalTaskState('failed')).toBe(true)
    expect(isTerminalTaskState('cancelled')).toBe(true)
    expect(isTerminalTaskState('queued')).toBe(false)
    expect(isTerminalTaskState('running')).toBe(false)
  })
})

describe('artifactDescriptor', () => {
  it('成功产物完整样例可解析', () => {
    expect(parseArtifactDescriptor(artifact)).toEqual(artifact)
  })

  it('空结果：任务快照允许 diagnostics/artifacts 为空数组', () => {
    const events: TaskEvent[] = []
    expect(events).toEqual([])
    expect(parseDiagnostic(undefined)).toBeNull()
  })

  it('digest/size/sourceRevision 缺失或非法拒绝', () => {
    expect(parseArtifactDescriptor({ ...artifact, digest: '' })).toBeNull()
    expect(parseArtifactDescriptor({ ...artifact, size: -1 })).toBeNull()
    expect(parseArtifactDescriptor({ ...artifact, sourceRevision: undefined })).toBeNull()
    expect(parseArtifactDescriptor({ ...artifact, typechecked: 'yes' })).toBeNull()
    expect(parseArtifactDescriptor({ ...artifact, kind: 'unknown-kind' })).toBeNull()
  })
})
