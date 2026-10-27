// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import type { Disposable } from 'fh2-plugin-sdk'
import { captureEvidencePreviewView } from '../../../views/capture-evidence-preview/contract'
import type { CaptureEvidencePreviewState, CapturePreviewPanel } from '../../../views/capture-evidence-preview/contract'
import type { TrafficCaptureContext } from '../context'
import type { LaneChangeModule } from '../lane-change/module'
import type { PersonRoadModule } from '../person-road/module'

export interface CapturePreviewHost {
  showLaneChange(): Promise<void>;
  showPersonRoad(): Promise<void>;
  clearSelection(): void;
  reset(): void;
  dispose(): void;
}

export async function createCapturePreviewHost (deps: {
  readonly ctx: TrafficCaptureContext;
  readonly laneChange: LaneChangeModule;
  readonly personRoad: PersonRoadModule;
  readonly onClose: () => void;
}): Promise<CapturePreviewHost> {
  let activePanel: CapturePreviewPanel | null = null
  const state = createViewState<CaptureEvidencePreviewState>({
    activePanel,
    laneChange: deps.laneChange.previewState.get(),
    personRoad: deps.personRoad.previewState.get(),
  })
  const sync = (): void => state.update(() => ({
    activePanel,
    laneChange: deps.laneChange.previewState.get(),
    personRoad: deps.personRoad.previewState.get(),
  }))
  const subscriptions: Disposable[] = [
    deps.laneChange.previewState.subscribe(sync),
    deps.personRoad.previewState.subscribe(sync),
  ]
  let previewTab: Awaited<ReturnType<typeof deps.ctx.extensions.contribute<'capture-preview'>>> | undefined

  const clearSelection = (): void => {
    activePanel = null
    deps.laneChange.clearSelection()
    deps.personRoad.clearSelection()
    sync()
    void previewTab?.update({ visible: false })
  }

  await captureEvidencePreviewView.handle(deps.ctx, {
    state,
    methods: {
      selectPersonRoadPhoto ({ index }) {
        deps.personRoad.selectPhoto(index)
      },
      openPersonRoadMediaLibrary () {
        return deps.personRoad.openMediaLibrary()
      },
      close () {
        deps.onClose()
      },
    },
  })
  previewTab = await deps.ctx.extensions.contribute('capture-preview', {
    visible: false,
    label: '照片预览',
    render: () => captureEvidencePreviewView.get(deps.ctx),
  })

  return {
    async showLaneChange () {
      activePanel = 'lane-change'
      deps.personRoad.clearSelection()
      sync()
      await previewTab?.reveal({ reason: 'capture-record-selected' })
    },
    async showPersonRoad () {
      activePanel = 'person-road'
      deps.laneChange.clearSelection()
      sync()
      await previewTab?.reveal({ reason: 'capture-record-selected' })
    },
    clearSelection,
    reset () {
      activePanel = null
      deps.laneChange.clearSelection()
      deps.personRoad.clearSelection()
      sync()
    },
    dispose () {
      clearSelection()
      for (const subscription of subscriptions) subscription.dispose()
    },
  }
}
