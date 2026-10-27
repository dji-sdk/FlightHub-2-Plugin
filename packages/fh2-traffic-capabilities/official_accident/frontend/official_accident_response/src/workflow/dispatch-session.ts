// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { GeoPoint, PlatformWaylinePreviewDestination } from 'fh2-plugin-sdk'
import type { DispatchDevicesApi } from '../api/dispatch-devices-api'
import type { AccidentWorkflowApi, RouteSelectedPayload } from '../api/workflow-api'
import type { AlertFlowSnapshot } from '../services/alert-flow'
import type { DispatchCardState } from '../views/dispatch-card/contract'
import type { RoutePlanningApi } from './route-planner'
import type { AccidentAlertContext, DispatchDevice, DispatchRequest, DispatchRoute } from './types'

interface RoutePreviewClient {
  show(input: {
    readonly previewId: string;
    readonly routes: readonly DispatchRoute[];
    readonly selectedIndex: number;
    readonly startPosition: GeoPoint;
    readonly destination: PlatformWaylinePreviewDestination;
  }): Promise<void>;
  clear(previewId: string): Promise<void>;
}

export interface DispatchSessionDependencies {
  readonly devices: DispatchDevicesApi;
  readonly workflow: AccidentWorkflowApi;
  readonly routePlanning: RoutePlanningApi;
  readonly routePreview: RoutePreviewClient;
  readonly getState: () => DispatchCardState;
  readonly setState: (state: DispatchCardState) => void;
  readonly publishFlow: (snapshot: AlertFlowSnapshot) => void;
  readonly navigate: (url: string, options: { readonly target: 'self' | 'blank' }) => Promise<void>;
  readonly onNavigationError?: (error: unknown) => void;
  readonly enableMultiAngle: boolean;
}

export interface DispatchSession {
  open(request: DispatchRequest): Promise<void>;
  refreshDevices(): Promise<void>;
  refreshRoutes(): Promise<void>;
  selectDevice(dockSn: string): Promise<void>;
  selectRoute(index: number): Promise<void>;
  dispatch(): Promise<{ readonly accepted: boolean }>;
  close(): Promise<void>;
  dispose(): Promise<void>;
}

