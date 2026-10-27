// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import type { ArtifactDescriptor, TaskEvent, TaskOwner } from '../../contracts/index.js'
import { InMemoryTaskService, TaskCancelledError, TaskError } from './task-service.js'
import type { TaskExecutor, TaskExecutorContext } from './task-service.js'

const owner: TaskOwner = { ownerId: 'owner-a' }
const other: TaskOwner = { ownerId: 'owner-b' }

const artifact: ArtifactDescriptor = {
  id: 'art-1',
  kind: 'backend-dist',
  path: '.fh2/artifacts/task-1/backend-dist',
  digest: 'd'.repeat(64),
  size: 128,
  sourceRevision: 'r'.repeat(64),
  typechecked: true,
  stale: false,
}

function service (): InMemoryTaskService {
  return new InMemoryTaskService({ canonicalizeRoot: root => root.toUpperCase() })
}

describe('taskService 状态与 owner（T1）', () => {
  it('start → queued → running → succeeded，快照携带 sequence 与产物', async () => {
    const tasks = service()
    tasks.registerExecutor('build', {
      async start (context) {
        context.reportInitialRevision('a'.repeat(64))
        context.emitLog('stdout', 'building...')
        context.emitArtifact(artifact)
        return { artifacts: [artifact], finalRevision: 'a'.repeat(64) }
      },
    })

    const started = await tasks.start(owner, { kind: 'build', root: '/ws/Project', params: {} })
    expect(started.state).toBe('queued')
    const final = await tasks.settle(owner, started.taskId)

    expect(final.state).toBe('succeeded')
    expect(final.kind).toBe('build')
    expect(final.artifacts).toEqual([artifact])
    expect(final.sourceRevision).toBe('a'.repeat(64))
    expect(final.stale).toBe(false)
    expect(final.lastSequence).toBeGreaterThan(0)
  })

  it('同 owner 同参数重复 start 返回已有 taskId；参数不同报 IN_PROGRESS', async () => {
    const tasks = service()
    let release: (() => void) | undefined
    tasks.registerExecutor('build', {
      async start () {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return {}
      },
    })

    const first = await tasks.start(owner, { kind: 'build', root: '/ws/Project', params: { mode: 'production' } })
    const duplicate = await tasks.start(owner, { kind: 'build', root: '/ws/Project', params: { mode: 'production' } })
    expect(duplicate.taskId).toBe(first.taskId)

    await expect(tasks.start(owner, { kind: 'build', root: '/ws/Project', params: { mode: 'development' } }))
      .rejects.toMatchObject({ code: 'FH2_TASK_IN_PROGRESS' })

    await tasks.awaitRunning(owner, first.taskId)
    release?.()
    await tasks.settle(owner, first.taskId)
  })

  it('不同 owner 冲突只返回忙碌错误，不泄露 taskId；跨 owner get/cancel 视为 NOT_FOUND', async () => {
    const tasks = service()
    let release: (() => void) | undefined
    tasks.registerExecutor('pack', {
      async start () {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return {}
      },
    })

    const first = await tasks.start(owner, { kind: 'pack', root: '/ws/project', params: {} })
    await expect(tasks.start(other, { kind: 'pack', root: '/ws/project', params: {} }))
      .rejects.toMatchObject({ code: 'FH2_TASK_IN_PROGRESS' })
    expect(() => tasks.get(other, first.taskId)).toThrow(TaskError)
    await expect(tasks.cancel(other, first.taskId)).rejects.toMatchObject({ code: 'FH2_TASK_NOT_FOUND' })

    await tasks.awaitRunning(owner, first.taskId)
    release?.()
    await tasks.settle(owner, first.taskId)
  })

  it('queued 可取消且不进入 executor；已终态 cancel 报 NOT_CANCELLABLE', async () => {
    const tasks = service()
    let started = false
    tasks.registerExecutor('build', {
      async start () {
        started = true
        return {}
      },
    })

    const queued = await tasks.start(owner, { kind: 'build', root: '/ws/p', params: {} })
    // start 返回 queued；executor 在微任务后才运行。同步取消 → 不进入 executor。
    await tasks.cancel(owner, queued.taskId)
    expect(started).toBe(false)
    expect(tasks.get(owner, queued.taskId).state).toBe('cancelled')

    await expect(tasks.cancel(owner, queued.taskId)).rejects.toMatchObject({ code: 'FH2_TASK_NOT_CANCELLABLE' })
  })

  it('running 取消：abort → executor 抛 TaskCancelledError → cancelled 终态', async () => {
    const tasks = service()
    tasks.registerExecutor('dev', {
      async start (context: TaskExecutorContext) {
        await new Promise<void>((resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(new TaskCancelledError()), { once: true })
        })
        return {}
      },
    })

    const task = await tasks.start(owner, { kind: 'dev', root: '/ws/p', params: {} })
    await tasks.awaitRunning(owner, task.taskId)
    const cancelled = await tasks.cancel(owner, task.taskId)
    expect(cancelled.state).toBe('cancelled')
  })

  it('取消失败不伪报成功：executor 忽略 abort 并成功时 cancel 报 CANCEL_FAILED', async () => {
    const tasks = service()
    tasks.registerExecutor('build', {
      async start () {
        await new Promise(resolve => setTimeout(resolve, 20))
        return {}
      },
    })

    const task = await tasks.start(owner, { kind: 'build', root: '/ws/p', params: {} })
    await tasks.awaitRunning(owner, task.taskId)
    await expect(tasks.cancel(owner, task.taskId)).rejects.toMatchObject({ code: 'FH2_TASK_CANCEL_FAILED' })
    expect(tasks.get(owner, task.taskId).state).toBe('succeeded')
  })

  it('executor 抛业务错误 → failed 且诊断入快照', async () => {
    const tasks = service()
    const events: TaskEvent[] = []
    tasks.subscribe(owner, event => events.push(event))
    tasks.registerExecutor('build', {
      async start () {
        throw new Error('boom')
      },
    })
    const task = await tasks.start(owner, { kind: 'build', root: '/ws/p', params: {} })
    const final = await tasks.settle(owner, task.taskId)
    expect(final.state).toBe('failed')
    expect(final.diagnostics[0]).toMatchObject({ code: 'FH2_TASK_EXECUTOR_FAILED', message: 'boom' })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'diagnostic',
      diagnostic: expect.objectContaining({ code: 'FH2_TASK_EXECUTOR_FAILED', message: 'boom' }),
    }))
  })

  it('stopOwned 停止该 owner 全部任务，其他 owner 不受影响', async () => {
    const tasks = service()
    const hanging = (): TaskExecutor => ({
      async start (context) {
        await new Promise<void>((_, reject) => {
          context.signal.addEventListener('abort', () => reject(new TaskCancelledError()), { once: true })
        })
        return {}
      },
    })
    tasks.registerExecutor('dev', hanging())
    tasks.registerExecutor('build', hanging())

    const own = await tasks.start(owner, { kind: 'dev', root: '/ws/p', params: {} })
    const foreign = await tasks.start(other, { kind: 'build', root: '/ws/p', params: {} })
    await tasks.awaitRunning(owner, own.taskId)
    await tasks.awaitRunning(other, foreign.taskId)

    await tasks.stopOwned(owner)
    expect(tasks.get(owner, own.taskId).state).toBe('cancelled')
    expect(tasks.get(other, foreign.taskId).state).toBe('running')
    await tasks.stopOwned(other)
  })
})

