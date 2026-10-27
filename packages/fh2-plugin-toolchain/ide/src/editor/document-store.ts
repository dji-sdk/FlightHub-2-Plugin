// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import * as monaco from 'monaco-editor'
import type { ApplyResult, PreparedCommand } from '../../../src/workflow/core/commands.js'
import type { JsonEditOp } from '../../../src/workflow/core/json-edits.js'
import { applyJsonEditOp, canEditJson } from '../../../src/workflow/core/json-edits.js'

/**
 * 契约 §0：path 一律是相对工作根的 POSIX 相对路径。
 * 相对 URI（`file:///<path>`）供 JSON 语言服务的 fileMatch 与 Problems marker 使用；
 * F1 之后，工作根已知时文档 model 一律使用绝对 `file://` URI（LSP 消费同一 model）。
 */
export function pathToUri (path: string): monaco.Uri {
  return monaco.Uri.parse(`file:///${encodeWorkspacePath(path)}`)
}

export function uriToPath (uri: monaco.Uri): string {
  return decodeURIComponent(uri.path).replace(/^\//, '')
}

/** 绝对 file URI → 工作区相对路径；不在工作区内时退回 {@link uriToPath} 的旧行为。 */
export function uriToWorkspacePath (uri: monaco.Uri, root: string): string {
  const rootPath = workspacePathToUri(root, '').path.replace(/\/+$/, '')
  if (rootPath !== '' && (uri.path === rootPath || uri.path.startsWith(`${rootPath}/`))) {
    const relativePath = uri.path.slice(rootPath.length).replace(/^\/+/, '')
    return relativePath === '' ? '.' : decodeURIComponent(relativePath)
  }
  return uriToPath(uri)
}

/** F1：工作区相对路径 → 绝对 file URI（`file://<root>/<path>`）。 */
export function workspacePathToUri (root: string, path: string): monaco.Uri {
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/+$/, '')
  const prefix = normalizedRoot.startsWith('/') ? '' : '/'
  return monaco.Uri.parse(`file://${prefix}${encodeWorkspacePath(normalizedRoot)}${normalizedRoot === '' ? '' : '/'}${encodeWorkspacePath(path)}`)
}

function encodeWorkspacePath (path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  json: 'json',
  jsonc: 'json',
  vue: 'html',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'pgsql',
  sh: 'shell',
}

export function languageOf (path: string): string {
  const name = path.split('/').pop() ?? path
  const extension = name.includes('.') ? (name.split('.').pop() ?? '') : ''
  return LANGUAGE_BY_EXTENSION[extension.toLowerCase()] ?? 'plaintext'
}

/** 外部变更冲突态：磁盘内容/revision 快照，由冲突 UI 消费。 */
export interface DocumentConflict {
  readonly diskContent: string;
  readonly diskRevision: string;
}

interface OpenDocument {
  readonly path: string;
  readonly model: monaco.editor.ITextModel;
  /** 磁盘基线内容：isDirty = model 值 !== savedContent（F3：内容基线替代版本号基线）。 */
  savedContent: string;
  /**
   * 基线对应的 Monaco alternativeVersionId。isDirty 是**内容**判据：用户编辑后
   * （甚至贴入与基线相同的内容）undo 栈里已有编辑史，内容判据却读作 clean。
   * watcher 若对这种文档静默重灌，会连 undo 栈一起清掉（DAG-014-01），
   * 因此另存基线版本号：hasUndoHistory = 当前 id !== 基线 id。
   */
  savedVersionId: number;
  /** 磁盘基线 revision（内容 hash）；未知时保存前需先读取。 */
  savedRevision?: string | undefined;
  conflict: DocumentConflict | null;
  viewState: monaco.editor.ICodeEditorViewState | null;
  /** F1：引用计数——主编辑器与 Workflow 脚本编辑器共享同一 model，最后消费者释放。 */
  refCount: number;
  tabOpen?: boolean;

  /**
   * 单调递增的内容代号（C1）。**全局序列**，不是 Monaco 的 versionId。
   *
   * ★ 为什么不直接用 `model.getVersionId()`：它随 model 重建归 1。
   * 关掉再打开同一个文件后，一条 prepare 于重建之前的命令会看到「版本号又相等了」，
   * 于是前置核验放行 —— 那正是它要拦的情形。全局序列不会重复发号。
   */
  generation: number;

  /** 文件在磁盘上是否已存在。false = 画布新建、尚未落盘（虚拟文件）。 */
  existsOnDisk: boolean;

