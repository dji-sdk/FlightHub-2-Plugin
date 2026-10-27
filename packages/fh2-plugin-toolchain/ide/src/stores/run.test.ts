// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { RunEvent, RunProcess } from '../api/types.js'
import { useRunStore } from './run.js'

function runEvent (overrides: Partial<RunEvent>): RunEvent {
  return { schemaVersion: 1, mode: 'dev', status: 'running', ...overrides }
}

function process (overrides: Partial<RunProcess>): RunProcess {
  return { mode: 'dev', status: 'running', ...overrides }
}

describe('run store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('append 把一条多行输出拆成多行', () => {
    const run = useRunStore()
    run.append({ schemaVersion: 1, mode: 'dev', stream: 'stdout', line: 'a\nb\nc' })
    expect(run.lines.map(line => line.text)).toEqual(['a', 'b', 'c'])
    expect(run.lines.every(line => line.mode === 'dev' && line.stream === 'stdout')).toBe(true)
  })

  it('note 以「»」前缀注入本地回执，错误走 stderr', () => {
    const run = useRunStore()
    run.note('dev', '请求启动')
    run.note('preview', '启动失败', true)
    expect(run.lines.map(line => [line.mode, line.stream, line.text])).toEqual([
      ['dev', 'stdout', '» 请求启动'],
      ['preview', 'stderr', '» 启动失败'],
    ])
  })

  it('日志缓冲超出上限丢最旧的（2000 行）', () => {
    const run = useRunStore()
    for (let i = 0; i < 2010; i += 1) {
      run.append({ schemaVersion: 1, mode: 'dev', stream: 'stdout', line: `line-${i}` })
    }
    expect(run.lines).toHaveLength(2000)
    expect(run.lines[0]?.text).toBe('line-10')
    expect(run.lines.at(-1)?.text).toBe('line-2009')
  })

  it('appendedCount 单调递增且不受裁剪影响；clear 归零；去重行不计入', () => {
    const run = useRunStore()
    for (let i = 0; i < 2010; i += 1) {
      run.append({ schemaVersion: 1, mode: 'dev', stream: 'stdout', line: `line-${i}` })
    }
    // 裁掉 10 行后 appendedCount 仍是 2010：终端据此计算 headDropped = 2010 - 2000 = 10
    expect(run.appendedCount).toBe(2010)
    run.append({ schemaVersion: 1, mode: 'dev', stream: 'stdout', line: 'dup', sequence: 7 })
    run.append({ schemaVersion: 1, mode: 'dev', stream: 'stdout', line: 'dup', sequence: 7 })
    expect(run.appendedCount).toBe(2011)
    run.clear()
    expect(run.appendedCount).toBe(0)
  })

  it('visibleLines 按过滤模式筛选，null 看全部', () => {
    const run = useRunStore()
    run.note('dev', 'd1')
    run.note('preview', 'p1')
    expect(run.visibleLines).toHaveLength(2)
    run.setFilter('preview')
    expect(run.visibleLines.map(line => line.text)).toEqual(['» p1'])
    run.setFilter(null)
    expect(run.visibleLines).toHaveLength(2)
  })

  it('isActive：stopped/failed 视为未运行', () => {
    const run = useRunStore()
    run.setProcesses([process({ mode: 'dev', status: 'stopped' })])
    expect(run.isActive('dev')).toBe(false)
    run.setProcesses([process({ mode: 'dev', status: 'starting' })])
    expect(run.isActive('dev')).toBe(true)
    expect(run.isActive('preview')).toBe(false)
  })

  it('applyRunState 合并：保留其他 mode，URL 与 since 沿用旧值', () => {
    const run = useRunStore()
    run.setProcesses([
      process({ mode: 'dev', status: 'running', url: 'http://x', since: 100 }),
      process({ mode: 'preview', status: 'stopped' }),
    ])
    run.applyRunState(runEvent({ mode: 'dev', status: 'starting' }))
    expect(run.processes).toHaveLength(2)
    expect(run.statusOf('dev')).toMatchObject({ mode: 'dev', status: 'starting', url: 'http://x', since: 100 })
    expect(run.statusOf('preview')).toBeDefined()
  })

  it('applyRunState 对未见过的 mode 落 since', () => {
    const run = useRunStore()
    run.applyRunState(runEvent({ mode: 'preview', status: 'starting' }))
    expect(run.statusOf('preview')?.since).toBeTypeOf('number')
  })

  it('clear 清日志但保留进程状态', () => {
    const run = useRunStore()
    run.setProcesses([process({})])
    run.note('dev', 'x')
    run.clear()
    expect(run.lines).toEqual([])
    expect(run.processes).toHaveLength(1)
  })
})
