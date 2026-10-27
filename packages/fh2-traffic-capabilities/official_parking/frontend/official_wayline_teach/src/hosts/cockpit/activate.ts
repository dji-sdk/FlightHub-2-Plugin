// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState, isPluginError } from 'fh2-plugin-sdk'
import type {
  ApiCallOptions,
  AsyncDisposable,
  Disposable,
  JsonValue,
  PluginValue,
  ViewPresentation,
} from 'fh2-plugin-sdk'
import { createTeachApi } from '../../api/teach-api'
import type { ApiCall } from '../../api/teach-api'
import { createTeachTransport } from '../../api/teach-mock'
import type { WaylineTeachContext } from '../../types'
import { createTeachController } from '../../workflow/teach-controller'
import type { TeachConflictDecision, TeachController } from '../../workflow/teach-controller'
import type { TeachSessionState, TeachWaypoint } from '../../workflow/teach-session'
import type { TeachTelemetryState } from '../../workflow/teach-telemetry'
import { teachDialogView } from '../../views/teach-dialog/contract'
import type { TeachDialogState } from '../../views/teach-dialog/contract'
import { teachPanelView } from '../../views/teach-panel/contract'
import type { TeachPanelState } from '../../views/teach-panel/contract'
import { createTeachTelemetryAdapter } from './teach-telemetry-adapter'

const REQUIRED_CAPABILITIES = [
  'cockpit:context',
  'cockpit:telemetry',
  'cockpit:ai-config',
  'cockpit:camera',
  'cockpit:scene-geometry',
  'cockpit:hotkeys',
  'platform:dialog',
  'platform:object-upload',
] as const

const DIAG_PREFIX = '[WAYLINE_TEACH_DIAG]'
const SCREENSHOT_DIAG_PREFIX = '[WAYLINE_TEACH_SCREENSHOT_DIAG]'
const BUILD_MARKER = 'zelin-plugin-ui-20260902'
const TEACH_ENTRY_ICON = 'wayline-teach'

function apiResponseCode (value: JsonValue): number | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Readonly<Record<string, JsonValue>>
  return typeof record.code === 'number' ? record.code : null
}

function diagnosticError (error: unknown): {
  readonly name: string;
  readonly message: string;
  readonly code: string | null;
  readonly detail: PluginValue;
} {
  if (isPluginError(error)) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      detail: error.detail ?? null,
    }
  }
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    code: null,
    detail: null,
  }
}

function telemetryDiagnostic (state: TeachTelemetryState, liveReady: boolean) {
  return {
    capturedAt: state.capturedAt,
    source: state.source,
    liveReady,
    projectId: state.projectId,
    flightId: state.flightId,
    dockSn: state.dockSn,
    droneSn: state.droneSn,
    gatewaySn: state.gatewaySn,
    longitudeReady: Number.isFinite(state.longitude),
    latitudeReady: Number.isFinite(state.latitude),
    height: state.height,
    cameraYaw: state.cameraYaw,
    gimbalPitch: state.gimbalPitch,
    focalLength: state.focalLength,
    horizontalSpeed: state.horizontalSpeed,
    verticalSpeed: state.verticalSpeed,
    aiAvailable: state.aiAvailable,
    aiRecognitionOn: state.aiRecognitionOn,
    aiTargetTypes: [...state.aiTargetTypes],
  }
}

