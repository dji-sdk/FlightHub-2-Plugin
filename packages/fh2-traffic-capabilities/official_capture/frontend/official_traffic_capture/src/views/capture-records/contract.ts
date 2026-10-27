// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk/view'
import type { PluginViewClient } from 'fh2-plugin-sdk/view'
import type { LaneChangeRecordsState } from './lane-change/contract'
import type { PersonRoadRecordsState } from './person-road/contract'

export type CaptureRecordsPanel = 'lane-change' | 'person-road'

export interface CaptureRecordsState {
  readonly activePanel: CaptureRecordsPanel;
  readonly laneChange: LaneChangeRecordsState;
  readonly personRoad: PersonRoadRecordsState;
}

interface CaptureRecordsContract {
  state: CaptureRecordsState;
  methods: {
    setActivePanel(input: { readonly panel: CaptureRecordsPanel }): void;
    selectLaneChangeRecord(input: { readonly eventKey: string }): void;
    selectPersonRoadRecord(input: { readonly trackingId: string }): void;
  };
}

export const captureRecordsView = definePluginView<CaptureRecordsContract>('capture-records')
export type CaptureRecordsClient = PluginViewClient<CaptureRecordsContract>
