// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IdeRunManager } from './run-manager.js'
import { inspectPort, stopPortProcesses } from './port-processes.js'
import type { IdeTaskBridge } from './task-bridge.js'

vi.mock('./port-processes.js', async original => ({ ...await original<typeof import('./port-processes.js')>(), inspectPort: vi.fn(), stopPortProcesses: vi.fn() }))
const occupied = { occupied: true, processes: [{ pid: 999999, command: 'node', startedAt: 'first' }] }
let root: string
let manager: IdeRunManager
const start = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  root = mkdtempSync(join(tmpdir(), 'fh2-run-port-'))
  writeFileSync(join(root, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_port_test', version: '0.1.0', entry: './entry.js', extensions: [] }))
  start.mockResolvedValue({ taskId: 'dev', createdAt: 1 })
  const tasks = { start, get: () => ({ state: 'running' }), subscribe: vi.fn() } as unknown as IdeTaskBridge
  manager = new IdeRunManager({ resolveRoot: () => root, tasks, onEvent: vi.fn(), onLog: vi.fn() })
  vi.mocked(inspectPort).mockResolvedValue(occupied)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('端口占用不创建任务、不停进程；有效确认先停止再启动原目标', async () => {
  const result = await manager.start({ mode: 'dev' })
  expect(result).toMatchObject({ status: 'failed', portConflict: { port: 5175, processes: [{ pid: 999999, command: 'node' }] } })
  expect(start).not.toHaveBeenCalled()
  expect(stopPortProcesses).not.toHaveBeenCalled()
  vi.mocked(inspectPort).mockResolvedValueOnce(occupied).mockResolvedValueOnce({ occupied: false, processes: [] })
  await manager.start({ mode: 'dev', port: 5175, portConfirmation: result.portConflict!.confirmationToken })
  expect(stopPortProcesses).toHaveBeenCalledWith(5175, occupied.processes)
  expect(start).toHaveBeenCalledWith(root, 'dev', { port: 5175 })
})

it('占用者变化或伪造确认不能杀进程，只返回新的确认', async () => {
  const first = await manager.start({ mode: 'dev' })
  vi.mocked(inspectPort).mockResolvedValue({ occupied: true, processes: [{ ...occupied.processes[0]!, startedAt: 'new' }] })
  const changed = await manager.start({ mode: 'dev', portConfirmation: first.portConflict!.confirmationToken })
  expect(changed.portConflict?.confirmationToken).not.toBe(first.portConflict?.confirmationToken)
  await manager.start({ mode: 'dev', portConfirmation: 'forged', pids: [999999] })
  expect(stopPortProcesses).not.toHaveBeenCalled()
  expect(start).not.toHaveBeenCalled()
})

it('确认不能用于其他端口；工作区停止全部任务后旧确认失效', async () => {
  const first = await manager.start({ mode: 'dev' })
  const changed = await manager.start({ mode: 'dev', port: 5176, portConfirmation: first.portConflict!.confirmationToken })
  expect(changed.portConflict?.port).toBe(5176)
  expect(stopPortProcesses).not.toHaveBeenCalled()
  await manager.stopAll()
  await manager.start({ mode: 'dev', port: 5176, portConfirmation: changed.portConflict!.confirmationToken })
  expect(stopPortProcesses).not.toHaveBeenCalled()
  expect(start).not.toHaveBeenCalled()
})

it('端口已自行释放直接启动，无法识别或IDE进程不提供自动停止', async () => {
  const first = await manager.start({ mode: 'dev' })
  vi.mocked(inspectPort).mockResolvedValue({ occupied: false, processes: [] })
  expect((await manager.start({ mode: 'dev', portConfirmation: first.portConflict!.confirmationToken })).status).toBe('starting')
  manager = new IdeRunManager({ resolveRoot: () => root, tasks: { subscribe: vi.fn() } as never, onEvent: vi.fn(), onLog: vi.fn() })
  vi.mocked(inspectPort).mockResolvedValue({ occupied: true, processes: [{ ...occupied.processes[0]!, pid: process.pid }] })
  expect((await manager.start({ mode: 'dev' })).portConflict?.confirmationToken).toBeUndefined()
})

it('停止失败不创建dev任务；preview保留原启动行为', async () => {
  const first = await manager.start({ mode: 'dev' })
  vi.mocked(stopPortProcesses).mockRejectedValueOnce(new Error('permission denied'))
  await expect(manager.start({ mode: 'dev', portConfirmation: first.portConflict!.confirmationToken })).rejects.toThrow('permission denied')
  expect(start).not.toHaveBeenCalled()
  vi.mocked(inspectPort).mockClear()
  await manager.start({ mode: 'preview', target: ' http://fh2.example.com/project?org=1#/team ' })
  expect(inspectPort).not.toHaveBeenCalled()
  expect(start).toHaveBeenCalledWith(root, 'preview', { port: 4317, target: 'http://fh2.example.com/project?org=1#/team' })
})

it.each([
  [undefined, 'preview 需要 target'],
  ['', 'preview 需要 target'],
  ['   ', 'preview 需要 target'],
  [123, 'preview 需要 target'],
  ['https://fh2.example.com/project?org=1', '不支持 HTTPS 目标'],
  ['http:fh2.example.com', '必须是完整 HTTP URL'],
  ['http:/fh2.example.com/project', '必须是完整 HTTP URL'],
  ['http:///fh2.example.com/project', '必须是完整 HTTP URL'],
  ['not-a-url', '必须是完整 HTTP URL'],
  ['file:///etc/passwd', '必须是完整 HTTP URL'],
  ['http://user:pass@fh2.example.com/project', '不得包含用户名或密码'],
])('preview 拒绝 target=%s，校验失败不调度任何本地任务', async (target, message) => {
  await expect(manager.start({ mode: 'preview', target })).rejects.toMatchObject({
    name: 'IdeRequestError',
    code: 'FH2_IDE_BAD_REQUEST',
    message: expect.stringContaining(message),
  })
  expect(start).not.toHaveBeenCalled()
  expect(inspectPort).not.toHaveBeenCalled()
  expect(manager.status().processes).toEqual([])
})

it('无法识别占用PID时提示手动释放，不提供确认令牌或创建任务', async () => {
  vi.mocked(inspectPort).mockResolvedValue({ occupied: true, processes: [] })
  const result = await manager.start({ mode: 'dev' })
  expect(result).toMatchObject({ status: 'failed', portConflict: { processes: [], message: expect.stringContaining('手动释放') } })
  expect(result.portConflict?.confirmationToken).toBeUndefined()
  expect(start).not.toHaveBeenCalled()
  expect(stopPortProcesses).not.toHaveBeenCalled()
})
