// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
export interface TeachTelemetryState {
  readonly capturedAt: number;
  readonly source: 'drc' | 'ws' | null;
  readonly projectId: string | null;
  readonly flightId: string | null;
  readonly dockSn: string | null;
  readonly droneSn: string | null;
  readonly gatewaySn: string | null;
  readonly longitude: number | null;
  readonly latitude: number | null;
  readonly height: number | null;
  readonly cameraYaw: number | null;
  readonly gimbalPitch: number | null;
  readonly focalLength: number | null;
  readonly horizontalSpeed: number | null;
  readonly verticalSpeed: number | null;
  readonly aiAvailable: boolean;
  readonly aiRecognitionOn: boolean;
  readonly aiTargetTypes: readonly ('person' | 'car' | 'boat')[];
}
