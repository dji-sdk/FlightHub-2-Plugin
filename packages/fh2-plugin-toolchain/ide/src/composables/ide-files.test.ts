// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createPinia, setActivePinia } from 'pinia'
import { createApp } from 'vue'
import type { App } from 'vue'
import * as monaco from 'monaco-editor'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IdeApiError, ideApi } from '../api/client'
import { FsEventStream } from '../api/events'
import type { FsEvent, WorkspaceEvent, WorkspaceInfo } from '../api/types'
import { useDocumentsStore } from '../stores/documents'
import { useWorkspaceStore } from '../stores/workspace'
import { useRecoveryStore } from '../stores/recovery'
import { useFileTreeStore } from '../stores/file-tree'
import { useStatusStore } from '../stores/status'
import { showContextMenu } from '../services/context-menu'
import type { MenuEntry } from '../services/context-menu'
import { closeDialog, dialogState } from '../services/dialog'
import { useIde } from './use-ide'
import type { IdeContext } from './use-ide'

vi.mock('../editor/monaco-setup', () => ({ applyBrowserTypeScriptDefaults: vi.fn(), applyGojaTypeScriptDefaults: vi.fn(), applyJsonSchemas: vi.fn() }))
vi.mock('../services/context-menu', () => ({ showContextMenu: vi.fn(), closeContextMenu: vi.fn() }))
vi.mock('../features/workflow/resources', async (importOriginal) => {
  const original = await importOriginal<typeof import('../features/workflow/resources')>()
  return { ...original, useWorkflowResources: () => {
    const resources = original.useWorkflowResources()
    resources.refreshCatalog = vi.fn(async () => {})
    return resources
  } }
})
vi.mock('../lsp/client', () => ({ LSP_MARKER_OWNER: 'lsp', LspDiagnosticsClient: class {
  setDocumentsProvider () {}
  start () {}
  stop () {}
  scheduleSync () {}
} }))

let app: App | undefined
let ide: IdeContext
let fsListener: ((event: FsEvent) => void) | undefined
let connection: ((connected: boolean) => void) | undefined
let workspaceListener: ((event: WorkspaceEvent) => void) | undefined
const info = { root: '/tmp/test-ide', sessionId: 's1', kind: 'frontend-plugin', diagnostics: [] } as unknown as WorkspaceInfo

