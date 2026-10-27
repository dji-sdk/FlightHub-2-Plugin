// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireCapabilityLock } from './lock.js'
import { CapabilityError } from './types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('capability operation lock', () => {
  it('拒绝同一进程的并发 Capability 操作', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-capability-lock-'))
    roots.push(root)
    const releaseOuter = acquireCapabilityLock(root)
    expect(() => acquireCapabilityLock(root)).toThrow(CapabilityError)
    releaseOuter()
  })

  it('锁文件已存在时报告进行中的操作', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-capability-lock-'))
    roots.push(root)
    const release = acquireCapabilityLock(root)
    release()
    const externalLock = join(root, '.fh2/operation.lock')
    await mkdir(externalLock, { recursive: true })

    expect(() => acquireCapabilityLock(root)).toThrow(CapabilityError)
  })

  it('释放后移除仅含锁的空 .fh2 目录，已有其他成员时保留', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-capability-lock-'))
    roots.push(root)
    const release = acquireCapabilityLock(root)
    release()
    expect(existsSync(join(root, '.fh2'))).toBe(false)

    const keepRoot = await mkdtemp(join(tmpdir(), 'fh2-capability-lock-'))
    roots.push(keepRoot)
    const releaseWithReport = acquireCapabilityLock(keepRoot)
    await mkdir(join(keepRoot, '.fh2/build-report.json'), { recursive: true })
    releaseWithReport()
    expect(existsSync(join(keepRoot, '.fh2'))).toBe(true)
    expect(existsSync(join(keepRoot, '.fh2/build-report.json'))).toBe(true)
  })
})
