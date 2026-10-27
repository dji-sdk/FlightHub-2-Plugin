// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { JsonValue, TrackedTimers } from 'fh2-plugin-sdk'
import { createAccidentEventsApi } from '../api/accident-events-api'
import type { EventStatus } from './types'

export interface AccidentEventState {
  readonly pluginEventId: string;
  readonly status: EventStatus | null;
  readonly rawPayload: Readonly<Record<string, JsonValue>>;
  readonly result: JsonValue;
  readonly allowApproach: boolean;
  readonly visible: boolean;
  readonly error: string | null;
}

export interface CockpitEventMonitor {
  getState(): AccidentEventState;
  start(): void;
  dispose(): void;
}

export function emptyEventState (pluginEventId = ''): AccidentEventState {
  return {
    pluginEventId,
    status: null,
    rawPayload: {},
    result: null,
    allowApproach: false,
    visible: pluginEventId !== '',
    error: null,
  }
}

export function createCockpitEventMonitor (input: {
  readonly pluginEventId: string;
  readonly apiCall: (endpoint: string, options?: { readonly method?: 'GET' | 'POST'; readonly body?: JsonValue }) => Promise<JsonValue>;
  readonly timers: TrackedTimers;
  readonly onState: (state: AccidentEventState) => void;
  readonly intervalMs?: number;
}): CockpitEventMonitor {
  const api = createAccidentEventsApi(input.apiCall)
  let state = emptyEventState(input.pluginEventId)
  let timer: unknown
  let sequence = 0

  const schedule = (run: number): void => {
    timer = input.timers.setTimeout(() => void poll(run), input.intervalMs ?? 2000)
  }

  async function poll (run: number): Promise<void> {
    try {
      const event = await api.getEvent(input.pluginEventId)
      if (run !== sequence) return
      const terminal = isTerminal(event.status)
      state = {
        pluginEventId: event.pluginEventId,
        status: event.status,
        rawPayload: event.rawPayload,
        result: event.result,
        allowApproach: event.status === 'handling' || event.status === 'completed' || event.status === 'terminated',
        visible: event.status !== 'ack_timeout' && event.status !== 'ignored',
        error: null,
      }
      input.onState(state)
      if (!terminal) schedule(run)
    } catch (error) {
      if (run !== sequence) return
      state = {
        ...state,
        error: error instanceof Error ? error.message : String(error),
      }
      input.onState(state)
      schedule(run)
    }
  }

  return {
    getState: () => state,
    start () {
      const run = ++sequence
      if (timer !== undefined) input.timers.clearTimeout(timer)
      timer = undefined
      void poll(run)
    },
    dispose () {
      sequence++
      if (timer !== undefined) input.timers.clearTimeout(timer)
      timer = undefined
    },
  }
}

function isTerminal (status: EventStatus): boolean {
  return status === 'completed' || status === 'terminated' || status === 'ack_timeout' || status === 'ignored'
}
