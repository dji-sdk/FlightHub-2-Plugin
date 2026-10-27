// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { CockpitContextState, Disposable, FlightTaskState, FlightTaskStatus, TrackedTimers } from 'fh2-plugin-sdk'
import type { PatrolApi } from '../../api/patrol-api'
import type { FlightTaskDetail, PatrolAbortResponse, PatrolTaskSnapshot } from '../../api/types'
import type { PatrolTaskState, PatrolWsMessage } from '../../workflow/patrol-session'
import { createInitialPatrolState } from '../../workflow/patrol-session'
import { createPatrolRuntime } from './patrol-runtime'

function flush (rounds = 20): Promise<void> {
  return Array.from({ length: rounds }).reduce<Promise<void>>(
    promise => promise.then(() => Promise.resolve()),
    Promise.resolve(),
  )
}

function createTimers (): TrackedTimers & { runIntervals (): void; activeTimerCount (): number; delays (): number[] } {
  const intervals = new Map<unknown, () => void>()
  const timeouts = new Map<unknown, () => void>()
  // 历史日志：记录每次 setTimeout 的 delay（含已被 clearTimeout 的），供节奏断言。
  const scheduledDelays: number[] = []
  let id = 0
  return {
    setTimeout (callback, delay = 0) {
      const handle = ++id
      timeouts.set(handle, callback)
      scheduledDelays.push(delay)
      return handle
    },
    clearTimeout (handle) {
      timeouts.delete(handle)
    },
    setInterval (callback) {
      const handle = ++id
      intervals.set(handle, callback)
      return handle
    },
    clearInterval (handle) {
      intervals.delete(handle)
    },
    runIntervals () {
      const pendingTimeouts = [...timeouts.entries()]
      for (const [handle, callback] of pendingTimeouts) {
        timeouts.delete(handle)
        callback()
      }
      for (const callback of [...intervals.values()]) callback()
    },
    activeTimerCount () {
      return timeouts.size + intervals.size
    },
    delays () {
      return [...scheduledDelays]
    },
  }
}

function createTaskStore () {
  const listeners = new Set<(state: PatrolTaskState) => void>()
  const store = {
    current: createInitialPatrolState(),
    get: () => store.current,
    update (updater: (current: PatrolTaskState) => PatrolTaskState) {
      store.current = updater(store.current)
      for (const listener of listeners) listener(store.current)
    },
    subscribe (listener: (state: PatrolTaskState) => void): Disposable {
      listeners.add(listener)
      listener(store.current)
      return {
        dispose: () => {
          listeners.delete(listener)
        },
      }
    },
    listenerCount: () => listeners.size,
  }
  return store
}

function activeSnapshot (taskUuid: string, revision = 1): PatrolTaskSnapshot {
  return {
    link_state: 'active',
    task_uuid: taskUuid,
    reject_reason: '',
    session_id: 'session-1',
    wayline_uuid: 'wayline-1',
    phase: 'phase1',
    completion_reason: '',
    state_revision: revision,
    allowed_actions: ['abort'],
    abort_pending: false,
    return_home_state: 'none',
    return_home_due_at_ms: 0,
    target_stats: { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, skipped: 0 },
    targets: [],
  }
}

function createApi (overrides: Partial<PatrolApi> = {}): PatrolApi {
  return {
    getTask: vi.fn(async taskUuid => activeSnapshot(taskUuid)),
    getCurrent: vi.fn(async () => null),
    getTargetMedia: vi.fn(async () => ({ target_id: '', status: '', url_expires_at_ms: 0, initial: null, recheck: [] })),
    returnNow: vi.fn(async () => ({ return_home_state: 'pending' })),
    cancelReturn: vi.fn(async () => ({ return_home_state: 'cancelled' })),
    abort: vi.fn(async (): Promise<PatrolAbortResponse> => ({ effective: 'immediate', return_home_state: 'none' })),
    getFlightTaskDetail: vi.fn(async (_projectId, taskUuid) => ({ uuid: taskUuid, biz_ext: { 'es-patrol': {} }, begin_at_ms: 0 })),
    getWaylineInfo: vi.fn(async () => ({ name: '福华路南段', waypointCount: 12 })),
    ...overrides,
  }
}

