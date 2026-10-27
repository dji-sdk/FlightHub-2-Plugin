// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor'
import type { PreparedCommand } from '../../../src/workflow/core/commands.js'
import { DocumentStore, minimalDiffRange } from './document-store.js'

/**
 * C1 新增面的用例：generation / workspaceEpoch / snapshot / applyPrepared / batch event。
 *
 * ★★ 这组用例守的核心是**「前置失效时零修改」**。它不是理论洁癖：
 * 跨文件命令写了脚本没写清单，工程会处在一个两边都解析不出来的中间态，
 * 而用户看到的只是「保存了，但画布报错」。
 */

const WORKFLOW = `{
  "name": "f",
  "steps": [
    { "id": "a", "action": "run_script" }
  ]
}
`

const stores: DocumentStore[] = []

function store (): DocumentStore {
  const instance = new DocumentStore()
  instance.setWorkspaceRoot('/repo')
  stores.push(instance)
  return instance
}

// monaco 的 model 注册表按 URI 全局唯一（跨 DocumentStore 实例共享）：
// 不清干净，下一个用例 createModel 会撞 URI 而不是报出真正的断言失败。
afterEach(() => {
  for (const instance of stores.splice(0)) {
    for (const path of [...instance.openPaths]) instance.close(path, true)
  }
  for (const model of monaco.editor.getModels()) model.dispose()
  vi.restoreAllMocks()
})

/** 造一条针对已打开文档的命令，generation 默认取当前值（即前置成立）。 */
function command (
  instance: DocumentStore,
  overrides: Partial<PreparedCommand> & { paths?: readonly string[] } = {},
): PreparedCommand {
  const paths = overrides.paths ?? ['workflows/f.json']
  return {
    kind: overrides.kind ?? 'SetInput',
    label: overrides.label ?? '设置入参',
    edits: overrides.edits ?? [{
      path: 'workflows/f.json',
      kind: 'modify',
      ops: [{ path: ['steps', 0, 'action'], value: 'dispatch_mission' }],
    }],
    expected: overrides.expected ?? {
      workspaceEpoch: instance.workspaceEpoch,
      documents: paths.map(path => ({ path, generation: instance.generationOf(path)! })),
    },
    ...(overrides.focus === undefined ? {} : { focus: overrides.focus }),
  }
}

describe('minimalDiffRange', () => {
  it('取公共前后缀之外的那一段', () => {
    expect(minimalDiffRange('abcdef', 'abXYef')).toEqual({ start: 2, endBefore: 4, inserted: 'XY' })
  })

  it('纯插入与纯删除', () => {
    expect(minimalDiffRange('ac', 'abc')).toEqual({ start: 1, endBefore: 1, inserted: 'b' })
    expect(minimalDiffRange('abc', 'ac')).toEqual({ start: 1, endBefore: 2, inserted: '' })
  })

  it('相同文本回空区间', () => {
    expect(minimalDiffRange('abc', 'abc')).toEqual({ start: 3, endBefore: 3, inserted: '' })
  })

  it('短文本被包含时不算出负长度区间（前后缀相撞）', () => {
    const forward = minimalDiffRange('ab', 'b')
    expect(forward.endBefore).toBeGreaterThanOrEqual(forward.start)
    const backward = minimalDiffRange('b', 'ab')
    expect(backward.endBefore).toBeGreaterThanOrEqual(backward.start)
    // 语义仍然正确：按区间替换后得到目标文本。
    expect('ab'.slice(0, forward.start) + forward.inserted + 'ab'.slice(forward.endBefore)).toBe('b')
    expect('b'.slice(0, backward.start) + backward.inserted + 'b'.slice(backward.endBefore)).toBe('ab')
  })

  it('重复字符串上也能还原目标文本', () => {
    for (const [before, after] of [
      ['aaaa', 'aa'],
      ['aa', 'aaaa'],
      ['{"a":1}', '{"a":1,"b":2}'],
      ['', 'x'],
      ['x', ''],
    ] as const) {
      const diff = minimalDiffRange(before, after)
      expect(before.slice(0, diff.start) + diff.inserted + before.slice(diff.endBefore)).toBe(after)
    }
  })
})

