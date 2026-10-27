// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { TelemetryState } from 'fh2-plugin-sdk'

function finite (value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function gatewaySn (state: TelemetryState | undefined): string | null {
  return state?.device.roster?.gatewaySn ?? null
}

export function modeCode (state: TelemetryState | undefined): number | null {
  return state?.drone.mode?.mode_code ?? null
}

export function droneTimestamp (state: TelemetryState | undefined): number | null {
  const timestamp = state?.drone.timestamp
  return finite(timestamp) ? timestamp : null
}

export function dronePosition (state: TelemetryState | undefined): { lng: number; lat: number; height: number } | null {
  const pose = state?.drone.pose
  return pose && finite(pose.longitude) && finite(pose.latitude) && finite(pose.height)
    ? { lng: pose.longitude, lat: pose.latitude, height: pose.height }
    : null
}

export function laserPosition (state: TelemetryState | undefined): { lng: number; lat: number; height: number } | null {
  const laser = state?.payload.laser
  return laser && finite(laser.longitude) && finite(laser.latitude) && finite(laser.altitude)
    ? { lng: laser.longitude, lat: laser.latitude, height: laser.altitude }
    : null
}
