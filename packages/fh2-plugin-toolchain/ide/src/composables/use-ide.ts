// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import * as monaco from 'monaco-editor'
import { useEventListener } from '@vueuse/core'
import { inject, onBeforeUnmount, provide, watch } from 'vue'
import type { InjectionKey } from 'vue'
import { createDocumentService } from '../editor/document-service.js'
import { useWorkflowResources } from '../features/workflow/resources.js'
import { IdeApiError, describeApiError, ideApi, setWorkspaceSession } from '../api/client.js'
import { FsEventStream } from '../api/events.js'
import type { FsEvent, RunEvent, RunMode, WorkspaceEvent, WorkspaceInfo } from '../api/types.js'
import { useDocumentsStore } from '../stores/documents.js'
import { TASK_STATE_LABEL, useTasksStore } from '../stores/tasks.js'
import { useStartupStore } from '../stores/startup.js'
import { LSP_MARKER_OWNER, LspDiagnosticsClient } from '../lsp/client.js'
import { useFileTreeStore } from '../stores/file-tree.js'
import type { TreeContextTarget } from '../stores/file-tree.js'
import { diagnosticsToProblems, markersToProblems, useProblemsStore } from '../stores/problems.js'
import { MODE_LABEL, useRunStore } from '../stores/run.js'
import { useStatusStore } from '../stores/status.js'
import { useLspStore } from '../stores/lsp.js'
import { useSettingsStore } from '../stores/settings.js'
import { useUiStore } from '../stores/ui.js'
import { useRecoveryStore } from '../stores/recovery.js'
import type { RecoveryFile } from '../stores/recovery.js'
import type { IdeView } from '../stores/ui.js'
import { useWorkflowStore } from '../features/workflow/store.js'
import { isGojaScript, useWorkspaceStore } from '../stores/workspace.js'
import { languageOf } from '../editor/document-store.js'
import { closeContextMenu, showContextMenu } from '../services/context-menu.js'
import type { MenuEntry } from '../services/context-menu.js'
import { confirmDialog, showDialog } from '../services/dialog.js'
import { isWorkflowPath } from '../features/workflow/schema.js'
import { collectPackMemberLeafIds, derivePackMembers, loadPackMemberNames } from '../features/pack-members.js'

const TREE_REFRESH_DEBOUNCE_MS = 120
const WORKSPACE_CONFIG_REFRESH_DEBOUNCE_MS = 120
/** 自动保存静默期：停止输入后等多久落盘（VSCode afterDelay 同档）。 */
const AUTO_SAVE_DEBOUNCE_MS = 800

/** 这些标志文件会改变工作区身份、成员或语言档案，保存后必须重新 inspect。 */
export function isWorkspaceDiscoveryPath (path: string): boolean {
  const name = basename(path)
  return name === 'packages.json' || name === 'capabilities.json' || name === 'fh2-plugin.json'
}