function flightState (
  taskId: string | null,
  status: FlightTaskStatus | null = null,
  flightId: string | null = null,
): FlightTaskState {
  return {
    kind: taskId ? 'wayline' : null,
    flightId,
    wayline: taskId === null
      ? null
      : {
          taskId,
          status: status ?? 'running',
          progressPercent: null,
          waylineUuid: null,
          taskType: null,
          completedWaypointCount: 0,
          totalWaypointCount: 12,
        },
    inFlightWayline: null,
  }
}

/** 复检即时航线执行中：父巡逻 wayline 任务与即时航线双通道并存。 */
function recheckActiveState (flightId: string, recheckTaskId: string, patrolTaskId: string): FlightTaskState {
  return {
    kind: 'in-flight-wayline',
    flightId,
    wayline: {
      taskId: patrolTaskId,
      status: 'running',
      progressPercent: null,
      waylineUuid: null,
      taskType: null,
      completedWaypointCount: 0,
      totalWaypointCount: 12,
    },
    inFlightWayline: { taskId: recheckTaskId, status: 'running', progressPercent: 10, taskName: '复检临时航线' },
  }
}

function contextState (projectId: string | null): CockpitContextState {
  return {
    organizationId: 'org-1',
    projectId,
    droneSn: 'drone-1',
    gatewaySn: 'dock-1',
    alertExecutionId: null,
    liveReady: true,
  }
}

