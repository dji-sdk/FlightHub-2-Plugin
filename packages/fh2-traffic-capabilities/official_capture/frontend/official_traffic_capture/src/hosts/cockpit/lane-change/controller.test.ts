// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { PluginLogger, TrackedTimers } from 'fh2-plugin-sdk'
import { testTelemetryState } from '../../../shared/test-telemetry'
import type { LaneChangeApi } from './api'
import { createLaneChangeController } from './controller'
import type { LaneChangeControllerDeps } from './controller'
import { composeSnapshotOverlay } from './snapshot-overlay'

vi.mock('./snapshot-overlay', () => ({
  composeSnapshotOverlay: vi.fn(async () => null),
}))

function harness (flightId = 'flight-1') {
  const timeouts = new Map<unknown, () => void>()
  const timers: TrackedTimers = {
    setTimeout (callback) {
      timeouts.set(callback, callback)
      return callback
    },
    clearTimeout (handle) {
      timeouts.delete(handle)
    },
    setInterval (callback) {
      return callback
    },
    clearInterval () {},
  }
  const api: LaneChangeApi = {
    startMode: vi.fn(async input => ({ isActive: true as const, flightId: input.flightId })),
    stopMode: vi.fn(async () => ({ isActive: false as const, flightId: '' })),
    getMode: vi.fn(async () => ({ isActive: false, flightId: '' })),
    createEvent: vi.fn(async input => ({ eventId: 'event-1', eventKey: input.eventKey, postStatus: 'pending_video' as const, createdAt: '', created: true })),
    listEvents: vi.fn(async () => ({ total: 0, events: [] })),
  }
  let telemetryHandler: ((event: { state: ReturnType<typeof testTelemetryState> }) => void) | undefined
  const telemetry = {
    getState: async () => testTelemetryState(),
    onStateChanged: async (handler: (event: { state: ReturnType<typeof testTelemetryState> }) => void) => {
      telemetryHandler = handler
      return { dispose: () => {} }
    },
  }
  const logger: PluginLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const notification = { show: vi.fn(async () => ({ dispose: () => {} })) }
  const deps: LaneChangeControllerDeps = {
    api,
    telemetry: telemetry as unknown as LaneChangeControllerDeps['telemetry'],
    camera: undefined,
    detection: undefined,
    sceneGeometry: undefined,
    aiConfig: undefined,
    notification: notification as unknown as LaneChangeControllerDeps['notification'],
    pointer: undefined,
    storage: { get: async () => undefined, set: async () => {} },
    blobs: { put: async () => {}, url: async () => undefined },
    timers,
    logger,
    getProjectId: () => 'project-1',
    getFlightId: () => flightId,
    now: () => 1000,
  }
  return {
    api,
    deps,
    notification,
    timeouts,
    emitTelemetry: (state: ReturnType<typeof testTelemetryState>) => telemetryHandler?.({ state }),
  }
}

function returningTelemetryState (): ReturnType<typeof testTelemetryState> {
  const state = testTelemetryState()
  return {
    ...state,
    drone: {
      ...state.drone,
      mode: { source: 'drc', mode_code: 12 },
    },
  }
}

function attachCamera (deps: LaneChangeControllerDeps, options: {
  readonly recording: boolean | (() => boolean);
  readonly stop?: () => Promise<void>;
  readonly acquireGate?: Promise<void>;
}) {
  const recordingNow = (): boolean => (typeof options.recording === 'function' ? options.recording() : options.recording)
  const stop = vi.fn(options.stop ?? (async () => {}))
  const dispose = vi.fn(async () => {})
  const acquireRecording = vi.fn(async () => {
    await options.acquireGate
    return {
      stop,
      dispose,
      onRevoked: vi.fn(() => ({ dispose: () => {} })),
    }
  })
  Object.assign(deps, {
    camera: {
      getState: () => ({ availability: { status: 'available' as const, reason: null }, mode: 'record' as const, lens: 'wide' as const, zoom: 1, recording: recordingNow() }),
      onStateChanged: () => ({ dispose: () => {} }),
      ensureMode: async () => {},
      switchLens: async () => {},
      ensureZoom: async () => {},
      boundingZoom: async () => {},
      takePhoto: async () => ({ accepted: true, capturedAt: 1 }),
      acquireRecording,
      captureFrame: async () => ({ blob: new Blob(), width: 1, height: 1, capturedAt: 1, geometrySnapshotId: null }),
    },
  })
  return { acquireRecording, stop, dispose }
}

function timeoutError (message = 'stop failed'): Error & { readonly code: 'TIMEOUT' } {
  return Object.assign(new Error(message), { code: 'TIMEOUT' as const })
}

/** 订阅四条状态链并计数；createViewState.subscribe 会同步回调当前值一次，归零后再开始计数。 */
function countingSubscriptions (controller: ReturnType<typeof createLaneChangeController>) {
  const counts = { settings: 0, workbench: 0, canvas: 0, records: 0 }
  controller.settingsState.subscribe(() => {
    counts.settings += 1
  })
  controller.workbenchState.subscribe(() => {
    counts.workbench += 1
  })
  controller.canvasState.subscribe(() => {
    counts.canvas += 1
  })
  controller.recordsState.subscribe(() => {
    counts.records += 1
  })
  counts.settings = 0
  counts.workbench = 0
  counts.canvas = 0
  counts.records = 0
  return counts
}