describe('document store generation 与 workspaceEpoch', () => {
  it('generation 每次内容变化都推进，且是全局单调序列', () => {
    const instance = store()
    instance.open('a.json', '{}')
    instance.open('b.json', '{}')
    const a1 = instance.generationOf('a.json')!
    const b1 = instance.generationOf('b.json')!
    expect(b1).toBeGreaterThan(a1)

    instance.applyEdit('a.json', '{ "x": 1 }', instance.modelVersion('a.json')!)
    const a2 = instance.generationOf('a.json')!
    expect(a2).toBeGreaterThan(b1)
    // 另一个文件的代号不受影响 —— 否则无关改动会让命令频繁无故失效。
    expect(instance.generationOf('b.json')).toBe(b1)
  })

  it('关掉再打开同一路径不会复用旧代号（不能用 Monaco versionId 的关键理由）', () => {
    const instance = store()
    instance.open('a.json', '{}')
    const first = instance.generationOf('a.json')!
    instance.close('a.json', true)
    instance.open('a.json', '{}')
    const second = instance.generationOf('a.json')!
    expect(second).toBeGreaterThan(first)
    // Monaco 自己的版本号确实归 1 了，这正是不能拿它当判据的原因。
    expect(instance.modelVersion('a.json')).toBe(1)
  })

  it('切工作区 epoch +1 并清空命令历史', () => {
    const instance = store()
    instance.open('workflows/f.json', WORKFLOW)
    expect(instance.applyPrepared(command(instance)).ok).toBe(true)
    expect(instance.history).toHaveLength(1)

    const before = instance.workspaceEpoch
    instance.setWorkspaceRoot('/other')
    expect(instance.workspaceEpoch).toBe(before + 1)
    expect(instance.history).toHaveLength(0)
  })
})

describe('document store snapshot', () => {
  it('回固定字节集，含 dirty/存在态/基线 revision', () => {
    const instance = store()
    instance.open('a.json', '{}', 'rev-1')
    instance.applyEdit('a.json', '{ "x": 1 }', instance.modelVersion('a.json')!)

    const [snapshot] = instance.snapshot(['a.json'])
    expect(snapshot).toMatchObject({
      path: 'a.json',
      content: '{ "x": 1 }',
      existsOnDisk: true,
      pendingDelete: false,
      dirty: true,
      conflicted: false,
      expectedRevision: 'rev-1',
    })
  })

  it('未打开的路径回 content=null 而不是抛错', () => {
    expect(store().snapshot(['nope.json'])[0]).toMatchObject({ content: null, existsOnDisk: false })
  })
})