describe('createPatrolRuntime', () => {
  it('任务识别失败后由轮询重试，taskId 清空时保留当前任务', async () => {
    const timers = createTimers()
    const taskStore = createTaskStore()
    let flightListener: ((state: FlightTaskState) => void) | undefined
    const getFlightTaskDetail = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue({ uuid: 'task-1', biz_ext: { 'es-patrol': {} }, begin_at_ms: 0 })
    const runtime = createPatrolRuntime({
      api: createApi({ getFlightTaskDetail }),
      timers,
      taskState: taskStore,
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      flightTask: {
        getState: async () => flightState(null),
        onStateChanged: async (listener) => {
          flightListener = listener
          return { dispose: vi.fn() }
        },
      },
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()

    flightListener?.(flightState('task-1'))
    await flush()
    expect(taskStore.current.taskUuid).toBe('')

    timers.runIntervals()
    await flush()
    expect(taskStore.current.taskUuid).toBe('task-1')

    flightListener?.(flightState(null))
    expect(taskStore.current.taskUuid).toBe('task-1')
    await runtime.dispose()
  })

  it('复检即时航线不影响已确认的巡逻父任务', async () => {
    const timers = createTimers()
    const taskStore = createTaskStore()
    let flightListener: ((state: FlightTaskState) => void) | undefined
    const snapshot = {
      ...activeSnapshot('patrol-task'),
      target_stats: { total: 1, pending: 1, processing: 0, completed: 0, failed: 0, skipped: 0 },
      targets: [{
        target_id: 'target-1',
        status: 'pending',
        display_name: '粤B·12345',
        vehicle_class: 'car',
        lat: 22.5,
        lng: 113.9,
        best_frame_thumb_url: 'https://thumb',
        photo_taken_at_ms: 1756542962000,
        fail_reason: '',
      }],
    }
    const api = createApi({ getTask: vi.fn(async () => snapshot) })
    const runtime = createPatrolRuntime({
      api,
      timers,
      taskState: taskStore,
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      flightTask: {
        getState: async () => flightState('patrol-task', null, 'flight-1'),
        onStateChanged: async (listener) => {
          flightListener = listener
          return { dispose: vi.fn() }
        },
      },
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    await flush()
    expect(taskStore.current).toMatchObject({ taskUuid: 'patrol-task', targets: [{ target_id: 'target-1' }] })

    // 双通道并存：即时航线获得前台控制权，父巡逻 wayline 快照仍保留
    flightListener?.(recheckActiveState('flight-1', 'recheck-task', 'patrol-task'))
    await flush()
    // 纯即时航线状态（父任务快照暂缺）同样不清空已确认巡逻任务
    flightListener?.(flightState(null, null, 'flight-1'))
    await flush()
    // 父任务快照恢复后仍是同一任务，不重新判别、不清空 records
    flightListener?.(flightState('patrol-task', null, 'flight-1'))
    await flush()

    expect(taskStore.current).toMatchObject({ taskUuid: 'patrol-task', targets: [{ target_id: 'target-1' }] })
    expect(api.getFlightTaskDetail).toHaveBeenCalledTimes(1)

    timers.runIntervals()
    await flush()
    expect(api.getTask).toHaveBeenLastCalledWith('patrol-task')
    await runtime.dispose()
  })

  it('新航次先到达空 taskId 时清除旧巡逻任务并停止旧轮询', async () => {
    const timers = createTimers()
    const taskStore = createTaskStore()
    let flightListener: ((state: FlightTaskState) => void) | undefined
    const api = createApi()
    const runtime = createPatrolRuntime({
      api,
      timers,
      taskState: taskStore,
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      flightTask: {
        getState: async () => flightState('patrol-task', null, 'flight-1'),
        onStateChanged: async (listener) => {
          flightListener = listener
          return { dispose: vi.fn() }
        },
      },
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    await flush()
    const patrolPolls = vi.mocked(api.getTask).mock.calls.length

    flightListener?.(flightState(null, null, 'flight-2'))
    await flush()
    expect(taskStore.current).toEqual(createInitialPatrolState())

    timers.runIntervals()
    await flush()
    expect(api.getTask).toHaveBeenCalledTimes(patrolPolls)
    expect(api.getCurrent).toHaveBeenCalled()
    await runtime.dispose()
  })

  it('projectId 晚到时继续识别已经观察到的任务', async () => {
    const taskStore = createTaskStore()
    let contextListener: ((state: CockpitContextState) => void) | undefined
    const api = createApi()
    const runtime = createPatrolRuntime({
      api,
      timers: createTimers(),
      taskState: taskStore,
      context: {
        getState: async () => contextState(null),
        onStateChanged: async (listener) => {
          contextListener = listener
          return { dispose: vi.fn() }
        },
      },
      flightTask: {
        getState: async () => flightState('task-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    expect(api.getFlightTaskDetail).not.toHaveBeenCalled()

    contextListener?.(contextState('project-1'))
    await flush()

    expect(api.getFlightTaskDetail).toHaveBeenCalledWith('project-1', 'task-1')
    expect(taskStore.current.taskUuid).toBe('task-1')
    await runtime.dispose()
  })

  it('识别巡逻任务时把详情 begin_at_ms 写为任务开始时间', async () => {
    const taskStore = createTaskStore()
    const api = createApi({
      getFlightTaskDetail: vi.fn(async () => ({ uuid: 'task-1', biz_ext: { 'es-patrol': {} }, begin_at_ms: 1756542962000 })),
    })
    const runtime = createPatrolRuntime({
      api,
      timers: createTimers(),
      taskState: taskStore,
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      flightTask: {
        getState: async () => flightState('task-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    await flush()

    expect(taskStore.current).toMatchObject({ taskUuid: 'task-1', startedAtMs: 1756542962000 })
    await runtime.dispose()
  })

  it('冷启动 /current 发现任务时补查详情拿开始时间', async () => {
    const taskStore = createTaskStore()
    const api = createApi({
      getCurrent: vi.fn(async () => activeSnapshot('discovered-1')),
      getFlightTaskDetail: vi.fn(async (_projectId: string, taskUuid: string) => (
        { uuid: taskUuid, biz_ext: { 'es-patrol': {} }, begin_at_ms: 1756542962000 }
      )),
    })
    const runtime = createPatrolRuntime({
      api,
      timers: createTimers(),
      taskState: taskStore,
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      flightTask: null,
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    await flush()

    expect(api.getFlightTaskDetail).toHaveBeenCalledWith('project-1', 'discovered-1')
    expect(taskStore.current).toMatchObject({ taskUuid: 'discovered-1', startedAtMs: 1756542962000 })
    await runtime.dispose()
  })

  it('冷启动补查开始时间失败不阻塞任务恢复，时间保持占位', async () => {
    const taskStore = createTaskStore()
    const api = createApi({
      getCurrent: vi.fn(async () => activeSnapshot('discovered-1')),
      getFlightTaskDetail: vi.fn(async () => {
        throw new Error('temporary')
      }),
    })
    const onError = vi.fn()
    const runtime = createPatrolRuntime({
      api,
      timers: createTimers(),
      taskState: taskStore,
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      flightTask: null,
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError,
    })
    await runtime.start()
    await flush()

    expect(taskStore.current).toMatchObject({ taskUuid: 'discovered-1', startedAtMs: 0 })
    expect(onError).toHaveBeenCalledWith('查询任务开始时间失败', expect.any(Error))
    await runtime.dispose()
  })

  it('mock 任务到达事件携带任务开始时间', async () => {
    const taskStore = createTaskStore()
    let arrive: ((taskUuid: string, startedAtMs: number) => void) | undefined
    const runtime = createPatrolRuntime({
      api: createApi(),
      timers: createTimers(),
      taskState: taskStore,
      context: null,
      flightTask: null,
      mockEvents: {
        onTaskArrived (listener) {
          arrive = listener
          return () => {}
        },
        onWsMessage: () => () => {},
        onFlightTaskProgress: () => () => {},
      },
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    arrive?.('task-1', 1756542962000)
    await flush()

    expect(taskStore.current).toMatchObject({ taskUuid: 'task-1', startedAtMs: 1756542962000 })
    await runtime.dispose()
  })

  it.each(['completed', 'failed'] as const)('冷启动保留的 %s flight task 不激活历史巡逻', async (status) => {
    const timers = createTimers()
    const taskStore = createTaskStore()
    const api = createApi()
    const onTaskActivated = vi.fn(async () => {})
    const runtime = createPatrolRuntime({
      api,
      timers,
      taskState: taskStore,
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      flightTask: {
        getState: async () => flightState('old-task', status),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated,
      onError: vi.fn(),
    })
    await runtime.start()
    timers.runIntervals()
    await flush()

    expect(taskStore.current.taskUuid).toBe('')
    expect(api.getFlightTaskDetail).not.toHaveBeenCalled()
    expect(api.getTask).not.toHaveBeenCalled()
    expect(onTaskActivated).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  it('任务判别返回前同一 flight task 已终止时丢弃迟到结果', async () => {
    const taskStore = createTaskStore()
    let flightListener: ((state: FlightTaskState) => void) | undefined
    let resolveDetail: ((value: FlightTaskDetail) => void) | undefined
    const api = createApi({
      getFlightTaskDetail: vi.fn(() => new Promise<FlightTaskDetail>((resolve) => {
        resolveDetail = resolve
      })),
    })
    const onTaskActivated = vi.fn(async () => {})
    const runtime = createPatrolRuntime({
      api,
      timers: createTimers(),
      taskState: taskStore,
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      flightTask: {
        getState: async () => flightState('task-1'),
        onStateChanged: async (listener) => {
          flightListener = listener
          return { dispose: vi.fn() }
        },
      },
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated,
      onError: vi.fn(),
    })
    await runtime.start()
    await flush()

    flightListener?.(flightState('task-1', 'completed'))
    resolveDetail?.({ uuid: 'task-1', biz_ext: { 'es-patrol': {} }, begin_at_ms: 0 })
    await flush()

    expect(taskStore.current.taskUuid).toBe('')
    expect(onTaskActivated).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  it('普通飞行任务只判别一次，不在每个轮询周期重复请求详情', async () => {
    const timers = createTimers()
    const taskStore = createTaskStore()
    const api = createApi({
      getFlightTaskDetail: vi.fn(async () => ({ uuid: 'task-normal', biz_ext: null, begin_at_ms: 0 })),
    })
    const runtime = createPatrolRuntime({
      api,
      timers,
      taskState: taskStore,
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      flightTask: {
        getState: async () => flightState('task-normal'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    await flush()

    timers.runIntervals()
    await flush()
    timers.runIntervals()
    await flush()

    expect(api.getFlightTaskDetail).toHaveBeenCalledTimes(1)
    await runtime.dispose()
  })

  it('任务详情暂时为空时保留重试机会', async () => {
    const timers = createTimers()
    const taskStore = createTaskStore()
    const getFlightTaskDetail = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ uuid: 'task-1', biz_ext: { 'es-patrol': {} } })
    const runtime = createPatrolRuntime({
      api: createApi({ getFlightTaskDetail }),
      timers,
      taskState: taskStore,
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      flightTask: {
        getState: async () => flightState('task-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    await flush()
    expect(taskStore.current.taskUuid).toBe('')

    timers.runIntervals()
    await flush()

    expect(taskStore.current.taskUuid).toBe('task-1')
    await runtime.dispose()
  })

  it('初始化期间发生变化时不让旧 context 和 flight-task 快照覆盖新事件', async () => {
    const taskStore = createTaskStore()
    let updateContext: ((state: CockpitContextState) => void) | undefined
    let updateFlightTask: ((state: FlightTaskState) => void) | undefined
    let resolveInitialContext: ((state: CockpitContextState) => void) | undefined
    let resolveInitialFlightTask: ((state: FlightTaskState) => void) | undefined
    const api = createApi()
    const runtime = createPatrolRuntime({
      api,
      timers: createTimers(),
      taskState: taskStore,
      context: {
        getState: () => new Promise<CockpitContextState>((resolve) => {
          resolveInitialContext = resolve
        }),
        onStateChanged: async (listener) => {
          updateContext = listener
          return { dispose: vi.fn() }
        },
      },
      flightTask: {
        getState: () => new Promise<FlightTaskState>((resolve) => {
          resolveInitialFlightTask = resolve
        }),
        onStateChanged: async (listener) => {
          updateFlightTask = listener
          return { dispose: vi.fn() }
        },
      },
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })

    const starting = runtime.start()
    await flush()
    updateContext?.(contextState('project-new'))
    resolveInitialContext?.(contextState('project-old'))
    await flush()
    updateFlightTask?.(flightState('task-new'))
    resolveInitialFlightTask?.(flightState('task-old'))
    await starting
    await flush()

    expect(api.getFlightTaskDetail).toHaveBeenCalledWith('project-new', 'task-new')
    expect(api.getFlightTaskDetail).not.toHaveBeenCalledWith('project-old', 'task-old')
    expect(taskStore.current.taskUuid).toBe('task-new')
    await runtime.dispose()
  })

  it('current 冷启动发现失败终态时不激活历史巡逻并继续发现后续任务', async () => {
    const timers = createTimers()
    const taskStore = createTaskStore()
    const failed = {
      ...activeSnapshot('643f0777-d52c-4182-a43b-cc2b60953d0e', 7),
      phase: 'failed' as const,
      completion_reason: 'return_home_failed',
      return_home_state: 'failed',
      return_home_due_at_ms: 1788522771083,
    }
    const api = createApi({
      getCurrent: vi.fn(async () => failed),
    })
    const onTaskActivated = vi.fn(async () => {})
    const runtime = createPatrolRuntime({
      api,
      timers,
      taskState: taskStore,
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      flightTask: {
        getState: async () => flightState(null),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated,
      onError: vi.fn(),
    })
    await runtime.start()

    timers.runIntervals()
    await flush()
    expect(taskStore.current.taskUuid).toBe('')

    timers.runIntervals()
    await flush()

    expect(api.getCurrent).toHaveBeenCalledTimes(3)
    // 终态未命中不计快查：三轮慢查间隔均为 15s
    expect(timers.delays()).toEqual([15000, 15000, 15000])
    expect(api.getWaylineInfo).not.toHaveBeenCalled()
    expect(onTaskActivated).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  it('idle 发现连续无任务时先 2s 快查 10 次再降频 15s', async () => {
    const timers = createTimers()
    const taskStore = createTaskStore()
    const api = createApi()
    const runtime = createPatrolRuntime({
      api,
      timers,
      taskState: taskStore,
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      flightTask: null,
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    await flush()
    // 首轮发现已发出（miss=1 → 排 2s）
    expect(api.getCurrent).toHaveBeenCalledTimes(1)

    // 快查阶段：miss 2..10，第 1..9 个 delay 均为 2s，第 10 个起降频
    for (let round = 0; round < 9; round++) {
      timers.runIntervals()
      await flush()
    }
    expect(api.getCurrent).toHaveBeenCalledTimes(10)
    expect(timers.delays().slice(0, 9)).toEqual(Array(9).fill(2000))
    expect(timers.delays()[9]).toBe(15000)

    // 慢查阶段：间隔保持 15s
    timers.runIntervals()
    await flush()
    expect(api.getCurrent).toHaveBeenCalledTimes(11)
    expect(timers.delays()[10]).toBe(15000)
    await runtime.dispose()
  })

  it('慢速发现期间发现活跃任务后恢复 2s 跟踪轮询并停止发现', async () => {
    const timers = createTimers()
    const taskStore = createTaskStore()
    let getCurrentCalls = 0
    const api = createApi({
      getCurrent: vi.fn(async () => {
        getCurrentCalls++
        // 前 11 次（快查 10 + 慢查 1）无任务，第 12 次发现活跃任务
        return getCurrentCalls <= 11 ? null : activeSnapshot('discovered-1')
      }),
    })
    const runtime = createPatrolRuntime({
      api,
      timers,
      taskState: taskStore,
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      flightTask: null,
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    await flush()
    for (let round = 0; round < 11; round++) {
      timers.runIntervals()
      await flush()
    }

    expect(api.getCurrent).toHaveBeenCalledTimes(12)
    expect(taskStore.current.taskUuid).toBe('discovered-1')
    // 激活转 tracking：miss 计数清零，下一轮间隔回到 2s
    expect(timers.delays()[11]).toBe(2000)

    timers.runIntervals()
    await flush()
    expect(api.getCurrent).toHaveBeenCalledTimes(12)
    expect(api.getTask).toHaveBeenCalledWith('discovered-1')
    await runtime.dispose()
  })

  it('慢速发现后机场切换重置 miss 计数恢复 2s 快查', async () => {
    const timers = createTimers()
    const taskStore = createTaskStore()
    let contextListener: ((state: CockpitContextState) => void) | undefined
    const api = createApi()
    const runtime = createPatrolRuntime({
      api,
      timers,
      taskState: taskStore,
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async (listener) => {
          contextListener = listener
          return { dispose: vi.fn() }
        },
      },
      flightTask: null,
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    await flush()
    for (let round = 0; round < 10; round++) {
      timers.runIntervals()
      await flush()
    }
    // 已进入慢速（第 10 个 delay 为 15s）
    expect(timers.delays()[9]).toBe(15000)
    const slowPhaseCalls = vi.mocked(api.getCurrent).mock.calls.length

    // 机场切换：epoch+1 清零 miss 计数并立即补一轮快查
    contextListener?.({ ...contextState('project-1'), gatewaySn: 'dock-2' })
    await flush()
    expect(api.getCurrent).toHaveBeenLastCalledWith('dock-2')
    expect(vi.mocked(api.getCurrent).mock.calls.length).toBe(slowPhaseCalls + 1)
    expect(timers.delays()[11]).toBe(2000)
    await runtime.dispose()
  })

  it('当前会话已激活的任务进入失败终态时保留回顾状态', async () => {
    const timers = createTimers()
    const taskStore = createTaskStore()
    const failed = {
      ...activeSnapshot('task-1', 2),
      phase: 'failed' as const,
      completion_reason: 'return_home_failed',
      return_home_state: 'failed',
    }
    const api = createApi({
      getTask: vi.fn()
        .mockResolvedValueOnce(activeSnapshot('task-1'))
        .mockResolvedValueOnce(failed),
    })
    const onTaskActivated = vi.fn(async () => {})
    const runtime = createPatrolRuntime({
      api,
      timers,
      taskState: taskStore,
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      flightTask: {
        getState: async () => flightState('task-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated,
      onError: vi.fn(),
    })
    await runtime.start()
    await flush()
    expect(taskStore.current.phase).toBe('phase1')

    timers.runIntervals()
    await flush()

    expect(taskStore.current).toMatchObject({
      taskUuid: 'task-1',
      phase: 'failed',
      completionReason: 'return_home_failed',
      returnHomeState: 'failed',
    })
    expect(onTaskActivated).toHaveBeenCalledTimes(1)
    await runtime.dispose()
  })

  it('任务切换后丢弃上一任务迟到的 HTTP 快照', async () => {
    const taskStore = createTaskStore()
    let arrive: ((taskUuid: string, startedAtMs: number) => void) | undefined
    let resolveFirst: ((snapshot: PatrolTaskSnapshot) => void) | undefined
    const getTask = vi.fn((taskUuid: string) => {
      if (taskUuid === 'task-1') {
        return new Promise<PatrolTaskSnapshot>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve(activeSnapshot(taskUuid, 2))
    })
    const runtime = createPatrolRuntime({
      api: createApi({ getTask }),
      timers: createTimers(),
      taskState: taskStore,
      context: null,
      flightTask: null,
      mockEvents: {
        onTaskArrived (listener) {
          arrive = listener
          return () => {}
        },
        onWsMessage: () => () => {},
        onFlightTaskProgress: () => () => {},
      },
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()

    arrive?.('task-1', 0)
    await flush()
    arrive?.('task-2', 0)
    resolveFirst?.(activeSnapshot('task-1', 99))
    await flush()

    expect(taskStore.current.taskUuid).toBe('task-2')
    expect(taskStore.current.stateRevision).not.toBe(99)
    await runtime.dispose()
  })

  it('同任务 WS 推进后丢弃更早请求返回的非 active 快照', async () => {
    const taskStore = createTaskStore()
    let arrive: ((taskUuid: string, startedAtMs: number) => void) | undefined
    let receiveWsMessage: ((message: PatrolWsMessage) => void) | undefined
    let resolveTask: ((snapshot: PatrolTaskSnapshot) => void) | undefined
    const runtime = createPatrolRuntime({
      api: createApi({
        getTask: vi.fn(() => new Promise<PatrolTaskSnapshot>((resolve) => {
          resolveTask = resolve
        })),
      }),
      timers: createTimers(),
      taskState: taskStore,
      context: null,
      flightTask: null,
      mockEvents: {
        onTaskArrived (listener) {
          arrive = listener
          return () => {}
        },
        onWsMessage (listener) {
          receiveWsMessage = listener
          return () => {}
        },
        onFlightTaskProgress: () => () => {},
      },
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    arrive?.('task-1', 0)
    await flush()

    receiveWsMessage?.({ kind: 'progress', taskUuid: 'task-1', stateRevision: 2, phase: 'phase2' })
    resolveTask?.({ link_state: 'rejected', task_uuid: 'task-1', reject_reason: 'temporary' })
    await flush()

    expect(taskStore.current).toMatchObject({ taskUuid: 'task-1', phase: 'phase2', linkState: 'waiting' })
    await runtime.dispose()
  })

  it('路段查询失败后不随状态更新重试，新路段仍可查询', async () => {
    const taskStore = createTaskStore()
    const getWaylineInfo = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue({ name: '福华路南段', waypointCount: 12 })
    const runtime = createPatrolRuntime({
      api: createApi({ getWaylineInfo }),
      timers: createTimers(),
      taskState: taskStore,
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      flightTask: null,
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    taskStore.update(state => ({ ...state, taskUuid: 'task-1', waylineUuid: 'wayline-1' }))
    await flush()

    taskStore.update(state => ({ ...state }))
    await flush()
    expect(getWaylineInfo).toHaveBeenCalledTimes(1)

    taskStore.update(state => ({ ...state, waylineUuid: 'wayline-2' }))
    await flush()
    expect(getWaylineInfo).toHaveBeenCalledTimes(2)
    expect(taskStore.current.routeName).toBe('福华路南段')
    await runtime.dispose()
  })

  it('dispose 后不应用迟到的任务识别结果', async () => {
    const taskStore = createTaskStore()
    let resolveDetail: ((value: FlightTaskDetail) => void) | undefined
    const api = createApi({
      getFlightTaskDetail: vi.fn(() => new Promise<FlightTaskDetail | null>((resolve) => {
        resolveDetail = resolve
      })),
    })
    const runtime = createPatrolRuntime({
      api,
      timers: createTimers(),
      taskState: taskStore,
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      flightTask: {
        getState: async () => flightState('task-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    await runtime.dispose()

    resolveDetail?.({ uuid: 'task-1', biz_ext: { 'es-patrol': {} }, begin_at_ms: 0 })
    await flush()

    expect(taskStore.current.taskUuid).toBe('')
  })

  it('任务识别最多尝试三次，显式刷新后才重新开始', async () => {
    const timers = createTimers()
    const getFlightTaskDetail = vi.fn(async () => {
      throw new Error('not found')
    })
    const runtime = createPatrolRuntime({
      api: createApi({ getFlightTaskDetail }),
      timers,
      taskState: createTaskStore(),
      context: {
        getState: async () => contextState('project-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      flightTask: {
        getState: async () => flightState('task-1'),
        onStateChanged: async () => ({ dispose: vi.fn() }),
      },
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    await flush()

    timers.runIntervals()
    await flush()
    timers.runIntervals()
    await flush()
    timers.runIntervals()
    await flush()
    expect(getFlightTaskDetail).toHaveBeenCalledTimes(3)
    expect(timers.activeTimerCount()).toBe(0)

    runtime.refresh()
    await flush()
    expect(getFlightTaskDetail).toHaveBeenCalledTimes(4)
    await runtime.dispose()
  })

  it('在途轮询期间的 refresh 会在请求完成后补执行', async () => {
    const taskStore = createTaskStore()
    let arrive: ((taskUuid: string, startedAtMs: number) => void) | undefined
    let resolveFirst: ((snapshot: PatrolTaskSnapshot) => void) | undefined
    const getTask = vi.fn()
      .mockImplementationOnce(() => new Promise<PatrolTaskSnapshot>((resolve) => {
        resolveFirst = resolve
      }))
      .mockResolvedValue(activeSnapshot('task-1', 2))
    const runtime = createPatrolRuntime({
      api: createApi({ getTask }),
      timers: createTimers(),
      taskState: taskStore,
      context: null,
      flightTask: null,
      mockEvents: {
        onTaskArrived (listener) {
          arrive = listener
          return () => {}
        },
        onWsMessage: () => () => {},
        onFlightTaskProgress: () => () => {},
      },
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    arrive?.('task-1', 0)
    await flush()
    expect(getTask).toHaveBeenCalledTimes(1)

    runtime.refresh()
    resolveFirst?.(activeSnapshot('task-1'))
    await flush()

    expect(getTask).toHaveBeenCalledTimes(2)
    await runtime.dispose()
  })

  it('旧任务挂起请求不阻塞新任务轮询', async () => {
    const taskStore = createTaskStore()
    let arrive: ((taskUuid: string, startedAtMs: number) => void) | undefined
    const getTask = vi.fn((taskUuid: string) => taskUuid === 'task-1'
      ? new Promise<PatrolTaskSnapshot>(() => {})
      : Promise.resolve(activeSnapshot(taskUuid)))
    const runtime = createPatrolRuntime({
      api: createApi({ getTask }),
      timers: createTimers(),
      taskState: taskStore,
      context: null,
      flightTask: null,
      mockEvents: {
        onTaskArrived (listener) {
          arrive = listener
          return () => {}
        },
        onWsMessage: () => () => {},
        onFlightTaskProgress: () => () => {},
      },
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    arrive?.('task-1', 0)
    await flush()
    arrive?.('task-2', 0)
    await flush()

    expect(getTask).toHaveBeenCalledWith('task-1')
    expect(getTask).toHaveBeenCalledWith('task-2')
    expect(taskStore.current.taskUuid).toBe('task-2')
    await runtime.dispose()
  })

  it('启动失败时回滚已经取得的订阅，dispose 保持幂等', async () => {
    const taskStore = createTaskStore()
    const disposeContext = vi.fn()
    const runtime = createPatrolRuntime({
      api: createApi(),
      timers: createTimers(),
      taskState: taskStore,
      context: {
        getState: async () => {
          throw new Error('context unavailable')
        },
        onStateChanged: async () => ({ dispose: disposeContext }),
      },
      flightTask: null,
      mockEvents: null,
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })

    await expect(runtime.start()).rejects.toThrow('context unavailable')
    await runtime.dispose()
    await runtime.dispose()

    expect(disposeContext).toHaveBeenCalledTimes(1)
    expect(taskStore.listenerCount()).toBe(0)
  })

  it('dispose 清除本次会话保留的任务数据和 panel 状态', async () => {
    const taskStore = createTaskStore()
    let arrive: ((taskUuid: string, startedAtMs: number) => void) | undefined
    const runtime = createPatrolRuntime({
      api: createApi(),
      timers: createTimers(),
      taskState: taskStore,
      context: null,
      flightTask: null,
      mockEvents: {
        onTaskArrived (listener) {
          arrive = listener
          return () => {}
        },
        onWsMessage: () => () => {},
        onFlightTaskProgress: () => () => {},
      },
      subscribeWs: null,
      onTaskActivated: vi.fn(async () => {}),
      onError: vi.fn(),
    })
    await runtime.start()
    arrive?.('task-1', 0)
    await flush()
    expect(taskStore.current.taskUuid).toBe('task-1')

    await runtime.dispose()
    expect(taskStore.current).toEqual(createInitialPatrolState())
  })
})
