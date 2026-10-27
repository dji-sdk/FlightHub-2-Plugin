// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import type { Disposable, PluginState } from 'fh2-plugin-sdk'
import type { PersonRoadRecordItemDto, PersonRoadRecordsState } from '../../../views/capture-records/person-road/contract'
import type { PersonRoadRecord } from './model'

export function toPersonRoadRecordItemDto (record: PersonRoadRecord): PersonRoadRecordItemDto {
  return {
    trackingId: record.trackingId,
    folderId: record.folderId,
    title: personRoadRecordTitle(record.startedAt),
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    previewPhotoUrl: record.previewPhotoUrl,
    originalPhotoUrl: record.originalPhotoUrl,
    closeReason: record.closeReason,
    position: record.position,
    pending: record.pending,
  }
}

export function createPersonRoadRecordsState (
  source: PluginState<{ records: readonly PersonRoadRecord[] }>,
): { readonly state: PluginState<PersonRoadRecordsState>; readonly subscription: Disposable } {
  const state = createViewState<PersonRoadRecordsState>({ records: [], selectedTrackingId: '' })
  const sync = (): void => state.update(current => ({
    records: source.get().records.map(toPersonRoadRecordItemDto),
    selectedTrackingId: current.selectedTrackingId,
  }))
  const subscription = source.subscribe(sync)
  sync()
  return { state, subscription }
}

function personRoadRecordTitle (startedAt: number): string {
  const date = new Date(startedAt)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `行人上路抓拍_${hh}${mm}${ss}`
}