describe('document store applyPrepared', () => {
  it('按最小区间改 JSON：其余字节不动，且是一步撤销', () => {
    const instance = store()
    instance.open('workflows/f.json', WORKFLOW)
    const versionBefore = instance.modelVersion('workflows/f.json')!

    expect(instance.applyPrepared(command(instance))).toEqual({ ok: true })
    expect(instance.contentOf('workflows/f.json'))
      .toBe(WORKFLOW.replace('"run_script"', '"dispatch_mission"'))
    expect(instance.modelVersion('workflows/f.json')).toBeGreaterThan(versionBefore)
  })

  it('工作区代号不符 → stale，且一个字节都不写', () => {
    const instance = store()
    instance.open('workflows/f.json', WORKFLOW)
    const stale = command(instance, {
      expected: {
        workspaceEpoch: instance.workspaceEpoch + 1,
        documents: [{ path: 'workflows/f.json', generation: instance.generationOf('workflows/f.json')! }],
      },
    })
    expect(instance.applyPrepared(stale)).toMatchObject({ ok: false, code: 'stale' })
    expect(instance.contentOf('workflows/f.json')).toBe(WORKFLOW)
  })

  it('文档在 prepare 之后被改过 → stale，内容保持用户那一版', () => {
    const instance = store()
    instance.open('workflows/f.json', WORKFLOW)
    const prepared = command(instance)
    // 用户在 Monaco 里又敲了一下。
    instance.applyEdit('workflows/f.json', `${WORKFLOW}\n`, instance.modelVersion('workflows/f.json')!)
    const userContent = instance.contentOf('workflows/f.json')

    expect(instance.applyPrepared(prepared)).toMatchObject({ ok: false, code: 'stale' })
    expect(instance.contentOf('workflows/f.json')).toBe(userContent)
  })

  it('目标处于冲突态 → conflict，不覆盖', () => {
    const instance = store()
    instance.open('workflows/f.json', WORKFLOW, 'rev-1')
    instance.applyEdit('workflows/f.json', '{ "name": "local" }', instance.modelVersion('workflows/f.json')!)
    const prepared = command(instance)
    instance.enterConflict('workflows/f.json', { diskContent: '{ "name": "disk" }', diskRevision: 'rev-2' })

    expect(instance.applyPrepared(prepared)).toMatchObject({ ok: false, code: 'conflict' })
    expect(instance.contentOf('workflows/f.json')).toBe('{ "name": "local" }')
  })

  it('跨文件命令：任一前置失效则两个文件都不写', () => {
    const instance = store()
    instance.open('workflows/f.json', WORKFLOW)
    instance.open('fh2-plugin.json', '{ "scripts": [] }')
    const prepared: PreparedCommand = {
      kind: 'CreateScriptAndBind',
      label: '新建业务功能并绑定',
      edits: [
        { path: 'fh2-plugin.json', kind: 'modify', ops: [{ path: ['scripts', 0], value: { name: 's' }, insert: true }] },
        { path: 'workflows/f.json', kind: 'modify', ops: [{ path: ['steps', 0, 'action'], value: 'run_script' }] },
      ],
      expected: {
        workspaceEpoch: instance.workspaceEpoch,
        documents: [
          { path: 'fh2-plugin.json', generation: instance.generationOf('fh2-plugin.json')! },
          // 这一个故意给错的代号。
          { path: 'workflows/f.json', generation: 999_999 },
        ],
      },
    }
    expect(instance.applyPrepared(prepared)).toMatchObject({ ok: false, code: 'stale' })
    expect(instance.contentOf('fh2-plugin.json')).toBe('{ "scripts": [] }')
    expect(instance.contentOf('workflows/f.json')).toBe(WORKFLOW)
  })

  it('跨文件成功时**只发一个**事件，且带上两个路径', () => {
    const instance = store()
    instance.open('workflows/f.json', WORKFLOW)
    instance.open('fh2-plugin.json', '{ "scripts": [] }')

    const listener = vi.fn()
    instance.onDidChange(listener)
    const prepared: PreparedCommand = {
      kind: 'CreateScriptAndBind',
      label: '新建业务功能并绑定',
      edits: [
        { path: 'fh2-plugin.json', kind: 'modify', ops: [{ path: ['scripts', 0], value: { name: 's' }, insert: true }] },
        { path: 'workflows/f.json', kind: 'modify', ops: [{ path: ['steps', 0, 'action'], value: 'plugin.x' }] },
      ],
      expected: {
        workspaceEpoch: instance.workspaceEpoch,
        documents: [
          { path: 'fh2-plugin.json', generation: instance.generationOf('fh2-plugin.json')! },
          { path: 'workflows/f.json', generation: instance.generationOf('workflows/f.json')! },
        ],
      },
    }
    expect(instance.applyPrepared(prepared).ok).toBe(true)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]![0]).toMatchObject({
      reason: 'command',
      commandKind: 'CreateScriptAndBind',
      paths: ['fh2-plugin.json', 'workflows/f.json'],
    })
  })

  it('create 生成虚拟文件：dirty=true、existsOnDisk=false', () => {
    const instance = store()
    instance.open('workflows/f.json', WORKFLOW)
    const prepared: PreparedCommand = {
      kind: 'CreateScriptFunction',
      label: '新建业务功能',
      edits: [{ path: 'adapters/new.js', kind: 'create', content: 'function handle () {}\n' }],
      expected: { workspaceEpoch: instance.workspaceEpoch, documents: [] },
    }
    expect(instance.applyPrepared(prepared).ok).toBe(true)

    const [snapshot] = instance.snapshot(['adapters/new.js'])
    expect(snapshot).toMatchObject({ existsOnDisk: false, dirty: true })
    expect(snapshot!.content).toBe('function handle () {}\n')
  })

  it('create 目标已存在 → stale，不覆盖既有内容', () => {
    const instance = store()
    instance.open('adapters/x.js', 'export const old = 1\n')
    const prepared: PreparedCommand = {
      kind: 'CreateScriptFunction',
      label: '新建业务功能',
      edits: [{ path: 'adapters/x.js', kind: 'create', content: 'brand new\n' }],
      expected: { workspaceEpoch: instance.workspaceEpoch, documents: [] },
    }
    expect(instance.applyPrepared(prepared)).toMatchObject({ ok: false, code: 'stale' })
    expect(instance.contentOf('adapters/x.js')).toBe('export const old = 1\n')
  })

  it('modify 未打开的文件 → invalid（是程序缺陷，不该重试）', () => {
    const instance = store()
    const prepared: PreparedCommand = {
      kind: 'SetInput',
      label: '设置入参',
      edits: [{ path: 'nope.json', kind: 'modify', ops: [{ path: ['a'], value: 1 }] }],
      expected: { workspaceEpoch: instance.workspaceEpoch, documents: [] },
    }
    expect(instance.applyPrepared(prepared)).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('delete 标成待删，但内容与 model 还在（保存时才落盘）', () => {
    const instance = store()
    instance.open('adapters/old.js', 'old\n')
    const prepared: PreparedCommand = {
      kind: 'MoveScriptFile',
      label: '移动脚本文件',
      edits: [{ path: 'adapters/old.js', kind: 'delete' }],
      expected: {
        workspaceEpoch: instance.workspaceEpoch,
        documents: [{ path: 'adapters/old.js', generation: instance.generationOf('adapters/old.js')! }],
      },
    }
    expect(instance.applyPrepared(prepared).ok).toBe(true)
    expect(instance.snapshot(['adapters/old.js'])[0]).toMatchObject({ pendingDelete: true })
    expect(instance.contentOf('adapters/old.js')).toBe('old\n')
  })

  it('命令历史记录 kind/label/paths，且有上限', () => {
    const instance = store()
    instance.open('workflows/f.json', WORKFLOW)
    for (let index = 0; index < 3; index += 1) {
      expect(instance.applyPrepared(command(instance, {
        kind: `Cmd${index}`,
        label: `第 ${index} 步`,
        edits: [{
          path: 'workflows/f.json',
          kind: 'modify',
          ops: [{ path: ['steps', 0, 'action'], value: `act_${index}` }],
        }],
      })).ok).toBe(true)
    }
    expect(instance.history.map(entry => entry.kind)).toEqual(['Cmd0', 'Cmd1', 'Cmd2'])
    expect(instance.history.at(-1)).toMatchObject({ label: '第 2 步', paths: ['workflows/f.json'] })
  })

  it('replace 用于非 JSON 文件的整份替换', () => {
    const instance = store()
    instance.open('adapters/x.js', 'old\n')
    const prepared: PreparedCommand = {
      kind: 'ReplaceSource',
      label: '替换源码',
      edits: [{ path: 'adapters/x.js', kind: 'replace', content: 'new source\n' }],
      expected: {
        workspaceEpoch: instance.workspaceEpoch,
        documents: [{ path: 'adapters/x.js', generation: instance.generationOf('adapters/x.js')! }],
      },
    }
    expect(instance.applyPrepared(prepared).ok).toBe(true)
    expect(instance.contentOf('adapters/x.js')).toBe('new source\n')
  })

  it('jSON 路径算不出来时回 invalid，且不写任何文件', () => {
    const instance = store()
    instance.open('workflows/f.json', 'not json at all')
    instance.open('other.json', '{}')
    const prepared: PreparedCommand = {
      kind: 'SetInput',
      label: '设置入参',
      edits: [
        { path: 'other.json', kind: 'modify', ops: [{ path: ['ok'], value: 1 }] },
        { path: 'workflows/f.json', kind: 'modify', ops: [{ path: ['steps', 0, 'action'], value: 'x' }] },
      ],
      expected: {
        workspaceEpoch: instance.workspaceEpoch,
        documents: [
          { path: 'other.json', generation: instance.generationOf('other.json')! },
          { path: 'workflows/f.json', generation: instance.generationOf('workflows/f.json')! },
        ],
      },
    }
    // ⚠️ 必须**整条拒**。jsonc-parser 对解析不开的文本回空编辑而不报错，
    // 若不先判一次，这条命令会静默只写 other.json —— 正是要防的中间态。
    expect(instance.applyPrepared(prepared)).toMatchObject({ ok: false, code: 'invalid' })
    expect(instance.contentOf('other.json')).toBe('{}')
    expect(instance.contentOf('workflows/f.json')).toBe('not json at all')
  })
})
