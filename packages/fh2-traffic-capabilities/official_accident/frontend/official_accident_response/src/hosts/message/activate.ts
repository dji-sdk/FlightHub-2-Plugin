// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import { createDispatchDevicesApi } from '../../api/dispatch-devices-api'
import { createRoutePlanningHttpApi } from '../../api/route-planning-api'
import { createAccidentWorkflowApi } from '../../api/workflow-api'
import type { AlertFlowSnapshot } from '../../services/alert-flow'
import { alertFlowService } from '../../services/alert-flow'
import { buildCockpitUrl, createDispatchSession } from '../../workflow/dispatch-session'
import { createRoutePlanningApi } from '../../workflow/route-planner'
import { createWaylinePreview } from '../../workflow/wayline-preview'
import type { DispatchRequest } from '../../workflow/types'
import { dispatchCardView } from '../../views/dispatch-card/contract'
import type { DispatchCardState } from '../../views/dispatch-card/contract'
import type { AccidentMessageContext } from '../../types'

const INITIAL_FLOW_STATE: AlertFlowSnapshot = {
  status: 'idle',
  pluginEventId: null,
  projectId: null,
  title: '事故快处',
  occurredAt: null,
}

export async function activate (ctx: AccidentMessageContext) {
  const { capabilities, config, extensions, logger, services } = ctx
  const [navigation, notification] = await Promise.all([
    capabilities.get('platform:navigation'),
    capabilities.get('platform:notification'),
  ])
  const wpmz = await capabilities.get('platform:wpmz')
  const devicesCapability = await capabilities.get('platform:devices')
  const waylinePreview = createWaylinePreview(
    await capabilities.get('platform:wayline-preview'),
    logger,
  )
  if (!wpmz) logger.warn('platform:wpmz 不可用，路线预览将只显示起终点')
  if (!devicesCapability) logger.warn('platform:devices 不可用，派遣设备列表将无法加载')
  const state = createViewState<DispatchCardState>(emptyCardState(config.enableMultiAngle))
  let flowSnapshot = INITIAL_FLOW_STATE
  const flowListeners = new Set<(snapshot: AlertFlowSnapshot) => void>()

  function publishFlow (snapshot: AlertFlowSnapshot): void {
    flowSnapshot = snapshot
    for (const listener of flowListeners) listener(snapshot)
  }

  const flow = createDispatchSession({
    devices: createDispatchDevicesApi(devicesCapability),
    workflow: createAccidentWorkflowApi(ctx.apiCall, config.flowName),
    routePlanning: createRoutePlanningApi(
      createRoutePlanningHttpApi(ctx.apiCall),
      wpmz ?? { parseCoordinates: async () => [] },
      logger,
    ),
    routePreview: waylinePreview,
    getState: state.get,
    setState: nextState => state.update(() => nextState),
    publishFlow,
    navigate: (url, options) => navigation?.open(url, options) ?? Promise.resolve(),
    onNavigationError: error => logger.warn('派遣成功，但驾驶舱页面打开失败', {
      message: error instanceof Error ? error.message : String(error),
    }),
    enableMultiAngle: config.enableMultiAngle,
  })

  const popupContribution = await extensions.contribute('accident-alert-popup', {
    visible: false,
    render: () => dispatchCardView.get(ctx),
  })

  async function hidePopup (): Promise<void> {
    await popupContribution.update({ visible: false })
  }

  async function presentPopup (request: DispatchRequest): Promise<void> {
    await hidePopup()
    await flow.open(request)
    await popupContribution.update({ visible: true })
  }

  await dispatchCardView.handle(ctx, {
    state,
    methods: {
      close: async () => {
        await flow.close()
        await hidePopup()
      },
      refreshDevices: async () => {
        await flow.refreshDevices()
      },
      refreshRoutes: async () => {
        await flow.refreshRoutes()
      },
      selectDevice: input => flow.selectDevice(input.dockSn),
      selectRoute: input => flow.selectRoute(input.index),
      dispatch: async () => {
        const popupId = state.get().popupId
        const result = await flow.dispatch()
        // 会话已被新警情替换时派遣中止，不通知、不关闭新卡片、不回执。
        if (!result.accepted || state.get().popupId !== popupId) return { accepted: false }
        try {
          await notification?.show({
            key: `accident-dispatch-success-${popupId}`,
            message: '派遣成功',
            intent: 'success',
          })
        } catch (error) {
          logger.warn('派遣成功通知展示失败', { popupId, error: String(error) })
        }
        if (state.get().popupId !== popupId) return { accepted: false }
        try {
          await flow.close()
        } finally {
          await hidePopup()
        }
        return result
      },
      cancelDispatch: async () => {
        await flow.close()
        await hidePopup()
      },
      viewDetail: async () => {
        const current = state.get()
        if (!current.projectId) return
        const device = current.devices.find(item => item.dockSn === current.selectedDockSn)
        if (!device) return
        if (!current.organizationId) return
        await navigation?.open(
          buildCockpitUrl({
            organizationId: current.organizationId,
            projectId: current.projectId,
            droneSn: device.droneSn,
            gatewaySn: device.gatewaySn,
            pluginEventId: current.pluginEventId,
          }),
          { target: 'blank' },
        )
      },
    },
  })

  await services.provide(alertFlowService, {
    getState: () => flowSnapshot,
    requestDispatch: async (input) => {
      await presentPopup(input)
      return { accepted: true }
    },
    stateChanged: (emit) => {
      flowListeners.add(emit)
      emit(flowSnapshot)
      return { dispose: () => {
        flowListeners.delete(emit)
      } }
    },
  })

  return {
    dispose: async () => {
      await hidePopup()
      await flow.dispose()
      await waylinePreview.dispose()
      flowListeners.clear()
    },
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
