// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState, isPluginError } from 'fh2-plugin-sdk'
import type { ViewPresentation } from 'fh2-plugin-sdk'
import { createAccidentEventsApi } from '../../api/accident-events-api'
import { createFlightActionsApi } from '../../api/flight-actions-api'
import { createAccidentWorkflowApi } from '../../api/workflow-api'
import { alertFlowService } from '../../services/alert-flow'
import { ACCIDENT_LIST_POLL_INTERVAL_MS } from '../../workflow/incident-message'
import { accidentListView, allEventsDialogView } from '../../views/accident-list/contract'
import type { AccidentProjectContext } from '../../types'
import { createAlertMapFocusController } from './alert-map-focus'
import { createCockpitPollGate } from './poll-gate'
import {
  ACCIDENT_ALERT_WS_BIZ_CODE,
  ACCIDENT_ALERT_WS_SUB_BIZ_CODE,
  createAccidentListController,
} from './list-controller'

export async function activate (ctx: AccidentProjectContext) {
  const { capabilities, extensions, logger, services, timers } = ctx
  const projectContext = await capabilities.get('project:context')
  if (!projectContext) {
    logger.warn('Project Host 未提供 project:context，事故列表不启用')
    return
  }
  const [platformMap, notification, dialog, navigation, clipboard, location] = await Promise.all([
    capabilities.get('platform:map'),
    capabilities.get('platform:notification'),
    capabilities.get('platform:dialog'),
    capabilities.get('platform:navigation'),
    capabilities.get('platform:clipboard'),
    capabilities.get('platform:location'),
  ])
  if (!navigation) logger.warn('Project Host 未提供 platform:navigation，媒体库与飞行记录跳转将不可用')
  if (platformMap && !clipboard) logger.warn('Project Host 未提供 platform:clipboard，地图右键复制经纬度不可用')
  const projectState = await projectContext.getState()
  const { projectId, organizationId } = projectState
  if (!projectId || !organizationId) throw new Error('当前 Project Host 导航上下文不完整')
  logger.debug('事故列表 Project 上下文就绪', { projectId, organizationId })

  const sidebarContribution = await extensions.contribute('accident-sidebar-action', {
    icon: 'accident-alert',
    label: '事故快处',
    disabled: false,
    showBadge: false,
    render: () => accidentListView.get(ctx),
  })
  const alertFlow = await services.connect(alertFlowService)
  const alertMapFocus = createAlertMapFocusController(platformMap ?? null)
  // 地图右键「获取并复制经纬度」：宿主渲染菜单并拾取坐标，插件组合 platform:clipboard 完成复制。
  const contextMenuRegistration = platformMap && clipboard
    ? await platformMap.registerContextMenuItem({
      id: 'copy-coordinates',
      label: '获取并复制经纬度',
      group: { id: 'location', label: '位置' },
      onTrigger: async ({ position }) => {
        if (!position) {
          await notification?.show({
            key: 'accident-coordinate-copy',
            message: '未拾取到地图坐标，请重试',
            intent: 'warning',
          })
          return
        }
        try {
          await clipboard.writeText({ text: `${position.lat},${position.lng}` })
        } catch (error) {
          logger.error('复制经纬度失败', { message: error instanceof Error ? error.message : String(error) })
          await notification?.show({
            key: 'accident-coordinate-copy',
            message: '复制经纬度失败，请手动记录',
            intent: 'error',
          })
        }
      },
    })
    : undefined
  const events = createAccidentEventsApi(ctx.apiCall)
  const workflow = createAccidentWorkflowApi(ctx.apiCall, ctx.config.flowName)
  let dialogPresentation: ViewPresentation | undefined

  async function openAllEventsDialog (): Promise<void> {
    if (!dialog) {
      await notification?.show({ key: 'accident-dialog-unavailable', message: '当前页面暂不支持警情列表弹窗', intent: 'warning' })
      return
    }
    const previous = dialogPresentation
    dialogPresentation = undefined
    await previous?.close()
    const nextPresentation = await dialog.open(allEventsDialogView.get(ctx), {
      title: '警情列表',
      width: 1300,
    })
    dialogPresentation = nextPresentation
    void nextPresentation.closed.then(() => {
      if (dialogPresentation === nextPresentation) dialogPresentation = undefined
    })
  }

  const controller = createAccidentListController({
    ctx,
    events,
    workflow,
    flightActions: createFlightActionsApi(ctx.apiCall),
    navigation: navigation ?? { open: async () => {}, back: async () => {} },
    projectId,
    organizationId,
    updateBadgeVisibility: visible => sidebarContribution.update({ showBadge: visible }),
    notifyError: async (message) => {
      if (!notification) {
        logger.error(message)
        return
      }
      await notification.show({
        key: `accident-response-${Date.now()}`,
        message,
        intent: 'error',
      })
    },
    recenter: async (record) => {
      if (!platformMap || record.latitude === undefined || record.longitude === undefined) return
      await platformMap.recenter({
        points: [{ lat: record.latitude, lng: record.longitude, height: record.height }],
        padding: 48,
      })
    },
    focusAlert: record => alertMapFocus.focus(record),
    clearAlertFocus: () => alertMapFocus.clear(),
    requestDispatch: async (request) => {
      try {
        await alertFlow.requestDispatch(request)
      } catch (error) {
        if (isPluginError(error) && error.code === 'SERVICE_UNAVAILABLE') {
          throw new Error('消息中心尚未就绪，请稍后重试')
        }
        throw error
      }
    },
    openAllEventsDialog,
  })

  await accidentListView.handle(ctx, { state: controller.state, methods: controller.listMethods })
  await allEventsDialogView.handle(ctx, { state: createViewState(null), methods: controller.dialogMethods })
  logger.debug('事故列表 View handler 注册完成', { viewId: 'accident-list' })

  await alertFlow.on('stateChanged', controller.handleFlowState)
  // 警情实时通知：订阅共享 WS 的 scene_alert biz_code，alert_notify 子类触发即时刷新（轮询兜底保留）。
  const alertNotifySubscription = await ctx.ws.onBizCode(
    ACCIDENT_ALERT_WS_BIZ_CODE,
    controller.handleAlertNotifyWsEvent,
  ).then((subscription) => {
    logger.debug('警情实时通知订阅完成', {
      bizCode: ACCIDENT_ALERT_WS_BIZ_CODE,
      subBizCode: ACCIDENT_ALERT_WS_SUB_BIZ_CODE,
    })
    return subscription
  }).catch((error: unknown) => {
    logger.warn('警情实时通知不可用，继续使用轮询', {
      message: error instanceof Error ? error.message : String(error),
    })
    return undefined
  })
  // 驾驶舱路由下 project-app 保持挂载但列表页不可见：用 platform:location 感知
  // #/cockpit，暂停自动轮询；离开时立即刷新并恢复。宿主未提供 location 能力时
  // 保持原行为（立即首拉 + 固定轮询）。
  let pollHandle: unknown
  const startPolling = (): void => {
    if (pollHandle !== undefined) return
    pollHandle = timers.setInterval(() => {
      void controller.fetchEvents('poll')
    }, ACCIDENT_LIST_POLL_INTERVAL_MS)
  }
  const stopPolling = (): void => {
    if (pollHandle === undefined) return
    timers.clearInterval(pollHandle)
    pollHandle = undefined
  }
  const pollGate = location
    ? createCockpitPollGate({
        location,
        refresh: () => {
          void controller.fetchEvents('initial')
        },
        startPolling,
        stopPolling,
      })
    : undefined
  if (pollGate) {
    await pollGate.start()
  } else {
    void controller.fetchEvents('initial')
    startPolling()
  }

  return {
    dispose: async () => {
      pollGate?.dispose()
      controller.dispose()
      alertMapFocus.clear()
      await contextMenuRegistration?.dispose()
      await alertNotifySubscription?.dispose()
      await dialogPresentation?.close()
      dialogPresentation = undefined
    },
  }
}
