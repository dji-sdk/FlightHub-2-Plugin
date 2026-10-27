// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import * as monaco from 'monaco-editor'
import { createPinia, setActivePinia } from 'pinia'
import { DragDropProvider } from '@dnd-kit/vue'
import { createApp, h, provide } from 'vue'
import type { App } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IDE_KEY } from '../composables/use-ide'
import { useDocumentsStore } from '../stores/documents'
import { useFileTreeStore } from '../stores/file-tree'
import { ideApi } from '../api/client'
import { useRecoveryStore } from '../stores/recovery'
import { useWorkspaceStore } from '../stores/workspace'
import TreeInlineInput from './tree/TreeInlineInput.vue'
import ConflictDialog from './conflicts/ConflictDialog.vue'
import RecoveryDialog from './conflicts/RecoveryDialog.vue'
import FileTreeNode from './tree/FileTreeNode.vue'

let app: App | undefined
let root: HTMLElement
const create = vi.fn(async (..._args: unknown[]) => false)
beforeEach(() => {
  setActivePinia(createPinia())
  create.mockClear()
})
afterEach(() => {
  app?.unmount()
  root?.remove()
  for (const model of monaco.editor.getModels()) model.dispose()
  vi.restoreAllMocks()
})
function mount (component: typeof ConflictDialog | typeof TreeInlineInput | typeof RecoveryDialog | typeof FileTreeNode, props = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  app = createApp({ setup () {
    provide(IDE_KEY, { createTreeEntry: create, refreshTree: vi.fn(), openFile: vi.fn(), loadTreeChildren: vi.fn() } as never)
    return () => h(DragDropProvider, {}, { default: () => h(component, props) })
  } })
  root = document.createElement('div')
  document.body.append(root)
  app.use(pinia)
  app.mount(root)
}

it('diff 跟随冲突快照，关闭再打开重新绑定容器且释放临时 model', async () => {
  const setModel = vi.fn()
  const dispose = vi.fn()
  const createDiff = vi.spyOn(monaco.editor, 'createDiffEditor').mockImplementation(() => ({ setModel, dispose } as never))
  mount(ConflictDialog)
  const documents = useDocumentsStore()
  documents.open('a.json', 'LOCAL', 'r1')
  documents.enterConflict('a.json', { diskContent: 'DISK_ONE', diskRevision: 'r2' })
  await vi.waitFor(() => expect(setModel).toHaveBeenCalledOnce())
  const pair = setModel.mock.calls[0]![0] as { original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel }
  documents.enterConflict('a.json', { diskContent: 'DISK_TWO', diskRevision: 'r3' })
  await vi.waitFor(() => expect(pair.original.getValue()).toBe('DISK_TWO'))
  documents.keepLocal('a.json')
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
  expect(pair.original.isDisposed()).toBe(true)
  expect(pair.modified.isDisposed()).toBe(true)
  expect(documents.contentOf('a.json')).toBe('LOCAL')
  documents.enterConflict('a.json', { diskContent: 'DISK_THREE', diskRevision: 'r4' })
  await vi.waitFor(() => expect(createDiff).toHaveBeenCalledTimes(2))
  app!.unmount()
  app = undefined
  expect(monaco.editor.getModels()).toHaveLength(1)
})

it('生成/忽略文件和目录置灰，活动文件仍可识别', async () => {
  const child = { path: 'dist/file.js', name: 'file.js', kind: 'file' as const, generated: true, ignored: true }
  const node = { path: 'dist', name: 'dist', kind: 'dir' as const, generated: true, ignored: true, childrenLoaded: true, children: [child] }
  mount(FileTreeNode, { node, depth: 0 })
  const tree = useFileTreeStore()
  tree.setTree([node], false)
  tree.collapsed.delete('dist')
  useDocumentsStore().open(child.path, 'content')
  await vi.waitFor(() => expect(root.querySelector('.tree-file')).not.toBeNull())
  expect(root.querySelector('.tree-dir')?.classList.contains('tree-generated')).toBe(true)
  expect(root.querySelector('.tree-file')?.getAttribute('data-ignored')).toBe('true')
  expect(root.querySelector('.tree-file')?.classList.contains('tree-generated')).toBe(true)
  expect(root.querySelector('.tree-file')?.classList.contains('active')).toBe(true)
})

