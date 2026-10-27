// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { definePluginView } from 'fh2-plugin-sdk/view'
import type { PluginViewClient } from 'fh2-plugin-sdk/view'

export interface TeachDialogWaypoint {
  readonly id: string;
  readonly seq: number;
  readonly selected: boolean;
  readonly height: number;
  readonly cameraYaw: number;
  readonly gimbalPitch: number;
  readonly focalLength: number;
  readonly aiRecognitionOn: boolean;
  readonly aiTargetTypes: readonly string[];
  readonly screenshotUrl: string | null;
  readonly screenshotError: string | null;
}

export type TeachDialogState = {
  readonly kind: 'conflict';
  readonly routeName: string;
  readonly waypointCount: number;
  readonly createdAt: string | null;
  readonly confirmingRecreate: boolean;
  readonly pending: boolean;
  readonly error: string | null;
} | {
  readonly kind: 'generate';
  readonly defaultName: string;
  readonly defaultGlobalSpeed: number;
  readonly defaultWaypointSpeed: number;
  readonly selectedCount: number;
  readonly screenshotBytes: number;
  readonly screenshotQuotaBytes: number;
  readonly waypoints: readonly TeachDialogWaypoint[];
  readonly pending: boolean;
  readonly error: string | null;
}

interface TeachDialogContract {
  readonly state: TeachDialogState;
  readonly methods: {
    cancel(): void;
    loadExisting(): void;
    requestRecreate(): void;
    recreate(): void;
    retryScreenshot(input: { readonly waypointId: string }): void;
    setWaypointSelected(input: { readonly waypointId: string; readonly selected: boolean }): void;
    generate(input: {
      readonly name: string;
      readonly globalSpeed: number;
      readonly waypointSpeed: number;
    }): void;
  };
}

export const teachDialogView = definePluginView<TeachDialogContract>('teach-dialog')
export type TeachDialogClient = PluginViewClient<TeachDialogContract>
