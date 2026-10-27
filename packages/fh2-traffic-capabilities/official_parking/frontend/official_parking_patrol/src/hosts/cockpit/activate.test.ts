// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Disposable, FlightTaskState, FlightTaskStatus, TrackedTimers } from 'fh2-plugin-sdk'
import type { TaskPanelState } from '../../views/patrol-task-panel/contract'
import type { RecordsState } from '../../views/patrol-records/contract'
import type { PreviewState } from '../../views/patrol-preview/contract'
import type { PatrolDialogState } from '../../views/patrol-dialog/contract'
import type { ParkingPatrolCockpitContext } from '../../types'
import { activate } from './activate'

interface StateSource<T> {
  subscribe (handler: (state: T) => void): Disposable;
}

interface CapturedProvider<TState, TMethods> {
  state: StateSource<TState>;
  methods: TMethods;
}

const providers = vi.hoisted(() => ({
  taskPanel: undefined as CapturedProvider<TaskPanelState, { requestEndTask (): Promise<void>; dismiss (): Promise<void> }> | undefined,
  records: undefined as CapturedProvider<RecordsState, { selectCard (input: { targetId: string }): Promise<void> }> | undefined,
  preview: undefined as CapturedProvider<PreviewState, Record<string, never>> | undefined,
  dialog: undefined as CapturedProvider<PatrolDialogState, { cancel (): Promise<void>; confirm (): Promise<void> }> | undefined,
}))

const viewMocks = vi.hoisted(() => ({
  taskPanelView: {
    get: vi.fn(() => ({ viewId: 'patrol-task-panel', initialState: null })),
    handle: vi.fn(async (_ctx: unknown, provider: unknown) => {
      providers.taskPanel = provider as typeof providers.taskPanel
      return { dispose: vi.fn() }
    }),
  },
  recordsView: {
    get: vi.fn(() => ({ viewId: 'patrol-records', initialState: null })),
    handle: vi.fn(async (_ctx: unknown, provider: unknown) => {
      providers.records = provider as typeof providers.records
      return { dispose: vi.fn() }
    }),
  },
  previewView: {
    get: vi.fn(() => ({ viewId: 'patrol-preview', initialState: null })),
    handle: vi.fn(async (_ctx: unknown, provider: unknown) => {
      providers.preview = provider as typeof providers.preview
      return { dispose: vi.fn() }
    }),
  },
  patrolDialogView: {
    get: vi.fn(() => ({ viewId: 'patrol-dialog', initialState: null })),
    handle: vi.fn(async (_ctx: unknown, provider: unknown) => {
      providers.dialog = provider as typeof providers.dialog
      return { dispose: vi.fn() }
    }),
  },
}))

vi.mock('../../views/patrol-task-panel/contract', () => ({ taskPanelView: viewMocks.taskPanelView }))
vi.mock('../../views/patrol-records/contract', () => ({ recordsView: viewMocks.recordsView }))
vi.mock('../../views/patrol-preview/contract', () => ({ previewView: viewMocks.previewView }))
vi.mock('../../views/patrol-dialog/contract', () => ({ patrolDialogView: viewMocks.patrolDialogView }))

/** 订阅 View 状态源并持续捕获最新值。 */
function createReader<T> (source: StateSource<T>): () => T {
  let latest: T | undefined
  source.subscribe((value) => {
    latest = value
  })
  return () => latest as T
}

/** 手动触发式定时器：runPending() 执行一次所有已排期回调（interval 保持排期）。 */
function createFakeTimers (): TrackedTimers & { runPending (): void } {
  const tasks = new Map<unknown, { callback: () => void; interval: boolean }>()
  let seq = 0
  return {
    setTimeout (callback, _ms) {
      const handle = ++seq
      tasks.set(handle, { callback, interval: false })
      return handle
    },
    clearTimeout (handle) {
      tasks.delete(handle)
    },
    setInterval (callback, _ms) {
      const handle = ++seq
      tasks.set(handle, { callback, interval: true })
      return handle
    },
    clearInterval (handle) {
      tasks.delete(handle)
    },
    runPending () {
      for (const [handle, task] of [...tasks.entries()]) {
        task.callback()
        if (!task.interval) tasks.delete(handle)
      }
    },
  }
}

