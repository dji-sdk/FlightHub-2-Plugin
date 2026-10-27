// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import { createCockpitPollGate, isInCockpitRoute } from './poll-gate'

interface LocationState {
  pathname: string;
  search: string;
  hash: string;
}

function createLocationFixture (initialHash = ''): {
  location: {
    getState: ReturnType<typeof vi.fn>;
    onStateChanged: ReturnType<typeof vi.fn>;
  };
  emit: (hash: string) => void;
} {
  const handlers = new Set<(state: LocationState) => void>()
  let currentHash = initialHash
  const snapshot = (): LocationState => ({ pathname: '/organization/o1/project/p1', search: '', hash: currentHash })
  const location = {
    getState: vi.fn(async () => snapshot()),
    onStateChanged: vi.fn(async (handler: (state: LocationState) => void) => {
      handlers.add(handler)
      return { dispose: async () => {
        handlers.delete(handler)
      } }
    }),
  }
  return {
    location,
    emit: (hash: string) => {
      currentHash = hash
      for (const handler of [...handlers]) handler(snapshot())
    },
  }
}

function createGateFixture (initialHash = '') {
  const { location, emit } = createLocationFixture(initialHash)
  const refresh = vi.fn()
  const startPolling = vi.fn()
  const stopPolling = vi.fn()
  const gate = createCockpitPollGate({ location: location as never, refresh, startPolling, stopPolling })
  return { gate, emit, refresh, startPolling, stopPolling, location }
}

describe('isInCockpitRoute', () => {
  it('与宿主 cockpit-route 判定一致：#/cockpit 前缀即驾驶舱', () => {
    expect(isInCockpitRoute({ hash: '#/cockpit' })).toBe(true)
    expect(isInCockpitRoute({ hash: '#/cockpit?droneSn=1' })).toBe(true)
    expect(isInCockpitRoute({ hash: '#/cockpit/sub' })).toBe(true)
    expect(isInCockpitRoute({ hash: '#/team' })).toBe(false)
    expect(isInCockpitRoute({ hash: '' })).toBe(false)
  })
})

describe('createCockpitPollGate', () => {
  it('初始非驾驶舱：立即刷新并启动轮询', async () => {
    const fixture = createGateFixture('')

    await fixture.gate.start()

    expect(fixture.refresh).toHaveBeenCalledOnce()
    expect(fixture.startPolling).toHaveBeenCalledOnce()
    expect(fixture.stopPolling).not.toHaveBeenCalled()
  })

  it('初始即在驾驶舱：不刷新不轮询，只执行停用', async () => {
    const fixture = createGateFixture('#/cockpit')

    await fixture.gate.start()

    expect(fixture.refresh).not.toHaveBeenCalled()
    expect(fixture.startPolling).not.toHaveBeenCalled()
    expect(fixture.stopPolling).toHaveBeenCalledOnce()
  })

  it('进入驾驶舱停轮询，离开刷新并恢复，状态去重', async () => {
    const fixture = createGateFixture('')

    await fixture.gate.start()
    fixture.emit('#/cockpit')
    fixture.emit('#/cockpit?droneSn=1')
    expect(fixture.stopPolling).toHaveBeenCalledOnce()
    expect(fixture.startPolling).toHaveBeenCalledOnce()

    fixture.emit('')
    expect(fixture.refresh).toHaveBeenCalledTimes(2)
    expect(fixture.startPolling).toHaveBeenCalledTimes(2)

    fixture.emit('')
    fixture.emit('#/team')
    expect(fixture.refresh).toHaveBeenCalledTimes(2)
    expect(fixture.startPolling).toHaveBeenCalledTimes(2)
  })

  it('dispose 后迟到路由通知无效，订阅与轮询一并释放', async () => {
    const fixture = createGateFixture('')

    await fixture.gate.start()
    expect(fixture.location.onStateChanged).toHaveBeenCalledOnce()

    fixture.gate.dispose()
    expect(fixture.stopPolling).toHaveBeenCalledOnce()

    fixture.emit('#/cockpit')
    fixture.emit('')

    expect(fixture.stopPolling).toHaveBeenCalledOnce()
    expect(fixture.startPolling).toHaveBeenCalledOnce()
    expect(fixture.refresh).toHaveBeenCalledOnce()
  })

  it('start 订阅建立后立即 dispose：不应用快照并释放订阅', async () => {
    const fixture = createGateFixture('')

    const started = fixture.gate.start()
    fixture.gate.dispose()
    await started

    expect(fixture.refresh).not.toHaveBeenCalled()
    expect(fixture.startPolling).not.toHaveBeenCalled()
  })
})
