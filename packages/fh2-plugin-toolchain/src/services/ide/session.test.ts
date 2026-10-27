// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { IdeSessionService } from './session.js'

function deferred () {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('iDE 会话受理与切换', () => {
  it('等待已受理写入及资源清理完成，之后才发布新 session', async () => {
    const sessions = new IdeSessionService('/old')
    const initial = sessions.snapshot()
    const write = deferred()
    const teardown = deferred()
    const accepted = sessions.accept(initial.id, () => write.promise)
    const switching = sessions.switchRoot('/new', () => teardown.promise)
    await expect(sessions.accept(initial.id, async () => {})).rejects.toMatchObject({ code: 'FH2_IDE_PROCESS_RUNNING' })
    expect(sessions.snapshot()).toEqual(initial)
    write.resolve()
    await accepted
    expect(sessions.snapshot()).toEqual(initial)
    teardown.resolve()
    await switching
    expect(sessions.snapshot().root).toBe('/new')
    expect(sessions.snapshot().id).not.toBe(initial.id)
    await expect(sessions.accept(initial.id, async () => {})).rejects.toMatchObject({ code: 'FH2_IDE_SESSION_EXPIRED' })
  })
  it('清理失败保持旧 session，写失败不泄漏受理门', async () => {
    const sessions = new IdeSessionService('/old')
    const original = sessions.snapshot()
    await expect(sessions.accept(original.id, async () => {
      throw new Error('write')
    })).rejects.toThrow('write')
    await expect(sessions.switchRoot('/new', async () => {
      throw new Error('teardown')
    })).rejects.toThrow('teardown')
    expect(sessions.snapshot()).toEqual(original)
    await sessions.accept(original.id, async () => {})
  })
})
