// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { revisionOf } from './files.js'
import { orderSavePlan, runSavePlan, saveOrderOf } from './save.js'
import type { SaveItem } from './save.js'

/**
 * 多文件保存的用例，跑在**真实文件系统**上。
 *
 * ★★ 三条被守住的性质（见 save.ts 头部）：
 *   ① 顺序：脚本 → 清单 → 工作流。失败在中间时，落下去的那部分仍是能装载的工程。
 *   ② CAS：每份文件带 expectedDiskHash，外部改动不被静默覆盖。
 *   ③ 失败即停 + partial：调用方能精确知道哪些落了。
 */

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fh2-save-'))
  await mkdir(join(root, 'workflows'), { recursive: true })
  await mkdir(join(root, 'adapters'), { recursive: true })
  await writeFile(join(root, 'fh2-plugin.json'), '{ "scripts": [] }\n', 'utf8')
  await writeFile(join(root, 'workflows/f.json'), '{ "steps": [] }\n', 'utf8')
  await writeFile(join(root, 'adapters/a.js'), 'old\n', 'utf8')
})

async function hashOf (path: string): Promise<string> {
  return revisionOf(await readFile(join(root, path), 'utf8'))
}

async function read (path: string): Promise<string> {
  return await readFile(join(root, path), 'utf8')
}

describe('saveOrderOf / orderSavePlan', () => {
  it('脚本最先、清单居中、工作流最后', () => {
    expect(saveOrderOf('adapters/a.js')).toBeLessThan(saveOrderOf('fh2-plugin.json'))
    expect(saveOrderOf('fh2-plugin.json')).toBeLessThan(saveOrderOf('workflows/f.json'))
    expect(saveOrderOf('backend/plugin.json')).toBe(saveOrderOf('fh2-plugin.json'))
    expect(saveOrderOf('backend/workflows/x.json')).toBe(saveOrderOf('workflows/f.json'))
  })

  it('p2-5：全部脚本扩展名（.ts/.mts/.cts/.mjs/.cjs）都归脚本优先档', () => {
    for (const path of ['adapters/a.ts', 'adapters/a.mts', 'adapters/a.cts', 'adapters/a.mjs', 'adapters/a.cjs', 'backend/adapters/deep/x.ts']) {
      expect(saveOrderOf(path), path).toBeLessThan(saveOrderOf('fh2-plugin.json'))
      expect(saveOrderOf(path), path).toBeLessThan(saveOrderOf('workflows/f.json'))
    }
  })

  it('排序把顺序纠正过来，且同档内保持调用方顺序（稳定）', () => {
    const items: SaveItem[] = [
      { path: 'workflows/f.json', kind: 'write', content: 'w', expectedDiskHash: 'x' },
      { path: 'adapters/b.js', kind: 'write', content: 'b', expectedDiskHash: 'x' },
      { path: 'fh2-plugin.json', kind: 'write', content: 'm', expectedDiskHash: 'x' },
      { path: 'adapters/a.js', kind: 'write', content: 'a', expectedDiskHash: 'x' },
    ]
    expect(orderSavePlan(items).map(item => item.path)).toEqual([
      'adapters/b.js',
      'adapters/a.js',
      'fh2-plugin.json',
      'workflows/f.json',
    ])
  })
})

describe('runSavePlan 成功路径', () => {
  it('三份文件按序落盘，逐条回新 revision', async () => {
    const result = await runSavePlan({
      root,
      plan: {
        items: [
          { path: 'workflows/f.json', kind: 'write', content: '{ "steps": [1] }\n', expectedDiskHash: await hashOf('workflows/f.json') },
          { path: 'fh2-plugin.json', kind: 'write', content: '{ "scripts": [1] }\n', expectedDiskHash: await hashOf('fh2-plugin.json') },
          { path: 'adapters/a.js', kind: 'write', content: 'new\n', expectedDiskHash: await hashOf('adapters/a.js') },
        ],
      },
    })
    expect(result.ok).toBe(true)
    expect(result.partial).toBe(false)
    // 回包按**执行顺序**排：脚本、清单、流程。
    expect(result.items.map(item => item.path)).toEqual([
      'adapters/a.js',
      'fh2-plugin.json',
      'workflows/f.json',
    ])
    for (const item of result.items) expect(item.revision).toBeTruthy()
    expect(await read('adapters/a.js')).toBe('new\n')
    expect(await read('workflows/f.json')).toBe('{ "steps": [1] }\n')
  })

  it('create 会把不存在的父目录逐级建出来', async () => {
    const result = await runSavePlan({
      root,
      plan: { items: [{ path: 'adapters/deep/nested/new.js', kind: 'create', content: 'fresh\n' }] },
    })
    expect(result.ok).toBe(true)
    expect(await read('adapters/deep/nested/new.js')).toBe('fresh\n')
  })

  it('delete 落盘，且重复删（已不存在）按成功处理', async () => {
    const first = await runSavePlan({
      root,
      plan: { items: [{ path: 'adapters/a.js', kind: 'delete', expectedDiskHash: await hashOf('adapters/a.js') }] },
    })
    expect(first.ok).toBe(true)
    expect(existsSync(join(root, 'adapters/a.js'))).toBe(false)

    // 再删一次：目标状态已达成。重复保存是常态，不该报错。
    const again = await runSavePlan({
      root,
      plan: { items: [{ path: 'adapters/a.js', kind: 'delete', expectedDiskHash: 'whatever' }] },
    })
    expect(again.ok).toBe(true)
  })
})

