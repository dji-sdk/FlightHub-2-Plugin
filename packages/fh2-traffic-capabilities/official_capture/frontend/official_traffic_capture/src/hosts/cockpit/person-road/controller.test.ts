// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { PluginLogger, TrackedTimers } from 'fh2-plugin-sdk'
import { testTelemetryState } from '../../../shared/test-telemetry'
import type { IllegalRoadApi } from './api'
import { createPersonRoadController } from './controller'
import type { PersonRoadControllerDeps } from './controller'

function harness (status: Partial<Awaited<ReturnType<IllegalRoadApi['getStatus']>>>) {
  const completeStatus: Awaited<ReturnType<IllegalRoadApi['getStatus']>> = {
    isActive: false,
    sessionId: '',
    projectId: 'project-1',
    dockSn: 'dock-1',
    flightId: '',
    startedAt: 0,
    trackingCount: 0,
    openTracking: null,
    ...status,
  }
  const api: IllegalRoadApi = {
    startSession: vi.fn(async input => ({ isActive: true, sessionId: 'session-1', startedAt: 1, resumed: false, ...input })),
    stopSession: vi.fn(async input => ({ sessionId: input.sessionId, stoppedAt: input.endedAt, closedTrackingIds: [] })),
    getStatus: vi.fn(async () => completeStatus),
    startTracking: vi.fn(async input => ({ trackingId: 'tracking-1', sessionId: input.sessionId, startedAt: input.startedAt, matchEndAt: input.startedAt + 30_000, supersededTrackingId: '' })),
    stopTracking: vi.fn(async input => ({ trackingId: input.trackingId, startedAt: 1, endedAt: input.endedAt, closeReason: 'manual' as const, mediaCount: 0 })),
    listTrackings: vi.fn(async () => ({ total: 0, session: null, trackings: [] })),
    listMedia: vi.fn(async () => ({ total: 0, folderId: 0, media: [] })),
  }
  const telemetryState = testTelemetryState()
  const withoutControl = { ...telemetryState, control: { ...telemetryState.control, payload: { ...telemetryState.control.payload, hasControl: false } } }
  const telemetry = { getState: async () => withoutControl, onStateChanged: async () => ({ dispose: () => {} }) }
  const timers: TrackedTimers = { setTimeout: callback => callback, clearTimeout () {}, setInterval: callback => callback, clearInterval () {} }
  const logger: PluginLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const notification = { show: vi.fn(async () => ({ dispose: () => {} })) }
  const deps: PersonRoadControllerDeps = {
    api,
    telemetry: telemetry as unknown as PersonRoadControllerDeps['telemetry'],
    camera: undefined,
    detection: undefined,
    smartTrack: undefined,
    aiConfig: undefined,
    gimbal: undefined,
    sceneGeometry: undefined,
    notification: notification as unknown as PersonRoadControllerDeps['notification'],
    storage: { get: async () => undefined, set: async () => {} },
    blobs: { put: async () => {}, url: async () => undefined },
    ws: { onBizCode: vi.fn(async () => ({ dispose: async () => {} })) },
    timers,
    logger,
    resolveMediaUrl: value => value,
    getProjectId: () => 'project-1',
    getFlightId: () => 'flight-1',
  }
  return { api, deps, notification }
}

