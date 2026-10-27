// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLaneChangePreview } from './preview'

// blob: 缩略图转 data: URL 是异步链，等待一个宏任务让转换与创建全部落地
function flushAsync (): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

describe('lane-change preview', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses only the local screenshot and updates the map marker', async () => {
    const recordsState = createViewState({ records: [{ eventId: 'event-1', eventKey: 'key-1', title: '变道抓拍', crossedAt: 1, collisionType: 'solid_line' as const, screenshotUrl: 'blob:lane', position: { lng: 113, lat: 23 }, postStatus: 'verified' as const, failureReason: '' }], selectedEventKey: '' })
    const map = {
      addBillboard: vi.fn(async () => ({ id: 'marker-1', dispose: vi.fn(), update: vi.fn(async () => {}) })),
      recenter: vi.fn(async () => {}),
    }
    // blob: 转换依赖 fetch：本用例只关心图元创建时序，固定失败（降级占位图）即可
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }))
    const preview = createLaneChangePreview(recordsState, map)
    preview.selectRecord('key-1')
    await flushAsync()

    expect(preview.state.get()).toMatchObject({ screenshotUrl: 'blob:lane', record: { eventId: 'event-1' } })
    expect(map.addBillboard).toHaveBeenCalledOnce()
    preview.dispose()
  })

  it('记录状态重放同一选中时不重建地图图元', async () => {
    const recordsState = createViewState({ records: [{ eventId: 'event-1', eventKey: 'key-1', title: '变道抓拍', crossedAt: 1, collisionType: 'solid_line' as const, screenshotUrl: 'blob:lane', position: { lng: 113, lat: 23 }, postStatus: 'verified' as const, failureReason: '' }], selectedEventKey: '' })
    const marker = { id: 'marker-1', dispose: vi.fn(), update: vi.fn(async () => {}) }
    const map = {
      addBillboard: vi.fn(async () => marker),
      recenter: vi.fn(async () => {}),
    }
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }))
    const preview = createLaneChangePreview(recordsState, map)
    preview.selectRecord('key-1')
    await flushAsync()
    expect(map.addBillboard).toHaveBeenCalledOnce()

    // 后端刷新/合并产生新数组、相同内容：订阅重放 selectRecord 不得清理重建图元
    recordsState.update(current => ({ ...current, records: [...current.records] }))
    await flushAsync()

    expect(map.addBillboard).toHaveBeenCalledOnce()
    expect(map.recenter).toHaveBeenCalledOnce()
    expect(marker.dispose).not.toHaveBeenCalled()
    preview.dispose()
    expect(marker.dispose).toHaveBeenCalledOnce()
  })
})
