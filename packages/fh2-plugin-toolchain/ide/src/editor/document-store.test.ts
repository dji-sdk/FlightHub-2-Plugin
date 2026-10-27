// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor'
import { DocumentStore, languageOf, pathToUri, uriToPath, uriToWorkspacePath, workspacePathToUri } from './document-store.js'

/**
 * 用真实 monaco model（editor.api 纯模型层，不需要 DOM 容器），
 * 因为被测的核心正是 `getAlternativeVersionId()` 的撤销语义 —— 换成手写假 model 就等于
 * 把要验证的行为自己重新实现一遍，测不出东西。
 */

const stores: DocumentStore[] = []

function newStore (): DocumentStore {
  const store = new DocumentStore()
  stores.push(store)
  return store
}

afterEach(() => {
  // model 注册表按 URI 全局唯一，不清干净下个用例 createModel 会撞 URI
  for (const store of stores.splice(0)) {
    for (const path of [...store.openPaths]) store.close(path)
  }
  for (const model of monaco.editor.getModels()) model.dispose()
  vi.restoreAllMocks()
})

/** 在 model 上追加一次可撤销编辑（等价于用户敲一段后停手）。 */
function typeInto (store: DocumentStore, path: string, text: string): void {
  const model = monaco.editor.getModel(pathToUri(path))!
  model.pushEditOperations(
    [],
    [{ range: model.getFullModelRange(), text }],
    () => null,
  )
  // Monaco 默认把连续编辑并进同一个撤销元素；真实编辑器会在停顿/移光标时切分，这里显式切
  model.pushStackElement()
}

function undo (path: string): void {
  ;(monaco.editor.getModel(pathToUri(path)) as unknown as { undo: () => void }).undo()
}

function redo (path: string): void {
  ;(monaco.editor.getModel(pathToUri(path)) as unknown as { redo: () => void }).redo()
}

describe('web ide path/uri 映射', () => {
  it('path 与 URI 双向可逆，且保留完整相对路径以区分同名文件', () => {
    for (const path of ['fh2-plugin.json', 'sub/fh2-plugin.json', 'src/views/panel.ts']) {
      expect(uriToPath(pathToUri(path))).toBe(path)
    }
    expect(pathToUri('fh2-plugin.json').toString()).not.toBe(pathToUri('sub/fh2-plugin.json').toString())
  })

  it('含空格与中文的路径经 encodeURIComponent 仍能还原', () => {
    for (const path of ['src/我的 视图.ts', 'a b/c d.json']) {
      expect(uriToPath(pathToUri(path))).toBe(path)
    }
  })

  it('绝对工作区 URI 能还原为工作区相对路径，包含中文与空格', () => {
    const root = '/workspace/plugin workspace'
    for (const path of ['fh2-plugin.json', 'official_accident/backend/plugin/fh2-plugin.json', 'src/我的 视图.ts']) {
      expect(uriToWorkspacePath(workspacePathToUri(root, path), root)).toBe(path)
    }
    expect(uriToWorkspacePath(workspacePathToUri(root, ''), root)).toBe('.')
  })

  it('languageOf 按扩展名映射，未知扩展与无扩展都落到 plaintext', () => {
    expect(languageOf('fh2-plugin.json')).toBe('json')
    expect(languageOf('src/plugin.ts')).toBe('typescript')
    expect(languageOf('src/App.VUE')).toBe('html')
    expect(languageOf('schema.sql')).toBe('pgsql')
    expect(languageOf('migrations/SCHEMA.SQL')).toBe('pgsql')
    expect(languageOf('README.md')).toBe('markdown')
    expect(languageOf('LICENSE')).toBe('plaintext')
    expect(languageOf('data.unknownext')).toBe('plaintext')
  })
})

