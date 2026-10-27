// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createServer } from 'node:net'
import process from 'node:process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inspectPort, stopPortProcesses } from './port-processes.js'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) }
})
vi.mock('node:net', () => ({ createServer: vi.fn() }))

const listener = { pid: 999999, command: 'node', startedAt: 'Tue Oct 13 17:00:00 2026' }

beforeEach(() => {
  vi.clearAllMocks()
  execute.mockReset()
  execute.mockImplementation(async (command: string) => ({
    stdout: command === 'powershell.exe'
      ? JSON.stringify([listener])
      : command === 'lsof' ? `${listener.pid}\n` : `${listener.startedAt} ${listener.command}\n`,
  }))
  // 模拟系统绑定和命令结果，不依赖本机安装lsof/ps。
  let onError!: (error: NodeJS.ErrnoException) => void
  vi.mocked(createServer).mockReturnValue({
    once: (_event: string, handler: typeof onError) => {
      onError = handler
    },
    listen: () => onError(Object.assign(new Error('占用'), { code: 'EADDRINUSE' })),
  } as never)
})

afterEach(() => vi.restoreAllMocks())

it.runIf(process.platform !== 'win32')('缺少lsof仍报告占用且没有可停止PID，不发送任何信号', async () => {
  execute.mockRejectedValue(Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }))
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
  try {
    const snapshot = await inspectPort(5175)
    expect(snapshot).toEqual({ occupied: true, processes: [] })
    expect(execute).toHaveBeenCalledWith('lsof', expect.any(Array), { timeout: 5000 })
    await expect(stopPortProcesses(5175, snapshot.processes)).rejects.toThrow('不能自动停止')
    expect(kill).not.toHaveBeenCalled()
  } finally {
    kill.mockRestore()
  }
})

it.runIf(process.platform !== 'win32')('lsof没有匹配进程仍保留绑定确认的占用事实', async () => {
  execute.mockRejectedValue(Object.assign(new Error('no matches'), { code: 1 }))
  expect(await inspectPort(5175)).toEqual({ occupied: true, processes: [] })
})

it.runIf(process.platform !== 'win32')('其他系统命令错误不静默吞掉', async () => {
  execute.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
  await expect(inspectPort(5175)).rejects.toThrow('permission denied')
})

it('端口可用不调用系统命令', async () => {
  vi.mocked(createServer).mockReturnValue({
    once: vi.fn(),
    listen: (_port: number, _host: string, callback: () => void) => callback(),
    close: (callback: () => void) => callback(),
  } as never)
  expect(await inspectPort(5175)).toEqual({ occupied: false, processes: [] })
  expect(execute).not.toHaveBeenCalled()
})

it('有效快照只发送SIGTERM，端口释放后完成停止', async () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    vi.mocked(createServer).mockReturnValue({
      once: vi.fn(),
      listen: (_port: number, _host: string, callback: () => void) => callback(),
      close: (callback: () => void) => callback(),
    } as never)
    return true
  })
  await stopPortProcesses(5175, [listener])
  expect(kill.mock.calls).toEqual([[listener.pid, 'SIGTERM']])
})

it('快照变化时拒绝停止，不发送信号', async () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
  await expect(stopPortProcesses(5175, [{ ...listener, startedAt: 'wrong' }])).rejects.toThrow('已变化')
  expect(kill).not.toHaveBeenCalled()
})

it('空快照及IDE自身、父进程均拒绝停止', async () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
  for (const snapshot of [[], [{ ...listener, pid: process.pid }], [{ ...listener, pid: process.ppid }]]) {
    await expect(stopPortProcesses(5175, snapshot)).rejects.toThrow('不能自动停止')
  }
  expect(kill).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
})