describe('runSavePlan CAS 与失败处理', () => {
  it('磁盘被外部改过时拒绝覆盖，并回磁盘快照', async () => {
    const stale = await hashOf('workflows/f.json')
    await writeFile(join(root, 'workflows/f.json'), '{ "steps": ["外部改的"] }\n', 'utf8')

    const result = await runSavePlan({
      root,
      plan: { items: [{ path: 'workflows/f.json', kind: 'write', content: '{ "steps": ["我的"] }\n', expectedDiskHash: stale }] },
    })
    expect(result.ok).toBe(false)
    // 用仓里既有的文件冲突码，不自造 —— 前端按码弹冲突 UI。
    expect(result.items[0]!.errorCode).toBe('FH2_FILE_CONFLICT')
    expect(result.items[0]!.conflict?.diskContent).toContain('外部改的')
    // 外部内容没被覆盖。
    expect(await read('workflows/f.json')).toContain('外部改的')
  })

  it('create 目标已存在时拒绝（不吃掉别人刚建的同名文件）', async () => {
    const result = await runSavePlan({
      root,
      plan: { items: [{ path: 'adapters/a.js', kind: 'create', content: '覆盖\n' }] },
    })
    expect(result.ok).toBe(false)
    expect(result.items[0]!.errorCode).toBe('FH2_IDE_ALREADY_EXISTS')
    expect(await read('adapters/a.js')).toBe('old\n')
  })

  it('delete 时磁盘内容不符 → 停手，不删', async () => {
    const result = await runSavePlan({
      root,
      plan: { items: [{ path: 'adapters/a.js', kind: 'delete', expectedDiskHash: revisionOf('别的内容') }] },
    })
    expect(result.ok).toBe(false)
    expect(existsSync(join(root, 'adapters/a.js'))).toBe(true)
  })

  it('失败即停：后面的项标成未执行，且真的没写', async () => {
    const staleManifest = await hashOf('fh2-plugin.json')
    await writeFile(join(root, 'fh2-plugin.json'), '{ "scripts": ["外部"] }\n', 'utf8')

    const result = await runSavePlan({
      root,
      plan: {
        items: [
          { path: 'adapters/a.js', kind: 'write', content: 'ok\n', expectedDiskHash: await hashOf('adapters/a.js') },
          // 这一项会冲突。
          { path: 'fh2-plugin.json', kind: 'write', content: '{ "scripts": ["我的"] }\n', expectedDiskHash: staleManifest },
          { path: 'workflows/f.json', kind: 'write', content: '{ "steps": ["我的"] }\n', expectedDiskHash: await hashOf('workflows/f.json') },
        ],
      },
    })

    expect(result.ok).toBe(false)
    // ★ partial：脚本落了、清单冲突、流程没执行。
    expect(result.partial).toBe(true)
    expect(result.items.map(item => [item.path, item.ok])).toEqual([
      ['adapters/a.js', true],
      ['fh2-plugin.json', false],
      ['workflows/f.json', false],
    ])
    expect(result.items[2]!.errorCode).toBe('FH2_IDE_SAVE_SKIPPED')

    // ★★ 关键：失败停在清单，流程**没被写** —— 落下去的那部分（脚本文件多一份）
    //    仍是一个能装载的工程。反序执行的话这里会留下「流程引用了清单里没有的功能」。
    expect(await read('workflows/f.json')).toBe('{ "steps": [] }\n')
    expect(await read('adapters/a.js')).toBe('ok\n')
  })

  it('失败停在第一项时 partial=false（什么都没落）', async () => {
    const result = await runSavePlan({
      root,
      plan: {
        items: [
          { path: 'adapters/a.js', kind: 'write', content: 'x\n', expectedDiskHash: revisionOf('不对') },
          { path: 'workflows/f.json', kind: 'write', content: 'y\n', expectedDiskHash: await hashOf('workflows/f.json') },
        ],
      },
    })
    expect(result.ok).toBe(false)
    expect(result.partial).toBe(false)
    expect(await read('workflows/f.json')).toBe('{ "steps": [] }\n')
  })

  it('路径逃逸被拒（保存走的是同一套路径安全判据）', async () => {
    const result = await runSavePlan({
      root,
      plan: { items: [{ path: '../escape.js', kind: 'create', content: 'x\n' }] },
    })
    expect(result.ok).toBe(false)
    expect(result.items[0]!.errorCode).toBe('FH2_IDE_PATH_ESCAPE')
  })

  it('空计划不算成功（避免「保存了 0 个文件」被当成保存成功）', async () => {
    const result = await runSavePlan({ root, plan: { items: [] } })
    expect(result.ok).toBe(false)
    expect(result.partial).toBe(false)
  })
})