describe('web ide document store dirty 追踪', () => {
  it('新打开的文档不是 dirty；编辑后变 dirty', () => {
    const store = newStore()
    store.open('src/plugin.ts', 'export const a = 1\n')
    expect(store.isDirty('src/plugin.ts')).toBe(false)
    expect(store.hasDirty).toBe(false)

    typeInto(store, 'src/plugin.ts', 'export const a = 2\n')
    expect(store.isDirty('src/plugin.ts')).toBe(true)
    expect(store.hasDirty).toBe(true)
  })

  it('编辑后撤销回基线要重新变成非 dirty（alternativeVersionId 而非内容比对的关键收益）', () => {
    const store = newStore()
    store.open('src/plugin.ts', 'v0')

    typeInto(store, 'src/plugin.ts', 'v1')
    expect(store.isDirty('src/plugin.ts')).toBe(true)

    undo('src/plugin.ts')
    expect(store.contentOf('src/plugin.ts')).toBe('v0')
    expect(store.isDirty('src/plugin.ts')).toBe(false)

    // 再 redo 回去必须重新 dirty，否则等于把 dirty 状态丢了
    redo('src/plugin.ts')
    expect(store.contentOf('src/plugin.ts')).toBe('v1')
    expect(store.isDirty('src/plugin.ts')).toBe(true)
  })

  it('内容改回与基线相同时不算 dirty（F3 内容基线语义）', () => {
    const store = newStore()
    store.open('src/plugin.ts', 'v0')

    typeInto(store, 'src/plugin.ts', 'v1')
    typeInto(store, 'src/plugin.ts', 'v0')

    // F3：dirty = model 内容 !== 磁盘基线内容。内容一致即干净，
    // 保存是幂等 no-op；这与版本号基线（动过即脏）不同，是有意的契约变更。
    expect(store.contentOf('src/plugin.ts')).toBe('v0')
    expect(store.isDirty('src/plugin.ts')).toBe(false)
  })

  it('未打开的路径既不是 dirty 也没有内容', () => {
    const store = newStore()
    expect(store.has('src/missing.ts')).toBe(false)
    expect(store.isDirty('src/missing.ts')).toBe(false)
    expect(store.contentOf('src/missing.ts')).toBeNull()
  })

  it('hasDirty 只要有一个文档脏就为真', () => {
    const store = newStore()
    store.open('a.ts', 'a')
    store.open('b.ts', 'b')
    expect(store.hasDirty).toBe(false)

    typeInto(store, 'b.ts', 'b2')
    expect(store.isDirty('a.ts')).toBe(false)
    expect(store.hasDirty).toBe(true)
  })
})