describe('lane-change controller formal handlers', () => {
  it('开启和关闭均等待领域 Handler', async () => {
    const { api, deps } = harness()
    const controller = createLaneChangeController(deps)
    await new Promise(resolve => setTimeout(resolve, 0))
    await controller.settings.setEnabled({ enabled: true })
    expect(api.startMode).toHaveBeenCalledWith({ projectId: 'project-1', dockSn: 'dock-1', flightId: 'flight-1' })
    expect(controller.settingsState.get().enabled).toBe(true)
    await controller.settings.setEnabled({ enabled: false })
    expect(api.stopMode).toHaveBeenCalledWith({ projectId: 'project-1', dockSn: 'dock-1' })
    await controller.dispose()
  })

  it('返航 telemetry 连续更新时只请求一次 stop-mode', async () => {
    const setup = harness()
    let resolveStop!: (value: { isActive: false; flightId: string }) => void
    setup.api.stopMode = vi.fn(() => new Promise<{ isActive: false; flightId: string }>((resolve) => {
      resolveStop = resolve
    }))
    const controller = createLaneChangeController(setup.deps)
    await new Promise(resolve => setTimeout(resolve, 0))
    await controller.settings.setEnabled({ enabled: true })
    const returning = returningTelemetryState()

    for (let index = 0; index < 15; index += 1) setup.emitTelemetry(returning)
    await vi.waitFor(() => expect(setup.api.stopMode).toHaveBeenCalledOnce())

    resolveStop({ isActive: false, flightId: 'flight-1' })
    await vi.waitFor(() => expect(controller.settingsState.get().enabled).toBe(false))
    await controller.dispose()
  })

  it('返航自动关闭失败后允许下一帧重试', async () => {
    const setup = harness()
    setup.api.stopMode = vi.fn()
      .mockRejectedValueOnce(new Error('stop-mode down'))
      .mockResolvedValue({ isActive: false, flightId: 'flight-1' })
    const controller = createLaneChangeController(setup.deps)
    await new Promise(resolve => setTimeout(resolve, 0))
    await controller.settings.setEnabled({ enabled: true })
    const returning = returningTelemetryState()

    setup.emitTelemetry(returning)
    await vi.waitFor(() => expect(controller.settingsState.get().switchBusy).toBe(false))
    expect(controller.settingsState.get().enabled).toBe(true)

    setup.emitTelemetry(returning)
    await vi.waitFor(() => expect(controller.settingsState.get().enabled).toBe(false))
    expect(setup.api.stopMode).toHaveBeenCalledTimes(2)
    await controller.dispose()
  })

  it('相同 telemetry 高频帧不广播任何状态链', async () => {
    const setup = harness()
    const controller = createLaneChangeController(setup.deps)
    await new Promise(resolve => setTimeout(resolve, 0))
    const workbench = { update: vi.fn(async () => {}) }
    const canvas = { update: vi.fn(async () => {}) }
    controller.attachUi({ workbench, canvas })
    workbench.update.mockClear()
    canvas.update.mockClear()

    // 先发一帧合法遥测把 settings 收敛到已推送快照（canEnable=true）
    setup.emitTelemetry(testTelemetryState())

    const counts = countingSubscriptions(controller)

    const frame = testTelemetryState()
    for (let index = 0; index < 10; index += 1) setup.emitTelemetry(frame)

    expect(counts).toEqual({ settings: 0, workbench: 0, canvas: 0, records: 0 })
    expect(workbench.update).not.toHaveBeenCalled()
    expect(canvas.update).not.toHaveBeenCalled()
    await controller.dispose()
  })

  it('gate 字段变化时只通知 settings，不触碰其余状态链', async () => {
    const setup = harness()
    const controller = createLaneChangeController(setup.deps)
    await new Promise(resolve => setTimeout(resolve, 0))

    // 合法帧把 settings 收敛到 canEnable=true
    setup.emitTelemetry(testTelemetryState())
    expect(controller.settingsState.get().canEnable).toBe(true)

    const counts = countingSubscriptions(controller)

    const returning = returningTelemetryState()
    setup.emitTelemetry(returning)
    expect(controller.settingsState.get().canEnable).toBe(false)
    // 重复相同 gate 帧：不再广播
    setup.emitTelemetry(returning)
    // gate 恢复：恰好再广播一次
    setup.emitTelemetry(testTelemetryState())

    expect(counts).toEqual({ settings: 2, workbench: 0, canvas: 0, records: 0 })
    await controller.dispose()
  })

  it('enabled 时 gate 失效只触发一次 disable 并收敛完整 UI', async () => {
    const setup = harness()
    let resolveStop!: (value: { isActive: false; flightId: string }) => void
    setup.api.stopMode = vi.fn(() => new Promise<{ isActive: false; flightId: string }>((resolve) => {
      resolveStop = resolve
    }))
    const controller = createLaneChangeController(setup.deps)
    await new Promise(resolve => setTimeout(resolve, 0))
    await controller.settings.setEnabled({ enabled: true })
    const workbench = { update: vi.fn(async () => {}) }
    const canvas = { update: vi.fn(async () => {}) }
    controller.attachUi({ workbench, canvas })

    const returning = returningTelemetryState()
    for (let index = 0; index < 5; index += 1) setup.emitTelemetry(returning)
    await vi.waitFor(() => expect(setup.api.stopMode).toHaveBeenCalledOnce())

    resolveStop({ isActive: false, flightId: 'flight-1' })
    await vi.waitFor(() => {
      expect(controller.settingsState.get().enabled).toBe(false)
      expect(controller.workbenchState.get().panelVisible).toBe(false)
      expect(controller.canvasState.get().visible).toBe(false)
    })
    expect(workbench.update).toHaveBeenCalledWith({ visible: false })
    expect(canvas.update).toHaveBeenCalledWith({ visible: false, interactive: false })
    await controller.dispose()
  })

  it('恢复仅接受严格匹配当前 flight 的模式', async () => {
    const mismatch = harness()
    mismatch.api.getMode = vi.fn(async () => ({ isActive: true, flightId: 'old-flight' }))
    const first = createLaneChangeController(mismatch.deps)
    await first.recover()
    expect(first.settingsState.get().enabled).toBe(false)
    await first.dispose()

    const match = harness()
    match.api.getMode = vi.fn(async () => ({ isActive: true, flightId: 'flight-1' }))
    const second = createLaneChangeController(match.deps)
    await second.recover()
    expect(second.settingsState.get().enabled).toBe(true)
    await second.dispose()
  })

  it('刷新恢复 active 模式时先接管并停止遗留录像，再恢复为空闲态', async () => {
    const { api, deps } = harness()
    api.getMode = vi.fn(async () => ({ isActive: true, flightId: 'flight-1' }))
    const camera = attachCamera(deps, { recording: true })
    const controller = createLaneChangeController(deps)

    await controller.recover()

    expect(camera.acquireRecording).toHaveBeenCalledWith({ takeover: true })
    expect(camera.stop).toHaveBeenCalledOnce()
    expect(camera.dispose).toHaveBeenCalledOnce()
    expect(controller.settingsState.get().enabled).toBe(true)
    expect(controller.workbenchState.get()).toMatchObject({ captureStatus: 'idle', message: null })
    await controller.dispose()
  })

  it('遗留录像停止完成前不发布恢复状态', async () => {
    const { api, deps } = harness()
    api.getMode = vi.fn(async () => ({ isActive: true, flightId: 'flight-1' }))
    let releaseStop!: () => void
    attachCamera(deps, {
      recording: true,
      stop: () => new Promise<void>((resolve) => {
        releaseStop = resolve
      }),
    })
    const controller = createLaneChangeController(deps)

    const recovering = controller.recover()
    await vi.waitFor(() => expect(releaseStop).toBeTypeOf('function'))
    expect(controller.settingsState.get().enabled).toBe(false)
    releaseStop()
    await recovering

    expect(controller.settingsState.get().enabled).toBe(true)
    expect(controller.workbenchState.get().captureStatus).toBe('idle')
    await controller.dispose()
  })

  it('后端模式未开启或航次不匹配时不接管设备录像', async () => {
    const inactive = harness()
    const inactiveCamera = attachCamera(inactive.deps, { recording: true })
    const inactiveController = createLaneChangeController(inactive.deps)
    await inactiveController.recover()
    expect(inactiveCamera.acquireRecording).not.toHaveBeenCalled()
    await inactiveController.dispose()

    const mismatch = harness()
    mismatch.api.getMode = vi.fn(async () => ({ isActive: true, flightId: 'old-flight' }))
    const mismatchCamera = attachCamera(mismatch.deps, { recording: true })
    const mismatchController = createLaneChangeController(mismatch.deps)
    await mismatchController.recover()
    expect(mismatchCamera.acquireRecording).not.toHaveBeenCalled()
    await mismatchController.dispose()
  })

  it('停止遗留录像连续超时时重试一次后提示设备状态未收敛', async () => {
    const { api, deps, timeouts } = harness()
    api.getMode = vi.fn(async () => ({ isActive: true, flightId: 'flight-1' }))
    const show = vi.fn()
    Object.assign(deps, { notification: { show } })
    const camera = attachCamera(deps, {
      recording: true,
      stop: async () => {
        throw timeoutError()
      },
    })
    const controller = createLaneChangeController(deps)

    const recovering = controller.recover()
    for (const attempt of [1, 2]) {
      await vi.waitFor(() => expect(camera.stop).toHaveBeenCalledTimes(attempt))
      if (attempt < 2) {
        await vi.waitFor(() => expect(timeouts.size).toBeGreaterThan(0))
        for (const callback of [...timeouts.values()]) callback()
      }
    }
    await recovering

    expect(camera.stop).toHaveBeenCalledTimes(2)
    expect(camera.acquireRecording).toHaveBeenCalledTimes(2)
    expect(deps.logger.warn).toHaveBeenCalledWith('停止遗留录像失败，准备重试', expect.objectContaining({ attempt: 1 }))
    expect(controller.settingsState.get().enabled).toBe(true)
    expect(controller.workbenchState.get()).toMatchObject({
      captureStatus: 'idle',
      message: '恢复变道抓拍时停止遗留录像失败，请在相机控制中手动停止录像：stop failed',
    })
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ intent: 'error' }))
    expect(deps.logger.warn).toHaveBeenCalledWith('恢复变道抓拍时停止遗留录像失败', { message: 'stop failed' })
    await controller.dispose()
  })

  it('停止遗留录像首次失败后重试成功，不提示错误', async () => {
    const { api, deps, timeouts } = harness()
    api.getMode = vi.fn(async () => ({ isActive: true, flightId: 'flight-1' }))
    const show = vi.fn()
    Object.assign(deps, { notification: { show } })
    let stopCalls = 0
    const camera = attachCamera(deps, {
      recording: true,
      stop: async () => {
        stopCalls += 1
        if (stopCalls === 1) throw timeoutError()
      },
    })
    const controller = createLaneChangeController(deps)

    const recovering = controller.recover()
    await vi.waitFor(() => expect(camera.stop).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(timeouts.size).toBeGreaterThan(0))
    for (const callback of [...timeouts.values()]) callback()
    await recovering

    expect(camera.stop).toHaveBeenCalledTimes(2)
    expect(controller.settingsState.get().enabled).toBe(true)
    expect(controller.workbenchState.get()).toMatchObject({ captureStatus: 'idle', message: null })
    expect(show).not.toHaveBeenCalled()
    await controller.dispose()
  })

  it('重试前发现设备已停止录像则不再下发 stop', async () => {
    const { api, deps, timeouts } = harness()
    api.getMode = vi.fn(async () => ({ isActive: true, flightId: 'flight-1' }))
    let recording = true
    const camera = attachCamera(deps, {
      recording: () => recording,
      // 超时只代表结果未知：命令实际已生效，设备已停止录像
      stop: async () => {
        recording = false
        throw timeoutError()
      },
    })
    const controller = createLaneChangeController(deps)

    const recovering = controller.recover()
    await vi.waitFor(() => expect(camera.stop).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(timeouts.size).toBeGreaterThan(0))
    for (const callback of [...timeouts.values()]) callback()
    await recovering

    expect(camera.stop).toHaveBeenCalledTimes(1)
    expect(controller.settingsState.get().enabled).toBe(true)
    expect(controller.workbenchState.get()).toMatchObject({ captureStatus: 'idle', message: null })
    await controller.dispose()
  })

  it('退避等待期间会话重置则中止重试', async () => {
    const { api, deps, timeouts } = harness()
    api.getMode = vi.fn(async () => ({ isActive: true, flightId: 'flight-1' }))
    const camera = attachCamera(deps, {
      recording: true,
      stop: async () => {
        throw timeoutError()
      },
    })
    const controller = createLaneChangeController(deps)

    const recovering = controller.recover()
    await vi.waitFor(() => expect(camera.stop).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(timeouts.size).toBeGreaterThan(0))

    controller.resetSession()
    for (const callback of [...timeouts.values()]) callback()
    await recovering

    expect(camera.stop).toHaveBeenCalledTimes(1)
    expect(controller.settingsState.get().enabled).toBe(false)
    await controller.dispose()
  })

  it('非超时错误不重试并立即提示', async () => {
    const { api, deps, timeouts } = harness()
    api.getMode = vi.fn(async () => ({ isActive: true, flightId: 'flight-1' }))
    const camera = attachCamera(deps, {
      recording: true,
      stop: async () => {
        throw new Error('device rejected')
      },
    })
    const controller = createLaneChangeController(deps)

    await controller.recover()

    expect(camera.stop).toHaveBeenCalledTimes(1)
    expect(timeouts.size).toBe(0)
    expect(controller.workbenchState.get().message).toContain('device rejected')
    await controller.dispose()
  })

  it('接管录像期间会话重置则释放 lease 且不下发 stop', async () => {
    const { api, deps } = harness()
    api.getMode = vi.fn(async () => ({ isActive: true, flightId: 'flight-1' }))
    let releaseAcquire!: () => void
    const acquireGate = new Promise<void>((resolve) => {
      releaseAcquire = resolve
    })
    const camera = attachCamera(deps, { recording: true, acquireGate })
    const controller = createLaneChangeController(deps)

    const recovering = controller.recover()
    await vi.waitFor(() => expect(camera.acquireRecording).toHaveBeenCalledOnce())
    controller.resetSession()
    releaseAcquire()
    await recovering

    expect(camera.stop).not.toHaveBeenCalled()
    expect(camera.dispose).toHaveBeenCalledOnce()
    expect(controller.settingsState.get().enabled).toBe(false)
    await controller.dispose()
  })

  it('恢复 pending 后处理记录时不在驾驶舱轮询返航后产物', async () => {
    const { api, deps, timeouts } = harness()
    api.listEvents = vi.fn(async () => ({ total: 1, events: [{ eventId: 'e', eventKey: 'k', projectId: 'project-1', dockSn: 'dock-1', flightId: 'flight-1', objId: '1', collisionType: 'solid_line' as const, crossedAt: 1, postStatus: 'processing' as const, rejectReason: '', failureReason: '', createdAt: '' }] }))
    api.getMode = vi.fn(async () => ({ isActive: true, flightId: 'flight-1' }))
    const controller = createLaneChangeController(deps)
    await controller.recover()
    expect(api.listEvents).toHaveBeenCalledOnce()
    expect(timeouts.size).toBe(0)
    await controller.dispose()
    expect(timeouts.size).toBe(0)
  })

  it('列表恢复保留后端 failureReason，并以 rejectReason 兜底', async () => {
    const { api, deps } = harness()
    api.listEvents = vi.fn(async () => ({
      total: 2,
      events: [
        { eventId: 'failed', eventKey: 'failed-key', projectId: 'project-1', dockSn: 'dock-1', flightId: 'flight-1', objId: '1', collisionType: 'solid_line' as const, crossedAt: 2, postStatus: 'failed' as const, rejectReason: '驳回原因', failureReason: '处理失败', createdAt: '' },
        { eventId: 'rejected', eventKey: 'rejected-key', projectId: 'project-1', dockSn: 'dock-1', flightId: 'flight-1', objId: '2', collisionType: 'guide_area' as const, crossedAt: 1, postStatus: 'rejected' as const, rejectReason: '证据不足', failureReason: '', createdAt: '' },
      ],
    }))
    const controller = createLaneChangeController(deps)
    await controller.recover()
    expect(controller.recordsState.get().records).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventKey: 'failed-key', failureReason: '处理失败' }),
      expect.objectContaining({ eventKey: 'rejected-key', failureReason: '证据不足' }),
    ]))
    await controller.dispose()
  })

  it('stopMode 失败时保持 enabled、面板可见并展示错误', async () => {
    const { api, deps, notification } = harness()
    api.stopMode = vi.fn(async () => {
      throw new Error('backend down')
    })
    const controller = createLaneChangeController(deps)
    await new Promise(resolve => setTimeout(resolve, 0))
    await controller.settings.setEnabled({ enabled: true })
    await expect(controller.settings.setEnabled({ enabled: false })).rejects.toThrow('backend down')
    expect(controller.settingsState.get().enabled).toBe(true)
    expect(controller.workbenchState.get()).toMatchObject({ panelVisible: true, message: '变道抓拍关闭失败：backend down' })
    expect(notification.show).toHaveBeenCalledWith(expect.objectContaining({
      intent: 'error',
      message: expect.stringContaining('变道抓拍关闭失败'),
    }))
    api.stopMode = vi.fn(async () => ({ isActive: false as const, flightId: '' }))
    await controller.dispose()
  })

  it('startMode 失败时向用户提示开启失败并保持未开启', async () => {
    const { api, deps, notification } = harness()
    api.startMode = vi.fn(async () => {
      throw new Error('start-mode 响应状态非法')
    })
    const controller = createLaneChangeController(deps)
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(controller.settings.setEnabled({ enabled: true })).rejects.toThrow('start-mode 响应状态非法')
    expect(controller.settingsState.get().enabled).toBe(false)
    expect(controller.workbenchState.get().message).toBe('变道抓拍开启失败：start-mode 响应状态非法')
    expect(notification.show).toHaveBeenCalledWith(expect.objectContaining({
      intent: 'error',
      message: expect.stringContaining('变道抓拍开启失败'),
    }))
    await controller.dispose()
  })

  it('通知能力自身失败不影响开启错误传播', async () => {
    const { api, deps, notification } = harness()
    api.startMode = vi.fn(async () => {
      throw new Error('gateway down')
    })
    notification.show = vi.fn(async () => {
      throw new Error('notification transport failed')
    })
    const controller = createLaneChangeController(deps)
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(controller.settings.setEnabled({ enabled: true })).rejects.toThrow('gateway down')
    expect(notification.show).toHaveBeenCalled()
    await controller.dispose()
  })

  it('enable 响应迟到且期间 disable 时不会提交 enabled', async () => {
    const { api, deps } = harness()
    let resolveStart!: (value: { isActive: true; flightId: string }) => void
    api.startMode = vi.fn(() => new Promise<{ isActive: true; flightId: string }>((resolve) => {
      resolveStart = resolve
    }))
    const controller = createLaneChangeController(deps)
    await new Promise(resolve => setTimeout(resolve, 0))
    const enabling = controller.settings.setEnabled({ enabled: true })
    await vi.waitFor(() => expect(api.startMode).toHaveBeenCalled())
    await controller.settings.setEnabled({ enabled: false })
    resolveStart({ isActive: true, flightId: 'flight-1' })
    await enabling
    expect(controller.settingsState.get().enabled).toBe(false)
    expect(api.stopMode).toHaveBeenCalledWith({ projectId: 'project-1', dockSn: 'dock-1' })
    await controller.dispose()
  })

  it('reset 后忽略迟到列表响应且不重新调度轮询', async () => {
    const { api, deps, timeouts } = harness()
    let resolveList!: (value: Awaited<ReturnType<LaneChangeApi['listEvents']>>) => void
    api.getMode = vi.fn(async () => ({ isActive: true, flightId: 'flight-1' }))
    api.listEvents = vi.fn(() => new Promise<Awaited<ReturnType<LaneChangeApi['listEvents']>>>((resolve) => {
      resolveList = resolve
    }))
    const controller = createLaneChangeController(deps)
    const recovering = controller.recover()
    await vi.waitFor(() => expect(api.listEvents).toHaveBeenCalled())
    controller.resetSession()
    resolveList({ total: 1, events: [{ eventId: 'e', eventKey: 'k', projectId: 'project-1', dockSn: 'dock-1', flightId: 'flight-1', objId: '1', collisionType: 'solid_line', crossedAt: 1, postStatus: 'processing', rejectReason: '', failureReason: '', createdAt: '' }] })
    await recovering
    expect(controller.recordsState.get().records).toEqual([])
    expect(timeouts.size).toBe(0)
    await controller.dispose()
  })

  it('列表恢复按 flightId/eventKey 精确读取本地截图', async () => {
    const { api, deps } = harness()
    const url = vi.fn(async () => 'blob:restored')
    Object.assign(deps, { blobs: { put: async () => {}, url } })
    api.listEvents = vi.fn(async () => ({ total: 1, events: [{ eventId: 'event-1', eventKey: 'event-key', projectId: 'project-1', dockSn: 'dock-1', flightId: 'flight-1', objId: 'car', collisionType: 'solid_line' as const, crossedAt: 1, postStatus: 'verified' as const, rejectReason: '', failureReason: '', createdAt: '' }] }))
    const controller = createLaneChangeController(deps)
    await controller.recover()
    expect(url).toHaveBeenCalledWith('lane-change-snapshot:flight-1:event-key')
    expect(controller.recordsState.get().records[0]?.screenshotUrl).toBe('blob:restored')
    await controller.dispose()
  })
})