describe('person-road controller formal handlers', () => {
  it('dispose waits for a late WS subscription and disposes every acquired handle', async () => {
    const setup = harness({ isActive: false })
    const telemetryDispose = vi.fn(async () => {})
    const wsDispose = vi.fn(async () => {})
    let resolveWs!: (handle: { dispose(): Promise<void> }) => void
    Object.assign(setup.deps, { telemetry: {
      getState: async () => testTelemetryState(),
      onStateChanged: async () => ({ dispose: telemetryDispose }),
    } as unknown as PersonRoadControllerDeps['telemetry'] })
    setup.deps.ws.onBizCode = vi.fn(() => new Promise<{ dispose(): Promise<void> }>((resolve) => {
      resolveWs = resolve
    })) as PersonRoadControllerDeps['ws']['onBizCode']

    const controller = createPersonRoadController(setup.deps)
    await vi.waitFor(() => expect(setup.deps.ws.onBizCode).toHaveBeenCalledOnce())
    const disposing = controller.dispose()
    resolveWs({ dispose: wsDispose })
    await disposing

    expect(wsDispose).toHaveBeenCalledOnce()
    expect(telemetryDispose).toHaveBeenCalledOnce()
  })

  it('恢复要求 flightId 严格匹配且 sessionId 非空', async () => {
    const mismatch = harness({ isActive: true, sessionId: 'session-old', projectId: 'project-1', dockSn: 'dock-1', flightId: 'old-flight', startedAt: 1 })
    const first = createPersonRoadController(mismatch.deps)
    await first.recover()
    expect(first.settingsState.get().enabled).toBe(false)
    await first.dispose()

    const emptySession = harness({ isActive: true, sessionId: '', projectId: 'project-1', dockSn: 'dock-1', flightId: 'flight-1', startedAt: 1 })
    const second = createPersonRoadController(emptySession.deps)
    await second.recover()
    expect(second.settingsState.get().enabled).toBe(false)
    await second.dispose()

    const match = harness({ isActive: true, sessionId: 'session-1', projectId: 'project-1', dockSn: 'dock-1', flightId: 'flight-1', startedAt: 1 })
    const third = createPersonRoadController(match.deps)
    await third.recover()
    expect(third.settingsState.get().enabled).toBe(true)
    await third.dispose()
    expect(match.api.stopSession).toHaveBeenCalledWith({ sessionId: 'session-1', endedAt: 1720000000000 })
  })

  it('恢复时携带 flightId 并接续后端 open Tracking', async () => {
    const setup = harness({
      isActive: true,
      sessionId: 'session-1',
      flightId: 'flight-1',
      trackingCount: 1,
      openTracking: { trackingId: 'tracking-open', startedAt: 10, matchEndAt: 30_010 },
    })
    const controller = createPersonRoadController(setup.deps)
    await controller.recover()
    expect(setup.api.getStatus).toHaveBeenCalledWith({ projectId: 'project-1', dockSn: 'dock-1', flightId: 'flight-1' })
    expect(controller.skipHintState.get().phase).toBe('ready')
    await controller.dispose()
  })

  it('订阅新 WS biz_code 并按 dock/flight 严格过滤', async () => {
    const { deps, api } = harness({ isActive: false, sessionId: '', projectId: 'project-1', dockSn: 'dock-1', flightId: '', startedAt: 0 })
    let handler: ((event: { subBizCode: string | null; data: Record<string, unknown> }) => void) | undefined
    deps.ws.onBizCode = vi.fn(async (_code, next) => {
      handler = next as typeof handler
      return { dispose: async () => {} }
    })
    const controller = createPersonRoadController(deps)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(deps.ws.onBizCode).toHaveBeenCalledWith('illegal_road_capture', expect.any(Function))
    handler?.({ subBizCode: 'media_added', data: { scene: 'illegal_road', dock_sn: 'other', flight_id: 'flight-1' } })
    expect(api.listTrackings).not.toHaveBeenCalled()
    await controller.dispose()
  })

  it('从 tracking summary 分别映射列表缩略图、详情原图和文件夹', async () => {
    const setup = harness({ isActive: true, sessionId: 'session-1', flightId: 'flight-1' })
    setup.api.listTrackings = vi.fn(async () => ({
      total: 2,
      session: null,
      trackings: [{
        id: 'tracking-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        dockSn: 'dock-1',
        flightId: 'flight-1',
        status: 'closed' as const,
        startedAt: 10,
        endedAt: 20,
        closeReason: 'timeout' as const,
        folderId: 1,
        parentFolderId: 2,
        latestPhoto: { fileId: 1, previewUrl: '/preview.jpg', originalUrl: '/original.jpg', photoTimeMs: 11 },
      }, {
        id: 'tracking-old',
        sessionId: 'session-old',
        projectId: 'project-1',
        dockSn: 'dock-1',
        flightId: 'flight-1',
        status: 'closed' as const,
        startedAt: 1,
        endedAt: 2,
        closeReason: 'manual' as const,
        folderId: 3,
        parentFolderId: 2,
        latestPhoto: null,
      }],
    }))
    const controller = createPersonRoadController(setup.deps)
    await controller.recover()

    expect(setup.api.listTrackings).toHaveBeenCalledWith({ projectId: 'project-1', flightId: 'flight-1', sessionId: 'session-1', page: 1, pageSize: 100 })
    expect(controller.recordsState.get().records).toHaveLength(1)
    expect(controller.recordsState.get().records[0]).toMatchObject({
      trackingId: 'tracking-1',
      folderId: 1,
      endedAt: 20,
      previewPhotoUrl: '/preview.jpg',
      originalPhotoUrl: '/original.jpg',
      closeReason: 'timeout',
      pending: false,
    })
    await controller.dispose()
  })
})