  /**
   * 命令要求删除该文件，等保存时落盘。
   * ⚠️ 与 close() 是两件事：close 只是不在编辑器里显示，pendingDelete 会真的删磁盘文件。
   */
  pendingDelete?: boolean;
}

/**
 * 一批文档变更的描述（C1 的「单一 DocumentBatchEvent」）。
 *
 * ★★ 为什么跨文件命令必须只发**一个**事件：逐文件发会让 UI 在中间态上重算投影 ——
 * 那一次重算看到的是「脚本已建、清单还没登记」，于是画布闪一下红字再变绿。
 */
export interface DocumentBatchEvent {
  readonly reason: 'edit' | 'command' | 'open' | 'close' | 'save' | 'conflict' | 'workspace' | 'disk';
  /** 本批涉及的路径（reason='workspace' 时为空）。 */
  readonly paths: readonly string[];
  /** reason='command' 时的命令类型（进历史与诊断）。 */
  readonly commandKind?: string;
  readonly workspaceEpoch: number;
}

/** 工作区结构化命令历史的一条。 */
export interface CommandHistoryEntry {
  readonly kind: string;
  readonly label: string;
  readonly paths: readonly string[];
  /** 应用后各文件的新 generation（用于「回到那一步之前」的诊断）。 */
  readonly generations: readonly { readonly path: string; readonly generation: number }[];
}

/** `snapshot(paths)` 的单条结果：一次固定输入字节集。 */
export interface DocumentSnapshot {
  readonly path: string;
  /** 文档未打开时为 null。 */
  readonly content: string | null;
  readonly generation: number;
  readonly existsOnDisk: boolean;
  readonly pendingDelete: boolean;
  readonly dirty: boolean;
  readonly conflicted: boolean;
  /** 磁盘基线 revision；虚拟文件与未知基线为 undefined。 */
  readonly expectedRevision?: string;
}

/**
 * ⚠️ 事件参数是**可选**的：既有调用方写的是 `onDidChange(() => refresh())`，
 * 它们照旧工作。要按 reason 精细刷新的新调用方才读这个参数。
 */
export type DocumentsListener = (event?: DocumentBatchEvent) => void

/** 命令历史上限：它只服务诊断与「刚才做了什么」，不是撤销栈，不需要无限长。 */
const MAX_COMMAND_HISTORY = 200

/**
 * 打开文档集合（F1/F3）：model 按 path 缓存（工作根已知时用绝对 URI），
 * 同一路径只有一个 Monaco model；编辑器绑定与撤销栈各自保留。
 */
export class DocumentStore {
  private readonly documents = new Map<string, OpenDocument>()
  private readonly listeners = new Set<DocumentsListener>()
  private readonly disposables = new Map<string, monaco.IDisposable>()
  private activePath: string | null = null
  private editor: monaco.editor.IStandaloneCodeEditor | null = null
  private workspaceRootPath: string | null = null

  /** 全局内容代号发号器（见 OpenDocument.generation 的 ★）。 */
  private changeSeq = 0
  /** 工作区代号：切根即 +1，让跨工作区的旧命令一律失效。 */
  private epoch = 0
  /** 批量深度 > 0 时不发事件，退出批量时合成一个（见 DocumentBatchEvent 的 ★★）。 */
  private batchDepth = 0
  private batchPaths = new Set<string>()
  private batchCommandKind: string | undefined
  private readonly commandHistory: CommandHistoryEntry[] = []

  attach (editor: monaco.editor.IStandaloneCodeEditor): void {
    if (this.editor !== null) this.detach(this.editor)
    this.editor = editor
    const active = this.activePath === null ? undefined : this.documents.get(this.activePath)
    editor.setModel(active?.model ?? null)
    if (active?.viewState != null) editor.restoreViewState(active.viewState)
  }

  detach (editor: monaco.editor.IStandaloneCodeEditor): void {
    if (this.editor !== editor) return
    const active = this.activePath === null ? undefined : this.documents.get(this.activePath)
    if (active !== undefined) active.viewState = editor.saveViewState()
    this.editor = null
    editor.setModel(null)
  }

  /** F1：记录工作根（绝对 file URI 的前缀）。切根时旧 URI 全部作废，关闭所有文档。 */
  setWorkspaceRoot (root: string | null): void {
    if (this.workspaceRootPath === root) return
    this.workspaceRootPath = root
    for (const path of [...this.documents.keys()]) this.close(path, true)
    this.activePath = null
    // 代号 +1：prepare 于旧工作区的命令一律失效。少了这一步，一条旧命令会去写
    // 新工程里同名的那个文件（两个插件工程都有 workflows/dispatch.json 是常态）。
    this.epoch += 1
    this.commandHistory.length = 0
    this.emit('workspace')
  }

