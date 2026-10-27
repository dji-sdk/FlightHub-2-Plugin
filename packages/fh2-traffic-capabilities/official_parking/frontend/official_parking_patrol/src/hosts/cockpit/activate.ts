// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import { type ApiCallFn, type PatrolApi, createHttpPatrolApi } from '../../api/patrol-api'
import { type MockPatrolBackendDriver, createMockPatrolBackend } from '../../mock/patrol-source'
import { type PatrolScenario, createPatrolScenario } from '../../mock/scenario'
import { createPhotoMarkerIcon } from '../../mock/evidence-images'
import type { ParkingPatrolCockpitContext } from '../../types'
import type { PatrolDialogState } from '../../views/patrol-dialog/contract'
import { patrolDialogView } from '../../views/patrol-dialog/contract'
import type { PreviewState } from '../../views/patrol-preview/contract'
import { previewView } from '../../views/patrol-preview/contract'
import type { RecordsState } from '../../views/patrol-records/contract'
import { recordsView } from '../../views/patrol-records/contract'
import { taskPanelView } from '../../views/patrol-task-panel/contract'
import type { PatrolLinkState } from '../../api/types'
import type { PatrolTaskState } from '../../workflow/patrol-session'
import { createInitialPatrolState, dismissPatrol } from '../../workflow/patrol-session'
import { createEvidencePreview } from './evidence-preview'
import { createMapPreviewController } from './map-preview'
import { END_TASK_DIALOG, createPatrolDialogController } from './patrol-dialog-controller'
import { createPatrolRuntime } from './patrol-runtime'
import {
  createTaskViewUpdater,
  rejectText,
  toTaskPanelState,
} from './task-view'

/** Cockpit Host 组合入口：创建依赖、注册界面，并连接 Runtime 与各 UI Controller。 */
export async function activate (ctx: ParkingPatrolCockpitContext) {
  const [dialogCapability, mapCapability, notification, cockpitContext] = await Promise.all([
    ctx.capabilities.get('platform:dialog'),
    ctx.capabilities.get('platform:map'),
    ctx.capabilities.get('platform:notification'),
    ctx.capabilities.get('cockpit:context'),
  ])

  // Mock 仅用于当前测试剧本，后续会整体删除，不为它增加长期抽象。
  const backend: MockPatrolBackendDriver | null = ctx.config.enableMock ? createMockPatrolBackend() : null
  const apiCall: ApiCallFn = (endpoint, options) => ctx.apiCall(endpoint, options)
  const api: PatrolApi = backend ?? createHttpPatrolApi(apiCall)
  const scenario: PatrolScenario | null = backend ? createPatrolScenario(backend) : null
  const flightTask = backend ? null : await ctx.capabilities.get('cockpit:flight-task')

  const taskState = createViewState<PatrolTaskState>(createInitialPatrolState())
  const recordsState = createViewState<RecordsState>({ group: null, activeTargetId: '' })
  const previewState = createViewState<PreviewState>({ displayName: '', photos: [], initialIndex: 0 })
  const dialogState = createViewState<PatrolDialogState>(END_TASK_DIALOG)

  const taskOverlay = await ctx.extensions.contribute('patrol-task-panel', {
    visible: false,
    interactive: true,
    width: 280,
    height: 254,
    placement: 'bottom-left' as const,
    offsetX: 4,
    offsetY: -16,
    render: () => taskPanelView.get(ctx),
  })
  const recordsPanel = await ctx.extensions.contribute('patrol-records', {
    visible: true,
    label: '违停巡逻',
    icon: 'patrol-icon',
    width: 260,
    render: () => recordsView.get(ctx),
  })
  const previewTab = await ctx.extensions.contribute('patrol-preview', {
    visible: false,
    label: '违停车辆',
    icon: 'cockpit_viewfollow',
    render: () => previewView.get(ctx),
  })
  if (scenario) {
    await ctx.extensions.contribute('patrol-menubar', {
      icon: 'patrol-icon',
      label: '违停抓拍',
      active: false,
      disabled: false,
      onTrigger: () => {
        scenario.advance()
      },
    })
  }

  const mapPreview = createMapPreviewController(mapCapability ?? null, thumbUrl => (
    createPhotoMarkerIcon(thumbUrl, '#268AFF')
  ))

  function notify (intent: 'info' | 'success' | 'warning' | 'error', message: string): void {
    notification?.show({ key: `patrol-${intent}`, message, intent })
  }

  function reportRuntimeError (operation: string, error: unknown): void {
    ctx.logger.warn(operation, { message: error instanceof Error ? error.message : String(error) })
  }

  let runtime: ReturnType<typeof createPatrolRuntime>
  const dialogController = createPatrolDialogController({
    dialogPort: dialogCapability ?? null,
    getDialogView: () => patrolDialogView.get(ctx),
    timers: ctx.timers,
    taskState,
    dialogState,
    api,
    notify,
    refresh: () => runtime.refresh(),
  })
  const evidencePreview = createEvidencePreview({
    api,
    taskState,
    recordsState,
    previewState,
    previewTab,
    mapPreview,
  })
  const taskViews = createTaskViewUpdater({ recordsState, taskOverlay })

  runtime = createPatrolRuntime({
    api,
    timers: ctx.timers,
    taskState,
    context: cockpitContext ?? null,
    flightTask: flightTask ?? null,
    mockEvents: backend?.events ?? null,
    subscribeWs: backend
      ? null
      : handler => ctx.ws.onBizCode('patrol_progress', (event) => {
        ctx.logger.debug('收到 patrol ws 消息', { subBizCode: event.subBizCode, data: event.data })
        handler(event)
      }),
    onTaskActivated: async () => {
      await recordsPanel.reveal({ reason: 'patrol-task-arrived' })
    },
    onError: reportRuntimeError,
  })

  await taskPanelView.handle(ctx, {
    state: taskState.map(toTaskPanelState),
    methods: {
      requestEndTask: () => dialogController.open('end-task'),
      async dismiss () {
        taskState.update(state => dismissPatrol(state))
      },
    },
  })
  await recordsView.handle(ctx, {
    state: recordsState,
    methods: {
      selectCard: ({ targetId }) => evidencePreview.select(targetId),
    },
  })
  await previewView.handle(ctx, { state: previewState, methods: {} })
  await patrolDialogView.handle(ctx, {
    state: dialogState,
    methods: {
      cancel: () => dialogController.cancel(),
      confirm: () => dialogController.confirm(),
    },
  })

  let lastTaskUuid = ''
  let lastLinkState: PatrolLinkState = 'waiting'
  const taskStateSubscription = taskState.subscribe((state) => {
    void taskViews.updateTaskOverlay(state).catch(error => reportRuntimeError('更新巡逻任务面板失败', error))
    taskViews.updateRecordsPanel(state)

    if (state.taskUuid !== lastTaskUuid) {
      lastTaskUuid = state.taskUuid
      lastLinkState = state.linkState
      evidencePreview.reset()
      void dialogController.close()
      return
    }

    if (state.linkState !== lastLinkState) {
      lastLinkState = state.linkState
      if (state.linkState === 'rejected') notify('error', rejectText(state.rejectReason))
    }
    dialogController.handleTaskStateChange(state)
    evidencePreview.handleTaskStateChange(state)
  })

  await runtime.start()

  return {
    dispose: async () => {
      await runtime.dispose()
      await dialogController.dispose()
      try {
        mapPreview.clear()
      } catch (error) {
        reportRuntimeError('清理证据地图失败', error)
      }
      taskStateSubscription.dispose()
    },
  }
}
