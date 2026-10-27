// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { TrackedTimers, ViewHandle, ViewPresentation } from 'fh2-plugin-sdk'
import type { PatrolApi } from '../../api/patrol-api'
import type { PatrolDialogState } from '../../views/patrol-dialog/contract'
import { type PatrolTaskState, isPatrolReview, isTaskVisible } from '../../workflow/patrol-session'

/** 结束任务确认弹窗（静态形态）。 */
export const END_TASK_DIALOG: PatrolDialogState = {
  kind: 'end-task',
  iconType: 'warning',
  title: '确认终止巡逻吗？',
  description: '终止后剩余目标不再复检\n飞行器将自动返航机场',
  cancelText: '取消',
  confirmText: '终止',
  countdown: 0,
  confirmPending: false,
  cancelDisabled: false,
  confirmDisabled: false,
}

function returnHomeDialog (countdown: number): PatrolDialogState {
  return {
    kind: 'return-home',
    iconType: 'success',
    title: '复检完成',
    description: '违停抓拍已完成，飞行器等待返航\n超时后将自动返航机场',
    cancelText: '不返航',
    confirmText: '返航',
    countdown,
    confirmPending: false,
    cancelDisabled: false,
    confirmDisabled: false,
  }
}

export interface PatrolDialogControllerDeps {
  /** 宿主弹窗能力；宿主没提供时弹窗功能整体不可用（打开/确认/取消都不会执行） */
  readonly dialogPort: {
    readonly open: (view: ViewHandle, options: { hideHeader: boolean; width: number; height: number }) => Promise<ViewPresentation>;
  } | null;
  readonly getDialogView: () => ViewHandle;
  readonly timers: TrackedTimers;
  readonly taskState: {
    readonly get: () => PatrolTaskState;
    readonly update: (updater: (current: PatrolTaskState) => PatrolTaskState) => void;
  };
  readonly dialogState: {
    readonly update: (updater: (current: PatrolDialogState) => PatrolDialogState) => void;
  };
  readonly api: Pick<PatrolApi, 'abort' | 'returnNow' | 'cancelReturn'>;
  readonly notify: (intent: 'info' | 'success' | 'warning' | 'error', message: string) => void;
  /** 操作后主动拉一次最新任务状态：失败后纠偏，决策成功后加快权威收敛 */
  readonly refresh: () => void;
}

export interface PatrolDialogController {
  open (kind: PatrolDialogState['kind']): Promise<void>;
  close (): Promise<void>;
  cancel (): Promise<void>;
  confirm (): Promise<void>;
  /** 任务状态变化时联动弹窗：返航窗口到了自动弹、结果出来自动关、按钮按 allowedActions 置灰、终态关确认弹窗 */
  handleTaskStateChange (state: PatrolTaskState): void;
  dispose (): Promise<void>;
}

