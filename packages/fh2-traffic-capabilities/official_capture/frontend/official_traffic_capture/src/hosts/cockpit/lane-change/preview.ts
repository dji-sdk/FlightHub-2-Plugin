// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import type { PluginState } from 'fh2-plugin-sdk'
import type { LaneChangePreviewState } from '../../../views/capture-evidence-preview/lane-change/contract'
import type { LaneChangeRecordsState } from '../../../views/capture-records/lane-change/contract'
import { createMapPreviewController } from '../capture/map-preview'
import type { MapPreviewPort } from '../capture/map-preview'

export interface LaneChangePreview {
  readonly state: PluginState<LaneChangePreviewState>;
  selectRecord(eventKey: string): void;
  clearSelection(): void;
  dispose(): void;
}

export function createLaneChangePreview (
  recordsState: PluginState<LaneChangeRecordsState>,
  map: MapPreviewPort | null,
): LaneChangePreview {
  const state = createViewState<LaneChangePreviewState>({ record: null, screenshotUrl: null })
  const mapPreview = createMapPreviewController(map)

  let selectedEventKey = ''
  const selectRecord = (eventKey: string): void => {
    selectedEventKey = eventKey
    const record = recordsState.get().records.find(item => item.eventKey === eventKey) ?? null
    state.update(() => ({ record, screenshotUrl: record?.screenshotUrl ?? null }))
    if (!record?.position) {
      mapPreview.clear()
      return
    }
    void mapPreview.show({
      thumbUrl: record.screenshotUrl,
      longitude: record.position.lng,
      latitude: record.position.lat,
      height: 0,
      accent: 'lane-change',
    })
  }
  const subscription = recordsState.subscribe(() => {
    if (selectedEventKey !== '') selectRecord(selectedEventKey)
  })

  return {
    state,
    selectRecord,
    clearSelection () {
      selectRecord('')
    },
    dispose () {
      subscription.dispose()
      selectRecord('')
    },
  }
}
