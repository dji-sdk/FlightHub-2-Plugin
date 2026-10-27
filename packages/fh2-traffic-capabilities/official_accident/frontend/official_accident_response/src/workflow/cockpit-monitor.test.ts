// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { JsonValue, TrackedTimers } from 'fh2-plugin-sdk'
import type { EventStatus } from './types'
import { createCockpitEventMonitor } from './cockpit-monitor'

function timers () {
  const callbacks: Array<() => void> = []
  return {
    callbacks,
    value: {
      setTimeout: (callback: () => void) => {
        callbacks.push(callback)
        return callbacks.length
      },
      clearTimeout: vi.fn(),
    } as unknown as TrackedTimers,
  }
}

function eventResponse (status: EventStatus): JsonValue {
  return {
    code: 0,
    data: {
      eventId: 'JQ/1',
      eventType: '警情',
      priority: 'high',
      status,
      occurredAt: '2026-08-27 10:00:00',
      rawPayload: { lat: 22.5, lng: 114.1 },
      result: { route: 'done' },
    },
  }
}

describe('cockpit event monitor', () => {
  it.each<EventStatus>(['unacknowledged', 'acknowledged', 'handling'])('%s 状态继续轮询', async (status) => {
    const clock = timers()
    const onState = vi.fn()
    const apiCall = vi.fn(async (): Promise<JsonValue> => eventResponse(status))
    const monitor = createCockpitEventMonitor({
      pluginEventId: 'JQ/1',
      apiCall,
      timers: clock.value,
      onState,
    })

    monitor.start()
    await vi.waitFor(() => expect(onState).toHaveBeenCalledOnce())

    expect(apiCall).toHaveBeenCalledWith('/plugin-scene/data-store/events/JQ%2F1', { method: 'GET' })
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({
      status,
      allowApproach: status === 'handling',
      visible: true,
    }))
    expect(clock.callbacks).toHaveLength(1)
    monitor.dispose()
  })

  it.each<EventStatus>(['completed', 'terminated'])('%s 停止轮询并允许抵近', async (status) => {
    const clock = timers()
    const onState = vi.fn()
    const monitor = createCockpitEventMonitor({
      pluginEventId: 'event-1',
      apiCall: async () => eventResponse(status),
      timers: clock.value,
      onState,
    })

    monitor.start()
    await vi.waitFor(() => expect(onState).toHaveBeenCalledOnce())

    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ status, allowApproach: true, visible: true }))
    expect(clock.callbacks).toHaveLength(0)
  })

  it.each<EventStatus>(['ack_timeout', 'ignored'])('%s 停止轮询并隐藏', async (status) => {
    const clock = timers()
    const onState = vi.fn()
    const monitor = createCockpitEventMonitor({
      pluginEventId: 'event-1',
      apiCall: async () => eventResponse(status),
      timers: clock.value,
      onState,
    })

    monitor.start()
    await vi.waitFor(() => expect(onState).toHaveBeenCalledOnce())

    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ status, allowApproach: false, visible: false }))
    expect(clock.callbacks).toHaveLength(0)
  })

  it('瞬时失败保留最近有效状态并继续重试', async () => {
    const clock = timers()
    const onState = vi.fn()
    const apiCall = vi.fn()
      .mockResolvedValueOnce(eventResponse('handling'))
      .mockRejectedValueOnce(new Error('网关瞬时失败'))
    const monitor = createCockpitEventMonitor({
      pluginEventId: 'event-1',
      apiCall,
      timers: clock.value,
      onState,
    })

    monitor.start()
    await vi.waitFor(() => expect(onState).toHaveBeenCalledTimes(1))
    clock.callbacks.shift()?.()
    await vi.waitFor(() => expect(onState).toHaveBeenCalledTimes(2))

    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'handling',
      rawPayload: { lat: 22.5, lng: 114.1 },
      result: { route: 'done' },
      error: '网关瞬时失败',
    }))
    expect(clock.callbacks).toHaveLength(1)
    monitor.dispose()
  })
})
