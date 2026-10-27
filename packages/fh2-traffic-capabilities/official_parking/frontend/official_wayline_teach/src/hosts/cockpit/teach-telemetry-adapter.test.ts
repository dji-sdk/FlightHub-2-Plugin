// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type {
  AiConfigState,
  CockpitContextState,
  PluginCapabilityClient,
  TelemetryState,
} from 'fh2-plugin-sdk'
import {
  createTeachTelemetryAdapter,
  toTeachTelemetryState,
} from './teach-telemetry-adapter'

const context: CockpitContextState = {
  organizationId: 'organization-1',
  projectId: 'project-1',
  flightId: 'flight-1',
  droneSn: 'drone-1',
  gatewaySn: 'gateway-1',
  alertExecutionId: null,
  liveReady: true,
}

const telemetry: TelemetryState = {
  device: {
    roster: {
      droneSn: 'telemetry-drone',
      gatewaySn: 'telemetry-gateway',
      gatewayType: 'dock',
      dockSn: 'dock-1',
      baseStationSn: null,
      rcSn: null,
      isNetworked: true,
    },
  },
  drone: {
    pose: {
      source: 'drc',
      longitude: 113.9,
      latitude: 22.5,
      height: 171.6,
      elevation: 30,
      attitude_head: 99,
      horizontal_speed: 8,
      vertical_speed: -1,
      home_distance: 100,
    },
    mode: null,
    link: { drcReady: true, timeDiffDeviceAndWeb: 0 },
    timestamp: 1000,
  },
  dock: { status: null, position: null, environment: null },
  payload: {
    camera: {
      source: 'drc',
      camera_index: '0',
      camera_mode: 0,
      photo_state: 0,
      recording_state: 0,
      record_time: 0,
      zoom_factor: 2,
      remain_photo_num: 10,
      remain_record_duration: 100,
      lens: 'zoom',
    },
    gimbal: { pitch: -30, yaw: -20, roll: 0, locked: false },
    laser: null,
  },
  control: {
    flight: { hasControl: true, ownerUserId: 'user-1' },
    payload: { hasControl: true, ownerUserId: 'user-1' },
  },
}

const aiConfig: AiConfigState = {
  availability: { status: 'available', reason: null },
  model: 'dji-visible',
  recognitionEnabled: true,
  targetTypes: ['vehicle', 'person', 'moving-target'],
}

describe('示教遥测适配器', () => {
  it('在插件内转换 WGS84 高度、云台偏航、焦距和示教 AI 类型', () => {
    expect(toTeachTelemetryState({ context, telemetry, aiConfig, capturedAt: 2000 })).toEqual({
      capturedAt: 2000,
      source: 'drc',
      projectId: 'project-1',
      flightId: 'flight-1',
      dockSn: 'dock-1',
      droneSn: 'drone-1',
      gatewaySn: 'gateway-1',
      longitude: 113.9,
      latitude: 22.5,
      height: 171.6,
      cameraYaw: -20,
      gimbalPitch: -30,
      focalLength: 48,
      horizontalSpeed: 8,
      verticalSpeed: -1,
      aiAvailable: true,
      aiRecognitionOn: true,
      aiTargetTypes: ['car', 'person'],
    })
  })

  it('组合通用能力并在任一来源变化时生成新快照', async () => {
    const handlers = new Map<string, () => void>()
    const disposable = () => ({ dispose: vi.fn(async () => {}) })
    const contextCapability = {
      getState: vi.fn(async () => context),
      onStateChanged: vi.fn(async (handler: (state: CockpitContextState) => void) => {
        handlers.set('context', () => handler(context))
        return disposable()
      }),
    } satisfies Pick<PluginCapabilityClient<'cockpit:context'>, 'getState' | 'onStateChanged'>
    const telemetryCapability = {
      getState: vi.fn(async () => telemetry),
      onStateChanged: vi.fn(async (handler: (event: { readonly source: 'drone'; readonly state: TelemetryState }) => void) => {
        handlers.set('telemetry', () => handler({ source: 'drone', state: telemetry }))
        return disposable()
      }),
    } satisfies Pick<PluginCapabilityClient<'cockpit:telemetry'>, 'getState' | 'onStateChanged'>
    const aiConfigCapability = {
      getState: vi.fn(async () => aiConfig),
      onStateChanged: vi.fn(async (handler: (state: AiConfigState) => void) => {
        handlers.set('ai-config', () => handler(aiConfig))
        return disposable()
      }),
    } satisfies Pick<PluginCapabilityClient<'cockpit:ai-config'>, 'getState' | 'onStateChanged'>
    const onError = vi.fn()
    const adapter = await createTeachTelemetryAdapter({
      context: contextCapability,
      telemetry: telemetryCapability,
      aiConfig: aiConfigCapability,
      onError,
    })
    const listener = vi.fn()
    adapter.onStateChanged(listener)

    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(expect.objectContaining({ source: 'snapshot' })))
    listener.mockClear()

    handlers.get('telemetry')?.()

    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      source: 'telemetry',
      state: expect.objectContaining({ projectId: 'project-1', height: 171.6 }),
    })))
    expect(onError).not.toHaveBeenCalled()
    await adapter.dispose()
  })
})
