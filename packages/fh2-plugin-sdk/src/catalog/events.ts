// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * Host 可发布、插件可订阅的平台事件唯一契约目录。
 *
 * 事件名和 payload 必须在这里成对声明；不提供任意字符串逃生口。
 */
interface PlatformEventCatalog {
  /** Cockpit SDK 报告急停已触发/受理；不保证执行成功，成功终态由业务自行确认。 */
  readonly 'cockpit.emergency-stop': {
    readonly timestamp: number;
    readonly source?: string;
  };
  /** Cockpit 直播通道生命周期发生变化。 */
  readonly 'cockpit.live.lifecycle': {
    /** first-frame=首帧渲染完成（逐帧处理安全起点，≠ started 建联成功）。 */
    readonly phase: 'started' | 'first-frame' | 'stopped' | 'channel-changed';
    readonly liveId: string;
    readonly cameraIndex: string | null;
    readonly timestamp: number;
  };
}

/** 封闭的平台事件目录；type 别名阻止插件通过声明合并扩展目录。 */
export type PlatformEventMap = PlatformEventCatalog

export type PlatformEventName = keyof PlatformEventMap

export type PlatformEventPayload<TName extends PlatformEventName> = PlatformEventMap[TName]

export type CockpitEmergencyStopEventPayload = PlatformEventMap['cockpit.emergency-stop']

export type CockpitLiveLifecycleEventPayload = PlatformEventMap['cockpit.live.lifecycle']
