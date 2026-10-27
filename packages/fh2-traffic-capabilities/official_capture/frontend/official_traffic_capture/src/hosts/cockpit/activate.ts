// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createLaneChangeCockpitModule } from './lane-change/module'
import { createPersonRoadCockpitModule } from './person-road/module'
import { createCaptureModule } from './capture/module'
import type { CaptureModule } from './capture/module'
import { createCaptureModeCoordinator } from './capture/coordinator'
import { createCockpitRuntimeEnv } from './runtime-env'
import type { TrafficCaptureContext } from './context'

/**
 * Cockpit Host 的装配组合根：runtime 环境 → 变道/行人上路两个 feature 模块 →
 * 共享面板；随后接管模式互斥仲裁、航次切换订阅与统一 dispose。
 */
export async function activate (ctx: TrafficCaptureContext) {
  let captureRef: CaptureModule | undefined
  const env = await createCockpitRuntimeEnv(ctx, {
    onAlertToastClick: () => {
      void captureRef?.revealRecordsPanel({ reason: 'capture-alert-clicked' })
    },
  })

  // --- 两个领域模块与父级 Capture UI 显式装配 -------------------------------

  const lane = await createLaneChangeCockpitModule({
    ctx,
    api: env.laneChangeApi,
    telemetry: env.capabilities.telemetry,
    camera: env.capabilities.camera,
    detection: env.capabilities.detection,
    sceneGeometry: env.capabilities.sceneGeometry,
    aiConfig: env.capabilities.aiConfig,
    notification: env.capabilities.notification,
    pointer: env.capabilities.pointer,
    dialog: env.capabilities.dialog,
    map: env.capabilities.map,
    storage: ctx.storage.session,
    blobs: ctx.blobs,
    timers: ctx.timers,
    logger: ctx.logger,
    getProjectId: env.getProjectId,
    getFlightId: env.getFlightId,
    onViolationDetected: message => env.alert.alert(message),
  })

  const personRoad = await createPersonRoadCockpitModule({
    ctx,
    api: env.personRoadApi,
    telemetry: env.capabilities.telemetry,
    camera: env.capabilities.camera,
    detection: env.capabilities.detection,
    smartTrack: env.capabilities.smartTrack,
    aiConfig: env.capabilities.aiConfig,
    gimbal: env.capabilities.gimbal,
    sceneGeometry: env.capabilities.sceneGeometry,
    notification: env.capabilities.notification,
    storage: ctx.storage.session,
    blobs: ctx.blobs,
    ws: env.ws,
    timers: ctx.timers,
    logger: ctx.logger,
    resolveMediaUrl: env.resolveMediaUrl,
    getContextSnapshot: env.getContextSnapshot,
    getFlightId: env.getFlightId,
    getProjectId: env.getProjectId,
    onViolationDetected: message => env.alert.alert(message),
    hotkeys: env.capabilities.hotkeys,
    map: env.capabilities.map,
    navigation: env.capabilities.navigation,
  })

  const coordinator = createCaptureModeCoordinator({
    laneChange: lane,
    personRoad,
    env,
    logger: ctx.logger,
    resetCaptureSession: () => captureRef?.resetSession(),
  })
  const capture = await createCaptureModule({ ctx, env, laneChange: lane, personRoad, coordinator })
  captureRef = capture

  // --- 上下文订阅：航次/项目变化后刷新门控 --------------------------------------

  const initialRecovery = coordinator.recover()
  const cockpitContext = env.capabilities.cockpitContext
  const contextSubscription = cockpitContext
    ? await cockpitContext.onStateChanged((next) => {
      void coordinator.applyContextTransition(next).catch((error: unknown) => {
        ctx.logger.warn('切换抓拍航次失败', error instanceof Error ? error.message : String(error))
      })
    })
    : undefined

  let initialRecoveryError: unknown
  try {
    await initialRecovery
  } catch (error) {
    initialRecoveryError = error
  }
  await coordinator.idle()
  if (initialRecoveryError !== undefined) throw initialRecoveryError

  return {
    dispose: async () => {
      // 卸载逐模块尽力清理：单个模块失败只记录告警，不阻断其余模块释放
      const cleanupSteps: Array<() => void | Promise<void>> = [
        () => contextSubscription?.dispose(),
        () => coordinator.dispose(),
        () => capture.dispose(),
        () => personRoad.dispose(),
        () => lane.dispose(),
        () => env.dispose(),
      ]
      for (const step of cleanupSteps) {
        try {
          await step()
        } catch (error) {
          ctx.logger.warn('交通抓拍卸载清理失败', error instanceof Error ? error.message : String(error))
        }
      }
    },
  }
}
