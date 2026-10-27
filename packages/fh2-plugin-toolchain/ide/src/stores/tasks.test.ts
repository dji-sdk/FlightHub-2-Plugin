// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { TaskSnapshot } from '../../../src/contracts/index.js'
import { useTasksStore } from './tasks.js'

function snapshot (overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: 'task-1',
    kind: 'build',
    state: 'queued',
    createdAt: 1,
    diagnostics: [],
    artifacts: [],
    lastSequence: 0,
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('tasks store（U1）', () => {
  it('快照与事件合并：sequence 去重、重复/旧事件丢弃', () => {
    const tasks = useTasksStore()
    tasks.applySnapshot(snapshot())

    tasks.applyEvent({ type: 'log', taskId: 'task-1', sequence: 1, stream: 'stdout', line: 'started' })
    tasks.applyEvent({ type: 'state', taskId: 'task-1', sequence: 2, state: 'running' })
    // 重复/旧 sequence 丢弃
    tasks.applyEvent({ type: 'state', taskId: 'task-1', sequence: 2, state: 'running' })
    tasks.applyEvent({ type: 'log', taskId: 'task-1', sequence: 1, stream: 'stdout', line: 'dup' })
    tasks.applyEvent({ type: 'diagnostic', taskId: 'task-1', sequence: 3, diagnostic: { code: 'TS1', phase: 'typecheck', file: 'a.ts', message: 'err', severity: 'error' } })

    const task = tasks.tasks.find(item => item.taskId === 'task-1')!
    expect(task.state).toBe('running')
    expect(task.lastSequence).toBe(3)
    expect(task.diagnostics).toHaveLength(1)
    expect(tasks.logsOf('task-1')).toEqual(['[stdout] started'])
  })

  it('乱序快照不回退已见 sequence', () => {
    const tasks = useTasksStore()
    tasks.applySnapshot(snapshot({ lastSequence: 5, state: 'running' }))
    tasks.applySnapshot(snapshot({ lastSequence: 2, state: 'queued' }))
    expect(tasks.tasks[0]!.lastSequence).toBe(5)
    expect(tasks.tasks[0]!.state).toBe('running')
  })

  it('终态事件合并产物与诊断（U2 数据入口）', () => {
    const tasks = useTasksStore()
    tasks.applySnapshot(snapshot({ lastSequence: 9, state: 'running' }))
    const artifact = {
      id: 'a1',
      kind: 'backend-dist' as const,
      path: '.fh2/artifacts/task-1/a1.zip',
      digest: 'd'.repeat(64),
      size: 100,
      sourceRevision: 'r'.repeat(64),
      typechecked: true,
      stale: false,
    }
    tasks.applyEvent({ type: 'artifact', taskId: 'task-1', sequence: 10, artifact })
    tasks.applyEvent({ type: 'state', taskId: 'task-1', sequence: 11, state: 'succeeded' })

    const task = tasks.tasks[0]!
    expect(task.state).toBe('succeeded')
    expect(task.artifacts).toEqual([artifact])
    expect(tasks.artifactsOf('task-1')).toEqual([artifact])
    expect(tasks.activeTasks).toEqual([])
  })

  it('日志有界：超过上限截断头部', () => {
    const tasks = useTasksStore()
    tasks.applySnapshot(snapshot())
    for (let index = 0; index < 350; index++) {
      tasks.applyEvent({ type: 'log', taskId: 'task-1', sequence: index + 1, stream: 'stdout', line: `line ${index}` })
    }
    const logs = tasks.logsOf('task-1')
    expect(logs.length).toBe(300)
    expect(logs[0]).toBe('[stdout] line 50')
  })
})

it('工作区切换后丢弃旧任务事件', () => {
  const tasks = useTasksStore()
  tasks.setSession('new')
  tasks.applyEvent({ type: 'state', taskId: 'old-task', state: 'running', sequence: 1, workspaceSessionId: 'old', kind: 'dev' })
  expect(tasks.tasks).toEqual([])
  tasks.applyEvent({ type: 'state', taskId: 'new-task', state: 'running', sequence: 1, workspaceSessionId: 'new', kind: 'dev' })
  expect(tasks.tasks[0]?.kind).toBe('dev')
})
