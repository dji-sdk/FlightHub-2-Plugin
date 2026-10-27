// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { FlightTaskState, FlightTaskStatus, InFlightWaylineTaskSnapshot, TelemetryState } from 'fh2-plugin-sdk'
import type { DispatchRoute } from '../../workflow/types'
import type { ReturnRoutePanelState } from '../../views/return-route-panel/contract'
import { createReturnRouteController, returnRouteAvailable, returnRouteHeight } from './return-route-controller'
import type { ReturnRouteContext } from './return-route-controller'
import { telemetryState } from './test-telemetry'

const telemetry: TelemetryState = telemetryState({
  drone: {
    ...telemetryState().drone,
    pose: { ...telemetryState().drone.pose!, longitude: 114.1, latitude: 22.6, height: 80 },
  },
  device: { roster: { ...telemetryState().device.roster!, gatewaySn: 'dock-1' } },
  control: {
    flight: { hasControl: true, ownerUserId: null },
    payload: { hasControl: true, ownerUserId: null },
  },
})

const startPosition = { lng: 114.1, lat: 22.6, height: 80 }
const takeoffPoint = { lng: 114, lat: 22.5, height: 12 }

function idleFlightTaskState (): FlightTaskState {
  return { kind: null, flightId: null, wayline: null, inFlightWayline: null }
}

function inFlightTaskState (taskId: string, status: FlightTaskStatus): FlightTaskState {
  return {
    kind: 'in-flight-wayline',
    flightId: null,
    wayline: null,
    inFlightWayline: { taskId, status, progressPercent: 0, taskName: '事故快处-沿路网返航' },
  }
}

function waylineTaskState (taskId: string, status: FlightTaskStatus): FlightTaskState {
  return {
    kind: 'wayline',
    flightId: null,
    wayline: {
      taskId,
      status,
      progressPercent: null,
      waylineUuid: null,
      taskType: null,
      completedWaypointCount: null,
      totalWaypointCount: null,
    },
    inFlightWayline: null,
  }
}

const route: DispatchRoute = {
  id: 'route-1',
  source: 'road',
  label: '推荐路线',
  totalDistance: 1800,
  estimatedDuration: 130,
  waypointCount: 20,
  wpmzKey: 'return.kmz',
  wpmzUrl: 'https://example/return.kmz',
  warnings: [],
  coordinates: [startPosition, takeoffPoint],
}

function setup () {
  let state: ReturnRoutePanelState = { phase: 'idle', routes: [], selectedIndex: -1, error: null }
  let context: ReturnRouteContext = {
    projectId: 'project-1',
    pluginEventId: 'event-1',
    rawPayload: { go_back_alt: 150 },
    telemetry,
  }
  const routePlanning = {
    plan: vi.fn(async () => [route]),
    register: vi.fn(async () => 'wayline-1'),
  }
  const preview = { show: vi.fn(async () => ({ accepted: true })), clear: vi.fn(async () => null) }
  const emergencyStop = vi.fn(async () => {})
  const getInFlightTask = vi.fn(async (): Promise<InFlightWaylineTaskSnapshot | null> => null)
  const startWayline = vi.fn(async () => ({ taskId: 'task-1' }))
  const cancelWayline = vi.fn(async () => {})
  const resetGimbal = vi.fn(async () => {})
  const setPanelVisible = vi.fn(async (_visible: boolean) => {})
  const onChanged = vi.fn()
  const controller = createReturnRouteController({
    routePlanning,
    preview,
    emergencyStop,
    getInFlightTask,
    startWayline,
    cancelWayline,
    resetGimbal,
    getContext: () => context,
    getState: () => state,
    setState: (next) => {
      state = next
    },
    setPanelVisible,
    onChanged,
  })
  return {
    controller,
    routePlanning,
    preview,
    emergencyStop,
    getInFlightTask,
    startWayline,
    cancelWayline,
    resetGimbal,
    setPanelVisible,
    onChanged,
    state: () => state,
    setState: (next: ReturnRoutePanelState) => {
      state = next
    },
    setContext: (next: typeof context) => {
      context = next
    },
    context: () => context,
  }
}

