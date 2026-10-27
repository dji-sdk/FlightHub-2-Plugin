// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import type { TrackedTimers } from 'fh2-plugin-sdk'
import { createMockTrafficRuntime } from './mock-runtime'

function createFakeTimers (): TrackedTimers & { advance(ms: number): void; size(): number } {
  const tasks = new Map<number, { callback: () => void; dueAt: number }>()
  let clock = 0
  let sequence = 0
  return {
    setTimeout (callback, ms) {
      tasks.set(++sequence, { callback, dueAt: clock + ms })
      return sequence
    },
    clearTimeout (handle) {
      tasks.delete(handle as number)
    },
    setInterval (callback, ms) {
      tasks.set(++sequence, { callback, dueAt: clock + ms })
      return sequence
    },
    clearInterval (handle) {
      tasks.delete(handle as number)
    },
    advance (ms) {
      clock += ms
      for (const [handle, task] of [...tasks]) {
        if (task.dueAt <= clock) {
          tasks.delete(handle)
          task.callback()
        }
      }
    },
    size: () => tasks.size,
  }
}

describe('mock traffic backend', () => {
  it('两模式可并存、string tracking ID、分页和行人媒体 WS', async () => {
    const timers = createFakeTimers()
    const backend = createMockTrafficRuntime({ timers, now: () => 1000, mediaDelayMs: 100 })
    const events: unknown[] = []
    await backend.ws.onBizCode('illegal_road_capture', event => events.push(event))
    await backend.laneChangeApi.startMode({ projectId: 'p', dockSn: 'd', flightId: 'f' })
    const session = await backend.personRoadApi.startSession({ projectId: 'p', dockSn: 'd', flightId: 'f' })
    expect((await backend.laneChangeApi.getMode({ projectId: 'p', dockSn: 'd' })).isActive).toBe(true)
    const { trackingId } = await backend.personRoadApi.startTracking({ sessionId: session.sessionId, startedAt: 1000 })
    expect(trackingId).toBe('tracking-1')
    timers.advance(100)
    const page = await backend.personRoadApi.listTrackings({ projectId: 'p', flightId: 'f', page: 1, pageSize: 1 })
    expect(page).toMatchObject({ total: 1, trackings: [{ id: 'tracking-1', latestPhoto: { previewUrl: expect.any(String), originalUrl: expect.any(String) } }] })
    expect(events[0]).toMatchObject({ bizCode: 'illegal_road_capture', subBizCode: 'media_added', data: { scene: 'illegal_road', session_id: session.sessionId, dock_sn: 'd', flight_id: 'f', tracking_id: 'tracking-1', media_type: 'photo', lens: 'wide' } })
  })

  it('startTracking 顶替同 Session 未关闭的 Tracking', async () => {
    const timers = createFakeTimers()
    const backend = createMockTrafficRuntime({ timers })
    const session = await backend.personRoadApi.startSession({ projectId: 'p', dockSn: 'd', flightId: 'f' })
    const first = await backend.personRoadApi.startTracking({ sessionId: session.sessionId, startedAt: 1 })
    const second = await backend.personRoadApi.startTracking({ sessionId: session.sessionId, startedAt: 2 })
    expect(second.supersededTrackingId).toBe(first.trackingId)
    expect((await backend.personRoadApi.listTrackings({ projectId: 'p', flightId: 'f', page: 1, pageSize: 20 })).trackings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: first.trackingId, closeReason: 'superseded' })]))
  })

  it('返回恢复状态、最新照片并由 stopSession 收尾 open Tracking', async () => {
    const timers = createFakeTimers()
    const backend = createMockTrafficRuntime({ timers, now: () => 1000, mediaDelayMs: 100 })
    const session = await backend.personRoadApi.startSession({ projectId: 'p', dockSn: 'd', flightId: 'f' })
    const resumed = await backend.personRoadApi.startSession({ projectId: 'p', dockSn: 'd', flightId: 'f' })
    expect(resumed.resumed).toBe(true)
    const tracking = await backend.personRoadApi.startTracking({ sessionId: session.sessionId, startedAt: 1000 })
    expect(await backend.personRoadApi.getStatus({ projectId: 'p', dockSn: 'd', flightId: 'f' })).toMatchObject({
      trackingCount: 1,
      openTracking: { trackingId: tracking.trackingId, matchEndAt: 31_000 },
    })
    timers.advance(200)
    const list = await backend.personRoadApi.listTrackings({ projectId: 'p', flightId: 'f', page: 1, pageSize: 20 })
    expect(list.trackings[0]).toMatchObject({ latestPhoto: { previewUrl: expect.any(String), originalUrl: expect.any(String) } })
    const stopped = await backend.personRoadApi.stopSession({ sessionId: session.sessionId, endedAt: 2000 })
    expect(stopped.closedTrackingIds).toEqual([tracking.trackingId])
    expect((await backend.personRoadApi.listTrackings({ projectId: 'p', flightId: 'f', page: 1, pageSize: 20 })).trackings[0]?.closeReason).toBe('session_stopped')
  })

  it('event_key 幂等且驾驶舱期间不生成返航后证据', async () => {
    const timers = createFakeTimers()
    const backend = createMockTrafficRuntime({ timers, now: () => 1000, mediaDelayMs: 100 })
    const input = { projectId: 'p', dockSn: 'd', flightId: 'f', eventKey: '100:car:r', crossedAt: 100, collisionType: 'solid_line' as const, objId: 'car', regionId: 'r', annotationId: 'r', annotationSnapshot: { name: '实线 1', kind: 'line' as const, normalized_points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], geo_points: [] } }
    const first = await backend.laneChangeApi.createEvent(input)
    const duplicate = await backend.laneChangeApi.createEvent(input)
    expect(duplicate).toMatchObject({ eventId: first.eventId, created: false })
    expect(timers.size()).toBe(0)
    expect((await backend.laneChangeApi.listEvents({ projectId: 'p', flightId: 'f', page: 1, pageSize: 1 })).events[0]?.postStatus).toBe('pending_video')
  })

  it('dispose 清理全部定时器', async () => {
    const timers = createFakeTimers()
    const backend = createMockTrafficRuntime({ timers, mediaDelayMs: 100 })
    const session = await backend.personRoadApi.startSession({ projectId: 'p', dockSn: 'd', flightId: 'f' })
    await backend.personRoadApi.startTracking({ sessionId: session.sessionId, startedAt: 1 })
    expect(timers.size()).toBeGreaterThan(0)
    backend.dispose()
    expect(timers.size()).toBe(0)
  })
})
