// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import * as monaco from 'monaco-editor'
import { pathToUri } from '../editor/document-store.js'
import { useDocumentsStore } from './documents.js'

/** 与 document-store.test.ts 相同的理由：用真实 model 验证 dirty/撤销语义。 */

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  for (const model of monaco.editor.getModels()) model.dispose()
})

function typeInto (path: string, text: string): void {
  const model = monaco.editor.getModel(pathToUri(path))
  if (model === null) throw new Error(`model 不存在: ${path}`)
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null)
  model.pushStackElement()
}

describe('documents store', () => {
  it('reactive 镜像：open/active/openPaths/isDirty 跟随 DocumentStore', () => {
    const documents = useDocumentsStore()
    documents.open('a.ts', 'let a = 1')
    documents.open('b.ts', 'let b = 2')
    expect(documents.openPaths).toEqual(['a.ts', 'b.ts'])
    expect(documents.active).toBe('b.ts')
    expect(documents.isDirty('a.ts')).toBe(false)
    typeInto('b.ts', 'let b = 3')
    expect(documents.isDirty('b.ts')).toBe(true)
    expect(documents.hasDirty).toBe(true)
    documents.markSaved('b.ts', 'let b = 3', 'r1')
    expect(documents.hasDirty).toBe(false)
  })

  it('requestClose：干净文件直接关；脏文件需连点两次', () => {
    const documents = useDocumentsStore()
    documents.open('clean.ts', 'x')
    expect(documents.requestClose('clean.ts')).toBe('closed')
    expect(documents.has('clean.ts')).toBe(false)

    documents.open('dirty.ts', 'x')
    typeInto('dirty.ts', 'y')
    expect(documents.requestClose('dirty.ts')).toBe('needs-confirm')
    expect(documents.pendingClosePath).toBe('dirty.ts')
    expect(documents.has('dirty.ts')).toBe(true)
    expect(documents.requestClose('dirty.ts')).toBe('closed')
    expect(documents.has('dirty.ts')).toBe(false)
    expect(documents.pendingClosePath).toBeNull()
  })

  it('requestClose：选中其他 tab 后脏文件计数重置，再关仍需两次确认', () => {
    const documents = useDocumentsStore()
    documents.open('a.ts', 'a')
    documents.open('b.ts', 'b')
    typeInto('b.ts', 'b2')
    expect(documents.requestClose('b.ts')).toBe('needs-confirm')
    documents.activate('a.ts')
    documents.pendingClosePath = null
    expect(documents.requestClose('b.ts')).toBe('needs-confirm')
  })

  it('remapOpenDocuments：脏文档带着内容与 dirty 跟随，干净文档按已保存重开', () => {
    const documents = useDocumentsStore()
    documents.open('src/a.ts', 'content-a')
    documents.open('src/sub/b.ts', 'content-b')
    documents.open('other/c.ts', 'content-c')
    typeInto('src/a.ts', 'content-a2')

    const followed = documents.remapOpenDocuments('src', 'renamed')
    expect(followed).toEqual([{ from: 'src/a.ts', to: 'renamed/a.ts' }])
    expect(documents.has('src/a.ts')).toBe(false)
    expect(documents.has('renamed/a.ts')).toBe(true)
    expect(documents.contentOf('renamed/a.ts')).toBe('content-a2')
    expect(documents.isDirty('renamed/a.ts')).toBe(true)
    expect(documents.has('src/sub/b.ts')).toBe(false)
    expect(documents.has('renamed/sub/b.ts')).toBe(true)
    expect(documents.isDirty('renamed/sub/b.ts')).toBe(false)
    // 不在改名范围内的文档不动
    expect(documents.has('other/c.ts')).toBe(true)
  })

  it('reset 关掉全部文档并清空关闭确认状态', () => {
    const documents = useDocumentsStore()
    documents.open('a.ts', 'a')
    typeInto('a.ts', 'a2')
    documents.requestClose('a.ts')
    documents.reset()
    expect(documents.openPaths).toEqual([])
    expect(documents.pendingClosePath).toBeNull()
    expect(documents.hasDirty).toBe(false)
  })

  it('rename 覆盖目标缓存仍保留源修改、基线与活动标签顺序', () => {
    const documents = useDocumentsStore()
    documents.open('from.ts', 'SOURCE', 'source-hash')
    typeInto('from.ts', 'UNSAVED_SOURCE')
    documents.open('other.ts', 'other', 'r2')
    documents.open('to.ts', 'OLD_TARGET', 'target-hash')
    documents.activate('other.ts')
    documents.remapOpenDocuments('from.ts', 'to.ts')
    expect(documents.contentOf('to.ts')).toBe('UNSAVED_SOURCE')
    expect(documents.expectedRevision('to.ts')).toBe('source-hash')
    expect(documents.isDirty('to.ts')).toBe(true)
    expect(documents.openPaths).toEqual(['to.ts', 'other.ts'])
    expect(documents.active).toBe('other.ts')
  })

  it('rename 保持其他消费者的 model 生命周期与冲突快照', () => {
    const documents = useDocumentsStore()
    documents.open('from.ts', 'source', 'r1')
    const acquired = documents.acquireModel('from.ts', 'ignored')
    documents.enterConflict('from.ts', { diskContent: 'new disk', diskRevision: 'r2' })
    documents.remapOpenDocuments('from.ts', 'to.ts')
    expect(acquired.model.isDisposed()).toBe(false)
    expect(documents.conflictOf('to.ts')?.diskRevision).toBe('r2')
    acquired.release()
    expect(acquired.model.isDisposed()).toBe(true)
    expect(documents.contentOf('to.ts')).toBe('source')
  })

  it('覆盖被其他消费者引用的目标时复用目标 model，释放不会误删迁移文档', () => {
    const documents = useDocumentsStore()
    documents.open('from.ts', 'source', 'r1')
    documents.open('to.ts', 'old target', 'r2')
    const acquired = documents.acquireModel('to.ts', 'ignored')
    documents.remapOpenDocuments('from.ts', 'to.ts')
    expect(acquired.model.getValue()).toBe('source')
    acquired.release()
    expect(documents.contentOf('to.ts')).toBe('source')
    expect(documents.expectedRevision('to.ts')).toBe('r1')
  })
})
