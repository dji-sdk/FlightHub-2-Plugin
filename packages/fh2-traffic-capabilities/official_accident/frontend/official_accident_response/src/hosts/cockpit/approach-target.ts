// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type {
  PluginCapabilityClient,
  TelemetryState,
  TrackedTimers,
  VideoPoint,
} from 'fh2-plugin-sdk'
import { dronePosition, laserPosition } from './telemetry'

export interface ApproachController {
  readonly running: boolean;
  execute(input: { readonly videoPoint: VideoPoint; readonly stream: string; readonly targetAgl: number }): Promise<void>;
  dispose(): void;
}

export interface GeometryProjectionSample {
  readonly capturedAt: number;
  readonly laserTarget: { readonly lng: number; readonly lat: number; readonly height: number };
  readonly projectedTarget: { readonly lng: number; readonly lat: number; readonly height: number };
  readonly horizontalErrorMeters: number;
  readonly heightErrorMeters: number;
}

function distanceMeters (
  left: { readonly lng: number; readonly lat: number },
  right: { readonly lng: number; readonly lat: number },
): number {
  const radians = (value: number): number => value * Math.PI / 180
  const lat1 = radians(left.lat)
  const lat2 = radians(right.lat)
  const deltaLat = lat2 - lat1
  const deltaLng = radians(right.lng - left.lng)
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
}

/** lookAt 后云台转动到位的固定等待：转动途中激光会打到中间地物，需吸收完再取新鲜帧基线（先等云台转动）。 */
const GIMBAL_SETTLE_WAIT_MS = 3000

export function createApproachTarget (input: {
  readonly telemetry: PluginCapabilityClient<'cockpit:telemetry'>;
  readonly geometry?: PluginCapabilityClient<'cockpit:scene-geometry'>;
  readonly gimbal: PluginCapabilityClient<'cockpit:gimbal'>;
  readonly flight: PluginCapabilityClient<'cockpit:flight-control'>;
  readonly timers: TrackedTimers;
  readonly onRunningChanged: (running: boolean) => void;
  readonly onProjectionSample?: (sample: GeometryProjectionSample) => void;
  readonly onProjectionError?: (error: unknown) => void;
  readonly now?: () => number;
}): ApproachController {
  const now = input.now ?? Date.now
  let sequence = 0
  let running = false
  let laserRevision = 0
  const telemetryEvents = input.telemetry.onStateChanged((event) => {
    if (event.source === 'payload.laser') laserRevision++
  })

  const setRunning = (value: boolean): void => {
    if (running === value) return
    running = value
    input.onRunningChanged(value)
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    input.timers.setTimeout(resolve, ms)
  })

  const waitForFreshLaser = async (revision: number, run: number): Promise<TelemetryState> => {
    const deadline = now() + 5000
    while (now() < deadline) {
      if (run !== sequence) throw new Error('抵近目标已取消')
      const current = await input.telemetry.getState()
      if (laserRevision > revision && laserPosition(current)) return current
      await sleep(200)
    }
    throw new Error('激光测距未返回新目标，已取消抵近')
  }

  const monitorArrival = async (
    target: { readonly lng: number; readonly lat: number },
    run: number,
  ): Promise<void> => {
    const deadline = now() + 120000
    while (now() < deadline) {
      if (run !== sequence) return
      const telemetry = await input.telemetry.getState()
      const position = dronePosition(telemetry)
      if (position && distanceMeters(position, target) < 10) {
        await input.gimbal.reset('down')
        if (run === sequence) setRunning(false)
        return
      }
      await sleep(1000)
    }
    if (run === sequence) setRunning(false)
  }

  const collectProjectionSample = async (
    videoPoint: VideoPoint,
    laserTarget: { readonly lng: number; readonly lat: number; readonly height: number },
  ): Promise<void> => {
    if (!input.geometry) return
    try {
      const projection = await input.geometry.projectVideoToGround(
        [videoPoint],
        { groundHeight: laserTarget.height },
      )
      const projectedTarget = projection?.points[0]
      if (!projection || !projectedTarget) {
        input.onProjectionError?.(new Error('Cockpit tools 当前无法生成目标投影'))
        return
      }
      input.onProjectionSample?.({
        capturedAt: projection.capturedAt,
        laserTarget,
        projectedTarget,
        horizontalErrorMeters: distanceMeters(laserTarget, projectedTarget),
        heightErrorMeters: Math.abs(laserTarget.height - projectedTarget.height),
      })
    } catch (error) {
      input.onProjectionError?.(error)
    }
  }

  const controller: ApproachController = {
    get running () {
      return running
    },
    async execute ({ videoPoint, stream, targetAgl }) {
      if (stream !== 'DronePayload') throw new Error('抵近目标仅支持主负载直播画面')
      if (running) await input.flight.emergencyStop()
      const run = ++sequence
      setRunning(true)
      try {
        await telemetryEvents
        await input.gimbal.lookAt(videoPoint, { locked: true })
        if (run !== sequence) return
        await sleep(GIMBAL_SETTLE_WAIT_MS)
        if (run !== sequence) return
        // 基线取固定等待之后：转动途中产生的激光帧全部被基线吸收，只有云台到位后的新帧才算"新鲜"。
        const revision = laserRevision
        const measured = await waitForFreshLaser(revision, run)
        if (run !== sequence) return
        const control = measured.control
        if (!control.flight.hasControl || !control.payload.hasControl) {
          await input.flight.acquireControl('all')
        }
        const position = laserPosition(measured)
        if (!position) throw new Error('激光目标位置无效')
        void collectProjectionSample(videoPoint, position)
        const target = {
          lng: position.lng,
          lat: position.lat,
          height: position.height + Math.max(20, targetAgl),
        }
        await input.flight.flyTo([target], { maxSpeed: 14 })
        if (run !== sequence) return
        void monitorArrival(target, run)
      } catch (error) {
        if (run === sequence) setRunning(false)
        throw error
      }
    },
    dispose () {
      sequence++
      setRunning(false)
      void telemetryEvents.then(subscription => subscription.dispose())
    },
  }
  return controller
}