/** 微任务冲刷：让 activate 内部的异步链推进。 */
async function flush (rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

/** 普通航线通道快照（巡逻父任务识别与初检进度的唯一消费通道）。 */
function waylineFlightTaskState (input: {
  readonly taskId: string;
  readonly status?: FlightTaskStatus;
  readonly flightId?: string | null;
  readonly waylineUuid?: string | null;
  readonly completedWaypointCount?: number | null;
  readonly totalWaypointCount?: number | null;
}): FlightTaskState {
  return {
    kind: 'wayline',
    flightId: input.flightId ?? null,
    wayline: {
      taskId: input.taskId,
      status: input.status ?? 'running',
      progressPercent: null,
      waylineUuid: input.waylineUuid ?? null,
      taskType: '1',
      completedWaypointCount: input.completedWaypointCount ?? null,
      totalWaypointCount: input.totalWaypointCount ?? null,
    },
    inFlightWayline: null,
  }
}

function idleFlightTaskState (): FlightTaskState {
  return { kind: null, flightId: null, wayline: null, inFlightWayline: null }
}

interface TestHarness {
  context: ParkingPatrolCockpitContext;
  implementations: Map<string, Record<string, unknown>>;
  handles: Map<string, { reveal: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>;
  timers: ReturnType<typeof createFakeTimers>;
  dialog: { open: ReturnType<typeof vi.fn>; presentation: { close: ReturnType<typeof vi.fn> } };
  map: { addBillboard: ReturnType<typeof vi.fn>; recenter: ReturnType<typeof vi.fn> };
  notification: { show: ReturnType<typeof vi.fn> };
  ws: { onBizCode: ReturnType<typeof vi.fn> };
  apiCall: ReturnType<typeof vi.fn>;
  emitFlightTaskState (state: FlightTaskState): void;
  menubar (): Promise<void>;
}

function createHarness (options: {
  enableMock?: boolean;
  apiRoutes?: Record<string, unknown>;
} = {}): TestHarness {
  const implementations = new Map<string, Record<string, unknown>>()
  const handles = new Map<string, { reveal: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>()
  const timers = createFakeTimers()

  const map = {
    addBillboard: vi.fn(async () => ({ dispose: vi.fn() })),
    recenter: vi.fn(async () => {}),
  }
  const notification = { show: vi.fn(() => ({ dispose: () => {} })) }
  const dialogPresentation = { close: vi.fn(async () => {}), closed: new Promise<void>(() => {}) }
  const dialog = { open: vi.fn(() => dialogPresentation), presentation: dialogPresentation }
  const ws = { onBizCode: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })) }

  const flightTaskListeners = new Set<(state: FlightTaskState) => void>()
  let currentFlightTaskState: FlightTaskState = idleFlightTaskState()
  const flightTask = {
    getState: vi.fn(async () => currentFlightTaskState),
    onStateChanged: vi.fn(async (handler: (state: FlightTaskState) => void) => {
      flightTaskListeners.add(handler)
      return { dispose: () => flightTaskListeners.delete(handler) }
    }),
  }

  const apiRoutes = options.apiRoutes ?? {}
  const apiCall = vi.fn(async (endpoint: string, requestOptions?: { readonly method?: string }) => {
    const key = `${requestOptions?.method ?? 'GET'} ${endpoint}`
    if (key in apiRoutes) return apiRoutes[key]
    throw new Error(`unexpected apiCall: ${key}`)
  })

  const capabilities = {
    get: vi.fn(async (id: string) => {
      if (id === 'cockpit:context') {
        return {
          getState: async () => ({
            organizationId: 'org-1',
            projectId: 'proj-1',
            droneSn: 'DRONE-1',
            gatewaySn: 'DOCK-1',
            alertExecutionId: null,
            liveReady: true,
          }),
          onStateChanged: async () => ({ dispose: () => {} }),
        }
      }
      if (id === 'cockpit:flight-task') return flightTask
      if (id === 'platform:dialog') return dialog
      if (id === 'platform:map') {
        return {
          addMarker: vi.fn(async () => ({ dispose: () => {} })),
          addBillboard: map.addBillboard,
          addLabel: vi.fn(async () => ({ dispose: () => {} })),
          addPolyline: vi.fn(async () => ({ dispose: () => {} })),
          addPolygon: vi.fn(async () => ({ dispose: () => {} })),
          recenter: map.recenter,
          onClick: vi.fn(() => ({ dispose: () => {} })),
          onHover: vi.fn(() => ({ dispose: () => {} })),
        }
      }
      if (id === 'platform:notification') return notification
      return undefined
    }),
  }

  const context = {
    host: { id: 'cockpit' },
    config: { enableMock: options.enableMock ?? true },
    timers,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    apiCall,
    ws,
    capabilities,
    extensions: {
      contribute: vi.fn(async (id: string, implementation: Record<string, unknown>) => {
        implementations.set(id, implementation)
        const handle = { reveal: vi.fn(async () => {}), update: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
        handles.set(id, handle)
        return handle
      }),
    },
  } as unknown as ParkingPatrolCockpitContext

  return {
    context,
    implementations,
    handles,
    timers,
    dialog,
    map,
    notification,
    ws,
    apiCall,
    emitFlightTaskState (state) {
      currentFlightTaskState = state
      for (const listener of flightTaskListeners) listener(state)
    },
    async menubar () {
      await (implementations.get('patrol-menubar')!.onTrigger as () => Promise<void>)()
    },
  }
}

const readers: {
  panel: (() => TaskPanelState) | undefined;
  records: (() => RecordsState) | undefined;
  preview: (() => PreviewState) | undefined;
  dialog: (() => PatrolDialogState) | undefined;
} = { panel: undefined, records: undefined, preview: undefined, dialog: undefined }

function readPanel (): TaskPanelState {
  readers.panel ??= createReader(providers.taskPanel!.state)
  return readers.panel()
}

function readRecords (): RecordsState {
  readers.records ??= createReader(providers.records!.state)
  return readers.records()
}

function readPreview (): PreviewState {
  readers.preview ??= createReader(providers.preview!.state)
  return readers.preview()
}

function readDialog (): PatrolDialogState {
  readers.dialog ??= createReader(providers.dialog!.state)
  return readers.dialog()
}

async function advanceScenario (harness: TestHarness, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) await harness.menubar()
  await flush()
  harness.timers.runPending()
  await flush()
}

