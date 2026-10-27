// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import type { Disposable } from 'fh2-plugin-sdk'

/** 抓拍告警配置（对齐原生"告警"页）：总开关、弹窗、音效，默认全部开启。 */
export interface CaptureAlertSettings {
  readonly enabled: boolean;
  readonly popup: boolean;
  readonly sound: boolean;
}

export interface CaptureAlertToastState {
  readonly visible: boolean;
  readonly message: string;
}

export interface CaptureAlertController {
  readonly settingsState: { get(): CaptureAlertSettings; subscribe(listener: (state: CaptureAlertSettings) => void): Disposable };
  readonly toastState: { get(): CaptureAlertToastState; subscribe(listener: (state: CaptureAlertToastState) => void): Disposable };
  setEnabled (input: { enabled: boolean }): void;
  setPopup (input: { popup: boolean }): void;
  setSound (input: { sound: boolean }): void;
  /** 抓拍确认后的统一告警入口：按配置展示"发现目标"弹窗并播放音效。 */
  alert (message?: string): void;
  /** 告警弹窗被点击：隐藏并回调（reveal 记录面板）。 */
  handleToastClick (): void;
  dispose (): Promise<void>;
}

const TOAST_AUTO_DISMISS_MS = 5000

/**
 * 告警协调器：变道、行人与 Mock 剧本共用。
 * 弹窗为 live-overlay toast（5 秒自动消失），音效为插件自带 Audio，两者独立开关。
 */
export function createCaptureAlertController (options: {
  readonly audio: { play(options?: { readonly restart?: boolean }): Promise<void>; dispose(): Promise<void> } | undefined;
  readonly timers: { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  readonly onToastClick: () => void;
  readonly logger: { warn(message: string, detail?: unknown): void };
}): CaptureAlertController {
  const settingsState = createViewState<CaptureAlertSettings>({ enabled: true, popup: true, sound: true })
  const toastState = createViewState<CaptureToastInternal>({ visible: false, message: '发现目标' })
  let dismissTimer: unknown

  const scheduleAutoDismiss = (): void => {
    if (dismissTimer !== undefined) options.timers.clearTimeout(dismissTimer)
    dismissTimer = options.timers.setTimeout(() => {
      toastState.update(state => ({ ...state, visible: false }))
    }, TOAST_AUTO_DISMISS_MS)
  }

  return {
    settingsState,
    toastState,
    setEnabled ({ enabled }) {
      settingsState.update(state => ({ ...state, enabled }))
    },
    setPopup ({ popup }) {
      settingsState.update(state => ({ ...state, popup }))
    },
    setSound ({ sound }) {
      settingsState.update(state => ({ ...state, sound }))
    },
    alert (message = '发现目标') {
      const settings = settingsState.get()
      if (!settings.enabled) return
      // 新告警替换旧告警并重新计时
      if (settings.popup) toastState.update(() => ({ visible: true, message }))
      if (settings.sound) {
        void options.audio?.play({ restart: true }).catch((error: unknown) => {
          options.logger.warn('告警音效播放失败', error instanceof Error ? error.message : String(error))
        })
      }
      if (settings.popup) scheduleAutoDismiss()
    },
    handleToastClick () {
      if (dismissTimer !== undefined) options.timers.clearTimeout(dismissTimer)
      dismissTimer = undefined
      toastState.update(state => ({ ...state, visible: false }))
      options.onToastClick()
    },
    async dispose () {
      if (dismissTimer !== undefined) options.timers.clearTimeout(dismissTimer)
      dismissTimer = undefined
      await options.audio?.dispose()
    },
  }
}

// 内部状态与对外契约同构；显式别名保持公开类型稳定
type CaptureToastInternal = CaptureAlertToastState