describe('person-road controller 设备编排与竞态', () => {
  function readyHarness () {
    const base = harness({ isActive: false, sessionId: '', projectId: 'project-1', dockSn: 'dock-1', flightId: '', startedAt: 0 })
    const order: string[] = []
    let cameraZoom = 1
    let cameraRecording = false
    const acquireRecordingInputs: Array<{ takeover?: boolean }> = []
    const ensureZoomCalls: number[] = []
    let detectionHandler: ((frame: { targets: Array<{ targetId: string; type: string; state: string; bbox: { x: number; y: number; width: number; height: number } }> }) => void) | undefined
    let telemetryHandler: ((event: { state: ReturnType<typeof testTelemetryState> }) => void) | undefined
    const timers: TrackedTimers = {
      setTimeout (callback, ms) {
        return setTimeout(callback, ms)
      },
      clearTimeout (handle) {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
      },
      setInterval (callback, ms) {
        return setInterval(callback, ms)
      },
      clearInterval (handle) {
        clearInterval(handle as ReturnType<typeof setInterval>)
      },
    }
    Object.assign(base.deps, {
      timers,
      telemetry: {
        getState: async () => testTelemetryState(),
        onStateChanged: async (handler: typeof telemetryHandler) => {
          telemetryHandler = handler
          return {
            dispose: async () => {
              telemetryHandler = undefined
            },
          }
        },
      },
      camera: {
        getState: async () => ({ availability: { status: 'available' as const, reason: null }, mode: 'photo' as const, lens: 'wide' as const, zoom: cameraZoom, recording: cameraRecording }),
        onStateChanged: async () => ({ dispose: async () => {} }),
        ensureMode: async () => {
          order.push('camera.mode')
        },
        switchLens: async () => {},
        ensureZoom: async (factor: number) => {
          ensureZoomCalls.push(factor)
          cameraZoom = factor
          order.push('camera.zoom')
        },
        boundingZoom: async () => {},
        takePhoto: async () => {
          order.push('camera.photo')
          return { accepted: true, capturedAt: 1 }
        },
        acquireRecording: async (input: { takeover?: boolean }) => {
          acquireRecordingInputs.push(input)
          order.push('camera.record')
          return {
            stop: async () => {
              order.push('camera.stop')
              cameraRecording = false
            },
            dispose: async () => {},
            onRevoked: async () => ({ dispose: async () => {} }),
          }
        },
        captureFrame: async () => ({ blob: new Blob(['frame']), width: 100, height: 100, capturedAt: 1, geometrySnapshotId: 's' }),
      },
      detection: {
        onFrame: async (handler: typeof detectionHandler) => {
          detectionHandler = handler
          return {
            dispose: async () => {
              detectionHandler = undefined
            },
          }
        },
        projectToGround: async () => null,
        projectFromGround: async () => null,
      },
      smartTrack: {
        getState: async () => ({ phase: 'off' as const, targetId: null }),
        onStateChanged: async () => ({ dispose: async () => {} }),
        start: async (input: { targetId?: string }) => {
          order.push('smart.start')
          return { phase: 'tracking' as const, targetId: input.targetId ?? null }
        },
        stop: async () => {
          order.push('smart.stop')
          return { phase: 'off' as const, targetId: null }
        },
      },
      aiConfig: {
        getState: async () => ({ availability: { status: 'available' as const, reason: null }, model: 'dji-visible', recognitionEnabled: true, targetTypes: ['person'] }),
        onStateChanged: async () => ({ dispose: async () => {} }),
        ensure: async () => {
          order.push('ai.ensure')
          return { confirmed: true, reason: null }
        },
      },
      gimbal: { reset: async () => {}, lookAt: async () => {
        order.push('gimbal.lookAt')
      } },
      now: () => Date.now(),
    })
    const emitPerson = (): void => detectionHandler?.({ targets: [{ targetId: 'person-1', type: '2', state: 'tracked', bbox: { x: 0.4, y: 0.4, width: 0.1, height: 0.2 } }] })
    const emitControl = (hasControl: boolean): void => {
      const state = testTelemetryState()
      telemetryHandler?.({ state: { ...state, control: { ...state.control, payload: { ...state.control.payload, hasControl } } } })
    }
    const emitTelemetry = (droneTimestampValue: number): void => {
      const state = testTelemetryState()
      telemetryHandler?.({ state: { ...state, drone: { ...state.drone, timestamp: droneTimestampValue } } })
    }
    const detectionAttached = (): boolean => detectionHandler !== undefined
    const setCameraZoom = (zoom: number): void => {
      cameraZoom = zoom
    }
    const setCameraRecording = (recording: boolean): void => {
      cameraRecording = recording
    }
    return { ...base, order, ensureZoomCalls, acquireRecordingInputs, setCameraZoom, setCameraRecording, emitPerson, emitControl, emitTelemetry, detectionAttached }
  }

  async function startRound (setup = readyHarness()) {
    const controller = createPersonRoadController(setup.deps)
    await controller.recover()
    await controller.settings.setEnabled({ enabled: true })
    setup.emitPerson()
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => expect(controller.recordsState.get().records).toHaveLength(1))
    return { ...setup, controller }
  }

  it('enable 迟到时由后续 disable 失效并关闭已创建 Session', async () => {
    const setup = readyHarness()
    let resolveStart!: (value: Awaited<ReturnType<IllegalRoadApi['startSession']>>) => void
    setup.api.startSession = vi.fn(() => new Promise<Awaited<ReturnType<IllegalRoadApi['startSession']>>>((resolve) => {
      resolveStart = resolve
    }))
    const controller = createPersonRoadController(setup.deps)
    await controller.recover()
    const enabling = controller.settings.setEnabled({ enabled: true })
    await vi.waitFor(() => expect(setup.api.startSession).toHaveBeenCalled())
    await controller.settings.setEnabled({ enabled: false })
    resolveStart({ isActive: true, sessionId: 'session-late', projectId: 'project-1', dockSn: 'dock-1', flightId: 'flight-1', startedAt: 1, resumed: false })
    await enabling
    expect(controller.settingsState.get().enabled).toBe(false)
    expect(setup.api.stopSession).toHaveBeenCalledWith({ sessionId: 'session-late', endedAt: expect.any(Number) })
    await controller.dispose()
  })

  it('新建 Session 时清空上一 Session 的记录', async () => {
    const setup = readyHarness()
    setup.api.startSession = vi.fn()
      .mockResolvedValueOnce({ isActive: true, sessionId: 'session-old', projectId: 'project-1', dockSn: 'dock-1', flightId: 'flight-1', startedAt: 1, resumed: true })
      .mockResolvedValueOnce({ isActive: true, sessionId: 'session-new', projectId: 'project-1', dockSn: 'dock-1', flightId: 'flight-1', startedAt: 2, resumed: false })
    setup.api.listTrackings = vi.fn(async () => ({
      total: 1,
      session: null,
      trackings: [{
        id: 'tracking-old',
        sessionId: 'session-old',
        projectId: 'project-1',
        dockSn: 'dock-1',
        flightId: 'flight-1',
        status: 'closed' as const,
        startedAt: 1,
        endedAt: 2,
        closeReason: 'manual' as const,
        folderId: 1,
        parentFolderId: 0,
        latestPhoto: null,
      }],
    }))
    const controller = createPersonRoadController(setup.deps)
    await controller.recover()
    await controller.settings.setEnabled({ enabled: true })
    expect(controller.recordsState.get().records.map(item => item.trackingId)).toEqual(['tracking-old'])

    await controller.settings.setEnabled({ enabled: false })
    await controller.settings.setEnabled({ enabled: true })

    expect(controller.recordsState.get().records).toEqual([])
    expect(setup.api.listTrackings).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-old' }))
    await controller.dispose()
  })

  it('stopSession 失败时保持 enabled 并允许再次关闭', async () => {
    const setup = readyHarness()
    let calls = 0
    setup.api.stopSession = vi.fn(async (input) => {
      calls += 1
      if (calls === 1) throw new Error('stop session failed')
      return { sessionId: input.sessionId, stoppedAt: input.endedAt, closedTrackingIds: [] }
    })
    const controller = createPersonRoadController(setup.deps)
    await controller.recover()
    await controller.settings.setEnabled({ enabled: true })
    await expect(controller.settings.setEnabled({ enabled: false })).rejects.toThrow('stop session failed')
    expect(controller.settingsState.get().enabled).toBe(true)
    expect(setup.notification.show).toHaveBeenCalledWith(expect.objectContaining({
      intent: 'error',
      message: expect.stringContaining('行人上路抓拍关闭失败'),
    }))
    await controller.settings.setEnabled({ enabled: false })
    expect(controller.settingsState.get().enabled).toBe(false)
    await controller.dispose()
  })

  it('startSession 失败时向用户提示开启失败', async () => {
    const setup = readyHarness()
    setup.api.startSession = vi.fn(async () => {
      throw new Error('start-session 响应状态非法')
    })
    const controller = createPersonRoadController(setup.deps)
    await controller.recover()
    await expect(controller.settings.setEnabled({ enabled: true })).rejects.toThrow('start-session 响应状态非法')
    expect(controller.settingsState.get().enabled).toBe(false)
    expect(setup.notification.show).toHaveBeenCalledWith(expect.objectContaining({
      intent: 'error',
      message: expect.stringContaining('行人上路抓拍开启失败'),
    }))
    await controller.dispose()
  })

  it('开启时相机录像中先接管停止既有录像再切拍照模式', async () => {
    vi.useFakeTimers()
    try {
      const setup = readyHarness()
      setup.setCameraRecording(true)
      const controller = createPersonRoadController(setup.deps)
      await controller.recover()
      const enabling = controller.settings.setEnabled({ enabled: true })
      // 停录像后有 1s 封存稳定等待：等待期内不切模式，越过 1s 才切
      await vi.advanceTimersByTimeAsync(999)
      expect(setup.order).not.toContain('camera.mode')
      await vi.advanceTimersByTimeAsync(1)
      await enabling
      expect(setup.acquireRecordingInputs).toEqual([{ takeover: true }])
      expect(setup.order.indexOf('camera.record')).toBeLessThan(setup.order.indexOf('camera.stop'))
      expect(setup.order.indexOf('camera.stop')).toBeLessThan(setup.order.indexOf('camera.mode'))
      expect(controller.settingsState.get().enabled).toBe(true)
      expect(setup.api.startSession).toHaveBeenCalledOnce()
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('开启时停止录像失败则提示手动关闭且不创建 Session', async () => {
    const setup = readyHarness()
    setup.setCameraRecording(true)
    const camera = setup.deps.camera as NonNullable<PersonRoadControllerDeps['camera']>
    Object.assign(camera, { acquireRecording: vi.fn(async () => ({
      stop: async () => {
        throw new Error('stop rejected')
      },
      dispose: async () => {},
      onRevoked: async () => ({ dispose: async () => {} }),
    })) })
    const controller = createPersonRoadController(setup.deps)
    await controller.recover()
    await controller.settings.setEnabled({ enabled: true })
    expect(controller.settingsState.get().enabled).toBe(false)
    expect(controller.settingsState.get().switchBusy).toBe(false)
    expect(setup.api.startSession).not.toHaveBeenCalled()
    expect(setup.notification.show).toHaveBeenCalledWith(expect.objectContaining({
      intent: 'warning',
      message: '相机正在录像，请手动停止录像后再开启行人上路抓拍',
    }))
    await controller.dispose()
  })

  it('通知能力自身失败不影响业务错误传播', async () => {
    const setup = readyHarness()
    setup.notification.show = vi.fn(async () => {
      throw new Error('notification transport failed')
    })
    setup.api.startSession = vi.fn(async () => {
      throw new Error('gateway down')
    })
    const controller = createPersonRoadController(setup.deps)
    await controller.recover()
    await expect(controller.settings.setEnabled({ enabled: true })).rejects.toThrow('gateway down')
    expect(setup.notification.show).toHaveBeenCalled()
    await controller.dispose()
  })

  it('检测订阅失败时补偿关闭已创建 Session', async () => {
    const setup = readyHarness()
    Object.assign(setup.deps, {
      detection: {
        onFrame: vi.fn(async () => {
          throw new Error('detection unavailable')
        }),
        projectToGround: async () => null,
        projectFromGround: async () => null,
      },
    })
    const controller = createPersonRoadController(setup.deps)
    await controller.recover()
    await expect(controller.settings.setEnabled({ enabled: true })).rejects.toThrow('detection unavailable')
    expect(controller.settingsState.get().enabled).toBe(false)
    expect(setup.api.stopSession).toHaveBeenCalledWith({ sessionId: 'session-1', endedAt: 1720000000000 })
    await controller.dispose()
  })

  it('startTracking 在关闭后迟到返回时仍使用冻结 endedAt 收敛', async () => {
    vi.useFakeTimers()
    try {
      const setup = readyHarness()
      let resolveTracking!: (value: Awaited<ReturnType<IllegalRoadApi['startTracking']>>) => void
      setup.api.startTracking = vi.fn(() => new Promise<Awaited<ReturnType<IllegalRoadApi['startTracking']>>>((resolve) => {
        resolveTracking = resolve
      }))
      const controller = createPersonRoadController(setup.deps)
      await controller.recover()
      await controller.settings.setEnabled({ enabled: true })
      setup.emitPerson()
      await vi.advanceTimersByTimeAsync(1_500)
      await vi.waitFor(() => expect(setup.api.startTracking).toHaveBeenCalledOnce())
      await controller.settings.setEnabled({ enabled: false })
      resolveTracking({ trackingId: 'tracking-late', sessionId: 'session-1', startedAt: 1, matchEndAt: 30_001, supersededTrackingId: '' })
      await vi.advanceTimersByTimeAsync(0)
      expect(setup.api.stopTracking).toHaveBeenCalledWith({ trackingId: 'tracking-late', endedAt: expect.any(Number) })
      expect(controller.recordsState.get().records).toEqual([])
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('设备准备完成后创建 Session，Tracking 只提交业务字段', async () => {
    vi.useFakeTimers()
    try {
      const setup = await startRound()
      const startSessionOrder = (setup.api.startSession as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      const startTrackingOrder = (setup.api.startTracking as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      expect(startSessionOrder).toBeLessThan(startTrackingOrder)
      expect(setup.api.startTracking).toHaveBeenCalledWith({ sessionId: 'session-1', startedAt: 1720000000000 })
      expect(setup.order.indexOf('smart.start')).toBeLessThan(setup.order.indexOf('camera.photo'))
      await setup.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('飞机时间戳缺失时回退浏览器时间并记录诊断', async () => {
    vi.useFakeTimers()
    try {
      const setup = readyHarness()
      const telemetry = setup.deps.telemetry as NonNullable<PersonRoadControllerDeps['telemetry']>
      const state = testTelemetryState()
      Object.assign(telemetry, { getState: async () => ({ ...state, drone: { ...state.drone, timestamp: null } }) })
      Object.assign(setup.deps, { now: () => 1234 })
      const controller = createPersonRoadController(setup.deps)
      await controller.recover()
      await controller.settings.setEnabled({ enabled: true })
      setup.emitPerson()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(setup.api.startTracking).toHaveBeenCalledWith({ sessionId: 'session-1', startedAt: 1234 })
      expect(setup.deps.logger.debug).toHaveBeenCalledWith('[person-road] 业务时间戳', expect.objectContaining({
        operation: 'h_illegalRoad_startTracking',
        used: 'browser-fallback',
        droneTs: null,
        driftMs: null,
      }))
      expect(setup.deps.logger.warn).toHaveBeenCalledWith('飞机时间戳不可用，回退浏览器时间', { operation: 'h_illegalRoad_startTracking', fallback: 1234 })
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('startTracking 失败时不自动重试', async () => {
    vi.useFakeTimers()
    try {
      const setup = readyHarness()
      setup.api.startTracking = vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
      const controller = createPersonRoadController(setup.deps)
      await controller.recover()
      await controller.settings.setEnabled({ enabled: true })
      setup.emitPerson()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(setup.api.startTracking).toHaveBeenCalledOnce()
      expect(controller.recordsState.get().records).toEqual([])
      expect(setup.notification.show).toHaveBeenCalledWith(expect.objectContaining({
        intent: 'error',
        message: expect.stringContaining('行人上路本轮抓拍启动失败'),
      }))
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('媒体回填先于本地截图完成时不被 pending 记录覆盖', async () => {
    vi.useFakeTimers()
    try {
      const setup = readyHarness()
      let mediaHandler: ((event: { subBizCode: string | null; data: Record<string, unknown> }) => void) | undefined
      setup.deps.ws.onBizCode = vi.fn(async (_code, handler) => {
        mediaHandler = handler as typeof mediaHandler
        return { dispose: async () => {} }
      })
      let resolveFrame!: (value: { blob: Blob; width: number; height: number; capturedAt: number; geometrySnapshotId: string }) => void
      const camera = setup.deps.camera as NonNullable<PersonRoadControllerDeps['camera']>
      Object.assign(camera, { captureFrame: vi.fn(() => new Promise((resolve) => {
        resolveFrame = resolve
      })) })
      setup.api.listTrackings = vi.fn(async () => ({
        total: 1,
        session: null,
        trackings: [{
          id: 'tracking-1',
          sessionId: 'session-1',
          projectId: 'project-1',
          dockSn: 'dock-1',
          flightId: 'flight-1',
          status: 'open' as const,
          startedAt: 1720000000000,
          endedAt: 0,
          closeReason: '' as const,
          folderId: 95601,
          parentFolderId: 95583,
          latestPhoto: { fileId: 95600, previewUrl: '/preview.jpg', originalUrl: '/original.jpg', photoTimeMs: 1720000000100 },
        }],
      }))
      const controller = createPersonRoadController(setup.deps)
      await controller.recover()
      await controller.settings.setEnabled({ enabled: true })
      setup.emitPerson()
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => expect(camera.captureFrame).toHaveBeenCalledOnce())
      expect(controller.recordsState.get().records[0]).toMatchObject({ trackingId: 'tracking-1', folderId: 0, pending: true })

      mediaHandler?.({ subBizCode: 'media_added', data: { scene: 'illegal_road', dock_sn: 'dock-1', flight_id: 'flight-1' } })
      await vi.waitFor(() => expect(controller.recordsState.get().records[0]).toMatchObject({ folderId: 95601, pending: false }))
      resolveFrame({ blob: new Blob(['frame']), width: 100, height: 100, capturedAt: 1, geometrySnapshotId: 's' })
      await vi.advanceTimersByTimeAsync(0)

      expect(controller.recordsState.get().records[0]).toMatchObject({
        folderId: 95601,
        previewPhotoUrl: '/preview.jpg',
        originalPhotoUrl: '/original.jpg',
        pending: false,
      })
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stopTracking 失败保留同一 trackingId 和 endedAt，disable 时再次收敛', async () => {
    vi.useFakeTimers()
    try {
      const setup = readyHarness()
      let calls = 0
      setup.api.stopTracking = vi.fn(async (input) => {
        calls += 1
        if (calls === 1) throw new Error('stop failed')
        return { trackingId: input.trackingId, startedAt: 1, endedAt: input.endedAt, closeReason: 'manual' as const, mediaCount: 0 }
      })
      const running = await startRound(setup)
      await expect(running.controller.skipCurrentTarget()).rejects.toThrow('stop failed')
      expect(setup.notification.show).toHaveBeenCalledWith(expect.objectContaining({
        intent: 'error',
        message: expect.stringContaining('行人上路本轮抓拍结束失败'),
      }))
      await running.controller.settings.setEnabled({ enabled: false })
      const stopCalls = (setup.api.stopTracking as ReturnType<typeof vi.fn>).mock.calls
      expect(stopCalls).toHaveLength(2)
      expect(stopCalls[1]?.[0]).toEqual(stopCalls[0]?.[0])
      expect(stopCalls[0]?.[0].endedAt).toBe(1720000000000)
      expect(setup.api.stopSession).toHaveBeenCalled()
      await running.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('控制权丢失时 stopTracking 失败仍保留并在 disable 重试', async () => {
    vi.useFakeTimers()
    try {
      const setup = readyHarness()
      let calls = 0
      setup.api.stopTracking = vi.fn(async (input) => {
        calls += 1
        if (calls === 1) throw new Error('stop failed')
        return { trackingId: input.trackingId, startedAt: 1, endedAt: input.endedAt, closeReason: 'manual' as const, mediaCount: 0 }
      })
      const running = await startRound(setup)
      setup.emitControl(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(setup.api.stopTracking).toHaveBeenCalledTimes(1)
      await running.controller.settings.setEnabled({ enabled: false })
      expect(setup.api.stopTracking).toHaveBeenCalledTimes(2)
      await running.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('关闭时串行收敛提示条更新，迟到的 visible=true 不能覆盖隐藏', async () => {
    vi.useFakeTimers()
    try {
      const running = await startRound()
      const updates: boolean[] = []
      let releaseVisible!: () => void
      const visiblePending = new Promise<void>((resolve) => {
        releaseVisible = resolve
      })
      running.controller.attachUi({ skipHint: {
        update: vi.fn(async ({ visible }) => {
          updates.push(visible ?? false)
          if (visible) await visiblePending
        }),
      } })
      await vi.waitFor(() => expect(updates).toContain(true))

      const disabling = running.controller.settings.setEnabled({ enabled: false })
      releaseVisible()
      await disabling
      await vi.waitFor(() => expect(updates.at(-1)).toBe(false))

      expect(running.controller.skipHintState.get().phase).toBe('hidden')
      await running.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('卸载时后端收尾失败不阻断本地清理与 Session 关闭', async () => {
    vi.useFakeTimers()
    try {
      const setup = readyHarness()
      setup.api.stopTracking = vi.fn(async () => {
        throw new Error('stop tracking failed')
      })
      setup.api.stopSession = vi.fn(async () => {
        throw new Error('stop session failed')
      })
      const running = await startRound(setup)
      await expect(running.controller.dispose()).resolves.toBeUndefined()
      expect(setup.api.stopSession).toHaveBeenCalledWith({ sessionId: 'session-1', endedAt: 1720000000000 })
      expect(setup.detectionAttached()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('finalize 收尾先停 SPZ，再按轮次基准恢复变焦与观察视角', async () => {
    vi.useFakeTimers()
    try {
      const setup = readyHarness()
      setup.setCameraZoom(5)
      const { controller } = await startRound(setup)
      await controller.skipCurrentTarget()
      const { order } = setup
      expect(order.indexOf('smart.stop')).toBeLessThan(order.indexOf('camera.zoom'))
      expect(order.indexOf('camera.zoom')).toBeLessThan(order.lastIndexOf('gimbal.lookAt'))
      expect(setup.ensureZoomCalls).toEqual([5])
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  describe('飞机时间戳观测', () => {
    const heartbeatCalls = (setup: { deps: { logger: PluginLogger } }): number =>
      (setup.deps.logger.debug as ReturnType<typeof vi.fn>)
        .mock.calls.filter(([message]) => message === '[person-road] 飞机时间戳观测').length

    it('心跳每 5 秒输出缓存值与 SDK 现读值', async () => {
      vi.useFakeTimers()
      try {
        const setup = readyHarness()
        const controller = createPersonRoadController(setup.deps)
        await controller.recover()
        const debug = setup.deps.logger.debug as ReturnType<typeof vi.fn>
        debug.mockClear()
        await vi.advanceTimersByTimeAsync(4_999)
        expect(heartbeatCalls(setup)).toBe(0)
        await vi.advanceTimersByTimeAsync(1)
        await vi.waitFor(() => expect(debug).toHaveBeenCalledWith('[person-road] 飞机时间戳观测', expect.objectContaining({
          droneTs: 1720000000000,
          freshDroneTs: 1720000000000,
          timeDiffDeviceAndWeb: 0,
        })))
        await vi.advanceTimersByTimeAsync(5_000)
        expect(heartbeatCalls(setup)).toBe(2)
        await controller.dispose()
      } finally {
        vi.useRealTimers()
      }
    })

    it('心跳区分缓存值与 SDK 现读值，缓存只随订阅事件更新', async () => {
      vi.useFakeTimers()
      try {
        const setup = readyHarness()
        const controller = createPersonRoadController(setup.deps)
        await controller.recover()
        setup.emitTelemetry(111)
        const telemetry = setup.deps.telemetry as NonNullable<PersonRoadControllerDeps['telemetry']>
        Object.assign(telemetry, { getState: async () => ({ ...testTelemetryState(), drone: { ...testTelemetryState().drone, timestamp: 222 } }) })
        await vi.advanceTimersByTimeAsync(5_000)
        await vi.waitFor(() => expect(setup.deps.logger.debug).toHaveBeenCalledWith('[person-road] 飞机时间戳观测', expect.objectContaining({
          droneTs: 111,
          freshDroneTs: 222,
        })))
        await controller.dispose()
      } finally {
        vi.useRealTimers()
      }
    })

    it('飞机时间戳缺失时心跳输出 null 且不抛错', async () => {
      vi.useFakeTimers()
      try {
        const setup = readyHarness()
        const telemetry = setup.deps.telemetry as NonNullable<PersonRoadControllerDeps['telemetry']>
        Object.assign(telemetry, { getState: async () => ({ ...testTelemetryState(), drone: { ...testTelemetryState().drone, timestamp: null } }) })
        const controller = createPersonRoadController(setup.deps)
        await controller.recover()
        await vi.advanceTimersByTimeAsync(5_000)
        await vi.waitFor(() => expect(setup.deps.logger.debug).toHaveBeenCalledWith('[person-road] 飞机时间戳观测', expect.objectContaining({
          droneTs: null,
          freshDroneTs: null,
          driftMs: null,
        })))
        await controller.dispose()
      } finally {
        vi.useRealTimers()
      }
    })

    it('dispose 后心跳停止打点', async () => {
      vi.useFakeTimers()
      try {
        const setup = readyHarness()
        const controller = createPersonRoadController(setup.deps)
        await controller.recover()
        await controller.dispose()
        const before = heartbeatCalls(setup)
        await vi.advanceTimersByTimeAsync(30_000)
        expect(heartbeatCalls(setup)).toBe(before)
      } finally {
        vi.useRealTimers()
      }
    })

    it('业务时间戳日志标记 drone 来源与漂移', async () => {
      vi.useFakeTimers()
      try {
        const setup = readyHarness()
        const controller = createPersonRoadController(setup.deps)
        await controller.recover()
        await controller.settings.setEnabled({ enabled: true })
        setup.emitPerson()
        await vi.advanceTimersByTimeAsync(10_000)
        expect(setup.api.startTracking).toHaveBeenCalledWith({ sessionId: 'session-1', startedAt: 1720000000000 })
        expect(setup.deps.logger.debug).toHaveBeenCalledWith('[person-road] 业务时间戳', expect.objectContaining({
          operation: 'h_illegalRoad_startTracking',
          used: 'drone',
          droneTs: 1720000000000,
        }))
        await controller.dispose()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
