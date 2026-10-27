// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest'
import { createConstInputDrafts } from './input-draft'

const draft = { epoch: 1, stepId: 'step-1', field: 'record_key', type: 'string', raw: 'demo-001' }

describe('createConstInputDrafts', () => {
  it('commit 只收到一次，flush 后清空', async () => {
    const commit = vi.fn()
    const drafts = createConstInputDrafts(commit, () => 1)
    drafts.track(draft)
    await drafts.flush()
    await drafts.flush()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(draft)
    expect(drafts.peek()).toBeNull()
  })

  it('change/blur 已提交的输入不再重复提交', async () => {
    const commit = vi.fn()
    const drafts = createConstInputDrafts(commit, () => 1)
    drafts.track(draft)
    drafts.released('step-1', 'record_key')
    await drafts.flush()
    expect(commit).not.toHaveBeenCalled()
  })

  it('其他字段提交不影响这份草稿', async () => {
    const commit = vi.fn()
    const drafts = createConstInputDrafts(commit, () => 1)
    drafts.track(draft)
    drafts.released('step-1', 'title')
    await drafts.flush()
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('改另一个输入时只保留最后一份草稿', async () => {
    const commit = vi.fn()
    const drafts = createConstInputDrafts(commit, () => 1)
    drafts.track(draft)
    drafts.track({ ...draft, field: 'title', raw: '第二条' })
    await drafts.flush()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[0]).toMatchObject({ field: 'title', raw: '第二条' })
  })

  it('flush 等待异步提交，而不是只启动提交', async () => {
    let finish!: () => void
    const completion = new Promise<void>((resolve) => {
      finish = resolve
    })
    const drafts = createConstInputDrafts(() => completion, () => 1)
    drafts.track(draft)
    const done = vi.fn()
    const flushing = drafts.flush().then(done)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    finish()
    await flushing
    expect(done).toHaveBeenCalledOnce()
  })

  it('文档世代变化后不提交旧草稿，即使步骤和字段同名', async () => {
    let epoch = 1
    const commit = vi.fn()
    const drafts = createConstInputDrafts(commit, () => epoch)
    drafts.track(draft)
    epoch += 1
    await drafts.flush()
    expect(commit).not.toHaveBeenCalled()
    expect(drafts.peek()).toBeNull()
  })

  it('切节点清场后不提交草稿', async () => {
    const commit = vi.fn()
    const drafts = createConstInputDrafts(commit, () => 1)
    drafts.track(draft)
    drafts.discard()
    await drafts.flush()
    expect(commit).not.toHaveBeenCalled()
  })
})
