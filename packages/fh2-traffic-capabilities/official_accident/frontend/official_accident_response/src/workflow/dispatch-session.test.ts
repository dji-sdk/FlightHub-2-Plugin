// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { AccidentWorkflowApi } from '../api/workflow-api'
import type { DispatchCardState } from '../views/dispatch-card/contract'
import { createDispatchSession } from './dispatch-session'
import type { DispatchRequest, DispatchRoute } from './types'

function popup (): DispatchRequest {
  return {
    popupId: 'popup-001',
    receivedAt: 1_700_000_000_000,
    projectId: 'project-1',
    organizationId: 'organization-1',
    pluginEventId: 'JQ-001',
    title: '测试事故',
    alarmPosition: { lat: 22.55, lng: 113.95, height: 0 },
    flightHeight: 120,
    originParams: {},
    level: 1,
    address: '',
    description: '',
    waitTime: 0,
  }
}

const devices = [{
  dockSn: 'dock-1',
  droneSn: 'drone-1',
  gatewaySn: 'dock-1',
  droneCallsign: '应急无人机',
  dockCallsign: '福田一号机场',
  droneModelName: 'M4D',
  dockModelName: 'Dock 3',
  startPosition: {
    lat: 22.1,
    lng: 113.9,
    height: 20,
  },
  takeoffReferenceAltitude: 10,
  idle: true,
  executingTask: false,
}]

const executingDevices = [{ ...devices[0]!, executingTask: true }]

const routes: readonly DispatchRoute[] = [{
  id: 'wayline/project-1/route-a.kmz',
  source: 'navinfo',
  label: '推荐路线',
  totalDistance: 1000,
  estimatedDuration: 100,
  waypointCount: 2,
  wpmzKey: 'wayline/project-1/route-a.kmz',
  wpmzUrl: 'http://minio.example.com/wayline/project-1/route-a.kmz',
  warnings: [],
  coordinates: [{ lat: 22.1, lng: 113.9, height: 10 }, { lat: 22.55, lng: 113.95, height: 60 }],
}]

