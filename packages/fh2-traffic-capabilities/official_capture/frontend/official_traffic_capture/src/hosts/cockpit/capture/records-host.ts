// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import type { Disposable, PluginValue } from 'fh2-plugin-sdk'
import { captureRecordsView } from '../../../views/capture-records/contract'
import type { CaptureRecordsPanel, CaptureRecordsState } from '../../../views/capture-records/contract'
import type { TrafficCaptureContext } from '../context'
import type { LaneChangeModule } from '../lane-change/module'
import type { PersonRoadModule } from '../person-road/module'
import type { CapturePreviewHost } from './preview-host'

export interface CaptureRecordsHost {
  reveal(input?: PluginValue): Promise<void>;
  setActivePanel(panel: CaptureRecordsPanel): void;
  clearSelection(): void;
  reset(): void;
  dispose(): void;
}

export async function createCaptureRecordsHost (deps: {
  readonly ctx: TrafficCaptureContext;
  readonly laneChange: LaneChangeModule;
  readonly personRoad: PersonRoadModule;
  readonly preview: CapturePreviewHost;
}): Promise<CaptureRecordsHost> {
  let activePanel: CaptureRecordsPanel = 'lane-change'
  let selectedEventKey = ''
  let selectedTrackingId = ''
  const state = createViewState<CaptureRecordsState>({
    activePanel,
    laneChange: { ...deps.laneChange.recordsState.get(), selectedEventKey },
    personRoad: { ...deps.personRoad.recordsState.get(), selectedTrackingId },
  })
  const sync = (): void => state.update(() => ({
    activePanel,
    laneChange: { ...deps.laneChange.recordsState.get(), selectedEventKey },
    personRoad: { ...deps.personRoad.recordsState.get(), selectedTrackingId },
  }))
  const subscriptions: Disposable[] = [
    deps.laneChange.recordsState.subscribe(sync),
    deps.personRoad.recordsState.subscribe(sync),
  ]

  const clearSelection = (): void => {
    selectedEventKey = ''
    selectedTrackingId = ''
    deps.preview.clearSelection()
    sync()
  }
  const selectLaneChangeRecord = async (eventKey: string): Promise<void> => {
    if (selectedEventKey === eventKey) {
      clearSelection()
      return
    }
    deps.laneChange.selectRecord(eventKey)
    selectedEventKey = eventKey
    selectedTrackingId = ''
    sync()
    await deps.preview.showLaneChange()
  }
  const selectPersonRoadRecord = async (trackingId: string): Promise<void> => {
    if (selectedTrackingId === trackingId) {
      clearSelection()
      return
    }
    deps.personRoad.selectRecord(trackingId)
    selectedTrackingId = trackingId
    selectedEventKey = ''
    sync()
    await deps.preview.showPersonRoad()
  }

  await captureRecordsView.handle(deps.ctx, {
    state,
    methods: {
      setActivePanel ({ panel }) {
        activePanel = panel
        sync()
      },
      selectLaneChangeRecord: ({ eventKey }) => selectLaneChangeRecord(eventKey),
      selectPersonRoadRecord: ({ trackingId }) => selectPersonRoadRecord(trackingId),
    },
  })
  const contribution = await deps.ctx.extensions.contribute('capture-records', {
    visible: true,
    label: '交通违章抓拍',
    icon: 'cockpit-violation-event',
    width: 260,
    render: () => captureRecordsView.get(deps.ctx),
  })

  return {
    reveal: input => contribution.reveal(input),
    setActivePanel (panel) {
      activePanel = panel
      sync()
    },
    clearSelection,
    reset () {
      activePanel = 'lane-change'
      selectedEventKey = ''
      selectedTrackingId = ''
      deps.preview.reset()
      sync()
    },
    dispose () {
      clearSelection()
      for (const subscription of subscriptions) subscription.dispose()
    },
  }
}
