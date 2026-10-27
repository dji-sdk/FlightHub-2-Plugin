// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { GeoPoint, TelemetryState } from 'fh2-plugin-sdk'

function finite (value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function dronePosition (state: TelemetryState): GeoPoint | null {
  const pose = state.drone.pose
  return pose && finite(pose.longitude) && finite(pose.latitude) && finite(pose.height)
    ? { lng: pose.longitude, lat: pose.latitude, height: pose.height }
    : null
}

export function dockPosition (state: TelemetryState): GeoPoint | null {
  const position = state.dock.position
  return position && finite(position.longitude) && finite(position.latitude)
    ? {
        lng: position.longitude,
        lat: position.latitude,
        height: finite(position.height) ? position.height : 0,
      }
    : null
}

export function laserPosition (state: TelemetryState): GeoPoint | null {
  const laser = state.payload.laser
  return laser && finite(laser.longitude) && finite(laser.latitude) && finite(laser.altitude)
    ? { lng: laser.longitude, lat: laser.latitude, height: laser.altitude }
    : null
}

export function droneInSky (state: TelemetryState): boolean {
  const inDock = state.dock.status?.drone_in_dock
  return inDock === 0
    || (inDock === null && finite(state.drone.pose?.elevation) && state.drone.pose.elevation > 1)
}
