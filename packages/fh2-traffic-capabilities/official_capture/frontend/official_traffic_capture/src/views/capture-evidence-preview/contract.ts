// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk/view'
import type { PluginViewClient } from 'fh2-plugin-sdk/view'
import type { LaneChangePreviewState } from './lane-change/contract'
import type { PersonRoadPreviewState } from './person-road/contract'

export type CapturePreviewPanel = 'lane-change' | 'person-road'

export interface CaptureEvidencePreviewState {
  readonly activePanel: CapturePreviewPanel | null;
  readonly laneChange: LaneChangePreviewState;
  readonly personRoad: PersonRoadPreviewState;
}

interface CaptureEvidencePreviewContract {
  state: CaptureEvidencePreviewState;
  methods: {
    selectPersonRoadPhoto(input: { readonly index: number }): void;
    openPersonRoadMediaLibrary(): Promise<void>;
    close(): void;
  };
}

export const captureEvidencePreviewView = definePluginView<CaptureEvidencePreviewContract>('capture-evidence-preview')
export type CaptureEvidencePreviewClient = PluginViewClient<CaptureEvidencePreviewContract>