beforeEach(() => {
  const pinia = createPinia()
  setActivePinia(pinia)
  vi.spyOn(ideApi, 'workspace').mockResolvedValue(info)
  vi.spyOn(ideApi, 'schemas').mockResolvedValue({ schemas: [] })
  vi.spyOn(ideApi, 'tree').mockResolvedValue({ tree: [], truncated: false })
  vi.spyOn(ideApi, 'taskList').mockResolvedValue({ tasks: [] })
  vi.spyOn(ideApi, 'runStatus').mockResolvedValue({ processes: [] })
  vi.spyOn(ideApi, 'runLogs').mockResolvedValue({ lines: [] })
  vi.spyOn(FsEventStream.prototype, 'start').mockImplementation(() => {})
  vi.spyOn(FsEventStream.prototype, 'onFsEvent').mockImplementation((listener) => {
    fsListener = listener
  })
  vi.spyOn(FsEventStream.prototype, 'onConnectionChange').mockImplementation((listener) => {
    connection = listener
  })
  vi.spyOn(FsEventStream.prototype, 'onWorkspaceEvent').mockImplementation((listener) => {
    workspaceListener = listener
  })
  app = createApp({ setup () {
    ide = useIde()
    return () => null
  } })
  app.use(pinia)
  app.mount(document.createElement('div'))
  useWorkspaceStore().info = info
})
afterEach(() => {
  closeDialog(null)
  app?.unmount()
  for (const model of monaco.editor.getModels()) model.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function deferred<T> () {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { resolve, promise }
}
const file = (path: string, content = path, revision = 'r1') => ({ path, content, revision, encoding: 'utf-8' as const })

function menuItem (label: string) {
  const entries = vi.mocked(showContextMenu).mock.lastCall![2]
  const entry = entries.find((entry: MenuEntry) => entry !== 'separator' && entry.label === label)
  if (entry === undefined || entry === 'separator') throw new Error(`缺少菜单项 ${label}`)
  return entry
}

it('文件、目录、空白区域均有三项系统菜单，删除去掉省略号并保留确认', () => {
  for (const target of [{ path: 'a.ts', kind: 'file' as const }, { path: 'src', kind: 'dir' as const }, null]) {
    ide.showTreeMenu(target, 10, 20)
    for (const label of ['在文件管理器中打开', '复制路径', '复制相对路径']) expect(menuItem(label)).toBeDefined()
  }
  ide.showTreeMenu({ path: 'a.ts', kind: 'file' }, 10, 20)
  const remove = vi.spyOn(ideApi, 'fsDelete')
  expect(menuItem('删除').danger).toBe(true)
  menuItem('删除').onSelect()
  expect(dialogState().current?.spec.title).toBe('删除确认')
  expect(remove).not.toHaveBeenCalled()
})

it('复制服务端Windows原生绝对路径，相对路径保持POSIX，空白区域根为点', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const path = vi.spyOn(ideApi, 'fsPath').mockResolvedValue({ absolutePath: 'C:\\工程\\src\\a.ts', relativePath: 'src/a.ts' })
  ide.showTreeMenu({ path: 'src/a.ts', kind: 'file' }, 0, 0)
  menuItem('复制路径').onSelect()
  await vi.waitFor(() => expect(useStatusStore().message).toContain('已复制路径'))
  expect(writeText).toHaveBeenLastCalledWith('C:\\工程\\src\\a.ts')
  menuItem('复制相对路径').onSelect()
  await vi.waitFor(() => expect(useStatusStore().message).toContain('已复制相对路径'))
  expect(writeText).toHaveBeenLastCalledWith('src/a.ts')
  path.mockResolvedValue({ absolutePath: 'C:\\工程', relativePath: '.' })
  ide.showTreeMenu(null, 0, 0)
  menuItem('复制相对路径').onSelect()
  await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith('.'))
  expect(path).toHaveBeenLastCalledWith('.')
})

it('文件、目录、空白打开发送对应相对路径，完成后才报告成功', async () => {
  const reveal = vi.spyOn(ideApi, 'fsReveal').mockResolvedValue({ absolutePath: '/tmp/test-ide', relativePath: '.' })
  for (const target of [{ path: 'a.ts', kind: 'file' as const }, { path: 'src', kind: 'dir' as const }, null]) {
    ide.showTreeMenu(target, 0, 0)
    menuItem('在文件管理器中打开').onSelect()
    await vi.waitFor(() => expect(useStatusStore().message).toBe(`已在文件管理器中打开 ${target?.path ?? '.'}`))
    expect(reveal).toHaveBeenLastCalledWith(target?.path ?? '.')
  }
})

it('复制权限和系统打开失败在状态栏反馈', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('无剪贴板权限')) } })
  vi.spyOn(ideApi, 'fsPath').mockResolvedValue({ absolutePath: '/tmp/test-ide/a.ts', relativePath: 'a.ts' })
  vi.spyOn(ideApi, 'fsReveal').mockRejectedValue(new Error('启动失败'))
  ide.showTreeMenu({ path: 'a.ts', kind: 'file' }, 0, 0)
  menuItem('复制路径').onSelect()
  await vi.waitFor(() => expect(useStatusStore().message).toContain('复制路径失败'))
  expect(useStatusStore().isError).toBe(true)
  menuItem('在文件管理器中打开').onSelect()
  await vi.waitFor(() => expect(useStatusStore().message).toContain('打开文件管理器失败'))
})

