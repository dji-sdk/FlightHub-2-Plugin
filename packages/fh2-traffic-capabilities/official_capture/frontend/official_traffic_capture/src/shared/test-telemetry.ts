// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { TelemetryState } from 'fh2-plugin-sdk'

export function testTelemetryState (): TelemetryState {
  return {
    device: { roster: { droneSn: 'drone-1', gatewaySn: 'dock-1', gatewayType: 'dock', dockSn: 'dock-1', baseStationSn: null, rcSn: null, isNetworked: true } },
    drone: {
      pose: { source: 'drc', longitude: 113.9, latitude: 22.5, height: 80, elevation: 60, attitude_head: 0, horizontal_speed: 0, vertical_speed: 0, home_distance: 0 },
      mode: { source: 'drc', mode_code: 3 },
      link: { drcReady: true, timeDiffDeviceAndWeb: 0 },
      timestamp: 1720000000000,
    },
    dock: {
      status: { source: 'dock', sn: 'dock-1', mode_code: 1, cover_state: 1, putter_state: 0, drone_in_dock: 0, emergency_stop_state: 0, alarm_state: 0 },
      position: { source: 'dock', longitude: 113.9, latitude: 22.5, height: 20 },
      environment: null,
    },
    payload: { camera: null, gimbal: { yaw: 0, pitch: 0, roll: 0, locked: false }, laser: { longitude: 113.9, latitude: 22.5, altitude: 30, distance: 10 } },
    control: { flight: { hasControl: true, ownerUserId: null }, payload: { hasControl: true, ownerUserId: null } },
  }
}
