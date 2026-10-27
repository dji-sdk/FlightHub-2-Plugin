// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 脚本节点的源码编辑器：在画布检查器里直接写 `run_script` 那份 .js / .ts。
 *
 * 用 Monaco 而不是 textarea：这份代码跑在 goja 运行时里（ES2015 语法与同步
 * 集合可用；没有事件循环 —— Promise / async / setTimeout 不会回调），IDE 已
 * 按 goja 实测校准了兜底诊断档（见 editor/monaco-setup.ts 的
 * applyGojaTypeScriptDefaults）—— 写 `new Promise` 当场红线，写 `new Map()`
 * 不再吃 ES5 时代的假红线。LSP 在线时以项目 tsconfig 为准（create 模板的
 * backend tsconfig 同样无 DOM lib）。
 *
 * ⚠️ 它编辑的是**真实文件**（scripts[].path 指向的那个 .js），不是画布里的游离文本：
 * worker 按 path 装载，只存在画布里的源码发布期一定是「脚本未注册」。
 *
 * W1（单模型）：model 由 DocumentStore 统一持有（绝对 file URI、引用计数），
 * 与主编辑器共享同一份内容/撤销栈/dirty/保存/冲突模型 —— 不再有独立的
 * `fh2-script://` URI，也不再独立 debounce 写盘；保存走统一的 Save All / 保存动作。
 */

import * as monaco from 'monaco-editor'

export interface ScriptEditorCallbacks {
  /** 请求在主编辑器里打开这份文件（复杂改动去那边做更顺手）。 */
  readonly onOpenInEditor: () => void;
}

export class ScriptSourceEditor {
  private readonly host: HTMLElement
  private readonly callbacks: ScriptEditorCallbacks
  private editor: monaco.editor.IStandaloneCodeEditor | null = null

  constructor (host: HTMLElement, callbacks: ScriptEditorCallbacks) {
    this.host = host
    this.callbacks = callbacks
  }

  /**
   * 挂载/切换到某份脚本文件。
   *
   * model 来自 DocumentStore（同一路径只有一个 Monaco model）：切走再切回来时
   * 撤销历史还在，主编辑器打开同一文件看到的是同一份内容与 dirty 状态。
   */
  mount (model: monaco.editor.ITextModel): void {
    if (this.editor === null) {
      this.editor = monaco.editor.create(this.host, {
        model,
        theme: 'vs-dark',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 12,
        tabSize: 2,
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        folding: false,
        // 检查器很窄，横向滚动比换行好读（代码有缩进语义）
        wordWrap: 'off',
        scrollbar: { vertical: 'auto', horizontal: 'auto', verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      })
    } else {
      this.editor.setModel(model)
    }
  }

  /** 把编辑器从 DOM 上摘掉（切到非脚本节点时）。model 归 DocumentStore，不在此销毁。 */
  dispose (): void {
    this.editor?.dispose()
    this.editor = null
  }

  get openInEditor (): () => void {
    return this.callbacks.onOpenInEditor
  }
}
