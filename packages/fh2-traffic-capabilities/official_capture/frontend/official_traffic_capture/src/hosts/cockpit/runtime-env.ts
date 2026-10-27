// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type {
  CockpitContextState,
  PluginCapabilityClient,
  PluginWsApi,
} from 'fh2-plugin-sdk'
import { createPluginInvoke } from '../../shared/api/invoke'
import type { CaptureAlertController } from '../../shared/alert/capture-alert'
import { createCaptureAlertController } from '../../shared/alert/capture-alert'
import type { LaneChangeApi } from './lane-change/api'
import { createLaneChangeApi } from './lane-change/api'
import type { IllegalRoadApi } from './person-road/api'
import { createIllegalRoadApi } from './person-road/api'
import { createMockTrafficRuntime } from './mock-runtime'
import type { TrafficCaptureContext } from './context'

/** Cockpit Runtime 装配环境：能力客户端、上下文 getter、数据源与告警协调器。 */
export interface CockpitRuntimeEnv {
  readonly capabilities: {
    readonly telemetry: PluginCapabilityClient<'cockpit:telemetry'> | undefined;
    readonly camera: PluginCapabilityClient<'cockpit:camera'> | undefined;
    readonly detection: PluginCapabilityClient<'cockpit:detection'> | undefined;
    readonly sceneGeometry: PluginCapabilityClient<'cockpit:scene-geometry'> | undefined;
    readonly aiConfig: PluginCapabilityClient<'cockpit:ai-config'> | undefined;
    readonly notification: PluginCapabilityClient<'platform:notification'> | undefined;
    readonly navigation: PluginCapabilityClient<'platform:navigation'> | undefined;
    readonly pointer: PluginCapabilityClient<'cockpit:live-pointer'> | undefined;
    readonly smartTrack: PluginCapabilityClient<'cockpit:smart-track'> | undefined;
    readonly gimbal: PluginCapabilityClient<'cockpit:gimbal'> | undefined;
    readonly hotkeys: PluginCapabilityClient<'cockpit:hotkeys'> | undefined;
    readonly cockpitContext: PluginCapabilityClient<'cockpit:context'> | undefined;
    readonly map: PluginCapabilityClient<'platform:map'> | undefined;
    readonly audio: PluginCapabilityClient<'platform:audio'> | undefined;
    readonly dialog: PluginCapabilityClient<'platform:dialog'> | undefined;
  };
  /** Mock 后端是否启用（仅切换 HTTP/WS 数据源；设备能力始终真实）。 */
  readonly enableMock: boolean;
  /** 违章抓拍后端 API（Mock 内存实现或 HTTP Adapter）。 */
  readonly laneChangeApi: LaneChangeApi;
  readonly personRoadApi: IllegalRoadApi;
  /** WS 订阅面（Mock 模式为内存事件流，否则透传 ctx.ws）。 */
  readonly ws: PluginWsApi;
  /** 告警协调器（弹窗 + 音效，两模式共用）。 */
  readonly alert: CaptureAlertController;
  readonly getProjectId: () => string | null;
  /** 当前飞行航次；无航次返回 null（gate 阻断开启）。 */
  readonly getFlightId: () => string | null;
  /** 相对媒体 URL 的解析基准（宿主 origin）。 */
  readonly resolveMediaUrl: (url: string) => string;
  /** 上下文快照读取/更新（航次/项目变化时由 activate 比较并更新，getter 立即生效）。 */
  readonly getContextSnapshot: () => CockpitContextState | null;
  setContextSnapshot (next: CockpitContextState): void;
  /** 释放数据源资源（Mock 定时器与订阅；真实模式为空操作）。 */
  dispose (): void;
}

export function resolveTrafficMediaUrl (url: string): string {
  return url === '' || url.startsWith('data:') ? url : new URL(url).href
}

export async function createCockpitRuntimeEnv (
  ctx: TrafficCaptureContext,
  options: {
    /** 告警 Toast 被点击（reveal 记录面板；句柄在 capture module 创建后生效）。 */
    readonly onAlertToastClick: () => void;
  },
): Promise<CockpitRuntimeEnv> {
  const [telemetry, camera, detection, sceneGeometry, aiConfig, notification, navigation, pointer, smartTrack, gimbal, hotkeys, cockpitContext, map, audio, dialog] = await Promise.all([
    ctx.capabilities.get('cockpit:telemetry'),
    ctx.capabilities.get('cockpit:camera'),
    ctx.capabilities.get('cockpit:detection'),
    ctx.capabilities.get('cockpit:scene-geometry'),
    ctx.capabilities.get('cockpit:ai-config'),
    ctx.capabilities.get('platform:notification'),
    ctx.capabilities.get('platform:navigation'),
    ctx.capabilities.get('cockpit:live-pointer'),
    ctx.capabilities.get('cockpit:smart-track'),
    ctx.capabilities.get('cockpit:gimbal'),
    ctx.capabilities.get('cockpit:hotkeys'),
    ctx.capabilities.get('cockpit:context'),
    ctx.capabilities.get('platform:map'),
    ctx.capabilities.get('platform:audio'),
    ctx.capabilities.get('platform:dialog'),
  ])

  // --- 真实驾驶舱上下文（projectId / flightId 动态化；缺失由 gate 阻断） --------

  let contextSnapshot: CockpitContextState | null = cockpitContext ? await cockpitContext.getState() : null
  const enableMock = ctx.config.enableMock
  const getProjectId = (): string | null => contextSnapshot?.projectId ?? null
  const getFlightId = (): string | null => contextSnapshot?.flightId ?? null
  const resolveMediaUrl = (url: string): string => (
    url === '' || url.startsWith('data:') ? url : resolveTrafficMediaUrl(url)
  )

  // --- 数据源：enableMock 时使用插件内 Mock 后端，否则 HTTP Adapter + 宿主 WS ---
  // Controller / View / 设备能力在两种模式下完全一致，后端 ready 后仅需切回配置。

  const mockRuntime = enableMock
    ? createMockTrafficRuntime({ timers: ctx.timers })
    : null
  const invoke = createPluginInvoke(ctx.apiCall)
  const laneChangeApi = mockRuntime?.laneChangeApi ?? createLaneChangeApi(invoke)
  const personRoadApi = mockRuntime?.personRoadApi ?? createIllegalRoadApi(invoke)
  const ws: PluginWsApi = mockRuntime?.ws ?? ctx.ws

  // --- 告警协调器（弹窗 Overlay + 插件自带音效） ----------------------------

  const audioPlayer = audio
    ? await audio.createPlayer({ source: { type: 'preset', sound: 'warning' }, volume: 1, loop: false })
    : undefined
  const alert = createCaptureAlertController({
    audio: audioPlayer,
    timers: ctx.timers,
    logger: ctx.logger,
    onToastClick: options.onAlertToastClick,
  })

  return {
    capabilities: {
      telemetry,
      camera,
      detection,
      sceneGeometry,
      aiConfig,
      notification,
      navigation,
      pointer,
      smartTrack,
      gimbal,
      hotkeys,
      cockpitContext,
      map,
      audio,
      dialog,
    },
    enableMock,
    laneChangeApi,
    personRoadApi,
    ws,
    alert,
    getProjectId,
    getFlightId,
    resolveMediaUrl,
    getContextSnapshot: () => contextSnapshot,
    setContextSnapshot (next) {
      contextSnapshot = next
    },
    dispose () {
      mockRuntime?.dispose()
    },
  }
}
