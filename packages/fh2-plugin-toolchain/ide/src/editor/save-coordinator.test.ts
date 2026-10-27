// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor'
import { DocumentStore } from './document-store.js'
import { SaveCoordinator } from './save-coordinator.js'
import type { SaveRequestItem, SaveResponse } from './save-coordinator.js'

/**
 * SaveCoordinator 的用例。每条对应一种**会丢用户内容**的失误：
 *   不 flush 草稿        → 「保存成功」而刚敲的值没进文件
 *   partial 时一把清脏   → 没落盘的文件显示成已保存，用户关掉就真丢了
 *   只收集 dirty         → 漏掉新建的虚拟文件与待删文件
 *   用当前内容推进基线    → 保存期间继续输入的那部分被标成已保存
 *   并发保存             → 两份计划各带自己的 hash，后到的必然冲突
 */

const stores: DocumentStore[] = []

function newStore (): DocumentStore {
  const store = new DocumentStore()
  store.setWorkspaceRoot('/repo')
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    for (const path of [...store.openPaths]) store.close(path, true)
  }
  for (const model of monaco.editor.getModels()) model.dispose()
  vi.restoreAllMocks()
})

/** 造一个按「全部成功」应答的假服务端。 */
function okServer (): {
  save: (items: readonly SaveRequestItem[]) => Promise<SaveResponse>;
  calls: SaveRequestItem[][];
} {
  const calls: SaveRequestItem[][] = []
  return {
    calls,
    save: async (items) => {
      calls.push([...items])
      return {
        ok: true,
        partial: false,
        items: items.map(item => ({
          path: item.path,
          kind: item.kind,
          ok: true,
          ...(item.kind === 'delete' ? {} : { revision: `rev-${item.path}` }),
        })),
      }
    },
  }
}