it('另存副本失败显示错误并保留冲突，扩展名不变', async () => {
  vi.spyOn(monaco.editor, 'createDiffEditor').mockImplementation(() => ({ setModel: vi.fn(), dispose: vi.fn() } as never))
  const creating = vi.spyOn(ideApi, 'fsCreate').mockRejectedValue(new Error('disk unavailable'))
  mount(ConflictDialog)
  const documents = useDocumentsStore()
  documents.open('a.json', 'LOCAL', 'r1')
  documents.enterConflict('a.json', { diskContent: 'DISK', diskRevision: 'r2' })
  await vi.waitFor(() => expect(document.querySelector('.conflict-actions')).not.toBeNull())
  const button = [...document.querySelectorAll('.conflict-actions button')].find(element => element.textContent?.includes('另存副本'))!
  button.dispatchEvent(new MouseEvent('click'))
  await vi.waitFor(() => expect(document.querySelector('.dialog-error')?.textContent).toContain('disk unavailable'))
  expect(creating.mock.calls[0]?.[0]).toMatch(/^a\.json\.local-\d+$/)
  expect(documents.conflictedPaths).toEqual(['a.json'])
})

it('输入法 Enter/Escape 不提交取消；普通回车提交，失败保留输入', async () => {
  mount(TreeInlineInput, { session: { mode: 'create', kind: 'file', base: '' }, depth: 0 })
  const tree = useFileTreeStore()
  tree.beginCreate('file', '')
  const input = root.querySelector('input')!
  input.value = '中文.ts'
  input.dispatchEvent(new Event('input'))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true }))
  expect(create).not.toHaveBeenCalled()
  expect(tree.editing).not.toBeNull()
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
  expect(input.value).toBe('中文.ts')
  expect(tree.editing).not.toBeNull()
})

it('空名回车不再静默取消：走创建校验被拒后保留输入框', async () => {
  mount(TreeInlineInput, { session: { mode: 'create', kind: 'file', base: '' }, depth: 0 })
  const tree = useFileTreeStore()
  tree.beginCreate('file', '')
  const input = root.querySelector('input')!
  input.value = '   '
  input.dispatchEvent(new Event('input'))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  // 空名交给 createTreeEntry（内部 validEntryName 拒绝 + 状态栏报错），组件不短路
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
  expect(create.mock.calls[0]?.[2]).toBe('')
  expect(tree.editing).not.toBeNull()
  expect(input.value).toBe('   ')
})

it('冲突另存副本成功后原文件保持本地内容且仍 dirty，副本为本地快照（DAG-017-08 规格）', async () => {
  vi.spyOn(monaco.editor, 'createDiffEditor').mockImplementation(() => ({ setModel: vi.fn(), dispose: vi.fn() } as never))
  const creating = vi.spyOn(ideApi, 'fsCreate').mockResolvedValue(undefined as never)
  mount(ConflictDialog)
  const documents = useDocumentsStore()
  documents.open('a.json', 'BASE', 'r1')
  documents.applyEdit('a.json', 'LOCAL', documents.modelVersion('a.json')!)
  documents.enterConflict('a.json', { diskContent: 'DISK', diskRevision: 'r2' })
  await vi.waitFor(() => expect(document.querySelector('.conflict-actions')).not.toBeNull())
  const button = [...document.querySelectorAll('.conflict-actions button')].find(element => element.textContent?.includes('另存副本'))!
  button.dispatchEvent(new MouseEvent('click'))
  await vi.waitFor(() => expect(documents.conflictedPaths).toEqual([]))
  expect(creating).toHaveBeenCalledWith(expect.stringMatching(/\.json\.local-\d+$/), 'file', 'LOCAL')
  // 九列规格：副本 L1、原盘 D1 不变；本地 dirty。用户刚把本地内容存进副本，
  // 主编辑器应保持本地继续编辑——takeDisk 换成磁盘版会把用户的工作现场换掉。
  expect(documents.contentOf('a.json')).toBe('LOCAL')
  expect(documents.isDirty('a.json')).toBe(true)
})

