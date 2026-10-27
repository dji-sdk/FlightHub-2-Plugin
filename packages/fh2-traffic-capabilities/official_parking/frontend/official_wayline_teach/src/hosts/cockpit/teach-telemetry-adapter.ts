// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type {
  AiConfigState,
  AsyncDisposable,
  CockpitContextState,
  Disposable,
  PluginCapabilityClient,
  TelemetryState,
} from 'fh2-plugin-sdk'
import type { TeachTelemetryState } from '../../workflow/teach-telemetry'

export type TeachTelemetryChangeSource = 'snapshot' | 'context' | 'telemetry' | 'ai-config'

export interface TeachTelemetryChangedEvent {
  readonly source: TeachTelemetryChangeSource;
  readonly state: TeachTelemetryState;
}

export interface TeachTelemetryAdapter extends AsyncDisposable {
  getState(): Promise<TeachTelemetryState>;
  onStateChanged(handler: (event: TeachTelemetryChangedEvent) => void): Disposable;
}

type ContextCapability = Pick<PluginCapabilityClient<'cockpit:context'>, 'getState' | 'onStateChanged'>
type TelemetryCapability = Pick<PluginCapabilityClient<'cockpit:telemetry'>, 'getState' | 'onStateChanged'>
type AiConfigCapability = Pick<PluginCapabilityClient<'cockpit:ai-config'>, 'getState' | 'onStateChanged'>

const VALID_AI_TARGET_TYPES = new Set(['person', 'car', 'boat'])

function focalLength (state: TelemetryState): number | null {
  const camera = state.payload.camera
  if (camera?.lens === 'wide') return 24
  if (camera?.lens !== 'zoom') return null
  return Math.max(24, typeof camera.zoom_factor === 'number' && Number.isFinite(camera.zoom_factor)
    ? camera.zoom_factor * 24
    : 24)
}

function aiTargetTypes (state: AiConfigState): readonly ('person' | 'car' | 'boat')[] {
  const result = new Set<'person' | 'car' | 'boat'>()
  for (const targetType of state.targetTypes) {
    const normalized = targetType === 'vehicle' ? 'car' : targetType
    if (VALID_AI_TARGET_TYPES.has(normalized)) result.add(normalized as 'person' | 'car' | 'boat')
  }
  return [...result]
}

export function toTeachTelemetryState (input: {
  readonly context: CockpitContextState;
  readonly telemetry: TelemetryState;
  readonly aiConfig: AiConfigState;
  readonly capturedAt?: number;
}): TeachTelemetryState {
  const roster = input.telemetry.device.roster
  const pose = input.telemetry.drone.pose
  const gimbal = input.telemetry.payload.gimbal
  return {
    capturedAt: input.capturedAt ?? Date.now(),
    source: pose?.source ?? null,
    projectId: input.context.projectId,
    flightId: input.context.flightId ?? null,
    dockSn: roster?.dockSn ?? null,
    droneSn: input.context.droneSn ?? roster?.droneSn ?? null,
    gatewaySn: input.context.gatewaySn ?? roster?.gatewaySn ?? null,
    longitude: pose?.longitude ?? null,
    latitude: pose?.latitude ?? null,
    // Cockpit telemetry 的 pose.height 是 WGS84 椭球高；示教不使用 elevation。
    height: pose?.height ?? null,
    // 示教航向取云台绝对偏航角，不使用飞机机头 attitude_head。
    cameraYaw: gimbal?.yaw ?? null,
    gimbalPitch: gimbal?.pitch ?? null,
    focalLength: focalLength(input.telemetry),
    horizontalSpeed: pose?.horizontal_speed ?? null,
    verticalSpeed: pose?.vertical_speed ?? null,
    aiAvailable: input.aiConfig.availability.status === 'available',
    aiRecognitionOn: input.aiConfig.recognitionEnabled,
    aiTargetTypes: aiTargetTypes(input.aiConfig),
  }
}

export async function createTeachTelemetryAdapter (input: {
  readonly context: ContextCapability;
  readonly telemetry: TelemetryCapability;
  readonly aiConfig: AiConfigCapability;
  readonly onError: (error: unknown) => void;
}): Promise<TeachTelemetryAdapter> {
  let disposed = false
  let refreshGeneration = 0
  const listeners = new Set<(event: TeachTelemetryChangedEvent) => void>()
  const subscriptions: AsyncDisposable[] = []

  const getState = async (): Promise<TeachTelemetryState> => {
    const [context, telemetry, aiConfig] = await Promise.all([
      input.context.getState(),
      input.telemetry.getState(),
      input.aiConfig.getState(),
    ])
    return toTeachTelemetryState({ context, telemetry, aiConfig })
  }
  const refresh = async (source: TeachTelemetryChangeSource): Promise<void> => {
    const generation = ++refreshGeneration
    try {
      const state = await getState()
      if (disposed || generation !== refreshGeneration) return
      for (const listener of listeners) listener({ source, state })
    } catch (error) {
      if (!disposed) input.onError(error)
    }
  }

  try {
    subscriptions.push(await input.context.onStateChanged(() => void refresh('context')))
    subscriptions.push(await input.telemetry.onStateChanged(() => void refresh('telemetry')))
    subscriptions.push(await input.aiConfig.onStateChanged(() => void refresh('ai-config')))
  } catch (error) {
    for (const subscription of subscriptions.reverse()) await subscription.dispose()
    throw error
  }

  return {
    getState,
    onStateChanged (handler) {
      listeners.add(handler)
      void refresh('snapshot')
      return {
        dispose: () => {
          listeners.delete(handler)
        },
      }
    },
    async dispose () {
      if (disposed) return
      disposed = true
      refreshGeneration += 1
      listeners.clear()
      for (const subscription of subscriptions.reverse()) await subscription.dispose()
    },
  }
}
