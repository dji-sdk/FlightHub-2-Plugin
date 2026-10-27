// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ArtifactDescriptor, TaskEvent, TaskSnapshot, TaskState } from '../../../src/contracts/index.js'
import { ideApi } from '../api/client.js'

/**
 * U1：任务 store —— Build/Pack 的统一观察口。
 *
 * - SSE `task` 事件驱动：按 taskId 记录 lastSequence，重复/旧事件丢弃；
 * - 快照（拉取/受理回执）携带 lastSequence，比已见 sequence 旧的事件不回放；
 * - 日志按任务有界（尾部 300 行）；
 * - 断线重连：恢复时先 taskList 拉全量快照，再继续消费新事件。
 */
const LOG_LIMIT = 300
const KEEP_TERMINAL = 20

interface TaskEntry {
  snapshot: TaskSnapshot;
  logs: string[];
}

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
}

export const useTasksStore = defineStore('tasks', () => {
  let sessionId: string | undefined
  function setSession (session: string): void {
    sessionId = session
    reset()
  }
  /** taskId → 任务条目；插入序即最近优先展示序（最新在前由 computed 排序）。 */
  const entries = ref(new Map<string, TaskEntry>())

  const tasks = computed(() => [...entries.value.values()]
    .map(entry => entry.snapshot)
    .sort((left, right) => right.createdAt - left.createdAt))

  const activeTasks = computed(() => tasks.value.filter(task => task.state === 'queued' || task.state === 'running'))

  function applySnapshot (snapshot: TaskSnapshot, options: { readonly replaceLogs?: boolean } = {}): void {
    if (snapshot.workspaceSessionId !== undefined && sessionId !== undefined && snapshot.workspaceSessionId !== sessionId) return
    const existing = entries.value.get(snapshot.taskId)
    const next = new Map(entries.value)
    if (existing !== undefined && existing.snapshot.lastSequence > snapshot.lastSequence) {
      // 乱序快照（重连竞态）：不回退已见 sequence。
      return
    }
    next.set(snapshot.taskId, {
      snapshot,
      logs: options.replaceLogs === true ? boundedLogs([]) : boundedLogs(existing?.logs ?? []),
    })
    entries.value = next
    trimHistory(next)
  }

  /** SSE 事件入口：sequence 去重后合并进快照。 */
  function applyEvent (event: TaskEvent): void {
    if (event.workspaceSessionId !== undefined && sessionId !== undefined && event.workspaceSessionId !== sessionId) return
    const existing = entries.value.get(event.taskId)
    if (existing !== undefined && event.sequence <= existing.snapshot.lastSequence) return
    let snapshot: TaskSnapshot = existing?.snapshot === undefined
      ? {
          taskId: event.taskId,
          kind: event.kind ?? 'build',
          state: 'queued',
          createdAt: Date.now(),
          diagnostics: [],
          artifacts: [],
          lastSequence: event.sequence,
        }
      : { ...existing.snapshot, lastSequence: event.sequence }
    let logs = [...(existing?.logs ?? [])]
    switch (event.type) {
      case 'state':
        snapshot = { ...snapshot, state: event.state }
        break
      case 'diagnostic':
        snapshot = { ...snapshot, diagnostics: [...snapshot.diagnostics, event.diagnostic] }
        break
      case 'artifact':
        snapshot = {
          ...snapshot,
          artifacts: [...snapshot.artifacts.filter(artifact => artifact.id !== event.artifact.id), event.artifact],
        }
        break
      case 'log':
        logs = [...logs, `[${event.stream}] ${event.line}`]
        break
      case 'url':
        // Build/Pack 无 URL 事件；保留通道语义。
        break
    }
    const next = new Map(entries.value)
    next.set(event.taskId, { snapshot, logs: boundedLogs(logs) })
    entries.value = next
    trimHistory(next)
  }

  function logsOf (taskId: string): readonly string[] {
    return entries.value.get(taskId)?.logs ?? []
  }

  function artifactsOf (taskId: string): readonly ArtifactDescriptor[] {
    return entries.value.get(taskId)?.snapshot.artifacts ?? []
  }

  /** 断线重连/启动恢复：全量快照优先。 */
  async function refresh (reportFailure = false): Promise<void> {
    try {
      const current = sessionId
      const list = await ideApi.taskList()
      if (current !== sessionId) return
      for (const snapshot of list.tasks) applySnapshot(snapshot)
    } catch (error) {
      if (reportFailure) throw error
      // 拉取失败不打断 UI：SSE 事件会继续驱动。
    }
  }

  function reset (): void {
    entries.value = new Map()
  }

  function boundedLogs (logs: readonly string[]): string[] {
    if (logs.length <= LOG_LIMIT) return [...logs]
    return logs.slice(logs.length - LOG_LIMIT)
  }

  /** 只保留最近 KEEP_TERMINAL 条已终态任务 + 全部活跃任务。 */
  function trimHistory (map: Map<string, TaskEntry>): void {
    const terminal = [...map.values()]
      .filter(entry => entry.snapshot.state === 'succeeded' || entry.snapshot.state === 'failed' || entry.snapshot.state === 'cancelled')
      .sort((left, right) => right.snapshot.createdAt - left.snapshot.createdAt)
      .slice(KEEP_TERMINAL)
    for (const entry of terminal) map.delete(entry.snapshot.taskId)
  }

  return {
    setSession,
    entries,
    tasks,
    activeTasks,
    applySnapshot,
    applyEvent,
    logsOf,
    artifactsOf,
    refresh,
    reset,
  }
})
