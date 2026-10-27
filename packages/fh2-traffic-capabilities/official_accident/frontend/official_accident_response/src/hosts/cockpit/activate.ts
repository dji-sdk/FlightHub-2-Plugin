// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import type { CockpitContextState, PlatformLocationState } from 'fh2-plugin-sdk'
import { createRoutePlanningHttpApi } from '../../api/route-planning-api'
import type { AccidentCockpitContext } from '../../types'
import { createCockpitEventMonitor, emptyEventState } from '../../workflow/cockpit-monitor'
import type { CockpitEventMonitor } from '../../workflow/cockpit-monitor'
import { createRoutePlanningApi } from '../../workflow/route-planner'
import { createWaylinePreview } from '../../workflow/wayline-preview'
import { returnRoutePanelView } from '../../views/return-route-panel/contract'
import type { ReturnRoutePanelState } from '../../views/return-route-panel/contract'
import { createApproachTarget } from './approach-target'
import { createReturnRouteController, returnRouteAvailable } from './return-route-controller'
import { droneInSky } from './telemetry'

const EMPTY_EVENT = emptyEventState()

export async function activate (ctx: AccidentCockpitContext) {
  const cockpitContext = await ctx.capabilities.get('cockpit:context')
  const location = await ctx.capabilities.get('platform:location')
  const telemetry = await ctx.capabilities.get('cockpit:telemetry')
  const flight = await ctx.capabilities.get('cockpit:flight-control')
  const gimbal = await ctx.capabilities.get('cockpit:gimbal')
  if (!cockpitContext || !location || !telemetry || !flight || !gimbal) {
    ctx.logger.warn('Cockpit 核心能力不完整，事故驾驶舱功能不启用')
    return
  }
  const telemetryClient = telemetry
  const flightControl = flight
  const gimbalControl = gimbal
  const [geometry, notification, flightTask, wpmz, waylinePreviewCapability] = await Promise.all([
    ctx.capabilities.get('cockpit:scene-geometry'),
    ctx.capabilities.get('platform:notification'),
    ctx.capabilities.get('cockpit:flight-task'),
    ctx.capabilities.get('platform:wpmz'),
    ctx.capabilities.get('platform:wayline-preview'),
  ])
  const waylinePreview = createWaylinePreview(waylinePreviewCapability, ctx.logger)
  let route = await cockpitContext.getState()
  let telemetryState = await telemetryClient.getState()
  let pluginEventId = readPluginEventId(await location.getState())
  let event = EMPTY_EVENT
  let eventMonitor: CockpitEventMonitor | undefined
  let uiSequence = 0
  let disposed = false

  const returnState = createViewState<ReturnRoutePanelState>({ phase: 'idle', routes: [], selectedIndex: -1, error: null })
  let returnPanelVisible = false
  const returnPanel = await ctx.extensions.contribute('accident-return-route-panel', {
    visible: false,
    interactive: true,
    width: 290,
    height: 360,
    placement: 'bottom-right',
    offsetX: -4,
    offsetY: -16,
    render: () => returnRoutePanelView.get(ctx),
  })

  let returnController: ReturnType<typeof createReturnRouteController> | undefined

  function createReturnController (): void {
    if (!flightTask || returnController || disposed) return
    returnController = createReturnRouteController({
      routePlanning: createRoutePlanningApi(
        createRoutePlanningHttpApi(ctx.apiCall),
        wpmz ?? { parseCoordinates: async () => [] },
        ctx.logger,
      ),
      preview: {
        show: input => waylinePreview.show(input),
        clear: input => waylinePreview.clear(input.previewId),
      },
      emergencyStop: () => flightControl.emergencyStop(),
      getInFlightTask: async () => (await flightTask.getState()).inFlightWayline,
      startWayline: input => flightTask.startInFlightWayline(input),
      cancelWayline: input => flightTask.cancelInFlightWayline(input),
      resetGimbal: () => gimbalControl.reset('all'),
      getContext: () => ({
        projectId: route.projectId,
        pluginEventId,
        rawPayload: event.rawPayload,
        telemetry: telemetryState,
      }),
      getState: returnState.get,
      setState: next => returnState.update(() => next),
      setPanelVisible: async (visible) => {
        returnPanelVisible = visible
        await returnPanel.update({ visible })
      },
      onChanged: () => void refreshUi(),
    })
  }

  createReturnController()

  await returnRoutePanelView.handle(ctx, {
    state: returnState,
    methods: {
      close: () => returnController?.close(),
      refresh: () => returnController?.refresh(),
      selectRoute: input => returnController?.selectRoute(input.index),
      execute: () => returnController?.execute(),
    },
  })

  const returnAction = await ctx.extensions.contribute('accident-return-route-action', {
    visible: false,
    icon: 'action-return-home',
    label: '沿路网返航',
    active: false,
    disabled: false,
    onTrigger: async () => {
      if (!returnController) return
      if (returnController.running) await returnController.cancel()
      else await returnController.open()
      await refreshUi()
    },
  })

  const approach = createApproachTarget({
    telemetry: telemetryClient,
    ...(geometry ? { geometry } : {}),
    gimbal: gimbalControl,
    flight: flightControl,
    timers: ctx.timers,
    onRunningChanged: () => void refreshUi(),
    onProjectionSample: (sample) => {
      // eslint-disable-next-line no-console -- 真机联调证据由 Engine console 旁路统一采集。
      console.info('[accident-response][cockpit-tools]', sample)
    },
    onProjectionError: (error) => {
      console.warn('[accident-response][cockpit-tools] 投影不可用', error)
    },
  })

  const menu = await ctx.extensions.contribute('accident-approach-target', {
    visible: false,
    icon: 'action-position-warning',
    label: '抵近目标',
    disabled: true,
    async onTrigger ({ videoPoint, stream }) {
      try {
        await approach.execute({ videoPoint, stream, targetAgl: 20 })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (notification) {
          await notification.show({ key: 'accident-approach-failed', message, intent: 'error' })
        } else {
          ctx.logger.error('抵近目标失败', { message })
        }
      } finally {
        await refreshUi()
      }
    },
  })

  let lastMenuGateLog = ''
  let lastMenuGateLoggedAt = 0

  function menuGateSnapshot () {
    return {
      organizationId: route.organizationId,
      projectId: route.projectId,
      droneSn: route.droneSn,
      gatewaySn: route.gatewaySn,
      pluginEventId,
      eventStatus: event.status ?? '',
      eventError: event.error ?? '',
      allowApproach: event.allowApproach,
      droneInSky: droneInSky(telemetryState),
      approachRunning: approach.running,
    }
  }

  function logMenuGate (canApproach: boolean): void {
    if (canApproach) {
      if (lastMenuGateLog !== 'visible') {
        lastMenuGateLog = 'visible'
        ctx.logger.info('[accident-response] 抵近目标菜单可见', { pluginEventId })
      }
      return
    }
    const summary = JSON.stringify(menuGateSnapshot())
    const now = Date.now()
    if (summary !== lastMenuGateLog || now - lastMenuGateLoggedAt > 10_000) {
      lastMenuGateLog = summary
      lastMenuGateLoggedAt = now
      ctx.logger.info('[accident-response] 抵近目标菜单隐藏', menuGateSnapshot())
    }
  }

  async function refreshUi (): Promise<void> {
    const refresh = ++uiSequence
    telemetryState = await telemetryClient.getState()
    if (refresh !== uiSequence) return
    const canApproach = canApproachEvent({
      context: route,
      pluginEventId,
      allowApproach: event.allowApproach,
      droneInSky: droneInSky(telemetryState),
      approachRunning: approach.running,
    })
    logMenuGate(canApproach)
    await Promise.all([
      menu.update({ visible: event.visible && canApproach, disabled: !canApproach }),
      returnAction.update({
        visible: Boolean(returnController) && (returnController?.running === true || returnRouteAvailable({
          projectId: route.projectId,
          pluginEventId,
          rawPayload: event.rawPayload,
          telemetry: telemetryState,
        })),
        label: returnController?.running ? '取消沿路网返航' : '沿路网返航',
        active: returnController?.running ?? false,
        disabled: returnController?.running !== true
          && (returnState.get().phase === 'loading' || returnState.get().phase === 'executing'),
      }),
    ])
    if (returnPanelVisible && !returnController?.running && !returnRouteAvailable({
      projectId: route.projectId,
      pluginEventId,
      rawPayload: event.rawPayload,
      telemetry: telemetryState,
    })) {
      await returnController?.close()
    }
  }

  function startEventMonitor (context: CockpitContextState): void {
    eventMonitor?.dispose()
    eventMonitor = undefined
    event = emptyEventState(pluginEventId)
    if (!context.projectId || !pluginEventId) {
      void refreshUi()
      return
    }
    eventMonitor = createCockpitEventMonitor({
      pluginEventId,
      apiCall: (endpoint, options) => ctx.apiCall(endpoint, options),
      timers: ctx.timers,
      onState: (next) => {
        event = next
        void refreshUi()
      },
    })
    eventMonitor.start()
  }

  startEventMonitor(route)
  await cockpitContext.onStateChanged((next) => {
    const projectChanged = next.projectId !== route.projectId
    route = next
    if (projectChanged) startEventMonitor(next)
    else void refreshUi()
  })
  await location.onStateChanged((next) => {
    const nextPluginEventId = readPluginEventId(next)
    if (nextPluginEventId === pluginEventId) return
    pluginEventId = nextPluginEventId
    startEventMonitor(route)
  })
  await telemetryClient.onStateChanged((next) => {
    telemetryState = next.state
    void refreshUi()
  })
  if (flightTask) {
    await flightTask.onStateChanged((next) => {
      returnController?.handleTaskState(next)
      void refreshUi()
    })
  }
  return {
    async dispose () {
      disposed = true
      eventMonitor?.dispose()
      approach.dispose()
      await returnController?.dispose()
      await waylinePreview.dispose()
    },
  }
}

export function readPluginEventId (location: Pick<PlatformLocationState, 'search'>): string {
  return new URLSearchParams(location.search).get('pluginEventId')?.trim() ?? ''
}

export function canApproachEvent (input: {
  readonly context: CockpitContextState;
  readonly pluginEventId: string;
  readonly allowApproach: boolean;
  readonly droneInSky: boolean;
  readonly approachRunning: boolean;
}): boolean {
  const { context } = input
  return Boolean(
    context.organizationId && context.projectId && context.droneSn && context.gatewaySn
    && input.pluginEventId && input.allowApproach && input.droneInSky
    && !input.approachRunning,
  )
}