export function createDispatchSession (dependencies: DispatchSessionDependencies): DispatchSession {
  let alert: DispatchRequest | undefined
  let sessionSequence = 0
  let deviceSequence = 0
  let routeSequence = 0
  let disposed = false

  const previewId = (): string => `message:${alert?.popupId ?? 'inactive'}`

  function update (patch: Partial<DispatchCardState>): void {
    if (disposed) return
    dependencies.setState({ ...dependencies.getState(), ...patch })
  }

  function publish (status: AlertFlowSnapshot['status']): void {
    const state = dependencies.getState()
    dependencies.publishFlow({
      status,
      pluginEventId: alert?.pluginEventId ?? null,
      projectId: alert?.projectId ?? null,
      title: state.title,
      occurredAt: state.receivedAt || null,
    })
  }

  async function clearRoutes (): Promise<void> {
    routeSequence++
    update({ routes: [], selectedRouteIndex: -1, loadingRoutes: false })
    await dependencies.routePreview.clear(previewId())
  }

  async function loadDevices (session: number, preserveSelection = false): Promise<void> {
    if (!alert) return
    const request = ++deviceSequence
    update({ loadingDevices: true, error: null })
    try {
      const loaded = await dependencies.devices.list(alert.projectId, alert.alarmPosition)
      if (isStaleDeviceRequest(session, request)) return
      const devices = loaded
      const selectedDockSn = dependencies.getState().selectedDockSn
      const selectedStillExists = preserveSelection
        && devices.some(device => device.dockSn === selectedDockSn && !device.executingTask)
      update({
        devices,
        loadingDevices: false,
        selectedDockSn: selectedStillExists ? selectedDockSn : '',
      })
      // 设备默认不选，用户手动选择后才规划路线。
      if (preserveSelection && !selectedStillExists) await clearRoutes()
    } catch (error) {
      if (isStaleDeviceRequest(session, request)) return
      update({ loadingDevices: false, error: errorMessage(error, '设备列表加载失败') })
    }
  }

  function isStaleDeviceRequest (session: number, request: number): boolean {
    return disposed || session !== sessionSequence || request !== deviceSequence
  }

  async function requestRoutes (device: DispatchDevice): Promise<void> {
    if (!alert) return
    const request = ++routeSequence
    const session = sessionSequence
    update({ loadingRoutes: true, routes: [], selectedRouteIndex: -1, error: null })
    try {
      const routes = await dependencies.routePlanning.plan({
        workspaceId: alert.projectId,
        startPosition: device.startPosition,
        destinationPosition: alert.alarmPosition,
        height: alert.flightHeight,
        takeoffReferenceAltitude: device.takeoffReferenceAltitude,
        speed: 10,
        // 抵达事故点云台垂直向下拍摄。
        endGimbalPitch: -90,
      })
      if (isStale(session, request)) return
      if (routes.length === 0) throw new Error('未生成候选路线')
      update({ routes, selectedRouteIndex: 0, loadingRoutes: false })
      try {
        await dependencies.routePreview.show({
          previewId: previewId(),
          routes,
          selectedIndex: 0,
          startPosition: device.startPosition,
          destination: { position: alert.alarmPosition, kind: 'alert' },
        })
      } catch {
        // 预览是尽力而为：渲染失败不清空已规划路线，派遣仍可继续。
      }
    } catch (error) {
      if (isStale(session, request)) return
      update({ loadingRoutes: false, routes: [], selectedRouteIndex: -1, error: errorMessage(error, '路线规划失败') })
      await dependencies.routePreview.clear(previewId())
    }
  }

  function isStale (session: number, request: number): boolean {
    return disposed || session !== sessionSequence || request !== routeSequence
  }

  async function open (request: DispatchRequest): Promise<void> {
    const session = ++sessionSequence
    deviceSequence++
    routeSequence++
    await dependencies.routePreview.clear(previewId())
    alert = request
    dependencies.setState(createCardState(request, {
      title: alert.title,
      status: 'pending',
      projectId: alert.projectId,
      requiresRoute: true,
      enableMultiAngle: dependencies.enableMultiAngle,
      level: alert.level,
      address: alert.address,
      description: alert.description,
      waitTime: alert.waitTime,
    }))
    publish('pending')
    await loadDevices(session)
  }

  async function refreshDevices (): Promise<void> {
    if (!alert) throw new Error('缺少有效警情')
    await loadDevices(sessionSequence, true)
  }

  async function refreshRoutes (): Promise<void> {
    if (!alert) throw new Error('缺少有效警情')
    const state = dependencies.getState()
    const device = state.devices.find(item => item.dockSn === state.selectedDockSn)
    if (!device) throw new Error('请先选择派遣设备')
    if (device.executingTask) throw new Error('设备正在执行任务，无法规划路线')
    await requestRoutes(device)
  }

  async function selectDevice (dockSn: string): Promise<void> {
    const device = dependencies.getState().devices.find(item => item.dockSn === dockSn)
    if (!device) throw new Error(`设备不存在：${dockSn}`)
    if (device.executingTask) throw new Error('设备正在执行任务，无法选择')
    await clearRoutes()
    update({ selectedDockSn: dockSn, error: null })
    await requestRoutes(device)
  }

  async function selectRoute (index: number): Promise<void> {
    const state = dependencies.getState()
    const route = state.routes[index]
    const device = state.devices.find(item => item.dockSn === state.selectedDockSn)
    if (!route || !device || !alert) throw new Error(`路线索引无效：${index}`)
    update({ selectedRouteIndex: index })
    await dependencies.routePreview.show({
      previewId: previewId(),
      routes: state.routes,
      selectedIndex: index,
      startPosition: device.startPosition,
      destination: { position: alert.alarmPosition, kind: 'alert' },
    })
  }

  async function ensureWaylineUuid (
    context: AccidentAlertContext,
    route: DispatchRoute,
  ): Promise<string> {
    if (route.waylineUuid !== undefined) return route.waylineUuid
    const name = buildWaylineName(context.title)
    try {
      return await dependencies.routePlanning.register(context.projectId, { wpmzKey: route.wpmzKey, name })
    } catch (error) {
      if (!isNameDuplicateError(error)) throw error
      return dependencies.routePlanning.register(context.projectId, { wpmzKey: route.wpmzKey, name: `${name}-2` })
    }
  }

  function isStaleDispatch (session: number): boolean {
    return disposed || session !== sessionSequence
  }

  async function dispatch (): Promise<{ readonly accepted: boolean }> {
    if (!alert) throw new Error('缺少有效警情')
    const session = sessionSequence
    const context = alert
    const state = dependencies.getState()
    let device = state.devices.find(item => item.dockSn === state.selectedDockSn)
    const route = state.selectedRouteIndex >= 0 ? state.routes[state.selectedRouteIndex] : undefined
    if (!device || !route) {
      update({ error: '请先选择派遣设备与路线' })
      throw new Error('请先选择派遣设备与路线')
    }

    try {
      const devices = await dependencies.devices.list(context.projectId, context.alarmPosition)
      if (isStaleDispatch(session)) return { accepted: false }
      const currentDevice = devices.find(item => item.dockSn === state.selectedDockSn)
      update({ devices })
      if (!currentDevice || currentDevice.executingTask) {
        const message = currentDevice ? '设备正在执行任务，请重新选择' : '所选设备已不可用，请重新选择'
        update({ selectedDockSn: '', error: message })
        await clearRoutes()
        throw new Error(message)
      }
      device = currentDevice
    } catch (error) {
      if (!isStaleDispatch(session) && dependencies.getState().selectedDockSn !== '') {
        update({ error: errorMessage(error, '设备状态校验失败，请重试') })
      }
      throw error
    }

    update({ status: 'dispatching', dispatching: true, error: null })
    publish('dispatching')
    try {
      const waylineUuid = await ensureWaylineUuid(context, route)
      if (isStaleDispatch(session)) return { accepted: false }
      // 注册成功后回写选中路线，信号失败重试时不再重复入库。
      if (route.waylineUuid === undefined) {
        update({
          routes: dependencies.getState().routes.map(item =>
            item.wpmzKey === route.wpmzKey ? { ...item, waylineUuid } : item),
        })
      }
      const payload: RouteSelectedPayload = {
        projectUuid: context.projectId,
        dockSn: device.dockSn,
        waylineUuid,
      }

      await dependencies.workflow.selectRoute(context.pluginEventId, payload)
      if (isStaleDispatch(session)) return { accepted: false }
      update({ status: 'dispatched', dispatching: false })
      publish('dispatched')
      try {
        await dependencies.navigate(buildCockpitUrl({
          organizationId: context.organizationId,
          projectId: context.projectId,
          droneSn: device.droneSn,
          gatewaySn: device.gatewaySn,
          pluginEventId: context.pluginEventId,
        }), { target: 'blank' })
      } catch (error) {
        dependencies.onNavigationError?.(error)
      }
      if (isStaleDispatch(session)) return { accepted: false }
      return { accepted: true }
    } catch (error) {
      if (!isStaleDispatch(session)) {
        update({ status: 'pending', dispatching: false, error: errorMessage(error, '派遣失败') })
        publish('failed')
      }
      throw error
    }
  }

  async function close (): Promise<void> {
    sessionSequence++
    deviceSequence++
    await clearRoutes()
    update({ status: 'closed', selectedDockSn: '' })
    publish('closed')
    alert = undefined
  }

  async function dispose (): Promise<void> {
    if (disposed) return
    sessionSequence++
    deviceSequence++
    routeSequence++
    await dependencies.routePreview.clear(previewId())
    disposed = true
  }

  return { open, refreshDevices, refreshRoutes, selectDevice, selectRoute, dispatch, close, dispose }
}