describe('parking-patrol Cockpit 装配（Mock 剧本全链路）', () => {
  beforeEach(() => {
    providers.taskPanel = undefined
    providers.records = undefined
    providers.preview = undefined
    providers.dialog = undefined
    readers.panel = undefined
    readers.records = undefined
    readers.preview = undefined
    readers.dialog = undefined
    vi.clearAllMocks()
  })

  it('任务到达：面板展示 waiting 准备态并自动展开记录面板', async () => {
    const harness = createHarness({ enableMock: true })
    const teardown = await activate(harness.context)

    expect(harness.implementations.get('patrol-task-panel')).toMatchObject({
      visible: false,
      interactive: true,
      width: 280,
      height: 254,
      placement: 'bottom-left',
      offsetX: 4,
      offsetY: -16,
    })
    expect(harness.handles.get('patrol-task-panel')!.update).not.toHaveBeenCalledWith(expect.objectContaining({ visible: true }))

    await harness.menubar() // 剧本步骤 1：下发任务（waiting）
    await flush()

    expect(harness.handles.get('patrol-task-panel')!.update).toHaveBeenCalledWith(expect.objectContaining({ visible: true }))
    expect(harness.handles.get('patrol-records')!.reveal).toHaveBeenCalled()
    const panel = readPanel()
    expect(panel.preparing).toBe(true)
    expect(panel.showProgress).toBe(false)
    await teardown.dispose()
  })

  it('接管后轮询快照驱动面板：phase1 进度 + 终止按钮', async () => {
    const harness = createHarness({ enableMock: true })
    const teardown = await activate(harness.context)

    await advanceScenario(harness, 4) // 步骤 1-4：接管 + 两辆违停车辆 + 初检完成
    const panel = readPanel()
    expect(panel.preparing).toBe(false)
    expect(panel.initialLabel).toBe('初检 — 已执行航点（26/26）')
    expect(panel.showEndButton).toBe(true)
    expect(panel.endButtonText).toBe('终止巡逻')
    expect(panel.endButtonDisabled).toBe(false)
    await teardown.dispose()
  })

  it('记录面板由 targets 驱动；点击卡片加载统一媒体并落地图图钉', async () => {
    const harness = createHarness({ enableMock: true })
    const teardown = await activate(harness.context)

    await advanceScenario(harness, 7) // 步骤 1-7：车辆1 取证完整 + 车辆2 复检中
    const records = readRecords()
    expect(records.group?.items).toHaveLength(2)
    expect(records.group?.statText).toBe('1/2')

    const completed = records.group!.items.find(item => item.badgeText === '取证完整')!
    await providers.records!.methods.selectCard({ targetId: completed.targetId })
    await flush()

    const preview = readPreview()
    // 初检 1 张 + 复检 1 张
    expect(preview.photos).toHaveLength(2)
    expect(preview.displayName).toBe(completed.displayName)
    expect(harness.map.addBillboard).toHaveBeenCalledWith(expect.objectContaining({
      position: expect.objectContaining({ lng: 113.9502, lat: 22.5312 }),
    }))
    await teardown.dispose()
  })

  it('返航窗口：return_pending 触发弹窗；确认返航后经轮询收敛到任务完成', async () => {
    const harness = createHarness({ enableMock: true })
    const teardown = await activate(harness.context)

    await advanceScenario(harness, 8) // 步骤 1-8：返航窗口开启
    expect(harness.dialog.open).toHaveBeenCalled()
    const dialog = readDialog()
    expect(dialog.kind).toBe('return-home')
    expect(dialog.countdown).toBeGreaterThan(0)

    await providers.dialog!.methods.confirm() // 返航
    harness.timers.runPending() // closeDialogAfterRpc + 轮询收敛
    await flush()
    harness.timers.runPending()
    await flush()

    expect(harness.dialog.presentation.close).toHaveBeenCalled()
    const panel = readPanel()
    expect(panel.isReview).toBe(true)
    expect(panel.reviewText).toBe('任务完成')
    await teardown.dispose()
  })

  it('不返航：cancel-return 进入 manual_control 终态并提示人工操控', async () => {
    const harness = createHarness({ enableMock: true })
    const teardown = await activate(harness.context)

    await advanceScenario(harness, 8)
    await providers.dialog!.methods.cancel() // 不返航
    await flush()

    expect(harness.notification.show).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('已取消返航'),
      intent: 'warning',
    }))
    const panel = readPanel()
    expect(panel.isReview).toBe(true)
    expect(panel.reviewText).toBe('已转人工控制')
    await teardown.dispose()
  })

  it('终止巡逻：确认后进入「正在终止…」，轮询收敛为已终止（user_abort）', async () => {
    const harness = createHarness({ enableMock: true })
    const teardown = await activate(harness.context)

    await advanceScenario(harness, 5) // 步骤 1-5：复检中
    await providers.taskPanel!.methods.requestEndTask()
    await flush()
    expect(readDialog().kind).toBe('end-task')

    await providers.dialog!.methods.confirm()
    await flush()
    let panel = readPanel()
    expect(panel.endButtonText).toBe('正在终止…')
    expect(panel.endButtonDisabled).toBe(true)

    harness.timers.runPending() // 第一次轮询：仍 abort_pending（mock 两段式收敛）
    await flush()
    harness.timers.runPending() // 第二次轮询：completed/user_abort
    await flush()
    panel = readPanel()
    expect(panel.isReview).toBe(true)
    expect(panel.reviewText).toBe('任务已终止')
    await teardown.dispose()
  })

  it('回顾态关闭面板：overlay 隐藏且不清任务身份', async () => {
    const harness = createHarness({ enableMock: true })
    const teardown = await activate(harness.context)

    await advanceScenario(harness, 9) // 完整跑完 → 终态
    await providers.taskPanel!.methods.dismiss()
    await flush()

    expect(harness.handles.get('patrol-task-panel')!.update).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
    await teardown.dispose()
  })

  it('menubar 解耦：剧本推进不驱动面板开关，也无 active 状态同步', async () => {
    const harness = createHarness({ enableMock: true })
    const teardown = await activate(harness.context)

    await advanceScenario(harness, 9)
    // 面板展开只能来自任务到达业务事件；menubar 不持有开关语义
    expect(harness.handles.get('patrol-menubar')!.update).not.toHaveBeenCalled()
    expect(harness.handles.get('patrol-records')!.update).not.toHaveBeenCalledWith(expect.objectContaining({ visible: false }))
    await teardown.dispose()
  })
})