function formatDistance (waypoints: readonly TeachWaypoint[]): string {
  let distance = 0
  for (let index = 1; index < waypoints.length; index++) {
    const previous = waypoints[index - 1]!
    const current = waypoints[index]!
    const latitudeDelta = (current.latitude - previous.latitude) * Math.PI / 180
    const longitudeDelta = (current.longitude - previous.longitude) * Math.PI / 180
    const startLatitude = previous.latitude * Math.PI / 180
    const endLatitude = current.latitude * Math.PI / 180
    const haversine = Math.sin(latitudeDelta / 2) ** 2
      + Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2
    distance += 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  }
  return distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${distance.toFixed(1)} m`
}

function telemetryProblem (state: TeachTelemetryState, liveReady: boolean): string | null {
  if (!liveReady) return '等待直播首帧'
  if (!state.projectId || !state.flightId || !state.dockSn || !state.droneSn) return '等待项目、航次和设备上下文'
  if (!Number.isFinite(state.longitude) || !Number.isFinite(state.latitude)) return '等待飞机位置'
  if (!Number.isFinite(state.height)) return '等待 WGS84 椭球高'
  if (!Number.isFinite(state.cameraYaw) || !Number.isFinite(state.gimbalPitch)) return '等待云台姿态'
  if (!Number.isFinite(state.focalLength)) return '等待相机焦距'
  if (!state.aiAvailable) return '等待 AI 识别状态'
  return null
}

function panelState (
  session: TeachSessionState,
  telemetry: TeachTelemetryState,
  liveReady: boolean,
  busy: boolean,
  mockMode: boolean,
): TeachPanelState {
  const problem = telemetryProblem(telemetry, liveReady)
  const waypoints = session.route?.waypoints ?? []
  return {
    phase: session.phase,
    ready: problem === null,
    disabledReason: problem,
    busy,
    mockMode,
    routeName: session.route?.name ?? '',
    routeDistance: formatDistance(waypoints),
    globalSpeed: session.route?.globalSpeed ?? 15,
    waypointSpeed: session.route?.waypointSpeed ?? 5,
    waylineUuid: session.route?.waylineUuid ?? null,
    waylineFileId: session.route?.waylineFileId ?? null,
    waypointCount: session.route?.waypointCount ?? waypoints.length,
    screenshotBytes: session.route?.screenshotBytes ?? 0,
    screenshotQuotaBytes: 80 * 1024 * 1024,
    selectedCount: waypoints.filter(waypoint => waypoint.selected).length,
    waypoints: waypoints.map(waypoint => ({
      id: waypoint.id,
      seq: waypoint.seq,
      selected: waypoint.selected,
      height: waypoint.height,
      cameraYaw: waypoint.cameraYaw,
      focalLength: waypoint.focalLength,
      aiRecognitionOn: waypoint.aiRecognitionOn,
      aiTargetTypes: waypoint.aiTargetTypes,
      screenshotUrl: waypoint.screenshotUrl,
      screenshotError: waypoint.screenshotError,
    })),
  }
}

function defaultRouteName (): string {
  const date = new Date()
  const twoDigits = (value: number): string => String(value).padStart(2, '0')
  return `新建巡逻航线${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}-${twoDigits(date.getHours())}-${twoDigits(date.getMinutes())}-${twoDigits(date.getSeconds())}`
}

export async function activate (ctx: WaylineTeachContext) {
  ctx.logger.info(`${DIAG_PREFIX} 插件开始激活`, {
    buildMarker: BUILD_MARKER,
    pluginId: ctx.plugin.id,
    pluginVersion: ctx.plugin.version,
    hostId: ctx.host.id,
    enableMock: ctx.config.enableMock,
  })
  const capabilities = await Promise.all([
    ctx.capabilities.get('cockpit:context'),
    ctx.capabilities.get('cockpit:telemetry'),
    ctx.capabilities.get('cockpit:ai-config'),
    ctx.capabilities.get('cockpit:camera'),
    ctx.capabilities.get('cockpit:scene-geometry'),
    ctx.capabilities.get('cockpit:hotkeys'),
    ctx.capabilities.get('platform:dialog'),
    ctx.capabilities.get('platform:object-upload'),
    ctx.capabilities.get('platform:notification'),
    ctx.capabilities.get('platform:devices'),
  ])
  const [cockpitContext, cockpitTelemetry, aiConfig, camera, sceneGeometry, hotkeys, dialog, objectUpload, notification, devices] = capabilities
  const missing = REQUIRED_CAPABILITIES.filter((_id, index) => !capabilities[index])
  ctx.logger.info(`${DIAG_PREFIX} Capability 解析结果`, {
    cockpitContext: Boolean(cockpitContext),
    telemetry: Boolean(cockpitTelemetry),
    aiConfig: Boolean(aiConfig),
    camera: Boolean(camera),
    sceneGeometry: Boolean(sceneGeometry),
    hotkeys: Boolean(hotkeys),
    dialog: Boolean(dialog),
    objectUpload: Boolean(objectUpload),
    notification: Boolean(notification),
    devices: Boolean(devices),
    missing: [...missing],
  })
  if (!cockpitContext || !cockpitTelemetry || !aiConfig || !camera || !sceneGeometry || !hotkeys || !dialog || !objectUpload) {
    ctx.logger.warn(`${DIAG_PREFIX} 示教插件缺少必要 Capability`, { missing: [...missing] })
    await ctx.extensions.contribute('wayline-teach-entry', {
      icon: 'wayline-teach',
      label: '示教航线',
      active: false,
      disabled: true,
      onTrigger: () => {
        void notification?.show({
          key: 'wayline-teach-unavailable',
          message: `示教能力不可用：${missing.join('、')}`,
          intent: 'warning',
        })
      },
    })
    return
  }
  const dialogCapability = dialog

  const disposables: Array<Disposable | AsyncDisposable> = []
  const telemetry = await createTeachTelemetryAdapter({
    context: cockpitContext,
    telemetry: cockpitTelemetry,
    aiConfig,
    onError: error => ctx.logger.error(`${DIAG_PREFIX} 示教遥测组合失败`, diagnosticError(error)),
  })
  disposables.push(telemetry)
  let telemetryState = await telemetry.getState()
  const initialCockpitContext = await cockpitContext.getState()
  let liveReady = initialCockpitContext.liveReady
  ctx.logger.info(`${DIAG_PREFIX} 初始 Cockpit Context`, initialCockpitContext)
  ctx.logger.info(`${DIAG_PREFIX} 初始示教遥测`, telemetryDiagnostic(telemetryState, liveReady))
  let panelVisible = false
  let hotkeyEnabled = false
  let dialogPresentation: ViewPresentation | undefined
  let conflictResolver: ((decision: TeachConflictDecision) => void) | undefined
  let dialogPreparing = false
  let dialogRouteId: string | undefined
  let exitingForLiveStop = false
  let lastTelemetryProblem: string | null | undefined
  let lastPanelDiagnosticSignature = ''
  let lastAiDiagnosticSignature = ''
  let lastContextDiagnosticSignature = JSON.stringify({
    organizationId: initialCockpitContext.organizationId,
    projectId: initialCockpitContext.projectId,
    droneSn: initialCockpitContext.droneSn,
    gatewaySn: initialCockpitContext.gatewaySn,
    liveReady: initialCockpitContext.liveReady,
  })

  function logAiState (state: TeachTelemetryState, source: string): void {
    const detail = {
      source,
      capturedAt: state.capturedAt,
      aiAvailable: state.aiAvailable,
      aiRecognitionOn: state.aiRecognitionOn,
      aiTargetTypes: [...state.aiTargetTypes],
      valid: !state.aiRecognitionOn || state.aiTargetTypes.length > 0,
    }
    const signature = JSON.stringify({
      aiAvailable: detail.aiAvailable,
      aiRecognitionOn: detail.aiRecognitionOn,
      aiTargetTypes: detail.aiTargetTypes,
    })
    if (signature === lastAiDiagnosticSignature) return
    lastAiDiagnosticSignature = signature
    if (!detail.valid) ctx.logger.warn(`${DIAG_PREFIX} AI 识别状态无合法目标类型`, detail)
    else ctx.logger.info(`${DIAG_PREFIX} AI 识别状态变化`, detail)
  }

  logAiState(telemetryState, 'initial')

  const initialDialogState: TeachDialogState = {
    kind: 'generate',
    defaultName: defaultRouteName(),
    defaultGlobalSpeed: 15,
    defaultWaypointSpeed: 5,
    selectedCount: 0,
    screenshotBytes: 0,
    screenshotQuotaBytes: 80 * 1024 * 1024,
    waypoints: [],
    pending: false,
    error: null,
  }
  const dialogState = createViewState<TeachDialogState>(initialDialogState)
  const viewState = createViewState<TeachPanelState>(panelState(
    { phase: 'idle', route: null },
    telemetryState,
    liveReady,
    false,
    false,
  ))

  const notify = (message: string, intent: 'success' | 'warning' | 'error' = 'error'): void => {
    void notification?.show({ key: `wayline-teach-${Date.now()}`, message, intent, durationMs: 3000 })
  }
  const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)
  const transport = createTeachTransport({
    apiCall: (endpoint, options) => ctx.apiCall(endpoint, options),
    objectUpload,
    enableMock: ctx.config.enableMock,
  })
  ctx.logger.info(`${DIAG_PREFIX} 示教后端模式`, { mode: transport.isMock() ? 'mock' : 'real' })
  if (transport.isMock()) {
    ctx.logger.warn(`${DIAG_PREFIX} 示教已启用内存模拟，所有数据仅在当前页面有效`)
    notify('示教模拟已开启，结果不会生成真实 KMZ', 'warning')
  }
  const diagnosticApiCall: ApiCall = async (endpoint: string, options?: ApiCallOptions) => {
    const startedAt = Date.now()
    const requestDiagPrefix = endpoint.includes('screenshot') ? SCREENSHOT_DIAG_PREFIX : DIAG_PREFIX
    ctx.logger.info(`${requestDiagPrefix} API 请求`, {
      mode: transport.isMock() ? 'mock' : 'real',
      endpoint,
      method: options?.method ?? 'GET',
      timeoutMs: options?.timeoutMs ?? null,
    })
    try {
      const response = await transport.apiCall(endpoint, options)
      ctx.logger.info(`${requestDiagPrefix} API 响应`, {
        endpoint,
        method: options?.method ?? 'GET',
        elapsedMs: Date.now() - startedAt,
        code: apiResponseCode(response),
      })
      return response
    } catch (error) {
      ctx.logger.error(`${requestDiagPrefix} API 失败`, {
        endpoint,
        method: options?.method ?? 'GET',
        elapsedMs: Date.now() - startedAt,
        error: diagnosticError(error),
      })
      throw error
    }
  }
  const api = createTeachApi(diagnosticApiCall)
  disposables.push({ dispose: () => transport.dispose() })

  async function closeDialog (): Promise<void> {
    const current = dialogPresentation
    dialogPresentation = undefined
    dialogRouteId = undefined
    await current?.close()
  }

  async function settleConflict (decision: TeachConflictDecision): Promise<void> {
    const resolve = conflictResolver
    conflictResolver = undefined
    resolve?.(decision)
    await closeDialog()
  }

  async function openConflict (existing: TeachSessionState): Promise<TeachConflictDecision> {
    dialogState.update(() => ({
      kind: 'conflict',
      routeName: existing.route?.name ?? '',
      waypointCount: existing.route?.waypoints.length ?? 0,
      createdAt: existing.route?.createdAt ?? null,
      confirmingRecreate: false,
      pending: false,
      error: null,
    }))
    await closeDialog()
    dialogPresentation = await dialogCapability.open(teachDialogView.get(ctx), { title: '示教路线冲突', width: 520 })
    const current = dialogPresentation
    syncPanel()
    return new Promise<TeachConflictDecision>((resolve) => {
      conflictResolver = resolve
      void current.closed.then(() => {
        if (dialogPresentation === current) dialogPresentation = undefined
        syncPanel()
        if (!conflictResolver) return
        const pending = conflictResolver
        conflictResolver = undefined
        pending('cancel')
      })
    })
  }

  const controller: TeachController = createTeachController({
    api,
    telemetry,
    // 录点前的车辆 AI 识别门：controller 通过 ensure 自动开启车辆识别。
    ai: aiConfig,
    camera,
    sceneGeometry,
    objectUpload: transport.objectUpload,
    // 生成必须取得当前飞机原始机型 key；能力缺失时 controller 报错并保留录制内容。
    ...(devices ? { devices } : {}),
    resolveConflict: openConflict,
    onCleanupError: error => ctx.logger.warn(`${DIAG_PREFIX} 释放示教截图几何快照失败`, { message: errorMessage(error) }),
    onScreenshotError: ({ stage, routeId, waypointId, error }) => {
      ctx.logger.error(`${SCREENSHOT_DIAG_PREFIX} 截图链路失败`, {
        stage,
        routeId,
        waypointId,
        error: diagnosticError(error),
      })
    },
    onTelemetrySnapshot: (snapshot) => {
      ctx.logger.info(`${DIAG_PREFIX} 示教录点使用驾驶舱聚合遥测快照`, {
        capturedAt: snapshot.capturedAt,
        source: snapshot.source,
        projectId: snapshot.projectId,
        flightId: snapshot.flightId,
        dockSn: snapshot.dockSn,
        droneSn: snapshot.droneSn,
        positionAvailable: Number.isFinite(snapshot.longitude) && Number.isFinite(snapshot.latitude),
        height: snapshot.height,
        cameraYaw: snapshot.cameraYaw,
        gimbalPitch: snapshot.gimbalPitch,
        focalLength: snapshot.focalLength,
        aiAvailable: snapshot.aiAvailable,
        aiRecognitionOn: snapshot.aiRecognitionOn,
        aiTargetTypes: [...snapshot.aiTargetTypes],
      })
    },
  })

  let panelContribution: Awaited<ReturnType<typeof ctx.extensions.contribute<'wayline-teach-panel'>>> | undefined
  let entryContribution: Awaited<ReturnType<typeof ctx.extensions.contribute<'wayline-teach-entry'>>> | undefined
  let hotkeyHandle: Awaited<ReturnType<typeof hotkeys.register>> | undefined

  function syncPanel (): void {
    const session = controller.getState()
    const next = panelState(session, telemetryState, liveReady, controller.isBusy() || dialogPreparing, transport.isMock())
    viewState.update(() => next)
    const quotaFull = next.screenshotBytes >= next.screenshotQuotaBytes
    const panelDiagnostic = {
      panelVisible,
      phase: next.phase,
      ready: next.ready,
      disabledReason: next.disabledReason,
      busy: next.busy,
      dialogOpen: dialogPresentation !== undefined,
      waypointCount: next.waypoints.length,
      selectedCount: next.selectedCount,
      screenshotBytes: next.screenshotBytes,
      screenshotQuotaBytes: next.screenshotQuotaBytes,
      quotaFull,
      recordEnabled: next.ready && !next.busy
        && (next.phase === 'idle' || next.phase === 'recording') && !quotaFull,
      finishEnabled: next.phase === 'recording' && next.waypoints.length > 0 && !next.busy,
      mockMode: next.mockMode,
    }
    const panelDiagnosticSignature = JSON.stringify(panelDiagnostic)
    if (panelDiagnosticSignature !== lastPanelDiagnosticSignature) {
      lastPanelDiagnosticSignature = panelDiagnosticSignature
      ctx.logger.info(`${DIAG_PREFIX} 面板交互判定`, panelDiagnostic)
    }
    if (next.disabledReason !== lastTelemetryProblem) {
      lastTelemetryProblem = next.disabledReason
      if (next.disabledReason) {
        ctx.logger.warn(`${DIAG_PREFIX} 示教遥测未就绪`, {
          reason: next.disabledReason,
          capturedAt: telemetryState.capturedAt,
          source: telemetryState.source,
          liveReady,
          projectReady: Boolean(telemetryState.projectId),
          flightReady: Boolean(telemetryState.flightId),
          dockReady: Boolean(telemetryState.dockSn),
          droneReady: Boolean(telemetryState.droneSn),
          positionReady: Number.isFinite(telemetryState.longitude) && Number.isFinite(telemetryState.latitude),
          heightReady: Number.isFinite(telemetryState.height),
          gimbalReady: Number.isFinite(telemetryState.cameraYaw) && Number.isFinite(telemetryState.gimbalPitch),
          focalLengthReady: Number.isFinite(telemetryState.focalLength),
          aiAvailable: telemetryState.aiAvailable,
        })
      } else {
        ctx.logger.info(`${DIAG_PREFIX} 示教遥测已就绪`, {
          capturedAt: telemetryState.capturedAt,
          source: telemetryState.source,
          flightId: telemetryState.flightId,
          droneSn: telemetryState.droneSn,
        })
      }
    }
    const currentDialog = dialogState.get()
    if (dialogPresentation && currentDialog.kind === 'generate' && session.route) {
      dialogState.update(() => ({
        ...currentDialog,
        selectedCount: session.route!.waypoints.filter(waypoint => waypoint.selected).length,
        screenshotBytes: session.route!.screenshotBytes,
        waypoints: session.route!.waypoints.map(waypoint => ({
          id: waypoint.id,
          seq: waypoint.seq,
          selected: waypoint.selected,
          height: waypoint.height,
          cameraYaw: waypoint.cameraYaw,
          gimbalPitch: waypoint.gimbalPitch,
          focalLength: waypoint.focalLength,
          aiRecognitionOn: waypoint.aiRecognitionOn,
          aiTargetTypes: waypoint.aiTargetTypes,
          screenshotUrl: waypoint.screenshotUrl,
          screenshotError: waypoint.screenshotError,
        })),
      }))
    }
    const shouldEnableHotkey = panelVisible && dialogPresentation === undefined && next.ready && !next.busy
      && (next.phase === 'idle' || next.phase === 'recording')
    if (hotkeyHandle && shouldEnableHotkey !== hotkeyEnabled) {
      hotkeyEnabled = shouldEnableHotkey
      void hotkeyHandle.update({ enabled: shouldEnableHotkey })
    }
  }

  async function runOperation (operation: () => Promise<void>): Promise<void> {
    try {
      const pending = operation()
      syncPanel()
      await pending
    } catch (error) {
      notify(errorMessage(error))
    } finally {
      syncPanel()
    }
  }

  async function runDialogRouteOperation (operation: () => Promise<void>): Promise<void> {
    if (!dialogRouteId || controller.getState().route?.id !== dialogRouteId) {
      await closeDialog()
      notify('项目或航次已切换，请重新打开确认窗口', 'warning')
      return
    }
    await runOperation(operation)
  }

  async function hidePanel (): Promise<void> {
    panelVisible = false
    await panelContribution?.update({ visible: false })
    await entryContribution?.update({ active: false })
    syncPanel()
  }

  async function exitForDronePayloadStop (): Promise<void> {
    if (exitingForLiveStop) return
    exitingForLiveStop = true
    try {
      conflictResolver?.('cancel')
      conflictResolver = undefined
      await closeDialog()
      await hidePanel()
      await controller.exitTeaching()
    } catch (error) {
      notify(`直播已停止，示教路线清理失败：${errorMessage(error)}`, 'warning')
    } finally {
      exitingForLiveStop = false
      syncPanel()
    }
  }

  async function openGenerateDialog (): Promise<void> {
    const route = controller.getState().route
    if (!route) return
    dialogPreparing = true
    syncPanel()
    try {
      if (controller.getState().route?.id !== route.id) return
      dialogState.update(() => ({
        kind: 'generate',
        defaultName: route.name || defaultRouteName(),
        defaultGlobalSpeed: route.globalSpeed,
        defaultWaypointSpeed: route.waypointSpeed,
        selectedCount: route.waypoints.filter(waypoint => waypoint.selected).length,
        screenshotBytes: route.screenshotBytes,
        screenshotQuotaBytes: 80 * 1024 * 1024,
        waypoints: route.waypoints.map(waypoint => ({
          id: waypoint.id,
          seq: waypoint.seq,
          selected: waypoint.selected,
          height: waypoint.height,
          cameraYaw: waypoint.cameraYaw,
          gimbalPitch: waypoint.gimbalPitch,
          focalLength: waypoint.focalLength,
          aiRecognitionOn: waypoint.aiRecognitionOn,
          aiTargetTypes: waypoint.aiTargetTypes,
          screenshotUrl: waypoint.screenshotUrl,
          screenshotError: waypoint.screenshotError,
        })),
        pending: false,
        error: null,
      }))
      await closeDialog()
      dialogPresentation = await dialogCapability.open(teachDialogView.get(ctx), { title: '确认示教航点', width: 800 })
      dialogRouteId = route.id
      const current = dialogPresentation
      void current.closed.then(() => {
        if (dialogPresentation === current) dialogPresentation = undefined
        if (dialogRouteId === route.id) dialogRouteId = undefined
        syncPanel()
      })
    } finally {
      dialogPreparing = false
      syncPanel()
    }
  }

  disposables.push(await teachPanelView.handle(ctx, {
    state: viewState,
    methods: {
      recordWaypoint: () => runOperation(() => controller.recordWaypoint()),
      requestGenerate: () => runOperation(openGenerateDialog),
      startNewTeaching: () => runOperation(async () => controller.startNewTeaching()),
      dismiss: () => hidePanel(),
    },
  }))
  disposables.push(await teachDialogView.handle(ctx, {
    state: dialogState,
    methods: {
      cancel: async () => {
        if (conflictResolver) {
          await settleConflict('cancel')
          await hidePanel()
        } else {
          await closeDialog()
        }
      },
      loadExisting: () => settleConflict('load'),
      requestRecreate: () => {
        dialogState.update(current => current.kind === 'conflict'
          ? { ...current, confirmingRecreate: true }
          : current)
      },
      recreate: () => settleConflict('recreate'),
      retryScreenshot: input => runDialogRouteOperation(() => controller.retryScreenshot(input.waypointId)),
      setWaypointSelected: input => runDialogRouteOperation(() => controller.updateWaypoint(input.waypointId, { selected: input.selected })),
      async generate (input) {
        if (dialogState.get().kind !== 'generate') return
        if (!dialogRouteId || controller.getState().route?.id !== dialogRouteId) {
          await closeDialog()
          notify('项目或航次已切换，请重新打开生成窗口', 'warning')
          return
        }
        dialogState.update(current => current.kind === 'generate'
          ? { ...current, pending: true, error: null }
          : current)
        try {
          await controller.generate(input)
          notify(transport.isMock() ? '模拟航线生成成功，不会生成真实 KMZ' : '航线生成成功', transport.isMock() ? 'warning' : 'success')
          await closeDialog()
        } catch (error) {
          dialogState.update(current => current.kind === 'generate'
            ? { ...current, pending: false, error: errorMessage(error) }
            : current)
        } finally {
          syncPanel()
        }
      },
    },
  }))

  panelContribution = await ctx.extensions.contribute('wayline-teach-panel', {
    visible: false,
    interactive: true,
    width: 240,
    render: () => teachPanelView.get(ctx),
  })
  entryContribution = await ctx.extensions.contribute('wayline-teach-entry', {
    icon: TEACH_ENTRY_ICON,
    label: '示教航线',
    active: false,
    disabled: false,
    async onTrigger () {
      if (panelVisible) {
        await hidePanel()
        return
      }
      panelVisible = true
      await panelContribution?.update({ visible: true })
      await entryContribution?.update({ active: true })
      syncPanel()
    },
  })
  hotkeyHandle = await hotkeys.register({
    key: 'h',
    enabled: false,
    onTrigger: () => runOperation(() => controller.recordWaypoint()),
  })

  disposables.push(controller.subscribe(syncPanel))
  disposables.push(await ctx.events.on('cockpit.live.lifecycle', (event) => {
    if (event.payload.liveId !== 'DronePayload' || event.payload.phase !== 'stopped') return
    void exitForDronePayloadStop()
  }))
  disposables.push(await telemetry.onStateChanged((event) => {
    const previousKey = `${telemetryState.projectId}:${telemetryState.flightId}`
    telemetryState = event.state
    logAiState(event.state, event.source)
    syncPanel()
    if (`${event.state.projectId}:${event.state.flightId}` !== previousKey) {
      void closeDialog().then(() => runOperation(() => controller.restore()))
    }
  }))
  disposables.push(await cockpitContext.onStateChanged((next) => {
    const contextDiagnostic = {
      organizationId: next.organizationId,
      projectId: next.projectId,
      droneSn: next.droneSn,
      gatewaySn: next.gatewaySn,
      liveReady: next.liveReady,
    }
    const contextDiagnosticSignature = JSON.stringify(contextDiagnostic)
    if (contextDiagnosticSignature !== lastContextDiagnosticSignature) {
      lastContextDiagnosticSignature = contextDiagnosticSignature
      ctx.logger.info(`${DIAG_PREFIX} Cockpit Context 关键状态变化`, contextDiagnostic)
    }
    liveReady = next.liveReady
    syncPanel()
  }))
  await runOperation(() => controller.restore())

  return {
    async dispose () {
      conflictResolver?.('cancel')
      conflictResolver = undefined
      await closeDialog()
      for (const disposable of [...disposables].reverse()) await disposable.dispose()
      controller.dispose()
    },
  }
}
