// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type {
  FlightTaskState,
  GeoPoint,
  InFlightWaylineTaskSnapshot,
  JsonValue,
  PlatformWaylinePreviewDestination,
  TelemetryState,
} from 'fh2-plugin-sdk'
import type { RoutePlanningApi } from '../../workflow/route-planner'
import type { ReturnRoutePanelState } from '../../views/return-route-panel/contract'
import { dockPosition, droneInSky, dronePosition } from './telemetry'

const PREVIEW_ID = 'cockpit:return-route'

export interface ReturnRouteContext {
  readonly projectId: string | null;
  readonly pluginEventId: string;
  readonly rawPayload: Readonly<Record<string, JsonValue>>;
  readonly telemetry: TelemetryState;
}

interface ReturnRouteControllerDependencies {
  readonly routePlanning: RoutePlanningApi;
  readonly preview: {
    show(input: {
      readonly previewId: string;
      readonly routes: ReturnRoutePanelState['routes'];
      readonly selectedIndex: number;
      readonly startPosition: GeoPoint;
      readonly destination: PlatformWaylinePreviewDestination;
    }): Promise<unknown>;
    clear(input: { readonly previewId: string }): Promise<unknown>;
  };
  readonly emergencyStop: () => Promise<void>;
  /** 当前设备的即时航线任务快照；用于返航前显式清理遗留的去程任务。 */
  readonly getInFlightTask: () => Promise<InFlightWaylineTaskSnapshot | null>;
  readonly startWayline: (input: {
    readonly waylineUuid: string;
    readonly rthAltitude: number;
    readonly taskName: string;
    readonly waylineDuration: number;
    readonly waylineLength: number;
    readonly finishAction: 'goHome';
  }) => Promise<{ readonly taskId: string }>;
  readonly cancelWayline: (input: { readonly taskId: string; readonly afterCancel: 'hover' }) => Promise<void>;
  readonly resetGimbal: () => Promise<void>;
  readonly getContext: () => ReturnRouteContext;
  readonly getState: () => ReturnRoutePanelState;
  readonly setState: (state: ReturnRoutePanelState) => void;
  readonly setPanelVisible: (visible: boolean) => Promise<void>;
  readonly onChanged: () => void;
}

export function returnRouteAvailable (context: ReturnRouteContext): boolean {
  return Boolean(
    context.projectId && context.pluginEventId
    && droneInSky(context.telemetry) && dronePosition(context.telemetry) && dockPosition(context.telemetry),
  )
}

export function returnRouteHeight (rawPayload: Readonly<Record<string, JsonValue>>): number {
  const value = rawPayload.go_back_alt
  return typeof value === 'number' && Number.isFinite(value) ? value : 120
}

