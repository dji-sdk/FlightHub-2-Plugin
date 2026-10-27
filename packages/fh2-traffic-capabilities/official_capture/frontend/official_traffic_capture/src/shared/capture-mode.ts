// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/** 两个抓拍模式（变道/行人上路）共享的模式级常量与类型。 */

/** 原生允许飞行的 mode_code 白名单（ManualFlight/SmartFollow/ADSBAvoidance/APAS/Joystick/CommandFlight/POI）。 */
export const ALLOWED_FLIGHT_MODES = new Set([3, 7, 8, 15, 16, 17, 20])

/** 录像所有权句柄（camera.acquireRecording 返回值的结构类型）。 */
export interface RecordingLease {
  stop (): Promise<void>;
  dispose (): void | Promise<void>;
  onRevoked (handler: (reason: 'superseded' | 'device-state-changed' | 'disposed') => void): Promise<{ dispose (): void | Promise<void> }>;
}

/** 单模式设置面板内部快照（组合面板由装配层组装）。 */
export interface CaptureModeSettingsSnapshot {
  readonly enabled: boolean;
  readonly canEnable: boolean;
  readonly disabledReason: string | null;
  readonly switchBusy: boolean;
}
