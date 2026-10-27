// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { TelemetryState } from 'fh2-plugin-sdk'

export function telemetryState (patch: Partial<TelemetryState> = {}): TelemetryState {
  return {
    device: {
      roster: {
        droneSn: 'drone-1',
        gatewaySn: 'gateway-1',
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
        height: 100,
        elevation: 80,
        attitude_head: 0,
        horizontal_speed: 0,
        vertical_speed: 0,
        home_distance: 0,
      },
      mode: { source: 'drc', mode_code: 1 },
      link: { drcReady: true, timeDiffDeviceAndWeb: 0 },
      timestamp: 1720000000000,
    },
    dock: {
      status: {
        source: 'dock',
        sn: 'dock-1',
        mode_code: 1,
        cover_state: 1,
        putter_state: 0,
        drone_in_dock: 0,
        emergency_stop_state: 0,
        alarm_state: 0,
      },
      position: { source: 'dock', longitude: 114, latitude: 22.5, height: 12 },
      environment: null,
    },
    payload: { camera: null, gimbal: null, laser: null },
    control: {
      flight: { hasControl: false, ownerUserId: null },
      payload: { hasControl: false, ownerUserId: null },
    },
    ...patch,
  }
}
