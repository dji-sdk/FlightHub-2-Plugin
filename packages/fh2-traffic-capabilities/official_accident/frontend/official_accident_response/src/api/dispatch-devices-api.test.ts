// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import type {
  GeoPoint,
  PlatformAircraftOperatingState,
  PlatformDeviceModelId,
  PlatformDockOperatingState,
  PlatformProjectDevice,
} from 'fh2-plugin-sdk'
import { createDispatchDevicesApi } from './dispatch-devices-api'
import type { ProjectDevicesSource } from './dispatch-devices-api'

const ALARM_POSITION: GeoPoint = { lat: 22.55, lng: 113.95, height: 0 }

interface DeviceFixture {
  dockSn?: string;
  droneSn?: string;
  dockModelId?: string;
  droneModelName?: string | null;
  dockCallsign?: string | null;
  droneCallsign?: string | null;
  dockConnectionState?: 'online' | 'offline' | 'unknown';
  dockOperatingState?: string;
  aircraftOperatingState?: string;
  inDock?: boolean;
  batteryPercent?: number | null;
  batteryCharging?: boolean;
  remainFlightTimeSeconds?: number | null;
  aircraftPosition?: GeoPoint | null;
  dockPosition?: { lat: number; lng: number; height: number } | null;
  gatewaySn?: string | null;
}

function makeDevice (fixture: DeviceFixture = {}): PlatformProjectDevice {
  const dockSn = fixture.dockSn ?? 'dock-1'
  const droneSn = fixture.droneSn ?? 'drone-1'
  return {
    aircraft: {
      sn: droneSn,
      model: { id: 'm4td', name: fixture.droneModelName === undefined ? 'Matrice 4TD' : fixture.droneModelName, modelKey: '0-100-1' },
      callsign: fixture.droneCallsign === undefined ? '应急无人机' : fixture.droneCallsign,
      connectionState: 'offline',
      position: fixture.aircraftPosition === undefined
        ? { lat: 22.1, lng: 113.9, height: 20 }
        : fixture.aircraftPosition,
      inDock: fixture.inDock ?? true,
      operatingState: (fixture.aircraftOperatingState ?? 'standby') as PlatformAircraftOperatingState,
      batteryPercent: fixture.batteryPercent === undefined ? 85 : fixture.batteryPercent,
      batteryCharging: fixture.batteryCharging ?? false,
      remainFlightTimeSeconds: fixture.remainFlightTimeSeconds === undefined ? 1250 : fixture.remainFlightTimeSeconds,
    },
    dock: {
      sn: dockSn,
      model: { id: (fixture.dockModelId ?? 'dock-3') as PlatformDeviceModelId, name: 'DJI Dock 3', modelKey: '3-3-0' },
      callsign: fixture.dockCallsign === undefined ? '福田一号机场' : fixture.dockCallsign,
      connectionState: fixture.dockConnectionState ?? 'online',
      position: fixture.dockPosition === undefined
        ? { lat: 22.1, lng: 113.9, height: 10 }
        : fixture.dockPosition,
      operatingState: (fixture.dockOperatingState ?? 'idle') as PlatformDockOperatingState,
    },
    gateway: fixture.gatewaySn === undefined
      ? { sn: dockSn, model: { id: 'dock-3', name: 'DJI Dock 3', modelKey: '3-3-0' }, callsign: '福田一号机场', connectionState: 'online' }
      : (fixture.gatewaySn === null ? null : { sn: fixture.gatewaySn, model: { id: 'dock-3', name: 'DJI Dock 3', modelKey: '3-3-0' }, callsign: null, connectionState: 'online' }),
  }
}

function makeSource (devices: readonly PlatformProjectDevice[]): ProjectDevicesSource {
  return {
    getProjectDevices: async ({ projectId }) => {
      expect(projectId).toBe('project-1')
      return devices
    },
  }
}

