// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { ViewPresentation } from 'fh2-plugin-sdk'
import type { PatrolAbortResponse, PatrolActionResponse } from '../../api/types'
import type { PatrolDialogState } from '../../views/patrol-dialog/contract'
import type { PatrolTaskState } from '../../workflow/patrol-session'
import { createInitialPatrolState } from '../../workflow/patrol-session'
import { END_TASK_DIALOG, createPatrolDialogController } from './patrol-dialog-controller'

function taskState (overrides: Partial<PatrolTaskState> = {}): PatrolTaskState {
  return { ...createInitialPatrolState(), ...overrides }
}

/** 微任务冲刷：让 open/close 内部的异步链推进。 */
async function flush (rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

/** 手动触发式定时器：runPending() 执行一次所有已排期回调（interval 保持排期）。 */
function createFakeTimers () {
  const tasks = new Map<unknown, { callback: () => void; interval: boolean }>()
  let seq = 0
  return {
    setTimeout (callback: () => void, _ms: number) {
      const handle = ++seq
      tasks.set(handle, { callback, interval: false })
      return handle
    },
    clearTimeout (handle: unknown) {
      tasks.delete(handle)
    },
    setInterval (callback: () => void, _ms: number) {
      const handle = ++seq
      tasks.set(handle, { callback, interval: true })
      return handle
    },
    clearInterval (handle: unknown) {
      tasks.delete(handle)
    },
    runPending () {
      for (const [handle, task] of [...tasks.entries()]) {
        task.callback()
        if (!task.interval) tasks.delete(handle)
      }
    },
  }
}

function setup (options: {
  task?: Partial<PatrolTaskState>;
  withCapability?: boolean;
} = {}) {
  const timers = createFakeTimers()
  const taskStore = {
    current: taskState(options.task),
    get: () => taskStore.current,
    update: (updater: (current: PatrolTaskState) => PatrolTaskState) => {
      taskStore.current = updater(taskStore.current)
    },
  }
  // dialogState 逐次叠加（倒计时等增量更新基于上一次结果）
  const dialogUpdates: PatrolDialogState[] = []
  const dialogState = {
    update: (updater: (current: PatrolDialogState) => PatrolDialogState) => {
      dialogUpdates.push(updater(dialogUpdates.at(-1) ?? END_TASK_DIALOG))
    },
  }
  let resolveClosed!: () => void
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const presentation: ViewPresentation = {
    close: vi.fn(async () => {}),
    closed: closedPromise,
  }
  const dialogPort = options.withCapability === false
    ? null
    : { open: vi.fn(async () => presentation) }
  const api = {
    abort: vi.fn(async (): Promise<PatrolAbortResponse> => ({ effective: 'immediate', return_home_state: 'none' })),
    returnNow: vi.fn(async (): Promise<PatrolActionResponse> => ({ return_home_state: 'pending' })),
    cancelReturn: vi.fn(async (): Promise<PatrolActionResponse> => ({ return_home_state: 'cancelled' })),
  }
  const notify = vi.fn()
  const refresh = vi.fn()
  const controller = createPatrolDialogController({
    dialogPort,
    getDialogView: () => ({ viewId: 'patrol-dialog', initialState: null }),
    timers,
    taskState: taskStore,
    dialogState,
    api,
    notify,
    refresh,
  })
  return { timers, taskStore, dialogUpdates, presentation, resolveClosed, dialogPort, api, notify, refresh, controller }
}

function lastDialog (dialogUpdates: PatrolDialogState[]): PatrolDialogState {
  return dialogUpdates.at(-1) ?? END_TASK_DIALOG
}

describe('createPatrolDialogController', () => {
  it('open(end-task)：静态确认形态，dialog.open 携带插件声明的尺寸', async () => {
    const { dialogPort, dialogUpdates, controller } = setup()
    await controller.open('end-task')

    expect(lastDialog(dialogUpdates)).toEqual(END_TASK_DIALOG)
    expect(dialogPort!.open).toHaveBeenCalledWith(
      expect.objectContaining({ viewId: 'patrol-dialog' }),
      { hideHeader: true, width: 288, height: 248 },
    )
  })

  it('open(return-home)：按 dueAtMs 计算倒计时并按 allowedActions 置灰', async () => {
    const { dialogUpdates, controller } = setup({
      task: {
        returnHomeDueAtMs: Date.now() + 30_000,
        allowedActions: ['return_now'],
      },
    })
    await controller.open('return-home')

    const dialog = lastDialog(dialogUpdates)
    expect(dialog.kind).toBe('return-home')
    expect(dialog.countdown).toBeGreaterThan(0)
    expect(dialog.cancelDisabled).toBe(true)
    expect(dialog.confirmDisabled).toBe(false)
  })

  it('倒计时只负责显示：归零不自动关弹窗', async () => {
    const base = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    try {
      const { presentation, dialogUpdates, timers, controller } = setup({
        task: { returnHomeDueAtMs: base + 2000, allowedActions: ['return_now', 'cancel_return'] },
      })
      await controller.open('return-home')

      nowSpy.mockReturnValue(base + 1000)
      timers.runPending() // 剩余 ~1s
      expect(lastDialog(dialogUpdates).countdown).toBe(1)
      nowSpy.mockReturnValue(base + 3000)
      timers.runPending() // 归零
      expect(lastDialog(dialogUpdates).countdown).toBe(0)
      expect(presentation.close).not.toHaveBeenCalled()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('presentation.closed 落定：内部状态复位（后续可再次打开）', async () => {
    const { dialogPort, resolveClosed, controller } = setup()
    await controller.open('end-task')
    resolveClosed()
    await flush()

    await controller.open('end-task')
    expect(dialogPort!.open).toHaveBeenCalledTimes(2)
  })

  it('confirm(end-task)：effective=pending 置 abortPending，confirmPending 复位，延迟关闭', async () => {
    const { taskStore, api, presentation, timers, dialogUpdates, controller } = setup({
      task: { taskUuid: 'task-1', phase: 'phase2', allowedActions: ['abort'] },
    })
    api.abort.mockResolvedValue({ effective: 'pending', return_home_state: 'none' })
    await controller.open('end-task')

    await controller.confirm()

    expect(api.abort).toHaveBeenCalledWith('task-1')
    expect(taskStore.current.abortPending).toBe(true)
    expect(lastDialog(dialogUpdates).confirmPending).toBe(false)
    expect(presentation.close).not.toHaveBeenCalled()
    timers.runPending()
    expect(presentation.close).toHaveBeenCalledTimes(1)
  })

  it('confirm(end-task)：无 abort 权限提示并跳过 RPC；接口失败提示错误并刷新', async () => {
    const { api, notify, refresh, controller } = setup({
      task: { taskUuid: 'task-1', allowedActions: [] },
    })
    await controller.open('end-task')
    await controller.confirm()

    expect(api.abort).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('warning', '巡逻已结束，无需终止')
    expect(refresh).not.toHaveBeenCalled()

    const failing = setup({ task: { taskUuid: 'task-1', allowedActions: ['abort'] } })
    failing.api.abort.mockRejectedValue(new Error('network down'))
    await failing.controller.open('end-task')
    await failing.controller.confirm()
    expect(failing.notify).toHaveBeenCalledWith('error', '终止巡逻失败：network down')
    expect(failing.refresh).toHaveBeenCalledTimes(1)
  })

  it('命令锁：执行中的 confirm 并发调用被忽略', async () => {
    const { api, controller } = setup({
      task: { taskUuid: 'task-1', allowedActions: ['abort'] },
    })
    let resolveAbort: ((value: PatrolAbortResponse) => void) | undefined
    api.abort.mockImplementation(() => new Promise<PatrolAbortResponse>((resolve) => {
      resolveAbort = resolve
    }))
    await controller.open('end-task')

    const first = controller.confirm()
    await controller.confirm() // 命令执行中被忽略
    resolveAbort?.({ effective: 'pending', return_home_state: 'none' })
    await first
    await flush()

    expect(api.abort).toHaveBeenCalledTimes(1)
  })

  it('cancel(return-home)：权限内取消返航 → 乐观更新 returnHomeState + 提示 + 刷新 + 延迟关闭', async () => {
    const { taskStore, api, notify, refresh, presentation, timers, controller } = setup({
      task: {
        taskUuid: 'task-1',
        phase: 'phase2',
        returnHomeDueAtMs: Date.now() + 30_000,
        allowedActions: ['return_now', 'cancel_return'],
      },
    })
    await controller.open('return-home')

    await controller.cancel()

    expect(api.cancelReturn).toHaveBeenCalledWith('task-1')
    expect(taskStore.current.returnHomeState).toBe('cancelled')
    expect(notify).toHaveBeenCalledWith('warning', '已取消返航，飞机仍在空中，请手动操控')
    expect(refresh).toHaveBeenCalledTimes(1)
    timers.runPending()
    expect(presentation.close).toHaveBeenCalledTimes(1)
  })

  it('cancel(return-home)：不在决策窗口提示并触发权威刷新；revision 已变不乐观更新', async () => {
    const { api, notify, refresh, controller } = setup({
      task: { taskUuid: 'task-1', returnHomeDueAtMs: Date.now() + 30_000, allowedActions: [] },
    })
    await controller.open('return-home')
    await controller.cancel()

    expect(api.cancelReturn).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('warning', '当前不在返航决策窗口')
    expect(refresh).toHaveBeenCalledTimes(1)

    // RPC 进行中快照推进 revision → 放弃乐观更新
    const revisioned = setup({
      task: { taskUuid: 'task-1', stateRevision: 5, returnHomeDueAtMs: Date.now() + 30_000, allowedActions: ['cancel_return'] },
    })
    revisioned.api.cancelReturn.mockImplementation(async () => {
      revisioned.taskStore.current = { ...revisioned.taskStore.current, stateRevision: 6 }
      return { return_home_state: 'cancelled' }
    })
    await revisioned.controller.open('return-home')
    await revisioned.controller.cancel()
    expect(revisioned.taskStore.current.returnHomeState).toBe('none')
  })

  it('confirm(return-home)：立即返航走乐观 pending 并刷新；任务已切换不更新', async () => {
    const { taskStore, refresh, controller } = setup({
      task: {
        taskUuid: 'task-1',
        returnHomeDueAtMs: Date.now() + 30_000,
        allowedActions: ['return_now', 'cancel_return'],
      },
    })
    await controller.open('return-home')
    await controller.confirm()
    expect(taskStore.current.returnHomeState).toBe('pending')
    expect(refresh).toHaveBeenCalledTimes(1)

    // 响应返回前任务已切换 → 丢弃
    const switched = setup({
      task: { taskUuid: 'task-1', returnHomeDueAtMs: Date.now() + 30_000, allowedActions: ['return_now'] },
    })
    switched.api.returnNow.mockImplementation(async () => {
      switched.taskStore.current = { ...switched.taskStore.current, taskUuid: 'task-2' }
      return { return_home_state: 'pending' }
    })
    await switched.controller.open('return-home')
    await switched.controller.confirm()
    expect(switched.taskStore.current.returnHomeState).toBe('none')
  })

  it('任务状态变化：返航窗口到达自动开窗；结果落定自动关窗', async () => {
    const { dialogPort, taskStore, controller } = setup({
      task: { taskUuid: 'task-1', phase: 'phase2', returnHomeDueAtMs: Date.now() + 30_000, allowedActions: ['return_now'] },
    })

    controller.handleTaskStateChange(taskStore.current)
    await flush()
    expect(dialogPort!.open).toHaveBeenCalledTimes(1)

    // 结果落定（sent）→ 关闭
    taskStore.current = { ...taskStore.current, returnHomeState: 'sent' }
    controller.handleTaskStateChange(taskStore.current)
    await flush()
    // sent 不再满足窗口条件，不会重新开窗
    expect(dialogPort!.open).toHaveBeenCalledTimes(1)
  })

  it('不返航成功但 revision 已推进（乐观更新被跳过）：同一窗口的后续状态回放不得重开弹窗', async () => {
    const dueAt = Date.now() + 30_000
    const { taskStore, api, dialogPort, presentation, timers, controller } = setup({
      task: {
        taskUuid: 'task-1',
        phase: 'phase2',
        returnHomeDueAtMs: dueAt,
        allowedActions: ['return_now', 'cancel_return'],
      },
    })
    controller.handleTaskStateChange(taskStore.current)
    await flush()
    expect(dialogPort!.open).toHaveBeenCalledTimes(1)

    // RPC 期间轮询推进 revision → 乐观更新被跳过，本地仍是「窗口开放」
    api.cancelReturn.mockImplementation(async () => {
      taskStore.current = { ...taskStore.current, stateRevision: taskStore.current.stateRevision + 1 }
      return { return_home_state: 'cancelled' }
    })
    await controller.cancel()
    expect(taskStore.current.returnHomeState).toBe('none')

    timers.runPending() // closeDialogAfterRpc
    expect(presentation.close).toHaveBeenCalledTimes(1)

    // 迟到的同窗口状态（dueAt 不变、returnHomeState 仍非终态）不得重开
    controller.handleTaskStateChange(taskStore.current)
    await flush()
    expect(dialogPort!.open).toHaveBeenCalledTimes(1)
  })

  it('同一返航窗口只自动开一次；新 dueAt 或新任务视为新窗口', async () => {
    const dueAt = Date.now() + 30_000
    const { taskStore, dialogPort, controller } = setup({
      task: {
        taskUuid: 'task-1',
        phase: 'phase2',
        returnHomeDueAtMs: dueAt,
        allowedActions: ['return_now', 'cancel_return'],
      },
    })
    controller.handleTaskStateChange(taskStore.current)
    await flush()
    expect(dialogPort!.open).toHaveBeenCalledTimes(1)

    // 终态关窗后，同 revision 快照把窗口字段盖回去（同一窗口）→ 不得重开
    taskStore.current = { ...taskStore.current, returnHomeState: 'cancelled' }
    controller.handleTaskStateChange(taskStore.current)
    await flush()
    taskStore.current = { ...taskStore.current, returnHomeState: 'none' }
    controller.handleTaskStateChange(taskStore.current)
    await flush()
    expect(dialogPort!.open).toHaveBeenCalledTimes(1)

    // 新的 dueAt = 新窗口 → 可以再次开窗
    taskStore.current = { ...taskStore.current, returnHomeDueAtMs: dueAt + 1000 }
    controller.handleTaskStateChange(taskStore.current)
    await flush()
    expect(dialogPort!.open).toHaveBeenCalledTimes(2)

    // 新任务的窗口 = 新窗口 → 可以再次开窗（先终态关掉上一个弹窗）
    taskStore.current = { ...taskStore.current, taskUuid: 'task-2', returnHomeDueAtMs: dueAt, returnHomeState: 'cancelled' }
    controller.handleTaskStateChange(taskStore.current)
    await flush()
    taskStore.current = { ...taskStore.current, returnHomeState: 'none' }
    controller.handleTaskStateChange(taskStore.current)
    await flush()
    expect(dialogPort!.open).toHaveBeenCalledTimes(3)
  })

  it('任务状态变化：任务不可见（dismiss）不开窗；end-task 遇终态自动关闭', async () => {
    const { dialogPort, taskStore, presentation, controller } = setup({
      task: { taskUuid: 'task-1', returnHomeDueAtMs: Date.now() + 30_000, allowedActions: ['return_now'] },
    })

    controller.handleTaskStateChange(taskState({ ...taskStore.current, patrolDismissed: true }))
    await flush()
    expect(dialogPort!.open).not.toHaveBeenCalled()

    await controller.open('end-task')
    controller.handleTaskStateChange(taskState({ taskUuid: 'task-1', linkState: 'active', phase: 'completed' }))
    await flush()
    expect(presentation.close).toHaveBeenCalledTimes(1)
  })

  it('capability 缺失：open 无效果，confirm/cancel 不触达 API', async () => {
    const { api, dialogPort, controller } = setup({ withCapability: false })
    await controller.open('end-task')
    expect(dialogPort).toBeNull()

    await controller.confirm()
    await controller.cancel()
    expect(api.abort).not.toHaveBeenCalled()
  })

  it('没有活动弹窗时 confirm/cancel 不触达 API', async () => {
    const { api, controller } = setup({
      task: { taskUuid: 'task-1', allowedActions: ['abort', 'return_now', 'cancel_return'] },
    })

    await controller.confirm()
    await controller.cancel()

    expect(api.abort).not.toHaveBeenCalled()
    expect(api.returnNow).not.toHaveBeenCalled()
    expect(api.cancelReturn).not.toHaveBeenCalled()
  })

  it('dispose 发生在 dialog.open 等待期间时关闭迟到的 presentation', async () => {
    const { dialogPort, presentation, controller } = setup()
    let resolveOpen: ((value: ViewPresentation) => void) | undefined
    dialogPort!.open.mockImplementation(() => new Promise<ViewPresentation>((resolve) => {
      resolveOpen = resolve
    }))

    const opening = controller.open('end-task')
    await flush()
    await controller.dispose()
    resolveOpen?.(presentation)
    await opening

    expect(presentation.close).toHaveBeenCalledTimes(1)
  })

  it('dialog.open 失败后允许后续状态变化重试', async () => {
    const { dialogPort, taskStore, notify, controller } = setup({
      task: { taskUuid: 'task-1', returnHomeDueAtMs: Date.now() + 30_000, allowedActions: ['return_now'] },
    })
    dialogPort!.open.mockRejectedValueOnce(new Error('host unavailable'))

    controller.handleTaskStateChange(taskStore.current)
    await flush()
    expect(notify).toHaveBeenCalledWith('error', '打开返航决策弹窗失败：host unavailable')

    controller.handleTaskStateChange(taskStore.current)
    await flush()
    expect(dialogPort!.open).toHaveBeenCalledTimes(2)
  })

  it('dispose：停止倒计时并关闭弹窗', async () => {
    const { presentation, timers, controller } = setup({
      task: { taskUuid: 'task-1', returnHomeDueAtMs: Date.now() + 30_000, allowedActions: ['return_now'] },
    })
    await controller.open('return-home')

    await controller.dispose()
    expect(presentation.close).toHaveBeenCalledTimes(1)
    timers.runPending()
    expect(presentation.close).toHaveBeenCalledTimes(1) // 无重复关闭
  })
})
