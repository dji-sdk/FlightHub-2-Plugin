// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState, isPluginError } from 'fh2-plugin-sdk'
import type {
  Disposable,
  PluginCapabilityClient,
  PluginLogger,
  PluginState,
  TelemetryState,
  TrackedTimers,
} from 'fh2-plugin-sdk'
import { ALLOWED_FLIGHT_MODES, type CaptureModeSettingsSnapshot, type RecordingLease } from '../../../shared/capture-mode'
import { dronePosition, droneTimestamp, gatewaySn, laserPosition, modeCode } from '../../../shared/cockpit-telemetry'
import type { LaneChangeWorkbenchState, ViolationTypeFilter } from '../../../views/lane-change-workbench/contract'
import type { CanvasShape, LaneChangeCanvasState, VideoPoint } from '../../../views/lane-change-annotation-canvas/contract'
import type { LaneChangeApi } from './api'
import type { CoreBBox, CoreRegion, LaneChangeTriggerEvent } from './detector-core'
import { createDetectorCore } from './detector-core'
import { type SnapshotOverlay, composeSnapshotOverlay } from './snapshot-overlay'
import type {
  LaneAnnotation,
  LaneChangeRecord,
  LngLat,
} from './model'
import {
  deserializeAnnotations,
  hasEnoughPoints,
  mergeRecords,
  nextAnnotationName,
  serializeAnnotations,
} from './model'
import { toCoreBBoxes } from './target-filter'

const EVENT_RETRY_DELAY_MS = 1_000
const VISUAL_PROJECTION_INTERVAL_MS = 33
const VIEW_SETTLE_MS = 1_000
const GIMBAL_JUMP_DEGREE = 5
const GIMBAL_ACCUM_DEGREE = 10
// 刷新后设备通道可能尚未就绪；首次超时后短暂退避并重试一次。
const RECOVERY_STOP_RETRY_SCHEDULE_MS = [0, 1_000]

export interface LaneChangeControllerDeps {
  readonly api: LaneChangeApi;
  readonly telemetry: PluginCapabilityClient<'cockpit:telemetry'> | undefined;
  readonly camera: PluginCapabilityClient<'cockpit:camera'> | undefined;
  readonly detection: PluginCapabilityClient<'cockpit:detection'> | undefined;
  readonly sceneGeometry: PluginCapabilityClient<'cockpit:scene-geometry'> | undefined;
  readonly aiConfig: PluginCapabilityClient<'cockpit:ai-config'> | undefined;
  readonly notification: PluginCapabilityClient<'platform:notification'> | undefined;
  readonly pointer: PluginCapabilityClient<'cockpit:live-pointer'> | undefined;
  readonly storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  readonly blobs: { put(key: string, value: Blob): Promise<void>; url(key: string): Promise<string | undefined> };
  readonly timers: TrackedTimers;
  readonly logger: PluginLogger;
  /** 当前飞行航次；无航次返回 null（gate 阻断开启）。开启成功后冻结到本轮结束。 */
  readonly getFlightId: () => string | null;
  /** 当前项目；用于隔离项目级标注。 */
  readonly getProjectId: () => string | null;
  /** 抓拍确认后的统一告警入口（总开关/弹窗/音效由 activate 层告警协调器裁决）。 */
  readonly onViolationDetected?: (message: string) => void;
  readonly now?: () => number;
}

export interface LaneChangeUiHandles {
  readonly workbench: { update(patch: { visible?: boolean }): Promise<void> };
  readonly canvas: { update(patch: { visible?: boolean; interactive?: boolean }): Promise<void> };
}

export interface LaneChangeController {
  readonly settingsState: PluginState<CaptureModeSettingsSnapshot>;
  readonly workbenchState: PluginState<LaneChangeWorkbenchState>;
  readonly canvasState: PluginState<LaneChangeCanvasState>;
  readonly recordsState: PluginState<{ records: readonly LaneChangeRecord[] }>;
  readonly settings: { setEnabled(input: { enabled: boolean }): Promise<void> };
  readonly workbench: {
    setCollapsed(input: { readonly collapsed: boolean }): Promise<void>;
    close(): Promise<void>;
    setViolationType(input: { readonly type: ViolationTypeFilter }): Promise<void>;
    toggleAnnotationLoaded(input: { readonly id: string; readonly loaded: boolean }): Promise<void>;
    renameAnnotation(input: { readonly id: string; readonly name: string }): Promise<void>;
    deleteAnnotation(input: { readonly id: string }): Promise<void>;
    setHighlight(input: { readonly id: string | null }): Promise<void>;
    beginDraw(input: { readonly kind: 'solid-line' | 'guide-area' }): Promise<void>;
    finishEdit(): Promise<void>;
    beginEdit(): Promise<void>;
    toggleCapture(): Promise<void>;
  };
  readonly canvas: {
    addDraftPoint(input: { readonly point: VideoPoint }): Promise<void>;
    removeLastDraftPoint(): Promise<void>;
    finishDraft(): Promise<void>;
    cancelDraft(): Promise<void>;
    selectShape(input: { readonly id: string | null }): Promise<void>;
    moveVertex(input: { readonly shapeId: string; readonly vertexIndex: number; readonly point: VideoPoint }): Promise<void>;
    moveShape(input: { readonly shapeId: string; readonly delta: VideoPoint }): Promise<void>;
    insertVertex(input: { readonly shapeId: string; readonly segmentIndex: number; readonly point: VideoPoint }): Promise<void>;
    deleteVertex(input: { readonly shapeId: string; readonly vertexIndex: number }): Promise<void>;
    deleteShape(input: { readonly shapeId: string }): Promise<void>;
  };
  recover(): Promise<void>;
  /** 外部上下文变化后刷新开关门控呈现。 */
  refreshGate(): void;
  resetSession(): void;
  attachUi(ui: LaneChangeUiHandles): void;
  dispose(): Promise<void>;
}

const STORAGE_ANNOTATIONS = 'lane-change:annotations:v1'
const STORAGE_VIOLATION_TYPE = 'lane-change:violation-type'

interface DetectionFrameShape {
  readonly frameId: string;
  readonly capturedAt: number;
  readonly targets: ReadonlyArray<{
    readonly targetId: string;
    readonly type: string;
    readonly state: string;
    readonly bbox: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  }>;
}