it('过期菜单不发请求，迟到路径回包不写剪贴板也不覆盖新工程状态', async () => {
  const writeText = vi.fn()
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const response = deferred<{ absolutePath: string; relativePath: string }>()
  const path = vi.spyOn(ideApi, 'fsPath').mockReturnValue(response.promise)
  const reveal = vi.spyOn(ideApi, 'fsReveal')
  ide.showTreeMenu({ path: 'a.ts', kind: 'file' }, 0, 0)
  menuItem('复制路径').onSelect()
  useWorkspaceStore().info = { ...info, sessionId: 's2' }
  useStatusStore().set('新工程')
  menuItem('复制相对路径').onSelect()
  menuItem('在文件管理器中打开').onSelect()
  expect(path).toHaveBeenCalledTimes(1)
  expect(reveal).not.toHaveBeenCalled()
  response.resolve({ absolutePath: '/tmp/test-ide/a.ts', relativePath: 'a.ts' })
  await response.promise
  expect(writeText).not.toHaveBeenCalled()
  expect(useStatusStore().message).toBe('新工程')
})

it('a/B 读取倒序回包，最后点击决定活动文件，迟到 A 只缓存', async () => {
  const a = deferred<ReturnType<typeof file>>()
  vi.spyOn(ideApi, 'readFile').mockImplementation(async path => path === 'a.ts' ? await a.promise : file(path))
  const opening = ide.openFile('a.ts')
  await ide.openFile('b.ts')
  a.resolve(file('a.ts'))
  await opening
  expect(useDocumentsStore().active).toBe('b.ts')
  expect(useDocumentsStore().openPaths).toEqual(['b.ts'])
  await ide.openFile('a.ts')
  expect(useDocumentsStore().openPaths).toEqual(['b.ts', 'a.ts'])
})

it('迟到 jumpTo 不定位到已经切走的文件', async () => {
  const a = deferred<ReturnType<typeof file>>()
  vi.spyOn(ideApi, 'readFile').mockImplementation(async path => path === 'a.ts' ? await a.promise : file(path))
  const reveal = vi.spyOn(useDocumentsStore(), 'reveal')
  const jumping = ide.jumpTo('a.ts', 3, 4)
  await ide.openFile('b.ts')
  a.resolve(file('a.ts'))
  await jumping
  expect(reveal).not.toHaveBeenCalled()
})

it('外部重载等待期间输入转冲突；晚回包不覆盖新文档', async () => {
  ide.start()
  await vi.waitFor(() => expect(ideApi.runLogs).toHaveBeenCalled())
  const documents = useDocumentsStore()
  documents.open('a.ts', 'base', 'r1')
  const response = deferred<ReturnType<typeof file>>()
  vi.spyOn(ideApi, 'readFile').mockReturnValue(response.promise)
  fsListener!({ schemaVersion: 1, type: 'change', path: 'a.ts' })
  documents.applyEdit('a.ts', 'local', documents.modelVersion('a.ts')!)
  response.resolve(file('a.ts', 'disk', 'r2'))
  await vi.waitFor(() => expect(documents.conflictOf('a.ts')?.diskContent).toBe('disk'))
  expect(documents.contentOf('a.ts')).toBe('local')
})

it('外部删除脏文件保 tab 保内容（下次保存走 create），干净文件关闭，不弹恢复窗', async () => {
  ide.start()
  await vi.waitFor(() => expect(ideApi.runLogs).toHaveBeenCalled())
  const documents = useDocumentsStore()
  documents.open('a.ts', 'base', 'r1')
  documents.open('b.ts', 'clean', 'r1')
  documents.applyEdit('a.ts', 'local', documents.modelVersion('a.ts')!)
  fsListener!({ schemaVersion: 1, type: 'unlink', path: 'a.ts' })
  fsListener!({ schemaVersion: 1, type: 'unlink', path: 'b.ts' })
  // DAG-017-09 规格：本地保留、不自动复活、框数量 0——脏文档原样留在 tab 里
  // （只标记磁盘不存在），恢复对话框（不可关闭的模态窗）不再被这个场景触发。
  expect(useRecoveryStore().files).toHaveLength(0)
  expect(documents.has('a.ts')).toBe(true)
  expect(documents.contentOf('a.ts')).toBe('local')
  expect(documents.isDirty('a.ts')).toBe(true)
  expect(documents.has('b.ts')).toBe(false)
})

