// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskEvent, TaskOwner } from '../../../contracts/index.js'
import { InMemoryTaskService } from '../task-service.js'
import { createDevExecutor, createRunExecutor } from './dev.js'

const roots: string[] = []
const owner: TaskOwner = { ownerId: 'dev-ipc-test' }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('dev executor IPC（T5）', () => {
  it.each(['dev', 'preview'] as const)('%s worker快速异常退出时，失败终态之前收齐stderr和诊断', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-dev-fast-exit-'))
    roots.push(root)
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_dev_ipc', entry: './plugin.js', extensions: [] }))
    const workerEntry = join(root, 'fast-exit.mjs')
    await writeFile(workerEntry, `process.stderr.write('startup boom\\nlast stderr fragment', () => process.exit(7))\n`)
    const tasks = new InMemoryTaskService()
    tasks.registerExecutor(kind, createRunExecutor(kind, { workerEntry }))
    const events: TaskEvent[] = []
    tasks.subscribe(owner, event => events.push(event))
    const started = await tasks.start(owner, { kind, root, params: {} })
    try {
      const final = await tasks.settle(owner, started.taskId)
      expect(final.state).toBe('failed')
      expect(final.diagnostics).toEqual([expect.objectContaining({ code: 'FH2_TASK_EXECUTOR_FAILED', message: `${kind} 进程异常退出：7` })])
      expect(events.filter(event => event.type === 'log')).toEqual([
        expect.objectContaining({ stream: 'stderr', line: 'startup boom' }),
        expect.objectContaining({ stream: 'stderr', line: 'last stderr fragment' }),
      ])
      expect(events.at(-1)).toMatchObject({ type: 'state', state: 'failed' })
      expect(events.filter(event => event.type === 'state' && event.state === 'failed')).toHaveLength(1)
    } finally {
      await tasks.stopOwned(owner)
    }
  })

  it('ready URL 只经 IPC 事件上报，取消回收子进程并落 cancelled', { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-dev-ipc-'))
    roots.push(root)
    // 只需通过上下文发现；实际 dev 进程由 IPC fixture 代替。
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_dev_ipc', entry: './src/plugin.js', extensions: [] }))
    const workerEntry = fileURLToPath(new URL('./fixtures/dev-ipc-child.mjs', import.meta.url))
    const tasks = new InMemoryTaskService()
    tasks.registerExecutor('dev', createDevExecutor({ workerEntry }))
    const events: TaskEvent[] = []
    tasks.subscribe(owner, event => events.push(event))

    const started = await tasks.start(owner, { kind: 'dev', root, params: {} })
    await waitFor(() => events.some(event => event.type === 'url'), 5000)
    const urlEvent = events.find(event => event.type === 'url')
    expect(urlEvent).toMatchObject({ type: 'url', url: 'http://127.0.0.1:43210/' })

    const cancelled = await tasks.cancel(owner, started.taskId)
    expect(cancelled.state).toBe('cancelled')
  })

  it.skipIf(process.platform === 'win32')('worker 先退出时也回收忽略 SIGTERM 的后代进程', { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-dev-descendant-'))
    roots.push(root)
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_dev_ipc', entry: './src/plugin.js', extensions: [] }))
    const tasks = new InMemoryTaskService()
    tasks.registerExecutor('dev', createDevExecutor({ workerEntry: fileURLToPath(new URL('./fixtures/dev-ipc-child.mjs', import.meta.url)) }))
    let descendant: number | undefined
    tasks.subscribe(owner, (event) => {
      if (event.type !== 'log') return
      const match = /descendant:(\d+)/.exec(event.line)
      if (match) descendant = Number(match[1])
    })
    const started = await tasks.start(owner, { kind: 'dev', root, params: { spawnDescendant: true } })
    try {
      await waitFor(() => descendant !== undefined, 5000)
      expect(() => process.kill(descendant!, 0)).not.toThrow()
      expect((await tasks.cancel(owner, started.taskId)).state).toBe('cancelled')
      await waitFor(() => {
        try {
          process.kill(descendant!, 0)
          return false
        } catch {
          return true
        }
      }, 5000)
    } finally {
      await tasks.stopOwned(owner)
      if (descendant !== undefined) {
        try {
          process.kill(descendant, 'SIGKILL')
        } catch { /* 已回收 */ }
      }
    }
  })

  it.skipIf(process.platform === 'win32')('worker退出后回收持有输出管道的后代，close能够完成', { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-dev-inherited-pipe-'))
    roots.push(root)
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_dev_ipc', entry: './plugin.js', extensions: [] }))
    const tasks = new InMemoryTaskService()
    tasks.registerExecutor('dev', createDevExecutor({ workerEntry: fileURLToPath(new URL('./fixtures/dev-ipc-child.mjs', import.meta.url)) }))
    let descendant: number | undefined
    tasks.subscribe(owner, (event) => {
      if (event.type !== 'log') return
      const match = /descendant:(\d+)/.exec(event.line)
      if (match) descendant = Number(match[1])
    })
    const started = await tasks.start(owner, { kind: 'dev', root, params: { spawnDescendant: true, exitWithDescendant: true } })
    try {
      await waitFor(() => tasks.get(owner, started.taskId).state === 'failed', 5000)
      expect(tasks.get(owner, started.taskId).diagnostics).toEqual([expect.objectContaining({ message: 'dev 进程异常退出：7' })])
      expect(descendant).toBeDefined()
      await waitFor(() => {
        try {
          process.kill(descendant!, 0)
          return false
        } catch {
          return true
        }
      }, 5000)
    } finally {
      if (descendant !== undefined) {
        try {
          process.kill(descendant, 'SIGKILL')
        } catch { /* 已回收 */ }
      }
      await tasks.stopOwned(owner)
    }
  })
})

async function waitFor (predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待 IPC 事件超时')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
