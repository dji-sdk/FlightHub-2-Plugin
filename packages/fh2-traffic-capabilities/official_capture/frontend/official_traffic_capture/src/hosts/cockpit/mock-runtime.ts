// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { AsyncDisposable, JsonValue, PluginWsApi, PluginWsEvent, TrackedTimers } from 'fh2-plugin-sdk'
import type { LaneChangeApi } from './lane-change/api'
import { createMockLaneChangeBackend } from './lane-change/mock-backend'
import type { IllegalRoadApi } from './person-road/api'
import { createMockPersonRoadBackend } from './person-road/mock-backend'

type WsListener = (event: PluginWsEvent<JsonValue>) => void

export interface MockTrafficRuntime {
  readonly laneChangeApi: LaneChangeApi;
  readonly personRoadApi: IllegalRoadApi;
  readonly ws: PluginWsApi;
  dispose(): void;
}

export function createMockTrafficRuntime (options: {
  readonly timers: TrackedTimers;
  readonly now?: () => number;
  readonly mediaDelayMs?: number;
}): MockTrafficRuntime {
  const now = options.now ?? Date.now
  const listeners = new Map<string, Set<WsListener>>()
  const pendingTimers = new Set<unknown>()
  const schedule = (delayMs: number, callback: () => void): void => {
    const handle = options.timers.setTimeout(() => {
      pendingTimers.delete(handle)
      callback()
    }, delayMs)
    pendingTimers.add(handle)
  }
  const emit = (bizCode: string, subBizCode: string, data: JsonValue): void => {
    for (const listener of listeners.get(bizCode) ?? []) listener({ bizCode, subBizCode, timestamp: now(), data })
  }

  const lane = createMockLaneChangeBackend({ now })
  const personRoad = createMockPersonRoadBackend({
    now,
    mediaDelayMs: options.mediaDelayMs ?? 2_500,
    schedule,
    emit,
  })

  const ws: PluginWsApi = {
    onBizCode<TData extends JsonValue = JsonValue> (bizCode: string, handler: (event: PluginWsEvent<TData>) => void): Promise<AsyncDisposable> {
      let handlers = listeners.get(bizCode)
      if (!handlers) {
        handlers = new Set()
        listeners.set(bizCode, handlers)
      }
      const listener: WsListener = event => handler(event as PluginWsEvent<TData>)
      handlers.add(listener)
      return Promise.resolve({ dispose: async () => {
        handlers?.delete(listener)
      } })
    },
  }

  return {
    laneChangeApi: lane.api,
    personRoadApi: personRoad.api,
    ws,
    dispose () {
      for (const handle of pendingTimers) options.timers.clearTimeout(handle)
      pendingTimers.clear()
      listeners.clear()
      lane.dispose()
      personRoad.dispose()
    },
  }
}
