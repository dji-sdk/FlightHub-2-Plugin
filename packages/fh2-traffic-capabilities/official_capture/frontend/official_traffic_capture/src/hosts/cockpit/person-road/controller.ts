// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import type {
  Disposable,
  JsonValue,
  PluginCapabilityClient,
  PluginLogger,
  PluginState,
  PluginWsApi,
  TelemetryState,
  TrackedTimers,
} from 'fh2-plugin-sdk'
import { ALLOWED_FLIGHT_MODES, type CaptureModeSettingsSnapshot, type RecordingLease } from '../../../shared/capture-mode'
import { dronePosition, droneTimestamp, gatewaySn, laserPosition, modeCode } from '../../../shared/cockpit-telemetry'
import type { PersonRoadSkipHintPhase } from '../../../views/person-road-skip-hint/contract'
import type { IllegalRoadApi } from './api'
import type { PersonRoadRecord } from './model'

/**
 * 行人上路抓拍（原「违章上路抓拍」，用户决策更名；后端 scene 保持 illegal_road）。
 *
 * 对齐原生 use-auto-capture 两阶段编排：
 * - Phase 1（无业务副作用）：保存偏好 → 预瞄准 → SPZ 稳定跟踪（厚 Provider 编排）
 * - Phase 2：tracking/start → 远景拍照 → 变焦稳定 → 近景拍照 → 码流截图 →
 *   切录像+全程录像 → 临时记录 + 告警；15s 超时 / 目标丢失 / K 键跳过进入 finalize
 * - finalize：停录像 → 停跟踪 → 变焦恢复 → lookAt 恢复（位移阈值判定）→ 切回拍照 →
 *   tracking/stop → 冷却
 * - 手动操作（相机模式/录像，经 internalOps 抑制自身回推）→ 自动关闭；
 *   控制权丢失 → 挂起（保持 enabled 与后端 status）；飞行模式出白名单 → 关闭。
 */

const ROUND_TIMEOUT_MS = 15_000
const COOLDOWN_MS = 1_500
const COOLING_DOWN_MS = 1_000
const ZOOM_STABLE_TIMEOUT_MS = 8_000
const TARGET_LOST_GRACE_MS = 5_000
const MODE_BLOCKED_DEBOUNCE_MS = 2_000
const AIM_SETTLE_MS = 1_000
/** 停录像后设备仍需封存视频文件，OSD recording_state=0 不代表可切模式；毫秒级连发 switchMode 会被拒（327009）。 */
const POST_RECORD_STOP_SETTLE_MS = 1_000
/** 飞机时间戳心跳观测间隔：诊断远景拍照时间窗口错位，仅 console debug，不进存储诊断。 */
const DRONE_TIMESTAMP_HEARTBEAT_MS = 5_000
/** 参与挑选的目标语义状态（对应原生 ObjectState {1,2,3,7}——上路场景不含 not-confident）。 */
const PICKABLE_TARGET_STATES = new Set(['tracked', 'vision-beacon-fused', 'auxiliary-tracked', 'redetected'])
/** 行人目标类型（Mock 语义字符串；真实宿主对齐 TYPE_PERSON）。 */
const PERSON_TARGET_TYPE = '2'

const MOVED_HORIZONTAL_THRESHOLD_M = 0.5
const MOVED_VERTICAL_THRESHOLD_M = 0.3

export type PersonRoadPhase = 'idle' | 'detected' | 'recording' | 'cooling-down'

export interface PersonRoadControllerDeps {
  readonly api: IllegalRoadApi;
  readonly telemetry: PluginCapabilityClient<'cockpit:telemetry'> | undefined;
  readonly camera: PluginCapabilityClient<'cockpit:camera'> | undefined;
  readonly detection: PluginCapabilityClient<'cockpit:detection'> | undefined;
  readonly smartTrack: PluginCapabilityClient<'cockpit:smart-track'> | undefined;
  readonly aiConfig: PluginCapabilityClient<'cockpit:ai-config'> | undefined;
  readonly gimbal: PluginCapabilityClient<'cockpit:gimbal'> | undefined;
  readonly sceneGeometry: PluginCapabilityClient<'cockpit:scene-geometry'> | undefined;
  readonly notification: PluginCapabilityClient<'platform:notification'> | undefined;
  readonly storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  readonly blobs: { put(key: string, value: Blob): Promise<void>; url(key: string): Promise<string | undefined> };
  readonly ws: PluginWsApi;
  readonly timers: TrackedTimers;
  readonly logger: PluginLogger;
  readonly resolveMediaUrl: (url: string) => string;
  /** 当前飞行航次；无航次返回 null（gate 阻断开启）。开启成功后冻结到本轮结束。 */
  readonly getFlightId: () => string | null;
  readonly getProjectId: () => string | null;
  /** 抓拍确认后的统一告警入口（总开关/弹窗/音效由 activate 层告警协调器裁决）。 */
  readonly onViolationDetected?: (message: string) => void;
  readonly now?: () => number;
}

export interface PersonRoadController {
  readonly settingsState: PluginState<CaptureModeSettingsSnapshot>;
  readonly skipHintState: PluginState<{ phase: PersonRoadSkipHintPhase }>;
  readonly recordsState: PluginState<{ records: readonly PersonRoadRecord[] }>;
  readonly settings: { setEnabled(input: { enabled: boolean }): Promise<void> };
  skipCurrentTarget(): Promise<void>;
  recover(): Promise<void>;
  /** 外部上下文变化后刷新开关门控呈现。 */
  refreshGate(): void;
  resetSession(): void;
  attachUi(ui: { skipHint: { update(patch: { visible?: boolean }): Promise<void> } }): void;
  dispose(): Promise<void>;
}

const STORAGE_PREFERRED_ZOOM = 'person-road:preferred-zoom'
const STORAGE_PREFERRED_LOOK_AT = 'person-road:preferred-look-at'
const STORAGE_DIAGNOSTICS = 'person-road:diagnostics'
const MAX_DIAGNOSTIC_ENTRIES = 300

interface RestoreLookAtPoint {
  readonly lng: number;
  readonly lat: number;
  readonly height: number;
}

/**
 * 每轮恢复只读取这个不可变快照，不能直接读取会话偏好。
 * 否则异步 OSD/存储回写可能把 SPZ 自动变焦后的值误当成用户起始值。
 */
interface RoundRestoreSnapshot {
  readonly zoom: number | null;
  readonly lookAt: RestoreLookAtPoint | null;
  readonly dronePosition: { readonly lng: number; readonly lat: number; readonly height: number } | null;
}

