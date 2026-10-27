// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { Ref } from 'vue'
import type { useDocumentsStore } from '../../stores/documents.js'
import type { useStatusStore } from '../../stores/status.js'
import type { ActionCatalog } from './catalog.js'
import { ScriptSourceEditor } from './script-source-editor.js'

/**
 * 检查器里的「JS 实现」页签：真实脚本文件的 Monaco 编辑器（W1 单模型）。
 *
 * ⓘ P0-5 之后本模块**不再有**新建脚本的旁路：新建业务功能统一走
 * CreateScriptFunction / CreateScriptAndBind 内存命令（见 store），失败时磁盘
 * 零修改。这里只负责挂载/释放源码编辑器。
 */
export function createWorkflowScripts (ports: {
  catalog: Readonly<Ref<ActionCatalog>>;
  documents: ReturnType<typeof useDocumentsStore>;
  status: ReturnType<typeof useStatusStore>;
  readFile: (path: string) => Promise<string>;
  openScriptSource: (path: string) => Promise<void>;
}) {
  const { catalog, documents, status, readFile, openScriptSource } = ports
  let scriptEditor: ScriptSourceEditor | null = null
  let scriptEditorRelease: (() => void) | null = null

  /**
   * 检查器里挂出脚本源码编辑器。编辑的是 `scripts[].path` 指向的真实文件 ——
   * worker 按 path 装载，只存在画布里的源码发布期一定是「脚本未注册」。
   */
  function mountScriptEditor (host: HTMLElement, scriptId: string): void {
    const script = catalog.value.scripts.find(item => item.id === scriptId)
    // ⚠️ 用 filePath 而不是 path：path 相对清单目录（worker 那套），
    // 而 /api/file 要的是工作区相对路径。两者在 backend/ 布局下差一层目录。
    const filePath = script?.filePath
    if (filePath === undefined) return

    // W1：同一路径只有一个 Monaco model —— 检查器重建前先释放旧引用。
    disposeScriptEditor()

    const editor = new ScriptSourceEditor(host, {
      onOpenInEditor: () => {
        if (filePath !== '') void openScriptSource(filePath)
      },
    })
    scriptEditor = editor

    void (async () => {
      if (documents.has(filePath)) {
        // 主编辑器已打开：直接复用同一 model（共享 dirty/撤销/冲突状态）。
        if (scriptEditor !== editor) return
        const acquired = documents.acquireModel(filePath, documents.contentOf(filePath) ?? '')
        editor.mount(acquired.model)
        scriptEditorRelease = acquired.release
        return
      }
      let source: string
      try {
        source = await readFile(filePath)
      } catch (error) {
        status.set(`读取 ${filePath} 失败：${describeError(error)}`, true)
        return
      }
      // 异步回来时用户可能已经切走了
      if (scriptEditor !== editor) return
      // W1：model 交给 DocumentStore（绝对 URI）；编辑经统一 dirty/保存/冲突模型落盘。
      const acquired = documents.acquireModel(filePath, source)
      scriptEditorRelease = acquired.release
      editor.mount(acquired.model)
    })()
  }

  /**
   * 释放源码编辑器（切节点 / 切工作流 / 组件卸载时都要走这里）。
   *
   * ⚠️ 旧版 watch 只在「换一个脚本」时经 mountScriptEditor 间接释放，
   * 切到非脚本节点（host 元素被 v-if 摘掉）时编辑器与 model 引用都留在
   * 闭包里 —— P2-4 起由 Inspector 显式调用。
   */
  function disposeScriptEditor (): void {
    scriptEditor?.dispose()
    scriptEditorRelease?.()
    scriptEditorRelease = null
    scriptEditor = null
  }

  return { mountScriptEditor, disposeScriptEditor }
}

function describeError (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