describe('return route controller', () => {
  it('空中且起终点齐全时可用，并读取数字返航高度', () => {
    const context = { projectId: 'p', pluginEventId: 'e', rawPayload: {}, telemetry }
    expect(returnRouteAvailable(context)).toBe(true)
    expect(returnRouteAvailable({ ...context, telemetry: { ...telemetry, dock: { ...telemetry.dock, position: null } } })).toBe(false)
    expect(returnRouteHeight({ go_back_alt: 150 })).toBe(150)
    expect(returnRouteHeight({ go_back_alt: '150' })).toBe(120)
  })

  it('打开先急停，再按返航参数规划、默认选择第一条并预览', async () => {
    const subject = setup()
    await subject.controller.open()
    expect(subject.emergencyStop).toHaveBeenCalledOnce()
    expect(subject.setPanelVisible).toHaveBeenCalledWith(true)
    expect(subject.routePlanning.plan).toHaveBeenCalledWith({
      workspaceId: 'project-1',
      startPosition,
      destinationPosition: takeoffPoint,
      height: 150,
      takeoffReferenceAltitude: 12,
      speed: 14,
      interval: 100,
      finishAction: 'goHome',
    })
    expect(subject.state()).toMatchObject({ phase: 'ready', selectedIndex: 0 })
    expect(subject.preview.show).toHaveBeenCalledWith(expect.objectContaining({
      previewId: 'cockpit:return-route',
      selectedIndex: 0,
      destination: { position: takeoffPoint, kind: 'home' },
    }))
  })

  it('不可返航时打开不会触发急停', async () => {
    const subject = setup()
    subject.setContext({
      ...subject.context(),
      telemetry: { ...telemetry, dock: { ...telemetry.dock, status: { ...telemetry.dock.status!, drone_in_dock: 1 } } },
    })

    await subject.controller.open()

    expect(subject.emergencyStop).not.toHaveBeenCalled()
    expect(subject.state()).toMatchObject({ phase: 'error', error: '当前状态无法沿路网返航' })
  })

  it('执行时入库并启动机上航线，随后关闭预览并复位云台', async () => {
    const subject = setup()
    await subject.controller.open()
    await subject.controller.execute()
    expect(subject.emergencyStop).toHaveBeenCalledTimes(2)
    expect(subject.emergencyStop.mock.invocationCallOrder[1]).toBeLessThan(subject.routePlanning.register.mock.invocationCallOrder[0]!)
    expect(subject.routePlanning.register).toHaveBeenCalledWith('project-1', expect.objectContaining({ wpmzKey: 'return.kmz' }))
    expect(subject.startWayline).toHaveBeenCalledWith({
      waylineUuid: 'wayline-1',
      rthAltitude: 150,
      taskName: '事故快处-沿路网返航',
      waylineDuration: 130,
      waylineLength: 1800,
      finishAction: 'goHome',
    })
    expect(subject.setPanelVisible).toHaveBeenLastCalledWith(false)
    expect(subject.preview.clear).toHaveBeenLastCalledWith({ previewId: 'cockpit:return-route' })
    expect(subject.resetGimbal).toHaveBeenCalledOnce()
    expect(subject.controller.running).toBe(true)
    expect(subject.onChanged).toHaveBeenCalledOnce()
  })

  it('执行前清理活动即时航线任务：急停 → 取消 → 入库 → 启动', async () => {
    const subject = setup()
    subject.getInFlightTask.mockResolvedValue({ taskId: 'outbound-1', status: 'paused', progressPercent: 40, taskName: '去程派遣' })
    await subject.controller.open()
    await subject.controller.execute()

    expect(subject.cancelWayline).toHaveBeenCalledOnce()
    expect(subject.cancelWayline).toHaveBeenCalledWith({ taskId: 'outbound-1', afterCancel: 'hover' })
    expect(subject.emergencyStop.mock.invocationCallOrder[1]!)
      .toBeLessThan(subject.cancelWayline.mock.invocationCallOrder[0]!)
    expect(subject.cancelWayline.mock.invocationCallOrder[0]!)
      .toBeLessThan(subject.routePlanning.register.mock.invocationCallOrder[0]!)
    expect(subject.startWayline).toHaveBeenCalledOnce()
    expect(subject.controller.running).toBe(true)
  })

  it('无活动即时航线任务时不发送取消', async () => {
    const subject = setup()
    await subject.controller.open()
    await subject.controller.execute()

    expect(subject.cancelWayline).not.toHaveBeenCalled()
    expect(subject.startWayline).toHaveBeenCalledOnce()
  })

  it('终态即时航线快照不触发取消', async () => {
    const subject = setup()
    subject.getInFlightTask.mockResolvedValue({ taskId: 'outbound-1', status: 'completed', progressPercent: 100, taskName: '去程派遣' })
    await subject.controller.open()
    await subject.controller.execute()

    expect(subject.cancelWayline).not.toHaveBeenCalled()
    expect(subject.startWayline).toHaveBeenCalledOnce()
  })

  it('清理旧任务失败时终止执行并保留具体错误', async () => {
    const subject = setup()
    subject.getInFlightTask.mockResolvedValue({ taskId: 'outbound-1', status: 'paused', progressPercent: 40, taskName: '去程派遣' })
    subject.cancelWayline.mockRejectedValueOnce(new Error('即时航线任务取消失败，业务码 314001'))
    await subject.controller.open()

    await expect(subject.controller.execute()).rejects.toThrow('即时航线任务取消失败，业务码 314001')

    expect(subject.routePlanning.register).not.toHaveBeenCalled()
    expect(subject.startWayline).not.toHaveBeenCalled()
    expect(subject.state()).toMatchObject({ phase: 'error' })
  })

  it('执行前重新校验事件、项目、遥测和路线归属', async () => {
    const subject = setup()
    await subject.controller.open()
    subject.setContext({ ...subject.context(), pluginEventId: 'event-2' })

    await expect(subject.controller.execute()).rejects.toThrow('返航路线已失效，请重新规划')

    expect(subject.emergencyStop).toHaveBeenCalledOnce()
    expect(subject.routePlanning.register).not.toHaveBeenCalled()
    expect(subject.startWayline).not.toHaveBeenCalled()
  })

  it('执行前拒绝已不可用的最新遥测', async () => {
    const subject = setup()
    await subject.controller.open()
    subject.setContext({
      ...subject.context(),
      telemetry: { ...telemetry, dock: { ...telemetry.dock, status: { ...telemetry.dock.status!, drone_in_dock: 1 } } },
    })

    await expect(subject.controller.execute()).rejects.toThrow('当前状态无法沿路网返航')

    expect(subject.emergencyStop).toHaveBeenCalledOnce()
    expect(subject.startWayline).not.toHaveBeenCalled()
  })

  it('执行前拒绝不属于本次规划结果的路线', async () => {
    const subject = setup()
    await subject.controller.open()
    subject.setState({ ...subject.state(), routes: [{ ...route }] })

    await expect(subject.controller.execute()).rejects.toThrow('返航路线已失效，请重新规划')

    expect(subject.emergencyStop).toHaveBeenCalledOnce()
    expect(subject.startWayline).not.toHaveBeenCalled()
  })

  it('急停期间上下文变化时不会继续入库或启动', async () => {
    const subject = setup()
    await subject.controller.open()
    subject.emergencyStop.mockImplementationOnce(async () => {
      subject.setContext({ ...subject.context(), projectId: 'project-2' })
    })

    await expect(subject.controller.execute()).rejects.toThrow('返航路线已失效，请重新规划')

    expect(subject.routePlanning.register).not.toHaveBeenCalled()
    expect(subject.startWayline).not.toHaveBeenCalled()
  })

  it('航线入库期间上下文变化时不会启动已失效路线', async () => {
    const subject = setup()
    let resolveRegister!: (waylineUuid: string) => void
    subject.routePlanning.register.mockImplementation(() => new Promise((resolve) => {
      resolveRegister = resolve
    }))
    await subject.controller.open()
    const executing = subject.controller.execute()
    await vi.waitFor(() => expect(subject.routePlanning.register).toHaveBeenCalledOnce())

    subject.setContext({
      ...subject.context(),
      telemetry: { ...telemetry, device: { roster: { ...telemetry.device.roster!, gatewaySn: 'dock-2' } } },
    })
    resolveRegister('wayline-1')

    await expect(executing).rejects.toThrow('返航路线已失效，请重新规划')
    expect(subject.startWayline).not.toHaveBeenCalled()
  })

  it.each(['completed', 'cancelled', 'failed'] as const)('启动响应前到达的匹配 %s 终态在登记 taskId 后立即结束运行态', async (status) => {
    const subject = setup()
    let resolveStart!: (result: { taskId: string }) => void
    subject.startWayline.mockImplementation(() => new Promise((resolve) => {
      resolveStart = resolve
    }))
    subject.controller.handleTaskState(idleFlightTaskState())
    expect(subject.onChanged).not.toHaveBeenCalled()
    await subject.controller.open()
    const executing = subject.controller.execute()
    await vi.waitFor(() => expect(subject.startWayline).toHaveBeenCalledOnce())

    subject.controller.handleTaskState(inFlightTaskState('task-fast', status))
    expect(subject.onChanged).not.toHaveBeenCalled()
    subject.controller.handleTaskState(idleFlightTaskState())
    resolveStart({ taskId: 'task-fast' })
    await executing

    expect(subject.controller.running).toBe(false)
    expect(subject.onChanged).toHaveBeenCalledOnce()
  })

  it('启动请求成功后即使面板已关闭仍登记任务并通知状态变化', async () => {
    const subject = setup()
    let resolveStart!: (result: { taskId: string }) => void
    subject.startWayline.mockImplementation(() => new Promise((resolve) => {
      resolveStart = resolve
    }))
    await subject.controller.open()
    const executing = subject.controller.execute()
    await vi.waitFor(() => expect(subject.startWayline).toHaveBeenCalledOnce())

    await subject.controller.close()
    resolveStart({ taskId: 'task-after-close' })
    await executing

    expect(subject.controller.running).toBe(true)
    expect(subject.onChanged).toHaveBeenCalledOnce()
  })

  it('启动请求成功后即使 controller 已 dispose 仍登记任务并通知状态变化', async () => {
    const subject = setup()
    let resolveStart!: (result: { taskId: string }) => void
    subject.startWayline.mockImplementation(() => new Promise((resolve) => {
      resolveStart = resolve
    }))
    await subject.controller.open()
    const executing = subject.controller.execute()
    await vi.waitFor(() => expect(subject.startWayline).toHaveBeenCalledOnce())

    await subject.controller.dispose()
    resolveStart({ taskId: 'task-after-dispose' })
    await executing

    expect(subject.controller.running).toBe(true)
    expect(subject.cancelWayline).not.toHaveBeenCalled()
    expect(subject.onChanged).toHaveBeenCalledOnce()
  })

  it('宿主空态不误清未观察的任务，观察到本任务后通道消失才清理运行态', async () => {
    const subject = setup()
    await subject.controller.open()
    await subject.controller.execute()
    subject.onChanged.mockClear()

    // 启动响应后、WS 尚未上报：空态与其他普通任务状态都不清理
    subject.controller.handleTaskState(idleFlightTaskState())
    subject.controller.handleTaskState(waylineTaskState('patrol-task', 'running'))
    expect(subject.controller.running).toBe(true)
    expect(subject.onChanged).not.toHaveBeenCalled()

    // 观察到本任务运行
    subject.controller.handleTaskState(inFlightTaskState('task-1', 'running'))
    expect(subject.controller.running).toBe(true)

    // 通道消失 → 清理运行态
    subject.controller.handleTaskState(idleFlightTaskState())
    expect(subject.controller.running).toBe(false)
    expect(subject.onChanged).toHaveBeenCalledOnce()
  })

  it.each(['completed', 'cancelled', 'failed'] as const)('即时航线 %s 终态清理运行态', async (status) => {
    const subject = setup()
    await subject.controller.open()
    await subject.controller.execute()
    subject.onChanged.mockClear()

    subject.controller.handleTaskState(inFlightTaskState('task-1', status))

    expect(subject.controller.running).toBe(false)
    expect(subject.onChanged).toHaveBeenCalledOnce()
  })

  it('普通 wayline 任务的运行与终态都不影响事故返航运行态', async () => {
    const subject = setup()
    await subject.controller.open()
    await subject.controller.execute()
    subject.onChanged.mockClear()

    // 未观察到本任务前：纯 wayline 状态（即时航线通道为空）不清理
    subject.controller.handleTaskState(waylineTaskState('patrol-task', 'running'))
    expect(subject.controller.running).toBe(true)
    subject.controller.handleTaskState(waylineTaskState('patrol-task', 'completed'))
    expect(subject.controller.running).toBe(true)

    // 观察到本任务后：双通道并存，wayline 的运行与终态都不影响
    subject.controller.handleTaskState(inFlightTaskState('task-1', 'running'))
    subject.controller.handleTaskState({
      kind: 'in-flight-wayline',
      flightId: 'flight-1',
      wayline: { ...waylineTaskState('patrol-task', 'running').wayline! },
      inFlightWayline: { taskId: 'task-1', status: 'running', progressPercent: 40, taskName: '事故快处-沿路网返航' },
    })
    expect(subject.controller.running).toBe(true)
    subject.controller.handleTaskState({
      kind: 'in-flight-wayline',
      flightId: 'flight-1',
      wayline: { ...waylineTaskState('patrol-task', 'completed').wayline! },
      inFlightWayline: { taskId: 'task-1', status: 'running', progressPercent: 60, taskName: '事故快处-沿路网返航' },
    })
    expect(subject.controller.running).toBe(true)
    expect(subject.onChanged).not.toHaveBeenCalled()
    await subject.controller.dispose()
  })

  it('运行时取消任务后悬停，且重复打开不会并发规划', async () => {
    const subject = setup()
    let release!: () => void
    subject.emergencyStop.mockImplementation(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    const first = subject.controller.open()
    const second = subject.controller.open()
    expect(subject.emergencyStop).toHaveBeenCalledOnce()
    release()
    await Promise.all([first, second])
    subject.emergencyStop.mockImplementation(async () => {})
    await subject.controller.execute()
    await subject.controller.cancel()
    expect(subject.cancelWayline).toHaveBeenCalledWith({ taskId: 'task-1', afterCancel: 'hover' })
    expect(subject.controller.running).toBe(false)
  })

  it('刷新期间保留旧路线，成功后整体替换并重置选中', async () => {
    const subject = setup()
    await subject.controller.open()
    expect(subject.state().routes).toHaveLength(1)

    let resolvePlan!: (routes: DispatchRoute[]) => void
    subject.routePlanning.plan.mockImplementationOnce(() => new Promise<DispatchRoute[]>((resolve) => {
      resolvePlan = resolve
    }))
    const refreshing = subject.controller.refresh()
    await vi.waitFor(() => expect(subject.routePlanning.plan).toHaveBeenCalledTimes(2))
    expect(subject.state()).toMatchObject({ phase: 'loading' })
    expect(subject.state().routes).toHaveLength(1)

    const nextRoute = { ...route, id: 'route-2', label: '第二路线' }
    resolvePlan([nextRoute])
    await refreshing

    expect(subject.state()).toMatchObject({ phase: 'ready', selectedIndex: 0, error: null })
    expect(subject.state().routes).toEqual([nextRoute])
  })

  it('刷新失败清空旧路线并写入错误', async () => {
    const subject = setup()
    await subject.controller.open()
    subject.routePlanning.plan.mockRejectedValueOnce(new Error('路网服务异常'))

    await subject.controller.refresh()

    expect(subject.state()).toMatchObject({ phase: 'error', error: '路网服务异常', routes: [], selectedIndex: -1 })
  })

  it('取消失败时保留运行态并向用户抛出友好错误', async () => {
    const subject = setup()
    await subject.controller.open()
    await subject.controller.execute()
    subject.cancelWayline.mockRejectedValueOnce(new Error('即时航线任务取消失败，业务码 314001'))

    await expect(subject.controller.cancel()).rejects.toThrow('取消返航失败：即时航线任务取消失败，业务码 314001')

    expect(subject.controller.running).toBe(true)
  })

  it('面板可见前已进入 loading，避免空态闪现', async () => {
    const subject = setup()
    const visiblePhases: ReturnRoutePanelState['phase'][] = []
    subject.setPanelVisible.mockImplementation(async (visible: boolean) => {
      if (visible) visiblePhases.push(subject.state().phase)
    })

    await subject.controller.open()

    expect(visiblePhases).toEqual(['loading'])
  })

  it('register 成功但 startWayline 抛 Error 时保留具体原因并回到 error 态', async () => {
    const subject = setup()
    subject.startWayline.mockRejectedValueOnce(new Error('即时航线任务创建失败：设备当前有任务执行中（code 314001）'))
    await subject.controller.open()

    await expect(subject.controller.execute()).rejects.toThrow('即时航线任务创建失败')
    expect(subject.routePlanning.register).toHaveBeenCalledOnce()
    expect(subject.state()).toMatchObject({ phase: 'error', error: '即时航线任务创建失败：设备当前有任务执行中（code 314001）' })
    expect(subject.controller.running).toBe(false)
  })

  it('规划失败写入面板 Alert 状态且清理预览', async () => {
    const subject = setup()
    subject.routePlanning.plan.mockRejectedValueOnce(new Error('路网服务异常'))
    await subject.controller.open()
    expect(subject.state()).toMatchObject({ phase: 'error', error: '路网服务异常', routes: [] })
    expect(subject.preview.clear).toHaveBeenCalled()
  })
})
