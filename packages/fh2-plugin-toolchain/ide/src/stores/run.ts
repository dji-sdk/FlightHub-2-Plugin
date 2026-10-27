// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { RunEvent, RunLogEvent, RunMode, RunProcess, RunStatus } from '../api/types.js'

/**
 * 运行日志缓冲上限。SSE 的 `run-log` 是无界流（dev server 的 HMR 刷屏很常见），
 * 不设上限迟早把标签页拖死 —— 超出就丢最旧的。
 */
const MAX_LOG_LINES = 2000

export const STATUS_LABEL: Readonly<Record<RunStatus, string>> = {
  starting: '启动中',
  running: '运行中',
  stopped: '已停止',
  failed: '失败',
}

export const MODE_LABEL: Readonly<Record<RunMode, string>> = {
  dev: '本地 Mock 宿主（dev）',
  preview: '司空前端预览（preview）',
}

export interface RunLogLine {
  readonly mode: RunMode;
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

/**
 * 运行 / 预览的进程状态与日志流。数据在这里，滚动与渲染行为在 UI 层。
 */
export const useRunStore = defineStore('run', () => {
  const processes = ref<readonly RunProcess[]>([])
  const lines = ref<readonly RunLogLine[]>([])
  /** 过滤器：null 表示两种模式都看。 */
  const filter = ref<RunMode | null>(null)
  const seenSequences = new Set<number>()
  /**
   * 历史累计 append 行数（去重后）：不受 MAX_LOG_LINES 裁剪影响，clear 时归零。
   * 终端用它精确检测「缓冲头部被裁掉」：headDropped = appendedCount - visible.length。
   */
  const appendedCount = ref(0)

  const activeProcesses = computed(() => processes.value.filter(process => process.status !== 'stopped'))
  const visibleLines = computed(() =>
    filter.value === null ? lines.value : lines.value.filter(line => line.mode === filter.value))

  function setProcesses (next: readonly RunProcess[]): void {
    processes.value = next
  }

  function statusOf (mode: RunMode): RunProcess | undefined {
    return processes.value.find(process => process.mode === mode)
  }

  /** 同一 mode 有进程且不是 stopped/failed，按钮显示「停止」。 */
  function isActive (mode: RunMode): boolean {
    const process = statusOf(mode)
    return process !== undefined && process.status !== 'stopped' && process.status !== 'failed'
  }

  function setFilter (next: RunMode | null): void {
    filter.value = next
  }

  function append (event: RunLogEvent): void {
    if (event.sequence !== undefined) {
      if (seenSequences.has(event.sequence)) return
      seenSequences.add(event.sequence)
    }
    // 一条 SSE 里可能裹了多行（进程输出按 chunk 切分），拆开存以便按行裁剪
    const added: RunLogLine[] = []
    for (const text of event.line.split('\n')) {
      added.push({ mode: event.mode, stream: event.stream, text })
    }
    const next = [...lines.value, ...added]
    lines.value = next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
    appendedCount.value += added.length
  }

  /** 本地注入一行（启停回执、错误），与进程日志混排在同一条时间线上。 */
  function note (mode: RunMode, text: string, isError = false): void {
    append({ schemaVersion: 1, mode, stream: isError ? 'stderr' : 'stdout', line: `» ${text}` })
  }

  function clear (): void {
    lines.value = []
    seenSequences.clear()
    appendedCount.value = 0
  }

  /** SSE run 事件 / 启停回执的合并：保留其他 mode 的进程，URL 与 since 尽量沿用旧值。 */
  function applyRunState (event: RunEvent): void {
    const others = processes.value.filter(process => process.mode !== event.mode)
    const previous = statusOf(event.mode)
    const url = event.url ?? previous?.url
    const projectPath = event.projectPath ?? previous?.projectPath
    const detail = event.detail ?? previous?.detail
    setProcesses([
      ...others,
      {
        mode: event.mode,
        status: event.status,
        ...(url === undefined ? {} : { url }),
        ...(projectPath === undefined ? {} : { projectPath }),
        ...(detail === undefined ? {} : { detail }),
        since: previous?.since ?? Date.now(),
      },
    ])
  }

  return {
    processes,
    lines,
    filter,
    appendedCount,
    activeProcesses,
    visibleLines,
    setProcesses,
    statusOf,
    isActive,
    setFilter,
    append,
    note,
    clear,
    applyRunState,
  }
})