describe('saveCoordinator 草稿 flush', () => {
  it('保存前先 flush 草稿 —— 否则刚敲的值不会进文件', async () => {
    const documents = newStore()
    documents.open('a.json', '{}', 'rev-0')
    const server = okServer()
    const coordinator = new SaveCoordinator({ documents, save: server.save })

    // 模拟检查器：草稿只在组件里，flush 时才写进文档。
    coordinator.registerDraftFlush(() => {
      documents.applyEdit('a.json', '{ "刚敲的": 1 }', documents.modelVersion('a.json')!)
    })

    await coordinator.save()
    expect(server.calls[0]![0]!.content).toBe('{ "刚敲的": 1 }')
  })

  it('一个面板 flush 抛错不影响其他面板与整次保存', async () => {
    const documents = newStore()
    documents.open('a.json', '{}', 'rev-0')
    const server = okServer()
    const coordinator = new SaveCoordinator({ documents, save: server.save })

    coordinator.registerDraftFlush(() => {
      throw new Error('这个面板坏了')
    })
    coordinator.registerDraftFlush(() => {
      documents.applyEdit('a.json', '{ "b": 2 }', documents.modelVersion('a.json')!)
    })

    const outcome = await coordinator.save()
    expect(outcome.ok).toBe(true)
    expect(server.calls[0]![0]!.content).toBe('{ "b": 2 }')
  })

  it('注销后不再被 flush', async () => {
    const documents = newStore()
    documents.open('a.json', '{}', 'rev-0')
    const coordinator = new SaveCoordinator({ documents, save: okServer().save })
    const flush = vi.fn()
    const dispose = coordinator.registerDraftFlush(flush)
    dispose()
    await coordinator.flushDrafts()
    expect(flush).not.toHaveBeenCalled()
  })

  it('等待异步草稿完成后才构造计划，并发保存仍只发一次', async () => {
    const documents = newStore()
    documents.open('a.json', '{}', 'rev-0')
    const server = okServer()
    const coordinator = new SaveCoordinator({ documents, save: server.save })
    let finish!: () => void
    const completion = new Promise<void>((resolve) => {
      finish = resolve
    })
    const flush = vi.fn(async () => {
      await completion
      documents.applyEdit('a.json', '{ "new": 1 }', documents.modelVersion('a.json')!)
    })
    coordinator.registerDraftFlush(flush)

    const first = coordinator.save()
    const second = coordinator.save()
    expect(server.calls).toHaveLength(0)
    finish()
    const results = await Promise.all([first, second])
    expect(flush).toHaveBeenCalledOnce()
    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]![0]!.content).toBe('{ "new": 1 }')
    expect(results[0]).toEqual(results[1])
    expect(documents.isDirty('a.json')).toBe(false)
  })

  it('异步 flush 拒绝时仍尝试其他面板，与同步异常规则一致', async () => {
    const documents = newStore()
    documents.open('a.json', '{}', 'rev-0')
    const server = okServer()
    const coordinator = new SaveCoordinator({ documents, save: server.save })
    coordinator.registerDraftFlush(async () => {
      throw new Error('面板提交失败')
    })
    coordinator.registerDraftFlush(() => {
      documents.applyEdit('a.json', '{ "other": 1 }', documents.modelVersion('a.json')!)
    })
    const outcome = await coordinator.save()
    expect(outcome.ok).toBe(true)
    expect(server.calls[0]![0]!.content).toBe('{ "other": 1 }')
  })

  it('等待草稿时世代变化，不为新工作区发送旧保存', async () => {
    const documents = newStore()
    documents.open('a.json', '{}', 'rev-0')
    const server = okServer()
    let epoch = 1
    const coordinator = new SaveCoordinator({ documents, save: server.save, epoch: () => epoch })
    coordinator.registerDraftFlush(async () => {
      await Promise.resolve()
      epoch += 1
      documents.applyEdit('a.json', '{ "new-workspace": 1 }', documents.modelVersion('a.json')!)
    })
    await expect(coordinator.save()).rejects.toThrow('已停止旧保存')
    expect(server.calls).toHaveLength(0)
    expect(documents.isDirty('a.json')).toBe(true)
  })

  it('保存回包期间世代变化，不把旧回包记到新工作区', async () => {
    const documents = newStore()
    documents.open('a.json', '{}', 'rev-0')
    documents.applyEdit('a.json', '{ "old-workspace": 1 }', documents.modelVersion('a.json')!)
    let epoch = 1
    const coordinator = new SaveCoordinator({
      documents,
      epoch: () => epoch,
      save: async (items) => {
        epoch += 1
        documents.setWorkspaceRoot('/other')
        documents.open('a.json', '{ "new-workspace": 1 }', 'rev-new')
        return { ok: true, partial: false, items: items.map(item => ({ path: item.path, kind: item.kind, ok: true, revision: 'rev-old-saved' })) }
      },
    })
    await expect(coordinator.save()).rejects.toThrow('已停止旧保存')
    expect(documents.contentOf('a.json')).toBe('{ "new-workspace": 1 }')
    expect(documents.expectedRevision('a.json')).toBe('rev-new')
  })
})