describe('lane-change controller 标注、Pointer 与事件上报', () => {
  function readyHarness () {
    const base = harness()
    interface TestDetectionFrame {
      frameId: string;
      capturedAt: number;
      targets: Array<{ targetId: string; type: string; state: string; bbox: { x: number; y: number; width: number; height: number } }>;
    }
    let detectionHandler: ((frame: TestDetectionFrame) => void) | undefined
    const pointerLease = { release: vi.fn(async () => {}), dispose: vi.fn(async () => {}), onRevoked: vi.fn(async () => ({ dispose: async () => {} })) }
    let clock = 1000
    Object.assign(base.deps, {
      now: () => {
        clock += 100
        return clock
      },
      camera: {
        getState: async () => ({ availability: { status: 'available' as const, reason: null }, mode: 'photo' as const, lens: 'wide' as const, zoom: 1, recording: false }),
        onStateChanged: async () => ({ dispose: async () => {} }),
        ensureMode: async () => {},
        switchLens: async () => {},
        ensureZoom: async () => {},
        boundingZoom: async () => {},
        takePhoto: async () => ({ accepted: true, capturedAt: 1 }),
        acquireRecording: async () => ({ stop: async () => {}, dispose: async () => {}, onRevoked: async () => ({ dispose: async () => {} }) }),
        captureFrame: vi.fn(async () => ({ blob: new Blob(['frame']), width: 100, height: 100, capturedAt: 1, geometrySnapshotId: 's' })),
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
        projectFromGround: vi.fn(async (_frameId: string, points: ReadonlyArray<{ lng: number; lat: number }>) => ({ capturedAt: 1, points: points.map(point => ({ x: point.lng, y: point.lat })) })),
      },
      sceneGeometry: {
        projectVideoToGround: async (points: ReadonlyArray<{ x: number; y: number }>) => ({ capturedAt: 1, points: points.map(point => ({ lng: point.x, lat: point.y, height: 30 })) }),
        projectGeoToVideo: async (points: ReadonlyArray<{ lng: number; lat: number }>) => ({ capturedAt: 1, points: points.map(point => ({ x: point.lng, y: point.lat })) }),
        projectSnapshotVideoToGround: async () => null,
        projectSnapshotGeoToVideo: async () => null,
        releaseSnapshot: async () => {},
      },
      aiConfig: {
        getState: vi.fn(async () => ({ availability: { status: 'available' as const, reason: null }, model: 'dji-visible', recognitionEnabled: true, targetTypes: ['vehicle'] })),
        onStateChanged: async () => ({ dispose: async () => {} }),
        ensure: vi.fn(async () => ({ confirmed: true, reason: null })),
      },
      pointer: { acquire: vi.fn(async () => ({ stream: 'DronePayload', ...pointerLease })) },
    })
    const emitFrame = (frame: TestDetectionFrame): void => detectionHandler?.(frame)
    const emitCrossing = (): void => {
      for (const y of [0.65, 0.60, 0.55, 0.42]) emitFrame({ frameId: `f-${y}`, capturedAt: clock, targets: [{ targetId: 'car-1', type: '3', state: 'tracked', bbox: { x: 0.4, y: y - 0.06, width: 0.12, height: 0.12 } }] })
    }
    return { ...base, pointerLease, emitCrossing, emitFrame }
  }

  async function startFlow (setup = readyHarness()) {
    const controller = createLaneChangeController(setup.deps)
    await controller.recover()
    await controller.settings.setEnabled({ enabled: true })
    await controller.workbench.beginDraw({ kind: 'solid-line' })
    await controller.canvas.addDraftPoint({ point: { x: 0.2, y: 0.5 } })
    await controller.canvas.addDraftPoint({ point: { x: 0.8, y: 0.5 } })
    await controller.canvas.finishDraft()
    await controller.workbench.finishEdit()
    await controller.workbench.toggleCapture()
    setup.emitCrossing()
    return { ...setup, controller }
  }

  async function preparedForCapture (setup = readyHarness()) {
    const controller = createLaneChangeController(setup.deps)
    await controller.recover()
    await controller.settings.setEnabled({ enabled: true })
    await controller.workbench.beginDraw({ kind: 'solid-line' })
    await controller.canvas.addDraftPoint({ point: { x: 0.2, y: 0.5 } })
    await controller.canvas.addDraftPoint({ point: { x: 0.8, y: 0.5 } })
    await controller.canvas.finishDraft()
    await controller.workbench.finishEdit()
    return { setup, controller }
  }

  it('开启抓拍自动开启车辆 AI 识别后才进入抓拍', async () => {
    const setup = readyHarness()
    const aiConfig = setup.deps.aiConfig as unknown as {
      ensure: ReturnType<typeof vi.fn>;
      getState: ReturnType<typeof vi.fn>;
    }
    const { controller } = await preparedForCapture(setup)
    // enable() 已调用过一次 ensure；此处只统计本次开启抓拍的 AI 门调用
    aiConfig.ensure.mockClear()

    await controller.workbench.toggleCapture()

    expect(aiConfig.ensure).toHaveBeenCalledWith({ model: 'dji-visible', recognitionEnabled: true, targetTypes: ['vehicle'] })
    expect(aiConfig.ensure).toHaveBeenCalledOnce()
    expect(controller.workbenchState.get().captureStatus).toBe('capturing')
    await controller.dispose()
  })

  it('开启抓拍时 AI ensure 拒绝则软失败：提示手动开启且不进入抓拍', async () => {
    const setup = readyHarness()
    const aiConfig = setup.deps.aiConfig as unknown as { ensure: ReturnType<typeof vi.fn> }
    const camera = setup.deps.camera as unknown as { acquireRecording: ReturnType<typeof vi.fn> }
    camera.acquireRecording = vi.fn(async () => ({ stop: async () => {}, dispose: async () => {}, onRevoked: async () => ({ dispose: async () => {} }) }))
    const { controller } = await preparedForCapture(setup)
    // 用户在原生面板关闭识别后点击开启抓拍：ensure 被拒绝
    aiConfig.ensure.mockResolvedValue({ confirmed: false, reason: 'DJI 可见光模型不可用' })

    await controller.workbench.toggleCapture()

    expect(camera.acquireRecording).not.toHaveBeenCalled()
    expect(controller.workbenchState.get()).toMatchObject({
      captureStatus: 'idle',
      captureBusy: false,
      message: 'AI 识别配置失败：DJI 可见光模型不可用，请手动开启后再开启抓拍',
    })
    expect(setup.notification.show).toHaveBeenCalledWith(expect.objectContaining({ intent: 'warning' }))
    await controller.dispose()
  })

  it('ensure 成功但复核未含 vehicle 时软失败', async () => {
    const setup = readyHarness()
    const aiConfig = setup.deps.aiConfig as unknown as { getState: ReturnType<typeof vi.fn> }
    const { controller } = await preparedForCapture(setup)
    // Provider 精确替换了目标类型：复核发现 vehicle 缺失
    aiConfig.getState.mockResolvedValue({ availability: { status: 'available' as const, reason: null }, model: 'dji-visible', recognitionEnabled: true, targetTypes: ['person'] })

    await controller.workbench.toggleCapture()

    expect(controller.workbenchState.get()).toMatchObject({
      captureStatus: 'idle',
      captureBusy: false,
      message: 'AI 识别配置失败：AI 识别未能启用“车”识别，请手动开启后再开启抓拍',
    })
    expect(setup.notification.show).toHaveBeenCalledWith(expect.objectContaining({ intent: 'warning' }))
    await controller.dispose()
  })

  it('开启抓拍时 AI ensure 抛错则软失败且不冒泡', async () => {
    const setup = readyHarness()
    const aiConfig = setup.deps.aiConfig as unknown as { ensure: ReturnType<typeof vi.fn> }
    const { controller } = await preparedForCapture(setup)
    aiConfig.ensure.mockRejectedValue(new Error('下发超时'))

    await expect(controller.workbench.toggleCapture()).resolves.toBeUndefined()

    expect(controller.workbenchState.get()).toMatchObject({
      captureStatus: 'idle',
      captureBusy: false,
      message: 'AI 识别配置失败：下发超时，请手动开启后再开启抓拍',
    })
    await controller.dispose()
  })

  it('手绘标注持有 Pointer，完成后释放并可进入抓拍', async () => {
    const setup = readyHarness()
    const controller = createLaneChangeController(setup.deps)
    await controller.recover()
    await controller.settings.setEnabled({ enabled: true })
    await controller.workbench.beginDraw({ kind: 'solid-line' })
    await controller.canvas.addDraftPoint({ point: { x: 0.2, y: 0.5 } })
    await controller.canvas.addDraftPoint({ point: { x: 0.8, y: 0.5 } })
    await controller.canvas.finishDraft()
    expect(controller.workbenchState.get().annotations[0]).toMatchObject({ name: '实线 1', coordinateMode: 'geo' })
    await controller.workbench.finishEdit()
    expect(setup.pointerLease.release).toHaveBeenCalledOnce()
    await controller.dispose()
  })

  it('抓拍启动等待录像期间关闭模式，不会被迟到响应重新开启', async () => {
    const setup = readyHarness()
    let resolveRecording!: (lease: { stop(): Promise<void>; dispose(): Promise<void>; onRevoked(): Promise<{ dispose(): Promise<void> }> }) => void
    const stop = vi.fn(async () => {})
    const camera = setup.deps.camera as unknown as { acquireRecording: ReturnType<typeof vi.fn> }
    camera.acquireRecording = vi.fn(() => new Promise((resolve) => {
      resolveRecording = resolve
    }))
    const controller = createLaneChangeController(setup.deps)
    await controller.recover()
    await controller.settings.setEnabled({ enabled: true })
    await controller.workbench.beginDraw({ kind: 'solid-line' })
    await controller.canvas.addDraftPoint({ point: { x: 0.2, y: 0.5 } })
    await controller.canvas.addDraftPoint({ point: { x: 0.8, y: 0.5 } })
    await controller.canvas.finishDraft()
    await controller.workbench.finishEdit()

    const starting = controller.workbench.toggleCapture()
    await vi.waitFor(() => expect(camera.acquireRecording).toHaveBeenCalledOnce())
    await controller.settings.setEnabled({ enabled: false })
    resolveRecording({ stop, dispose: async () => {}, onRevoked: async () => ({ dispose: async () => {} }) })
    await starting

    expect(stop).toHaveBeenCalledOnce()
    expect(controller.workbenchState.get()).toMatchObject({ enabled: false, captureStatus: 'idle' })
    await controller.dispose()
  })

  it('每个检测帧批量投影全部 geo 标注', async () => {
    const setup = readyHarness()
    const controller = createLaneChangeController(setup.deps)
    await controller.recover()
    await controller.settings.setEnabled({ enabled: true })
    for (const y of [0.4, 0.6]) {
      await controller.workbench.beginDraw({ kind: 'solid-line' })
      await controller.canvas.addDraftPoint({ point: { x: 0.2, y } })
      await controller.canvas.addDraftPoint({ point: { x: 0.8, y } })
      await controller.canvas.finishDraft()
      await controller.workbench.finishEdit()
    }
    await controller.workbench.toggleCapture()
    setup.emitFrame({ frameId: 'batch-frame', capturedAt: 1, targets: [{ targetId: 'car-1', type: '3', state: 'tracked', bbox: { x: 0.4, y: 0.3, width: 0.1, height: 0.1 } }] })
    const projectFromGround = setup.deps.detection!.projectFromGround as ReturnType<typeof vi.fn>
    await vi.waitFor(() => expect(projectFromGround).toHaveBeenCalledOnce())
    expect(projectFromGround.mock.calls[0]?.[1]).toHaveLength(4)
    await controller.dispose()
  })

  it('同 ID 有→无→无→有时空目标帧仍投影 geo 标线并检出跨线', async () => {
    const setup = readyHarness()
    const controller = createLaneChangeController(setup.deps)
    await controller.recover()
    await controller.settings.setEnabled({ enabled: true })
    await controller.workbench.beginDraw({ kind: 'solid-line' })
    await controller.canvas.addDraftPoint({ point: { x: 0.2, y: 0.5 } })
    await controller.canvas.addDraftPoint({ point: { x: 0.8, y: 0.5 } })
    await controller.canvas.finishDraft()
    await controller.workbench.finishEdit()
    await controller.workbench.toggleCapture()

    const projectFromGround = setup.deps.detection!.projectFromGround as ReturnType<typeof vi.fn>
    const emitAndWait = async (frameId: string, targets: Parameters<typeof setup.emitFrame>[0]['targets']) => {
      const expectedCalls = projectFromGround.mock.calls.length + 1
      setup.emitFrame({ frameId, capturedAt: 1, targets })
      await vi.waitFor(() => expect(projectFromGround).toHaveBeenCalledTimes(expectedCalls))
      await Promise.resolve()
    }
    const car = (y: number) => [{
      targetId: 'car-sparse',
      type: '3',
      state: 'tracked',
      bbox: { x: 0.4, y: y - 0.06, width: 0.12, height: 0.12 },
    }]

    await emitAndWait('sparse-0', car(0.65))
    await emitAndWait('sparse-1', car(0.60))
    await emitAndWait('sparse-2', car(0.55))
    await emitAndWait('sparse-3', [])
    await emitAndWait('sparse-4', [])
    await emitAndWait('sparse-5', car(0.42))

    await vi.waitFor(() => expect(setup.api.createEvent).toHaveBeenCalledOnce())
    expect(projectFromGround).toHaveBeenCalledTimes(6)
    await controller.dispose()
  })

  it('投影存在 null 时整条标注失效，不用剩余点拼接检测', async () => {
    const setup = readyHarness()
    const detection = setup.deps.detection as unknown as { projectFromGround: ReturnType<typeof vi.fn> }
    detection.projectFromGround.mockImplementation(async (_frameId: string, points: ReadonlyArray<{ lng: number; lat: number }>) => ({
      capturedAt: 1,
      points: points.map((point, index) => index === 1 ? null : { x: point.lng, y: point.lat }),
    }))
    const controller = createLaneChangeController(setup.deps)
    await controller.recover()
    await controller.settings.setEnabled({ enabled: true })
    await controller.workbench.beginDraw({ kind: 'solid-line' })
    await controller.canvas.addDraftPoint({ point: { x: 0.2, y: 0.5 } })
    await controller.canvas.addDraftPoint({ point: { x: 0.8, y: 0.5 } })
    await controller.canvas.finishDraft()
    await controller.workbench.finishEdit()
    await controller.workbench.toggleCapture()
    setup.emitCrossing()
    await vi.waitFor(() => expect(detection.projectFromGround).toHaveBeenCalled())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(setup.api.createEvent).not.toHaveBeenCalled()
    await controller.dispose()
  })

  it('检测内部使用帧入队时间，但事件上报使用冻结的飞机时间', async () => {
    const setup = readyHarness()
    let wallClock = 1000
    Object.assign(setup.deps, { now: () => wallClock })
    let projectionCalls = 0
    let resolveLastProjection!: (value: { capturedAt: number; points: Array<{ x: number; y: number }> }) => void
    const detection = setup.deps.detection as unknown as { projectFromGround: ReturnType<typeof vi.fn> }
    detection.projectFromGround.mockImplementation(async (_frameId: string, points: ReadonlyArray<{ lng: number; lat: number }>) => {
      projectionCalls += 1
      const value = { capturedAt: wallClock, points: points.map(point => ({ x: point.lng, y: point.lat })) }
      if (projectionCalls < 4) return value
      return await new Promise((resolve) => {
        resolveLastProjection = resolve
      })
    })
    const controller = createLaneChangeController(setup.deps)
    await controller.recover()
    await controller.settings.setEnabled({ enabled: true })
    await controller.workbench.beginDraw({ kind: 'solid-line' })
    await controller.canvas.addDraftPoint({ point: { x: 0.2, y: 0.5 } })
    await controller.canvas.addDraftPoint({ point: { x: 0.8, y: 0.5 } })
    await controller.canvas.finishDraft()
    await controller.workbench.finishEdit()
    await controller.workbench.toggleCapture()

    for (const [index, y] of [0.65, 0.60, 0.55].entries()) {
      wallClock = 1000 + index * 100
      setup.emitFrame({ frameId: `time-${index}`, capturedAt: 1, targets: [{ targetId: 'car-1', type: '3', state: 'tracked', bbox: { x: 0.4, y: y - 0.06, width: 0.12, height: 0.12 } }] })
      await vi.waitFor(() => expect(detection.projectFromGround).toHaveBeenCalledTimes(index + 1))
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    wallClock = 1300
    setup.emitFrame({ frameId: 'time-3', capturedAt: 1, targets: [{ targetId: 'car-1', type: '3', state: 'tracked', bbox: { x: 0.4, y: 0.36, width: 0.12, height: 0.12 } }] })
    await vi.waitFor(() => expect(detection.projectFromGround).toHaveBeenCalledTimes(4))
    wallClock = 9000
    resolveLastProjection({ capturedAt: wallClock, points: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }] })

    await vi.waitFor(() => expect(setup.api.createEvent).toHaveBeenCalledOnce())
    expect((setup.api.createEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].crossedAt).toBe(1720000000000)
    await controller.dispose()
  })

  it('飞机时间缺失时变道事件回退冻结的浏览器时间并记录诊断', async () => {
    const setup = readyHarness()
    const telemetry = setup.deps.telemetry as NonNullable<LaneChangeControllerDeps['telemetry']>
    const state = testTelemetryState()
    Object.assign(telemetry, { getState: async () => ({ ...state, drone: { ...state.drone, timestamp: null } }) })
    const { controller } = await startFlow(setup)
    await vi.waitFor(() => expect(setup.api.createEvent).toHaveBeenCalledOnce())

    const crossedAt = (setup.api.createEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].crossedAt
    expect(crossedAt).toBeTypeOf('number')
    expect(crossedAt).not.toBe(1720000000000)
    expect(setup.deps.logger.warn).toHaveBeenCalledWith('飞机时间戳不可用，变道事件回退浏览器时间', {
      operation: 'h_laneChange_createEvent',
      fallback: crossedAt,
    })
    await controller.dispose()
  })

  it('明确离开满 1 秒后再次跨线会生成第二个事件', async () => {
    const setup = readyHarness()
    const { controller } = await startFlow(setup)
    await vi.waitFor(() => expect(setup.api.createEvent).toHaveBeenCalledOnce())

    for (let index = 0; index < 12; index += 1) {
      setup.emitFrame({ frameId: `clear-${index}`, capturedAt: 1, targets: [{ targetId: 'car-1', type: '3', state: 'tracked', bbox: { x: 0.4, y: 0.29, width: 0.12, height: 0.12 } }] })
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    for (const [index, y] of [0.35, 0.4, 0.45, 0.6].entries()) {
      setup.emitFrame({ frameId: `return-${index}`, capturedAt: 1, targets: [{ targetId: 'car-1', type: '3', state: 'tracked', bbox: { x: 0.4, y: y - 0.06, width: 0.12, height: 0.12 } }] })
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    await vi.waitFor(() => expect(setup.api.createEvent).toHaveBeenCalledTimes(2))
    const eventKeys = (setup.api.createEvent as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0].eventKey)
    expect(new Set(eventKeys).size).toBe(2)
    await controller.dispose()
  })

  it('50301 使用同一冻结 payload 重试一次并回填 eventId', async () => {
    const setup = readyHarness()
    const unavailable = Object.assign(new Error('暂不可用'), { detail: { gatewayCode: 50301 } })
    let attempt = 0
    setup.api.createEvent = vi.fn(async (payload) => {
      attempt += 1
      if (attempt === 1) throw unavailable
      return { eventId: 'event-1', eventKey: payload.eventKey, postStatus: 'pending_video' as const, createdAt: '', created: true }
    })
    const { controller } = await startFlow(setup)
    await vi.waitFor(() => expect(setup.api.createEvent).toHaveBeenCalledOnce())
    const firstPayload = (setup.api.createEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    for (const callback of [...setup.timeouts.values()]) callback()
    await vi.waitFor(() => expect(setup.api.createEvent).toHaveBeenCalledTimes(2))
    expect((setup.api.createEvent as ReturnType<typeof vi.fn>).mock.calls[1]![0]).toEqual(firstPayload)
    await controller.dispose()
  })

  it('业务拒绝不重试并将本地记录置为 failed', async () => {
    const setup = readyHarness()
    setup.api.createEvent = vi.fn(async () => {
      throw Object.assign(new Error('参数错误'), { detail: { gatewayCode: 40006 } })
    })
    const { controller } = await startFlow(setup)
    await vi.waitFor(() => expect(controller.recordsState.get().records[0]?.failureReason).toBe('参数错误'))
    expect(setup.api.createEvent).toHaveBeenCalledOnce()
    expect(controller.recordsState.get().records[0]).toMatchObject({ postStatus: 'failed', failureReason: '参数错误' })
    await controller.dispose()
  })

  it('disable 清理事件重试 timer，旧回调不会再次提交', async () => {
    const setup = readyHarness()
    setup.api.createEvent = vi.fn(async () => {
      throw new TypeError('network failed')
    })
    const { controller } = await startFlow(setup)
    await vi.waitFor(() => expect(setup.api.createEvent).toHaveBeenCalledOnce())
    await controller.settings.setEnabled({ enabled: false })
    for (const callback of [...setup.timeouts.values()]) callback()
    await Promise.resolve()
    expect(setup.api.createEvent).toHaveBeenCalledOnce()
    expect(controller.recordsState.get().records[0]).toMatchObject({ postStatus: 'failed', failureReason: '抓拍模式已关闭，事件上报已取消' })
    await controller.dispose()
  })

  it('截图期间关闭模式时丢弃迟到确认，不写记录也不提交事件', async () => {
    const setup = readyHarness()
    let resolveFrame!: (frame: { blob: Blob; width: number; height: number; capturedAt: number; geometrySnapshotId: string }) => void
    let resolveStop!: () => void
    const camera = setup.deps.camera as unknown as { captureFrame: ReturnType<typeof vi.fn> }
    camera.captureFrame = vi.fn(() => new Promise((resolve) => {
      resolveFrame = resolve
    }))
    Object.assign(camera, {
      acquireRecording: async () => ({
        stop: () => new Promise<void>((resolve) => {
          resolveStop = resolve
        }),
        dispose: async () => {},
        onRevoked: async () => ({ dispose: async () => {} }),
      }),
    })
    const { controller } = await startFlow(setup)
    await vi.waitFor(() => expect(camera.captureFrame).toHaveBeenCalledOnce())
    const disabling = controller.settings.setEnabled({ enabled: false })
    await vi.waitFor(() => expect(resolveStop).toBeTypeOf('function'))
    resolveFrame({ blob: new Blob(['frame']), width: 100, height: 100, capturedAt: 1, geometrySnapshotId: 's' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(setup.api.createEvent).not.toHaveBeenCalled()
    expect(controller.recordsState.get().records).toEqual([])
    resolveStop()
    await disabling
    await controller.dispose()
  })

  it('confirm 截图叠绘标线与涉事车辆 bbox，合成图入库', async () => {
    const setup = readyHarness()
    const put = vi.fn(async (_key: string, _blob: Blob) => {})
    Object.assign(setup.deps, { blobs: { put, url: async () => 'blob:composed' } })
    const composited = new Blob(['composited'])
    vi.mocked(composeSnapshotOverlay).mockClear()
    vi.mocked(composeSnapshotOverlay).mockResolvedValueOnce(composited)
    const { controller } = await startFlow(setup)

    await vi.waitFor(() => expect(put).toHaveBeenCalledOnce())
    const [blobKey, blob] = put.mock.calls[0] ?? []
    expect(blobKey).toMatch(/^lane-change-snapshot:flight-1:/)
    expect(blob).toBe(composited)

    const [frameBlob, overlay] = vi.mocked(composeSnapshotOverlay).mock.calls[0] ?? []
    expect(frameBlob).toBeInstanceOf(Blob)
    expect(overlay).toMatchObject({
      kind: 'line',
      normalizedPoints: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }],
      bbox: { cx: 0.46, cy: 0.42, w: 0.12, h: 0.12 },
    })
    await controller.dispose()
  })

  it('叠绘失败降级裸截图，不阻断记录写入与事件上报', async () => {
    const setup = readyHarness()
    const put = vi.fn(async (_key: string, _blob: Blob) => {})
    Object.assign(setup.deps, { blobs: { put, url: async () => 'blob:raw' } })
    vi.mocked(composeSnapshotOverlay).mockClear()
    const { controller } = await startFlow(setup)

    await vi.waitFor(() => expect(put).toHaveBeenCalledOnce())
    const [frameBlob] = vi.mocked(composeSnapshotOverlay).mock.calls[0] ?? []
    expect(put.mock.calls[0]?.[1]).toBe(frameBlob)
    expect(setup.deps.logger.warn).toHaveBeenCalledWith('变道截图叠绘失败，降级使用裸截图')

    await vi.waitFor(() => expect(setup.api.createEvent).toHaveBeenCalledOnce())
    expect(controller.recordsState.get().records[0]?.screenshotUrl).toBe('blob:raw')
    await controller.dispose()
  })
})
