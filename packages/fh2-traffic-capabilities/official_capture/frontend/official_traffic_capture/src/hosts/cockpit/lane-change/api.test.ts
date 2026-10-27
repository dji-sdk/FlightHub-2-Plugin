// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import { createLaneChangeApi } from './api'

describe('lane-change api', () => {
  it('creates and lists events without exposing event-detail loading', async () => {
    const invoke = vi.fn(async (handler: string) => handler === 'h_laneChange_createEvent'
      ? { event_id: 'e-1', event_key: 'key-1', post_status: 'pending_video', created_at: '2026-01-01T00:00:00Z', created: true }
      : { total: 1, page: 1, page_size: 20, events: [{ event_id: 'e-1', event_key: 'key-1', project_id: 'p', dock_sn: 'd', flight_id: 'f', obj_id: '7', collision_type: 'solid_line', crossed_at: 1, post_status: 'pending_video', reject_reason: '', failure_reason: '', created_at: '2026-01-01T00:00:00Z' }] })
    const api = createLaneChangeApi(invoke)
    await expect(api.createEvent({ projectId: 'p', dockSn: 'd', flightId: 'f', eventKey: 'key-1', crossedAt: 1, collisionType: 'solid_line', objId: '7', regionId: 'r', annotationId: 'a', annotationSnapshot: { name: '实线 1', kind: 'line', normalized_points: [], geo_points: [] } })).resolves.toMatchObject({ eventId: 'e-1' })
    await expect(api.listEvents({ projectId: 'p', flightId: 'f', page: 1, pageSize: 20 })).resolves.toMatchObject({ total: 1, events: [{ eventId: 'e-1' }] })
    expect(api).not.toHaveProperty('getEvent')
  })
})