describe('saveCoordinator 计划构造', () => {
  it('dirty 文件走 write 并带 expectedDiskHash', () => {
    const documents = newStore()
    documents.open('a.json', '{}', 'rev-0')
    documents.applyEdit('a.json', '{ "x": 1 }', documents.modelVersion('a.json')!)
    const { items } = new SaveCoordinator({ documents, save: okServer().save }).buildPlan()
    expect(items).toEqual([
      { path: 'a.json', kind: 'write', content: '{ "x": 1 }', expectedDiskHash: 'rev-0' },
    ])
  })

  it('没改过的文件不进计划', () => {
    const documents = newStore()
    documents.open('a.json', '{}', 'rev-0')
    expect(new SaveCoordinator({ documents, save: okServer().save }).buildPlan().items).toEqual([])
  })

  it('虚拟文件（画布新建、尚未落盘）走 create —— 只收 dirty 会漏掉它', () => {
    const documents = newStore()
    documents.openUnsaved('adapters/new.js', 'function handle () {}\n')
    const { items } = new SaveCoordinator({ documents, save: okServer().save }).buildPlan()
    expect(items).toEqual([
      { path: 'adapters/new.js', kind: 'create', content: 'function handle () {}\n' },
    ])
  })

  it('create 落盘后再编辑，第二次保存走 write 而不是再次 create', () => {
    const documents = newStore()
    documents.openUnsaved('adapters/new.js', 'function handle () {}\n')
    // 第一次保存（create）成功回执：markSaved 推进 existsOnDisk 与基线
    documents.markSaved('adapters/new.js', 'function handle () {}\n', 'rev-0')

    documents.applyEdit('adapters/new.js', 'function handle2 () {}\n', documents.modelVersion('adapters/new.js')!)
    const { items } = new SaveCoordinator({ documents, save: okServer().save }).buildPlan()
    expect(items).toEqual([
      { path: 'adapters/new.js', kind: 'write', content: 'function handle2 () {}\n', expectedDiskHash: 'rev-0' },
    ])
  })

  it('冲突未解决的文件不进计划（需要用户先选）', () => {
    const documents = newStore()
    documents.open('a.json', '{}', 'rev-0')
    documents.applyEdit('a.json', '{ "local": 1 }', documents.modelVersion('a.json')!)
    documents.enterConflict('a.json', { diskContent: '{ "disk": 1 }', diskRevision: 'rev-1' })
    expect(new SaveCoordinator({ documents, save: okServer().save }).buildPlan().items).toEqual([])
  })
})