describe('taskService 事件（T2）', () => {
  it('sequence 单调递增、终态唯一、事件按 owner 隔离', async () => {
    const tasks = service()
    tasks.registerExecutor('build', {
      async start (context) {
        context.emitLog('stdout', 'line 1')
        context.emitDiagnostic({ code: 'TS1', phase: 'typecheck', file: 'a.ts', message: 'err', severity: 'error' })
        context.emitUrl('http://127.0.0.1:3000')
        return { finalRevision: 'b'.repeat(64) }
      },
    })

    const events: TaskEvent[] = []
    const foreignEvents: TaskEvent[] = []
    tasks.subscribe(owner, event => events.push(event))
    tasks.subscribe(other, event => foreignEvents.push(event))

    const task = await tasks.start(owner, { kind: 'build', root: '/ws/p', params: {} })
    await tasks.settle(owner, task.taskId)

    const sequences = events.map(event => event.sequence)
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
    expect(events.filter(event => event.type === 'state' && event.state === 'succeeded')).toHaveLength(1)
    expect(events.some(event => event.type === 'log' && event.line === 'line 1')).toBe(true)
    expect(events.some(event => event.type === 'diagnostic')).toBe(true)
    expect(events.some(event => event.type === 'url')).toBe(true)
    expect(foreignEvents).toEqual([])
    expect(tasks.logTail(owner, task.taskId)).toEqual(['[stdout] line 1'])
  })

  it('日志 tail 有界：超限截断头部', async () => {
    const tasks = new InMemoryTaskService({ logTailLimit: 3 })
    tasks.registerExecutor('build', {
      async start (context) {
        for (let index = 0; index < 10; index++) context.emitLog('stdout', `line ${index}`)
        return {}
      },
    })
    const task = await tasks.start(owner, { kind: 'build', root: '/ws/p', params: {} })
    await tasks.settle(owner, task.taskId)
    expect(tasks.logTail(owner, task.taskId)).toEqual([
      '[stdout] line 7',
      '[stdout] line 8',
      '[stdout] line 9',
    ])
  })
})

describe('任务目标与锁根', () => {
  it('成员保留自己的执行目标，同一锁根的其他成员不能复用其任务', async () => {
    const tasks = new InMemoryTaskService({ canonicalizeRoot: () => '/workspace' })
    let receivedRoot = ''
    tasks.registerExecutor('dev', {
      async start (context) {
        receivedRoot = context.root
        await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }))
        throw new TaskCancelledError()
      },
    })
    const task = await tasks.start(owner, { kind: 'dev', root: '/workspace/cap/frontend/a', params: {} })
    await tasks.awaitRunning(owner, task.taskId)
    expect(receivedRoot).toBe('/workspace/cap/frontend/a')
    await expect(tasks.start(owner, { kind: 'dev', root: '/workspace/cap/frontend/b', params: {} }))
      .rejects.toMatchObject({ code: 'FH2_TASK_IN_PROGRESS' })
    await tasks.cancel(owner, task.taskId)
    const next = await tasks.start(owner, { kind: 'dev', root: '/workspace/cap/frontend/b', params: {} })
    await tasks.awaitRunning(owner, next.taskId)
    expect(receivedRoot).toBe('/workspace/cap/frontend/b')
    await tasks.cancel(owner, next.taskId)
  })
})