function initialState (): DispatchCardState {
  return {
    popupId: '',
    pluginEventId: '',
    title: '事故快处',
    receivedAt: 0,
    enableMultiAngle: false,
    status: 'idle',
    projectId: '',
    organizationId: '',
    alarmPosition: null,
    requiresRoute: true,
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

function workflow (selectRoute: AccidentWorkflowApi['selectRoute']): AccidentWorkflowApi {
  return {
    getStatus: vi.fn(),
    acknowledge: vi.fn(),
    selectRoute,
    ignore: vi.fn(),
  }
}

function routePlanning (register?: ReturnType<typeof vi.fn>) {
  return {
    plan: vi.fn(async () => routes),
    register: register ?? vi.fn(async () => 'uuid-a'),
  }
}

describe('accident dispatch flow', () => {
  it('刷新设备和切换路线保留本地路线状态，不发送 route_selected', async () => {
    let state = initialState()
    const selectRouteSignal = vi.fn(async () => {})
    const show = vi.fn(async () => {})
    const flow = createDispatchSession({
      devices: { list: async () => devices },
      workflow: workflow(selectRouteSignal),
      routePlanning: routePlanning(),
      routePreview: { show, clear: async () => {} },
      getState: () => state,
      setState: (next) => {
        state = next
      },
      publishFlow: () => {},
      navigate: async () => {},
      enableMultiAngle: false,
    })

    await flow.open(popup())
    await flow.selectDevice('dock-1')
    await flow.refreshDevices()
    await flow.selectRoute(0)

    expect(state.selectedDockSn).toBe('dock-1')
    expect(state.selectedRouteIndex).toBe(0)
    expect(show).toHaveBeenCalled()
    expect(selectRouteSignal).not.toHaveBeenCalled()
  })

  it('执行中设备不能选择且不触发路线规划', async () => {
    let state = initialState()
    const plan = vi.fn(async () => routes)
    const flow = createDispatchSession({
      devices: { list: async () => executingDevices },
      workflow: workflow(vi.fn()),
      routePlanning: { plan, register: vi.fn(async () => 'uuid-a') },
      routePreview: { show: async () => {}, clear: async () => {} },
      getState: () => state,
      setState: (next) => {
        state = next
      },
      publishFlow: () => {},
      navigate: async () => {},
      enableMultiAngle: false,
    })

    await flow.open(popup())
    await expect(flow.selectDevice('dock-1')).rejects.toThrow('设备正在执行任务，无法选择')
    expect(state).toMatchObject({ selectedDockSn: '', routes: [], selectedRouteIndex: -1 })
    expect(plan).not.toHaveBeenCalled()
  })

  it('刷新后选中设备变为执行中时清空选择、路线和预览', async () => {
    let state = initialState()
    const list = vi.fn()
      .mockResolvedValueOnce(devices)
      .mockResolvedValueOnce(executingDevices)
    const clear = vi.fn(async () => {})
    const flow = createDispatchSession({
      devices: { list },
      workflow: workflow(vi.fn()),
      routePlanning: routePlanning(),
      routePreview: { show: async () => {}, clear },
      getState: () => state,
      setState: (next) => {
        state = next
      },
      publishFlow: () => {},
      navigate: async () => {},
      enableMultiAngle: false,
    })

    await flow.open(popup())
    await flow.selectDevice('dock-1')
    clear.mockClear()
    await flow.refreshDevices()

    expect(state.devices).toEqual(executingDevices)
    expect(state).toMatchObject({ selectedDockSn: '', routes: [], selectedRouteIndex: -1 })
    expect(clear).toHaveBeenCalledWith('message:popup-001')
  })

  it('刷新路线按当前选中设备重新规划并重置选中路线', async () => {
    let state = initialState()
    const plan = vi.fn(async () => routes)
    const selectRouteSignal = vi.fn(async () => {})
    const show = vi.fn(async () => {})
    const flow = createDispatchSession({
      devices: { list: async () => devices },
      workflow: workflow(selectRouteSignal),
      routePlanning: { plan, register: vi.fn(async () => 'uuid-a') },
      routePreview: { show, clear: async () => {} },
      getState: () => state,
      setState: (next) => {
        state = next
      },
      publishFlow: () => {},
      navigate: async () => {},
      enableMultiAngle: false,
    })

    await flow.open(popup())
    await flow.selectDevice('dock-1')
    await flow.selectRoute(0)
    await flow.refreshRoutes()

    expect(plan).toHaveBeenCalledTimes(2)
    expect(plan).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: 'project-1',
      startPosition: devices[0]!.startPosition,
      destinationPosition: popup().alarmPosition,
      endGimbalPitch: -90,
    }))
    expect(state.selectedDockSn).toBe('dock-1')
    expect(state.routes).toEqual(routes)
    expect(state.selectedRouteIndex).toBe(0)
    expect(state.error).toBeNull()
    expect(show).toHaveBeenCalledTimes(3)
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({
      routes,
      selectedIndex: 0,
    }))
    expect(selectRouteSignal).not.toHaveBeenCalled()
  })

  it('未选择设备时刷新路线被拒绝且不触发规划', async () => {
    let state = initialState()
    const plan = vi.fn(async () => routes)
    const flow = createDispatchSession({
      devices: { list: async () => devices },
      workflow: workflow(vi.fn(async () => {})),
      routePlanning: { plan, register: vi.fn(async () => 'uuid-a') },
      routePreview: { show: async () => {}, clear: async () => {} },
      getState: () => state,
      setState: (next) => {
        state = next
      },
      publishFlow: () => {},
      navigate: async () => {},
      enableMultiAngle: false,
    })

    await flow.open(popup())
    await expect(flow.refreshRoutes()).rejects.toThrow('请先选择派遣设备')
    expect(plan).not.toHaveBeenCalled()
  })

  it('点击立即派遣才发送完整 route_selected 并进入驾驶舱', async () => {
    let state = initialState()
    const selectRouteSignal = vi.fn(async () => {})
    const navigate = vi.fn(async () => {})
    const register = vi.fn(async () => 'uuid-a')
    const flow = createDispatchSession({
      devices: { list: async () => devices },
      workflow: workflow(selectRouteSignal),
      routePlanning: routePlanning(register),
      routePreview: { show: async () => {}, clear: async () => {} },
      getState: () => state,
      setState: (next) => {
        state = next
      },
      publishFlow: () => {},
      navigate,
      enableMultiAngle: false,
    })

    await flow.open(popup())
    await flow.selectDevice('dock-1')
    await flow.dispatch()

    expect(register).toHaveBeenCalledOnce()
    expect(register).toHaveBeenCalledWith('project-1', {
      wpmzKey: 'wayline/project-1/route-a.kmz',
      name: expect.stringMatching(/^事故快处-测试事故-\d{6}$/),
    })
    expect(selectRouteSignal).toHaveBeenCalledOnce()
    expect(selectRouteSignal).toHaveBeenCalledWith('JQ-001', {
      projectUuid: 'project-1',
      dockSn: 'dock-1',
      waylineUuid: 'uuid-a',
    })
    expect(state.status).toBe('dispatched')
    expect(navigate).toHaveBeenCalledWith(
      '/organization/organization-1/project/project-1?droneSn=drone-1&gatewaySn=dock-1&pluginEventId=JQ-001#/cockpit',
      { target: 'blank' },
    )
  })

  it('派遣已提交后导航失败不回滚业务状态', async () => {
    let state = initialState()
    const onNavigationError = vi.fn()
    const flow = createDispatchSession({
      devices: { list: async () => devices },
      workflow: workflow(vi.fn(async () => {})),
      routePlanning: routePlanning(),
      routePreview: { show: async () => {}, clear: async () => {} },
      getState: () => state,
      setState: (next) => {
        state = next
      },
      publishFlow: () => {},
      navigate: async () => {
        throw new Error('页面打开失败')
      },
      onNavigationError,
      enableMultiAngle: false,
    })

    await flow.open(popup())
    await flow.selectDevice('dock-1')

    await expect(flow.dispatch()).resolves.toEqual({ accepted: true })
    expect(state).toMatchObject({ status: 'dispatched', dispatching: false, error: null })
    expect(onNavigationError).toHaveBeenCalledWith(expect.objectContaining({ message: '页面打开失败' }))
  })

  it('设备或路线未选择时派遣被拒绝且不发信号', async () => {
    let state = initialState()
    const selectRouteSignal = vi.fn(async () => {})
    const navigate = vi.fn(async () => {})
    const flow = createDispatchSession({
      devices: { list: async () => devices },
      workflow: workflow(selectRouteSignal),
      routePlanning: routePlanning(),
      routePreview: { show: async () => {}, clear: async () => {} },
      getState: () => state,
      setState: (next) => {
        state = next
      },
      publishFlow: () => {},
      navigate,
      enableMultiAngle: false,
    })

    await flow.open(popup())

    // open 后设备默认不选，直接派遣被拒绝。
    await expect(flow.dispatch()).rejects.toThrow('请先选择派遣设备与路线')
    expect(selectRouteSignal).not.toHaveBeenCalled()
    expect(state).toMatchObject({ status: 'pending', error: '请先选择派遣设备与路线' })

    // 只选设备未选路线（路线规划失败置空）同样被拒绝。
    state = { ...state, selectedDockSn: 'dock-1', routes: [], selectedRouteIndex: -1, error: null }
    await expect(flow.dispatch()).rejects.toThrow('请先选择派遣设备与路线')
    expect(selectRouteSignal).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('派遣前设备变为执行中时清理失效选择且不提交', async () => {
    let state = initialState()
    const list = vi.fn()
      .mockResolvedValueOnce(devices)
      .mockResolvedValueOnce(executingDevices)
    const selectRouteSignal = vi.fn(async () => {})
    const register = vi.fn(async () => 'uuid-a')
    const clear = vi.fn(async () => {})
    const flow = createDispatchSession({
      devices: { list },
      workflow: workflow(selectRouteSignal),
      routePlanning: routePlanning(register),
      routePreview: { show: async () => {}, clear },
      getState: () => state,
      setState: (next) => {
        state = next
      },
      publishFlow: () => {},
      navigate: async () => {},
      enableMultiAngle: false,
    })

    await flow.open(popup())
    await flow.selectDevice('dock-1')
    clear.mockClear()
    await expect(flow.dispatch()).rejects.toThrow('设备正在执行任务，请重新选择')

    expect(state).toMatchObject({
      status: 'pending',
      selectedDockSn: '',
      routes: [],
      selectedRouteIndex: -1,
      error: '设备正在执行任务，请重新选择',
    })
    expect(clear).toHaveBeenCalledWith('message:popup-001')
    expect(register).not.toHaveBeenCalled()
    expect(selectRouteSignal).not.toHaveBeenCalled()
  })

  it('设备列表为空时保持空列表且不自动选中', async () => {
    let state = initialState()
    const show = vi.fn(async () => {})
    const flow = createDispatchSession({
      devices: { list: async () => [] },
      workflow: workflow(vi.fn()),
      routePlanning: routePlanning(),
      routePreview: { show, clear: async () => {} },
      getState: () => state,
      setState: (next) => {
        state = next
      },
      publishFlow: () => {},
      navigate: async () => {},
      enableMultiAngle: false,
    })

    await flow.open(popup())

    expect(state.devices).toEqual([])
    expect(state.selectedDockSn).toBe('')
    expect(state.routes).toEqual([])
    expect(show).not.toHaveBeenCalled()
  })

  it('信号失败时保留选择并允许重试', async () => {
    let state = initialState()
    let attempt = 0
    const selectRouteSignal = vi.fn(async () => {
      attempt++
      if (attempt === 1) throw new Error('signal failed')
    })
    const register = vi.fn(async () => 'uuid-a')
    const flow = createDispatchSession({
      devices: { list: async () => devices },
      workflow: workflow(selectRouteSignal),
      routePlanning: { plan: vi.fn(async () => routes), register },
      routePreview: { show: async () => {}, clear: async () => {} },
      getState: () => state,
      setState: (next) => {
        state = next
      },
      publishFlow: () => {},
      navigate: async () => {},
      enableMultiAngle: false,
    })

    await flow.open(popup())
    await flow.selectDevice('dock-1')
    await expect(flow.dispatch()).rejects.toThrow('signal failed')

    expect(state).toMatchObject({
      status: 'pending',
      selectedDockSn: 'dock-1',
      selectedRouteIndex: 0,
      error: 'signal failed',
    })

    await expect(flow.dispatch()).resolves.toEqual({ accepted: true })
    expect(selectRouteSignal).toHaveBeenCalledTimes(2)
    // 注册 uuid 已回写路线，重试只重发信号，不重复入库。
    expect(register).toHaveBeenCalledOnce()
    expect(selectRouteSignal).toHaveBeenNthCalledWith(2, 'JQ-001', expect.objectContaining({ projectUuid: 'project-1', waylineUuid: 'uuid-a' }))
    expect(state).toMatchObject({ status: 'dispatched', dispatching: false, error: null })
  })

  it('派遣注册期间新警情到达时不串单发送旧信号', async () => {
    let state = initialState()
    const selectRouteSignal = vi.fn(async () => {})
    let resolveRegister!: (uuid: string) => void
    const register = vi.fn(() => new Promise<string>((resolve) => {
      resolveRegister = resolve
    }))
    const flow = createDispatchSession({
      devices: { list: async () => devices },
      workflow: workflow(selectRouteSignal),
      routePlanning: { plan: vi.fn(async () => routes), register },
      routePreview: { show: async () => {}, clear: async () => {} },
      getState: () => state,
      setState: (next) => {
        state = next
      },
      publishFlow: () => {},
      navigate: async () => {},
      enableMultiAngle: false,
    })

    await flow.open(popup())
    await flow.selectDevice('dock-1')
    const dispatchPromise = flow.dispatch()
    await vi.waitFor(() => expect(register).toHaveBeenCalledOnce())
    await flow.open({ ...popup(), pluginEventId: 'JQ-002', popupId: 'popup-002' })
    resolveRegister('uuid-a')
    await expect(dispatchPromise).resolves.toEqual({ accepted: false })

    expect(selectRouteSignal).not.toHaveBeenCalled()
    expect(register).toHaveBeenCalledOnce()
    expect(state).toMatchObject({ status: 'pending', popupId: 'popup-002', pluginEventId: 'JQ-002', error: null })
  })

  it('地图预览失败不清空已规划路线', async () => {
    let state = initialState()
    const plan = vi.fn(async () => routes)
    const flow = createDispatchSession({
      devices: { list: async () => devices },
      workflow: workflow(vi.fn()),
      routePlanning: { plan, register: vi.fn(async () => 'uuid-a') },
      routePreview: {
        show: async () => {
          throw new Error('mapAppState Not Found')
        },
        clear: async () => {},
      },
      getState: () => state,
      setState: (next) => {
        state = next
      },
      publishFlow: () => {},
      navigate: async () => {},
      enableMultiAngle: false,
    })

    await flow.open(popup())
    await flow.selectDevice('dock-1')

    expect(state).toMatchObject({
      routes,
      selectedRouteIndex: 0,
      loadingRoutes: false,
      error: null,
    })
    await expect(flow.dispatch()).resolves.toEqual({ accepted: true })
  })

  it('plan 已回填 wayline_uuid 时派遣不再注册', async () => {
    let state = initialState()
    const selectRouteSignal = vi.fn(async () => {})
    const register = vi.fn(async () => 'uuid-a')
    const flow = createDispatchSession({
      devices: { list: async () => devices },
      workflow: workflow(selectRouteSignal),
      routePlanning: {
        plan: vi.fn(async () => [{ ...routes[0]!, waylineUuid: 'uuid-plan' }]),
        register,
      },
      routePreview: { show: async () => {}, clear: async () => {} },
      getState: () => state,
      setState: (next) => {
        state = next
      },
      publishFlow: () => {},
      navigate: async () => {},
      enableMultiAngle: false,
    })

    await flow.open(popup())
    await flow.selectDevice('dock-1')
    await flow.dispatch()

    expect(register).not.toHaveBeenCalled()
    expect(selectRouteSignal).toHaveBeenCalledWith('JQ-001', expect.objectContaining({ waylineUuid: 'uuid-plan' }))
  })

  it('注册重名时自动加后缀重试一次', async () => {
    let state = initialState()
    const selectRouteSignal = vi.fn(async () => {})
    const names: string[] = []
    const register = vi.fn(async (_alert: unknown, input: { name: string }) => {
      names.push(input.name)
      if (names.length === 1) throw new Error('invalid parameter: wayline: 航线名已存在: name="事故快处-测试事故-123456"')
      return 'uuid-a'
    })
    const flow = createDispatchSession({
      devices: { list: async () => devices },
      workflow: workflow(selectRouteSignal),
      routePlanning: { plan: vi.fn(async () => routes), register },
      routePreview: { show: async () => {}, clear: async () => {} },
      getState: () => state,
      setState: (next) => {
        state = next
      },
      publishFlow: () => {},
      navigate: async () => {},
      enableMultiAngle: false,
    })

    await flow.open(popup())
    await flow.selectDevice('dock-1')
    await flow.dispatch()

    expect(register).toHaveBeenCalledTimes(2)
    expect(names[1]).toBe(`${names[0]}-2`)
    expect(selectRouteSignal).toHaveBeenCalledWith('JQ-001', expect.objectContaining({ waylineUuid: 'uuid-a' }))
  })

  it('注册非重名失败时派遣报错并回到待派遣', async () => {
    let state = initialState()
    const selectRouteSignal = vi.fn(async () => {})
    const register = vi.fn(async () => {
      throw new Error('invalid parameter: wpmz_key 在存储桶中不存在')
    })
    const flow = createDispatchSession({
      devices: { list: async () => devices },
      workflow: workflow(selectRouteSignal),
      routePlanning: { plan: vi.fn(async () => routes), register },
      routePreview: { show: async () => {}, clear: async () => {} },
      getState: () => state,
      setState: (next) => {
        state = next
      },
      publishFlow: () => {},
      navigate: async () => {},
      enableMultiAngle: false,
    })

    await flow.open(popup())
    await flow.selectDevice('dock-1')
    await expect(flow.dispatch()).rejects.toThrow('wpmz_key 在存储桶中不存在')

    expect(selectRouteSignal).not.toHaveBeenCalled()
    expect(state).toMatchObject({
      status: 'pending',
      dispatching: false,
      error: 'invalid parameter: wpmz_key 在存储桶中不存在',
      selectedDockSn: 'dock-1',
      selectedRouteIndex: 0,
    })
  })

  it('存在真实设备时正常加载不注入任何设备', async () => {
    let state = initialState()
    const flow = createDispatchSession({
      devices: { list: async () => devices },
      workflow: workflow(vi.fn()),
      routePlanning: routePlanning(),
      routePreview: { show: async () => {}, clear: async () => {} },
      getState: () => state,
      setState: (next) => {
        state = next
      },
      publishFlow: () => {},
      navigate: async () => {},
      enableMultiAngle: false,
    })

    await flow.open(popup())

    expect(state.devices).toEqual(devices)
  })
})
