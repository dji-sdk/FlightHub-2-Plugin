// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PluginValue } from 'fh2-plugin-sdk'
import type { TrafficCaptureContext } from '../context'
import type { LaneChangeModule } from '../lane-change/module'
import type { PersonRoadModule } from '../person-road/module'
import type { CockpitRuntimeEnv } from '../runtime-env'
import type { CaptureModeCoordinator } from './coordinator'
import { createCaptureControls } from './controls'
import { createCapturePreviewHost } from './preview-host'
import { createCaptureRecordsHost } from './records-host'

export interface CaptureModule {
  revealRecordsPanel(input?: PluginValue): Promise<void>;
  resetSession(): void;
  dispose(): Promise<void>;
}

export async function createCaptureModule (deps: {
  readonly ctx: TrafficCaptureContext;
  readonly env: CockpitRuntimeEnv;
  readonly laneChange: LaneChangeModule;
  readonly personRoad: PersonRoadModule;
  readonly coordinator: CaptureModeCoordinator;
}): Promise<CaptureModule> {
  let clearRecordSelection = (): void => {}
  const preview = await createCapturePreviewHost({
    ctx: deps.ctx,
    laneChange: deps.laneChange,
    personRoad: deps.personRoad,
    onClose: () => clearRecordSelection(),
  })
  const records = await createCaptureRecordsHost({ ...deps, preview })
  clearRecordSelection = records.clearSelection
  const controls = await createCaptureControls({ ...deps, records })

  return {
    revealRecordsPanel: input => controls.revealRecords(input),
    resetSession () {
      records.reset()
      preview.reset()
    },
    async dispose () {
      await controls.dispose()
      records.dispose()
      preview.dispose()
    },
  }
}