it('取消主动工作区切换保留全部修改且不发送 open', async () => {
  const documents = useDocumentsStore()
  documents.open('a.ts', 'base', 'r1')
  documents.applyEdit('a.ts', 'local', documents.modelVersion('a.ts')!)
  const open = vi.spyOn(ideApi, 'openWorkspace')
  const switching = ide.openWorkspacePath('/tmp/new')
  expect(dialogState().current?.spec.title).toContain('未保存修改')
  closeDialog(null)
  await switching
  expect(open).not.toHaveBeenCalled()
  expect(documents.contentOf('a.ts')).toBe('local')
})

it('重连补拉任务/文件；重复 connected/ping 不重复同步', async () => {
  ide.start()
  await vi.waitFor(() => expect(ideApi.workspace).toHaveBeenCalled())
  await new Promise(resolve => setTimeout(resolve, 50))
  vi.mocked(ideApi.taskList).mockClear()
  vi.mocked(ideApi.tree).mockClear()
  connection!(false)
  connection!(true)
  connection!(true)
  await vi.waitFor(() => expect(ideApi.tree).toHaveBeenCalledOnce())
  expect(ideApi.taskList).toHaveBeenCalledOnce()
})

it('安装终态漏掉 SSE 时仍从查询快照完成等待', async () => {
  vi.spyOn(ideApi, 'taskGet').mockResolvedValue({ taskId: 'install', kind: 'install', state: 'succeeded', createdAt: 1, lastSequence: 5, diagnostics: [], artifacts: [] })
  expect(await ide.trackInstallTask('install', '/tmp/project')).toBe('succeeded')
})

it('外部工作区切换把草稿重新开回未保存 tab（IDE-011-05：tab 延续才算保护）', async () => {
  ide.start()
  await vi.waitFor(() => expect(ideApi.runLogs).toHaveBeenCalled())
  const write = vi.spyOn(ideApi, 'writeFile').mockResolvedValue({ path: 'a.ts', bytesWritten: 6, revision: 'r9' })
  const documents = useDocumentsStore()
  documents.open('a.ts', 'base', 'r1')
  documents.applyEdit('a.ts', 'local', documents.modelVersion('a.ts')!)
  const next = deferred<WorkspaceInfo>()
  vi.mocked(ideApi.workspace).mockReturnValueOnce(next.promise)
  workspaceListener!({ schemaVersion: 1, type: 'workspace', root: '/tmp/next', sessionId: 's2' } as never)
  documents.applyEdit('a.ts', 'latest', documents.modelVersion('a.ts')!)
  next.resolve({ ...info, root: '/tmp/next', sessionId: 's2' })
  await vi.waitFor(() => expect(useWorkspaceStore().info?.sessionId).toBe('s2'))
  // 草稿以未保存 tab 延续：内容是最后一次编辑，仍 dirty，恢复对话框不重复弹
  expect(documents.has('a.ts')).toBe(true)
  expect(documents.contentOf('a.ts')).toBe('latest')
  expect(documents.isDirty('a.ts')).toBe(true)
  expect(documents.openPaths).toContain('a.ts')
  expect(useRecoveryStore().files).toEqual([])
  expect(write).not.toHaveBeenCalled()
})