describe('createDispatchDevicesApi', () => {
  it('映射规范化 DTO 到派遣设备：呼号回退 SN、机型名回退 --、距离计算', async () => {
    const api = createDispatchDevicesApi(makeSource([
      makeDevice({
        droneCallsign: null,
        dockCallsign: null,
        droneModelName: null,
      }),
    ]))
    const devices = await api.list('project-1', ALARM_POSITION)
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({
      dockSn: 'dock-1',
      droneSn: 'drone-1',
      gatewaySn: 'dock-1',
      droneCallsign: 'drone-1',
      dockCallsign: 'dock-1',
      droneModelName: '--',
      dockModelName: 'DJI Dock 3',
      startPosition: { lat: 22.1, lng: 113.9, height: 20 },
      takeoffReferenceAltitude: 10,
      idle: true,
      executingTask: false,
      remainFlightTime: 1250,
      batteryPercent: 85,
      batteryCharging: false,
    })
    expect(devices[0]?.distance).toBeGreaterThan(0)
  })

  it('舱内待机/关机视为空闲，其余状态为作业中', async () => {
    const api = createDispatchDevicesApi(makeSource([
      makeDevice({ dockSn: 'dock-standby', aircraftOperatingState: 'standby' }),
      makeDevice({ dockSn: 'dock-shutdown', aircraftOperatingState: 'shutdown-in-dock', batteryPercent: 96 }),
      makeDevice({ dockSn: 'dock-working', aircraftOperatingState: 'working' }),
      makeDevice({ dockSn: 'dock-out', aircraftOperatingState: 'standby', inDock: false }),
    ]))
    const devices = await api.list('project-1', ALARM_POSITION)
    const idleBySn = new Map(devices.map(device => [device.dockSn, device.idle]))
    expect(idleBySn.get('dock-standby')).toBe(true)
    expect(idleBySn.get('dock-shutdown')).toBe(true)
    expect(idleBySn.get('dock-working')).toBe(false)
    expect(idleBySn.get('dock-out')).toBe(false)
  })

  it('过滤离线机场、不支持机型与不可用状态', async () => {
    const api = createDispatchDevicesApi(makeSource([
      makeDevice({ dockSn: 'dock-offline', dockConnectionState: 'offline' }),
      makeDevice({ dockSn: 'dock-unknown-model', dockModelId: 'unknown' }),
      makeDevice({ dockSn: 'dock-debug', dockOperatingState: 'on-site-debugging' }),
      makeDevice({ dockSn: 'dock-remote-debug', dockOperatingState: 'remote-debugging' }),
      makeDevice({ dockSn: 'dock-upgrading', dockOperatingState: 'upgrading' }),
      makeDevice({ dockSn: 'dock-state-offline', dockOperatingState: 'offline' }),
    ]))
    expect(await api.list('project-1', ALARM_POSITION)).toHaveLength(0)
  })

  it('机场执行任务时保留展示并禁止选择', async () => {
    const api = createDispatchDevicesApi(makeSource([
      makeDevice({ dockSn: 'dock-executing', dockOperatingState: 'executing-task', aircraftOperatingState: 'working', inDock: false }),
    ]))
    const devices = await api.list('project-1', ALARM_POSITION)
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({ dockSn: 'dock-executing', executingTask: true, idle: false })
  })

  it('缺少机场或飞机、缺少起降位置的条目被排除', async () => {
    const api = createDispatchDevicesApi(makeSource([
      { ...makeDevice(), dock: null },
      { ...makeDevice(), aircraft: null },
      makeDevice({ dockSn: 'dock-no-pos', dockPosition: null, aircraftPosition: null }),
    ]))
    expect(await api.list('project-1', ALARM_POSITION)).toHaveLength(0)
  })

  it('飞机未上报位置时回退机场位置；gateway 缺失时回退机场 SN', async () => {
    const api = createDispatchDevicesApi(makeSource([
      makeDevice({
        dockSn: 'dock-fallback',
        aircraftPosition: null,
        dockPosition: { lat: 22.2, lng: 113.92, height: 15 },
        gatewaySn: null,
      }),
    ]))
    const devices = await api.list('project-1', ALARM_POSITION)
    expect(devices[0]).toMatchObject({
      startPosition: { lat: 22.2, lng: 113.92, height: 15 },
      takeoffReferenceAltitude: 15,
      gatewaySn: 'dock-fallback',
    })
  })

  it('飞机上报 0/0 时回退机场位置', async () => {
    const api = createDispatchDevicesApi(makeSource([
      makeDevice({
        aircraftPosition: { lat: 0, lng: 0, height: 93.6 },
        dockPosition: { lat: 22.793078, lng: 114.358382, height: 48.5 },
      }),
    ]))
    const devices = await api.list('project-1', ALARM_POSITION)
    expect(devices[0]?.startPosition).toEqual({ lat: 22.793078, lng: 114.358382, height: 48.5 })
  })

  it('飞机和机场均为 0/0 时排除设备', async () => {
    const api = createDispatchDevicesApi(makeSource([
      makeDevice({
        aircraftPosition: { lat: 0, lng: 0, height: 93.6 },
        dockPosition: { lat: 0, lng: 0, height: 48.5 },
      }),
    ]))
    expect(await api.list('project-1', ALARM_POSITION)).toHaveLength(0)
  })

  it('未知电量与剩余时长省略字段；网联飞机的 gateway 是飞机自身', async () => {
    const api = createDispatchDevicesApi(makeSource([
      makeDevice({ dockSn: 'dock-nulls', batteryPercent: null, remainFlightTimeSeconds: null, gatewaySn: 'drone-1' }),
    ]))
    const devices = await api.list('project-1', ALARM_POSITION)
    expect(devices[0]).toMatchObject({ dockSn: 'dock-nulls', gatewaySn: 'drone-1' })
    expect(devices[0]?.batteryPercent).toBeUndefined()
    expect(devices[0]?.remainFlightTime).toBeUndefined()
  })

  it('可派遣设备排在执行中设备之前，同组内距离近的在前', async () => {
    const api = createDispatchDevicesApi(makeSource([
      makeDevice({ dockSn: 'executing-near', dockOperatingState: 'executing-task', aircraftPosition: null, dockPosition: { lat: 22.54, lng: 113.94, height: 10 } }),
      makeDevice({ dockSn: 'available-far', aircraftPosition: null, dockPosition: { lat: 22.1, lng: 113.9, height: 10 } }),
      makeDevice({ dockSn: 'available-near', aircraftPosition: null, dockPosition: { lat: 22.5, lng: 113.93, height: 10 } }),
      makeDevice({ dockSn: 'executing-far', dockOperatingState: 'executing-task', aircraftPosition: null, dockPosition: { lat: 22.0, lng: 113.9, height: 10 } }),
    ]))
    const devices = await api.list('project-1', { ...ALARM_POSITION, lat: 22.56 })
    expect(devices.map(device => device.dockSn)).toEqual([
      'available-near',
      'available-far',
      'executing-near',
      'executing-far',
    ])
  })

  it('能力缺失时明确报错而不是返回空列表', async () => {
    const api = createDispatchDevicesApi(undefined)
    await expect(api.list('project-1', ALARM_POSITION)).rejects.toThrow('platform:devices')
  })

  it('能力调用错误原样抛出', async () => {
    const api = createDispatchDevicesApi({
      getProjectDevices: async () => {
        throw new Error('拓扑接口请求失败（code: 40400）')
      },
    })
    await expect(api.list('project-1', ALARM_POSITION)).rejects.toThrow('code: 40400')
  })
})
