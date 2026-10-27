// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { LngLat } from '../../../shared/geo'

export type IllegalRoadCloseReason = '' | 'manual' | 'timeout' | 'superseded' | 'session_stopped'

export interface PersonRoadRecordItemDto {
  readonly trackingId: string;
  readonly folderId: number;
  readonly title: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly previewPhotoUrl: string | null;
  readonly originalPhotoUrl: string | null;
  readonly closeReason: IllegalRoadCloseReason;
  readonly position: LngLat | null;
  readonly pending: boolean;
}

export interface PersonRoadRecordsState {
  readonly records: readonly PersonRoadRecordItemDto[];
  readonly selectedTrackingId: string;
}
