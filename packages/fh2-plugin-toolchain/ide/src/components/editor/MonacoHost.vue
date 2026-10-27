<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import * as monaco from 'monaco-editor'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useIdeContext } from '../../composables/use-ide'
import { useDocumentsStore } from '../../stores/documents'
import { useSettingsStore } from '../../stores/settings'
import { useStatusStore } from '../../stores/status'

/**
 * Monaco 宿主：实例不进响应式系统（onMounted 创建 / onBeforeUnmount 销毁），
 * model 管理全部经 documents store（DocumentStore）；
 * 字号 / 自动换行跟随 settings store（活动栏设置弹窗写入）。
 */
const ide = useIdeContext()
const documents = useDocumentsStore()
const status = useStatusStore()
const settings = useSettingsStore()

const host = ref<HTMLElement | null>(null)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
const disposables: Array<{ dispose: () => void }> = []

// 每个 model 上一次观察到的错误数：只在「无错 → 有错」跳变时定位一次。
// 打字过程中的暂时错误会反复 0↔N 抖动，每次都抢滚动会把编辑器变成弹珠机。
const lastErrorCounts = new WeakMap<monaco.editor.ITextModel, number>()

onMounted(() => {
  if (host.value === null) return
  editor = monaco.editor.create(host.value, {
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: settings.fontSize,
    wordWrap: settings.wordWrap ? 'on' : 'off',
    tabSize: 2,
    insertSpaces: true,
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    'semanticHighlighting.enabled': true,
    fixedOverflowWidgets: true,
    // 自绘滚动条与全局 webkit 滚动条（10px thin 暗色）视觉对齐
    scrollbar: {
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      useShadows: false,
    },
    model: null,
  })
  documents.attach(editor)
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void ide.saveActive())
  editor.onDidChangeCursorPosition((event) => {
    status.setPosition(`行 ${event.position.lineNumber}，列 ${event.position.column}`)
  })
  // DAG-013-01：新错误出现在视口外时定位一次 —— 粘贴大段内容后首个非法行可能
  // 在几十行外，红线渲染是惰性的（视口内才画），不滚动的话「错在哪」全靠猜。
  disposables.push(monaco.editor.onDidChangeMarkers(() => {
    const model = editor?.getModel()
    if (editor === null || model === null || model === undefined) return
    const errors = monaco.editor.getModelMarkers({ resource: model.uri })
      .filter(marker => marker.severity === monaco.MarkerSeverity.Error)
    const previous = lastErrorCounts.get(model) ?? 0
    lastErrorCounts.set(model, errors.length)
    if (previous !== 0 || errors.length === 0) return
    const first = errors[0]!
    const inView = editor.getVisibleRanges()
      .some(range => range.containsPosition({ lineNumber: first.startLineNumber, column: first.startColumn }))
    // ScrollType 必须 Immediate：Smooth 的滚动动画会让 view-lines 在数百毫秒内持续
    // 重排，外部自动化（harness 的全选-粘贴序列）按元素稳定性点击会持续点空。
    if (inView !== true) editor.revealLineInCenter(first.startLineNumber, monaco.editor.ScrollType.Immediate)
  }))
})

watch(() => [settings.fontSize, settings.wordWrap] as const, ([fontSize, wordWrap]) => {
  editor?.updateOptions({ fontSize, wordWrap: wordWrap ? 'on' : 'off' })
})

onBeforeUnmount(() => {
  for (const disposable of disposables) disposable.dispose()
  if (editor !== null) documents.detach(editor)
  editor?.dispose()
  editor = null
})
</script>

<template>
  <div ref="host" class="editor" />
</template>