describe('parking-patrol Cockpit 装配（真实模式：flight-task + 平台任务服务 + Engine）', () => {
  beforeEach(() => {
    providers.taskPanel = undefined
    providers.records = undefined
    providers.preview = undefined
    providers.dialog = undefined
    readers.panel = undefined
    readers.records = undefined
    readers.preview = undefined
    readers.dialog = undefined
    vi.clearAllMocks()
  })

  function realRoutes (overrides: Record<string, unknown> = {}) {
    return {
      'GET /task/api/v1/workspaces/proj-1/flight-tasks/task-1': {
        code: 0,
        data: { uuid: 'task-1', biz_ext: { 'es-patrol': {} }, name: '巡逻任务', begin_at: '2026-09-08T11:26:14.144869+08:00' },
      },
      'GET /plugin-scene/api/v1/patrol/tasks/task-1': {
        code: 0,
        data: {
          link_state: 'active',
          task_uuid: 'task-1',
          reject_reason: '',
          session_id: '1024',
          wayline_uuid: 'wl-1',
          phase: 'phase1',
          completion_reason: '',
          state_revision: 5,
          allowed_actions: ['abort'],
          abort_pending: false,
          return_home_state: 'none',
          return_home_due_at_ms: 0,
          target_stats: { total: 1, pending: 1, processing: 0, completed: 0, failed: 0, skipped: 0 },
          targets: [],
        },
      },
      'GET /wayline/api/v1/workspaces/proj-1/waylines/wl-1': {
        code: 0,
        data: { name: '福华路南段', ext: { wayline_point_nums: 12 } },
      },
      ...overrides,
    }
  }

  it('flight-task.taskId → 平台任务服务 biz_ext 判别 → 挂面板并轮询 Engine', async () => {
    const harness = createHarness({ enableMock: false, apiRoutes: realRoutes() })
    const teardown = await activate(harness.context)
    await flush()

    harness.emitFlightTaskState(waylineFlightTaskState({
      taskId: 'task-1',
      flightId: 'flight-1',
      waylineUuid: 'wl-1',
      completedWaypointCount: 3,
      totalWaypointCount: 12,
    }))
    await flush()

    // 识别链：平台任务服务 v1 单任务详情 → Engine 快照
    expect(harness.apiCall).toHaveBeenCalledWith(
      '/task/api/v1/workspaces/proj-1/flight-tasks/task-1',
      expect.anything(),
    )
    expect(harness.apiCall).toHaveBeenCalledWith('/plugin-scene/api/v1/patrol/tasks/task-1', expect.anything())

    const panel = readPanel()
    expect(panel.preparing).toBe(false)
    expect(panel.routeName).toBe('福华路南段')
    expect(panel.initialLabel).toBe('初检 — 已执行航点（3/12）')
    expect(panel.showEndButton).toBe(true)
    await teardown.dispose()
  })

  it('复检即时航线切换 taskId 时保留同航次抓拍记录', async () => {
    const routes = realRoutes()
    const taskRoute = routes['GET /plugin-scene/api/v1/patrol/tasks/task-1'] as {
      data: { targets: unknown[] };
    }
    taskRoute.data.targets = [{
      target_id: '88',
      status: 'pending',
      display_name: '粤B·12345',
      vehicle_class: 'car',
      lat: 22.5,
      lng: 113.9,
      best_frame_thumb_url: 'https://thumb',
      photo_taken_at_ms: 1756542962000,
      fail_reason: '',
    }]
    const harness = createHarness({ enableMock: false, apiRoutes: routes })
    const teardown = await activate(harness.context)
    await flush()

    harness.emitFlightTaskState(waylineFlightTaskState({
      taskId: 'task-1',
      flightId: 'flight-1',
      waylineUuid: 'wl-1',
      completedWaypointCount: 3,
      totalWaypointCount: 12,
    }))
    await flush()
    expect(readRecords().group?.items).toHaveLength(1)

    // 复检即时航线获得前台控制权：双通道并存，父巡逻 wayline 快照保留
    harness.emitFlightTaskState({
      kind: 'in-flight-wayline',
      flightId: 'flight-1',
      wayline: {
        taskId: 'task-1',
        status: 'running',
        progressPercent: null,
        waylineUuid: 'wl-1',
        taskType: '1',
        completedWaypointCount: 3,
        totalWaypointCount: 12,
      },
      inFlightWayline: { taskId: 'recheck-task-1', status: 'running', progressPercent: 0, taskName: '复检' },
    })
    await flush()

    expect(readRecords().group?.items).toHaveLength(1)
    expect(harness.apiCall).not.toHaveBeenCalledWith(
      '/task/api/v1/workspaces/proj-1/flight-tasks/recheck-task-1',
      expect.anything(),
    )
    await teardown.dispose()
  })

  it('普通飞行任务（biz_ext 无 es-patrol）：不挂面板、不请求 Engine', async () => {
    const harness = createHarness({
      enableMock: false,
      apiRoutes: {
        'GET /task/api/v1/workspaces/proj-1/flight-tasks/task-2': {
          code: 0,
          data: { uuid: 'task-2', biz_ext: null, name: '普通任务' },
        },
      },
    })
    const teardown = await activate(harness.context)
    await flush()

    harness.emitFlightTaskState(waylineFlightTaskState({
      taskId: 'task-2',
      flightId: 'flight-2',
      waylineUuid: 'wl-2',
      completedWaypointCount: 1,
      totalWaypointCount: 5,
    }))
    await flush()

    expect(harness.handles.get('patrol-task-panel')!.update).not.toHaveBeenCalledWith(expect.objectContaining({ visible: true }))
    expect(harness.apiCall).not.toHaveBeenCalledWith('/plugin-scene/api/v1/patrol/tasks/task-2', expect.anything())
    await teardown.dispose()
  })

  it('enableMock=false：不贡献 patrol-menubar（无剧本入口），记录面板仍常驻贡献', async () => {
    const harness = createHarness({ enableMock: false })
    const teardown = await activate(harness.context)
    await flush()

    expect(harness.implementations.has('patrol-menubar')).toBe(false)
    expect(harness.implementations.has('patrol-records')).toBe(true)
    expect(harness.implementations.get('patrol-records')).toMatchObject({ visible: true, width: 260, icon: 'patrol-icon' })
    await teardown.dispose()
  })

  it('enableMock=true：贡献 patrol-menubar 且 onTrigger 只推进剧本、不触碰面板', async () => {
    const harness = createHarness({ enableMock: true })
    const teardown = await activate(harness.context)
    await flush()

    const menubar = harness.implementations.get('patrol-menubar')!
    expect(menubar).toMatchObject({ icon: 'patrol-icon', label: '违停抓拍' })

    await harness.menubar() // 剧本步骤 1：下发任务
    await flush()

    // 面板 preparing 来自任务到达业务事件；menubar 自身零面板语义
    expect(readPanel().preparing).toBe(true)
    expect(harness.handles.get('patrol-menubar')!.update).not.toHaveBeenCalled()
    expect(harness.handles.get('patrol-records')!.update).not.toHaveBeenCalledWith(expect.objectContaining({ visible: false }))
    await teardown.dispose()
  })

  it('从巡逻任务切到普通任务：立即清理旧面板且不请求新任务的 Engine 状态', async () => {
    const harness = createHarness({
      enableMock: false,
      apiRoutes: {
        ...realRoutes(),
        'GET /task/api/v1/workspaces/proj-1/flight-tasks/task-2': {
          code: 0,
          data: { uuid: 'task-2', biz_ext: null, name: '普通任务' },
        },
      },
    })
    const teardown = await activate(harness.context)
    await flush()

    harness.emitFlightTaskState(waylineFlightTaskState({
      taskId: 'task-1',
      flightId: 'flight-1',
      waylineUuid: 'wl-1',
      completedWaypointCount: 3,
      totalWaypointCount: 12,
    }))
    await flush()
    expect(harness.handles.get('patrol-task-panel')!.update).toHaveBeenCalledWith(expect.objectContaining({ visible: true }))

    harness.emitFlightTaskState(waylineFlightTaskState({
      taskId: 'task-2',
      flightId: 'flight-2',
      waylineUuid: 'wl-2',
      completedWaypointCount: 0,
      totalWaypointCount: 5,
    }))
    await flush()
    expect(harness.handles.get('patrol-task-panel')!.update).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
    expect(harness.apiCall).not.toHaveBeenCalledWith('/plugin-scene/api/v1/patrol/tasks/task-2', expect.anything())
    await teardown.dispose()
  })

  it('无 taskId 时经 /current 发现定时巡逻任务', async () => {
    const harness = createHarness({
      enableMock: false,
      apiRoutes: {
        'GET /plugin-scene/api/v1/patrol/current?dock_sn=DOCK-1': {
          code: 0,
          data: {
            link_state: 'active',
            task_uuid: 'task-1',
            reject_reason: '',
            session_id: '1024',
            wayline_uuid: 'wl-1',
            phase: 'phase2',
            completion_reason: '',
            state_revision: 9,
            allowed_actions: ['abort'],
            abort_pending: false,
            return_home_state: 'none',
            return_home_due_at_ms: 0,
            target_stats: { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, skipped: 0 },
            targets: [],
          },
        },
        'GET /task/api/v1/workspaces/proj-1/flight-tasks/task-1': {
          code: 0,
          data: { uuid: 'task-1', biz_ext: { 'es-patrol': {} }, begin_at: '2026-09-08T11:26:14.144869+08:00' },
        },
      },
    })
    const teardown = await activate(harness.context)
    await flush()

    harness.timers.runPending() // 首个轮询周期
    await flush()

    expect(harness.apiCall).toHaveBeenCalledWith('/plugin-scene/api/v1/patrol/current?dock_sn=DOCK-1', expect.anything())
    expect(harness.handles.get('patrol-task-panel')!.update).toHaveBeenCalledWith(expect.objectContaining({ visible: true }))
    const panel = readPanel()
    expect(panel.recheckLabel).toBe('复检 — 已处理车辆（0/0）')
    await teardown.dispose()
  })

  it('wS 增量：sub_biz_code 四路分发只更新各自字段', async () => {
    const harness = createHarness({ enableMock: false, apiRoutes: realRoutes() })
    const teardown = await activate(harness.context)
    await flush()

    harness.emitFlightTaskState(waylineFlightTaskState({
      taskId: 'task-1',
      flightId: 'flight-1',
      waylineUuid: 'wl-1',
      completedWaypointCount: 3,
      totalWaypointCount: 12,
    }))
    await flush()

    const wsHandler = harness.ws.onBizCode.mock.calls[0]?.[1] as (event: { subBizCode: string | null; data: unknown }) => void
    expect(wsHandler).toBeDefined()

    // progress：phase 推进 + target_stats
    wsHandler({
      subBizCode: 'progress',
      data: {
        dock_sn: 'DOCK-1',
        task_uuid: 'task-1',
        session_id: '1024',
        state_revision: 6,
        phase: 'phase2',
        completion_reason: '',
        target_stats: { total: 2, pending: 0, processing: 1, completed: 1, failed: 0, skipped: 0 },
      },
    })
    let panel = readPanel()
    expect(panel.phase).toBe('phase2')
    expect(panel.recheckLabel).toBe('复检 — 已处理车辆（1/2）')

    // target_updated：目标出现并进入记录面板
    wsHandler({
      subBizCode: 'target_updated',
      data: {
        dock_sn: 'DOCK-1',
        task_uuid: 'task-1',
        session_id: '1024',
        state_revision: 7,
        target: { target_id: '88', status: 'pending', display_name: '粤B·12345', vehicle_class: 'car', lat: 22.5, lng: 113.9, best_frame_thumb_url: 'https://thumb', photo_taken_at_ms: 1756542962000, fail_reason: '' },
      },
    })
    expect(readRecords().group?.items).toHaveLength(1)

    // 未知 sub_biz_code：忽略
    wsHandler({ subBizCode: 'legacy', data: {} })
    expect(readRecords().group?.items).toHaveLength(1)

    // 旧 revision：整条丢弃（phase 不回退）
    wsHandler({
      subBizCode: 'progress',
      data: { dock_sn: 'DOCK-1', task_uuid: 'task-1', session_id: '1024', state_revision: 5, phase: 'phase1' },
    })
    panel = readPanel()
    expect(panel.phase).toBe('phase2')
    await teardown.dispose()
  })

  it('旧 return_pending 不弹窗；HTTP 权威快照可恢复返航弹窗和按钮状态', async () => {
    const routes = realRoutes({
      'GET /plugin-scene/api/v1/patrol/tasks/task-1': {
        code: 0,
        data: {
          link_state: 'active',
          task_uuid: 'task-1',
          reject_reason: '',
          session_id: '1024',
          wayline_uuid: 'wl-1',
          phase: 'phase2',
          completion_reason: '',
          state_revision: 10,
          allowed_actions: ['abort'],
          abort_pending: false,
          return_home_state: 'none',
          return_home_due_at_ms: 0,
          target_stats: { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, skipped: 0 },
          targets: [],
        },
      },
    })
    const harness = createHarness({ enableMock: false, apiRoutes: routes })
    const teardown = await activate(harness.context)
    await flush()
    harness.emitFlightTaskState(waylineFlightTaskState({
      taskId: 'task-1',
      flightId: 'flight-1',
      waylineUuid: 'wl-1',
      completedWaypointCount: 12,
      totalWaypointCount: 12,
    }))
    await flush()

    const wsHandler = harness.ws.onBizCode.mock.calls[0]?.[1] as (event: { subBizCode: string | null; data: unknown }) => void
    wsHandler({
      subBizCode: 'return_pending',
      data: { dock_sn: 'DOCK-1', task_uuid: 'task-1', session_id: '1024', state_revision: 10, due_at_ms: Date.now() + 30_000 },
    })
    await flush()
    expect(harness.dialog.open).not.toHaveBeenCalled()

    routes['GET /plugin-scene/api/v1/patrol/tasks/task-1'] = {
      code: 0,
      data: {
        link_state: 'active',
        task_uuid: 'task-1',
        reject_reason: '',
        session_id: '1024',
        wayline_uuid: 'wl-1',
        phase: 'phase2',
        completion_reason: '',
        state_revision: 11,
        allowed_actions: ['return_now', 'cancel_return', 'abort'],
        abort_pending: false,
        return_home_state: 'none',
        return_home_due_at_ms: Date.now() + 30_000,
        target_stats: { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, skipped: 0 },
        targets: [],
      },
    }
    harness.timers.runPending()
    await flush()
    expect(harness.dialog.open).toHaveBeenCalledOnce()
    expect(readDialog()).toMatchObject({ cancelDisabled: false, confirmDisabled: false })

    routes['GET /plugin-scene/api/v1/patrol/tasks/task-1'] = {
      code: 0,
      data: {
        link_state: 'active',
        task_uuid: 'task-1',
        reject_reason: '',
        session_id: '1024',
        wayline_uuid: 'wl-1',
        phase: 'phase2',
        completion_reason: '',
        state_revision: 12,
        allowed_actions: ['abort'],
        abort_pending: false,
        return_home_state: 'none',
        return_home_due_at_ms: Date.now() - 1,
        target_stats: { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, skipped: 0 },
        targets: [],
      },
    }
    harness.timers.runPending()
    await flush()
    // 窗口到期不自动关闭，两个决策按钮按 allowed_actions 置灰。
    expect(harness.dialog.presentation.close).not.toHaveBeenCalled()
    expect(readDialog()).toMatchObject({ cancelDisabled: true, confirmDisabled: true })
    await teardown.dispose()
  })

  it('不返航成功后，权威快照同 revision 回放同一窗口不得重开弹窗', async () => {
    const dueAt = Date.now() + 30_000
    // 快照恒定返回窗口开放（模拟权威行未收敛/迟到响应的同 revision 回放）
    const windowSnapshot = {
      code: 0,
      data: {
        link_state: 'active',
        task_uuid: 'task-1',
        reject_reason: '',
        session_id: '1024',
        wayline_uuid: 'wl-1',
        phase: 'phase2',
        completion_reason: '',
        state_revision: 11,
        allowed_actions: ['return_now', 'cancel_return', 'abort'],
        abort_pending: false,
        return_home_state: 'none',
        return_home_due_at_ms: dueAt,
        target_stats: { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, skipped: 0 },
        targets: [],
      },
    }
    const harness = createHarness({
      enableMock: false,
      apiRoutes: realRoutes({
        'GET /plugin-scene/api/v1/patrol/tasks/task-1': windowSnapshot,
        'POST /plugin-scene/api/v1/patrol/tasks/task-1/cancel-return': { code: 0, data: { return_home_state: 'cancelled' } },
      }),
    })
    const teardown = await activate(harness.context)
    await flush()
    harness.emitFlightTaskState(waylineFlightTaskState({
      taskId: 'task-1',
      flightId: 'flight-1',
      waylineUuid: 'wl-1',
      completedWaypointCount: 12,
      totalWaypointCount: 12,
    }))
    await flush()
    expect(harness.dialog.open).toHaveBeenCalledTimes(1)

    await providers.dialog!.methods.cancel() // 不返航
    await flush()
    harness.timers.runPending() // 延迟关闭 + refresh 后的下一轮轮询（回放同窗口）
    await flush()

    expect(harness.dialog.presentation.close).toHaveBeenCalled()
    expect(harness.dialog.open).toHaveBeenCalledTimes(1)
    await teardown.dispose()
  })

  it('rejected：轮询快照展示拒绝原因（飞行任务仍正常执行）', async () => {
    const harness = createHarness({
      enableMock: false,
      apiRoutes: {
        'GET /task/api/v1/workspaces/proj-1/flight-tasks/task-1': {
          code: 0,
          data: { uuid: 'task-1', biz_ext: { 'es-patrol': {} } },
        },
        'GET /plugin-scene/api/v1/patrol/tasks/task-1': {
          code: 0,
          data: { link_state: 'rejected', task_uuid: 'task-1', reject_reason: 'route_not_patrol' },
        },
      },
    })
    const teardown = await activate(harness.context)
    await flush()

    harness.emitFlightTaskState(waylineFlightTaskState({
      taskId: 'task-1',
      flightId: 'flight-1',
      waylineUuid: 'wl-1',
    }))
    await flush()

    const panel = readPanel()
    expect(panel.rejected).toBe(true)
    expect(panel.rejectText).toBe('该航线不支持违停抓拍，飞行任务仍会正常执行')
    expect(panel.showEndButton).toBe(false)
    await teardown.dispose()
  })
})