function parentOf (path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

function joinPath (parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}

function basename (path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function validEntryName (name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
}

export interface IdeContext {
  /** 启动：拉工作区、接 SSE。App.vue onMounted 时调用一次。 */
  readonly start: () => void;
  readonly switchView: (view: IdeView) => Promise<void>;
  readonly openFile: (path: string) => Promise<void>;
  readonly closeFile: (path: string) => void;
  readonly saveActive: () => Promise<void>;
  /** F3：保存全部脏文档；冲突未解决返回 false，调用方不得启动操作。 */
  readonly saveAll: () => Promise<boolean>;
  readonly jumpTo: (path: string, line: number, column: number) => Promise<void>;
  /** P2-2：Problems 点击工作流问题 → 切画布、选中节点、聚焦具体输入。 */
  readonly revealWorkflowNode: (workflowPath: string, nodeId: string, inputKey?: string) => Promise<void>;
  readonly showTreeMenu: (target: TreeContextTarget | null, x: number, y: number) => void;
  readonly promptCreate: (kind: 'file' | 'dir', base?: string) => Promise<void>;
  readonly createTreeEntry: (kind: 'file' | 'dir', base: string, name: string) => Promise<boolean>;
  readonly renameTreeEntry: (target: TreeContextTarget, name: string) => Promise<boolean>;
  readonly moveTreeEntry: (target: TreeContextTarget, destination: string) => Promise<boolean>;
  /** N1：Start Center 的打开入口（失败可恢复，不切换现工作区）。 */
  readonly openWorkspacePath: (root: string) => Promise<void>;
  /** N3：跟踪 install 任务（创建向导的依赖安装）。 */
  readonly trackInstallTask: (taskId: string, projectRoot: string) => Promise<'succeeded' | 'failed' | 'cancelled'>;
  readonly refreshTree: () => Promise<void>;
  /** 生成目录展开：惰性拉取单层子树写回 file-tree store（不可变重建）。 */
  readonly loadTreeChildren: (path: string) => Promise<void>;
  readonly runValidate: (options?: { readonly silent?: boolean }) => Promise<void>;
  /** U2：Pack 任务（含成员选择与构建；上传司空为手动步骤）。 */
  readonly runPack: () => Promise<void>;
  /** U2：取消任务。 */
  readonly cancelTask: (taskId: string) => Promise<void>;
  /** U3：下载产物快照。 */
  readonly downloadArtifact: (taskId: string, artifactId: string) => Promise<void>;
  readonly toggleRun: (mode: RunMode) => Promise<void>;
  readonly openRunUrl: (url: string) => void;
  readonly openInCanvas: (path: string) => Promise<void>;
}

export const IDE_KEY: InjectionKey<IdeContext> = Symbol('fh2-ide')

export function useIdeContext (): IdeContext {
  const context = inject(IDE_KEY)
  if (context === undefined) throw new Error('缺少 IdeContext（App.vue 未 provide）')
  return context
}

/**
 * IDE 编排：唯一持有 FsEventStream 与文件/工作区/运行等动作的地方。
 * 由 App.vue 调用一次并 provide；组件经 useIdeContext() 取动作。
 */
export function useIde (): IdeContext {
  const status = useStatusStore()
  const lsp = useLspStore()
  const workspace = useWorkspaceStore()
  const documents = useDocumentsStore()
  const documentService = createDocumentService(documents, () => workspace.info?.sessionId ?? null)
  const tasks = useTasksStore()
  const startup = useStartupStore()
  const fileTree = useFileTreeStore()
  const problems = useProblemsStore()
  const run = useRunStore()
  const ui = useUiStore()
  const recovery = useRecoveryStore()

  /** IDE-011-05：切根时留存的草稿，等 applyWorkspace 重置后立即开回 tab。 */
  const pendingReopen: RecoveryFile[] = []

  const events = new FsEventStream()
  const cleanup = new Set<() => void>()
  let disposed = false
  /** L3：LSP 诊断客户端（随工作区会话重建；P1 只接诊断源）。 */
  let lspClient: LspDiagnosticsClient | null = null
  const workflow = useWorkflowStore()
  workflow.bindDocuments(documentService)
  /** 已经问过「要不要打开」的 dev URL，避免 start 回执与 SSE 事件重复弹窗。 */
  const offeredRunUrls = new Set<string>()
  const selectedRunTargets = new Map<RunMode, string>()

  /**
   * 拉受审词表（契约 §9 的节点菜单数据源）。
   *
   * 取不到不是致命错误：画布会降级成「不校验入参、action 自由输入」，
   * 所以这里吞掉异常只记一条状态 —— 让整个 IDE 因为画布的数据源挂掉是不成比例的。
   */
  async function refreshCatalog (): Promise<void> {
    useWorkflowResources().configure(workspace.schemas)
    await useWorkflowResources().refreshCatalog()
  }

  // ── 视图切换 ──────────────────────────────────

  async function switchView (view: IdeView): Promise<void> {
    if (ui.view === view) return
    ui.setView(view)
    if (view === 'workflow') await workflow.activate()
  }

  // ── 文件操作 ──────────────────────────────────

  async function refreshTree (): Promise<void> {
    const session = workspace.info?.sessionId
    try {
      const result = await ideApi.tree()
      if (session !== workspace.info?.sessionId) return
      fileTree.setTree(result.tree, result.truncated)
      if (result.warnings?.length) status.set(result.warnings.join('；'), true)
      workflow.setCandidates(
        fileTree.allFiles.filter(path => isWorkflowPath(path, workspace.schemas)),
      )
    } catch (error) {
      reportError('读取文件树失败', error)
    }
  }

  const childRequests = new Map<string, Promise<void>>()
  /** 所有未加载目录均拉单层；空结果也缓存，刷新或切工作区后旧回包无效。 */
  function loadTreeChildren (path: string): Promise<void> {
    const session = workspace.info?.sessionId
    const version = fileTree.treeVersion
    const key = `${session}:${version}:${path}`
    const existing = childRequests.get(key)
    if (existing) return existing
    if (!fileTree.needsChildren(path)) return Promise.resolve()
    const valid = (): boolean => !disposed && session === workspace.info?.sessionId && version === fileTree.treeVersion
    fileTree.setLoading(path, true)
    const pending = (async () => {
      try {
        const result = await ideApi.treeChildren(path)
        if (!valid()) return
        fileTree.setChildren(path, result.children)
        if (result.warnings?.length) status.set(result.warnings.join('；'), true)
      } catch (error) {
        if (!valid()) return
        fileTree.collapsed.add(path)
        reportError(`展开 ${path} 失败，可再次点击重试`, error)
      } finally {
        childRequests.delete(key)
        if (valid()) fileTree.setLoading(path, false)
      }
    })()
    childRequests.set(key, pending)
    return pending
  }

  let treeRefreshTimer: number | null = null
  function scheduleTreeRefresh (): void {
    if (treeRefreshTimer !== null) window.clearTimeout(treeRefreshTimer)
    treeRefreshTimer = window.setTimeout(() => {
      treeRefreshTimer = null
      void refreshTree()
    }, TREE_REFRESH_DEBOUNCE_MS)
  }

  let workspaceConfigRefreshTimer: number | null = null
  let workspaceConfigRefreshRequested = false
  let workspaceConfigRefreshPromise: Promise<void> | null = null

  function scheduleWorkspaceConfigurationRefresh (): void {
    if (workspaceConfigRefreshTimer !== null) window.clearTimeout(workspaceConfigRefreshTimer)
    workspaceConfigRefreshTimer = window.setTimeout(() => {
      workspaceConfigRefreshTimer = null
      void refreshWorkspaceConfiguration()
    }, WORKSPACE_CONFIG_REFRESH_DEBOUNCE_MS)
  }

  /** 同 session 内轻量重检配置，不清文档、文件树状态或任务。 */
  async function refreshWorkspaceConfiguration (): Promise<void> {
    if (workspaceConfigRefreshTimer !== null) {
      window.clearTimeout(workspaceConfigRefreshTimer)
      workspaceConfigRefreshTimer = null
    }
    workspaceConfigRefreshRequested = true
    if (workspaceConfigRefreshPromise !== null) return await workspaceConfigRefreshPromise
    workspaceConfigRefreshPromise = refreshWorkspaceConfigurationLoop()
    try {
      await workspaceConfigRefreshPromise
    } finally {
      workspaceConfigRefreshPromise = null
    }
  }

  async function refreshWorkspaceConfigurationLoop (): Promise<void> {
    while (workspaceConfigRefreshRequested) {
      workspaceConfigRefreshRequested = false
      await refreshWorkspaceConfigurationOnce()
    }
  }

  async function refreshWorkspaceConfigurationOnce (): Promise<void> {
    const previous = workspace.info
    if (previous === null) return
    const sessionId = previous.sessionId
    try {
      const workspaceInfo = await ideApi.workspace()
      if (workspace.info?.sessionId !== sessionId || workspaceInfo.sessionId !== sessionId) return
      let schemas = workspace.schemas
      try {
        schemas = (await ideApi.schemas()).schemas
      } catch (error) {
        status.set(`工作区配置已变化，但 schema 刷新失败：${describeApiError(error)}`, true)
      }
      if (workspace.info?.sessionId !== sessionId) return

      workspace.apply(workspaceInfo, schemas)
      problems.setProblems('workspace', diagnosticsToProblems(workspaceInfo.diagnostics, 'workspace'))
      workflow.setCandidates(fileTree.allFiles.filter(path => isWorkflowPath(path, schemas)))

      if (workspaceInfo.kind === 'unknown') {
        lspClient?.stop()
        lspClient = null
        startup.setPhase('start-center')
        ui.setView('start')
        status.set('当前目录已失去插件工程标志，请恢复 packages.json、capabilities.json 或 fh2-plugin.json', true)
        return
      }

      startup.setPhase('ready')
      if (ui.view === 'start') ui.setView('editor')
      await refreshCatalog()
      if (workspace.info?.sessionId !== sessionId) return
      startLspClient(workspaceInfo)
      if (workspaceInfo.diagnostics.length > 0) {
        status.set(`工程配置仍有 ${workspaceInfo.diagnostics.length} 个错误`, true)
      } else if (previous.diagnostics.length > 0) {
        status.set('工程配置已修复')
      }
    } catch (error) {
      reportError('刷新工程配置失败', error)
    }
  }

  let openSequence = 0
  async function openFile (path: string): Promise<void> {
    const sequence = ++openSequence
    // F5：请求发出时捕获会话；切换工作区后迟到的读取回包直接丢弃，不污染新工作区。
    const sessionAtRequest = workspace.info?.sessionId ?? null
    try {
      await documentService.readDetached(path)
      if (sequence !== openSequence || sessionAtRequest !== (workspace.info?.sessionId ?? null)) return
      documents.activate(path)
      await switchView('editor')
      status.set(`已打开 ${path}`)
    } catch (error) {
      if (sequence === openSequence && sessionAtRequest === (workspace.info?.sessionId ?? null)) reportError(`打开 ${path} 失败`, error)
    }
  }

  /**
   * 关闭脏文件需要连点两次确认。
   * 不用 `window.confirm`：它会冻结整个渲染线程（Monaco 的 worker 回调也被卡住）。
   */
  function closeFile (path: string): void {
    if (documents.requestClose(path) === 'needs-confirm') {
      status.set(`${path} 有未保存的修改；再次点击关闭按钮将放弃这些修改`, true)
    }
  }

  async function saveDocument (path: string): Promise<boolean> {
    const saved = await documentService.save(path)
    if (saved) status.set(`已保存 ${path}`)
    else status.set(`${path} 尚有未保存内容或冲突`, true)
    return saved
  }

  async function saveActive (): Promise<void> {
    if (ui.view === 'workflow') {
      await workflow.save()
      return
    }
    const path = documents.active
    if (path === null) return
    if (!documents.isDirty(path)) {
      status.set(`${path} 无改动`)
      return
    }
    try {
      const saved = await saveDocument(path)
      if (!saved) return
      if (isWorkspaceDiscoveryPath(path)) await refreshWorkspaceConfiguration()
      // 保存后立刻跑能力层校验，问题面板才能反映落盘后的真实状态
      await runValidate({ silent: true })
    } catch (error) {
      reportError(`保存 ${path} 失败`, error)
    }
  }

  /**
   * F3：Save All —— 逐个保存脏文档（带 revision）。
   * 返回 false 表示存在未解决冲突或保存失败，调用方不得启动任务。
   */
  async function saveAll (): Promise<boolean> {
    const refreshWorkspace = documents.dirtyPaths.some(isWorkspaceDiscoveryPath)
    try {
      const saved = await documentService.saveAll()
      if (saved && refreshWorkspace) await refreshWorkspaceConfiguration()
      return saved
    } catch (error) {
      reportError('保存失败', error)
      return false
    }
  }

  // ── 自动保存（设置开关）：编辑静默期后落盘 ──────
  //
  // 只由 DocumentStore 的 'edit' 事件驱动（用户/程序对 Monaco model 的内容变化），
  // 不轮询 dirtyPaths —— 切根后重开的「未保存草稿 tab」（openUnsaved）不发 edit
  // 事件，于是不会被自动写进新工作区（IDE-011-05：草稿落盘必须是用户的主动决定）。
  // Ctrl+S / 保存全部不受影响；save() 自身的串行链保证两者不竞争。
  const autoSaveTimers = new Map<string, number>()
  const settings = useSettingsStore()

  function clearAutoSaveTimers (): void {
    for (const timer of autoSaveTimers.values()) window.clearTimeout(timer)
    autoSaveTimers.clear()
  }

  function scheduleAutoSave (path: string): void {
    if (!settings.autoSave) return
    if (documents.conflictOf(path) !== null) return
    const existing = autoSaveTimers.get(path)
    if (existing !== undefined) window.clearTimeout(existing)
    autoSaveTimers.set(path, window.setTimeout(() => {
      autoSaveTimers.delete(path)
      // 会话守卫：定时器跨过了工作区切换（applyWorkspace 已清表，这里再兜一道）
      if (disposed || !documents.has(path) || !documents.isDirty(path)) return
      if (documents.conflictOf(path) !== null) return
      documentService.save(path)
        .then((saved) => {
          // false = 冲突或会话失效：冲突已进 store，由冲突对话框接管，不重复提示
          if (saved && isWorkspaceDiscoveryPath(path)) void refreshWorkspaceConfiguration()
        })
        .catch((error) => {
          status.set(`自动保存 ${path} 失败：${describeApiError(error)}`, true)
        })
    }, AUTO_SAVE_DEBOUNCE_MS))
  }

  // 关闭自动保存时丢弃挂起的静默定时器（已落盘的不撤销）
  watch(() => settings.autoSave, (enabled) => {
    if (!enabled) clearAutoSaveTimers()
  })

  // 编辑事件驱动自动保存（订阅与 SSE 无关，随 useIde 生命周期挂卸）
  const unsubscribeAutoSave = documentService.subscribe((event) => {
    if (event === undefined || event.reason !== 'edit') return
    for (const path of event.paths) scheduleAutoSave(path)
  })
  cleanup.add(unsubscribeAutoSave)

  async function jumpTo (path: string, line: number, column: number): Promise<void> {
    const expectedSequence = openSequence + 1
    await openFile(path)
    if (openSequence !== expectedSequence || documents.active !== path) return
    documents.reveal(path, line, column)
  }

  /** P2-2：工作流问题的节点定位（切到画布 → 载入对应流程 → 选节点 → 聚焦输入行）。 */
  async function revealWorkflowNode (workflowPath: string, nodeId: string, inputKey?: string): Promise<void> {
    await switchView('workflow')
    await workflow.revealWorkflowNode(workflowPath, nodeId, inputKey)
  }

  // ── 契约 §6：文件管理 ─────────────────────────

  /** IDE 内剪贴板：文件树「复制 → 粘贴」的源（切工作区后失效清空）。 */
  let copiedEntry: { readonly path: string; readonly kind: 'file' | 'dir' } | null = null

  function showTreeMenu (target: TreeContextTarget | null, x: number, y: number): void {
    const session = workspace.info?.sessionId
    // 在目录上新建 → 建在该目录下；在文件上新建 → 建在它的同级目录下
    const base = target === null ? '' : (target.kind === 'dir' ? target.path : parentOf(target.path))
    const entries: MenuEntry[] = [
      { label: '新建文件', onSelect: () => void promptCreate('file', base) },
      { label: '新建目录', onSelect: () => void promptCreate('dir', base) },
    ]
    if (target !== null) {
      entries.push(
        'separator',
        {
          label: '复制',
          onSelect: () => {
            copiedEntry = { path: target.path, kind: target.kind }
            status.set(`已复制 ${target.path}，在目标位置右键「粘贴」`)
          },
        },
        { label: '重命名', onSelect: () => fileTree.beginRename(target) },
        { label: '删除', danger: true, onSelect: () => void promptDelete(target) },
      )
      if (target.kind === 'file' && isWorkflowPath(target.path, workspace.schemas)) {
        entries.push(
          'separator',
          { label: '在工作流画布中打开', onSelect: () => void openInCanvas(target.path) },
        )
      }
    }
    if (copiedEntry !== null) {
      entries.push({
        label: `粘贴「${basename(copiedEntry.path)}」`,
        onSelect: () => void pasteCopiedEntry(base),
      })
    }
    const path = target?.path ?? '.'
    entries.push(
      'separator',
      { label: '在文件管理器中打开', onSelect: () => void treeSystemAction(path, 'reveal', session) },
      { label: '复制路径', onSelect: () => void treeSystemAction(path, 'absolute', session) },
      { label: '复制相对路径', onSelect: () => void treeSystemAction(path, 'relative', session) },
      'separator',
      { label: '刷新文件树', onSelect: () => void refreshTree() },
    )
    showContextMenu(x, y, entries)
  }

  /**
   * 契约 6.4 消费方：把剪贴板里的源复制到目标目录。
   * 重名不覆盖：自动追加「 (2)」「 (3)」序号（服务端对已存在目标一律 409）。
   */
  async function pasteCopiedEntry (destDir: string): Promise<void> {
    const source = copiedEntry
    if (source === null) return
    const session = workspace.info?.sessionId
    if (source.kind === 'dir' && (destDir === source.path || destDir.startsWith(`${source.path}/`))) {
      status.set('粘贴失败：不能把目录复制到自身或其子目录。', true)
      return
    }
    const name = basename(source.path)
    for (let attempt = 1; attempt <= 100; attempt++) {
      const to = joinPath(destDir, suffixedCopyName(name, attempt))
      try {
        await ideApi.fsCopy(source.path, to)
        if (session !== workspace.info?.sessionId) return
        fileTree.revealParents(to)
        await refreshTree()
        status.set(`已粘贴到 ${to}`)
        return
      } catch (error) {
        if (session !== workspace.info?.sessionId) return
        if (error instanceof IdeApiError && error.code === 'FH2_IDE_ALREADY_EXISTS' && attempt < 100) continue
        reportError(`粘贴 ${source.path} 失败`, error)
        return
      }
    }
  }

  /** name.ext 的第 attempt 次副本名：attempt=1 原名，之后 name (N).ext。 */
  function suffixedCopyName (name: string, attempt: number): string {
    if (attempt === 1) return name
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    return `${stem} (${attempt})${ext}`
  }

  async function treeSystemAction (path: string, action: 'reveal' | 'absolute' | 'relative', session: string | undefined): Promise<void> {
    const current = (): boolean => !disposed && session !== undefined && session === workspace.info?.sessionId
    if (!current()) return
    const label = action === 'reveal' ? '打开文件管理器' : action === 'absolute' ? '复制路径' : '复制相对路径'
    try {
      if (action === 'reveal') {
        await ideApi.fsReveal(path)
        if (current()) status.set(`已在文件管理器中打开 ${path}`)
        return
      }
      const paths = await ideApi.fsPath(path)
      if (!current()) return
      const text = action === 'absolute' ? paths.absolutePath : paths.relativePath
      await navigator.clipboard.writeText(text)
      if (current()) status.set(`已${label}：${text}`)
    } catch (error) {
      if (current()) reportError(`${label}失败`, error)
    }
  }

  async function openInCanvas (path: string): Promise<void> {
    await switchView('workflow')
    await workflow.load(path)
  }

  async function promptCreate (kind: 'file' | 'dir', base?: string): Promise<void> {
    const resolvedBase = base ?? (documents.active === null ? '' : parentOf(documents.active))
    fileTree.beginCreate(kind, resolvedBase)
  }

  async function createTreeEntry (kind: 'file' | 'dir', base: string, rawName: string): Promise<boolean> {
    const name = rawName.trim()
    if (!validEntryName(name)) {
      status.set('创建失败：请输入不含 / 或 \\ 的单个文件名。', true)
      return false
    }
    const path = joinPath(base, name)

    try {
      await ideApi.fsCreate(path, kind)
    } catch (error) {
      reportError(`创建 ${path} 失败`, error)
      return false
    }
    fileTree.revealParents(path)
    await refreshTree()
    // 先打开再报回执：openFile 自己也写状态栏，顺序反了会把「已创建」盖掉
    if (kind === 'file') await openFile(path)
    status.set(`已创建${kind === 'file' ? '文件' : '目录'} ${path}`)
    return true
  }

  async function renamePath (target: TreeContextTarget, to: string, verb: '重命名' | '移动'): Promise<boolean> {
    if (to === target.path) return true
    const session = workspace.info?.sessionId
    const affectedDirty = documents.dirtyPaths.filter(path => path === to || path.startsWith(`${to}/`))
    try {
      await ideApi.fsRename(target.path, to, false)
    } catch (error) {
      if (!(error instanceof IdeApiError) || error.code !== 'FH2_IDE_ALREADY_EXISTS') {
        reportError(`${verb} ${target.path} 失败`, error)
        return false
      }
      const overwrite = await confirmDialog({
        title: '目标已存在',
        body: [`${to} 已存在。是否覆盖？`, ...(affectedDirty.length === 0 ? [] : [`以下目标文件有未保存修改，覆盖将丢弃：${affectedDirty.join('、')}`]), '覆盖后原目标无法恢复。'],
        confirmLabel: '覆盖',
        danger: true,
      })
      if (!overwrite) return false
      if (session !== workspace.info?.sessionId) return false
      try {
        await ideApi.fsRename(target.path, to, true)
      } catch (retryError) {
        reportError(`${verb} ${target.path} 失败`, retryError)
        return false
      }
    }
    if (session !== workspace.info?.sessionId) return false
    openSequence += 1
    for (const followed of documents.remapOpenDocuments(target.path, to)) {
      status.set(`${followed.from} 的未保存修改已跟随到 ${followed.to}，请重新保存。`, true)
    }
    fileTree.revealParents(to)
    await refreshTree()
    status.set(`已${verb} ${target.path} → ${to}`)
    return true
  }

  async function renameTreeEntry (target: TreeContextTarget, rawName: string): Promise<boolean> {
    const name = rawName.trim()
    if (!validEntryName(name)) {
      status.set('重命名失败：请输入不含 / 或 \\ 的单个名称。', true)
      return false
    }
    return await renamePath(target, joinPath(parentOf(target.path), name), '重命名')
  }

  async function moveTreeEntry (target: TreeContextTarget, destination: string): Promise<boolean> {
    if (target.kind === 'dir' && (destination === target.path || destination.startsWith(`${target.path}/`))) {
      status.set('移动失败：不能把目录移入自身或子目录。', true)
      return false
    }
    const to = joinPath(destination, basename(target.path))
    if (to === target.path) return true
    return await renamePath(target, to, '移动')
  }

  async function promptDelete (target: TreeContextTarget): Promise<void> {
    const contained = target.kind === 'dir' ? fileTree.filesUnder(target.path) : []
    const isEmptyDir = target.kind === 'dir' && fileTree.isEmptyDirectory(target.path)
    const dirtyInside = [target.path, ...contained].filter(path => documents.isDirty(path))

    const preview = contained.slice(0, 12)
    const body = [
      target.kind === 'file' ? `将删除文件：${target.path}` : `将删除目录：${target.path}`,
    ]
    if (target.kind === 'dir') {
      body.push(isEmptyDir
        ? '该目录当前为空。'
        : `其中包含 ${contained.length} 个文件：${preview.join('、')}${contained.length > preview.length ? ` 等 ${contained.length} 个` : ''}`)
    }
    if (dirtyInside.length > 0) {
      body.push(`警告：${dirtyInside.join('、')} 有未保存的修改，删除后这些改动将无法落盘。`)
    }
    body.push('此操作不可撤销。')

    const fields = target.kind === 'dir' && !isEmptyDir
      ? [{
          kind: 'checkbox' as const,
          name: 'recursive',
          label: '连同目录内的全部内容一起删除',
          danger: true,
          hint: '不勾选时服务端会拒绝（FH2_IDE_NOT_EMPTY）—— 契约要求破坏性操作显式开启。',
        }]
      : []

    const result = await showDialog({
      title: '删除确认',
      body,
      fields,
      confirmLabel: '删除',
      danger: true,
    })
    if (result === null) return

    const recursive = result.recursive === true
    if (target.kind === 'dir' && !isEmptyDir && !recursive) {
      status.set(`未删除 ${target.path}：目录非空，需要勾选「连同内容一起删除」。`, true)
      return
    }

    try {
      await ideApi.fsDelete(target.path, recursive)
    } catch (error) {
      reportError(`删除 ${target.path} 失败`, error)
      return
    }
    for (const path of [target.path, ...contained]) {
      if (documents.has(path)) documents.close(path)
    }
    await refreshTree()
    status.set(`已删除 ${target.path}`)
  }

  /** 关闭全部文档、清空问题与画布，再按新工作区重拉树与 schema。 */
  /** N1：Start Center 打开入口 —— 校验失败保持原工作区/Start Center，可恢复。 */
  async function openWorkspacePath (root: string): Promise<void> {
    if (documents.hasDirty) {
      const decision = await showDialog({
        title: '切换工作区前处理未保存修改',
        body: [documents.dirtyPaths.join('、')],
        fields: [{ kind: 'select', name: 'action', label: '处理方式', value: 'save', options: [
          { value: 'save', label: '保存并切换' },
          { value: 'discard', label: '丢弃并切换' },
        ] }],
        confirmLabel: '切换',
      })
      if (decision === null || (decision.action === 'save' && !(await saveAll()))) return
    }
    const previousRoot = workspace.selfInitiatedRoot
    workspace.selfInitiatedRoot = root
    startup.setPhase('opening')
    try {
      const workspaceInfo = await ideApi.openWorkspace(root)
      await resetForWorkspace(workspaceInfo)
      startup.setPhase('ready')
      status.set(workspaceStatus('已打开', workspaceInfo), workspaceInfo.diagnostics.length > 0)
    } catch (error) {
      workspace.selfInitiatedRoot = previousRoot
      const message = describeApiError(error)
      startup.fail(`打开 ${root} 失败：${message}`)
    }
  }

  /**
   * N3：install 任务跟踪 —— 失败/取消保留已创建工程（executor 语义），提示可重试。
   * 返回终态；快照可能已达终态（任务先于订阅完成），先查快照再等 SSE。
   * 期间不切换工作根（避免 openWorkspace 的 stopAll 把安装任务取消）。
   */
  function trackInstallTask (taskId: string, projectRoot: string): Promise<'succeeded' | 'failed' | 'cancelled'> {
    return new Promise((resolve) => {
      let settled = false
      let unsubscribe = (): void => {}
      let timer = 0
      const stop = (): void => {
        settled = true
        unsubscribe()
        window.clearInterval(timer)
        cleanup.delete(stop)
      }
      const finish = (state: 'succeeded' | 'failed' | 'cancelled'): void => {
        if (settled) return
        stop()
        if (state === 'failed') {
          status.set(`依赖安装失败（${projectRoot} 的工程文件已保留）：任务面板可重试`, true)
        }
        resolve(state)
      }
      unsubscribe = events.onTaskEvent((event) => {
        if (event.taskId !== taskId) return
        tasks.applyEvent(event)
        if (event.type === 'state' && (event.state === 'succeeded' || event.state === 'failed' || event.state === 'cancelled')) {
          unsubscribe()
          finish(event.state)
        }
      })
      let querying = false
      const query = async (): Promise<void> => {
        if (querying || settled) return
        querying = true
        try {
          const snapshot = await ideApi.taskGet(taskId)
          if (settled) return
          tasks.applySnapshot(snapshot)
          if (snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled') finish(snapshot.state)
        } catch (error) {
          status.set(`安装状态查询失败，将自动重试：${describeApiError(error)}`, true)
        } finally {
          querying = false
        }
      }
      timer = window.setInterval(() => void query(), 3000)
      cleanup.add(stop)
      void query()
    })
  }

  let workspaceQueue = Promise.resolve()
  let transitionSequence = 0
  function resetForWorkspace (workspaceInfo: WorkspaceInfo): Promise<void> {
    const sequence = ++transitionSequence
    const next = workspaceQueue.then(async () => {
      if (disposed || sequence !== transitionSequence) return
      await applyWorkspace(workspaceInfo, sequence)
    })
    workspaceQueue = next.catch(() => undefined)
    return next
  }

  async function applyWorkspace (workspaceInfo: WorkspaceInfo, sequence: number): Promise<void> {
    openSequence += 1
    clearAutoSaveTimers()
    // IDE 内剪贴板是相对旧根的路径，切根后失效
    copiedEntry = null
    lspClient?.stop()
    lspClient = null
    if (workspaceConfigRefreshTimer !== null) {
      window.clearTimeout(workspaceConfigRefreshTimer)
      workspaceConfigRefreshTimer = null
    }
    workspaceConfigRefreshRequested = false
    closeContextMenu()
    // F5：会话与写请求绑定；F1：绝对 URI 基准随根切换。
    setWorkspaceSession(workspaceInfo.sessionId)
    workflow.reset()
    documents.setWorkspaceRoot(workspaceInfo.root)
    documents.reset()
    problems.clearAll()
    fileTree.reset()
    tasks.setSession(workspaceInfo.sessionId)
    selectedRunTargets.clear()
    run.clear()
    workspace.info = workspaceInfo
    // IDE-011-05：切根重置销毁文档后，先把留存的草稿以未保存 tab 开回（在场优先，
    // 不激活——焦点稍后由 preferred 打开后再交还草稿）。
    let draftsToReopen: readonly RecoveryFile[] = []
    if (pendingReopen.length > 0) {
      draftsToReopen = [...pendingReopen]
      pendingReopen.length = 0
      reopenRetainedDrafts(draftsToReopen, { activate: false })
    }

    let schemas = workspace.schemas
    try {
      schemas = (await ideApi.schemas()).schemas
    } catch (error) {
      status.set(`新工作区的 schema 拉取失败，沿用旧的：${describeApiError(error)}`, true)
    }
    if (disposed || sequence !== transitionSequence) return
    workspace.apply(workspaceInfo, schemas)
    problems.setProblems('workspace', diagnosticsToProblems(workspaceInfo.diagnostics, 'workspace'))
    // 词表跟着工作根走：新工程的 plugin.json 里是另一批脚本。
    await refreshCatalog()
    if (disposed || sequence !== transitionSequence) return
    await refreshTree()
    await refreshRunStatus()
    if (disposed || sequence !== transitionSequence) return
    const preferred = fileTree.firstPreferredFile
    if (preferred !== null) await openFile(preferred)
    // preferred 打开后把焦点交还草稿（用户中断前的编辑焦点，IDE-011-05）。
    if (draftsToReopen.length > 0) reopenRetainedDrafts(draftsToReopen, { activate: true })
    if (disposed || sequence !== transitionSequence) return
    if (workspaceInfo.kind !== 'unknown') {
      ui.setView('editor')
      startup.setPhase('ready')
      startLspClient(workspaceInfo)
    }
  }

  async function handleWorkspaceEvent (event: WorkspaceEvent): Promise<void> {
    const info = workspace.info
    if (info !== null && event.root === info.root) return
    if (workspace.selfInitiatedRoot === event.root) {
      // 这条事件是本地这次切换的回声，resetForWorkspace 已经跑过了
      workspace.selfInitiatedRoot = null
      return
    }
    // 工作区是被别处（另一个标签页 / CLI）切走的，本地无从阻止；草稿先留存，
    // 重置过程中以未保存 tab 重新开回（IDE-011-05：tab 延续才算保护，提示不算）。
    const retained = retainFiles(documents.dirtyPaths, false)
    if (retained.length > 0 || workflow.dirty) {
      status.set(
        `服务端工作区已切换到 ${event.root}；${retained.map(file => file.path).join('、')}${workflow.dirty ? '（含画布）' : ''} 的未保存修改已保留为标签页（保存将写入当前工作区）。`,
        true,
      )
    } else {
      status.set(`服务端工作区已切换到 ${event.root}，正在重新加载…`, true)
    }
    try {
      const next = await ideApi.workspace()
      const retainedLate = retainFiles(documents.dirtyPaths, false)
      // ⚠️ reopen 必须发生在 resetForWorkspace **内部**（documents.reset() 之后、
      // toolbar/preferred 打开之前），不能等整个切换流程完成——那之前 UI 已重绘，
      // 草稿 tab 的窗口期里看不到保护。经 pendingReopen 队列传递。
      pendingReopen.push(...retained, ...retainedLate)
      await resetForWorkspace(next)
    } catch (error) {
      reportError('跟随服务端切换工作区失败', error)
    }
  }

  // ── 契约 §8：运行 / 预览 ────────────────────────

  async function refreshRunStatus (): Promise<void> {
    const session = workspace.info?.sessionId
    try {
      const [statusResult, logsResult] = await Promise.all([ideApi.runStatus(), ideApi.runLogs()])
      if (session !== workspace.info?.sessionId) return
      run.setProcesses(statusResult.processes)
      for (const event of logsResult.lines) run.append(event)
    } catch (error) {
      if (session !== workspace.info?.sessionId) return
      // 后端还没实现 §8 时不该让整个 IDE 报错，静默降级成「无进程」
      run.setProcesses([])
      if (error instanceof IdeApiError && error.unauthorized) handleFatal(error)
    }
  }

  async function toggleRun (mode: RunMode): Promise<void> {
    if (run.isActive(mode)) {
      await stopRun(mode)
      return
    }
    await startRun(mode)
  }

  async function startRun (mode: RunMode): Promise<void> {
    const session = workspace.info?.sessionId
    // F3：Dev/Preview 前执行 Save All；冲突未解决不启动。
    if (!(await saveAll())) {
      status.set('存在未解决冲突或保存失败，已取消启动', true)
      return
    }
    let target = ''
    if (mode === 'preview') {
      // Preview 仅构建本地前端，通过 HTTP Origin Proxy/PAC 接入目标司空项目页。
      const result = await showDialog({
        title: '在真实司空中预览本地前端？',
        body: [
          'preview 只在本地构建当前工作区的前端产物，通过 HTTP Origin Proxy/PAC 在真实司空页面加载；不支持 HTTPS。',
          '启动后按运行日志配置并启用 SwitchyOmega PAC，在同一 Origin（协议、主机、端口）的司空页面登录并进入项目页。',
          '打开日志中的调试面板地址，手动填写本次会话的资源根 URL（日志中的完整“插件来源URL”），再校验、勾选同意、确认并重载。调试面板地址不会自动预填来源或 session；资源根不是 localhost 单插件 Manifest URL、Entry JS、PAC 或调试面板地址，不要沿用旧会话来源。',
          '后端将使用目标司空环境上已安装的版本运行；不会发布、上传或修改任何后端资产。',
          '如果想在纯本地环境运行，请改用「运行 dev」（本地 Mock 宿主）。',
        ],
        fields: [
          {
            kind: 'text',
            name: 'target',
            label: '司空项目页地址',
            placeholder: 'http://fh2.example.com/project?org=1（必填）',
            hint: '目标司空项目页的完整 HTTP URL（含项目路径和参数）；不支持 HTTPS，留空无法启动。',
          },
          {
            kind: 'checkbox',
            name: 'ack',
            label: '我了解将在真实司空页面中加载本地前端产物',
          },
        ],
        confirmLabel: '开始预览',
      })
      if (result === null) return
      if (result.ack !== true) {
        status.set('未启动 preview：需要勾选确认才能在真实环境中预览。', true)
        return
      }
      target = String(result.target ?? '')
    }

    let projectPath: string
    try {
      const targets = (await ideApi.runTargets()).targets.filter(candidate => candidate.modes.includes(mode))
      const remembered = selectedRunTargets.get(mode)
      const rememberedTarget = targets.find(candidate => candidate.projectPath === remembered)
      if (targets.length === 1) {
        projectPath = targets[0]!.projectPath
      } else if (targets.length === 0) {
        status.set(`当前工作区没有支持 ${mode} 的 Capability 或前端插件`, true)
        return
      } else {
        const selection = await showDialog({
          title: `选择 ${mode} 运行目标`,
          fields: [{
            kind: 'select',
            name: 'projectPath',
            label: '项目',
            value: rememberedTarget?.projectPath ?? targets[0]!.projectPath,
            options: targets.map(candidate => ({
              value: candidate.projectPath,
              label: `${candidate.label}（${candidate.kind}）`,
            })),
          }],
          confirmLabel: '运行',
        })
        if (selection === null) return
        projectPath = String(selection.projectPath)
      }
      selectedRunTargets.set(mode, projectPath)
    } catch (error) {
      run.note(mode, `读取运行目标失败：${describeApiError(error)}`, true)
      reportError('读取运行目标失败', error)
      return
    }

    ui.switchPanelTab('run')
    if (session !== workspace.info?.sessionId) return
    run.note(mode, `请求启动 ${MODE_LABEL[mode]}（${projectPath}）…`)
    try {
      const options = { projectPath, ...(target === '' ? {} : { target }) }
      let started = await ideApi.runStart(mode, options)
      while (started.portConflict !== undefined) {
        if (session !== workspace.info?.sessionId) return
        const conflict = started.portConflict
        run.applyRunState({ schemaVersion: 1, mode, status: 'failed', projectPath, detail: conflict.message })
        if (conflict.confirmationToken === undefined) {
          status.set(`dev 启动失败：${conflict.message}`, true)
          return
        }
        const confirmed = await confirmDialog({
          title: `dev 端口 ${conflict.port} 被占用`,
          body: [conflict.message, ...conflict.processes.map(item => `${item.command}（PID ${item.pid}）`), '停止后会中断这些进程正在提供的服务。'],
          confirmLabel: '停止进程并启动',
          cancelLabel: '取消启动',
          danger: true,
        })
        if (!confirmed || session !== workspace.info?.sessionId) {
          status.set(`dev 启动失败：端口 ${conflict.port} 被占用，已取消启动`, true)
          return
        }
        status.set(`正在释放端口 ${conflict.port} 并启动 dev…`)
        started = await ideApi.runStart(mode, { ...options, port: conflict.port, portConfirmation: conflict.confirmationToken })
      }
      if (session !== workspace.info?.sessionId) return
      run.applyRunState({ schemaVersion: 1, ...started })
      run.note(mode, `服务端回执：${started.status} · ${started.projectPath}${started.url === undefined ? '' : ` · ${started.url}`}`)
      if (started.status === 'running' && started.url !== undefined && started.url !== '') {
        await offerOpenUrl(mode, started.url)
      }
    } catch (error) {
      if (session !== workspace.info?.sessionId) return
      run.note(mode, `启动失败：${describeApiError(error)}`, true)
      reportError(`启动 ${mode} 失败`, error)
      await refreshRunStatus()
    }
  }

  async function stopRun (mode: RunMode): Promise<void> {
    const session = workspace.info?.sessionId
    run.note(mode, `请求停止 ${MODE_LABEL[mode]}…`)
    // 停过之后重启（可能换端口）应当重新询问是否打开
    offeredRunUrls.clear()
    try {
      const stopped = await ideApi.runStop(mode)
      if (session !== workspace.info?.sessionId) return
      run.applyRunState({ schemaVersion: 1, mode: stopped.mode, status: stopped.status })
      status.set(`${MODE_LABEL[mode]} 已停止`)
    } catch (error) {
      if (session !== workspace.info?.sessionId) return
      run.note(mode, `停止失败：${describeApiError(error)}`, true)
      reportError(`停止 ${mode} 失败`, error)
      await refreshRunStatus()
    }
  }

  function handleRunEvent (event: RunEvent): void {
    const previous = run.statusOf(event.mode)
    run.applyRunState(event)
    if (previous?.status === event.status) return
    run.note(event.mode, `状态变为 ${event.status}${event.url === undefined ? '' : ` · ${event.url}`}`)
    if (event.status === 'failed') status.set(`${MODE_LABEL[event.mode]} 启动失败，详情见运行日志。`, true)
    // dev 起来并给出 URL 时主动问一句要不要开 —— preview 不问，避免误触打开真实环境
    if (event.mode === 'dev' && event.status === 'running' && event.url !== undefined && event.url !== '') {
      void offerOpenUrl(event.mode, event.url)
    }
  }

  async function offerOpenUrl (mode: RunMode, url: string): Promise<void> {
    if (mode !== 'dev') return
    /**
     * `POST /api/run/start` 的回执与随后的 SSE `run` 事件都会带上 URL，
     * 不去重就会连弹两次同样的确认框。按 URL 记一次即可 —— 换了 URL（重启换端口）要再问。
     */
    if (offeredRunUrls.has(url)) return
    offeredRunUrls.add(url)
    const confirmed = await confirmDialog({
      title: '本地 dev 已就绪',
      body: [`Mock 宿主运行在 ${url}`, '要在新标签页打开吗？'],
      confirmLabel: '打开',
      cancelLabel: '稍后',
    })
    if (confirmed) openRunUrl(url)
  }

  function openRunUrl (url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  function handleTaskEvent (event: import('../../../src/contracts/index.js').TaskEvent): void {
    if (event.workspaceSessionId !== undefined && event.workspaceSessionId !== workspace.info?.sessionId) return
    tasks.applyEvent(event)
    if (event.type === 'state' && (event.state === 'succeeded' || event.state === 'failed' || event.state === 'cancelled')) {
      const snapshot = tasks.tasks.find(task => task.taskId === event.taskId)
      if (snapshot !== undefined && (snapshot.kind === 'build' || snapshot.kind === 'pack')) {
        // L4：构建诊断进 build 源，不清除 Validate/编辑器诊断。
        problems.setProblems('build', diagnosticsToProblems(snapshot.diagnostics, 'build'))
        const label = TASK_STATE_LABEL[event.state]
        status.set(
          `构建任务${label}${snapshot.stale === true ? '（源码在构建期间被修改，产物已标记 stale）' : ''}`,
          event.state === 'failed',
        )
        if (event.state === 'failed') ui.switchPanelTab('problems')
        scheduleTreeRefresh()
      }
    }
  }

  // ── 能力层命令 ──────────────────────────────────

  async function runValidate (options?: { readonly silent?: boolean }): Promise<void> {
    if (ui.busy !== null) return
    const silent = options?.silent === true
    // F3：操作前 Save All；冲突未解决不启动。
    if (!silent && !(await saveAll())) {
      status.set('存在未解决冲突或保存失败，已取消校验', true)
      ui.switchPanelTab('problems')
      return
    }
    ui.busy = 'validate'
    // 手动检查工程先清空旧问题，避免把上一轮的诊断误读成这一轮结果；
    // 保存后的静默校验保留当前问题，直到新结果替换。
    if (!silent) problems.clearAll()
    const session = workspace.info?.sessionId
    if (!silent) status.set('校验中…')
    try {
      const result = await ideApi.validate()
      if (session !== workspace.info?.sessionId) return
      problems.setApiProblems(diagnosticsToProblems(result.diagnostics))
      const summary = result.ok
        ? `校验通过（${result.durationMs} ms）`
        : `校验未通过：${result.diagnostics.length} 条诊断（${result.durationMs} ms）`
      // 保存后的自动校验只更新问题面板；状态栏保留「已保存 …」，否则用户看不到保存回执
      if (silent) status.append(summary)
      else status.set(summary, !result.ok)
      if (!result.ok && !silent) ui.switchPanelTab('problems')
    } catch (error) {
      if (session !== workspace.info?.sessionId) return
      reportError('校验失败', error)
    } finally {
      ui.busy = null
    }
  }

  /**
   * U2：Pack 任务（含成员选择；打包本身包含构建与类型检查）。
   * Save All 门禁不通过时零任务启动（F3）。
   * - 插件根（frontend-plugin / backend-plugin）：无成员概念，直接启动；
   * - Capability / 行业工作区：先弹成员勾选（默认全选 = 全量）。
   */
  async function runPack (): Promise<void> {
    if (ui.busy !== null) return
    if (!(await saveAll())) {
      status.set('存在未解决冲突或保存失败，已取消打包', true)
      return
    }

    const kind = workspace.info?.kind ?? 'unknown'
    const session = workspace.info?.sessionId
    let members: readonly string[] | undefined
    if (kind === 'capability-project' || kind === 'industry-capability-workspace') {
      const tree = derivePackMembers(fileTree.allFiles, kind)
      if (tree === null) {
        // 文件树被截断时推导结果不可信：回落全量，由服务端按真实成员清单执行
        if (fileTree.truncated) {
          status.set('文件树已截断，无法按成员勾选；将执行全量打包。', true)
        } else {
          status.set('未发现可打包的插件成员；将执行全量打包。', true)
        }
      } else {
        const namedTree = await loadPackMemberNames(tree, async path => (await ideApi.readFile(path)).content)
        if (session !== workspace.info?.sessionId) return
        const selection = await showDialog({
          title: '选择打包范围',
          body: ['勾选要打进上传包的成员（默认全选）；取消勾选即从包中裁掉。'],
          fields: [{
            kind: 'members',
            name: 'members',
            label: '成员',
            tree: namedTree,
          }],
          confirmLabel: '打包',
        })
        if (selection === null) return
        const checked = Array.isArray(selection.members) ? selection.members : []
        const allIds = collectPackMemberLeafIds(tree)
        if (checked.length === 0) {
          status.set('未启动打包：至少需要勾选一个成员。', true)
          return
        }
        // 全选 ⇄ 缺省（全量）：语义等价，走服务端默认路径
        members = checked.length === allIds.length ? undefined : checked
      }
    }

    ui.busy = 'pack'
    try {
      if (session !== workspace.info?.sessionId) return
      const snapshot = await ideApi.taskStart('pack', members === undefined ? undefined : { members: members.join(',') })
      if (session !== workspace.info?.sessionId) return
      tasks.applySnapshot(snapshot)
      status.set(`打包任务 ${snapshot.taskId.slice(0, 12)} 已受理（${snapshot.state}）`)
      // 任务进度/产物在任务面板，受理后自动切过去（switchPanelTab 自带展开）
      ui.switchPanelTab('tasks')
    } catch (error) {
      if (session !== workspace.info?.sessionId) return
      reportError('打包任务启动失败', error)
    } finally {
      ui.busy = null
    }
  }

  /** U2：取消任务。 */
  async function cancelTask (taskId: string): Promise<void> {
    try {
      const snapshot = await ideApi.taskCancel(taskId)
      tasks.applySnapshot(snapshot)
    } catch (error) {
      reportError('取消任务失败', error)
    }
  }

  /** U3：下载产物快照（fetch + blob，服务端校验 digest）。 */
  async function downloadArtifact (taskId: string, artifactId: string): Promise<void> {
    try {
      const { blob, fileName } = await ideApi.artifactDownload(taskId, artifactId)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      anchor.click()
      URL.revokeObjectURL(url)
      status.set(`已下载 ${fileName}（${blob.size} 字节）——上传到司空为手动步骤`)
    } catch (error) {
      reportError('产物下载失败', error)
    }
  }

  // ── SSE ────────────────────────────────────────

  function retainFiles (paths: readonly string[], deleted: boolean): RecoveryFile[] {
    const info = workspace.info
    if (info === null) return []
    const retained: RecoveryFile[] = []
    for (const path of paths) {
      const content = documents.contentOf(path)
      if (content !== null) {
        const file: RecoveryFile = { root: info.root, session: info.sessionId, path, content, deleted }
        recovery.retain(file)
        retained.push(file)
      }
    }
    return retained
  }

  /**
   * IDE-011-05 草稿保护：切根重置销毁文档后，把留存内容重新开回**未保存 tab**。
   * 草稿以 tab 延续（可继续编辑/保存/丢弃），不是一句「无法落盘」的提示；
   * 恢复对话框仍兜底（reopen 失败或外删 deleted 场景不走这里，弹窗照旧）。
   * 若新根已用磁盘内容打开了同路径 tab（applyWorkspace 的 preferred 打开），
   * 用带版本核验的 applyEdit 把草稿覆写回去，产生 dirty 而不是丢内容。
   */
  function reopenRetainedDrafts (files: readonly RecoveryFile[], options: { readonly activate?: boolean } = {}): void {
    // 同一路径可能留存多份（await 窗口前后的两次快照）：取最后一份（最新内容）。
    const byPath = new Map<string, RecoveryFile>()
    for (const file of files) {
      if (!file.deleted) byPath.set(file.path, file)
    }
    for (const file of byPath.values()) {
      if (documents.has(file.path)) {
        if (documents.contentOf(file.path) !== file.content) {
          const version = documents.modelVersion(file.path)
          if (version !== undefined) documents.applyEdit(file.path, file.content, version)
        }
      } else {
        documents.openUnsaved(file.path, file.content)
      }
      // 草稿是用户中断前的编辑焦点：焦点交还时激活（preferred 已打开后调用）；
      // 仅在场阶段不激活，避免抢 preferred 的初始焦点又被反抢。
      if (options.activate === true) documents.activate(file.path)
    }
    // dismiss 用数组里的同一批（响应式代理）对象按身份移除；原始对象 !== 代理对象。
    for (const current of [...recovery.files]) {
      if (!current.deleted && byPath.has(current.path)) recovery.dismiss(current)
    }
  }

  const diskReads = new Map<string, number>()
  async function reloadDocument (path: string): Promise<void> {
    if (!documents.has(path)) return
    const sequence = (diskReads.get(path) ?? 0) + 1
    diskReads.set(path, sequence)
    const session = workspace.info?.sessionId
    const identity = documents.modelIdentity(path)
    const valid = (): boolean => !disposed && session === workspace.info?.sessionId && documents.modelIdentity(path) === identity && diskReads.get(path) === sequence
    try {
      const file = await ideApi.readFile(path)
      if (!valid()) return
      if (documents.isDirty(path) && documents.conflictOf(path) === null && documents.expectedRevision(path) === file.revision) return
      if (documents.isDirty(path)) documents.enterConflict(path, { diskContent: file.content, diskRevision: file.revision })
      // 有编辑史的 clean 文档不静默重灌（DAG-014-01）：内容判据说没改动，但
      // undo 栈里是用户的编辑——重灌会清掉它。树照常刷新；要取磁盘新内容
      // 走「从磁盘重新载入」（那条路对 dirty 文档有冲突面板保护）。
      else if (!documents.hasUndoHistory(path)) documents.reloadFromDisk(path, file.content, file.revision)
    } catch (error) {
      if (!valid()) return
      if (error instanceof IdeApiError && error.code === 'FH2_IDE_NOT_FOUND') {
        if (documents.isDirty(path)) documents.markAbsentFromDisk(path)
        else documents.close(path)
        status.set(`${path} 已在磁盘上删除${documents.isDirty(path) ? '，未保存内容已保留' : ''}`, true)
      } else {
        reportError(`重载 ${path} 失败`, error)
      }
    }
  }

  async function handleFsEvent (event: FsEvent): Promise<void> {
    if (isWorkspaceDiscoveryPath(event.path)) scheduleWorkspaceConfigurationRefresh()
    if (event.type !== 'change') {
      scheduleTreeRefresh()
      if (event.type === 'unlink' || event.type === 'unlinkDir') {
        const paths = documents.allPaths().filter(path => path === event.path || path.startsWith(`${event.path}/`))
        for (const path of paths) {
          if (documents.isDirty(path)) {
            // DAG-017-09 规格：外删的脏文档保 tab 保内容（下次保存走 create 重建），
            // 不进恢复对话框——它不可关闭，会挡住外删后的所有后续操作。
            documents.markAbsentFromDisk(path)
            status.set(`${path} 已在磁盘上删除，未保存内容已保留`, true)
          } else {
            documents.close(path)
          }
        }
      }
      return
    }
    scheduleTreeRefresh()
    await workflow.onExternalChange(event.path)
    await reloadDocument(event.path)
  }

  // ── 启动与致命错误 ────────────────────────────

  let disconnected = false
  let recovering: Promise<void> | null = null
  function recoverConnection (): Promise<void> {
    if (recovering !== null) return recovering
    recovering = (async () => {
      try {
        const info = await ideApi.workspace()
        if (workspace.info?.sessionId !== info.sessionId) {
          pendingReopen.push(...retainFiles(documents.dirtyPaths, false))
          await resetForWorkspace(info)
        }
        await tasks.refresh(true)
        await refreshRunStatus()
        await refreshTree()
        await Promise.all(documents.allPaths().map(reloadDocument))
      } catch (error) {
        reportError('重连同步失败，可刷新重试', error)
      }
    })().finally(() => {
      recovering = null
    })
    return recovering
  }

  onBeforeUnmount(() => {
    disposed = true
    for (const stop of cleanup) stop()
    openSequence += 1
    transitionSequence += 1
    events.stop()
    lspClient?.stop()
    clearAutoSaveTimers()
    if (treeRefreshTimer !== null) window.clearTimeout(treeRefreshTimer)
    if (workspaceConfigRefreshTimer !== null) window.clearTimeout(workspaceConfigRefreshTimer)
  })

  async function loadWorkspace (): Promise<void> {
    const [workspaceInfo, schemas] = await Promise.all([ideApi.workspace(), ideApi.schemas()])
    // F5：写请求自动携带会话 id；F1：文档 model 使用绝对 file URI。
    setWorkspaceSession(workspaceInfo.sessionId)
    workflow.reset()
    documents.setWorkspaceRoot(workspaceInfo.root)
    tasks.setSession(workspaceInfo.sessionId)
    workspace.apply(workspaceInfo, schemas.schemas)
    problems.setProblems('workspace', diagnosticsToProblems(workspaceInfo.diagnostics, 'workspace'))
    // N1/N2：无有效工程（unknown）→ Start Center；不把空树当编辑器打开。
    if (workspaceInfo.kind === 'unknown') {
      startup.setPhase('start-center')
      ui.setView('start')
      status.set('未绑定插件工程 —— 在 Start Center 打开或创建工程')
      return
    }
    startup.setPhase('ready')
    await refreshCatalog()

    await refreshTree()
    const preferred = fileTree.firstPreferredFile
    if (preferred !== null) await openFile(preferred)
    status.set(workspaceStatus('已连接', workspaceInfo), workspaceInfo.diagnostics.length > 0)
    startLspClient(workspaceInfo)
  }

  function workspaceStatus (verb: '已打开' | '已连接', workspaceInfo: WorkspaceInfo): string {
    if (workspaceInfo.diagnostics.length === 0) return `${verb} ${workspaceInfo.root}`
    return `${verb} ${workspaceInfo.root}，检测到 ${workspaceInfo.diagnostics.length} 个工程配置错误`
  }

  /** L3：启动/重建 LSP 客户端（hello 携带当前会话；切根后旧客户端停止）。 */
  function startLspClient (workspaceInfo: WorkspaceInfo): void {
    lspClient?.stop()
    const client = new LspDiagnosticsClient({
      url: `${wsOrigin()}/lsp`,
      token: window.__FH2_IDE_TOKEN__ ?? 'dev-token',
      sessionId: workspaceInfo.sessionId,
      rootUri: monaco.Uri.file(workspaceInfo.root).toString(),
      onDiagnostics: (diagnostics) => {
        // L4：LSP 诊断进 lsp 源；与 Validate/Build/编辑器诊断互不清除。
        problems.setProblems('lsp', diagnosticsToProblems(diagnostics, 'lsp'))
      },
      onStatus: (next, detail) => lsp.setStatus(next, detail),
      onLog: entry => lsp.append(entry.source, entry.message),
    })
    client.setDocumentsProvider(() => documents.openPaths.map(path => ({
      path,
      content: documents.contentOf(path) ?? '',
      languageId: languageOf(path),
    })))
    client.start()
    lspClient = client
  }

  function wsOrigin (): string {
    // 同源 WebSocket：serve 在同一端口提供 /lsp upgrade。
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}`
  }

  function reportError (context: string, error: unknown): void {
    if (error instanceof IdeApiError && error.unauthorized) {
      handleFatal(error)
      return
    }
    status.set(`${context}：${describeApiError(error)}`, true)
  }

  function handleFatal (error: unknown): void {
    events.stop()
    if (error instanceof IdeApiError && error.unauthorized) {
      ui.setFatal('鉴权失败（401）', [
        '当前页面携带的 IDE token 与 fh2-plugin serve 不匹配。',
        'token 由 serve 启动时随机生成并注入首页，刷新旧标签页无法取得新 token。',
        '请回到终端复制 serve 输出的地址重新打开，或重启 fh2-plugin serve。',
        `服务端返回：${error.message}`,
      ])
      status.set('鉴权失败，IDE 已停止工作', true)
      return
    }
    const detail = error instanceof Error ? error.message : String(error)
    ui.setFatal('无法初始化 Web IDE', [
      '未能从 fh2-plugin serve 取得工作区信息。',
      '请确认 serve 仍在运行，然后刷新页面。',
      `错误详情：${detail}`,
    ])
    status.set('初始化失败', true)
  }

  function start (): void {
    // 画布落盘后的能力层校验兜底（契约 §9）
    workflow.setAfterSaveHook(async () => {
      await runValidate({ silent: true })
    })
    // W2：检查器「在主编辑器打开脚本」→ 统一 jumpTo（模型共享，无需重新拉取）。
    workflow.setOpenScriptHook(async (scriptPath) => {
      await jumpTo(scriptPath, 1, 1)
    })

    // 焦点不在编辑器上时 Monaco 的 command 不触发，仍要拦住浏览器的「保存网页」
    useEventListener(window, 'keydown', (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      void saveActive()
    })

    useEventListener(window, 'beforeunload', (event) => {
      if (!documents.hasDirty && !workflow.dirty && recovery.files.length === 0) return
      event.preventDefault()
      event.returnValue = ''
    })

    events.onConnectionChange((connected) => {
      status.setConnected(connected)
      if (!connected) {
        disconnected = true
      } else if (disconnected) {
        disconnected = false
        void recoverConnection()
      }
    })
    events.onFsEvent(event => void handleFsEvent(event))
    events.onWorkspaceEvent(event => void handleWorkspaceEvent(event))
    events.onRunEvent(event => handleRunEvent(event))
    // IDE-017-10：切根后 SSE 迟到释放的旧会话日志不混入当前标签的终端——
    // 带其他 workspaceSessionId 的行直接丢弃（它属于旧根，不再有归属者）。
    events.onRunLog((event) => {
      const current = workspace.info?.sessionId
      if (event.workspaceSessionId !== undefined && current !== undefined && event.workspaceSessionId !== current) return
      run.append(event)
    })
    // U1：任务事件（sequence 去重在 store）；终态时诊断/产物入库并刷新文件树。
    events.onTaskEvent(event => handleTaskEvent(event))
    void tasks.refresh()

    // TS 诊断档位跟随活动文档（后端 goja：ES2015 无 Promise / 浏览器 ES2022 双档）；同时同步 LSP 文档。
    watch(() => [documents.active, documents.revision] as const, () => {
      const active = documents.active
      if (active !== null) {
        workspace.applyTypeScriptDefaults(isGojaScript(active, workspace.info?.kind ?? 'unknown'))
      }
      lspClient?.scheduleSync()
    })

    const markers = monaco.editor.onDidChangeMarkers(() => {
      problems.setEditorProblems(markersToProblems(
        monaco.editor.getModelMarkers({}).filter(marker => marker.owner !== LSP_MARKER_OWNER),
        workspace.info?.root,
      ))
    })
    cleanup.add(() => markers.dispose())

    void loadWorkspace()
      .then(async () => {
        events.start()
        await refreshRunStatus()
      })
      .catch(handleFatal)
  }

  const context: IdeContext = {
    start,
    switchView,
    openFile,
    closeFile,
    saveActive,
    saveAll,
    jumpTo,
    revealWorkflowNode,
    showTreeMenu,
    promptCreate,
    createTreeEntry,
    renameTreeEntry,
    moveTreeEntry,
    openWorkspacePath,
    trackInstallTask,
    refreshTree,
    loadTreeChildren,
    runValidate,
    runPack,
    cancelTask,
    downloadArtifact,
    toggleRun,
    openRunUrl,
    openInCanvas,
  }
  provide(IDE_KEY, context)
  return context
}