function createCardState (
  request: DispatchRequest,
  patch: Partial<DispatchCardState>,
): DispatchCardState {
  return {
    ...emptyCardState(false),
    popupId: request.popupId,
    pluginEventId: request.pluginEventId,
    title: request.title,
    receivedAt: request.receivedAt,
    enableMultiAngle: false,
    status: 'idle',
    projectId: request.projectId,
    organizationId: request.organizationId,
    alarmPosition: request.alarmPosition,
    level: request.level,
    address: request.address,
    description: request.description,
    waitTime: request.waitTime,
    ...patch,
  }
}

function emptyCardState (enableMultiAngle: boolean): DispatchCardState {
  return {
    popupId: '',
    pluginEventId: '',
    title: '事故快处',
    receivedAt: 0,
    enableMultiAngle,
    status: 'idle',
    projectId: '',
    organizationId: '',
    alarmPosition: null,
    requiresRoute: false,
    devices: [],
    selectedDockSn: '',
    routes: [],
    selectedRouteIndex: -1,
    loadingDevices: false,
    loadingRoutes: false,
    dispatching: false,
    error: null,
    level: 1,
    address: '',
    description: '',
    waitTime: 0,
  }
}

function errorMessage (error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function buildWaylineName (title: string): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const timestamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `事故快处-${title}-${timestamp}`
}

function isNameDuplicateError (error: unknown): boolean {
  return error instanceof Error && error.message.includes('已存在')
}

export function buildCockpitUrl (input: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly droneSn: string;
  readonly gatewaySn: string;
  readonly pluginEventId: string;
}): string {
  const query = new URLSearchParams({
    droneSn: input.droneSn,
    gatewaySn: input.gatewaySn,
    pluginEventId: input.pluginEventId,
  })
  return `/organization/${encodeURIComponent(input.organizationId)}/project/${encodeURIComponent(input.projectId)}?${query.toString()}#/cockpit`
}