describe('saveCoordinator 结果回填', () => {
  it('成功时按**提交出去的那份内容**推进基线，不是当前内容', async () => {
    const documents = newStore()
    documents.open('a.json', '{}', 'rev-0')
    documents.applyEdit('a.json', '{ "提交的": 1 }', documents.modelVersion('a.json')!)

    let committed = ''
    const coordinator = new SaveCoordinator({
      documents,
      save: async (items) => {
        committed = items[0]!.content!
        // 服务端返回之前，用户又敲了一下。
        documents.applyEdit('a.json', '{ "保存期间又敲的": 2 }', documents.modelVersion('a.json')!)
        return {
          ok: true,
          partial: false,
          items: [{ path: 'a.json', kind: 'write', ok: true, revision: 'rev-1' }],
        }
      },
    })
    await coordinator.save()

    expect(committed).toBe('{ "提交的": 1 }')
    // ★ 基线推到提交的那一份，于是「保存期间又敲的」仍然是 dirty —— 不会被当成已保存。
    expect(documents.isDirty('a.json')).toBe(true)
    expect(documents.expectedRevision('a.json')).toBe('rev-1')
  })

  it('partial 时只把落盘的那几份清脏，其余仍是 dirty', async () => {
    const documents = newStore()
    documents.open('adapters/a.js', 'old\n', 'rev-a')
    documents.open('fh2-plugin.json', '{}', 'rev-m')
    documents.applyEdit('adapters/a.js', 'new\n', documents.modelVersion('adapters/a.js')!)
    documents.applyEdit('fh2-plugin.json', '{ "x": 1 }', documents.modelVersion('fh2-plugin.json')!)

    const coordinator = new SaveCoordinator({
      documents,
      save: async items => ({
        ok: false,
        partial: true,
        items: items.map(item => item.path === 'adapters/a.js'
          ? { path: item.path, kind: item.kind, ok: true, revision: 'rev-a2' }
          : { path: item.path, kind: item.kind, ok: false, errorCode: 'FH2_FILE_CONFLICT', message: '冲突' }),
      }),
    })
    const outcome = await coordinator.save()

    expect(outcome.ok).toBe(false)
    expect(outcome.partial).toBe(true)
    expect(outcome.saved).toEqual(['adapters/a.js'])
    expect(outcome.failed.map(item => item.path)).toEqual(['fh2-plugin.json'])
    // ★★ 落盘的清脏、没落盘的**仍然是 dirty** —— 反过来用户关掉 tab 就真丢了。
    expect(documents.isDirty('adapters/a.js')).toBe(false)
    expect(documents.isDirty('fh2-plugin.json')).toBe(true)
  })

  it('冲突结果进冲突态，并带上磁盘快照给冲突 UI', async () => {
    const documents = newStore()
    documents.open('a.json', '{}', 'rev-0')
    documents.applyEdit('a.json', '{ "local": 1 }', documents.modelVersion('a.json')!)

    const coordinator = new SaveCoordinator({
      documents,
      save: async () => ({
        ok: false,
        partial: false,
        items: [{
          path: 'a.json',
          kind: 'write',
          ok: false,
          errorCode: 'FH2_FILE_CONFLICT',
          message: '磁盘被改过',
          conflict: { diskContent: '{ "disk": 9 }', diskRevision: 'rev-9' },
        }],
      }),
    })
    const outcome = await coordinator.save()

    expect(outcome.conflicted).toEqual(['a.json'])
    expect(documents.conflictOf('a.json')).toEqual({ diskContent: '{ "disk": 9 }', diskRevision: 'rev-9' })
  })

  it('删除成功后把文档关掉，不留指向已删文件的 tab', async () => {
    const documents = newStore()
    documents.open('adapters/old.js', 'old\n', 'rev-o')
    const coordinator = new SaveCoordinator({
      documents,
      save: async items => ({
        ok: true,
        partial: false,
        items: items.map(item => ({ path: item.path, kind: item.kind, ok: true })),
      }),
    })
    // 造一个待删状态。
    documents.applyPrepared({
      kind: 'MoveScriptFile',
      label: '移动',
      edits: [{ path: 'adapters/old.js', kind: 'delete' }],
      expected: {
        workspaceEpoch: documents.workspaceEpoch,
        documents: [{ path: 'adapters/old.js', generation: documents.generationOf('adapters/old.js')! }],
      },
    })
    expect(documents.snapshot(['adapters/old.js'])[0]!.pendingDelete).toBe(true)

    const outcome = await coordinator.save()
    expect(outcome.saved).toEqual(['adapters/old.js'])
    expect(documents.has('adapters/old.js')).toBe(false)
  })

  it('没有待保存内容时 nothingToSave=true 且不打服务端', async () => {
    const documents = newStore()
    documents.open('a.json', '{}', 'rev-0')
    const server = okServer()
    const outcome = await new SaveCoordinator({ documents, save: server.save }).save()
    expect(outcome.nothingToSave).toBe(true)
    expect(outcome.ok).toBe(true)
    expect(server.calls).toHaveLength(0)
  })

  it('有未解决冲突且没别的可存时，报失败而不是「无事可做」', async () => {
    const documents = newStore()
    documents.open('a.json', '{}', 'rev-0')
    documents.applyEdit('a.json', '{ "local": 1 }', documents.modelVersion('a.json')!)
    documents.enterConflict('a.json', { diskContent: '{ "disk": 1 }', diskRevision: 'rev-1' })
    const outcome = await new SaveCoordinator({ documents, save: okServer().save }).save()
    expect(outcome.nothingToSave).toBe(false)
    expect(outcome.ok).toBe(false)
    expect(outcome.conflicted).toEqual(['a.json'])
  })

  it('并发调用只真跑一次（两份计划各带自己的 hash 会让后到的必然冲突）', async () => {
    const documents = newStore()
    documents.open('a.json', '{}', 'rev-0')
    documents.applyEdit('a.json', '{ "x": 1 }', documents.modelVersion('a.json')!)
    const server = okServer()
    const coordinator = new SaveCoordinator({ documents, save: server.save })

    const [first, second] = await Promise.all([coordinator.save(), coordinator.save()])
    expect(server.calls).toHaveLength(1)
    expect(first).toEqual(second)
  })
})

