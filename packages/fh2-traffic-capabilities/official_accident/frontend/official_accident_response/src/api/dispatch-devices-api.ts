// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { GeoPoint, PlatformProjectDevice } from 'fh2-plugin-sdk'
import type { DispatchDevice } from '../workflow/types'

/**
 * 派遣设备数据源：平台 `platform:devices` 能力返回的规范化项目设备。
 *
 * 拓扑协议、数字状态码、机型 key、电量来源和 EA340 结构等宿主细节全部封在
 * 平台 Provider 内；本文件只保留事故快处的派遣策略。
 */

/** 与原生派遣支持的机型范围一致：Dock 1/2/3/4（含 EA340 机库）。 */
const DISPATCHABLE_DOCK_MODELS = new Set(['dock', 'dock-2', 'dock-3', 'dock-4'])

/** 与原生派遣一致的机场不可用状态：现场/远程调试、升级、离线。 */
const BLOCKED_DOCK_STATES = new Set(['on-site-debugging', 'remote-debugging', 'upgrading', 'offline'])

/** 舱内待机/关机视为空闲，状态点显示绿色。 */
const IDLE_AIRCRAFT_STATES = new Set(['standby', 'shutdown-in-dock'])

export interface DispatchDevicesApi {
  list(projectId: string, alarmPosition: GeoPoint): Promise<readonly DispatchDevice[]>;
}

/** platform:devices 能力 Client 的最小结构；便于单测注入。 */
export interface ProjectDevicesSource {
  getProjectDevices(input: { readonly projectId: string }): Promise<readonly PlatformProjectDevice[]>;
}

export function createDispatchDevicesApi (devices: ProjectDevicesSource | undefined): DispatchDevicesApi {
  return {
    async list (projectId, alarmPosition) {
      if (!devices) throw new Error('平台设备能力（platform:devices）不可用，无法加载派遣设备')
      const projectDevices = await devices.getProjectDevices({ projectId })
      const candidates = projectDevices.flatMap(device => toDispatchDevice(device, alarmPosition))
      // 可派遣设备优先；同组内距离近的在前。
      return [...candidates].sort((left, right) => {
        if (left.executingTask !== right.executingTask) return left.executingTask ? 1 : -1
        return (left.distance ?? Infinity) - (right.distance ?? Infinity)
      })
    },
  }
}

function toDispatchDevice (device: PlatformProjectDevice, alarmPosition: GeoPoint): readonly DispatchDevice[] {
  const { aircraft, dock, gateway } = device
  if (!dock || !aircraft) return []
  if (dock.connectionState !== 'online') return []
  if (!DISPATCHABLE_DOCK_MODELS.has(dock.model.id)) return []
  if (BLOCKED_DOCK_STATES.has(dock.operatingState)) return []
  // 起飞位置优先取飞机自身上报；0/0 是 topo 的无定位哨兵值，回退机场位置。
  const startPosition = dispatchPosition(aircraft.position) ?? dispatchPosition(dock.position)
  if (!startPosition) return []
  const executingTask = dock.operatingState === 'executing-task'
  return [{
    dockSn: dock.sn,
    droneSn: aircraft.sn,
    gatewaySn: gateway?.sn ?? dock.sn,
    droneCallsign: aircraft.callsign ?? aircraft.sn,
    dockCallsign: dock.callsign ?? dock.sn,
    droneModelName: aircraft.model.name ?? '--',
    dockModelName: dock.model.name ?? '--',
    startPosition,
    takeoffReferenceAltitude: dock.position?.height ?? 0,
    idle: aircraft.inDock && IDLE_AIRCRAFT_STATES.has(aircraft.operatingState),
    executingTask,
    ...(aircraft.remainFlightTimeSeconds === null ? {} : { remainFlightTime: aircraft.remainFlightTimeSeconds }),
    ...(aircraft.batteryPercent === null ? {} : { batteryPercent: aircraft.batteryPercent }),
    batteryCharging: aircraft.batteryCharging,
    distance: haversineDistance(alarmPosition.lat, alarmPosition.lng, startPosition.lat, startPosition.lng),
  }]
}

function dispatchPosition (position: GeoPoint | null): GeoPoint | null {
  return position !== null && (position.lat !== 0 || position.lng !== 0) ? position : null
}

function haversineDistance (lat1: number, lng1: number, lat2: number, lng2: number): number {
  const earthRadius = 6371000
  const radians = Math.PI / 180
  const deltaLat = (lat2 - lat1) * radians
  const deltaLng = (lng2 - lng1) * radians
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(deltaLng / 2) ** 2
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
}
