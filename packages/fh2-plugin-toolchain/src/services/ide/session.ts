// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { IdeRequestError } from '../../contracts/ide.js'

/** 工作区会话拥有受理门与切换顺序；HTTP、watcher、LSP 只提供适配回调。 */
export class IdeSessionService {
  private current: { root: string;id: string }

  private readonly writes = new Set<Promise<void>>()
  private switching = false
  constructor (root: string) {
    this.current = { root: resolve(root), id: randomUUID() }
  }

  snapshot (): Readonly<{ root: string;id: string }> {
    return this.current
  }

  assertCurrent (id: string): void {
    if (id !== this.current.id) throw new IdeRequestError('FH2_IDE_SESSION_EXPIRED', '工作区会话已过期。')
  }

  async accept<T> (id: string, operation: () => Promise<T>): Promise<T> {
    this.assertCurrent(id)
    if (this.switching) throw new IdeRequestError('FH2_IDE_PROCESS_RUNNING', '工作区正在切换。')
    let finish!: () => void
    const gate = new Promise<void>((resolveGate) => {
      finish = resolveGate
    })
    this.writes.add(gate)
    try {
      return await operation()
    } finally {
      finish()
      this.writes.delete(gate)
    }
  }

  async switchRoot (next: string, teardown: () => Promise<void>): Promise<void> {
    if (this.switching) throw new IdeRequestError('FH2_IDE_PROCESS_RUNNING', '工作区正在切换。')
    if (next === this.current.root) return
    this.switching = true
    try {
      await Promise.all([...this.writes])
      await teardown()
      this.current = { root: next, id: randomUUID() }
    } finally {
      this.switching = false
    }
  }
}
