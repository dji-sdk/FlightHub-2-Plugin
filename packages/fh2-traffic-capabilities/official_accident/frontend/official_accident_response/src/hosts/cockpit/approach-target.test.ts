// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginCapabilityClient,
  TrackedTimers,
} from 'fh2-plugin-sdk'
import { createApproachTarget } from './approach-target'
import { telemetryState } from './test-telemetry'

const timers: TrackedTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
}

afterEach(() => vi.useRealTimers())

describe('approach controller', () => {
  it('lookAt 后等待云台转到位，只有到位后的新鲜激光才触发 flyTo，到达后云台朝下', async () => {
    vi.useFakeTimers()
    const target = { lng: 113.9, lat: 22.5, height: 8 }
    let currentState = telemetryState()
    const withLaser = telemetryState({
      drone: { ...telemetryState().drone, pose: { ...telemetryState().drone.pose!, longitude: target.lng, latitude: target.lat, height: target.height } },
      payload: { ...telemetryState().payload, laser: { longitude: target.lng, latitude: target.lat, altitude: target.height, distance: 10 } },
    })
    let onTelemetryChanged: ((event: { source: 'payload.laser'; state: ReturnType<typeof telemetryState> }) => void) | undefined
    const telemetry = {
      getState: vi.fn(async () => currentState),
      onStateChanged: vi.fn(async (handler) => {
        onTelemetryChanged = handler as typeof onTelemetryChanged
        return { dispose: vi.fn() }
      }),
    } satisfies PluginCapabilityClient<'cockpit:telemetry'>
    const geometry = {
      projectVideoToGround: vi.fn(async () => ({
        capturedAt: 10,
        points: [{ lng: 113.9001, lat: 22.5001, height: 8 }],
      })),
      projectGeoToVideo: vi.fn(),
      projectSnapshotVideoToGround: vi.fn(async () => null),
      projectSnapshotGeoToVideo: vi.fn(async () => null),
      releaseSnapshot: vi.fn(async () => {}),
    } satisfies PluginCapabilityClient<'cockpit:scene-geometry'>
    const gimbal = {
      reset: vi.fn(async () => {}),
      lookAt: vi.fn(async () => {
        onTelemetryChanged?.({ source: 'payload.laser', state: currentState })
      }),
    } satisfies PluginCapabilityClient<'cockpit:gimbal'>
    const flight = {
      acquireControl: vi.fn(async () => {}),
      releaseControl: vi.fn(),
      flyTo: vi.fn(async () => {}),
      emergencyStop: vi.fn(),
      returnHome: vi.fn(),
      returnHomeCancel: vi.fn(),
    } satisfies PluginCapabilityClient<'cockpit:flight-control'>
    const onProjectionSample = vi.fn()
    const controller = createApproachTarget({
      telemetry,
      geometry,
      gimbal,
      flight,
      timers,
      onRunningChanged: () => {},
      onProjectionSample,
    })

    // lookAt 期间到达的"转动途中"激光帧：云台尚未到位，不该被采纳
    const operation = controller.execute({ videoPoint: { x: 0.5, y: 0.4 }, stream: 'DronePayload', targetAgl: 5 })
    await vi.advanceTimersByTimeAsync(100)
    expect(flight.flyTo).not.toHaveBeenCalled()

    // 云台转到位后（3.2s）才有新激光帧
    setTimeout(() => {
      currentState = withLaser
      onTelemetryChanged?.({ source: 'payload.laser', state: withLaser })
    }, 3200)
    await vi.advanceTimersByTimeAsync(3500)
    await operation

    expect(gimbal.lookAt).toHaveBeenCalledWith({ x: 0.5, y: 0.4 }, { locked: true })
    expect(flight.acquireControl).toHaveBeenCalledWith('all')
    expect(flight.flyTo).toHaveBeenCalledWith([{ ...target, height: 28 }], { maxSpeed: 14 })
    expect(geometry.projectVideoToGround).toHaveBeenCalledWith(
      [{ x: 0.5, y: 0.4 }],
      { groundHeight: 8 },
    )
    await vi.advanceTimersByTimeAsync(2000)
    expect(gimbal.reset).toHaveBeenCalledWith('down')
    await vi.waitFor(() => expect(onProjectionSample).toHaveBeenCalledWith(expect.objectContaining({
      capturedAt: 10,
      laserTarget: target,
      projectedTarget: { lng: 113.9001, lat: 22.5001, height: 8 },
      heightErrorMeters: 0,
    })))
  })

  it('lookAt 后固定等待内不发 flyTo：转动途中激光帧不触发飞行', async () => {
    vi.useFakeTimers()
    const target = { lng: 113.9, lat: 22.5, height: 8 }
    let onTelemetryChanged: ((event: { source: 'payload.laser'; state: ReturnType<typeof telemetryState> }) => void) | undefined
    const withLaser = telemetryState({
      drone: { ...telemetryState().drone, pose: { ...telemetryState().drone.pose!, longitude: target.lng, latitude: target.lat, height: target.height } },
      control: { flight: { hasControl: true, ownerUserId: null }, payload: { hasControl: true, ownerUserId: null } },
      payload: { ...telemetryState().payload, laser: { longitude: target.lng, latitude: target.lat, altitude: target.height, distance: 10 } },
    })
    const telemetry = {
      getState: vi.fn(async () => withLaser),
      onStateChanged: vi.fn(async (handler) => {
        onTelemetryChanged = handler as typeof onTelemetryChanged
        return { dispose: vi.fn() }
      }),
    } satisfies PluginCapabilityClient<'cockpit:telemetry'>
    const geometry = {
      projectVideoToGround: vi.fn(async () => ({
        capturedAt: 10,
        points: [{ lng: 113.9001, lat: 22.5001, height: 8 }],
      })),
      projectGeoToVideo: vi.fn(),
      projectSnapshotVideoToGround: vi.fn(async () => null),
      projectSnapshotGeoToVideo: vi.fn(async () => null),
      releaseSnapshot: vi.fn(async () => {}),
    } satisfies PluginCapabilityClient<'cockpit:scene-geometry'>
    const gimbal = {
      reset: vi.fn(),
      lookAt: vi.fn(async () => {
        onTelemetryChanged?.({ source: 'payload.laser', state: withLaser })
      }),
    } satisfies PluginCapabilityClient<'cockpit:gimbal'>
    const flight = {
      acquireControl: vi.fn(),
      releaseControl: vi.fn(),
      flyTo: vi.fn(),
      emergencyStop: vi.fn(),
      returnHome: vi.fn(),
      returnHomeCancel: vi.fn(),
    } satisfies PluginCapabilityClient<'cockpit:flight-control'>
    const controller = createApproachTarget({ telemetry, geometry, gimbal, flight, timers, onRunningChanged: () => {} })

    const operation = controller.execute({ videoPoint: { x: 0.5, y: 0.4 }, stream: 'DronePayload', targetAgl: 20 })
    await vi.advanceTimersByTimeAsync(1500)
    expect(flight.flyTo).not.toHaveBeenCalled()
    expect(geometry.projectVideoToGround).not.toHaveBeenCalled()

    setTimeout(() => {
      onTelemetryChanged?.({ source: 'payload.laser', state: withLaser })
    }, 1700)
    await vi.advanceTimersByTimeAsync(2500)
    await operation
    expect(flight.flyTo).toHaveBeenCalledWith([{ ...target, height: 28 }], { maxSpeed: 14 })
  })

  it('固定等待加轮询窗口内没有新激光目标时安全失败，不下发飞行命令', async () => {
    vi.useFakeTimers()
    const telemetry = {
      getState: vi.fn(async () => telemetryState()),
      onStateChanged: vi.fn(async () => ({ dispose: vi.fn() })),
    } satisfies PluginCapabilityClient<'cockpit:telemetry'>
    const geometry = {
      projectVideoToGround: vi.fn(),
      projectGeoToVideo: vi.fn(),
      projectSnapshotVideoToGround: vi.fn(async () => null),
      projectSnapshotGeoToVideo: vi.fn(async () => null),
      releaseSnapshot: vi.fn(async () => {}),
    } satisfies PluginCapabilityClient<'cockpit:scene-geometry'>
    const gimbal = {
      reset: vi.fn(),
      lookAt: vi.fn(async () => {}),
    } satisfies PluginCapabilityClient<'cockpit:gimbal'>
    const flight = {
      acquireControl: vi.fn(),
      releaseControl: vi.fn(),
      flyTo: vi.fn(),
      emergencyStop: vi.fn(),
      returnHome: vi.fn(),
      returnHomeCancel: vi.fn(),
    } satisfies PluginCapabilityClient<'cockpit:flight-control'>
    const controller = createApproachTarget({ telemetry, geometry, gimbal, flight, timers, onRunningChanged: () => {} })
    const operation = controller.execute({ videoPoint: { x: 0.5, y: 0.5 }, stream: 'DronePayload', targetAgl: 30 })
    const assertion = expect(operation).rejects.toThrow('激光测距未返回新目标')
    await vi.advanceTimersByTimeAsync(8200)
    await assertion
    expect(flight.flyTo).not.toHaveBeenCalled()
    expect(geometry.projectVideoToGround).not.toHaveBeenCalled()
  })

  it('tools 投影失败只上报诊断，仍使用激光 GPS 下发 flyTo', async () => {
    vi.useFakeTimers()
    const target = { lng: 113.9, lat: 22.5, height: 8 }
    let currentState = telemetryState()
    const withLaser = telemetryState({
      drone: { ...telemetryState().drone, pose: { ...telemetryState().drone.pose!, longitude: target.lng, latitude: target.lat, height: target.height } },
      control: { flight: { hasControl: true, ownerUserId: null }, payload: { hasControl: true, ownerUserId: null } },
      payload: { ...telemetryState().payload, laser: { longitude: target.lng, latitude: target.lat, altitude: target.height, distance: 10 } },
    })
    let onTelemetryChanged: ((event: { source: 'payload.laser'; state: ReturnType<typeof telemetryState> }) => void) | undefined
    const telemetry = {
      getState: vi.fn(async () => currentState),
      onStateChanged: vi.fn(async (handler) => {
        onTelemetryChanged = handler as typeof onTelemetryChanged
        return { dispose: vi.fn() }
      }),
    } satisfies PluginCapabilityClient<'cockpit:telemetry'>
    const projectionError = new Error('SEI 暂不可用')
    const geometry = {
      projectVideoToGround: vi.fn(async () => {
        throw projectionError
      }),
      projectGeoToVideo: vi.fn(),
      projectSnapshotVideoToGround: vi.fn(async () => null),
      projectSnapshotGeoToVideo: vi.fn(async () => null),
      releaseSnapshot: vi.fn(async () => {}),
    } satisfies PluginCapabilityClient<'cockpit:scene-geometry'>
    const gimbal = {
      reset: vi.fn(async () => {}),
      lookAt: vi.fn(async () => {
        onTelemetryChanged?.({ source: 'payload.laser', state: currentState })
      }),
    } satisfies PluginCapabilityClient<'cockpit:gimbal'>
    const flight = {
      acquireControl: vi.fn(),
      releaseControl: vi.fn(),
      flyTo: vi.fn(async () => {}),
      emergencyStop: vi.fn(),
      returnHome: vi.fn(),
      returnHomeCancel: vi.fn(),
    } satisfies PluginCapabilityClient<'cockpit:flight-control'>
    const onProjectionError = vi.fn()
    const controller = createApproachTarget({
      telemetry,
      geometry,
      gimbal,
      flight,
      timers,
      onRunningChanged: () => {},
      onProjectionError,
    })

    const operation = controller.execute({ videoPoint: { x: 0.5, y: 0.4 }, stream: 'DronePayload', targetAgl: 20 })
    setTimeout(() => {
      currentState = withLaser
      onTelemetryChanged?.({ source: 'payload.laser', state: withLaser })
    }, 3200)
    await vi.advanceTimersByTimeAsync(3500)
    await operation

    expect(flight.flyTo).toHaveBeenCalledWith([{ ...target, height: 28 }], { maxSpeed: 14 })
    await vi.waitFor(() => expect(onProjectionError).toHaveBeenCalledWith(projectionError))
  })

  it('非主负载直播直接拒绝，不触发云台或飞控命令', async () => {
    const telemetry = {
      getState: vi.fn(async () => telemetryState()),
      onStateChanged: vi.fn(async () => ({ dispose: vi.fn() })),
    } satisfies PluginCapabilityClient<'cockpit:telemetry'>
    const geometry = {
      projectVideoToGround: vi.fn(),
      projectGeoToVideo: vi.fn(),
      projectSnapshotVideoToGround: vi.fn(async () => null),
      projectSnapshotGeoToVideo: vi.fn(async () => null),
      releaseSnapshot: vi.fn(async () => {}),
    } satisfies PluginCapabilityClient<'cockpit:scene-geometry'>
    const gimbal = {
      reset: vi.fn(),
      lookAt: vi.fn(),
    } satisfies PluginCapabilityClient<'cockpit:gimbal'>
    const flight = {
      acquireControl: vi.fn(),
      releaseControl: vi.fn(),
      flyTo: vi.fn(),
      emergencyStop: vi.fn(),
      returnHome: vi.fn(),
      returnHomeCancel: vi.fn(),
    } satisfies PluginCapabilityClient<'cockpit:flight-control'>
    const controller = createApproachTarget({ telemetry, geometry, gimbal, flight, timers, onRunningChanged: () => {} })

    await expect(controller.execute({ videoPoint: { x: 0.5, y: 0.5 }, stream: 'Fpv', targetAgl: 30 }))
      .rejects.toThrow('仅支持主负载直播画面')
    expect(gimbal.lookAt).not.toHaveBeenCalled()
    expect(flight.acquireControl).not.toHaveBeenCalled()
    expect(flight.flyTo).not.toHaveBeenCalled()
  })
})