it('保存失败阻止主动切换；旧 model 的重载回包不覆盖重开文件', async () => {
  ide.start()
  await vi.waitFor(() => expect(ideApi.runLogs).toHaveBeenCalled())
  const documents = useDocumentsStore()
  documents.open('a.ts', 'base', 'r1')
  documents.applyEdit('a.ts', 'local', documents.modelVersion('a.ts')!)
  vi.spyOn(ideApi, 'writeFile').mockRejectedValue(new Error('disk unavailable'))
  const open = vi.spyOn(ideApi, 'openWorkspace')
  const switching = ide.openWorkspacePath('/tmp/next')
  closeDialog({ action: 'save' })
  await switching
  expect(open).not.toHaveBeenCalled()
  expect(documents.contentOf('a.ts')).toBe('local')
  const next = deferred<ReturnType<typeof file>>()
  vi.spyOn(ideApi, 'readFile').mockReturnValue(next.promise)
  fsListener!({ schemaVersion: 1, type: 'change', path: 'a.ts' })
  await vi.waitFor(() => expect(ideApi.readFile).toHaveBeenCalledWith('a.ts'))
  documents.close('a.ts')
  documents.open('a.ts', 'reopened', 'r3')
  next.resolve(file('a.ts', 'OLD_DISK', 'r2'))
  await next.promise
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(documents.contentOf('a.ts')).toBe('reopened')
})

it('打包范围显示当前清单名称，选中后仍提交英文成员id', async () => {
  useWorkspaceStore().info = { ...info, kind: 'capability-project' }
  useFileTreeStore().setTree(['exp_ui', 'exp_other'].map(id => ({ path: `frontend/${id}/fh2-plugin.json`, name: 'fh2-plugin.json', kind: 'file' as const })), false)
  vi.spyOn(ideApi, 'readFile').mockImplementation(async path => file(path, JSON.stringify({ name: path.includes('exp_ui') ? '事故面板' : '其他面板' })))
  const task = vi.spyOn(ideApi, 'taskStart').mockResolvedValue({ taskId: 'pack', kind: 'pack', state: 'queued', createdAt: 1, lastSequence: 0, diagnostics: [], artifacts: [] })
  const packing = ide.runPack()
  await vi.waitFor(() => expect(dialogState().current?.spec.title).toBe('选择打包范围'))
  expect(dialogState().current?.spec.fields?.[0]).toMatchObject({ tree: [{ children: [
    { id: 'exp_other', label: '其他面板（exp_other）' },
    { id: 'exp_ui', label: '事故面板（exp_ui）' },
  ] }] })
  closeDialog({ members: ['exp_ui'] })
  await packing
  expect(task).toHaveBeenCalledWith('pack', { members: 'exp_ui' })
})

it('读取打包名称期间切工作区，不弹旧列表或启动任务', async () => {
  useWorkspaceStore().info = { ...info, kind: 'capability-project' }
  useFileTreeStore().setTree([{ path: 'frontend/exp_ui/fh2-plugin.json', name: 'fh2-plugin.json', kind: 'file' }], false)
  const next = deferred<ReturnType<typeof file>>()
  vi.spyOn(ideApi, 'readFile').mockReturnValue(next.promise)
  const task = vi.spyOn(ideApi, 'taskStart')
  const packing = ide.runPack()
  await vi.waitFor(() => expect(ideApi.readFile).toHaveBeenCalled())
  useWorkspaceStore().info = { ...info, sessionId: 's2' }
  next.resolve(file('frontend/exp_ui/fh2-plugin.json', '{"name":"旧面板"}'))
  await packing
  expect(dialogState().current).toBeNull()
  expect(task).not.toHaveBeenCalled()
})

it('多级懒加载合并同路径请求，空目录不重复读，刷新后旧请求不写回', async () => {
  const tree = useFileTreeStore()
  const node = { path: 'dist', name: 'dist', kind: 'dir' as const, children: [], generated: true, childrenLoaded: false }
  tree.setTree([node], false)
  const next = deferred<{ path: string; children: [] }>()
  const read = vi.spyOn(ideApi, 'treeChildren').mockReturnValueOnce(next.promise).mockResolvedValue({ path: 'dist', children: [] })
  const first = ide.loadTreeChildren('dist')
  const second = ide.loadTreeChildren('dist')
  expect(read).toHaveBeenCalledOnce()
  tree.setTree([node], false)
  next.resolve({ path: 'dist', children: [] })
  await Promise.all([first, second])
  expect(tree.needsChildren('dist')).toBe(true)
  await ide.loadTreeChildren('dist')
  await ide.loadTreeChildren('dist')
  expect(read).toHaveBeenCalledTimes(2)
  expect(tree.needsChildren('dist')).toBe(false)
})

