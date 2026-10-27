// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk/view'
import type { PluginViewClient } from 'fh2-plugin-sdk/view'
import type { TeachPhase } from '../../workflow/teach-session'

export interface TeachPanelWaypoint {
  readonly id: string;
  readonly seq: number;
  readonly selected: boolean;
  readonly height: number;
  readonly cameraYaw: number;
  readonly focalLength: number;
  readonly aiRecognitionOn: boolean;
  readonly aiTargetTypes: readonly string[];
  readonly screenshotUrl: string | null;
  readonly screenshotError: string | null;
}

export interface TeachPanelState {
  readonly phase: TeachPhase;
  readonly ready: boolean;
  readonly disabledReason: string | null;
  readonly busy: boolean;
  readonly mockMode: boolean;
  readonly routeName: string;
  readonly routeDistance: string;
  readonly globalSpeed: number;
  readonly waypointSpeed: number;
  readonly waylineUuid: string | null;
  readonly waylineFileId: string | null;
  readonly waypointCount: number;
  readonly screenshotBytes: number;
  readonly screenshotQuotaBytes: number;
  readonly waypoints: readonly TeachPanelWaypoint[];
  readonly selectedCount: number;
}

interface TeachPanelContract {
  readonly state: TeachPanelState;
  readonly methods: {
    recordWaypoint(): void;
    requestGenerate(): void;
    startNewTeaching(): void;
    dismiss(): void;
  };
}

export const teachPanelView = definePluginView<TeachPanelContract>('teach-panel')
export type TeachPanelClient = PluginViewClient<TeachPanelContract>