interface DetectionTarget {
  readonly targetId: string;
  readonly type: string;
  readonly state: string;
  readonly bbox: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export function createPersonRoadController (deps: PersonRoadControllerDeps): PersonRoadController {
  const { api, timers, logger } = deps
  const now = deps.now ?? Date.now
  /** 本轮冻结的航次：enable 时读取，disable/recover 重置；未开启时按需回读当前值。 */
  let activeFlightId: string | null = null
  let activeSessionId: string | null = null
  let operationGeneration = 0
  let disposed = false
  const flightIdOrEmpty = (): string => activeFlightId ?? deps.getFlightId() ?? ''

  const state = {
    enabled: false,
    phase: 'idle' as PersonRoadPhase,
    switchBusy: false,
    currentTrackingId: null as string | null,
    currentTrackingEndedAt: null as number | null,
    currentTargetId: null as string | null,
    cooldownUntil: 0,
    records: [] as readonly PersonRoadRecord[],
    preferredZoom: null as number | null,
    preferredLookAt: null as RestoreLookAtPoint | null,
  }

  const settingsState = createViewState<CaptureModeSettingsSnapshot>({
    enabled: false,
    canEnable: false,
    disabledReason: null,
    switchBusy: false,
  })
  const skipHintState = createViewState<{ phase: PersonRoadSkipHintPhase }>({ phase: 'hidden' })
  const recordsState = createViewState<{ records: readonly PersonRoadRecord[] }>({ records: [] })

  let ui: { skipHint: { update(patch: { visible?: boolean }): Promise<void> } } | undefined
  /**
   * 提示条阶段：LookAt 完成后 confirming（识别确认中…），后端 tracking/start 返回
   * trackingId 后 ready（按 K 退出）；finalize/skip/失败/挂起/关闭一律回 hidden。
   */
  let hintPhase: PersonRoadSkipHintPhase = 'hidden'
  let skipHintUpdateTail = Promise.resolve()
  const disposables: Array<{ dispose(): void | Promise<void> }> = []
  let telemetryState: TelemetryState | undefined
  let detectionSubscription: Disposable | undefined
  let roundTimeout: unknown
  let coolingTimer: unknown
  let targetLostTimer: unknown
  let modeBlockedTimer: unknown
  let heartbeatTimer: unknown
  let heartbeatInFlight = false
  let suspended = false
  /** 本轮编排代数：finalize/disable 递增使旧异步链失效，防止关闭后旧 Promise 继续拍照/录像。 */
  let roundGeneration = 0
  /** 自身设备编排抑制：期间收到的相机状态变化不判为用户手动操作。 */
  let internalOps = 0
  let roundRestoreSnapshot: RoundRestoreSnapshot | null = null
  let aiRepairing = false
  let recordingLease: RecordingLease | undefined
  let recordingRevocation: { dispose (): void | Promise<void> } | undefined
  let finalizePromise: Promise<void> | undefined
  let resumePromise: Promise<void> | undefined
  let recordsRefreshGeneration = 0
  let diagnosticWrite = Promise.resolve()
  let latestPersonTargets: readonly DetectionTarget[] = []

  function trace (event: string, detail: Record<string, unknown> = {}): void {
    const entry = { at: now(), event, phase: state.phase, enabled: state.enabled, ...detail }
    logger.debug(`[person-road] ${event}`)
    diagnosticWrite = diagnosticWrite.then(async () => {
      const existing = await deps.storage.get(STORAGE_DIAGNOSTICS)
      const entries = Array.isArray(existing) ? existing : []
      await deps.storage.set(STORAGE_DIAGNOSTICS, [...entries, entry].slice(-MAX_DIAGNOSTIC_ENTRIES))
    }).catch(() => {})
  }

  function dockSnOr (fallback: string): string {
    return gatewaySn(telemetryState) ?? fallback
  }

  function businessTimestamp (operation: string): number {
    const timestamp = droneTimestamp(telemetryState)
    const browserNow = now()
    if (timestamp !== null) {
      logger.debug('[person-road] 业务时间戳', {
        operation,
        used: 'drone',
        droneTs: timestamp,
        browserNow,
        driftMs: browserNow - timestamp,
      })
      return timestamp
    }
    logger.debug('[person-road] 业务时间戳', {
      operation,
      used: 'browser-fallback',
      droneTs: null,
      browserNow,
      driftMs: null,
    })
    logger.warn('飞机时间戳不可用，回退浏览器时间', { operation, fallback: browserNow })
    return browserNow
  }

  /**
   * 飞机时间戳心跳观测（插件存活期每 5s 一拍）：
   * 区分「业务消费的缓存值」与「SDK 现读值」，用于实测远景拍照时间窗口错位根因——
   * 云端物模型 timestamp 冻结 / 未上报 / 订阅未达。仅 console debug，不走 trace()
   * （存储诊断 300 条上限会被心跳刷穿）。
   */
  function startDroneTimestampHeartbeat (): void {
    if (!deps.telemetry) return
    heartbeatTimer = timers.setInterval(() => {
      if (heartbeatInFlight || disposed) return
      heartbeatInFlight = true
      void Promise.resolve(deps.telemetry!.getState())
        .then((fresh) => {
          if (disposed) return
          const cachedTs = droneTimestamp(telemetryState)
          const browserNow = now()
          logger.debug('[person-road] 飞机时间戳观测', {
            droneTs: cachedTs,
            freshDroneTs: droneTimestamp(fresh),
            browserNow,
            driftMs: cachedTs === null ? null : browserNow - cachedTs,
            timeDiffDeviceAndWeb: fresh.drone.link.timeDiffDeviceAndWeb,
          })
        })
        .catch(() => {})
        .finally(() => {
          heartbeatInFlight = false
        })
    }, DRONE_TIMESTAMP_HEARTBEAT_MS)
  }

  function gateReason (): string | null {
    if (!deps.aiConfig) return 'AI 配置能力不可用'
    if (!deps.camera) return '相机能力不可用'
    if (!deps.detection) return 'AI 检测能力不可用'
    if (!deps.smartTrack) return '智能跟踪能力不可用'
    const telemetry = telemetryState
    if (!telemetry) return '遥测不可用'
    if (!telemetry.control.payload.hasControl) return '请先获取负载控制权'
    const currentModeCode = modeCode(telemetry)
    if (currentModeCode === null || !ALLOWED_FLIGHT_MODES.has(currentModeCode)) return '当前飞行器状态不可开启行人上路抓拍'
    if (!gatewaySn(telemetry)) return '无法获取机场 SN'
    if (deps.getProjectId() === null) return '当前无项目，无法开启抓拍'
    if (deps.getFlightId() === null) return '当前无飞行航次，无法开启抓拍'
    return null
  }

  function pushSettings (): void {
    const reason = state.enabled ? null : gateReason()
    settingsState.update(() => ({
      enabled: state.enabled,
      canEnable: reason === null,
      disabledReason: reason,
      switchBusy: state.switchBusy,
    }))
  }

  function pushSkipHint (): void {
    const phase = hintPhase
    skipHintState.update(() => ({ phase }))
    const handle = ui?.skipHint
    if (!handle) return
    skipHintUpdateTail = skipHintUpdateTail
      .then(() => handle.update({ visible: phase !== 'hidden' }))
      .catch((error: unknown) => {
        logger.warn('更新行人抓拍提示条可见性失败', { message: error instanceof Error ? error.message : String(error) })
      })
  }

  function hideSkipHint (): void {
    hintPhase = 'hidden'
    pushSkipHint()
  }

  function pushRecords (): void {
    // 记录数组引用未变时不广播，避免无变化刷新驱动预览订阅与 View 状态重放
    recordsState.update(current => (current.records === state.records ? current : { records: state.records }))
  }

  async function notify (intent: 'info' | 'success' | 'warning' | 'error', message: string): Promise<void> {
    try {
      // Capability Client 跨 SDK 后统一 Promise 语义，必须 await 才能吞掉异步展示失败
      await deps.notification?.show({ key: `person-road:${intent}:${now()}`, message, intent, durationMs: 4000 })
    } catch {
      // 通知展示失败不阻断编排
    }
  }

  // === 开关 ===============================================================

  async function ensurePersonAiConfig (reason: string): Promise<boolean> {
    const result = await deps.aiConfig!.ensure({
      model: 'dji-visible',
      recognitionEnabled: true,
      targetTypes: ['person'],
    })
    const current = await deps.aiConfig!.getState()
    // Provider 已负责模型与识别开关编排；插件只复核本业务真正依赖的 PERSON 是否生效。
    const confirmed = result.confirmed && current.targetTypes.includes('person')
    trace('enable.ai-config', {
      reason,
      confirmed,
      providerConfirmed: result.confirmed,
      providerReason: result.reason,
      model: current.model,
      recognitionEnabled: current.recognitionEnabled,
      targetTypes: current.targetTypes,
    })
    return confirmed
  }

  async function enable (generation: number): Promise<void> {
    if (state.enabled || state.switchBusy) return
    const reason = gateReason()
    if (reason !== null) {
      await notify('warning', `行人上路抓拍开启失败：${reason}`)
      pushSettings()
      return
    }
    state.switchBusy = true
    pushSettings()
    try {
      if (!await ensurePersonAiConfig('initial')) {
        await notify('warning', 'AI 识别配置失败：未能启用“人”识别')
        return
      }

      // 用户可能在开启前使用过智能跟踪。先恢复干净设备状态，避免把 SPZ 高倍变焦
      // 记录成用户偏好；这段只发生在明确拥有负载控制权的 enable 路径。
      const smartTrackState = await deps.smartTrack!.getState()
      if (generation !== operationGeneration) return
      if (smartTrackState.phase !== 'off') {
        await withInternal(() => deps.smartTrack!.stop())
        await withInternal(() => deps.camera!.ensureZoom(1))
      }

      // 开启前设备可能正在录像：录像中 switchMode 会被设备拒绝（327009），
      // 先接管停止既有录像再切拍照模式；停止失败则友好提示用户手动关闭。
      const cameraRecording = (await deps.camera!.getState())?.recording === true
      if (generation !== operationGeneration) return
      if (cameraRecording) {
        try {
          const cleanupLease = await withInternal(() => deps.camera!.acquireRecording({ takeover: true })) as RecordingLease
          if (generation !== operationGeneration) {
            await cleanupLease.dispose()
            return
          }
          await withInternal(() => cleanupLease.stop())
          if (generation !== operationGeneration) return
          await delay(POST_RECORD_STOP_SETTLE_MS)
          if (generation !== operationGeneration) return
        } catch (error) {
          trace('enable.stop-recording.failed', { message: error instanceof Error ? error.message : String(error) })
          await notify('warning', '相机正在录像，请手动停止录像后再开启行人上路抓拍')
          return
        }
      }
      await withInternal(() => deps.camera!.ensureMode('photo'))
      if (generation !== operationGeneration) return

      // 多个设备命令之间控制权可能被其它 tab 抢走，提交 enabled 前必须重新校验。
      const finalReason = gateReason()
      if (finalReason !== null) {
        await notify('warning', `行人上路抓拍开启失败：${finalReason}`)
        return
      }
      await captureSessionBaseline()
      if (generation !== operationGeneration) return
      // SPZ、相机模式等设备准备期间，原生 UI 仍可能覆盖 AI filter；提交前再确保一次。
      if (!await ensurePersonAiConfig('before-commit')) {
        await notify('warning', 'AI 识别配置失败：未能启用“人”识别')
        return
      }
      const commitReason = gateReason()
      if (commitReason !== null) {
        await notify('warning', `行人上路抓拍开启失败：${commitReason}`)
        return
      }
      const projectId = deps.getProjectId()
      const flightId = deps.getFlightId()
      const dockSn = dockSnOr('')
      if (!projectId || !flightId || !dockSn) throw new Error('抓拍上下文不完整')
      const session = await api.startSession({ projectId, dockSn, flightId })
      if (generation !== operationGeneration) {
        await stopSessionBestEffort(session.sessionId)
        return
      }
      try {
        await attachDetection()
      } catch (error) {
        // 检测订阅失败时补偿关闭已创建的 Session，避免后端会话悬挂
        await stopSessionBestEffort(session.sessionId)
        throw error
      }
      if (generation !== operationGeneration) {
        detectionSubscription?.dispose()
        detectionSubscription = undefined
        await stopSessionBestEffort(session.sessionId)
        return
      }
      activeSessionId = session.sessionId
      activeFlightId = flightId
      state.enabled = true
      state.phase = 'idle'
      state.cooldownUntil = 0
      suspended = false
      pushSettings()
      pushSkipHint()
      if (session.resumed) {
        await refreshTrackings()
      } else {
        recordsRefreshGeneration += 1
        state.records = []
        pushRecords()
      }
      await notify('success', '行人上路抓拍已开启')
      trace('enable.completed', {
        zoom: state.preferredZoom,
        lookAt: state.preferredLookAt,
      })
    } catch (error) {
      trace('enable.failed', { message: error instanceof Error ? error.message : String(error) })
      await notify('error', `行人上路抓拍开启失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    } finally {
      if (generation === operationGeneration) {
        state.switchBusy = false
        pushSettings()
      }
    }
  }

  async function disable (reason: string, generation = ++operationGeneration): Promise<void> {
    hideSkipHint()
    if (!state.enabled) {
      if (generation === operationGeneration) state.switchBusy = false
      pushSettings()
      return
    }
    state.switchBusy = true
    pushSettings()
    logger.info('关闭行人上路抓拍', { reason })
    const sessionEndedAt = businessTimestamp('h_illegalRoad_stopSession')
    try {
      await finalizeRound('disable')
    } catch (error) {
      logger.warn('结束当前 Tracking 失败，将由 stop-session 统一收敛', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
    const sessionId = activeSessionId
    try {
      if (sessionId) {
        const result = await api.stopSession({ sessionId, endedAt: sessionEndedAt })
        if (result.closedTrackingIds.length > 0) {
          logger.warn('关闭 Session 时收尾了未关闭的行人 Tracking', { trackingIds: result.closedTrackingIds })
          await refreshTrackings()
        }
      }
    } catch (error) {
      if (generation === operationGeneration) {
        state.switchBusy = false
        pushSettings()
      }
      await notify('error', `行人上路抓拍关闭失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
    if (generation !== operationGeneration) return
    state.currentTrackingId = null
    state.currentTrackingEndedAt = null
    state.enabled = false
    state.phase = 'idle'
    state.currentTargetId = null
    state.preferredZoom = null
    state.preferredLookAt = null
    roundRestoreSnapshot = null
    await Promise.all([
      deps.storage.set(STORAGE_PREFERRED_ZOOM, null),
      deps.storage.set(STORAGE_PREFERRED_LOOK_AT, null),
    ]).catch(() => {})
    activeFlightId = null
    activeSessionId = null
    detectionSubscription?.dispose()
    detectionSubscription = undefined
    suspended = false
    state.switchBusy = false
    pushSettings()
    pushSkipHint()
    if (reason !== 'disable') await notify('info', '行人上路抓拍已关闭')
  }

  // === 检测目标挑选 ========================================================

  async function attachDetection (): Promise<void> {
    if (detectionSubscription || !deps.detection) return
    let subscription: Disposable
    try {
      subscription = await deps.detection.onFrame(frame => handleDetectionFrame(frame), { maxFps: 30 })
    } catch {
      subscription = await deps.detection.onFrame(frame => handleDetectionFrame(frame), { maxFps: 10 })
    }
    detectionSubscription = subscription
  }

  function handleDetectionFrame (frame: { targets: readonly DetectionTarget[] }): void {
    const candidates = frame.targets.filter(target =>
      target.type === PERSON_TARGET_TYPE
      && PICKABLE_TARGET_STATES.has(target.state)
      && target.bbox.width > 0 && target.bbox.height > 0)
    // LookAt 会改变画面并触发 SEI 目标 ID 更新；即使本轮已进入 detected，也必须持续保留最新帧。
    latestPersonTargets = candidates.map(target => ({ ...target, bbox: { ...target.bbox } }))
    if (!state.enabled || suspended) return
    if (state.phase !== 'idle' || now() < state.cooldownUntil) return
    if (candidates.length === 0) return
    // 原生：IDLE 态按 bbox 面积最大挑选
    const best = candidates.reduce((left, right) => (
      left.bbox.width * left.bbox.height >= right.bbox.width * right.bbox.height ? left : right
    ))
    // 失败已由 startCaptureFlow 内部 toast；此处仅消费收尾拒绝避免 unhandled rejection
    void startCaptureFlow(best).catch((error) => {
      logger.warn('本轮行人抓拍收尾失败', { message: error instanceof Error ? error.message : String(error) })
    })
  }

  // === 两阶段编排 ==========================================================

  async function startCaptureFlow (target: DetectionTarget): Promise<void> {
    if (!deps.camera || !deps.smartTrack) {
      await notify('error', '相机或智能跟踪能力不可用，无法抓拍')
      return
    }
    const camera = deps.camera
    const smartTrack = deps.smartTrack
    // generation 必须在第一个异步调用之前建立；否则关闭发生在 getState() 期间时，
    // 旧流程会在恢复后创建“新一代”并继续发送设备命令。
    const generation = ++roundGeneration
    const stale = (): boolean => generation !== roundGeneration || !state.enabled || suspended
    hideSkipHint()
    state.phase = 'detected'
    state.currentTargetId = target.targetId
    try {
      const currentCamera = await camera.getState()
      if (stale()) return
      const fallbackLookAt = laserPosition(telemetryState)
      roundRestoreSnapshot = {
        zoom: state.preferredZoom ?? currentCamera.zoom,
        lookAt: state.preferredLookAt
          ? { ...state.preferredLookAt }
          : fallbackLookAt ? { ...fallbackLookAt } : null,
        dronePosition: dronePosition(telemetryState),
      }
      trace('round.baseline', {
        targetId: target.targetId,
        zoom: roundRestoreSnapshot.zoom,
        lookAt: roundRestoreSnapshot.lookAt,
        dronePosition: roundRestoreSnapshot.dronePosition,
      })
      // --- Phase 1：无业务副作用 ---
      await withInternal(() => camera.ensureMode('photo'))
      if (stale()) return
      trace('round.photo-mode.completed')

      // 预瞄准（best-effort）：bbox 中心作为视频点
      const center = { x: target.bbox.x + target.bbox.width / 2, y: target.bbox.y + target.bbox.height / 2 }
      trace('round.aim.started', { targetId: target.targetId, center })
      await deps.gimbal?.lookAt(center).catch(() => {})
      // LookAt 已发出：SPZ 稳定与后端 tracking 创建期间展示「识别确认中…」
      hintPhase = 'confirming'
      pushSkipHint()
      await delay(AIM_SETTLE_MS)
      if (stale()) return
      const refreshedTarget = pickClosestToCenterTarget(latestPersonTargets)
      if (!refreshedTarget) throw new Error('LookAt 后已无可跟踪行人')
      state.currentTargetId = refreshedTarget.targetId
      trace('round.aim.completed', {
        initialTargetId: target.targetId,
        refreshedTargetId: refreshedTarget.targetId,
      })

      // SPZ 稳定跟踪（厚 Provider：enable→track→等待权威 tracking，失败抛错）
      trace('round.spz.started', { targetId: refreshedTarget.targetId })
      const stableTrack = await smartTrack.start({ kind: 'detection-target', targetId: refreshedTarget.targetId })
      state.currentTargetId = stableTrack.targetId ?? refreshedTarget.targetId
      trace('round.spz.completed', { targetId: state.currentTargetId })
      if (stale()) return

      // --- Phase 2：允许业务数据 ---
      const sessionId = activeSessionId
      if (!sessionId) throw new Error('行人抓拍会话不存在')
      const startedAt = businessTimestamp('h_illegalRoad_startTracking')
      const startResult = await api.startTracking({ sessionId, startedAt })
      if (stale()) {
        const endedAt = state.currentTrackingEndedAt ?? businessTimestamp('h_illegalRoad_stopTracking:late-start')
        await api.stopTracking({ trackingId: startResult.trackingId, endedAt }).catch((error) => {
          logger.warn('清理迟到 Tracking 失败', { message: error instanceof Error ? error.message : String(error) })
        })
        return
      }
      state.currentTrackingId = startResult.trackingId
      state.currentTrackingEndedAt = null
      // 后端 tracking 已创建：K 键从此刻起可结束本轮
      hintPhase = 'ready'
      pushSkipHint()

      // 先发布占位记录，再触发拍照；否则 media_added 先回填的后端记录会被后续占位写入覆盖。
      state.records = [{
        trackingId: startResult.trackingId,
        folderId: 0,
        startedAt: startResult.startedAt,
        endedAt: null,
        previewPhotoUrl: null,
        originalPhotoUrl: null,
        closeReason: '',
        position: (() => {
          const position = dronePosition(telemetryState)
          return position ? { lng: position.lng, lat: position.lat } : null
        })(),
        pending: true,
      }, ...state.records.filter(record => record.trackingId !== startResult.trackingId)]
      pushRecords()

      // 远景拍照（用户当前视角，无变焦）
      try {
        await withInternal(() => camera.takePhoto())
        trace('round.photo-far.completed', { trackingId: startResult.trackingId })
      } catch (error) {
        trace('round.photo-far.failed', { message: error instanceof Error ? error.message : String(error) })
        logger.warn('远景拍照失败，继续本轮编排')
      }
      if (stale()) return

      await waitForZoomStable()
      if (stale()) return

      // 近景拍照（SPZ 自动变焦后）
      try {
        await withInternal(() => camera.takePhoto())
        trace('round.photo-near.completed', { trackingId: startResult.trackingId })
      } catch (error) {
        trace('round.photo-near.failed', { message: error instanceof Error ? error.message : String(error) })
        logger.warn('近景拍照失败，继续本轮编排')
      }
      if (stale()) return

      // 码流截图：本地缩略图
      let screenshotUrl: string | null = null
      try {
        const frame = await camera.captureFrame({ scale: 0.5, mime: 'image/png' })
        const blobKey = `person-road-snapshot:${flightIdOrEmpty()}:${startResult.trackingId}`
        await deps.blobs.put(blobKey, frame.blob)
        screenshotUrl = (await deps.blobs.url(blobKey)) ?? null
      } catch (error) {
        logger.warn('码流截图失败', { message: error instanceof Error ? error.message : String(error) })
      }
      if (stale()) return

      // 切录像模式并接管录像
      const lease = await withInternal(() => camera.acquireRecording({ takeover: true })) as RecordingLease
      if (stale()) {
        if (suspended) await lease.dispose()
        else await withInternal(() => lease.stop()).catch(() => {})
        return
      }
      const revocation = await lease.onRevoked(reason => void onRecordingRevoked(reason).catch((error) => {
        logger.warn('录像撤销后收尾失败', { message: error instanceof Error ? error.message : String(error) })
      }))
      if (stale()) {
        await revocation.dispose()
        if (suspended) await lease.dispose()
        else await withInternal(() => lease.stop()).catch(() => {})
        return
      }
      recordingLease = lease
      recordingRevocation = revocation

      state.phase = 'recording'
      trace('round.recording.started', { trackingId: startResult.trackingId })
      pushSkipHint()

      roundTimeout = timers.setTimeout(() => {
        void finalizeRound('round-timeout').catch((error) => {
          logger.warn('本轮超时收尾失败', { message: error instanceof Error ? error.message : String(error) })
        })
      }, ROUND_TIMEOUT_MS)

      // 媒体回填可能已把记录升级为后端权威状态；截图只能补 pending 记录的空字段。
      state.records = state.records.map(record => record.trackingId === startResult.trackingId && record.pending
        ? {
            ...record,
            previewPhotoUrl: record.previewPhotoUrl ?? screenshotUrl,
            originalPhotoUrl: record.originalPhotoUrl ?? screenshotUrl,
          }
        : record)
      pushRecords()
      if (startResult.supersededTrackingId !== '') {
        logger.warn('后端收尾了未关闭的行人 Tracking', { trackingId: startResult.supersededTrackingId })
        void refreshTrackings()
      }

      // 统一告警入口（弹窗/音效由 activate 层告警协调器裁决）
      deps.onViolationDetected?.('发现目标')
    } catch (error) {
      if (stale()) return
      const message = error instanceof Error ? error.message : String(error)
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : null
      const smartTrackState = await smartTrack.getState().catch(() => null)
      trace('round.failed', { message, code, smartTrackState })
      logger.info('本轮行人抓拍编排失败，进入收尾', { message })
      await notify('error', `行人上路本轮抓拍启动失败：${message}`)
      await finalizeRound('phase-failed')
    }
  }

  /** LookAt 后按最新帧选择最接近画面中心的行人，避免继续使用转动前已经失效的 SEI ID。 */
  function pickClosestToCenterTarget (targets: readonly DetectionTarget[]): DetectionTarget | null {
    let selected: DetectionTarget | null = null
    let minimumDistance = Number.POSITIVE_INFINITY
    for (const target of targets) {
      const centerX = target.bbox.x + target.bbox.width / 2
      const centerY = target.bbox.y + target.bbox.height / 2
      const distance = (centerX - 0.5) ** 2 + (centerY - 0.5) ** 2
      if (distance < minimumDistance) {
        selected = target
        minimumDistance = distance
      }
    }
    return selected
  }

  async function captureSessionBaseline (): Promise<void> {
    const cameraState = await deps.camera!.getState()
    state.preferredZoom = cameraState.zoom !== null && cameraState.zoom > 0 ? cameraState.zoom : 1
    const laser = laserPosition(telemetryState)
    state.preferredLookAt = laser ? { ...laser } : null
    await Promise.all([
      deps.storage.set(STORAGE_PREFERRED_ZOOM, state.preferredZoom),
      deps.storage.set(STORAGE_PREFERRED_LOOK_AT, state.preferredLookAt),
    ])
  }

  async function restorePreferences (): Promise<void> {
    const zoom = await deps.storage.get(STORAGE_PREFERRED_ZOOM)
    if (typeof zoom === 'number' && zoom > 0) state.preferredZoom = zoom
    const lookAt = await deps.storage.get(STORAGE_PREFERRED_LOOK_AT)
    if (lookAt !== null && typeof lookAt === 'object'
      && typeof (lookAt as { lng?: unknown }).lng === 'number'
      && typeof (lookAt as { lat?: unknown }).lat === 'number'
      && typeof (lookAt as { height?: unknown }).height === 'number') {
      state.preferredLookAt = {
        lng: (lookAt as RestoreLookAtPoint).lng,
        lat: (lookAt as RestoreLookAtPoint).lat,
        height: (lookAt as RestoreLookAtPoint).height,
      }
    }
  }

  function delay (ms: number): Promise<void> {
    return new Promise(resolve => timers.setTimeout(resolve, ms))
  }

  /** 对齐原生：采集 zoom 变化值，四帧带宽小于 3 且方向发生反转时认为物理变焦已稳定。 */
  async function waitForZoomStable (): Promise<void> {
    if (!deps.camera) return
    let lastZoom: number | null
    try {
      lastZoom = (await deps.camera.getState()).zoom
    } catch {
      return
    }
    return new Promise<void>((resolve) => {
      const samples: number[] = []
      let finished = false
      let poll: unknown
      let timeout: unknown
      const finish = (): void => {
        if (finished) return
        finished = true
        if (poll !== undefined) timers.clearInterval(poll)
        if (timeout !== undefined) timers.clearTimeout(timeout)
        resolve()
      }
      timeout = timers.setTimeout(finish, ZOOM_STABLE_TIMEOUT_MS)
      poll = timers.setInterval(() => {
        void deps.camera!.getState().then((cameraState) => {
          const zoom = cameraState.zoom
          if (zoom === null || zoom === lastZoom) return
          lastZoom = zoom
          samples.push(zoom)
          if (samples.length > 4) samples.shift()
          if (samples.length < 4) return
          const band = Math.max(...samples) - Math.min(...samples)
          let previousSign = 0
          let directionChanged = false
          for (let index = 1; index < samples.length; index++) {
            const difference = samples[index]! - samples[index - 1]!
            if (difference === 0) continue
            const sign = difference > 0 ? 1 : -1
            if (previousSign !== 0 && sign !== previousSign) directionChanged = true
            previousSign = sign
          }
          if (band < 3 && directionChanged) finish()
        }).catch(() => {
          finish()
        })
      }, 200)
    })
  }

  // === finalize 六步收尾 ====================================================

  function finalizeRound (reason: string): Promise<void> {
    if (finalizePromise) return finalizePromise
    if (state.currentTrackingEndedAt === null && (state.phase === 'detected' || state.phase === 'recording')) {
      state.currentTrackingEndedAt = businessTimestamp('h_illegalRoad_stopTracking')
    }
    finalizePromise = runFinalizeRound(reason).finally(() => {
      finalizePromise = undefined
    })
    return finalizePromise
  }

  async function runFinalizeRound (reason: string): Promise<void> {
    hideSkipHint()
    if (state.phase !== 'detected' && state.phase !== 'recording') {
      state.phase = 'idle'
      await stopCurrentTracking()
      return
    }
    trace('round.finalize.started', { reason })
    // 使在途编排链失效
    roundGeneration += 1
    if (roundTimeout !== undefined) {
      timers.clearTimeout(roundTimeout)
      roundTimeout = undefined
    }
    if (targetLostTimer !== undefined) {
      timers.clearTimeout(targetLostTimer)
      targetLostTimer = undefined
    }
    state.phase = 'cooling-down'

    // 1. 停录像（本插件启动的那一代）
    if (recordingLease) {
      const lease = recordingLease
      recordingLease = undefined
      const revocation = recordingRevocation
      recordingRevocation = undefined
      await revocation?.dispose()
      await withInternal(() => lease.stop()).catch((error) => {
        logger.warn('停止录像失败', { message: error instanceof Error ? error.message : String(error) })
      })
    }
    if (suspended) return

    // 2+3. 停跟踪目标 + 关 SPZ（厚 Provider stop 等待权威 off）
    await withInternal(async () => {
      await deps.smartTrack?.stop()
    }).catch(() => {})
    if (suspended) return

    const restoreSnapshot = roundRestoreSnapshot

    // 4. 变焦恢复（相机参数与位置无关，即使飞机移动也始终恢复）。
    if (deps.camera && restoreSnapshot?.zoom !== null && restoreSnapshot?.zoom !== undefined) {
      await withInternal(() => deps.camera!.ensureZoom(restoreSnapshot.zoom!)).catch((error) => {
        trace('round.restore-zoom.failed', { message: error instanceof Error ? error.message : String(error) })
      })
    }
    if (suspended) return

    // 5. lookAt 恢复：本轮飞机位移超阈值则跳过并丢弃偏好
    const moved = isDroneMoved()
    if (moved) {
      state.preferredLookAt = null
      void deps.storage.set(STORAGE_PREFERRED_LOOK_AT, null).catch(() => {})
    } else if (restoreSnapshot?.lookAt && deps.gimbal) {
      try {
        await withInternal(() => deps.gimbal!.lookAt(restoreSnapshot.lookAt!, { locked: true }))
      } catch (error) {
        logger.warn('自动复位云台视角失败，请手动调整')
        trace('round.restore-look-at.failed', { message: error instanceof Error ? error.message : String(error) })
      }
    }
    if (suspended) return

    // 5b. 切回拍照模式（失败仅告警，下轮 Phase 1 会重试）
    if (deps.camera) {
      await withInternal(() => deps.camera!.ensureMode('photo')).catch(() => {})
    }

    // 6. 后端 tracking 结束
    state.currentTargetId = null
    await stopCurrentTracking()
    roundRestoreSnapshot = null
    trace('round.finalize.completed', { reason, moved })

    coolingTimer = timers.setTimeout(() => {
      coolingTimer = undefined
      state.phase = 'idle'
      state.cooldownUntil = now() + COOLDOWN_MS
      pushSkipHint()
    }, COOLING_DOWN_MS)
  }

  async function stopCurrentTracking (): Promise<void> {
    const trackingId = state.currentTrackingId
    if (trackingId === null) return
    const endedAt = state.currentTrackingEndedAt ?? businessTimestamp('h_illegalRoad_stopTracking')
    state.currentTrackingEndedAt = endedAt
    try {
      await api.stopTracking({ trackingId, endedAt })
      if (state.currentTrackingId === trackingId) {
        state.currentTrackingId = null
        state.currentTrackingEndedAt = null
      }
      await refreshTrackings()
    } catch (error) {
      // 失败保留 trackingId/endedAt：disable、超时等后续路径会按同一参数重试收敛
      await notify('error', `行人上路本轮抓拍结束失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  /** 补偿/卸载路径的 best-effort 关闭：失败只告警，不打断所在清理流程。 */
  async function stopSessionBestEffort (sessionId: string): Promise<void> {
    await api.stopSession({ sessionId, endedAt: businessTimestamp('h_illegalRoad_stopSession:cleanup') }).catch((error) => {
      logger.warn('关闭行人抓拍会话失败', { message: error instanceof Error ? error.message : String(error) })
    })
  }

  function isDroneMoved (): boolean {
    const initial = roundRestoreSnapshot?.dronePosition
    const current = dronePosition(telemetryState)
    if (!initial || !current) return false
    // 简化 haversine（米）
    const dLng = (current.lng - initial.lng) * Math.cos((initial.lat + current.lat) / 2 * Math.PI / 180) * 111_320
    const dLat = (current.lat - initial.lat) * 111_320
    const horizontal = Math.hypot(dLng, dLat)
    const vertical = Math.abs(current.height - initial.height)
    return horizontal > MOVED_HORIZONTAL_THRESHOLD_M || vertical > MOVED_VERTICAL_THRESHOLD_M
  }

  async function onRecordingRevoked (reason: 'superseded' | 'device-state-changed' | 'disposed'): Promise<void> {
    if (reason === 'superseded') {
      recordingLease = undefined
      await recordingRevocation?.dispose()
      recordingRevocation = undefined
      return
    }
    if (state.phase !== 'recording') return
    recordingLease = undefined
    await recordingRevocation?.dispose()
    recordingRevocation = undefined
    await finalizeRound(`recording-${reason}`)
  }

  async function withInternal<T> (operation: () => Promise<T>): Promise<T> {
    internalOps += 1
    try {
      return await operation()
    } finally {
      internalOps -= 1
    }
  }

  // === 退出路径 ============================================================

  /** K 键跳过：结束本轮（保持开关开启）。 */
  async function skipCurrentTarget (): Promise<void> {
    if (!state.enabled) return
    if ((state.phase === 'detected' || state.phase === 'recording') && state.currentTrackingId !== null) {
      await finalizeRound('skip')
    }
  }

  /** 用户手动操作：自动关闭（toast + disable）。 */
  async function manualExit (reason: string): Promise<void> {
    if (!state.enabled) return
    await notify('warning', '检测到用户手动操作，抓拍已自动关闭')
    await disable(`manual:${reason}`)
  }

  /** 控制权丢失：挂起当前轮，保持 enabled 与后端 status。 */
  async function suspendForControlLoss (): Promise<void> {
    if (suspended) return
    suspended = true
    // 控制权已经不属于当前 Runtime，不能复用 finalizeRound 继续发送相机/SPZ/云台指令。
    roundGeneration += 1
    if (roundTimeout !== undefined) timers.clearTimeout(roundTimeout)
    if (targetLostTimer !== undefined) timers.clearTimeout(targetLostTimer)
    roundTimeout = undefined
    targetLostTimer = undefined
    state.phase = 'idle'
    state.currentTargetId = null
    roundRestoreSnapshot = null
    const revocation = recordingRevocation
    const lease = recordingLease
    recordingRevocation = undefined
    recordingLease = undefined
    await revocation?.dispose()
    // dispose 只释放本 Runtime 的句柄，不向设备发送 stop；恢复控制权后再做设备收敛。
    await lease?.dispose()
    const trackingId = state.currentTrackingId
    await stopCurrentTracking().catch((error) => {
      logger.warn('控制权丢失时结束 Tracking 失败', { message: error instanceof Error ? error.message : String(error) })
    })
    state.cooldownUntil = 0
    hideSkipHint()
    trace('control.suspended', { trackingId })
    logger.info('负载控制权丢失，行人上路抓拍挂起（保持开启）')
  }

  function hasPayloadControl (): boolean {
    return telemetryState?.control.payload.hasControl === true
  }

  function resumeFromSuspension (): Promise<void> {
    if (resumePromise) return resumePromise
    resumePromise = runResumeFromSuspension().finally(() => {
      resumePromise = undefined
    })
    return resumePromise
  }

  async function runResumeFromSuspension (): Promise<void> {
    const canResume = (): boolean => state.enabled && suspended && hasPayloadControl()
    if (!canResume()) return
    try {
      const aiResult = await deps.aiConfig?.ensure({
        model: 'dji-visible',
        recognitionEnabled: true,
        targetTypes: ['person'],
      })
      if (!aiResult?.confirmed) throw new Error(aiResult?.reason ?? 'AI 配置未确认')
      if (!canResume()) return
      const smartState = await deps.smartTrack?.getState()
      if (!canResume()) return
      if (smartState && smartState.phase !== 'off') await withInternal(() => deps.smartTrack!.stop())
      if (!canResume()) return
      const cameraState = await deps.camera?.getState()
      if (!canResume()) return
      if (cameraState?.recording) {
        const cleanupLease = await deps.camera!.acquireRecording({ takeover: true }) as RecordingLease
        if (!canResume()) {
          await cleanupLease.dispose()
          return
        }
        await withInternal(() => cleanupLease.stop())
        await delay(POST_RECORD_STOP_SETTLE_MS)
      }
      if (!canResume()) return
      await withInternal(() => deps.camera!.ensureMode('photo'))
      if (!canResume()) return
      suspended = false
      state.phase = state.currentTrackingId === null ? 'idle' : 'detected'
      trace('control.resumed')
      logger.info('负载控制权恢复，行人上路抓拍继续')
    } catch (error) {
      if (!state.enabled) return
      trace('control.resume-failed', { message: error instanceof Error ? error.message : String(error) })
      await disable('control-resume-failed')
    }
  }

  // === 订阅 ================================================================

  async function attachSubscriptions (): Promise<void> {
    if (deps.telemetry) {
      telemetryState = await deps.telemetry.getState()
      if (disposed) return
      const telemetrySubscription = await deps.telemetry.onStateChanged(({ state: next }) => {
        if (disposed) return
        const previous = telemetryState
        telemetryState = next
        if (!state.enabled) return
        if (!next.control.payload.hasControl) {
          void suspendForControlLoss()
          return
        }
        if (suspended) {
          void resumeFromSuspension()
          return
        }
        const nextModeCode = modeCode(next)
        if (nextModeCode !== null && !ALLOWED_FLIGHT_MODES.has(nextModeCode)) {
          if (modeBlockedTimer !== undefined) timers.clearTimeout(modeBlockedTimer)
          modeBlockedTimer = timers.setTimeout(() => {
            modeBlockedTimer = undefined
            const current = telemetryState
            const code = modeCode(current)
            if (state.enabled && code !== null && !ALLOWED_FLIGHT_MODES.has(code)) {
              void disable('mode-code-blocked')
            }
          }, MODE_BLOCKED_DEBOUNCE_MS)
        } else if (modeBlockedTimer !== undefined) {
          timers.clearTimeout(modeBlockedTimer)
          modeBlockedTimer = undefined
        }
        void previous
      })
      if (disposed) {
        await Promise.resolve(telemetrySubscription.dispose()).catch(() => {})
        return
      }
      disposables.push(telemetrySubscription)
    }
    if (deps.camera) {
      let previousMode: 'photo' | 'record' | null = null
      const cameraSubscription = await deps.camera.onStateChanged((next) => {
        if (disposed) return
        const modeChanged = previousMode !== null && next.mode !== previousMode
        previousMode = next.mode
        if (!state.enabled || internalOps > 0) return
        // 用户开始录像（非自身编排、非本轮 RECORDING）
        if (next.recording && state.phase !== 'recording' && !recordingLease) {
          void manualExit('user-recording')
          return
        }
        if (modeChanged) {
          void manualExit('user-camera-mode')
        }
      })
      if (disposed) {
        await Promise.resolve(cameraSubscription.dispose()).catch(() => {})
        return
      }
      disposables.push(cameraSubscription)
    }
    if (deps.smartTrack) {
      const smartTrackSubscription = await deps.smartTrack.onStateChanged((next) => {
        if (disposed) return
        if (!state.enabled || suspended) return
        if (state.phase !== 'detected' && state.phase !== 'recording') return
        const lost = next.phase === 'lost' || next.phase === 'off' || next.phase === 'error'
        if (lost) {
          if (targetLostTimer !== undefined) return
          targetLostTimer = timers.setTimeout(() => {
            targetLostTimer = undefined
            void deps.smartTrack!.getState().then((current) => {
              const stillLost = current.phase === 'lost' || current.phase === 'off' || current.phase === 'error'
              if (state.enabled && stillLost && (state.phase === 'detected' || state.phase === 'recording')) {
                void finalizeRound('target-lost').catch((error) => {
                  logger.warn('目标丢失收尾失败', { message: error instanceof Error ? error.message : String(error) })
                })
              }
            }).catch(() => {})
          }, TARGET_LOST_GRACE_MS)
        } else if (targetLostTimer !== undefined) {
          timers.clearTimeout(targetLostTimer)
          targetLostTimer = undefined
        }
      })
      if (disposed) {
        await Promise.resolve(smartTrackSubscription.dispose()).catch(() => {})
        return
      }
      disposables.push(smartTrackSubscription)
    }
    if (deps.aiConfig) {
      const aiConfigSubscription = await deps.aiConfig.onStateChanged((next) => {
        if (disposed) return
        if (!state.enabled || suspended || aiRepairing) return
        if (next.model === 'dji-visible'
          && next.recognitionEnabled
          && next.targetTypes.length === 1
          && next.targetTypes[0] === 'person') {
          return
        }
        aiRepairing = true
        void deps.aiConfig!.ensure({
          model: 'dji-visible',
          recognitionEnabled: true,
          targetTypes: ['person'],
        }).then((result) => {
          trace('ai.guard', { confirmed: result.confirmed, reason: result.reason })
          if (!result.confirmed) void disable('ai-config-lost')
        }).catch((error: unknown) => {
          trace('ai.guard-failed', { message: error instanceof Error ? error.message : String(error) })
          void disable('ai-config-lost')
        }).finally(() => {
          aiRepairing = false
        })
      })
      if (disposed) {
        await Promise.resolve(aiConfigSubscription.dispose()).catch(() => {})
        return
      }
      disposables.push(aiConfigSubscription)
    }
    const wsSubscription = await deps.ws.onBizCode<Record<string, JsonValue>>('illegal_road_capture', (event) => {
      if (disposed) return
      if (event.subBizCode !== 'media_added') return
      const data = event.data as { scene?: unknown; dock_sn?: unknown; flight_id?: unknown }
      if (data?.scene !== 'illegal_road') return
      if (data.dock_sn !== dockSnOr('') || data.flight_id !== flightIdOrEmpty()) return
      void refreshTrackings()
    })
    if (disposed) {
      await Promise.resolve(wsSubscription.dispose()).catch(() => {})
      return
    }
    disposables.push(wsSubscription)
  }

  async function refreshTrackings (): Promise<void> {
    const refreshGeneration = ++recordsRefreshGeneration
    const flightId = flightIdOrEmpty()
    const sessionId = activeSessionId
    if (flightId === '' || !sessionId) return
    try {
      const projectId = deps.getProjectId()
      if (!projectId) return
      logger.info('行人抓拍列表刷新请求', {
        projectId,
        flightId,
        sessionId,
        localCount: state.records.length,
        pendingCount: state.records.filter(record => record.pending).length,
      })
      const { trackings: items } = await api.listTrackings({ projectId, flightId, sessionId, page: 1, pageSize: 100 })
      // 多次 media_added 会并发补拉；只允许最后一次请求提交，避免远景旧响应覆盖近景。
      if (refreshGeneration !== recordsRefreshGeneration || activeSessionId !== sessionId) return
      logger.info('行人抓拍列表刷新响应', {
        sessionId,
        itemCount: items.length,
        itemSessionIds: [...new Set(items.map(item => item.sessionId))],
        pendingCount: state.records.filter(record => record.pending).length,
      })
      const backend = items.filter(item => item.sessionId === sessionId).map((item) => {
        // 后端媒体/位置未回传时保留本地截图与无人机位置（真实 Adapter 暂无位置来源）；
        // 兜底按 trackingId 匹配任意本地记录，保证媒体回传前不丢失截图。
        const local = state.records.find(record => record.trackingId === item.id)
        const previewUrl = item.latestPhoto?.previewUrl ?? ''
        const originalUrl = item.latestPhoto?.originalUrl ?? ''
        return {
          trackingId: item.id,
          folderId: item.folderId,
          startedAt: item.startedAt,
          endedAt: item.status === 'open' ? null : item.endedAt,
          previewPhotoUrl: previewUrl === '' ? local?.previewPhotoUrl ?? null : deps.resolveMediaUrl(previewUrl),
          originalPhotoUrl: originalUrl === '' ? local?.originalPhotoUrl ?? null : deps.resolveMediaUrl(originalUrl),
          closeReason: item.closeReason,
          position: local?.position ?? null,
          pending: false,
        }
      })
      // 后端 + 临时合并：trackingId 优先去重，缺失时按 startedAt 兜底；后端优先，时间倒序
      const seenTrackingIds = new Set(backend.map(record => record.trackingId))
      const seenStartedAt = new Set(backend.map(record => record.startedAt))
      const merged = [...backend, ...state.records.filter((record) => {
        if (!record.pending) return false
        if (seenTrackingIds.has(record.trackingId)) return false
        return !seenStartedAt.has(record.startedAt)
      })]
      state.records = merged.sort((left, right) => right.startedAt - left.startedAt)
      pushRecords()
      logger.info('行人抓拍列表刷新提交', {
        sessionId,
        backendCount: backend.length,
        recordCount: state.records.length,
        pendingCount: state.records.filter(record => record.pending).length,
      })
    } catch (error) {
      logger.warn('刷新行人抓拍记录失败', { message: error instanceof Error ? error.message : String(error) })
    }
  }

  startDroneTimestampHeartbeat()
  const initialization = attachSubscriptions().catch((error: unknown) => {
    if (!disposed) logger.warn('初始化行人抓拍订阅失败', { message: error instanceof Error ? error.message : String(error) })
  })

  const settings = {
    async setEnabled ({ enabled }: { readonly enabled: boolean }): Promise<void> {
      if (enabled) {
        if (state.switchBusy) return
        await enable(++operationGeneration)
      } else {
        await disable('disable', ++operationGeneration)
      }
    },
  }

  return {
    settingsState,
    skipHintState,
    recordsState,
    settings,
    skipCurrentTarget,
    async recover () {
      const generation = operationGeneration
      if (!telemetryState && deps.telemetry) telemetryState = await deps.telemetry.getState()
      if (generation !== operationGeneration) return
      try {
        const dockSn = dockSnOr('')
        if (dockSn) {
          const projectId = deps.getProjectId()
          const currentFlightId = deps.getFlightId()
          if (projectId && currentFlightId) {
            const status = await api.getStatus({ projectId, dockSn, flightId: currentFlightId })
            if (generation === operationGeneration && status.isActive && status.flightId === currentFlightId && status.sessionId !== '') {
              // 先阻断检测，再恢复偏好并收敛设备；避免订阅首帧抢在恢复流程之前启动抓拍。
              suspended = true
              state.enabled = true
              state.phase = status.openTracking ? 'detected' : 'idle'
              state.currentTrackingId = status.openTracking?.trackingId ?? null
              state.currentTrackingEndedAt = null
              hintPhase = status.openTracking ? 'ready' : 'hidden'
              activeFlightId = currentFlightId
              activeSessionId = status.sessionId
              await restorePreferences()
              if (generation !== operationGeneration) return
              if (hasPayloadControl()) await resumeFromSuspension()
              await attachDetection()
            }
          }
        }
      } catch {
        // 后端不可达时按未开启处理
      }
      await refreshTrackings()
      pushSettings()
      pushSkipHint()
    },
    /** 外部上下文变化（如航次切换）后刷新开关门控呈现。 */
    refreshGate (): void {
      pushSettings()
    },
    resetSession (): void {
      hideSkipHint()
      activeFlightId = null
      activeSessionId = null
      operationGeneration += 1
      recordsRefreshGeneration += 1
      state.enabled = false
      state.phase = 'idle'
      state.records = []
      pushRecords()
      pushSettings()
    },
    attachUi (handles) {
      ui = handles
      pushSkipHint()
    },
    async dispose () {
      disposed = true
      hideSkipHint()
      operationGeneration += 1
      recordsRefreshGeneration += 1
      const wasEnabled = state.enabled
      if (state.phase === 'detected' || state.phase === 'recording') {
        // 卸载必须完成本地清理；tracking 结束失败由 stop-session 在后端统一收敛
        await finalizeRound('dispose').catch((error) => {
          logger.warn('卸载时结束本轮抓拍失败', { message: error instanceof Error ? error.message : String(error) })
        })
      }
      state.enabled = false
      activeFlightId = null
      if (coolingTimer !== undefined) timers.clearTimeout(coolingTimer)
      if (roundTimeout !== undefined) timers.clearTimeout(roundTimeout)
      if (targetLostTimer !== undefined) timers.clearTimeout(targetLostTimer)
      if (modeBlockedTimer !== undefined) timers.clearTimeout(modeBlockedTimer)
      if (heartbeatTimer !== undefined) timers.clearInterval(heartbeatTimer)
      detectionSubscription?.dispose()
      detectionSubscription = undefined
      await initialization
      for (const disposable of [...disposables].reverse()) {
        await Promise.resolve(disposable.dispose()).catch(() => {})
      }
      disposables.length = 0
      const sessionId = activeSessionId
      activeSessionId = null
      if (wasEnabled && sessionId) await stopSessionBestEffort(sessionId)
      await skipHintUpdateTail
      await diagnosticWrite
    },
  }
}
