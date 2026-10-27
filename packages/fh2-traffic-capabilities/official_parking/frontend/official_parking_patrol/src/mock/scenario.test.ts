// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import type { PatrolWsMessage } from '../workflow/patrol-session'
import { createMockPatrolBackend } from './patrol-source'
import { createPatrolScenario } from './scenario'

/** 驱动整个剧本并返回每一步后的快照与 WS 消息流。 */
function runScenario () {
  const backend = createMockPatrolBackend()
  const messages: PatrolWsMessage[] = []
  backend.events.onWsMessage(message => messages.push(message))
  const scenario = createPatrolScenario(backend, () => 1756542962000)

  for (let i = 1; i <= 9; i++) scenario.advance()

  const taskUuid = backend.activeTaskUuid()
  return { backend, messages, taskUuid, snapshot: taskUuid ? undefined : undefined }
}

describe('patrol scenario（新版契约剧本）', () => {
  it('完整九步：waiting → active → phase1 → phase1_done → phase2 → 返航窗口 → 终态', async () => {
    const backend = createMockPatrolBackend()
    const messages: PatrolWsMessage[] = []
    backend.events.onWsMessage(message => messages.push(message))
    const scenario = createPatrolScenario(backend, () => 1756542962000)

    // 步骤 1：下发任务，engine 未接管（waiting）
    scenario.advance()
    const taskUuid = backend.activeTaskUuid()
    expect(taskUuid).not.toBe('')
    await expect(backend.getTask(taskUuid)).resolves.toMatchObject({ link_state: 'waiting', task_uuid: taskUuid })

    // 步骤 2：接管成功，phase1 + abort 可用
    scenario.advance()
    let snapshot = await backend.getTask(taskUuid)
    expect(snapshot).toMatchObject({ link_state: 'active', phase: 'phase1' })
    if (snapshot.link_state === 'active') {
      expect(snapshot.allowed_actions).toEqual(['abort'])
      expect(snapshot.wayline_uuid).not.toBe('')
    }

    // 步骤 3-4：两辆违停车辆入库，初检完成
    scenario.advance()
    scenario.advance()
    snapshot = await backend.getTask(taskUuid)
    expect(snapshot.link_state).toBe('active')
    if (snapshot.link_state === 'active') {
      expect(snapshot.phase).toBe('phase1_done')
      expect(snapshot.targets).toHaveLength(2)
      expect(snapshot.target_stats).toMatchObject({ total: 2, pending: 2 })
    }

    // 步骤 5-7：复检推进，车辆1 取证完整
    scenario.advance()
    scenario.advance()
    scenario.advance()
    snapshot = await backend.getTask(taskUuid)
    if (snapshot.link_state === 'active') {
      expect(snapshot.phase).toBe('phase2')
      expect(snapshot.targets.map(item => item.status)).toEqual(['completed', 'in_progress'])
      // photo_pending 已并入口径之外：completed=1, processing=1
      expect(snapshot.target_stats).toMatchObject({ completed: 1, processing: 1 })
    }

    // 步骤 8：复检完成，返航窗口开启（phase 仍 phase2，等待用户决策）
    scenario.advance()
    snapshot = await backend.getTask(taskUuid)
    if (snapshot.link_state === 'active') {
      expect(snapshot.phase).toBe('phase2')
      expect(snapshot.return_home_due_at_ms).toBe(1756542962000 + 30_000)
      expect(snapshot.allowed_actions).toEqual(['return_now', 'cancel_return', 'abort'])
    }
    expect(messages.some(message => message.kind === 'return_pending')).toBe(true)

    // 步骤 9：窗口超时，自动返航（终态 completed + all_done）
    scenario.advance()
    snapshot = await backend.getTask(taskUuid)
    if (snapshot.link_state === 'active') {
      expect(snapshot.phase).toBe('completed')
      expect(snapshot.completion_reason).toBe('all_done')
      expect(snapshot.return_home_state).toBe('sent')
      expect(snapshot.allowed_actions).toEqual([])
    }
    expect(backend.isTaskRunning()).toBe(false)
  })

  it('wS 消息流覆盖四类 sub 消息且携带 task 标识', () => {
    const { messages, taskUuid } = runScenario()
    const kinds = new Set(messages.map(message => message.kind))
    expect(kinds).toEqual(new Set(['progress', 'target_updated', 'return_pending', 'return_state']))
    for (const message of messages) {
      expect(message.taskUuid).toBe(taskUuid)
    }
  })

  it('返航：return-now 收下后窗口关闭，下一次 getTask 收敛 sent/completed', async () => {
    const backend = createMockPatrolBackend()
    const scenario = createPatrolScenario(backend, () => 1756542962000)
    for (let i = 1; i <= 8; i++) scenario.advance()
    const taskUuid = backend.activeTaskUuid()

    await expect(backend.returnNow(taskUuid)).resolves.toMatchObject({ return_home_state: 'pending' })
    // 收下后动作窗口关闭（防重复点击）
    let snapshot = await backend.getTask(taskUuid)
    if (snapshot.link_state === 'active') expect(snapshot.allowed_actions).toEqual([])

    // 下一次 getTask 收敛终态
    snapshot = await backend.getTask(taskUuid)
    if (snapshot.link_state === 'active') {
      expect(snapshot.phase).toBe('completed')
      expect(snapshot.return_home_state).toBe('sent')
    }
  })

  it('不返航：cancel-return 立即进入 manual_control 终态', async () => {
    const backend = createMockPatrolBackend()
    const scenario = createPatrolScenario(backend, () => 1756542962000)
    for (let i = 1; i <= 8; i++) scenario.advance()
    const taskUuid = backend.activeTaskUuid()

    await expect(backend.cancelReturn(taskUuid)).resolves.toMatchObject({ return_home_state: 'cancelled' })
    const snapshot = await backend.getTask(taskUuid)
    if (snapshot.link_state === 'active') {
      expect(snapshot.phase).toBe('manual_control')
      expect(snapshot.return_home_state).toBe('cancelled')
      expect(snapshot.allowed_actions).toEqual([])
    }
  })

  it('终止：abort 排队生效（pending），下一次 getTask 收敛 completed/user_abort', async () => {
    const backend = createMockPatrolBackend()
    const scenario = createPatrolScenario(backend, () => 1756542962000)
    for (let i = 1; i <= 5; i++) scenario.advance()
    const taskUuid = backend.activeTaskUuid()

    await expect(backend.abort(taskUuid)).resolves.toMatchObject({ effective: 'pending', return_home_state: 'none' })
    let snapshot = await backend.getTask(taskUuid)
    if (snapshot.link_state === 'active') expect(snapshot.abort_pending).toBe(true)

    snapshot = await backend.getTask(taskUuid)
    if (snapshot.link_state === 'active') {
      expect(snapshot.phase).toBe('completed')
      expect(snapshot.completion_reason).toBe('user_abort')
      expect(snapshot.return_home_state).toBe('sent')
    }
  })

  it('窗口外动作被拒（40901 语义）', async () => {
    const backend = createMockPatrolBackend()
    const scenario = createPatrolScenario(backend, () => 1756542962000)
    scenario.advance()
    scenario.advance()
    const taskUuid = backend.activeTaskUuid()

    await expect(backend.returnNow(taskUuid)).rejects.toThrow('40901')
    await expect(backend.cancelReturn(taskUuid)).rejects.toThrow('40901')
  })

  it('平台任务服务 判别：mock 任务带 es-patrol 与开始时间，未知任务为普通飞行', async () => {
    const { backend, taskUuid } = runScenario()
    await expect(backend.getFlightTaskDetail('p', taskUuid)).resolves.toEqual({
      uuid: taskUuid,
      biz_ext: { 'es-patrol': {} },
      begin_at_ms: expect.any(Number),
    })
    await expect(backend.getFlightTaskDetail('p', 'unknown-task')).resolves.toEqual({
      uuid: 'unknown-task',
      biz_ext: null,
      begin_at_ms: 0,
    })
  })

  it('媒体：initial 恒定一张 + recheck 按拍照进度增长', async () => {
    const backend = createMockPatrolBackend()
    const scenario = createPatrolScenario(backend, () => 1756542962000)
    for (let i = 1; i <= 7; i++) scenario.advance()
    const taskUuid = backend.activeTaskUuid()
    const snapshot = await backend.getTask(taskUuid)
    if (snapshot.link_state !== 'active') throw new Error('snapshot should be active')

    const pending = snapshot.targets.find(item => item.status === 'in_progress')
    if (pending) {
      const before = await backend.getTargetMedia(pending.target_id)
      expect(before.recheck).toHaveLength(0)
      expect(before.initial?.url).toBe(pending.best_frame_thumb_url)
    }

    const completed = snapshot.targets.find(item => item.status === 'completed')
    if (completed) {
      const media = await backend.getTargetMedia(completed.target_id)
      expect(media.recheck).toHaveLength(1)
    }
  })

  it('getCurrent：进行中的任务可发现；无任务/已结束时为 null', async () => {
    const backend = createMockPatrolBackend()
    const scenario = createPatrolScenario(backend, () => 1756542962000)
    await expect(backend.getCurrent('MOCK-GATEWAY-001')).resolves.toBeNull()
    await expect(backend.getCurrent('OTHER-DOCK')).resolves.toBeNull()

    for (let i = 1; i <= 5; i++) scenario.advance()
    await expect(backend.getCurrent('MOCK-GATEWAY-001')).resolves.toMatchObject({ link_state: 'active' })

    for (let i = 6; i <= 9; i++) scenario.advance()
    await expect(backend.getCurrent('MOCK-GATEWAY-001')).resolves.toBeNull()
  })
})
