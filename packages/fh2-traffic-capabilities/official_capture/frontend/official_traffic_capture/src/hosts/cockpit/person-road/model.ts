// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { LngLat } from '../../../shared/geo'
import type { IllegalRoadCloseReason } from './api'

export interface PersonRoadRecord {
  readonly trackingId: string;
  readonly folderId: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly previewPhotoUrl: string | null;
  readonly originalPhotoUrl: string | null;
  readonly closeReason: IllegalRoadCloseReason;
  readonly position: LngLat | null;
  readonly pending: boolean;
}