function deletedFile () {
  const documents = useDocumentsStore()
  useWorkspaceStore().info = { root: '/tmp/recover', sessionId: 's1' } as never
  documents.open('a.json', 'base', 'r1')
  documents.applyEdit('a.json', 'LOCAL', documents.modelVersion('a.json')!)
  useRecoveryStore().retain({ root: '/tmp/recover', session: 's1', path: 'a.json', content: 'LOCAL', deleted: true })
  return documents
}
async function clickRecovery (label: string) {
  await vi.waitFor(() => expect(document.querySelector('.recovery-actions')).not.toBeNull())
  const button = [...document.querySelectorAll('.recovery-actions button')].find(element => element.textContent?.includes(label))!
  button.dispatchEvent(new MouseEvent('click'))
}

it('删除恢复失败保留内容；重新创建后更新基线，不丢等待期间的新编辑', async () => {
  mount(RecoveryDialog)
  const documents = deletedFile()
  const creating = vi.spyOn(ideApi, 'fsCreate').mockRejectedValue(new Error('disk unavailable'))
  await clickRecovery('重新创建')
  await vi.waitFor(() => expect(document.querySelector('.dialog-error')?.textContent).toContain('disk unavailable'))
  expect(useRecoveryStore().files).toHaveLength(1)
  let resolve!: () => void
  creating.mockImplementation(() => new Promise((done) => {
    resolve = () => done(undefined as never)
  }))
  vi.spyOn(ideApi, 'readFile').mockResolvedValue({ path: 'a.json', content: 'LOCAL', revision: 'r2', encoding: 'utf-8' })
  await clickRecovery('重新创建')
  documents.applyEdit('a.json', 'NEW_LOCAL', documents.modelVersion('a.json')!)
  resolve()
  await vi.waitFor(() => expect(useRecoveryStore().files).toHaveLength(0))
  expect(documents.contentOf('a.json')).toBe('NEW_LOCAL')
  expect(documents.expectedRevision('a.json')).toBe('r2')
  expect(documents.isDirty('a.json')).toBe(true)
})

it('删除恢复副本等待期间继续编辑，保留更新快照；丢弃旧快照不丢新内容', async () => {
  mount(RecoveryDialog)
  const documents = deletedFile()
  let resolve!: () => void
  vi.spyOn(ideApi, 'fsCreate').mockImplementation(() => new Promise((done) => {
    resolve = () => done(undefined as never)
  }))
  vi.spyOn(ideApi, 'readFile').mockResolvedValue({ path: 'a.local.json', content: 'LOCAL', revision: 'r2', encoding: 'utf-8' })
  await clickRecovery('另存副本')
  documents.applyEdit('a.json', 'NEW_LOCAL', documents.modelVersion('a.json')!)
  resolve()
  await vi.waitFor(() => expect(useRecoveryStore().files[0]?.content).toBe('NEW_LOCAL'))
  expect(documents.isDirty('a.json')).toBe(true)
  documents.applyEdit('a.json', 'LATEST', documents.modelVersion('a.json')!)
  await clickRecovery('丢弃恢复内容')
  await vi.waitFor(() => expect(useRecoveryStore().files[0]?.content).toBe('LATEST'))
  expect(documents.contentOf('a.json')).toBe('LATEST')
  await clickRecovery('丢弃恢复内容')
  await vi.waitFor(() => expect(useRecoveryStore().files).toHaveLength(0))
  expect(documents.has('a.json')).toBe(false)
})
