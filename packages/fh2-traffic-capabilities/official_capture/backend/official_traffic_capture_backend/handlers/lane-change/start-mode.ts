// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createStoreRecord, updateStoreRecord } from '../../shared/store'
import { modeKeyOf } from '../../shared/lane-change'
import { msNum, msText } from '../../shared/time'
import { requireText } from '../../shared/validation'
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'

export interface StartModeInput {
  readonly [key: string]: unknown
  readonly project_id?: string
  readonly dock_sn?: string
  readonly flight_id?: string
}

export interface StartModeResult {
  readonly is_active: boolean
  readonly project_id: string
  readonly dock_sn: string
  readonly flight_id: string
  readonly started_at: number
}

export function startMode (input: StartModeInput, ctx: HandlerCtx): StartModeResult {
  const projectId = requireText(input, 'project_id')
  const dockSn = requireText(input, 'dock_sn')
  const flightId = requireText(input, 'flight_id')
  const modeKey = modeKeyOf(projectId, dockSn)
  const nowMs = msText(Date.parse(ctx.now))
  const result = createStoreRecord('lane_change_mode', {
    mode_key: modeKey,
    project_id: projectId,
    dock_sn: dockSn,
    flight_id: flightId,
    is_active: '1',
    started_at_ms: nowMs,
    stopped_at_ms: '',
  }, ['mode_key'])
  if (!result.created) {
    updateStoreRecord('lane_change_mode', { mode_key: { eq: modeKey } }, {
      flight_id: flightId,
      is_active: '1',
      started_at_ms: nowMs,
      stopped_at_ms: '',
    })
  }
  return { is_active: true, project_id: projectId, dock_sn: dockSn, flight_id: flightId, started_at: msNum(nowMs) }
}
