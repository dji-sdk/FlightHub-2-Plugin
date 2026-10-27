// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { LaneChangeRecordItemDto } from '../../capture-records/lane-change/contract'

export interface LaneChangePreviewState {
  readonly record: LaneChangeRecordItemDto | null;
  readonly screenshotUrl: string | null;
}
