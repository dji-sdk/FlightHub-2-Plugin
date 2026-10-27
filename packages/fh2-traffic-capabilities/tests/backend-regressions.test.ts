// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEvent } from '../official_capture/backend/official_traffic_capture_backend/handlers/lane-change/create-event'
import { startTracking } from '../official_capture/backend/official_traffic_capture_backend/handlers/illegal-road/start-tracking'
import { snapshotText } from '../official_capture/backend/official_traffic_capture_backend/shared/lane-change'
import { h_teach_listRoutes } from '../official_parking/backend/official_patrol_teach/handlers/teach/list-routes'

afterEach(() => {
  vi.unstubAllGlobals()
})

function thrownBy (run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('Expected the function to throw')
}

describe('traffic capability migration regressions', () => {
  it('keeps new archive fields omitted so async archive claims see SQL NULL', () => {
    const createIfAbsent = vi.fn((entity: string, record: Readonly<Record<string, unknown>>) => ({
      ok: true,
      data: {
        created: true,
        record: { id: `${entity}-1`, ...record },
      },
    }))
    vi.stubGlobal('store', {
      query: vi.fn((entity: string) => ({
        ok: true,
        data: entity === 'illegal_road_session'
          ? {
              list: [{ id: 'session-1', project_id: 'project-1', dock_sn: 'dock-1', flight_id: 'flight-1', status: 'active' }],
              total: 1,
            }
          : { list: [], total: 0 },
      })),
      update: vi.fn(() => ({ ok: true, data: { affected: 0 } })),
      createIfAbsent,
    })

    startTracking({ session_id: 'session-1', started_at: 1700000000000 }, { idempotencyKey: '', now: '2026-09-17T00:00:00Z' } as never)
    createEvent({
      project_id: 'project-1',
      dock_sn: 'dock-1',
      flight_id: 'flight-1',
      event_key: 'event-1',
      collision_type: 'solid_line',
      obj_id: 'car-1',
      region_id: 'region-1',
      crossed_at: 1700000000000,
      annotation_snapshot: { kind: 'line', normalized_points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    }, { now: '2026-09-17T00:00:00Z' } as never)

    const trackingRecord = createIfAbsent.mock.calls.find(([entity]) => entity === 'illegal_road_tracking')?.[1]
    const eventRecord = createIfAbsent.mock.calls.find(([entity]) => entity === 'lane_change_event')?.[1]
    for (const record of [trackingRecord, eventRecord]) {
      expect(record).toBeDefined()
      expect(record).not.toHaveProperty('folder_id')
      expect(record).not.toHaveProperty('parent_folder_id')
    }
  })

  it('returns INVALID_ARGUMENT when normalized_points is absent', () => {
    expect(thrownBy(() => snapshotText({ kind: 'line' }))).toEqual({
      code: 'INVALID_ARGUMENT',
      message: 'annotation_snapshot.normalized_points 不能为空(后处理必需)',
    })
  })

  it('uses the legacy default page size when route page_size is negative', () => {
    const query = vi.fn(() => ({ ok: true, data: { list: [], total: 0 } }))
    vi.stubGlobal('store', { query, count: vi.fn() })
    vi.stubGlobal('log', { info: vi.fn() })

    expect(h_teach_listRoutes({ page_size: -1 })).toEqual({
      pagination: { page: 1, page_size: 20, total: 0 },
      list: [],
    })
    expect(query).toHaveBeenCalledWith('teach_route', {}, {
      limit: 20,
      offset: 0,
      orderBy: [{ field: 'id', dir: 'desc' }],
    })
  })
})
