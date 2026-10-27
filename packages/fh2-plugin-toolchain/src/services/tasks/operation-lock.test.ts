// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readOperationLockOwner } from '../../capability/lock.js'
import { CapabilityError } from '../../capability/types.js'
import { acquireOperationLock, canonicalOperationRoot, isOperationLockHeld } from './operation-lock.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('canonicalOperationRoot（T3）', () => {
  it('成员插件入口归一到所属 Capability 根', async () => {
    const root = await createCapabilityProject()
    const pluginRoot = join(root, 'frontend/exp_front')

    expect(canonicalOperationRoot(pluginRoot)).toBe(root)
  })

  it('独立插件根保持自身', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-canonical-plugin-'))
    roots.push(root)
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_standalone', entry: './plugin.js', extensions: [] }))

    expect(canonicalOperationRoot(root)).toBe(root)
    expect(canonicalOperationRoot(join(root, 'src'))).toBe(join(root, 'src'))
  })

  it('行业工作区成员 Capability 上提到工作区根', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'fh2-canonical-ws-'))
    roots.push(workspace)
    await writeFile(join(workspace, 'packages.json'), JSON.stringify([{
      packageId: 'exp_ws_pkg',
      name: 'WS',
      capabilityIds: ['exp_alpha'],
    }]))
    const capabilityRoot = join(workspace, 'exp_alpha')
    await mkdir(join(capabilityRoot, 'frontend/exp_alpha_frontend'), { recursive: true })
    await writeFile(join(capabilityRoot, 'capabilities.json'), JSON.stringify({ name: 'A', description: 'a' }))
    await writeFile(join(capabilityRoot, 'frontend/exp_alpha_frontend/fh2-plugin.json'), JSON.stringify({ id: 'exp_alpha_frontend' }))

    expect(canonicalOperationRoot(capabilityRoot)).toBe(workspace)
    expect(canonicalOperationRoot(join(capabilityRoot, 'frontend/exp_alpha_frontend'))).toBe(workspace)
    expect(canonicalOperationRoot(workspace)).toBe(workspace)
  })

  it('普通 Capability 根保持自身', async () => {
    const root = await createCapabilityProject()
    expect(canonicalOperationRoot(root)).toBe(root)
  })
})

describe('acquireOperationLock（T3）', () => {
  it('获取与释放，held 集合同步维护', async () => {
    const root = await createCapabilityProject()
    const release = acquireOperationLock(root)
    expect(isOperationLockHeld(root)).toBe(true)
    expect(isOperationLockHeld(join(root, 'frontend/exp_front'))).toBe(true)

    release()
    expect(isOperationLockHeld(root)).toBe(false)
    expect(existsSync(join(root, '.fh2/operation.lock'))).toBe(false)
  })

  it('同进程二次获取报 IN_PROGRESS（自身 pid 存活）', async () => {
    const root = await createCapabilityProject()
    const release = acquireOperationLock(root)
    expect(() => acquireOperationLock(root)).toThrow(CapabilityError)
    release()
  })

  it('死 pid 遗留锁被回收重试；无 owner.json 的锁明确报人工恢复', async () => {
    const root = await createCapabilityProject()
    const lockPath = join(root, '.fh2/operation.lock')

    // 死 pid：可判定持有进程已退出 → 回收。
    await mkdir(lockPath, { recursive: true })
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: 999_999_999, command: 'dead', startedAt: 0 }))
    const release = acquireOperationLock(root)
    expect(readOperationLockOwner(root)?.pid).toBe(process.pid)
    release()

    // 无 owner.json：不可判定 → 报错，不静默删除。
    await mkdir(lockPath, { recursive: true })
    expect(() => acquireOperationLock(root)).toThrow(/无法判定持有进程/)
  })

  it('存活的他人 pid 锁明确报 IN_PROGRESS', async () => {
    const root = await createCapabilityProject()
    const lockPath = join(root, '.fh2/operation.lock')
    await mkdir(lockPath, { recursive: true })
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, command: 'other-process-simulation', startedAt: Date.now() }))

    expect(() => acquireOperationLock(root)).toThrow(/仍在运行/)
  })
})

async function createCapabilityProject (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-oplock-capability-'))
  roots.push(root)
  await mkdir(join(root, 'frontend/exp_front'), { recursive: true })
  await writeFile(join(root, 'capabilities.json'), JSON.stringify({ name: 'C', description: 'c' }))
  await writeFile(join(root, 'frontend/exp_front/fh2-plugin.json'), JSON.stringify({ id: 'exp_front' }))
  return root
}