export function createLaneChangeController (deps: LaneChangeControllerDeps): LaneChangeController {
  const { api, timers, logger } = deps
  const now = deps.now ?? Date.now
  /** 本轮冻结的航次：enable 时读取，disable/recover 重置；未开启时按需回读当前值。 */
  let activeFlightId: string | null = null
  let operationGeneration = 0
  let disposed = false
  const flightIdOrEmpty = (): string => activeFlightId ?? deps.getFlightId() ?? ''

  // --- 唯一业务真相 -------------------------------------------------------
  const state = {
    enabled: false,
    captureStatus: 'idle' as 'idle' | 'capturing' | 'paused',
    violationType: 'both' as ViolationTypeFilter,
    annotations: [] as readonly LaneAnnotation[],
    records: [] as readonly LaneChangeRecord[],
    panelVisible: false,
    panelCollapsed: false,
    highlightedAnnotationId: null as string | null,
    drawingKind: null as 'solid-line' | 'guide-area' | null,
    editing: false,
    draftPoints: [] as readonly VideoPoint[],
    selectedShapeId: null as string | null,
    switchBusy: false,
    captureBusy: false,
    canvasVisible: false,
    message: null as string | null,
  }

  const settingsState = createViewState<CaptureModeSettingsSnapshot>({
    enabled: false,
    canEnable: false,
    disabledReason: null,
    switchBusy: false,
  })
  const workbenchState = createViewState<LaneChangeWorkbenchState>({
    panelVisible: false,
    panelCollapsed: false,
    enabled: false,
    captureStatus: 'idle',
    violationType: 'both',
    annotations: [],
    highlightedAnnotationId: null,
    drawingKind: null,
    editing: false,
    captureBusy: false,
    message: null,
  })
  const canvasState = createViewState<LaneChangeCanvasState>({
    visible: false,
    shapes: [],
    draftPoints: [],
    drawingKind: null,
    editing: false,
    selectedShapeId: null,
    highlightedShapeId: null,
  })
  const recordsState = createViewState<{ records: readonly LaneChangeRecord[] }>({ records: [] })

  let ui: LaneChangeUiHandles | undefined
  const disposables: Array<{ dispose(): void | Promise<void> }> = []
  let telemetryState: TelemetryState | undefined

  function dockSnOr (fallback: string): string {
    return gatewaySn(telemetryState) ?? fallback
  }

  function gateReason (): string | null {
    const telemetry = telemetryState
    if (!telemetry) return '遥测不可用'
    if (!telemetry.control.payload.hasControl) return '请先获取负载控制权'
    const currentModeCode = modeCode(telemetry)
    if (currentModeCode === null || !ALLOWED_FLIGHT_MODES.has(currentModeCode)) return '当前飞行器状态不可开启变道抓拍'
    if (!gatewaySn(telemetry)) return '无法获取机场 SN'
    if (deps.getFlightId() === null) return '当前无飞行航次，无法开启抓拍'
    return null
  }

  function groundHeight (): number | null {
    return laserPosition(telemetryState)?.height ?? null
  }

  // --- 快照与推送 ---------------------------------------------------------

  /** 当前展示帧的 geo → video 投影缓存（由 30Hz 视觉投影泵维护）。 */
  let latestProjection = new Map<string, readonly VideoPoint[]>()
  let projectionTask: Promise<void> | undefined
  let projectionRequested = false
  let visualProjectionTimer: unknown
  let visualProjectionGeneration = 0
  let visualProjectionMutationCount = 0

  function projectedShapes (): readonly CanvasShape[] {
    return state.annotations
      .filter(annotation => annotation.loaded)
      .map(annotation => ({
        id: annotation.id,
        kind: annotation.kind,
        points: annotation.coordinateMode === 'geo'
          ? (latestProjection.get(annotation.id) ?? [])
          : annotation.points as readonly VideoPoint[],
        coordinateMode: annotation.coordinateMode,
      }))
      .filter(shape => shape.points.length > 0)
  }

  /**
   * 推送开关门控呈现；字段全部未变时返回 current 静默。
   * telemetry 每帧回调与 refreshGate 只依赖本函数——高频帧不得广播其余状态链。
   */
  function pushSettings (): void {
    const reason = state.enabled ? null : gateReason()
    settingsState.update(current => (
      current.enabled === state.enabled
      && current.canEnable === (reason === null)
      && current.disabledReason === reason
      && current.switchBusy === state.switchBusy
        ? current
        : {
            enabled: state.enabled,
            canEnable: reason === null,
            disabledReason: reason,
            switchBusy: state.switchBusy,
          }
    ))
  }

  function pushAll (): void {
    pushSettings()
    workbenchState.update(() => ({
      panelVisible: state.panelVisible,
      panelCollapsed: state.panelCollapsed,
      enabled: state.enabled,
      captureStatus: state.captureStatus,
      violationType: state.violationType,
      annotations: state.annotations.map(annotation => ({
        id: annotation.id,
        name: annotation.name,
        kind: annotation.kind,
        loaded: annotation.loaded,
        coordinateMode: annotation.coordinateMode,
        createdAt: annotation.createdAt,
      })),
      highlightedAnnotationId: state.highlightedAnnotationId,
      drawingKind: state.drawingKind,
      editing: state.editing,
      captureBusy: state.captureBusy,
      message: state.message,
    }))
    canvasState.update(current => ({
      ...current,
      visible: state.canvasVisible,
      shapes: projectedShapes(),
      draftPoints: state.draftPoints,
      drawingKind: state.drawingKind,
      editing: state.editing,
      selectedShapeId: state.selectedShapeId,
      highlightedShapeId: state.highlightedAnnotationId,
    }))
    // 记录数组引用未变时保持状态对象稳定：遥测帧高频触发 pushAll，
    // 不能让 records 链（DTO → records-host → View RPC）和预览订阅每帧重放
    recordsState.update(current => (current.records === state.records ? current : { records: state.records }))
    syncVisualProjectionPump()
    void pushUi()
  }

  async function pushUi (): Promise<void> {
    if (!ui) return
    await Promise.all([
      ui.workbench.update({ visible: state.panelVisible }),
      ui.canvas.update({ visible: state.canvasVisible, interactive: state.drawingKind !== null || state.editing }),
    ])
  }

  function shouldRunVisualProjection (): boolean {
    return state.canvasVisible
      && deps.sceneGeometry !== undefined
      && visualProjectionMutationCount === 0
      && state.annotations.some(annotation => annotation.loaded && annotation.coordinateMode === 'geo')
  }

  function stopVisualProjectionPump (): void {
    if (visualProjectionTimer !== undefined) {
      timers.clearInterval(visualProjectionTimer)
      visualProjectionTimer = undefined
    }
    visualProjectionGeneration += 1
    projectionRequested = false
  }

  function syncVisualProjectionPump (): void {
    if (!shouldRunVisualProjection()) {
      stopVisualProjectionPump()
      return
    }
    if (visualProjectionTimer !== undefined) return
    visualProjectionGeneration += 1
    visualProjectionTimer = timers.setInterval(() => {
      void refreshGeoProjection()
    }, VISUAL_PROJECTION_INTERVAL_MS)
    void refreshGeoProjection()
  }

  /** 30Hz 视觉投影泵；同一时刻最多一个调用，并只保留一次尾随刷新。 */
  function refreshGeoProjection (): Promise<void> {
    if (projectionTask) {
      projectionRequested = true
      return projectionTask
    }
    projectionTask = (async () => {
      do {
        projectionRequested = false
        await refreshGeoProjectionOnce()
      } while (projectionRequested)
    })().finally(() => {
      projectionTask = undefined
    })
    return projectionTask
  }

  async function refreshGeoProjectionOnce (): Promise<void> {
    const loadedGeo = state.annotations.filter(annotation => annotation.loaded && annotation.coordinateMode === 'geo')
    if (loadedGeo.length === 0 || !deps.sceneGeometry) return
    const generation = visualProjectionGeneration
    try {
      const slices: Array<{ id: string; start: number; count: number }> = []
      const points: Array<{ lng: number; lat: number; height: number }> = []
      for (const annotation of loadedGeo) {
        const annotationPoints = annotation.points as readonly LngLat[]
        slices.push({ id: annotation.id, start: points.length, count: annotationPoints.length })
        points.push(...annotationPoints.map(point => ({
          lng: point.lng,
          lat: point.lat,
          height: annotation.groundHeight ?? 0,
        })))
      }
      const result = await deps.sceneGeometry.projectGeoToVideo(points)
      if (!result || generation !== visualProjectionGeneration || !shouldRunVisualProjection()) return
      const projection = new Map<string, readonly VideoPoint[]>()
      for (const slice of slices) {
        projection.set(slice.id, result.points
          .slice(slice.start, slice.start + slice.count)
          .filter((point): point is { x: number; y: number } => point !== null)
          .map(point => ({ x: point.x, y: point.y })))
      }
      latestProjection = projection
      canvasState.update(current => ({ ...current, shapes: projectedShapes() }))
    } catch {
      // 投影失败保持现状；检测循环会再次尝试
    }
  }

  function setMessage (message: string | null): void {
    state.message = message
  }

  async function notify (intent: 'info' | 'success' | 'warning' | 'error', message: string): Promise<void> {
    // 句柄由宿主按 durationMs 自动关闭；提前 dispose 会立即隐藏提示
    try {
      // Capability Client 跨 SDK 后统一 Promise 语义，必须 await 才能吞掉异步展示失败
      await deps.notification?.show({ key: `lane-change:${intent}:${now()}`, message, intent, durationMs: 4000 })
    } catch {
      // 通知展示失败不阻断编排
    }
  }

  type PointerLease = Awaited<ReturnType<PluginCapabilityClient<'cockpit:live-pointer'>['acquire']>>
  let pointerLease: PointerLease | undefined
  let pointerRevocation: Disposable | undefined
  let pointerGeneration = 0

  async function releasePointerLease (): Promise<void> {
    pointerGeneration += 1
    const lease = pointerLease
    const revocation = pointerRevocation
    pointerLease = undefined
    pointerRevocation = undefined
    await Promise.resolve(revocation?.dispose()).catch(() => {})
    await Promise.resolve(lease?.release()).catch(() => {})
  }

  async function acquirePointerLease (): Promise<boolean> {
    if (pointerLease) return true
    if (!deps.pointer) {
      setMessage('直播画面交互能力不可用')
      pushAll()
      return false
    }
    const generation = ++pointerGeneration
    try {
      const lease = await deps.pointer.acquire('DronePayload')
      if (generation !== pointerGeneration) {
        await lease.release()
        return false
      }
      pointerLease = lease
      const revocation = await lease.onRevoked(() => {
        pointerGeneration += 1
        pointerLease = undefined
        pointerRevocation = undefined
        state.drawingKind = null
        state.editing = false
        state.draftPoints = []
        state.selectedShapeId = null
        setMessage('宿主已接管直播画面，标注编辑已退出')
        pushAll()
      })
      if (generation !== pointerGeneration) {
        await revocation.dispose()
        await lease.release()
        return false
      }
      pointerRevocation = revocation
      return true
    } catch (error) {
      setMessage(`无法接管直播画面：${error instanceof Error ? error.message : String(error)}`)
      pushAll()
      return false
    }
  }

  // --- 持久化 -------------------------------------------------------------

  const storageKey = (base: string): string => `${base}:${deps.getProjectId() ?? 'no-project'}`
  let persistTimer: unknown
  function schedulePersist (): void {
    if (persistTimer !== undefined) timers.clearTimeout(persistTimer)
    persistTimer = timers.setTimeout(() => {
      persistTimer = undefined
      void deps.storage.set(storageKey(STORAGE_ANNOTATIONS), serializeAnnotations(state.annotations)).catch(() => {})
    }, 200)
  }

  async function restorePersisted (): Promise<void> {
    state.annotations = []
    const annotations = deserializeAnnotations(await deps.storage.get(storageKey(STORAGE_ANNOTATIONS)))
    if (annotations !== undefined && annotations.length > 0) state.annotations = [...annotations]
    const violationType = await deps.storage.get(storageKey(STORAGE_VIOLATION_TYPE))
    if (violationType === 'solidLine' || violationType === 'guideArea' || violationType === 'both') {
      state.violationType = violationType
    }
  }

  // === 开关 ===============================================================

  async function enable (generation: number): Promise<void> {
    if (state.enabled || state.switchBusy) return
    const reason = gateReason()
    if (reason !== null) {
      await notify('warning', `变道抓拍开启失败：${reason}`)
      pushAll()
      return
    }
    state.switchBusy = true
    pushAll()
    try {
      if (deps.aiConfig) {
        const result = await deps.aiConfig.ensure({ model: 'dji-visible', recognitionEnabled: true, targetTypes: ['vehicle'] })
        if (generation !== operationGeneration) return
        if (!result.confirmed) {
          await notify('warning', `AI 识别配置失败：${result.reason ?? '未知原因'}`)
          return
        }
      }
      const projectId = deps.getProjectId()
      const flightId = deps.getFlightId()
      const dockSn = dockSnOr('')
      if (!projectId || !flightId || !dockSn) throw new Error('抓拍上下文不完整')
      await api.startMode({ projectId, dockSn, flightId })
      if (generation !== operationGeneration) {
        await api.stopMode({ projectId, dockSn }).catch((error) => {
          logger.warn('补偿关闭变道抓拍模式失败', { message: error instanceof Error ? error.message : String(error) })
        })
        return
      }
      activeFlightId = flightId
      state.enabled = true
      state.captureStatus = 'idle'
      state.panelVisible = true
      state.canvasVisible = true
      setMessage(null)
      pushAll()
    } catch (error) {
      // 迟到失败（用户已切走）不提示，交由当代 disable 流程收敛
      if (generation === operationGeneration) {
        const message = `变道抓拍开启失败：${error instanceof Error ? error.message : String(error)}`
        setMessage(message)
        pushAll()
        await notify('error', message)
      }
      throw error
    } finally {
      if (generation === operationGeneration) {
        state.switchBusy = false
        pushAll()
      }
    }
  }

  async function disable (reason: string, generation = ++operationGeneration): Promise<void> {
    if (!state.enabled) {
      if (generation === operationGeneration) state.switchBusy = false
      pushAll()
      return
    }
    state.switchBusy = true
    pushAll()
    logger.info('关闭变道抓拍', { reason })
    clearEventRetries('抓拍模式已关闭，事件上报已取消')
    await stopCaptureInternal('disable')
    const projectId = deps.getProjectId()
    const dockSn = dockSnOr('')
    try {
      if (projectId && dockSn) await api.stopMode({ projectId, dockSn })
    } catch (error) {
      if (generation !== operationGeneration) {
        logger.warn('忽略旧一代变道模式关闭失败', { message: error instanceof Error ? error.message : String(error) })
        return
      }
      state.captureStatus = 'paused'
      state.switchBusy = false
      const message = `变道抓拍关闭失败：${error instanceof Error ? error.message : String(error)}`
      setMessage(message)
      pushAll()
      await notify('error', message)
      throw error
    }
    if (generation !== operationGeneration) return
    state.enabled = false
    state.captureStatus = 'idle'
    state.panelVisible = false
    state.canvasVisible = false
    state.drawingKind = null
    state.editing = false
    state.draftPoints = []
    state.switchBusy = false
    activeFlightId = null
    await releasePointerLease()
    setMessage(null)
    pushAll()
    await notify('info', '变道抓拍已关闭')
  }

  // === 抓拍状态机 ==========================================================

  const detector = createDetectorCore()
  let detectionSubscription: Disposable | undefined
  const pendingDetectionFrames: Array<{
    frame: DetectionFrameShape;
    generation: number;
    receivedAt: number;
    businessAt: number;
    businessTimeSource: 'drone' | 'browser-fallback';
    sequence: number;
  }> = []
  let detectionWorker: Promise<void> | undefined
  let detectionGeneration = 0
  let detectionSequence = 0
  let viewSettleUntil = 0
  let recordingLease: RecordingLease | undefined
  let recordingRevocation: { dispose (): void | Promise<void> } | undefined
  let autoPausing = false
  let eventGeneration = 0

  async function stopRecoveredRecording (generation: number): Promise<void> {
    if (!deps.camera) return
    let lastError: unknown
    let attempt = 0
    for (const delayMs of RECOVERY_STOP_RETRY_SCHEDULE_MS) {
      if (delayMs > 0) {
        logger.warn('停止遗留录像失败，准备重试', {
          attempt,
          message: lastError instanceof Error ? lastError.message : String(lastError),
        })
        await new Promise<void>((resolve) => {
          timers.setTimeout(resolve, delayMs)
        })
      }
      if (disposed || generation !== operationGeneration) return
      // 超时只代表结果未知：命令可能已实际停止录像，每次尝试前复查权威状态
      const cameraState = await deps.camera.getState()
      if (disposed || generation !== operationGeneration) return
      if (!cameraState.recording) return
      attempt += 1
      let lease: RecordingLease | undefined
      try {
        lease = await deps.camera.acquireRecording({ takeover: true }) as RecordingLease
        if (disposed || generation !== operationGeneration) return
        await lease.stop()
        return
      } catch (error) {
        if (!isPluginError(error) || error.code !== 'TIMEOUT') throw error
        lastError = error
      } finally {
        try {
          await lease?.dispose()
        } catch {
          // 录像已停止时句柄本地释放失败不影响设备终态
        }
      }
    }
    throw lastError
  }

  async function attachDetection (generation: number): Promise<boolean> {
    if (detectionSubscription) return true
    if (!deps.detection) return false
    let subscription: Disposable
    try {
      subscription = await deps.detection.onFrame(frame => void handleDetectionFrame(frame), { maxFps: 30 })
    } catch {
      // untrusted Runtime 上限 10fps；生产安装策略为 trusted 30fps
      subscription = await deps.detection.onFrame(frame => void handleDetectionFrame(frame), { maxFps: 10 })
    }
    if (generation !== detectionGeneration || !state.enabled || disposed) {
      await Promise.resolve(subscription.dispose()).catch(() => {})
      return false
    }
    detectionSubscription = subscription
    return true
  }

  async function startCapture (): Promise<void> {
    if (!state.enabled || state.captureStatus === 'capturing' || state.captureBusy) return
    if (state.drawingKind !== null || state.editing) {
      setMessage('请先完成标注编辑，再开始抓拍')
      pushAll()
      return
    }
    const usable = state.annotations.some(annotation => annotation.loaded
      && hasEnoughPoints(annotation.kind, annotation.points.length))
    if (!usable) {
      setMessage('请先加载或绘制标注，再开启抓拍')
      pushAll()
      return
    }
    if (!deps.detection) {
      setMessage('检测能力不可用，无法抓拍')
      pushAll()
      return
    }
    state.captureBusy = true
    pushAll()
    const generation = detectionGeneration
    try {
      // AI 门（对齐 person-road/wayline-teach 模式）：模式开启后用户可能在原生面板
      // 关闭识别；检测订阅建立前先自动开启车辆识别，纯配置编排先于设备资源编排。
      if (deps.aiConfig) {
        let confirmed = false
        let failure: string
        try {
          const result = await deps.aiConfig.ensure({ model: 'dji-visible', recognitionEnabled: true, targetTypes: ['vehicle'] })
          if (generation !== detectionGeneration || !state.enabled || disposed) return
          confirmed = result.confirmed
          failure = result.reason ?? '未知原因'
          if (confirmed) {
            const current = await deps.aiConfig.getState()
            if (generation !== detectionGeneration || !state.enabled || disposed) return
            confirmed = current.targetTypes.includes('vehicle')
            failure = 'AI 识别未能启用“车”识别'
          }
        } catch (error) {
          if (generation !== detectionGeneration || !state.enabled || disposed) return
          confirmed = false
          failure = error instanceof Error ? error.message : String(error)
        }
        if (!confirmed) {
          const message = `AI 识别配置失败：${failure}，请手动开启后再开启抓拍`
          setMessage(message)
          pushAll()
          await notify('warning', message)
          return
        }
      }
      // 全程录像（用户决策）：直接接管既有录像
      if (deps.camera) {
        let lease: RecordingLease | undefined
        try {
          lease = await deps.camera.acquireRecording({ takeover: true }) as RecordingLease
          const revocation = await lease.onRevoked(reason => void onRecordingRevoked(reason))
          if (generation !== detectionGeneration || !state.enabled || disposed) {
            await Promise.resolve(revocation.dispose()).catch(() => {})
            await lease.stop().catch(() => {})
            return
          }
          recordingLease = lease
          recordingRevocation = revocation
        } catch (error) {
          if (lease) await lease.stop().catch(() => {})
          logger.warn('获取录像所有权失败，按无录像模式抓拍', { message: error instanceof Error ? error.message : String(error) })
        }
      }
      if (generation !== detectionGeneration || !state.enabled || disposed) return
      detector.reset()
      if (!await attachDetection(generation)) return
      if (generation !== detectionGeneration || !state.enabled || disposed) return
      state.captureStatus = 'capturing'
      setMessage(null)
      pushAll()
      void refreshEvents()
    } finally {
      if (generation === detectionGeneration) {
        state.captureBusy = false
        pushAll()
      }
    }
  }

  async function pauseCapture (reason: string): Promise<void> {
    if (state.captureStatus !== 'capturing') return
    logger.info('暂停变道抓拍', { reason })
    await stopCaptureInternal(reason)
    state.captureStatus = 'paused'
    pushAll()
  }

  async function stopCaptureInternal (_reason: string): Promise<void> {
    detectionGeneration += 1
    state.captureBusy = false
    const subscription = detectionSubscription
    detectionSubscription = undefined
    pendingDetectionFrames.length = 0
    detector.reset()
    await Promise.resolve(subscription?.dispose()).catch(() => {})
    if (recordingLease) {
      const lease = recordingLease
      recordingLease = undefined
      const revocation = recordingRevocation
      recordingRevocation = undefined
      await revocation?.dispose()
      await lease.stop().catch((error) => {
        logger.warn('停止录像失败', { message: error instanceof Error ? error.message : String(error) })
      })
    }
  }

  async function onRecordingRevoked (reason: 'superseded' | 'device-state-changed' | 'disposed'): Promise<void> {
    if (reason === 'superseded') {
      recordingLease = undefined
      await recordingRevocation?.dispose()
      recordingRevocation = undefined
      return
    }
    if (autoPausing || state.captureStatus !== 'capturing') return
    autoPausing = true
    try {
      recordingLease = undefined
      await recordingRevocation?.dispose()
      recordingRevocation = undefined
      await pauseCapture(`recording-${reason}`)
      await notify('warning', '设备录像状态变化，变道抓拍已暂停')
    } finally {
      autoPausing = false
    }
  }

  // --- 检测循环 -----------------------------------------------------------

  function drainDetectionFrames (): Promise<void> {
    if (!detectionWorker) {
      detectionWorker = (async () => {
        while (pendingDetectionFrames.length > 0) {
          const pending = pendingDetectionFrames.shift()!
          if (pending.generation !== detectionGeneration) continue
          await processDetectionFrame(pending)
        }
      })().catch((error) => {
        logger.warn('变道检测帧处理失败', { message: error instanceof Error ? error.message : String(error) })
      }).finally(() => {
        detectionWorker = undefined
        if (pendingDetectionFrames.length > 0) void drainDetectionFrames()
      })
    }
    return detectionWorker
  }

  async function handleDetectionFrame (frame: DetectionFrameShape): Promise<void> {
    if (pendingDetectionFrames.length >= 8) pendingDetectionFrames.shift()
    const receivedAt = now()
    const aircraftTimestamp = droneTimestamp(telemetryState)
    pendingDetectionFrames.push({
      frame,
      generation: detectionGeneration,
      receivedAt,
      businessAt: aircraftTimestamp ?? receivedAt,
      businessTimeSource: aircraftTimestamp === null ? 'browser-fallback' : 'drone',
      sequence: ++detectionSequence,
    })
    await drainDetectionFrames()
  }

  async function processDetectionFrame (pending: {
    frame: DetectionFrameShape;
    generation: number;
    receivedAt: number;
    businessAt: number;
    businessTimeSource: 'drone' | 'browser-fallback';
    sequence: number;
  }): Promise<void> {
    const { frame, generation, receivedAt, businessAt, businessTimeSource, sequence } = pending
    if (!state.enabled || state.captureStatus !== 'capturing') return
    if (now() < viewSettleUntil) return
    const loadedGeo = state.annotations.filter(annotation => annotation.loaded && annotation.coordinateMode === 'geo')
    const projection = new Map<string, readonly VideoPoint[] | null>()
    if (loadedGeo.length > 0 && deps.detection) {
      const spans: Array<{ readonly id: string; readonly offset: number; readonly length: number }> = []
      let offset = 0
      const points = loadedGeo.flatMap((annotation) => {
        const annotationPoints = (annotation.points as readonly LngLat[]).map(point => ({
          lng: point.lng,
          lat: point.lat,
          height: annotation.groundHeight ?? 0,
        }))
        spans.push({ id: annotation.id, offset, length: annotationPoints.length })
        offset += annotationPoints.length
        return annotationPoints
      })
      const result = await deps.detection.projectFromGround(frame.frameId, points)
      for (const span of spans) {
        const projected = result?.points.slice(span.offset, span.offset + span.length)
        const valid = projected?.length === span.length
          && projected.every((point): point is VideoPoint => point !== null
            && Number.isFinite(point.x) && Number.isFinite(point.y))
        projection.set(span.id, valid ? projected : null)
      }
    } else {
      for (const annotation of loadedGeo) projection.set(annotation.id, null)
    }
    if (generation !== detectionGeneration || !state.enabled || state.captureStatus !== 'capturing') return
    processFrame(frame, projection, receivedAt, businessAt, businessTimeSource, sequence)
  }

  function processFrame (
    frame: DetectionFrameShape,
    projection: ReadonlyMap<string, readonly VideoPoint[] | null>,
    receivedAt: number,
    businessAt: number,
    businessTimeSource: 'drone' | 'browser-fallback',
    sequence: number,
  ): void {
    const regions: CoreRegion[] = []
    const validProjection = new Map<string, readonly VideoPoint[]>()
    for (const annotation of state.annotations) {
      if (!annotation.loaded) continue
      const points = annotation.coordinateMode === 'geo'
        ? projection.get(annotation.id)
        : annotation.points as readonly VideoPoint[]
      const kind = annotation.kind === 'solid-line' ? 'line' : 'polygon'
      if (!points || !hasEnoughPoints(annotation.kind, points.length)
        || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
        regions.push({ id: annotation.id, kind, valid: false })
        continue
      }
      validProjection.set(annotation.id, points)
      const regionPoints = points.map(point => ({ x: point.x, y: point.y }))
      regions.push(kind === 'line'
        ? { id: annotation.id, kind, valid: true, points: regionPoints }
        : { id: annotation.id, kind, valid: true, points: regionPoints })
    }
    const bboxes = toCoreBBoxes(frame.targets)
    const events = detector.processFrame({
      now: receivedAt,
      sequence,
      continuous: true,
      regions,
      bboxes,
    })
    for (const event of events) {
      void handleConfirm(event, validProjection, bboxes, businessAt, businessTimeSource, sequence)
    }
  }

  // --- 视角稳定锁 ---------------------------------------------------------

  let lastZoom: number | null = null
  let gimbalAccumSince = 0
  let gimbalAccum = 0

  function onViewChanged (): void {
    detector.reset()
    viewSettleUntil = now() + VIEW_SETTLE_MS
  }

  // === confirm 链 =========================================================

  async function handleConfirm (
    event: LaneChangeTriggerEvent,
    detectionProjection: ReadonlyMap<string, readonly VideoPoint[]>,
    frameBboxes: readonly CoreBBox[],
    businessAt: number,
    businessTimeSource: 'drone' | 'browser-fallback',
    sequence: number,
  ): Promise<void> {
    const annotation = state.annotations.find(item => item.id === event.regionId)
    if (!annotation || !annotation.loaded) return

    if (businessTimeSource === 'browser-fallback') {
      logger.warn('飞机时间戳不可用，变道事件回退浏览器时间', {
        operation: 'h_laneChange_createEvent',
        fallback: businessAt,
      })
    }
    const snapshotKey = `${businessAt}:${sequence}:${event.objId}:${event.regionId}`
    const dockSn = dockSnOr('')
    const projectId = deps.getProjectId()
    const flightId = flightIdOrEmpty()
    if (!projectId || !dockSn || !flightId) {
      logger.warn('变道事件上报失败：抓拍上下文不完整')
      return
    }
    const normalizedPoints = (detectionProjection.get(annotation.id)
      ?? latestProjection.get(annotation.id)
      ?? (annotation.coordinateMode === 'normalized' ? annotation.points as readonly VideoPoint[] : []))
      .map(point => ({ x: point.x, y: point.y }))
    if (!hasEnoughPoints(annotation.kind, normalizedPoints.length)) {
      logger.warn('变道事件未上报：标注缺少有效画面坐标', { annotationId: annotation.id })
      return
    }
    // 冻结本代上报：截图是本函数首个 await，期间模式可能被关闭或航次切换
    const submitGeneration = eventGeneration
    const position = dronePosition(telemetryState)
    const violationPosition: LngLat | null = position ? { lng: position.lng, lat: position.lat } : null

    // 叠绘几何：被压标线（上报同款归一化点）+ 涉事车辆 bbox（confirm 同帧检测目标）。
    const bboxRect = frameBboxes.find(item => item.objId === event.objId)?.rect
    const overlay: SnapshotOverlay = {
      kind: annotation.kind === 'solid-line' ? 'line' : 'polygon',
      normalizedPoints,
      bbox: bboxRect
        ? {
            cx: (bboxRect.x1 + bboxRect.x2) / 2,
            cy: (bboxRect.y1 + bboxRect.y2) / 2,
            w: bboxRect.x2 - bboxRect.x1,
            h: bboxRect.y2 - bboxRect.y1,
          }
        : undefined,
    }

    // 驾驶舱只展示违章发生时的实时码流截图；返航后生成的证据不参与本次会话。
    let screenshotUrl: string | null = null
    if (deps.camera) {
      try {
        const frame = await deps.camera.captureFrame({ scale: 0.5, mime: 'image/png' })
        // 截图叠绘标线 + 涉事车辆 bbox；失败降级裸截图，不阻断抓拍与上报。
        let blob = frame.blob
        const composited = await composeSnapshotOverlay(frame.blob, overlay)
        if (composited) blob = composited
        else logger.warn('变道截图叠绘失败，降级使用裸截图')
        const blobKey = `lane-change-snapshot:${flightIdOrEmpty()}:${snapshotKey}`
        await deps.blobs.put(blobKey, blob)
        screenshotUrl = (await deps.blobs.url(blobKey)) ?? null
      } catch (error) {
        logger.warn('证据截图失败', { message: error instanceof Error ? error.message : String(error) })
      }
    }

    // 截图期间模式已关闭/会话已重置：迟到确认直接丢弃，不回写新会话状态
    if (submitGeneration !== eventGeneration) return

    // 实时截图记录秒级可见，事件接口只回填 ID，并按 eventKey 精确合并。
    state.records = mergeRecords(
      [],
      [...state.records, {
        eventId: null,
        eventKey: snapshotKey,
        collisionType: annotation.kind === 'solid-line' ? 'solid_line' : 'guide_area',
        crossedAt: businessAt,
        title: '',
        screenshotUrl,
        position: violationPosition,
        postStatus: 'submitting',
        failureReason: '',
      }],
    )

    // 冻结上报 payload：normalized 用当前投影，geo 用库内原点
    const geoPoints = annotation.coordinateMode === 'geo'
      ? (annotation.points as readonly LngLat[]).map(point => ({
          lng: point.lng,
          lat: point.lat,
          height: annotation.groundHeight ?? 0,
        }))
      : []

    pushAll()
    // 统一告警入口（弹窗/音效由 activate 层告警协调器裁决）
    deps.onViolationDetected?.('发现目标')

    const payload: Parameters<LaneChangeApi['createEvent']>[0] = {
      projectId,
      dockSn,
      flightId,
      eventKey: snapshotKey,
      crossedAt: businessAt,
      collisionType: annotation.kind === 'solid-line' ? 'solid_line' : 'guide_area',
      objId: String(event.objId),
      regionId: event.regionId,
      annotationId: annotation.id,
      annotationSnapshot: {
        name: annotation.name,
        kind: annotation.kind === 'solid-line' ? 'line' : 'polygon',
        normalized_points: normalizedPoints,
        geo_points: geoPoints,
      },
    }
    void submitEvent(payload, submitGeneration, 0)
  }

  const eventRetryTimers = new Map<string, unknown>()

  function gatewayCodeOf (error: unknown): number | undefined {
    if (error === null || typeof error !== 'object') return undefined
    const detail = 'detail' in error ? error.detail : undefined
    if (detail === null || typeof detail !== 'object' || !('gatewayCode' in detail)) return undefined
    return typeof detail.gatewayCode === 'number' ? detail.gatewayCode : undefined
  }

  function shouldRetryEvent (error: unknown): boolean {
    const gatewayCode = gatewayCodeOf(error)
    if (gatewayCode !== undefined) return gatewayCode === 50301
    if (error instanceof TypeError) return true
    return error instanceof Error && (/network|fetch/i.test(error.message) || error.message.includes('code: 50301'))
  }

  async function submitEvent (
    payload: Parameters<LaneChangeApi['createEvent']>[0],
    generation: number,
    attempt: number,
  ): Promise<void> {
    if (generation !== eventGeneration || payload.projectId !== deps.getProjectId() || payload.flightId !== flightIdOrEmpty()) return
    try {
      const result = await api.createEvent(payload)
      if (generation !== eventGeneration || payload.projectId !== deps.getProjectId() || payload.flightId !== flightIdOrEmpty()) return
      state.records = state.records.map(record =>
        record.eventKey === result.eventKey
          ? { ...record, eventId: result.eventId, postStatus: result.postStatus }
          : record)
      pushAll()
    } catch (error) {
      if (generation !== eventGeneration) return
      if (attempt === 0 && shouldRetryEvent(error)) {
        const handle = timers.setTimeout(() => {
          eventRetryTimers.delete(payload.eventKey)
          void submitEvent(payload, generation, 1)
        }, EVENT_RETRY_DELAY_MS)
        eventRetryTimers.set(payload.eventKey, handle)
        return
      }
      const failureReason = error instanceof Error ? error.message : String(error)
      state.records = state.records.map(record => record.eventKey === payload.eventKey
        ? { ...record, postStatus: 'failed', failureReason }
        : record)
      pushAll()
      logger.warn('变道事件上报失败', { eventKey: payload.eventKey, message: failureReason })
    }
  }

  let recordsGeneration = 0

  function clearEventRetries (failureReason?: string): void {
    eventGeneration += 1
    for (const handle of eventRetryTimers.values()) timers.clearTimeout(handle)
    eventRetryTimers.clear()
    if (failureReason !== undefined) {
      state.records = state.records.map(record => record.postStatus === 'submitting' && record.eventId === null
        ? { ...record, postStatus: 'failed', failureReason }
        : record)
    }
  }

  async function refreshEvents (
    generation = recordsGeneration,
    projectId = deps.getProjectId(),
    flightId = flightIdOrEmpty(),
  ): Promise<void> {
    if (flightId === '' || !projectId) return
    try {
      const { events } = await api.listEvents({ projectId, flightId, page: 1, pageSize: 100 })
      if (generation !== recordsGeneration || projectId !== deps.getProjectId() || flightId !== flightIdOrEmpty()) return
      const backendRecords = await Promise.all(events.map(async (item) => {
        const local = state.records.find(record => record.eventKey === item.eventKey)
        const storedUrl = await deps.blobs.url(`lane-change-snapshot:${flightId}:${item.eventKey}`)
        return {
          eventId: item.eventId,
          eventKey: item.eventKey,
          crossedAt: item.crossedAt,
          collisionType: item.collisionType,
          screenshotUrl: local?.screenshotUrl ?? storedUrl ?? null,
          position: local?.position ?? null,
          postStatus: item.postStatus,
          failureReason: item.failureReason || item.rejectReason,
        }
      }))
      if (generation !== recordsGeneration || projectId !== deps.getProjectId() || flightId !== flightIdOrEmpty()) return
      state.records = mergeRecords(
        backendRecords,
        state.records,
      )
      pushAll()
    } catch (error) {
      logger.warn('刷新抓拍记录失败', { message: error instanceof Error ? error.message : String(error) })
    }
  }

  // === 工作台与画布操作 ====================================================

  async function commitDraft (): Promise<boolean> {
    const kind = state.drawingKind
    const points = state.draftPoints
    if (kind === null || !hasEnoughPoints(kind, points.length)) {
      setMessage('实线至少需要 2 个点，导流区至少需要 3 个点')
      pushAll()
      return false
    }

    // 新标注必须地理锚定；失败时保留草稿供用户重试或取消。
    const ground = groundHeight()
    if (deps.sceneGeometry && ground !== null) {
      try {
        const projected = await deps.sceneGeometry.projectVideoToGround(points, { groundHeight: ground })
        if (projected && projected.points.every(point => point !== null)) {
          const geoPoints = projected.points.map(point => ({ lng: point!.lng, lat: point!.lat }))
          state.annotations = [...state.annotations, {
            id: `anno-${Math.random().toString(36).slice(2)}`,
            name: nextAnnotationName(state.annotations, kind),
            kind,
            groundHeight: ground,
            coordinateMode: 'geo',
            points: geoPoints,
            origin: 'manual',
            loaded: true,
            createdAt: now(),
          }]
          state.draftPoints = []
          setMessage(null)
          schedulePersist()
          pushAll()
          await refreshGeoProjection()
          return true
        }
      } catch {
        // 下方统一提示，不生成会随视角漂移的画面坐标标注。
      }
    }
    setMessage('当前画面无法反投到地面，请确认激光测距和直播画面后重试')
    pushAll()
    return false
  }

  /** 画布编辑回流：video 点位更新后重新锚定（geo 模式反投，失败仅更新缓存投影）。 */
  const shapeMutationVersions = new Map<string, number>()
  async function mutateShapePoints (
    shapeId: string,
    transform: (points: readonly VideoPoint[]) => readonly VideoPoint[],
  ): Promise<void> {
    const annotation = state.annotations.find(item => item.id === shapeId)
    if (!annotation || !annotation.loaded) return
    const currentVideo = annotation.coordinateMode === 'geo'
      ? (latestProjection.get(annotation.id) ?? [])
      : annotation.points as readonly VideoPoint[]
    const nextVideo = transform(currentVideo)
    if (!hasEnoughPoints(annotation.kind, nextVideo.length)) return
    if (annotation.coordinateMode === 'normalized') {
      state.annotations = state.annotations.map(item => item.id === shapeId ? { ...item, points: nextVideo } : item)
      schedulePersist()
      pushAll()
      return
    }
    const ground = annotation.groundHeight ?? groundHeight()
    if (deps.sceneGeometry && ground !== null) {
      visualProjectionMutationCount += 1
      stopVisualProjectionPump()
      const version = (shapeMutationVersions.get(shapeId) ?? 0) + 1
      shapeMutationVersions.set(shapeId, version)
      latestProjection = new Map(latestProjection).set(shapeId, nextVideo)
      canvasState.update(current => ({ ...current, shapes: projectedShapes() }))
      try {
        const projected = await deps.sceneGeometry.projectVideoToGround(nextVideo, { groundHeight: ground })
        if (shapeMutationVersions.get(shapeId) === version && projected && projected.points.every(point => point !== null)) {
          const geoPoints = projected.points.map(point => ({ lng: point!.lng, lat: point!.lat }))
          state.annotations = state.annotations.map(item => item.id === shapeId ? { ...item, points: geoPoints, groundHeight: ground } : item)
          latestProjection = new Map(latestProjection).set(shapeId, nextVideo)
          schedulePersist()
          pushAll()
          return
        }
      } catch {
        // 下方按当前 geo 权威值重新投影，回滚本地预览。
      } finally {
        visualProjectionMutationCount -= 1
        if (visualProjectionMutationCount === 0) syncVisualProjectionPump()
      }
      if (shapeMutationVersions.get(shapeId) !== version) return
      setMessage('标注位置反投失败，已恢复原位置')
      pushAll()
    }
  }

  function clamp01 (value: number): number {
    return Math.min(1, Math.max(0, value))
  }

  const settings = {
    async setEnabled ({ enabled }: { readonly enabled: boolean }): Promise<void> {
      if (enabled) {
        if (state.switchBusy) return
        await enable(++operationGeneration)
      } else {
        await disable('setting-switch', ++operationGeneration)
      }
    },
  }

  const workbench = {
    async setCollapsed ({ collapsed }: { readonly collapsed: boolean }): Promise<void> {
      state.panelCollapsed = collapsed
      pushAll()
    },
    async close (): Promise<void> {
      state.panelVisible = false
      pushAll()
    },
    async setViolationType ({ type }: { readonly type: ViolationTypeFilter }): Promise<void> {
      if (state.captureStatus === 'capturing') {
        setMessage('抓拍中无法切换违章类型')
        pushAll()
        return
      }
      state.violationType = type
      // 卸载不属于新类型的标注（保留在库中，切回可重新勾选）
      state.annotations = state.annotations.map((annotation) => {
        const inFilter = type === 'both'
          || (type === 'solidLine' && annotation.kind === 'solid-line')
          || (type === 'guideArea' && annotation.kind === 'guide-area')
        return !inFilter && annotation.loaded ? { ...annotation, loaded: false } : annotation
      })
      await deps.storage.set(storageKey(STORAGE_VIOLATION_TYPE), type).catch(() => {})
      schedulePersist()
      pushAll()
    },
    async toggleAnnotationLoaded ({ id, loaded }: { readonly id: string; readonly loaded: boolean }): Promise<void> {
      state.annotations = state.annotations.map(annotation => annotation.id === id ? { ...annotation, loaded } : annotation)
      schedulePersist()
      pushAll()
      if (loaded) await refreshGeoProjection()
    },
    async renameAnnotation ({ id, name }: { readonly id: string; readonly name: string }): Promise<void> {
      const trimmed = name.trim()
      if (trimmed === '') return
      state.annotations = state.annotations.map(annotation => annotation.id === id ? { ...annotation, name: trimmed } : annotation)
      schedulePersist()
      pushAll()
    },
    async deleteAnnotation ({ id }: { readonly id: string }): Promise<void> {
      state.annotations = state.annotations.filter(annotation => annotation.id !== id)
      state.highlightedAnnotationId = null
      if (state.selectedShapeId === id) state.selectedShapeId = null
      schedulePersist()
      pushAll()
    },
    async setHighlight ({ id }: { readonly id: string | null }): Promise<void> {
      state.highlightedAnnotationId = id
      pushAll()
    },
    async beginDraw ({ kind }: { readonly kind: 'solid-line' | 'guide-area' }): Promise<void> {
      if (state.captureStatus === 'capturing') {
        setMessage('抓拍中无法编辑标注')
        pushAll()
        return
      }
      if (state.drawingKind === kind) {
        state.drawingKind = null
        state.draftPoints = []
        await releasePointerLease()
        setMessage(null)
        pushAll()
        return
      }
      if (state.drawingKind !== null || state.editing) {
        setMessage('请先完成当前编辑')
        pushAll()
        return
      }
      const ground = groundHeight()
      if (!deps.sceneGeometry || ground === null) {
        setMessage('未获取到激光测距或画面几何，无法绘制地理标注')
        pushAll()
        return
      }
      const anchor = await deps.sceneGeometry.projectVideoToGround([{ x: 0.5, y: 0.5 }], { groundHeight: ground }).catch(() => null)
      if (!anchor?.points[0] || !await acquirePointerLease()) {
        if (!anchor?.points[0]) {
          setMessage('当前直播画面无法反投到地面')
          pushAll()
        }
        return
      }
      state.drawingKind = kind
      state.draftPoints = []
      state.editing = false
      setMessage('点击画面添加顶点，双击完成')
      pushAll()
    },
    async finishEdit (): Promise<void> {
      if (state.drawingKind !== null) {
        state.drawingKind = null
        state.draftPoints = []
        await releasePointerLease()
        setMessage(null)
        pushAll()
        return
      }
      state.editing = false
      state.selectedShapeId = null
      await releasePointerLease()
      setMessage(null)
      pushAll()
    },
    async beginEdit (): Promise<void> {
      if (state.captureStatus === 'capturing') {
        setMessage('抓拍中无法编辑标注')
        pushAll()
        return
      }
      if (state.drawingKind !== null) {
        setMessage('请先完成当前绘制')
        pushAll()
        return
      }
      if (!await acquirePointerLease()) return
      state.editing = true
      setMessage('拖动顶点或标注调整位置')
      pushAll()
    },
    async toggleCapture (): Promise<void> {
      if (state.captureStatus === 'capturing') {
        await pauseCapture('user-pause')
      } else {
        await startCapture()
      }
    },
  }

  const canvas = {
    async addDraftPoint ({ point }: { readonly point: VideoPoint }): Promise<void> {
      if (state.drawingKind === null) return
      state.draftPoints = [...state.draftPoints, { x: clamp01(point.x), y: clamp01(point.y) }]
      pushAll()
    },
    async removeLastDraftPoint (): Promise<void> {
      if (state.drawingKind === null || state.draftPoints.length === 0) return
      state.draftPoints = state.draftPoints.slice(0, -1)
      pushAll()
    },
    async finishDraft (): Promise<void> {
      if (state.drawingKind === null) return
      // add 态连续绘制：完成后立即开下一条同类草稿（原生行为）
      const kind = state.drawingKind
      if (!await commitDraft()) return
      state.drawingKind = kind
      state.draftPoints = []
      pushAll()
    },
    async cancelDraft (): Promise<void> {
      state.draftPoints = []
      pushAll()
    },
    async selectShape ({ id }: { readonly id: string | null }): Promise<void> {
      state.selectedShapeId = id
      pushAll()
    },
    async moveVertex (input: { readonly shapeId: string; readonly vertexIndex: number; readonly point: VideoPoint }): Promise<void> {
      await mutateShapePoints(input.shapeId, points => points.map((existing, index) => (
        index === input.vertexIndex ? { x: clamp01(input.point.x), y: clamp01(input.point.y) } : existing
      )))
    },
    async moveShape (input: { readonly shapeId: string; readonly delta: VideoPoint }): Promise<void> {
      await mutateShapePoints(input.shapeId, points => points.map(existing => ({
        x: clamp01(existing.x + input.delta.x),
        y: clamp01(existing.y + input.delta.y),
      })))
    },
    async insertVertex (input: { readonly shapeId: string; readonly segmentIndex: number; readonly point: VideoPoint }): Promise<void> {
      await mutateShapePoints(input.shapeId, (points) => {
        const next: VideoPoint[] = []
        for (let index = 0; index < points.length; index += 1) {
          next.push(points[index]!)
          if (index === input.segmentIndex) next.push({ x: clamp01(input.point.x), y: clamp01(input.point.y) })
        }
        return next
      })
    },
    async deleteVertex (input: { readonly shapeId: string; readonly vertexIndex: number }): Promise<void> {
      await mutateShapePoints(input.shapeId, points => points.filter((_, index) => index !== input.vertexIndex))
    },
    async deleteShape ({ shapeId }: { readonly shapeId: string }): Promise<void> {
      state.annotations = state.annotations.filter(annotation => annotation.id !== shapeId)
      if (state.selectedShapeId === shapeId) state.selectedShapeId = null
      schedulePersist()
      pushAll()
    },
  }

  // === 订阅与生命周期 ======================================================

  async function attachSubscriptions (): Promise<void> {
    if (deps.telemetry) {
      telemetryState = await deps.telemetry.getState()
      if (disposed) return
      const telemetrySubscription = await deps.telemetry.onStateChanged(({ state: next }) => {
        const previous = telemetryState
        telemetryState = next
        // gate 失效自动关闭（对齐原生 payload-ctl-lost / mode-code-blocked）
        if (state.enabled && !state.switchBusy) {
          const reason = gateReason()
          if (reason !== null) {
            const disableReason = reason.includes('控制权') ? 'payload-ctl-lost' : 'mode-code-blocked'
            void disable(disableReason).catch((error: unknown) => {
              logger.warn('自动关闭变道抓拍失败', {
                reason: disableReason,
                message: error instanceof Error ? error.message : String(error),
              })
            })
            return
          }
        }
        // 视角稳定锁：云台单次 ≥5° 或 1s 累计 ≥10°
        const gimbal = next.payload.gimbal
        const previousGimbal = previous?.payload.gimbal
        if (gimbal && previousGimbal
          && gimbal.yaw !== null && gimbal.pitch !== null
          && previousGimbal.yaw !== null && previousGimbal.pitch !== null) {
          const yawDelta = Math.abs(gimbal.yaw - previousGimbal.yaw)
          const pitchDelta = Math.abs(gimbal.pitch - previousGimbal.pitch)
          if (yawDelta >= GIMBAL_JUMP_DEGREE || pitchDelta >= GIMBAL_JUMP_DEGREE) {
            onViewChanged()
          } else {
            if (gimbalAccumSince === 0 || now() - gimbalAccumSince > 1000) {
              gimbalAccumSince = now()
              gimbalAccum = 0
            }
            gimbalAccum += yawDelta + pitchDelta
            if (gimbalAccum >= GIMBAL_ACCUM_DEGREE) onViewChanged()
          }
        }
        // 高频遥测帧只需刷新开关门控；gate 失效路径由 disable() 自行收敛完整 UI
        pushSettings()
      })
      if (disposed) {
        await Promise.resolve(telemetrySubscription.dispose()).catch(() => {})
        return
      }
      disposables.push(telemetrySubscription)
    }
    if (deps.camera) {
      const cameraSubscription = await deps.camera.onStateChanged((next) => {
        // 相机离开录像模式且非自身持租 → 暂停
        if (state.captureStatus === 'capturing' && next.mode !== 'record' && !recordingLease) {
          void pauseCapture('camera-mode-changed')
        }
        if (next.zoom !== null && lastZoom !== null && Math.abs(next.zoom - lastZoom) >= 0.1) onViewChanged()
        lastZoom = next.zoom
      })
      if (disposed) {
        await Promise.resolve(cameraSubscription.dispose()).catch(() => {})
        return
      }
      disposables.push(cameraSubscription)
    }
  }

  void attachSubscriptions()

  return {
    settingsState,
    workbenchState,
    canvasState,
    recordsState,
    settings,
    workbench,
    canvas,
    attachUi (handles) {
      ui = handles
      void pushUi()
    },
    async recover () {
      const generation = operationGeneration
      await restorePersisted()
      if (generation !== operationGeneration) return
      if (!telemetryState && deps.telemetry) telemetryState = await deps.telemetry.getState()
      if (generation !== operationGeneration) return
      try {
        const dockSn = dockSnOr('')
        if (dockSn) {
          const projectId = deps.getProjectId()
          const currentFlightId = deps.getFlightId()
          if (!projectId || !currentFlightId) return
          const status = await api.getMode({ projectId, dockSn })
          if (generation === operationGeneration && status.isActive && status.flightId === currentFlightId) {
            let recoveryError: string | null = null
            try {
              // 刷新后旧 Runtime 的录像会保留；对齐原生逻辑，先停止孤儿录像再恢复为空闲态。
              await stopRecoveredRecording(generation)
            } catch (error) {
              recoveryError = `恢复变道抓拍时停止遗留录像失败，请在相机控制中手动停止录像：${error instanceof Error ? error.message : String(error)}`
              logger.warn('恢复变道抓拍时停止遗留录像失败', { message: error instanceof Error ? error.message : String(error) })
            }
            if (generation !== operationGeneration) return
            state.enabled = true
            state.captureStatus = 'idle'
            state.panelVisible = true
            state.canvasVisible = state.annotations.some(annotation => annotation.loaded)
            setMessage(recoveryError)
            if (recoveryError) await notify('error', recoveryError)
            // 按后端返回的航次恢复模式，避免旧航次数据写入新航次
            activeFlightId = currentFlightId
          }
        }
      } catch {
        // 后端不可达时按未开启处理
      }
      await refreshEvents()
      pushAll()
      await refreshGeoProjection()
    },
    /** 外部上下文变化（如航次切换）后刷新开关门控呈现；对齐 person-road 只推送 settings。 */
    refreshGate (): void {
      pushSettings()
    },
    resetSession (): void {
      if (persistTimer !== undefined) timers.clearTimeout(persistTimer)
      persistTimer = undefined
      activeFlightId = null
      recordsGeneration += 1
      clearEventRetries()
      operationGeneration += 1
      state.enabled = false
      state.captureStatus = 'idle'
      state.panelVisible = false
      state.canvasVisible = false
      state.annotations = []
      latestProjection.clear()
      state.records = []
      pushAll()
    },
    async dispose () {
      disposed = true
      operationGeneration += 1
      stopVisualProjectionPump()
      const wasEnabled = state.enabled
      recordsGeneration += 1
      clearEventRetries()
      await stopCaptureInternal('dispose')
      await detectionWorker
      await releasePointerLease()
      for (const disposable of [...disposables].reverse()) {
        await Promise.resolve(disposable.dispose()).catch(() => {})
      }
      disposables.length = 0
      if (wasEnabled) {
        const projectId = deps.getProjectId()
        const dockSn = dockSnOr('')
        if (projectId && dockSn) await api.stopMode({ projectId, dockSn })
      }
      state.enabled = false
      activeFlightId = null
    },
  }
}
