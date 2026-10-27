// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import process from 'node:process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const execute = promisify(execFile)
export interface PortProcess {
  readonly pid: number;
  readonly command: string;
  /** 仅服务端持有，用来识别PID复用。 */
  readonly startedAt: string;
}
export interface PortInspection {
  readonly occupied: boolean;
  readonly processes: readonly PortProcess[];
}

export async function inspectPort (port: number): Promise<PortInspection> {
  const occupied = await new Promise<boolean>((resolve, reject) => {
    const server = createServer()
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(true)
      else reject(error)
    })
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve(false)))
  })
  if (!occupied) return { occupied, processes: [] }
  if (process.platform === 'win32') {
    const script = `@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction Stop; @{ pid = $p.Id; command = $p.ProcessName; startedAt = $p.StartTime.ToUniversalTime().ToString('o') } }) | ConvertTo-Json -Compress`
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000 })
    const values = JSON.parse(stdout || '[]') as PortProcess | PortProcess[]
    return { occupied, processes: (Array.isArray(values) ? values : [values]).sort((a, b) => a.pid - b.pid) }
  }
  let stdout: string
  try {
    stdout = (await execute('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeout: 5000 })).stdout
  } catch (error) {
    // 精简Linux镜像可能没有lsof；保持端口占用事实，交给IDE提示手动释放。
    const code = (error as { code?: number | string }).code
    if (code === 1 || code === 'ENOENT') return { occupied, processes: [] }
    throw error
  }
  const pids = [...new Set(stdout.trim().split(/\s+/).map(Number))].filter(pid => Number.isInteger(pid) && pid > 0)
  const processes = await Promise.all(pids.map(async (pid): Promise<PortProcess> => {
    const { stdout: identity } = await execute('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='], { timeout: 5000 })
    const match = /^(.{24})\s+(.+)$/.exec(identity.trim())
    if (!match) throw new Error(`无法识别端口 ${port} 的占用进程 ${pid}`)
    return { pid, startedAt: match[1]!, command: match[2]! }
  }))
  return { occupied, processes: processes.sort((a, b) => a.pid - b.pid) }
}

export function sameProcesses (left: readonly PortProcess[], right: readonly PortProcess[]): boolean {
  return left.length === right.length && left.every((item, index) => item.pid === right[index]?.pid && item.startedAt === right[index]?.startedAt && item.command === right[index]?.command)
}

/** 只停止用户确认的监听PID；新占用者不会被继续杀掉。 */
export async function stopPortProcesses (port: number, expected: readonly PortProcess[]): Promise<void> {
  if (expected.length === 0 || expected.some(item => item.pid === process.pid || item.pid === process.ppid)) throw new Error('不能自动停止IDE服务或无法识别的进程')
  const before = await inspectPort(port)
  if (!before.occupied) return
  if (!sameProcesses(expected, before.processes)) throw new Error('端口占用进程已变化，请重新确认')
  for (const item of expected) process.kill(item.pid, 'SIGTERM')
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await delay(100)
    if (!(await inspectPort(port)).occupied) return
  }
  const remaining = await inspectPort(port)
  if (remaining.processes.length === 0 || remaining.processes.some(item => !expected.some(original => sameProcesses([original], [item])))) throw new Error('端口占用进程已变化，请重新确认')
  for (const item of remaining.processes) process.kill(item.pid, 'SIGKILL')
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await delay(100)
    if (!(await inspectPort(port)).occupied) return
  }
  throw new Error(`停止进程后端口 ${port} 仍被占用`)
}