/** 巡逻确认弹窗：负责弹窗的打开/关闭、倒计时和按钮命令。同一时刻只放行一个命令（防连点），命令成功后延迟一拍再关窗（等 View 那边的调用先返回）。 */
export function createPatrolDialogController (deps: PatrolDialogControllerDeps): PatrolDialogController {
  let presentation: ViewPresentation | null = null
  let kind: PatrolDialogState['kind'] | null = null
  let countdownHandle: unknown = null
  let openGeneration = 0
  let disposed = false
  // 有命令正在执行：View 按钮置灰只是显示效果，防连点靠这里
  let commandRunning = false
  // 已自动开过窗的返航窗口标识（taskUuid + dueAt）：同一窗口只自动开一次。
  // 不返航/立即返航成功后、权威状态收敛前，迟到的同 revision 快照或 WS 仍会宣告
  // 同一窗口；按「窗口开放 && 无弹窗」电平重开会让弹窗弹两次，且按钮按旧
  // allowed_actions 可点、服务端一律 40901。新任务或新的 dueAt 才算新窗口。
  // 已知取舍：任务身份被重置后重新识别同一窗口（项目切换往返/宿主任务通道
  // 闪断）不重开；若要支持需在 activate 订阅的 taskUuid 边沿联动重置（该边沿
  // 提前 return，状态不会流经本函数）。
  let openedWindowKey = ''

  async function open (nextKind: PatrolDialogState['kind']): Promise<void> {
    if (!deps.dialogPort || disposed) return
    const generation = ++openGeneration
    await closePresentation(false)
    if (disposed || generation !== openGeneration) return
    kind = nextKind
    if (nextKind === 'return-home') {
      const state = deps.taskState.get()
      const dueAtMs = state.returnHomeDueAtMs
      deps.dialogState.update(() => ({
        ...returnHomeDialog(dueAtMs > 0 ? Math.max(0, Math.ceil((dueAtMs - Date.now()) / 1000)) : 0),
        cancelDisabled: !state.allowedActions.includes('cancel_return'),
        confirmDisabled: !state.allowedActions.includes('return_now'),
      }))
      if (dueAtMs > 0) startCountdown(dueAtMs)
    } else {
      deps.dialogState.update(() => END_TASK_DIALOG)
    }
    let opened: ViewPresentation
    try {
      opened = await deps.dialogPort.open(deps.getDialogView(), { hideHeader: true, width: 288, height: 248 })
    } catch (error) {
      if (generation === openGeneration) {
        kind = null
        stopCountdown()
      }
      throw error
    }
    if (disposed || generation !== openGeneration) {
      await opened.close().catch(() => {})
      return
    }
    presentation = opened
    void opened.closed.then(() => {
      if (presentation === opened) {
        presentation = null
        kind = null
        stopCountdown()
      }
    })
  }

  /** 倒计时只负责显示（服务端 due_at 权威）；归零不自动关弹窗。 */
  function startCountdown (dueAtMs: number): void {
    stopCountdown()
    const tick = (): void => {
      const remaining = Math.max(0, Math.ceil((dueAtMs - Date.now()) / 1000))
      deps.dialogState.update(state => ({ ...state, countdown: remaining }))
    }
    tick()
    countdownHandle = deps.timers.setInterval(tick, 1000)
  }

  function stopCountdown (): void {
    if (countdownHandle !== null) {
      deps.timers.clearInterval(countdownHandle)
      countdownHandle = null
    }
  }

  async function closePresentation (invalidatePendingOpen: boolean): Promise<void> {
    if (invalidatePendingOpen) openGeneration++
    stopCountdown()
    const current = presentation
    presentation = null
    kind = null
    await current?.close().catch(() => {})
  }

  async function close (): Promise<void> {
    await closePresentation(true)
  }

  /**
   * 在 View 方法返回之后关闭弹窗。
   * View 方法内部若先 closeDialog 会卸载发起 RPC 的 untrusted iframe，
   * 调用方拿到的是 `view closing` 拒绝；把关闭挪到微任务之后即可让 RPC 正常返回。
   */
  function closeAfterRpc (): void {
    deps.timers.setTimeout(() => {
      void close()
    }, 0)
  }

  async function cancel (): Promise<void> {
    if (commandRunning || kind === null) return
    if (kind === 'return-home') {
      // 不返航：放弃自动返航，飞机交回人工操控（manual_control 终态）
      commandRunning = true
      try {
        const state = deps.taskState.get()
        if (!state.allowedActions.includes('cancel_return')) {
          deps.notify('warning', '当前不在返航决策窗口')
          deps.refresh()
          return
        }
        try {
          const response = await deps.api.cancelReturn(state.taskUuid)
          const current = deps.taskState.get()
          if (current.taskUuid !== state.taskUuid) return
          if (current.stateRevision === state.stateRevision) {
            // 不返航收下即决策成立：响应缺字段/为 none 时归一为终态，防「窗口开放」条件复活
            const decided = response.return_home_state
            deps.taskState.update(value => ({
              ...value,
              returnHomeState: decided === 'sent' || decided === 'failed' || decided === 'cancelled' ? decided : 'cancelled',
            }))
          }
        } catch (error) {
          deps.notify('error', `取消返航失败：${errorMessage(error)}`)
          deps.refresh()
          return
        }
        deps.notify('warning', '已取消返航，飞机仍在空中，请手动操控')
        deps.refresh()
        closeAfterRpc()
      } finally {
        commandRunning = false
      }
      return
    }
    closeAfterRpc()
  }

  async function confirm (): Promise<void> {
    if (commandRunning || kind === null) return
    if (kind === 'return-home') {
      // 立即返航：200 仅代表信号收下，实际结果看 return_state / 轮询
      commandRunning = true
      try {
        const state = deps.taskState.get()
        if (!state.allowedActions.includes('return_now')) {
          deps.notify('warning', '当前不在返航决策窗口')
          deps.refresh()
          return
        }
        try {
          const response = await deps.api.returnNow(state.taskUuid)
          const current = deps.taskState.get()
          if (current.taskUuid !== state.taskUuid) return
          if (current.stateRevision === state.stateRevision
            && current.returnHomeState !== 'sent'
            && current.returnHomeState !== 'failed'
            && current.returnHomeState !== 'cancelled') {
            deps.taskState.update(value => ({ ...value, returnHomeState: response.return_home_state || 'pending' }))
          }
        } catch (error) {
          deps.notify('error', `返航失败：${errorMessage(error)}`)
          deps.refresh()
          return
        }
        deps.refresh()
        closeAfterRpc()
      } finally {
        commandRunning = false
      }
      return
    }

    // 终止巡逻：排队语义（effective=pending 等下一个可中断点），终态经轮询确认
    const state = deps.taskState.get()
    if (!state.allowedActions.includes('abort')) {
      deps.notify('warning', '巡逻已结束，无需终止')
      return
    }
    commandRunning = true
    deps.dialogState.update(dialog => ({ ...dialog, confirmPending: true }))
    try {
      const response = await deps.api.abort(state.taskUuid)
      if (deps.taskState.get().taskUuid !== state.taskUuid) return
      if (response.effective === 'pending') {
        deps.taskState.update(current => ({ ...current, abortPending: true }))
      } else {
        deps.refresh()
      }
      closeAfterRpc()
    } catch (error) {
      deps.notify('error', `终止巡逻失败：${errorMessage(error)}`)
      deps.refresh()
    } finally {
      deps.dialogState.update(dialog => ({ ...dialog, confirmPending: false }))
      commandRunning = false
    }
  }

  function handleTaskStateChange (state: PatrolTaskState): void {
    // 返航已有结果（sent/failed/cancelled）→ 关闭返航弹窗
    if (kind === 'return-home'
      && (state.returnHomeState === 'sent' || state.returnHomeState === 'failed' || state.returnHomeState === 'cancelled')) {
      void close()
    }

    const returnDecisionAvailable = state.returnHomeDueAtMs > 0
      && state.returnHomeState !== 'sent'
      && state.returnHomeState !== 'failed'
      && state.returnHomeState !== 'cancelled'
    const windowKey = `${state.taskUuid}:${state.returnHomeDueAtMs}`
    if (returnDecisionAvailable && kind === null && isTaskVisible(state) && windowKey !== openedWindowKey) {
      openedWindowKey = windowKey
      void open('return-home').catch((error) => {
        // 开窗失败放行后续状态变化重试（对齐既有语义），否则该窗口永远不再弹
        openedWindowKey = ''
        deps.notify('error', `打开返航决策弹窗失败：${errorMessage(error)}`)
      })
    } else if (kind === 'return-home') {
      deps.dialogState.update(dialog => ({
        ...dialog,
        cancelDisabled: !state.allowedActions.includes('cancel_return'),
        confirmDisabled: !state.allowedActions.includes('return_now'),
      }))
    }

    // 终止确认弹窗打开期间任务已到终态 → 关闭
    if (kind === 'end-task' && isPatrolReview(state)) {
      void close()
    }
  }

  async function dispose (): Promise<void> {
    if (disposed) return
    disposed = true
    stopCountdown()
    await close()
  }

  return { open, close, cancel, confirm, handleTaskStateChange, dispose }
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
