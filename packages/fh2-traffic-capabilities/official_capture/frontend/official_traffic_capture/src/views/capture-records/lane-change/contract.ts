// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { LngLat } from '../../../shared/geo'

export type LaneChangePostStatus = 'submitting' | 'pending_video' | 'waiting_artifacts' | 'processing' | 'verified' | 'rejected' | 'failed'

export interface LaneChangeRecordItemDto {
  readonly eventId: string | null;
  readonly eventKey: string;
  readonly title: string;
  readonly crossedAt: number;
  readonly collisionType: 'solid_line' | 'guide_area';
  readonly screenshotUrl: string | null;
  readonly position: LngLat | null;
  readonly postStatus: LaneChangePostStatus;
  readonly failureReason: string;
}

export interface LaneChangeRecordsState {
  readonly records: readonly LaneChangeRecordItemDto[];
  readonly selectedEventKey: string;
}