describe('saveCoordinator P0-7/P2-5：范围保存与响应丢失对账', () => {
  it('save(only) 只保存范围内的路径 —— 关联保存不碰无关工作流', async () => {
    const documents = newStore()
    documents.open('workflows/a.json', 'A', 'rev-a0')
    documents.open('workflows/b.json', 'B', 'rev-b0')
    documents.open('fh2-plugin.json', 'M', 'rev-m0')
    // 三个文件都弄脏。
    for (const path of ['workflows/a.json', 'workflows/b.json', 'fh2-plugin.json']) {
      documents.applyEdit(path, `${path} dirty`, documents.modelVersion(path)!)
    }
    const server = okServer()
    const coordinator = new SaveCoordinator({ documents, save: server.save })

    await coordinator.save(['workflows/a.json', 'fh2-plugin.json'])

    // 计划里只有范围闸内的两个文件（顺序照打开序；排序落盘是服务端的事）。
    expect(server.calls[0]!.map(item => item.path)).toEqual(['workflows/a.json', 'fh2-plugin.json'])
    // 范围外的 b 保持脏。
    expect(documents.isDirty('workflows/b.json')).toBe(true)
    expect(documents.isDirty('workflows/a.json')).toBe(false)
  })

  it('服务端失败即停：未执行的项单独报 pending，不冒充失败', async () => {
    const documents = newStore()
    documents.open('adapters/a.js', 'a', 'rev-0')
    documents.open('adapters/b.js', 'b', 'rev-0')
    documents.applyEdit('adapters/a.js', 'a2', documents.modelVersion('adapters/a.js')!)
    documents.applyEdit('adapters/b.js', 'b2', documents.modelVersion('adapters/b.js')!)

    const coordinator = new SaveCoordinator({
      documents,
      save: async items => ({
        ok: false,
        partial: true,
        // 第一个失败即停：第二个连结果都没有。
        items: items.slice(0, 1).map(item => ({
          path: item.path,
          kind: item.kind,
          ok: false,
          message: '磁盘只读',
        })),
      }),
    })

    const outcome = await coordinator.save()
    expect(outcome.ok).toBe(false)
    expect(outcome.failed).toEqual([{ path: 'adapters/a.js', message: '磁盘只读' }])
    expect(outcome.saved).toEqual([])
    // b 既没成功也没失败 —— 它是「没轮到执行」，内容仍在编辑器里。
    expect(outcome.pending).toEqual(['adapters/b.js'])
    expect(documents.isDirty('adapters/b.js')).toBe(true)
  })

  it('保存请求丢失后按磁盘内容对账：已达目标内容的按已保存收账（P2-5）', async () => {
    const documents = newStore()
    documents.open('adapters/a.js', 'old', 'rev-0')
    documents.applyEdit('adapters/a.js', 'new content', documents.modelVersion('adapters/a.js')!)

    const coordinator = new SaveCoordinator({
      documents,
      // 请求本身抛错（网络断/进程重启），不是服务端拒绝。
      save: async () => {
        throw new Error('fetch failed')
      },
      readFile: async path => ({ content: path === 'adapters/a.js' ? 'new content' : '', revision: 'rev-1' }),
    })

    const outcome = await coordinator.save()
    // 写入其实成功了，只是回包丢了 —— 按已保存收账，不误报冲突。
    expect(outcome.saved).toEqual(['adapters/a.js'])
    expect(outcome.failed).toEqual([])
    expect(documents.isDirty('adapters/a.js')).toBe(false)
  })

  it('响应丢失且磁盘内容不一致时如实报失败，内存修改保留', async () => {
    const documents = newStore()
    documents.open('adapters/a.js', 'old', 'rev-0')
    documents.applyEdit('adapters/a.js', 'new content', documents.modelVersion('adapters/a.js')!)

    const coordinator = new SaveCoordinator({
      documents,
      save: async () => {
        throw new Error('fetch failed')
      },
      readFile: async () => ({ content: '磁盘上还是旧的', revision: 'rev-1' }),
    })

    const outcome = await coordinator.save()
    expect(outcome.ok).toBe(false)
    expect(outcome.failed[0]?.path).toBe('adapters/a.js')
    expect(documents.isDirty('adapters/a.js')).toBe(true)
  })
})
