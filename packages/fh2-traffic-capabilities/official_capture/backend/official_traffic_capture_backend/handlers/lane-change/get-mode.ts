// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { queryStore } from '../../shared/store'
import { modeKeyOf } from '../../shared/lane-change'
import { msNum } from '../../shared/time'
import { requireText } from '../../shared/validation'
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'

export interface GetModeInput {
  readonly [key: string]: unknown
  readonly project_id?: string
  readonly dock_sn?: string
}

export interface GetModeResult {
  readonly is_active: boolean
  readonly project_id: string
  readonly dock_sn: string
  readonly flight_id: string
  readonly started_at: number
}

export function getMode (input: GetModeInput, _ctx: HandlerCtx): GetModeResult {
  const projectId = requireText(input, 'project_id')
  const dockSn = requireText(input, 'dock_sn')
  const page = queryStore('lane_change_mode', { mode_key: { eq: modeKeyOf(projectId, dockSn) } }, { limit: 1 })
  if (!page.list.length) {
    return { is_active: false, project_id: projectId, dock_sn: dockSn, flight_id: '', started_at: 0 }
  }
  const record = page.list[0]!
  const active = record.is_active === '1'
  return {
    is_active: active,
    project_id: projectId,
    dock_sn: dockSn,
    flight_id: active ? record.flight_id || '' : '',
    started_at: active ? msNum(record.started_at_ms) : 0,
  }
}
