// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { CockpitContextState, PluginLogger } from 'fh2-plugin-sdk'
import type { LaneChangeModule } from '../lane-change/module'
import type { PersonRoadModule } from '../person-road/module'
import type { CockpitRuntimeEnv } from '../runtime-env'

type CaptureMode = 'lane-change' | 'person-road'

export interface CaptureModeCoordinator {
  setEnabled(mode: CaptureMode, enabled: boolean): Promise<void>;
  recover(): Promise<void>;
  applyContextTransition(next: CockpitContextState): Promise<void>;
  idle(): Promise<void>;
  dispose(): Promise<void>;
}

export function createCaptureModeCoordinator (deps: {
  readonly laneChange: LaneChangeModule;
  readonly personRoad: PersonRoadModule;
  readonly env: CockpitRuntimeEnv;
  readonly logger: PluginLogger;
  readonly resetCaptureSession: () => void;
}): CaptureModeCoordinator {
  let transition = Promise.resolve()
  let disposed = false

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const run = async (): Promise<void> => {
      if (!disposed) await operation()
    }
    const result = transition.then(run, run)
    transition = result.catch(() => {})
    return result
  }

  const notify = async (message: string, intent: 'warning' | 'error'): Promise<void> => {
    try {
      await deps.env.capabilities.notification?.show({
        key: `capture-mode-coordinator:${intent}:${Date.now()}`,
        message,
        intent,
        durationMs: 4000,
      })
    } catch {
      // 状态收敛不依赖通知能力。
    }
  }

  const setEnabled = async (mode: CaptureMode, enabled: boolean): Promise<void> => {
    const target = mode === 'lane-change' ? deps.laneChange : deps.personRoad
    const other = mode === 'lane-change' ? deps.personRoad : deps.laneChange
    if (enabled) await other.setEnabled(false)
    await target.setEnabled(enabled)
  }

  const recoverModes = async (): Promise<void> => {
    let firstError: unknown
    for (const [name, recover] of [
      ['行人上路', () => deps.personRoad.recover()],
      ['变道', () => deps.laneChange.recover()],
    ] as const) {
      try {
        await recover()
      } catch (error) {
        firstError ??= error
        deps.logger.warn(`恢复${name}抓拍模式失败`, error instanceof Error ? error.message : String(error))
      }
    }

    const bothEnabled = deps.personRoad.settingsState.get().enabled
      && deps.laneChange.settingsState.get().enabled
    if (bothEnabled) {
      let closeFailed = false
      for (const [name, close] of [
        ['行人上路', () => deps.personRoad.setEnabled(false)],
        ['变道', () => deps.laneChange.setEnabled(false)],
      ] as const) {
        try {
          await close()
        } catch (error) {
          closeFailed = true
          deps.logger.warn(`恢复双开状态时关闭${name}模式失败`, error instanceof Error ? error.message : String(error))
        }
      }
      notify(
        closeFailed
          ? '检测到两个抓拍模式同时开启，自动关闭未完全成功，请手动重试'
          : '检测到两个抓拍模式同时开启，已自动全部关闭，请重新开启需要的功能',
        closeFailed ? 'error' : 'warning',
      )
    }

    if (firstError !== undefined) throw firstError
  }

  const sessionKey = (state: CockpitContextState | null): string => (
    `${state?.projectId ?? ''}:${state?.flightId ?? ''}`
  )

  return {
    setEnabled: (mode, enabled) => enqueue(() => setEnabled(mode, enabled)),
    recover: () => enqueue(recoverModes),
    applyContextTransition: next => enqueue(async () => {
      if (sessionKey(deps.env.getContextSnapshot()) === sessionKey(next)) {
        deps.env.setContextSnapshot(next)
        deps.laneChange.refreshGate()
        deps.personRoad.refreshGate()
        return
      }
      for (const [name, close] of [
        ['行人上路', () => deps.personRoad.setEnabled(false)],
        ['变道', () => deps.laneChange.setEnabled(false)],
      ] as const) {
        try {
          await close()
        } catch (error) {
          deps.logger.warn(`切换抓拍航次时关闭${name}模式失败`, error instanceof Error ? error.message : String(error))
        }
      }
      deps.env.setContextSnapshot(next)
      deps.laneChange.resetSession()
      deps.personRoad.resetSession()
      deps.resetCaptureSession()
      await recoverModes()
    }),
    idle: () => transition,
    async dispose () {
      disposed = true
      await transition
    },
  }
}