describe('web ide document store 基线推进', () => {
  it('markSaved 把基线推进到当前版本，且撤销栈完好', () => {
    const store = newStore()
    store.open('src/plugin.ts', 'v0')
    typeInto(store, 'src/plugin.ts', 'v1')

    store.markSaved('src/plugin.ts', 'v1', 'r1')
    expect(store.isDirty('src/plugin.ts')).toBe(false)

    // 保存不重建 model：撤销仍能退回保存前的内容
    undo('src/plugin.ts')
    expect(store.contentOf('src/plugin.ts')).toBe('v0')
    expect(store.isDirty('src/plugin.ts')).toBe(true)
  })

  it('保存后再编辑再撤销，回到的是「上次保存」那个基线而不是首次打开的内容', () => {
    const store = newStore()
    store.open('src/plugin.ts', 'v0')
    typeInto(store, 'src/plugin.ts', 'v1')
    store.markSaved('src/plugin.ts', 'v1', 'r1')

    typeInto(store, 'src/plugin.ts', 'v2')
    expect(store.isDirty('src/plugin.ts')).toBe(true)

    undo('src/plugin.ts')
    expect(store.contentOf('src/plugin.ts')).toBe('v1')
    expect(store.isDirty('src/plugin.ts')).toBe(false)
  })

  it('markSaved 作用于未打开的路径时静默无副作用', () => {
    const store = newStore()
    store.open('a.ts', 'a')
    typeInto(store, 'a.ts', 'a2')

    store.markSaved('src/missing.ts', 'x', 'r')
    expect(store.isDirty('a.ts')).toBe(true)
  })

  it('markSaved 会通知监听者刷新（tab 上的脏标记靠它）', () => {
    const store = newStore()
    store.open('a.ts', 'a')
    const listener = vi.fn()
    store.onDidChange(listener)

    store.markSaved('a.ts', 'a', 'r')
    expect(listener).toHaveBeenCalled()
  })

  it('虚拟文档 create 落盘后 existsOnDisk 推进为 true，下一次保存不再是 create', () => {
    const store = newStore()
    store.openUnsaved('adapters/new-probe.ts', 'v1')
    expect(store.snapshot(['adapters/new-probe.ts'])[0]?.existsOnDisk).toBe(false)

    // create 成功的保存回执走 markSaved：基线推进 + 文件已在磁盘
    store.markSaved('adapters/new-probe.ts', 'v1', 'r1')
    const snapshot = store.snapshot(['adapters/new-probe.ts'])[0]
    expect(snapshot?.existsOnDisk).toBe(true)
    expect(snapshot?.dirty).toBe(false)
    expect(snapshot?.expectedRevision).toBe('r1')
  })

  it('onDidChange 返回的注销函数生效后不再收到通知', () => {
    const store = newStore()
    store.open('a.ts', 'a')
    const listener = vi.fn()
    const off = store.onDidChange(listener)

    off()
    store.markSaved('a.ts', 'a', 'r')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('web ide document store 外部变更回灌', () => {
  it('reloadFromDisk 写入新内容并把基线推到新版本（回灌后不是 dirty）', () => {
    const store = newStore()
    store.open('src/plugin.ts', 'v0')

    store.reloadFromDisk('src/plugin.ts', 'from-disk')
    expect(store.contentOf('src/plugin.ts')).toBe('from-disk')
    expect(store.isDirty('src/plugin.ts')).toBe(false)
  })

  it('reloadFromDisk 用 pushEditOperations，所以这次外部变更本身可撤销', () => {
    const store = newStore()
    store.open('src/plugin.ts', 'v0')
    store.reloadFromDisk('src/plugin.ts', 'from-disk')

    // setValue 会清空撤销栈，这里必须还能退回回灌前的内容
    undo('src/plugin.ts')
    expect(store.contentOf('src/plugin.ts')).toBe('v0')
    expect(store.isDirty('src/plugin.ts')).toBe(true)
  })

  it('内容与磁盘一致时 reloadFromDisk 直接短路，不产生多余的撤销步骤', () => {
    const store = newStore()
    store.open('src/plugin.ts', 'same')
    const listener = vi.fn()
    store.onDidChange(listener)

    store.reloadFromDisk('src/plugin.ts', 'same')
    expect(store.isDirty('src/plugin.ts')).toBe(false)
    expect(listener).not.toHaveBeenCalled()

    // 没有新增撤销步骤：undo 不该改变内容
    undo('src/plugin.ts')
    expect(store.contentOf('src/plugin.ts')).toBe('same')
  })

  it('reloadFromDisk 作用于未打开的路径时不会把它打开', () => {
    const store = newStore()
    store.reloadFromDisk('src/missing.ts', 'x')
    expect(store.has('src/missing.ts')).toBe(false)
    expect(store.openPaths).toEqual([])
  })

  it('open 复用已打开的 model：磁盘内容不会覆盖用户未保存的编辑', () => {
    const store = newStore()
    store.open('src/plugin.ts', 'v0')
    typeInto(store, 'src/plugin.ts', 'user-edit')
    const model = monaco.editor.getModel(pathToUri('src/plugin.ts'))

    // 再次 open（如从文件树重新点开）传入磁盘内容，脏 buffer 必须原样保留
    store.open('src/plugin.ts', 'stale-from-disk')

    expect(store.contentOf('src/plugin.ts')).toBe('user-edit')
    expect(store.isDirty('src/plugin.ts')).toBe(true)
    // 同一个 model 实例 —— 撤销栈没被重建掉
    expect(monaco.editor.getModel(pathToUri('src/plugin.ts'))).toBe(model)
    undo('src/plugin.ts')
    expect(store.contentOf('src/plugin.ts')).toBe('v0')
  })

  it('同一路径重复 open 不会重复注册内容监听（一次编辑只通知一轮）', () => {
    const store = newStore()
    store.open('a.ts', 'a')
    store.open('a.ts', 'a')
    expect(store.openPaths).toEqual(['a.ts'])

    const listener = vi.fn()
    store.onDidChange(listener)
    typeInto(store, 'a.ts', 'a2')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('web ide document store 打开/激活/关闭', () => {
  it('open 按插入顺序累积 openPaths 并把新文件设为 active', () => {
    const store = newStore()
    store.open('a.ts', 'a')
    store.open('b.ts', 'b')

    expect(store.openPaths).toEqual(['a.ts', 'b.ts'])
    expect(store.active).toBe('b.ts')
    expect(store.has('a.ts')).toBe(true)
  })

  it('activate 未打开的路径时 active 不变', () => {
    const store = newStore()
    store.open('a.ts', 'a')
    store.activate('src/missing.ts')
    expect(store.active).toBe('a.ts')
  })

  it('close 释放 model 并回退 active 到剩余文档', () => {
    const store = newStore()
    store.open('a.ts', 'a')
    store.open('b.ts', 'b')

    store.close('b.ts')
    expect(store.openPaths).toEqual(['a.ts'])
    expect(store.active).toBe('a.ts')
    expect(monaco.editor.getModel(pathToUri('b.ts'))).toBeNull()
  })

  it('关闭非 active 文档不改变 active', () => {
    const store = newStore()
    store.open('a.ts', 'a')
    store.open('b.ts', 'b')

    store.close('a.ts')
    expect(store.active).toBe('b.ts')
    expect(store.openPaths).toEqual(['b.ts'])
  })

  it('关闭最后一个文档后 active 变回 null', () => {
    const store = newStore()
    store.open('a.ts', 'a')

    store.close('a.ts')
    expect(store.active).toBeNull()
    expect(store.openPaths).toEqual([])
    expect(store.hasDirty).toBe(false)
  })

  it('关闭后再 open 同路径是一份全新的干净文档（旧的脏状态与撤销栈都不残留）', () => {
    const store = newStore()
    store.open('a.ts', 'v0')
    typeInto(store, 'a.ts', 'dirty')
    store.close('a.ts')

    store.open('a.ts', 'v0')
    expect(store.contentOf('a.ts')).toBe('v0')
    expect(store.isDirty('a.ts')).toBe(false)
  })

  it('close 未打开的路径时静默无副作用', () => {
    const store = newStore()
    store.open('a.ts', 'a')
    store.close('src/missing.ts')
    expect(store.openPaths).toEqual(['a.ts'])
    expect(store.active).toBe('a.ts')
  })
})

describe('web ide document store 与编辑器联动', () => {
  /** 只实现 store 真正调用到的那几个方法，其余交给 Proxy 兜住。 */
  function fakeEditor () {
    const calls = {
      setModel: [] as Array<monaco.editor.ITextModel | null>,
      restored: [] as unknown[],
      selections: [] as unknown[],
      revealedLines: [] as number[],
      focusCount: 0,
    }
    let viewStateSequence = 0
    const editor = {
      setModel (model: monaco.editor.ITextModel | null) {
        calls.setModel.push(model)
      },
      saveViewState () {
        viewStateSequence += 1
        return { token: viewStateSequence } as unknown as monaco.editor.ICodeEditorViewState
      },
      restoreViewState (state: unknown) {
        calls.restored.push(state)
      },
      setSelection (selection: unknown) {
        calls.selections.push(selection)
      },
      revealLineInCenter (line: number) {
        calls.revealedLines.push(line)
      },
      focus () {
        calls.focusCount += 1
      },
    } as unknown as monaco.editor.IStandaloneCodeEditor
    return { editor, calls }
  }

  it('切档把 model 换到目标文档，并保存/恢复各自的视图状态', () => {
    const store = newStore()
    const { editor, calls } = fakeEditor()
    store.attach(editor)

    store.open('a.ts', 'a')
    // 首次打开 a 时没有旧 active，也没有已存状态：不 save 也不 restore
    expect(calls.restored).toHaveLength(0)

    // 打开 b：a 的视图状态被存下；b 是新文档，没有状态可恢复
    store.open('b.ts', 'b')
    expect(calls.restored).toHaveLength(0)

    // 切回 a：a 上次存过状态，必须被恢复
    store.activate('a.ts')
    expect(calls.restored).toEqual([{ token: 1 }])

    // 再切到 b：恢复的是 b 自己那份，不能串成 a 的
    store.activate('b.ts')
    expect(calls.restored).toEqual([{ token: 1 }, { token: 2 }])

    expect(calls.setModel.at(-1)).toBe(monaco.editor.getModel(pathToUri('b.ts')))
  })

  it('关闭最后一个文档会把编辑器的 model 清成 null', () => {
    const store = newStore()
    const { editor, calls } = fakeEditor()
    store.attach(editor)
    store.open('a.ts', 'a')

    store.close('a.ts')
    expect(calls.setModel.at(-1)).toBeNull()
  })

  it('重新绑定立即恢复活动 model 和视图，不丢修改与 undo、不抢焦点', () => {
    const store = newStore()
    const first = fakeEditor()
    store.open('a.ts', 'base', 'r1')
    store.attach(first.editor)
    typeInto(store, 'a.ts', 'edited')
    const model = store.modelIdentity('a.ts')
    store.detach(first.editor)
    expect(first.calls.setModel.at(-1)).toBeNull()
    const next = fakeEditor()
    store.attach(next.editor)
    expect(next.calls.setModel.at(-1)).toBe(model)
    expect(next.calls.restored).toEqual([{ token: 1 }])
    expect(next.calls.focusCount).toBe(0)
    expect(store.isDirty('a.ts')).toBe(true)
    undo('a.ts')
    expect(store.contentOf('a.ts')).toBe('base')
    store.detach(first.editor)
    store.activate('a.ts')
    expect(next.calls.focusCount).toBe(1)
  })

  it('缓存文档 activate 补标签且保留 model', () => {
    const store = newStore()
    store.openDetached('a.ts', 'base', 'r1')
    const model = store.modelIdentity('a.ts')
    expect(store.tabPaths).toEqual([])
    store.activate('a.ts')
    expect(store.tabPaths).toEqual(['a.ts'])
    expect(store.modelIdentity('a.ts')).toBe(model)
  })

  it('reveal 会先激活目标文档，再定位到光标位置', () => {
    const store = newStore()
    const { editor, calls } = fakeEditor()
    store.attach(editor)
    store.open('a.ts', 'line1\nline2\nline3')
    store.open('b.ts', 'b')

    store.reveal('a.ts', 3, 2)
    expect(store.active).toBe('a.ts')
    expect(calls.selections.at(-1)).toEqual({
      startLineNumber: 3,
      startColumn: 2,
      endLineNumber: 3,
      endColumn: 2,
    })
    expect(calls.revealedLines.at(-1)).toBe(3)
  })

  it('reveal 的行列被夹到最小 1（诊断有时给 0 甚至负数）', () => {
    const store = newStore()
    const { editor, calls } = fakeEditor()
    store.attach(editor)
    store.open('a.ts', 'a')

    store.reveal('a.ts', 0, -5)
    expect(calls.selections.at(-1)).toMatchObject({ startLineNumber: 1, startColumn: 1 })
    expect(calls.revealedLines.at(-1)).toBe(1)
  })

  it('未挂载编辑器时 reveal 静默返回，不抛异常', () => {
    const store = newStore()
    store.open('a.ts', 'a')
    expect(() => store.reveal('a.ts', 1, 1)).not.toThrow()
  })
})

describe('web ide document store F1/F3/F4（绝对 URI、引用计数、冲突）', () => {
  it.each([
    ['/workspace/source fixture', 'file:///workspace/source%20fixture/src/main.ts', '/workspace/other fixture'],
    ['C:\\workspace\\source fixture', 'file:///c%3A/workspace/source%20fixture/src/main.ts', 'C:\\workspace\\other fixture'],
  ])('f1：工作根已知时 model 使用绝对 file URI；切根关闭全部文档：%s', (root, uri, nextRoot) => {
    const store = newStore()
    store.setWorkspaceRoot(root)
    store.open('src/main.ts', 'export {}')
    const model = monaco.editor.getModels().at(-1)!
    expect(model.uri.toString()).toBe(uri)

    store.setWorkspaceRoot(nextRoot)
    expect(store.openPaths).toEqual([])
    expect(monaco.editor.getModels()).toHaveLength(0)
  })

  it('f1：acquireModel 引用计数——两个消费者共享同一 model，最后消费者释放', () => {
    const store = newStore()
    const first = store.acquireModel('shared.ts', 'x')
    const second = store.acquireModel('shared.ts', 'x')
    expect(first.model).toBe(second.model)
    expect(monaco.editor.getModels()).toHaveLength(1)

    first.release()
    expect(monaco.editor.getModels()).toHaveLength(1)
    second.release()
    expect(monaco.editor.getModels()).toHaveLength(0)
  })

  it('f3：保存期间继续输入仍是 dirty（markSaved 只推进提交内容基线）', () => {
    const store = newStore()
    store.open('a.ts', 'v0')
    typeInto(store, 'a.ts', 'v1')
    // 模拟：提交 v1 后、回包前，用户又输入 v2
    store.markSaved('a.ts', 'v1', 'r1')
    typeInto(store, 'a.ts', 'v2')
    expect(store.isDirty('a.ts')).toBe(true)
    expect(store.expectedRevision('a.ts')).toBe('r1')

    // 乱序回包（旧的 v0 保存回包迟到）不能把基线拉回去
    store.markSaved('a.ts', 'v0', 'r0')
    expect(store.contentOf('a.ts')).toBe('v2')
    expect(store.isDirty('a.ts')).toBe(true)
  })

  it('f4：enterConflict/takeDisk/keepLocal 的冲突闭环', () => {
    const store = newStore()
    store.open('a.ts', 'local-v1')
    typeInto(store, 'a.ts', 'local-v2')

    store.enterConflict('a.ts', { diskContent: 'disk-v2', diskRevision: 'rd' })
    expect(store.conflictOf('a.ts')).toEqual({ diskContent: 'disk-v2', diskRevision: 'rd' })
    expect(store.conflictedPaths()).toEqual(['a.ts'])

    // 保留本地：基线 revision 对齐磁盘，下一次保存是确认的覆盖写
    store.keepLocal('a.ts')
    expect(store.conflictOf('a.ts')).toBeNull()
    expect(store.expectedRevision('a.ts')).toBe('rd')
    expect(store.isDirty('a.ts')).toBe(true)

    // 再次冲突后采用磁盘：内容重灌、基线对齐、不再是 dirty
    store.enterConflict('a.ts', { diskContent: 'disk-v3', diskRevision: 'rd3' })
    store.takeDisk('a.ts')
    expect(store.contentOf('a.ts')).toBe('disk-v3')
    expect(store.isDirty('a.ts')).toBe(false)
    expect(store.conflictOf('a.ts')).toBeNull()
  })

  it('f4：本地内容与磁盘一致时 enterConflict 直接对齐基线，不进入冲突态', () => {
    const store = newStore()
    store.open('a.ts', 'same')
    store.enterConflict('a.ts', { diskContent: 'same', diskRevision: 'r' })
    expect(store.conflictOf('a.ts')).toBeNull()
    expect(store.isDirty('a.ts')).toBe(false)
  })
})
