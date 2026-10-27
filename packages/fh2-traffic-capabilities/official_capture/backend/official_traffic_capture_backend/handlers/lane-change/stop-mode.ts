// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { updateStoreRecord } from '../../shared/store'
import { modeKeyOf } from '../../shared/lane-change'
import { msNum, msText } from '../../shared/time'
import { requireText } from '../../shared/validation'
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'

export interface StopModeInput {
  readonly [key: string]: unknown
  readonly project_id?: string
  readonly dock_sn?: string
}

export interface StopModeResult {
  readonly is_active: boolean
  readonly project_id: string
  readonly dock_sn: string
  readonly stopped_at: number
}

export function stopMode (input: StopModeInput, ctx: HandlerCtx): StopModeResult {
  const projectId = requireText(input, 'project_id')
  const dockSn = requireText(input, 'dock_sn')
  const nowMs = msText(Date.parse(ctx.now))
  updateStoreRecord('lane_change_mode', {
    mode_key: { eq: modeKeyOf(projectId, dockSn) },
    is_active: { eq: '1' },
  }, { is_active: '0', stopped_at_ms: nowMs })
  return { is_active: false, project_id: projectId, dock_sn: dockSn, stopped_at: msNum(nowMs) }
}