export function createReturnRouteController (dependencies: ReturnRouteControllerDependencies) {
  let sequence = 0
  let taskId: string | null = null
  let plannedFor: {
    readonly projectId: string;
    readonly pluginEventId: string;
    readonly droneSn: string | null;
    readonly gatewaySn: string | null;
    readonly routes: ReturnRoutePanelState['routes'];
  } | null = null
  let disposed = false
  let opening = false
  let executing = false
  let cancelling = false
  let awaitingTaskRegistration = false
  /** 启动后是否已在即时航线通道观察到本任务；用于区分「未上报」与「已消失」。 */
  let taskObserved = false
  const earlyTerminalTaskStates = new Map<string, InFlightWaylineTaskSnapshot>()

  const update = (patch: Partial<ReturnRoutePanelState>): void => {
    if (!disposed) dependencies.setState({ ...dependencies.getState(), ...patch })
  }

  async function clearPreview (): Promise<void> {
    await dependencies.preview.clear({ previewId: PREVIEW_ID })
  }

  async function loadRoutes (): Promise<void> {
    const request = ++sequence
    const context = dependencies.getContext()
    const startPosition = dronePosition(context.telemetry)
    const destinationPosition = dockPosition(context.telemetry)
    if (!returnRouteAvailable(context) || !context.projectId || !startPosition || !destinationPosition) {
      update({ phase: 'error', routes: [], selectedIndex: -1, error: '当前状态无法沿路网返航' })
      return
    }
    update({ phase: 'loading', error: null })
    plannedFor = null
    await clearPreview()
    try {
      const height = returnRouteHeight(context.rawPayload)
      const routes = await dependencies.routePlanning.plan({
        workspaceId: context.projectId,
        startPosition,
        destinationPosition,
        height,
        takeoffReferenceAltitude: destinationPosition.height,
        speed: 14,
        interval: 100,
        finishAction: 'goHome',
      })
      if (disposed || request !== sequence) return
      if (routes.length === 0) throw new Error('未规划到可用返航路线')
      plannedFor = {
        projectId: context.projectId,
        pluginEventId: context.pluginEventId,
        droneSn: context.telemetry.device.roster?.droneSn ?? null,
        gatewaySn: context.telemetry.device.roster?.gatewaySn ?? null,
        routes,
      }
      update({ phase: 'ready', routes, selectedIndex: 0, error: null })
      await dependencies.preview.show({
        previewId: PREVIEW_ID,
        routes,
        selectedIndex: 0,
        startPosition,
        destination: { position: destinationPosition, kind: 'home' },
      })
    } catch (error) {
      if (disposed || request !== sequence) return
      update({ phase: 'error', routes: [], selectedIndex: -1, error: message(error, '返航路线规划失败') })
      await clearPreview()
    }
  }

  async function open (): Promise<void> {
    if (disposed || opening || dependencies.getState().phase === 'loading') return
    if (!returnRouteAvailable(dependencies.getContext())) {
      update({ phase: 'error', routes: [], selectedIndex: -1, error: '当前状态无法沿路网返航' })
      return
    }
    opening = true
    const request = ++sequence
    try {
      await dependencies.emergencyStop()
      if (disposed || request !== sequence) return
      update({ phase: 'loading', routes: [], selectedIndex: -1, error: null })
      await dependencies.setPanelVisible(true)
      await loadRoutes()
    } catch (error) {
      if (disposed || request !== sequence) return
      await dependencies.setPanelVisible(true)
      update({ phase: 'error', routes: [], selectedIndex: -1, error: message(error, '紧急停止失败') })
      throw error
    } finally {
      opening = false
    }
  }

  async function selectRoute (index: number): Promise<void> {
    const state = dependencies.getState()
    const context = dependencies.getContext()
    const startPosition = dronePosition(context.telemetry)
    const destinationPosition = dockPosition(context.telemetry)
    if (!state.routes[index] || !startPosition || !destinationPosition) throw new Error(`路线索引无效：${index}`)
    update({ selectedIndex: index, error: null })
    await dependencies.preview.show({
      previewId: PREVIEW_ID,
      routes: state.routes,
      selectedIndex: index,
      startPosition,
      destination: { position: destinationPosition, kind: 'home' },
    })
  }

  async function close (): Promise<void> {
    sequence++
    plannedFor = null
    await clearPreview()
    await dependencies.setPanelVisible(false)
    if (!taskId) update({ phase: 'idle', routes: [], selectedIndex: -1, error: null })
  }

  async function execute (): Promise<void> {
    if (executing) return
    executing = true
    const request = ++sequence
    const state = dependencies.getState()
    const route = state.routes[state.selectedIndex]
    let context = dependencies.getContext()
    if (!route) {
      executing = false
      throw new Error('请先选择返航路线')
    }
    if (!returnRouteAvailable(context) || !context.projectId) {
      executing = false
      throw new Error('当前状态无法沿路网返航')
    }
    if (!plannedFor || !plannedFor.routes.includes(route)
      || plannedFor.projectId !== context.projectId
      || plannedFor.pluginEventId !== context.pluginEventId
      || plannedFor.droneSn !== context.telemetry.device.roster?.droneSn
      || plannedFor.gatewaySn !== context.telemetry.device.roster?.gatewaySn) {
      executing = false
      throw new Error('返航路线已失效，请重新规划')
    }
    update({ phase: 'executing', error: null })
    try {
      await dependencies.emergencyStop()
      if (disposed || request !== sequence) return
      context = dependencies.getContext()
      if (!returnRouteAvailable(context) || !context.projectId) throw new Error('当前状态无法沿路网返航')
      if (!plannedFor || !plannedFor.routes.includes(route)
        || plannedFor.projectId !== context.projectId
        || plannedFor.pluginEventId !== context.pluginEventId
        || plannedFor.droneSn !== context.telemetry.device.roster?.droneSn
        || plannedFor.gatewaySn !== context.telemetry.device.roster?.gatewaySn) {
        throw new Error('返航路线已失效，请重新规划')
      }
      // 原生返航链路 Step 0：急停只会暂停旧即时航线任务（多为去程派遣任务），
      // 必须显式取消后才能下发返航任务，否则后端以「设备当前有任务执行中」拒绝。
      const existing = await dependencies.getInFlightTask()
      if (disposed || request !== sequence) return
      if (existing?.taskId && !isTerminalTaskStatus(existing.status)) {
        await dependencies.cancelWayline({ taskId: existing.taskId, afterCancel: 'hover' })
        if (disposed || request !== sequence) return
      }
      const waylineUuid = route.waylineUuid ?? await dependencies.routePlanning.register(context.projectId, {
        wpmzKey: route.wpmzKey,
        name: `事故快处-沿路网返航-${Date.now()}`,
      })
      if (disposed || request !== sequence) return
      context = dependencies.getContext()
      if (!returnRouteAvailable(context) || !context.projectId || !plannedFor || !plannedFor.routes.includes(route)
        || plannedFor.projectId !== context.projectId
        || plannedFor.pluginEventId !== context.pluginEventId
        || plannedFor.droneSn !== context.telemetry.device.roster?.droneSn
        || plannedFor.gatewaySn !== context.telemetry.device.roster?.gatewaySn) {
        throw new Error('返航路线已失效，请重新规划')
      }
      earlyTerminalTaskStates.clear()
      awaitingTaskRegistration = true
      taskObserved = false
      const result = await dependencies.startWayline({
        waylineUuid,
        rthAltitude: returnRouteHeight(context.rawPayload),
        taskName: '事故快处-沿路网返航',
        waylineDuration: route.estimatedDuration,
        waylineLength: route.totalDistance,
        finishAction: 'goHome',
      })
      awaitingTaskRegistration = false
      taskId = result.taskId
      const earlyTerminalState = earlyTerminalTaskStates.get(taskId)
      earlyTerminalTaskStates.clear()
      if (earlyTerminalState) consumeInFlightState(earlyTerminalState)
      dependencies.onChanged()
      if (disposed || request !== sequence) return
      sequence++
      await Promise.allSettled([
        clearPreview(),
        dependencies.setPanelVisible(false),
        dependencies.resetGimbal(),
      ])
      update({ phase: 'idle', routes: [], selectedIndex: -1, error: null })
    } catch (error) {
      awaitingTaskRegistration = false
      earlyTerminalTaskStates.clear()
      if (disposed || request !== sequence) return
      update({ phase: 'error', error: message(error, '返航任务启动失败') })
      throw error
    } finally {
      executing = false
    }
  }

  async function cancel (): Promise<void> {
    if (cancelling) return
    const current = taskId
    if (!current) return
    cancelling = true
    try {
      await dependencies.cancelWayline({ taskId: current, afterCancel: 'hover' })
      if (taskId === current) {
        taskId = null
        taskObserved = false
      }
      update({ phase: 'idle', routes: [], selectedIndex: -1, error: null })
      dependencies.onChanged()
    } catch (error) {
      throw new Error(`取消返航失败：${message(error, '未知错误')}`)
    } finally {
      cancelling = false
    }
  }

  function handleTaskState (state: FlightTaskState): void {
    // 只消费即时航线通道；普通 wayline 任务与返航任务的生死无关。
    const inFlight = state.inFlightWayline
    if (awaitingTaskRegistration && !taskId && inFlight?.taskId && isTerminalTaskStatus(inFlight.status)) {
      earlyTerminalTaskStates.set(inFlight.taskId, inFlight)
    }
    if (!consumeInFlightState(inFlight)) return
    dependencies.onChanged()
  }

  /**
   * 即时航线终态/消失判定（启动请求成功即视为任务存在，等待真实证据再结束）：
   * - 通道内是本任务且进入终态 → 结束运行态；
   * - 已观察到本任务后通道清空或出现其他任务 → 本任务消失/被替换，结束运行态；
   * - 尚未观察到本任务 → 属启动响应到 WS 上报之间的正常窗口，不因无关状态误清。
   */
  function consumeInFlightState (inFlight: InFlightWaylineTaskSnapshot | null): boolean {
    if (!taskId) return false
    if (inFlight === null || inFlight.taskId !== taskId) {
      return taskObserved ? finishTask() : false
    }
    taskObserved = true
    if (!isTerminalTaskStatus(inFlight.status)) return false
    return finishTask()
  }

  function finishTask (): boolean {
    taskId = null
    taskObserved = false
    update({ phase: 'idle', routes: [], selectedIndex: -1, error: null })
    return true
  }

  async function dispose (): Promise<void> {
    if (disposed) return
    disposed = true
    sequence++
    await clearPreview()
  }

  return { open, refresh: loadRoutes, selectRoute, close, execute, cancel, handleTaskState, dispose, get running () {
    return taskId !== null
  } }
}

function message (error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function isTerminalTaskStatus (status: InFlightWaylineTaskSnapshot['status']): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed'
}
