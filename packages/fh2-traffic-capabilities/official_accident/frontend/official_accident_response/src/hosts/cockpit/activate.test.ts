// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { CockpitContextState } from 'fh2-plugin-sdk'
import type { AccidentCockpitContext } from '../../types'

import { activate, canApproachEvent, readPluginEventId } from './activate'
import { telemetryState } from './test-telemetry'

const returnViewMocks = vi.hoisted(() => ({
  get: vi.fn(() => ({ viewId: 'return-route-panel', initialState: null })),
  handle: vi.fn(async () => {}),
}))

vi.mock('../../views/return-route-panel/contract', () => ({
  returnRoutePanelView: returnViewMocks,
}))

const context: CockpitContextState = {
  organizationId: 'organization-1',
  projectId: 'project-1',
  droneSn: 'drone-1',
  gatewaySn: 'gateway-1',
  alertExecutionId: null,
  liveReady: true,
}

describe('cockpit plugin event location', () => {
  it('只读取 pluginEventId query 并解码', () => {
    expect(readPluginEventId({ search: '?droneSn=D1&pluginEventId=event%2F1&alertId=legacy' })).toBe('event/1')
    expect(readPluginEventId({ search: '?alertId=legacy' })).toBe('')
  })

  it('事件允许且遥测就绪时才允许抵近（不再依赖直播就绪信号）', () => {
    const ready = {
      context,
      pluginEventId: 'event-1',
      allowApproach: true,
      droneInSky: true,
      approachRunning: false,
    }
    expect(canApproachEvent(ready)).toBe(true)
    expect(canApproachEvent({ ...ready, context: { ...context, liveReady: false } })).toBe(true)
    expect(canApproachEvent({ ...ready, allowApproach: false })).toBe(false)
    expect(canApproachEvent({ ...ready, droneInSky: false })).toBe(false)
    expect(canApproachEvent({ ...ready, approachRunning: true })).toBe(false)
    expect(canApproachEvent({ ...ready, pluginEventId: '' })).toBe(false)
  })

  it('装配返航 action、overlay、View handler 与平台航线预览', async () => {
    const contributions = new Map<string, Record<string, unknown>>()
    const waylinePreview = {
      show: vi.fn(async () => ({ update: vi.fn(async () => {}), dispose: vi.fn(async () => {}) })),
    }
    const telemetry = telemetryState({
      drone: { ...telemetryState().drone, pose: { ...telemetryState().drone.pose!, longitude: 114, latitude: 22, height: 80 } },
      dock: { ...telemetryState().dock, position: { source: 'dock', longitude: 114.1, latitude: 22.1, height: 10 } },
      control: {
        flight: { hasControl: true, ownerUserId: null },
        payload: { hasControl: true, ownerUserId: null },
      },
    })
    const emergencyStop = vi.fn(async () => {})
    const flightTask = {
      getState: vi.fn(async () => ({ kind: null, flightId: null, wayline: null, inFlightWayline: null })),
      onStateChanged: vi.fn(async () => ({ dispose: vi.fn() })),
      startInFlightWayline: vi.fn(),
      cancelInFlightWayline: vi.fn(),
    }
    let previewAvailable = true
    const capability = (id: string) => {
      if (id === 'cockpit:context') return { getState: vi.fn(async () => context), onStateChanged: vi.fn(async () => ({ dispose: vi.fn() })) }
      if (id === 'platform:location') return { getState: vi.fn(async () => ({ search: '?pluginEventId=event-1', pathname: '/', hash: '' })), onStateChanged: vi.fn(async () => ({ dispose: vi.fn() })) }
      if (id === 'cockpit:telemetry') return { getState: vi.fn(async () => telemetry), onStateChanged: vi.fn(async () => ({ dispose: vi.fn() })) }
      if (id === 'cockpit:flight-control') return { emergencyStop, acquireControl: vi.fn(), releaseControl: vi.fn(), flyTo: vi.fn() }
      if (id === 'cockpit:gimbal') return { reset: vi.fn(), lookAt: vi.fn() }
      if (id === 'cockpit:scene-geometry') return { projectVideoToGround: vi.fn(async () => null) }
      if (id === 'platform:notification') return { show: vi.fn() }
      if (id === 'cockpit:flight-task') return flightTask
      if (id === 'platform:wpmz') return { parseCoordinates: vi.fn(async () => []) }
      if (id === 'platform:wayline-preview') return previewAvailable ? waylinePreview : undefined
      return undefined
    }
    const ctx = {
      config: { enableMultiAngle: false, flowName: 'flow' },
      capabilities: {
        get: vi.fn(async (id: string) => capability(id)),
      },
      extensions: {
        contribute: vi.fn(async (id: string, implementation: Record<string, unknown>) => {
          contributions.set(id, implementation)
          return { update: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
        }),
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      timers: { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(), setInterval: vi.fn(), clearInterval: vi.fn() },
      apiCall: vi.fn(async () => ({ code: 0, data: { eventId: 'event-1', eventType: '警情', occurredAt: 1, status: 'completed', priority: 'high', rawPayload: {} } })),
    } as unknown as AccidentCockpitContext

    const lifecycle = await activate(ctx)

    expect(contributions.get('accident-return-route-action')).toMatchObject({ label: '沿路网返航', visible: false })
    expect(contributions.get('accident-return-route-panel')).toMatchObject({ interactive: true, placement: 'bottom-right' })
    expect(returnViewMocks.handle).toHaveBeenCalledOnce()
    await lifecycle?.dispose?.()

    contributions.clear()
    previewAvailable = false
    const lifecycleWithoutPreview = await activate(ctx)
    expect(contributions.has('accident-return-route-action')).toBe(true)
    const action = contributions.get('accident-return-route-action') as { onTrigger: () => Promise<void> }
    await action.onTrigger()
    expect(emergencyStop).toHaveBeenCalled()
    await lifecycleWithoutPreview?.dispose?.()
  })
})
