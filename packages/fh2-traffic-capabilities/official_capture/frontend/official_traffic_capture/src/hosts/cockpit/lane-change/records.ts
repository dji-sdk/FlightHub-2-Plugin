// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import type { Disposable, PluginState } from 'fh2-plugin-sdk'
import type { LaneChangeRecordItemDto, LaneChangeRecordsState } from '../../../views/capture-records/lane-change/contract'
import type { LaneChangeRecord } from './model'

export function toLaneChangeRecordItemDto (record: LaneChangeRecord): LaneChangeRecordItemDto {
  return {
    eventId: record.eventId,
    eventKey: record.eventKey,
    title: record.title,
    crossedAt: record.crossedAt,
    collisionType: record.collisionType,
    screenshotUrl: record.screenshotUrl,
    position: record.position,
    postStatus: record.postStatus,
    failureReason: record.failureReason,
  }
}

export function createLaneChangeRecordsState (
  source: PluginState<{ records: readonly LaneChangeRecord[] }>,
): { readonly state: PluginState<LaneChangeRecordsState>; readonly subscription: Disposable } {
  const state = createViewState<LaneChangeRecordsState>({ records: [], selectedEventKey: '' })
  const sync = (): void => state.update(current => ({
    records: source.get().records.map(toLaneChangeRecordItemDto),
    selectedEventKey: current.selectedEventKey,
  }))
  const subscription = source.subscribe(sync)
  sync()
  return { state, subscription }
}