  get workspaceRoot (): string | null {
    return this.workspaceRootPath
  }

  onDidChange (listener: DocumentsListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 发一次变更通知。
   *
   * ⚠️ 批量中（applyPrepared 内）**不立刻发**，只累积路径：跨文件命令必须只发一个事件。
   * 既有调用方 `emit()` 不带参数，落到 reason='edit' 这一档，行为与从前一致。
   */
  private emit (reason: DocumentBatchEvent['reason'] = 'edit', paths: readonly string[] = []): void {
    if (this.batchDepth > 0) {
      for (const path of paths) this.batchPaths.add(path)
      return
    }
    const event: DocumentBatchEvent = {
      reason,
      paths: [...paths],
      ...(this.batchCommandKind === undefined ? {} : { commandKind: this.batchCommandKind }),
      workspaceEpoch: this.epoch,
    }
    for (const listener of this.listeners) listener(event)
  }

  /** 当前工作区代号（命令前置核验用）。 */
  get workspaceEpoch (): number {
    return this.epoch
  }

  /** 某个文档当前的内容代号；未打开时 undefined。 */
  generationOf (path: string): number | undefined {
    return this.documents.get(path)?.generation
  }

  /** 结构化命令历史（最新在后）。切工作区时清空。 */
  get history (): readonly CommandHistoryEntry[] {
    return this.commandHistory
  }

  /**
   * 取一组路径在**此刻**的快照 —— 保存计划要基于一次固定的输入字节集来算，
   * 而不是边写边读（边写边读会让「检查过的内容」与「真正落盘的内容」不是一份）。
   */
  snapshot (paths: readonly string[]): readonly DocumentSnapshot[] {
    return paths.map((path) => {
      const document = this.documents.get(path)
      if (document === undefined) {
        return {
          path,
          content: null,
          generation: 0,
          existsOnDisk: false,
          pendingDelete: false,
          dirty: false,
          conflicted: false,
        }
      }
      return {
        path,
        content: document.model.getValue(),
        generation: document.generation,
        existsOnDisk: document.existsOnDisk,
        pendingDelete: document.pendingDelete === true,
        dirty: this.isDirty(path),
        conflicted: document.conflict !== null,
        ...(document.savedRevision === undefined ? {} : { expectedRevision: document.savedRevision }),
      }
    })
  }

  get openPaths (): readonly string[] {
    return [...this.documents.keys()]
  }

  get tabPaths (): readonly string[] {
    return [...this.documents.values()].filter(document => document.tabOpen).map(document => document.path)
  }

  get active (): string | null {
    return this.activePath
  }

  has (path: string): boolean {
    return this.documents.has(path)
  }

  isDirty (path: string): boolean {
    const document = this.documents.get(path)
    if (document === undefined) return false
    return document.model.getValue() !== document.savedContent
  }

  get hasDirty (): boolean {
    return this.openPaths.some(path => this.isDirty(path))
  }

  /**
   * 保存计划的范围（DAG-016-01）：tab 里的文档 ∪ 没有 tab 但 dirty 的 model。
   * Inspector 的脚本编辑器经 acquireModel 持有 model（W1 引用计数、不开 tab），
   * 用户在里面改的内容若只按 tabPaths 收计划就会**静默丢改**——保存链路本身
   * 是通的（fsCreate/write 都正常），只是计划范围漏了这批文档。
   */
  get saveablePaths (): string[] {
    const paths = [...this.tabPaths]
    for (const path of this.documents.keys()) {
      if (!paths.includes(path) && this.isDirty(path)) paths.push(path)
    }
    return paths
  }

  /**
   * 用户是否做过（内容上可能已不可见的）编辑：undo 栈里还有基线之后的编辑史。
   * watcher 对这种文档不得静默重灌——内容判据说 clean，但重灌会清掉 undo 栈
   * 与光标（DAG-014-01）。内容相等路径的基线对齐**不**推进 savedVersionId，
   * 正是为了保住这个信号。
   */
  hasUndoHistory (path: string): boolean {
    const document = this.documents.get(path)
    if (document === undefined) return false
    return document.model.getAlternativeVersionId() !== document.savedVersionId
  }

  get hasConflict (): boolean {
    return this.openPaths.some(path => this.documents.get(path)?.conflict !== null)
  }

  contentOf (path: string): string | null {
    return this.documents.get(path)?.model.getValue() ?? null
  }

  modelVersion (path: string): number | undefined {
    return this.documents.get(path)?.model.getVersionId()
  }

  modelIdentity (path: string): unknown {
    return this.documents.get(path)?.model
  }

  /** 一次画布操作成为一次可撤销编辑；版本不符时不覆盖较新的源码。 */
  applyEdit (path: string, content: string, expectedVersion: number): boolean {
    const document = this.documents.get(path)
    if (document === undefined || document.model.getVersionId() !== expectedVersion || document.conflict !== null) return false
    if (document.model.getValue() === content) return true
    document.model.pushStackElement()
    document.model.pushEditOperations([], [{ range: document.model.getFullModelRange(), text: content }], () => null)
    document.model.pushStackElement()
    return true
  }

  /**
   * 原子应用一条已算好的命令（C1 的 `applyPrepared`）—— `applyEdit` 的**兄弟方法**。
   *
   * ★★ 与 `applyEdit` 的分工，刻意不合并：
   *   applyEdit      单文件、整内容替换。给「Monaco 里用户自己敲字」与外部回灌用。
   *   applyPrepared  多文件、按 offset 的**最小区间编辑**。给画布/检查器的结构化命令用。
   * 把 applyEdit 做成 applyPrepared 的特例，等于让「用户敲一个字」也要先构造一条命令 ——
   * 那是不必要的返工，而且 Monaco 的输入路径本来就不经过我们。
   *
   * ── 三条硬性质（计划 §D2）───────────────────────────────────────
   * ① **同步**：全程没有 await。核验通过之后到写完之间不存在让用户输入插进来的窗口。
   * ② **前置失效时零修改**：先核验全部文件，再动第一个字节。
   * ③ **只发一个事件**：跨文件也只发一次（见 DocumentBatchEvent 的 ★★）。
   */
  applyPrepared (command: PreparedCommand): ApplyResult {
    // ── 核验：全部通过才动手 ──
    if (command.expected.workspaceEpoch !== this.epoch) {
      return { ok: false, code: 'stale', reason: '工作区已切换，这条操作是针对上一个工程算出来的。' }
    }
    for (const expected of command.expected.documents) {
      const document = this.documents.get(expected.path)
      if (document === undefined) {
        return { ok: false, code: 'stale', reason: `${expected.path} 已不在编辑器中打开，请重试。` }
      }
      if (document.conflict !== null) {
        return { ok: false, code: 'conflict', reason: `${expected.path} 与磁盘存在冲突，请先解决冲突。` }
      }
      if (document.generation !== expected.generation) {
        return { ok: false, code: 'stale', reason: `${expected.path} 在这次操作算好之后又被改过，请重试。` }
      }
    }
    // 新建类编辑的目标不该已经存在：否则这条命令会悄悄盖掉一个已有文件。
    for (const edit of command.edits) {
      if (edit.kind === 'create' && this.documents.has(edit.path)) {
        return { ok: false, code: 'stale', reason: `${edit.path} 已存在，不能按「新建」写入。` }
      }
      if ((edit.kind === 'modify' || edit.kind === 'replace' || edit.kind === 'delete')
        && !this.documents.has(edit.path)) {
        return { ok: false, code: 'invalid', reason: `${edit.path} 未打开，无法修改。` }
      }
    }

    // 预先把 JSON 编辑算成文本区间：算的过程可能抛（路径解析不出来），
    // 而那必须在**动第一个字节之前**发生，否则就成了「改了一半」。
    const planned: { document: OpenDocument; edits: monaco.editor.IIdentifiedSingleEditOperation[] }[] = []
    for (const edit of command.edits) {
      if (edit.kind !== 'modify') continue
      const document = this.documents.get(edit.path)!
      // ⚠️ 必须先判「这份文本解析得开吗」：jsonc-parser 的 modify 对解析不开的文本
      // **回空编辑而不报错**，于是跨文件命令会静默只写成功的那一半。
      if (!canEditJson(document.model.getValue())) {
        return {
          ok: false,
          code: 'invalid',
          reason: `${edit.path} 当前不是合法 JSON，无法结构化修改（请先修好语法错误）。`,
        }
      }
      try {
        planned.push({ document, edits: this.toModelEdits(document.model, edit.ops) })
      } catch (error) {
        return {
          ok: false,
          code: 'invalid',
          reason: `${edit.path} 的编辑算不出来：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }

    // ── 落地：进入批量，事件只发一次 ──
    this.batchDepth += 1
    this.batchCommandKind = command.kind
    const touched: string[] = []
    try {
      let plannedIndex = 0
      for (const edit of command.edits) {
        touched.push(edit.path)
        switch (edit.kind) {
          case 'modify': {
            const entry = planned[plannedIndex]
            plannedIndex += 1
            if (entry === undefined || entry.edits.length === 0) break
            // pushStackElement 前后各一次：这次命令在 Monaco 里是**一步**撤销。
            entry.document.model.pushStackElement()
            entry.document.model.pushEditOperations([], entry.edits, () => null)
            entry.document.model.pushStackElement()
            break
          }
          case 'replace': {
            const document = this.documents.get(edit.path)!
            if (document.model.getValue() === edit.content) break
            document.model.pushStackElement()
            document.model.pushEditOperations(
              [],
              [{ range: document.model.getFullModelRange(), text: edit.content }],
              () => null,
            )
            document.model.pushStackElement()
            break
          }
          case 'create': {
            // 虚拟文件：基线留空、内容经一次编辑推到位，于是 dirty=true。
            // 直接把基线设成新内容会让它看起来「已保存」，用户关掉就丢了。
            this.openUnsaved(edit.path, edit.content)
            break
          }
          case 'delete': {
            const document = this.documents.get(edit.path)!
            document.pendingDelete = true
            break
          }
        }
      }
      this.commandHistory.push({
        kind: command.kind,
        label: command.label,
        paths: [...new Set(touched)].sort(),
        generations: [...new Set(touched)].sort()
          .map(path => ({ path, generation: this.documents.get(path)?.generation ?? 0 })),
      })
      if (this.commandHistory.length > MAX_COMMAND_HISTORY) this.commandHistory.shift()
    } finally {
      this.batchDepth -= 1
      const paths = [...new Set([...this.batchPaths, ...touched])].sort()
      this.batchPaths.clear()
      this.emit('command', paths)
      this.batchCommandKind = undefined
    }
    return { ok: true }
  }

  /**
   * 一组 JSON 编辑 → 一条 Monaco 区间编辑。
   *
   * ★ 用区间而不是 `setValue`/整份替换，是「最小编辑」在编辑器侧的落点：
   * 撤销栈保住、光标不跳、其他视图里的 decoration 不失效。
   *
   * 做法是「先算出最终文本，再取与当前文本的最小差异区间」而不是「把每条 offset
   * 逐个换算成 Range」：
   *   ⚠️ 逐条换算要自己维护前面编辑造成的偏移，而那正是最容易错、错了又很隐蔽的地方
   *     （错位的表现是内容被写到相邻位置，JSON 仍然合法）。
   *   ⓘ 代价：一条命令改了同一文件里相距很远的两处时，差异区间会把中间那段也覆盖进去。
   *     那仍然远小于整份替换，且撤销仍是一步 —— 这个取舍是明知的。
   */
  private toModelEdits (
    model: monaco.editor.ITextModel,
    ops: readonly JsonEditOp[],
  ): monaco.editor.IIdentifiedSingleEditOperation[] {
    const before = model.getValue()
    let text = before
    for (const op of ops) text = applyJsonEditOp(text, op)
    if (text === before) return []

    const diff = minimalDiffRange(before, text)
    return [{
      range: monaco.Range.fromPositions(
        model.getPositionAt(diff.start),
        model.getPositionAt(diff.endBefore),
      ),
      text: diff.inserted,
    }]
  }

  /** 磁盘基线 revision；未知（重命名跟随等场景）时由保存流程先读取。 */
  expectedRevision (path: string): string | undefined {
    return this.documents.get(path)?.savedRevision
  }

  conflictOf (path: string): DocumentConflict | null {
    return this.documents.get(path)?.conflict ?? null
  }

  conflictedPaths (): readonly string[] {
    return this.openPaths.filter(path => this.documents.get(path)?.conflict !== null)
  }

  /**
   * F1：引用计数获取 model。同一 session 同一路径只有一个 Monaco model；
   * 主编辑器与 Workflow 脚本编辑器 acquire 同一实例，最后消费者 release 时才销毁。
   */
  acquireModel (path: string, content: string): { model: monaco.editor.ITextModel; release: () => void } {
    let document = this.documents.get(path)
    if (document === undefined) {
      const model = monaco.editor.createModel(content, languageOf(path), this.uriFor(path))
      document = {
        path,
        model,
        savedContent: content,
        savedVersionId: model.getAlternativeVersionId(),
        conflict: null,
        viewState: null,
        refCount: 0,
        generation: (this.changeSeq += 1),
        existsOnDisk: true,
      }
      this.documents.set(path, document)
      this.track(document)
    }
    document.refCount += 1
    let released = false
    return {
      model: document.model,
      release: () => {
        if (released) return
        released = true
        const current = this.documents.get(path)
        if (current !== document) {
          document.refCount -= 1
          if (document.refCount <= 0) document.model.dispose()
          return
        }
        current.refCount -= 1
        if (current.refCount <= 0 && !current.tabOpen && !this.isDirty(path) && current.conflict === null) this.close(path)
      },
    }
  }

  /**
   * 挂内容监听：**每次内容变化都推进 generation**，再发事件。
   *
   * ★ 顺序要紧：先推代号后发事件。反过来的话，监听者在事件里读到的还是旧代号，
   * 它据此算出的命令前置会一落地就失效。
   */
  private track (document: OpenDocument): void {
    this.disposables.set(document.path, document.model.onDidChangeContent(() => {
      document.generation = (this.changeSeq += 1)
      this.emit('edit', [document.path])
    }))
  }

  private uriFor (path: string): monaco.Uri {
    return this.workspaceRootPath === null ? pathToUri(path) : workspacePathToUri(this.workspaceRootPath, path)
  }

  /**
   * 打开但**不激活 tab**（P2-3：画布加载依赖文件用）。
   *
   * ★ 不抢主编辑器的当前文件：检查器里挂脚本源码时，用户在主编辑器里
   *   正在看的那份内容不该被切走。tab 不出现；后续「在主编辑器打开」
   *   经 activate 正常接管（activate 不看 tabOpen）。
   */
  openDetached (path: string, content: string, revision?: string): void {
    if (this.documents.has(path)) return
    const model = monaco.editor.createModel(content, languageOf(path), this.uriFor(path))
    const document: OpenDocument = {
      path,
      model,
      savedContent: content,
      savedVersionId: model.getAlternativeVersionId(),
      conflict: null,
      viewState: null,
      refCount: 0,
      generation: (this.changeSeq += 1),
      existsOnDisk: true,
      tabOpen: false,
    }
    if (revision !== undefined) document.savedRevision = revision
    this.documents.set(path, document)
    this.track(document)
    this.emit()
  }

  /** 打开（已打开则复用，不覆盖用户正在编辑的内容）；revision 为读取回包的磁盘 revision。 */
  open (path: string, content: string, revision?: string): void {
    let document = this.documents.get(path)
    if (document === undefined) {
      const model = monaco.editor.createModel(content, languageOf(path), this.uriFor(path))
      document = {
        path,
        model,
        savedContent: content,
        savedVersionId: model.getAlternativeVersionId(),
        conflict: null,
        viewState: null,
        refCount: 0,
        generation: (this.changeSeq += 1),
        existsOnDisk: true,
      }
      if (revision !== undefined) document.savedRevision = revision
      this.documents.set(path, document)
      this.track(document)
    }
    document.tabOpen = true
    this.activate(path)
  }

  /**
   * 打开一个「内容已改但尚未落盘」的文档（重命名跟随场景）：
   * 基线留在空内容、内容经一次编辑推到位，因此 dirty=true ——
   * 直接 `open(path, content)` 会把基线设到编辑后内容，脏标记丢失，
   * 用户关 tab 时编辑会被静默丢弃。
   */
  openUnsaved (path: string, content: string): void {
    if (this.documents.has(path)) {
      this.activate(path)
      return
    }
    const model = monaco.editor.createModel('', languageOf(path), this.uriFor(path))
    const document: OpenDocument = {
      path,
      model,
      savedContent: '',
      savedVersionId: model.getAlternativeVersionId(),
      conflict: null,
      viewState: null,
      refCount: 0,
      generation: (this.changeSeq += 1),
      // 重命名跟随：目标路径此刻磁盘上还没有，保存时要走「新建」而不是「覆盖」。
      existsOnDisk: false,
    }
    this.documents.set(path, document)
    this.track(document)
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: content }],
      () => null,
    )
    // ★ 必须开 tab：这类文档是 dirty 且**磁盘上还没有**的（重命名跟随的目标、
    //   画布新建的脚本）。没有 tab 的话它在标签栏里不存在 —— 用户切走就再也回不来，
    //   而它又是 dirty 的，于是那份内容会被静默丢掉。
    document.tabOpen = true
    this.activate(path)
  }

  activate (path: string): void {
    const next = this.documents.get(path)
    if (next === undefined) return
    next.tabOpen = true
    const editor = this.editor
    if (editor !== null) {
      const current = this.activePath === null ? undefined : this.documents.get(this.activePath)
      if (current !== undefined) current.viewState = editor.saveViewState()
      editor.setModel(next.model)
      if (next.viewState !== null) editor.restoreViewState(next.viewState)
      editor.focus()
    }
    this.activePath = path
    this.emit()
  }

  /** 磁盘 rename 成功后迁移内容和基线，旧 model 等最后持有者释放。 */
  remap (from: string, to: string): readonly { from: string; to: string }[] {
    const inside = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`)
    const entries = [...this.documents.values()]
    const active = this.activePath
    if (this.editor !== null && active !== null) {
      const current = this.documents.get(active)
      if (current !== undefined) current.viewState = this.editor.saveViewState()
      this.editor.setModel(null)
    }
    const snapshots = entries.filter(document => inside(document.path, from)).map(document => ({
      document,
      content: document.model.getValue(),
      dirty: this.isDirty(document.path),
      path: `${to}${document.path.slice(from.length)}`,
    }))
    for (const document of entries) {
      if (!inside(document.path, from) && !inside(document.path, to)) continue
      this.disposables.get(document.path)?.dispose()
      this.disposables.delete(document.path)
      this.documents.delete(document.path)
      if (document.refCount <= 0) document.model.dispose()
    }
    const moved = new Map<string, OpenDocument>()
    for (const snapshot of snapshots) {
      const retained = entries.find(document => document.path === snapshot.path && document.refCount > 0)
      const model = retained?.model ?? monaco.editor.createModel(snapshot.content, languageOf(snapshot.path), this.uriFor(snapshot.path))
      if (retained !== undefined) model.setValue(snapshot.content)
      const next: OpenDocument = retained === undefined
        ? { ...snapshot.document, path: snapshot.path, model, refCount: 0, generation: (this.changeSeq += 1) }
        : Object.assign(retained, { savedContent: snapshot.document.savedContent, savedRevision: snapshot.document.savedRevision, conflict: snapshot.document.conflict, viewState: snapshot.document.viewState, tabOpen: snapshot.document.tabOpen, generation: (this.changeSeq += 1), existsOnDisk: snapshot.document.existsOnDisk })
      moved.set(snapshot.document.path, next)
      this.track(next)
    }
    const remaining = new Map(this.documents)
    this.documents.clear()
    for (const document of entries) {
      const next = moved.get(document.path) ?? remaining.get(document.path)
      if (next !== undefined) this.documents.set(next.path, next)
    }
    this.activePath = active === null
      ? null
      : moved.get(active)?.path
        ?? (this.documents.has(active) ? active : this.tabPaths.at(-1) ?? null)
    const current = this.activePath === null ? undefined : this.documents.get(this.activePath)
    this.editor?.setModel(current?.model ?? null)
    if (current?.viewState != null) this.editor?.restoreViewState(current.viewState)
    this.emit('disk', snapshots.map(snapshot => snapshot.path))
    return snapshots.filter(snapshot => snapshot.dirty).map(snapshot => ({ from: snapshot.document.path, to: snapshot.path }))
  }

  /**
   * F3：保存成功后推进磁盘基线。仅当提交内容仍是当前内容时才清 dirty；
   * 保存期间继续输入（model 值 !== content）仍是 dirty，乱序回包不能推进到错误基线。
   */
  markSaved (path: string, content: string, revision: string): void {
    const document = this.documents.get(path)
    if (document === undefined) return
    document.savedContent = content
    document.savedVersionId = document.model.getAlternativeVersionId()
    document.savedRevision = revision
    // create 成功也是落盘成功：推进 existsOnDisk，否则下一次保存仍计划 create 并撞 FH2_IDE_ALREADY_EXISTS。
    document.existsOnDisk = true
    // 本地内容与磁盘一致时冲突自然解除；不一致保留冲突由用户选择。
    if (document.model.getValue() === content) document.conflict = null
    this.emit()
  }

  /** 重命名跟随等场景：内容已落盘但 revision 未知，保存前需先读取。 */
  markSavedContentOnly (path: string, content: string): void {
    const document = this.documents.get(path)
    if (document === undefined) return
    document.savedContent = content
    document.savedVersionId = document.model.getAlternativeVersionId()
    document.savedRevision = undefined
    this.emit()
  } /** F3/F4：进入冲突态（外部修改 + 本地 dirty）。 */

  enterConflict (path: string, conflict: DocumentConflict): void {
    const document = this.documents.get(path)
    if (document === undefined) return
    if (document.model.getValue() === conflict.diskContent) {
      // 本地内容与磁盘一致：直接对齐基线，无需冲突。
      document.savedContent = conflict.diskContent
      document.savedRevision = conflict.diskRevision
      document.conflict = null
      this.emit()
      return
    }
    document.conflict = conflict
    this.emit()
  }

  /**
   * 磁盘上的文件已被外删（DAG-017-09）：文档保持打开、内容原样（dirty 不变），
   * 只把 existsOnDisk 翻成 false —— 下一次保存按「新建」计划重建文件。
   * ⚠️ 不进恢复对话框：那个模态窗不可关闭，会挡住外删后的全部后续操作；
   * 「不自动复活文件」指不主动写盘，用户主动保存才重建。
   */
  markAbsentFromDisk (path: string): void {
    const document = this.documents.get(path)
    if (document === undefined || !document.existsOnDisk) return
    document.existsOnDisk = false
    this.emit()
  }

  /** F4：采用磁盘——model 重灌为磁盘内容，基线对齐。 */
  takeDisk (path: string): void {
    const document = this.documents.get(path)
    if (document === undefined || document.conflict === null) return
    const { diskContent, diskRevision } = document.conflict
    this.reloadFromDisk(path, diskContent, diskRevision)
  }

  /** F4：保留本地——基线 revision 对齐冲突快照，下一次保存即用户确认的覆盖写。 */
  keepLocal (path: string): void {
    const document = this.documents.get(path)
    if (document === undefined || document.conflict === null) return
    document.savedRevision = document.conflict.diskRevision
    document.conflict = null
    this.emit()
  }

  /** F4：另存副本/放弃冲突 UI 后清理冲突标记（不动内容）。 */
  clearConflict (path: string): void {
    const document = this.documents.get(path)
    if (document === undefined) return
    document.conflict = null
    this.emit()
  }

  /**
   * 磁盘内容回灌（SSE change 事件 / 采用磁盘）。用 `pushEditOperations` 全量替换
   * 而不是 `setValue`：setValue 会清空撤销栈，pushEditOperations 让这次外部变更
   * 本身也可撤销。
   */
  reloadFromDisk (path: string, content: string, revision?: string): void {
    const document = this.documents.get(path)
    if (document === undefined) return
    if (document.model.getValue() === content) {
      // 内容已一致：只对齐基线，不产生多余撤销步骤，也不发多余事件。
      const changed = document.savedContent !== content || document.conflict !== null
      document.savedContent = content
      if (revision !== undefined) document.savedRevision = revision
      document.conflict = null
      if (changed) this.emit()
      return
    }
    document.model.pushEditOperations(
      [],
      [{ range: document.model.getFullModelRange(), text: content }],
      () => null,
    )
    document.savedContent = content
    document.savedVersionId = document.model.getAlternativeVersionId()
    if (revision !== undefined) document.savedRevision = revision
    document.conflict = null
    this.emit()
  }

  close (path: string, force = false): void {
    const document = this.documents.get(path)
    if (document === undefined) return
    document.tabOpen = false
    if (force || document.refCount <= 0) {
      this.disposables.get(path)?.dispose()
      this.disposables.delete(path)
      document.model.dispose()
      this.documents.delete(path)
    }
    if (this.activePath === path) {
      const fallback = this.tabPaths.at(-1) ?? null
      this.activePath = null
      if (fallback === null) this.editor?.setModel(null)
      else this.activate(fallback)
    }
    this.emit()
  }

  reveal (path: string, line: number, column: number): void {
    const document = this.documents.get(path)
    const editor = this.editor
    if (document === undefined || editor === null) return
    if (this.activePath !== path) this.activate(path)
    const position = { lineNumber: Math.max(1, line), column: Math.max(1, column) }
    editor.setSelection({
      startLineNumber: position.lineNumber,
      startColumn: position.column,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    })
    editor.revealLineInCenter(position.lineNumber)
    editor.focus()
  }
}

/**
 * 两份文本的最小差异区间：去掉公共前缀与公共后缀之后剩下的那一段。
 *
 * ⚠️ 前后缀都要按**码元**比，且后缀不能越过前缀（短文本整体被包含时会相撞），
 * 故下面用 `limit` 夹一次。不夹的话，`"ab" → "b"` 这类会算出负长度区间。
 */
export function minimalDiffRange (before: string, after: string): {
  readonly start: number;
  /** 在 `before` 中的结束位置（不含）。 */
  readonly endBefore: number;
  readonly inserted: string;
} {
  let start = 0
  const limit = Math.min(before.length, after.length)
  while (start < limit && before[start] === after[start]) start += 1

  let tail = 0
  while (
    tail < limit - start
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1
  }

  return {
    start,
    endBefore: before.length - tail,
    inserted: after.slice(start, after.length - tail),
  }
}
