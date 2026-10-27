// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { parseFsEvent, parseRunEvent, parseRunLogEvent, parseTaskEvent, parseWorkspaceEvent } from '../../../src/contracts/index.js'
import { ideApi } from './client.js'
import type { FsEvent, RunEvent, RunLogEvent, TaskEvent, WorkspaceEvent } from './types.js'

export type FsEventListener = (event: FsEvent) => void
export type WorkspaceEventListener = (event: WorkspaceEvent) => void
export type RunEventListener = (event: RunEvent) => void
export type RunLogListener = (event: RunLogEvent) => void
export type TaskEventListener = (event: TaskEvent) => void
export type ConnectionListener = (connected: boolean) => void

/**
 * SSE 订阅。EventSource 自带重连，但 serve 退出后它会无限重试；
 * 这里只把连接状态透出给状态栏，不额外造重连逻辑。
 *
 * 事件载荷的解析与版本校验统一走 Protocol：未知 schemaVersion 的事件会被
 * 丢弃（明确失败），不再静默按 v1 处理；kind 词表与 Serve 共用同一份。
 */
export class FsEventStream {
  private source: EventSource | null = null
  private readonly fsListeners = new Set<FsEventListener>()
  private readonly workspaceListeners = new Set<WorkspaceEventListener>()
  private readonly runListeners = new Set<RunEventListener>()
  private readonly runLogListeners = new Set<RunLogListener>()
  private readonly taskListeners = new Set<TaskEventListener>()
  private readonly connectionListeners = new Set<ConnectionListener>()

  onFsEvent (listener: FsEventListener): void {
    this.fsListeners.add(listener)
  }

  onWorkspaceEvent (listener: WorkspaceEventListener): void {
    this.workspaceListeners.add(listener)
  }

  onRunEvent (listener: RunEventListener): void {
    this.runListeners.add(listener)
  }

  onRunLog (listener: RunLogListener): void {
    this.runLogListeners.add(listener)
  }

  /** U1：任务事件（TaskEvent；sequence 由 store 按 taskId 去重）。返回退订函数。 */
  onTaskEvent (listener: TaskEventListener): () => void {
    this.taskListeners.add(listener)
    return () => {
      this.taskListeners.delete(listener)
    }
  }

  onConnectionChange (listener: ConnectionListener): void {
    this.connectionListeners.add(listener)
  }

  start (): void {
    if (this.source !== null) return
    const source = new EventSource(ideApi.eventsUrl())
    this.source = source

    source.addEventListener('open', () => this.emitConnection(true))
    source.addEventListener('error', () => this.emitConnection(false))
    source.addEventListener('ping', () => this.emitConnection(true))
    this.subscribe(source, 'fs', parseFsEvent, this.fsListeners)
    this.subscribe(source, 'workspace', parseWorkspaceEvent, this.workspaceListeners)
    this.subscribe(source, 'run', parseRunEvent, this.runListeners)
    this.subscribe(source, 'run-log', parseRunLogEvent, this.runLogListeners)
    this.subscribe(source, 'task', parseTaskEvent, this.taskListeners)
  }

  stop (): void {
    this.source?.close()
    this.source = null
    this.emitConnection(false)
  }

  private subscribe<T> (
    source: EventSource,
    name: string,
    parse: (value: unknown) => T | null,
    listeners: ReadonlySet<(event: T) => void>,
  ): void {
    source.addEventListener(name, (event) => {
      this.emitConnection(true)
      let payload: unknown
      try {
        payload = JSON.parse((event as MessageEvent<string>).data) as unknown
      } catch {
        return
      }
      const parsed = parse(payload)
      if (parsed === null) return
      for (const listener of listeners) listener(parsed)
    })
  }

  private emitConnection (connected: boolean): void {
    for (const listener of this.connectionListeners) listener(connected)
  }
}
