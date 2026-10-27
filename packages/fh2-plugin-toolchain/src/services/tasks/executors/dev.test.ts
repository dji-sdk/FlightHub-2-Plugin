// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { fork } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TaskExecutorContext } from '../task-service.js'
import { createRunExecutor } from './dev.js'

vi.mock('node:child_process', () => ({ fork: vi.fn() }))

let root: string
beforeEach(() => {
  vi.clearAllMocks()
  root = mkdtempSync(join(tmpdir(), 'fh2-dev-lifecycle-'))
  writeFileSync(join(root, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_lifecycle', entry: './plugin.js', extensions: [] }))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function start (kind: 'dev' | 'preview' = 'dev') {
  let sendCallback: ((error: Error | null) => void) | undefined
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(),
    send: vi.fn((_message: unknown, callback: (error: Error | null) => void) => {
      sendCallback = callback
    }),
  })
  vi.mocked(fork).mockReturnValue(child as unknown as ReturnType<typeof fork>)
  const emitLog = vi.fn()
  const controller = new AbortController()
  const context = { root, kind, params: {}, signal: controller.signal, emitLog, emitUrl: vi.fn() } as unknown as TaskExecutorContext
  const result = createRunExecutor(kind, { workerEntry: 'fixture.mjs', killGraceMs: 1000 }).start(context)
  // 立即订阅 rejection，测试手动控制事件顺序。
  const outcome = result.then(() => undefined, (error: unknown) => error)
  return { child, emitLog, controller, outcome, failSend: (error: Error) => sendCallback!(error) }
}

it.each(['dev', 'preview'] as const)('%s：IPC EPIPE后等待close，保留退出码和exit之后的stderr尾行', async (kind) => {
  const run = start(kind)
  await vi.waitFor(() => expect(run.child.send).toHaveBeenCalled())
  let settled = false
  void run.outcome.then(() => {
    settled = true
  })
  run.failSend(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
  expect(run.child.kill).toHaveBeenCalledWith('SIGTERM')
  run.child.exitCode = 7
  run.child.emit('exit', 7, null)
  expect(run.child.kill).toHaveBeenCalledWith('SIGKILL')
  run.child.stderr.write('startup boom\nlast stderr fragment')
  await Promise.resolve()
  expect(settled).toBe(false)
  run.child.emit('close', 7, null)
  expect(await run.outcome).toMatchObject({ message: `${kind} 进程异常退出：7` })
  expect(run.emitLog.mock.calls).toEqual([['stderr', 'startup boom'], ['stderr', 'last stderr fragment']])
})

it('spawn失败保留原错误，并在close后结束', async () => {
  const run = start()
  await vi.waitFor(() => expect(run.child.send).toHaveBeenCalled())
  const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
  run.child.emit('error', error)
  run.child.emit('close', -2, null)
  expect(await run.outcome).toBe(error)
})

it('ipc失败后的取消等待输出关闭，保持cancelled语义', async () => {
  const run = start()
  await vi.waitFor(() => expect(run.child.send).toHaveBeenCalled())
  run.controller.abort()
  run.failSend(new Error('write EPIPE'))
  run.child.emit('exit', null, 'SIGTERM')
  run.child.emit('close', null, 'SIGTERM')
  expect(await run.outcome).toMatchObject({ name: 'TaskCancelledError' })
})

it('ipc失败但worker以0退出仍报告发送失败；迟到回调不再停止已关闭进程', async () => {
  const run = start()
  await vi.waitFor(() => expect(run.child.send).toHaveBeenCalled())
  const error = new Error('IPC channel closed')
  run.child.exitCode = 0
  run.child.emit('close', 0, null)
  run.failSend(error)
  expect(await run.outcome).toBe(error)
  expect(run.child.kill.mock.calls).toEqual([['SIGKILL']])
})
