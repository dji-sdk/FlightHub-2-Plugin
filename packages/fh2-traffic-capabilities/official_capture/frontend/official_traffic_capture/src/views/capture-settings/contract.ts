// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk/view'
import type { PluginViewClient } from 'fh2-plugin-sdk/view'

/** 设置面板：抓拍开关 tab + 告警 tab（对齐原生 AutoCaptureSettingPanel）。 */

export interface CaptureSwitchState {
  readonly enabled: boolean;
  readonly canEnable: boolean;
  readonly disabledReason: string | null;
}

export interface CaptureAlertSwitchState {
  readonly enabled: boolean;
  readonly popup: boolean;
  readonly sound: boolean;
}

export interface CaptureSettingsState {
  readonly laneChange: CaptureSwitchState;
  readonly personRoad: CaptureSwitchState;
  readonly switchBusy: boolean;
  readonly alert: CaptureAlertSwitchState;
}

interface CaptureSettingsContract {
  state: CaptureSettingsState;
  methods: {
    close(): void;
    setLaneChangeEnabled(input: { readonly enabled: boolean }): void;
    setPersonRoadEnabled(input: { readonly enabled: boolean }): void;
    setAlertEnabled(input: { readonly enabled: boolean }): void;
    setAlertPopup(input: { readonly popup: boolean }): void;
    setAlertSound(input: { readonly sound: boolean }): void;
  };
}

export const captureSettingsView = definePluginView<CaptureSettingsContract>('capture-settings')

export type CaptureSettingsClient = PluginViewClient<CaptureSettingsContract>
