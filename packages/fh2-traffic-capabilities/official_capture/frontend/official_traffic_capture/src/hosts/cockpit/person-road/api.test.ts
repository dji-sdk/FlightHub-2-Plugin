// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import { createIllegalRoadApi } from './api'

describe('person-road api', () => {
  it('parses the latest photo without requiring media counters or latest_photos', async () => {
    const responses = [
      { total: 1, page: 1, page_size: 20, session: null, trackings: [{ id: 't-1', session_id: 's-1', project_id: 'p', dock_sn: 'd', flight_id: 'f', scene: 'illegal_road', status: 'closed', started_at: 1, ended_at: 2, close_reason: 'manual', folder_id: 10, parent_folder_id: 9, latest_photo: { file_id: 11, preview_url: '/preview.jpg', original_url: '/original.jpg', photo_time_ms: 2 } }] },
      { total: 1, page: 1, page_size: 50, folder_id: 10, media: [{ id: 'm-1', file_id: 11, media_type: 'photo', lens: 'wide', file_name: 'far.png', preview_url: '/far.png', original_url: '', captured_at_ms: 2, size: 100, duration_ms: 0 }] },
    ]
    const invoke = vi.fn(async () => responses.shift()!)
    const api = createIllegalRoadApi(invoke)
    await expect(api.listTrackings({ projectId: 'p', flightId: 'f', sessionId: 's-1', page: 1, pageSize: 20 })).resolves.toMatchObject({ trackings: [{ id: 't-1', folderId: 10, latestPhoto: { previewUrl: '/preview.jpg', originalUrl: '/original.jpg' } }] })
    expect(invoke).toHaveBeenNthCalledWith(1, 'h_illegalRoad_listTrackings', { project_id: 'p', flight_id: 'f', session_id: 's-1', page: 1, page_size: 20 })
    await expect(api.listMedia({ trackingId: 't-1', page: 1, pageSize: 50 })).resolves.toMatchObject({ folderId: 10, media: [{ id: 'm-1', lens: 'wide' }] })
  })
})
