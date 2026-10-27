// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PersonRoadRecordItemDto } from '../../capture-records/person-road/contract'

export interface PersonRoadPreviewPhotoDto {
  readonly url: string;
}

export interface PersonRoadPreviewState {
  readonly record: PersonRoadRecordItemDto | null;
  readonly photos: readonly PersonRoadPreviewPhotoDto[];
  readonly activeIndex: number;
  readonly loading: boolean;
  readonly loadError: string | null;
}