it('普通子目录加载失败可重试，切工作区的迟到回包被丢弃', async () => {
  const tree = useFileTreeStore()
  const node = { path: 'src/deep', name: 'deep', kind: 'dir' as const, children: [], childrenLoaded: false }
  tree.setTree([node], false)
  tree.collapsed.delete(node.path)
  const read = vi.spyOn(ideApi, 'treeChildren').mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce({ path: node.path, children: [] })
  await ide.loadTreeChildren(node.path)
  expect(tree.collapsed.has(node.path)).toBe(true)
  expect(tree.needsChildren(node.path)).toBe(true)
  expect(tree.loading.size).toBe(0)
  await ide.loadTreeChildren(node.path)
  expect(read).toHaveBeenCalledTimes(2)
  tree.setTree([node], false)
  const next = deferred<{ path: string; children: [] }>()
  read.mockReturnValueOnce(next.promise)
  const pending = ide.loadTreeChildren(node.path)
  useWorkspaceStore().info = { ...info, sessionId: 's2' }
  tree.reset()
  next.resolve({ path: node.path, children: [] })
  await pending
  expect(tree.nodes).toEqual([])
})

it('复制 → 粘贴：目录右键粘贴调用 fsCopy，重名自动加序号', async () => {
  const copy = vi.spyOn(ideApi, 'fsCopy')
    // 第一次 409（目标已存在），第二次换成 a (2).ts 成功
    .mockRejectedValueOnce(new IdeApiError('FH2_IDE_ALREADY_EXISTS', '目标已存在', 409))
    .mockResolvedValueOnce({ from: 'src/a.ts', to: 'src/a (2).ts' })
  const tree = vi.spyOn(ideApi, 'tree').mockResolvedValue({ tree: [], truncated: false })

  ide.showTreeMenu({ path: 'src/a.ts', kind: 'file' }, 0, 0)
  menuItem('复制').onSelect()
  await vi.waitFor(() => expect(useStatusStore().message).toContain('已复制 src/a.ts'))

  // 粘贴到目录 src：菜单项出现且标注源名
  ide.showTreeMenu({ path: 'src', kind: 'dir' }, 0, 0)
  const paste = menuItem('粘贴「a.ts」')
  paste.onSelect()
  await vi.waitFor(() => expect(useStatusStore().message).toContain('已粘贴到'))
  expect(copy).toHaveBeenCalledTimes(2)
  expect(copy).toHaveBeenNthCalledWith(1, 'src/a.ts', 'src/a.ts')
  expect(copy).toHaveBeenNthCalledWith(2, 'src/a.ts', 'src/a (2).ts')
  expect(tree).toHaveBeenCalled()
})

it('没有复制源时右键菜单不出现粘贴项', () => {
  ide.showTreeMenu({ path: 'src', kind: 'dir' }, 0, 0)
  const entries = vi.mocked(showContextMenu).mock.lastCall![2]
  expect(entries.some(entry => entry !== 'separator' && entry.label.startsWith('粘贴'))).toBe(false)
})

it('目录粘贴到自身或其子目录被拒绝且不发起请求', async () => {
  const copy = vi.spyOn(ideApi, 'fsCopy')
  ide.showTreeMenu({ path: 'src', kind: 'dir' }, 0, 0)
  menuItem('复制').onSelect()
  // 粘贴目标 = src/nested（src 的子目录）
  ide.showTreeMenu({ path: 'src/nested', kind: 'dir' }, 0, 0)
  menuItem('粘贴「src」').onSelect()
  await vi.waitFor(() => expect(useStatusStore().message).toContain('不能把目录复制到自身'))
  expect(copy).not.toHaveBeenCalled()
})
