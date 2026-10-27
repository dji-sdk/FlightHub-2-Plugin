<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEventListener, useResizeObserver } from '@vueuse/core'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRunStore } from '../../stores/run'
import { useUiStore } from '../../stores/ui'
import { useWorkspaceStore } from '../../stores/workspace'
import { useIdeContext } from '../../composables/use-ide'
import type { RunLogLine } from '../../stores/run'
import { parseTerminalFileLocations } from './terminal-links'

/**
 * 运行日志终端：xterm 流式渲染 run store 的日志行。
 *
 * 同步策略（防抖动）：
 * - 稳态纯增量写入（slice(written)），不做整屏重写。
 * - 仅四种情况整屏重写：filter 切换、已渲染的行不再是缓冲前缀、clear、空态 hint 迁移
 *   （hint 只在 visible 为空时写，首条真实日志到达即整屏重写清除——
 *   不能让「暂无输出」永久驻留缓冲顶部）。
 * - follow 只认用户真实滚动：scrollToBottom 自身的滚动事件置
 *   programmaticScroll 抑制，避免启动期日志爆发时异步解析中途触发的
 *   onScroll 误判成「用户上翻」导致视口滞留顶部抖动。
 * - fit 在容器 0 尺寸（pane 隐藏）时跳过，等 ResizeObserver 在可见时补。
 */

const run = useRunStore()
const ui = useUiStore()
const workspace = useWorkspaceStore()
const ide = useIdeContext()
const host = ref<HTMLElement | null>(null)

const MODE_COLOR: Readonly<Record<'dev' | 'preview', string>> = {
  dev: '#8a8a8a',
  preview: '#c9a0ff',
}

let term: Terminal | null = null
let fit: FitAddon | null = null
/** 已写进终端的可见行数（用于增量写入）。 */
let written = 0
let rendered: readonly RunLogLine[] = []
let writeSequence = 0
let lastFilter: string | null = 'unset'
let hintWritten = false
let follow = true
/** scrollToBottom 触发的滚动不算用户上翻。 */
let programmaticScroll = false
let userScrollUntil = 0

function reset (): void {
  programmaticScroll = true
  term?.reset()
  programmaticScroll = false
  written = 0
  hintWritten = false
  rendered = []
}

function canFit (): boolean {
  return host.value !== null && host.value.clientWidth !== 0 && host.value.clientHeight !== 0
}

function writeLine (line: RunLogLine): void {
  if (term === null) return
  const tag = run.filter === null ? `\x1B[38;2;${hexToAnsi(MODE_COLOR[line.mode])}m${line.mode}\x1B[0m ` : ''
  const text = line.stream === 'stderr'
    ? `\x1B[38;2;244;135;113m${line.text}\x1B[0m`
    : line.text
  term.write(`${tag}${text}\r\n`)
}

function hexToAnsi (hex: string): string {
  const value = hex.replace('#', '')
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  return `${r};${g};${b}`
}

function scrollToBottom (): void {
  if (term === null) return
  programmaticScroll = true
  term.scrollToBottom()
  // xterm 的 onScroll 同步派发，调用返回后即可解除程序性滚动标记。
  programmaticScroll = false
}

function render (): void {
  if (term === null) return
  const visible = run.visibleLines
  const filterChanged = lastFilter !== run.filter
  const changedPrefix = rendered.length > visible.length || rendered.some((line, index) => line !== visible[index])
  const viewport = term.buffer.active.viewportY
  const shouldReset = filterChanged || changedPrefix || (hintWritten && visible.length > 0)
  if (shouldReset) reset()
  lastFilter = run.filter

  if (visible.length === 0 && written === 0) {
    if (!hintWritten) {
      hintWritten = true
      term.write('\x1B[38;2;138;138;138m暂无输出。启动 dev 或 preview 后，进程日志会出现在这里。\x1B[0m\r\n')
    }
    return
  }
  const appended = visible.slice(written)
  for (const line of appended) writeLine(line)
  written = visible.length
  rendered = [...visible]
  const sequence = ++writeSequence
  // xterm 异步解析 write：等本批真正写入后定位，而不是先滚到旧 buffer 的底部。
  if (appended.length > 0) {
    term.write('', () => {
      // xterm6的视口滚动范围在渲染帧同步，解析回调时范围可能还是旧值。
      window.requestAnimationFrame(() => {
        if (term === null || sequence !== writeSequence) return
        if (follow) scrollToBottom()
        else if (shouldReset) term.scrollToLine(viewport)
      })
    })
  }
}

onMounted(() => {
  if (host.value === null) return
  term = new Terminal({
    convertEol: false,
    scrollback: 5000,
    fontSize: 12,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: '#1e1e1e',
      foreground: '#cccccc',
      cursor: '#cccccc',
      selectionBackground: '#264f78',
    },
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host.value)
  term.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      if (term === null) return callback(undefined)
      const text = term.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true) ?? ''
      const links = parseTerminalFileLocations(text, workspace.info?.root ?? '').map(location => ({
        text: location.text,
        range: {
          start: { x: location.start + 1, y: bufferLineNumber },
          end: { x: location.start + location.text.length, y: bufferLineNumber },
        },
        decorations: { pointerCursor: true, underline: true },
        activate: (event: MouseEvent) => {
          if (event.detail >= 2) void ide.jumpTo(location.path, location.line, location.column)
        },
      }))
      callback(links.length === 0 ? undefined : links)
    },
  })
  // pane 隐藏时容器 0 尺寸，fit 会算出垃圾列宽；可见后由 ResizeObserver 补
  if (canFit()) fit.fit()
  // 用户往上翻就停自动跟随，滚回底部再恢复（程序性滚动不算）
  term.onScroll(() => {
    if (term === null) return
    const buffer = term.buffer.active
    // xterm6解析/范围同步也会移动视口；只在用户滚轮、滚动条或按键后读取跟随状态。
    if (programmaticScroll || Date.now() > userScrollUntil) return
    follow = buffer.viewportY >= buffer.baseY
  })

  render()
})

watch(() => [run.visibleLines, run.filter] as const, () => render())

useEventListener(host, ['wheel', 'pointerdown', 'pointermove', 'keydown'], (event) => {
  if ('buttons' in event && event.buttons === 0) return
  userScrollUntil = Date.now() + 500
})

useResizeObserver(host, () => {
  // 面板切走时容器 display:none，尺寸为 0 不能 fit
  if (!canFit()) return
  fit?.fit()
})

onBeforeUnmount(() => {
  writeSequence += 1
  term?.dispose()
  term = null
})

useEventListener(window, 'resize', () => {
  if (!canFit()) return
  fit?.fit()
})
</script>

<template>
  <div class="run-pane panel-pane" :class="[{ active: ui.panelTab === 'run' }]">
    <div ref="host" class="run-terminal" />
  </div>
</template>
