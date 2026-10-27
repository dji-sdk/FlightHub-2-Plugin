// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// @vitest-environment happy-dom
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RecordsView from './RecordsView.vue'
import type { CaptureRecordsState } from './contract'

let root: HTMLElement | undefined
afterEach(() => root?.remove())

describe('captureRecordsView', () => {
  it('only mounts the active child and forwards the exact eventKey', async () => {
    const state: CaptureRecordsState = {
      activePanel: 'lane-change',
      laneChange: { records: [{ eventKey: 'event-key-1', eventId: 'event-1', title: '变道抓拍', crossedAt: 1, collisionType: 'solid_line', screenshotUrl: null, postStatus: 'failed', failureReason: '上报失败', position: null }], selectedEventKey: '' },
      personRoad: { records: [], selectedTrackingId: '' },
    }
    const setActivePanel = vi.fn()
    const client = {
      state: { subscribe: (listener: (value: CaptureRecordsState) => void) => {
        listener(state)
        return { dispose () {} }
      } },
      setActivePanel,
      selectLaneChangeRecord: vi.fn(),
      selectPersonRoadRecord: vi.fn(),
    }
    root = document.createElement('div')
    document.body.append(root)
    createApp(RecordsView, { client }).mount(root)
    await nextTick()
    expect(root.querySelector('.lane-records')).not.toBeNull()
    expect(root.querySelector('.person-records')).toBeNull()
    ;(root.querySelector('[data-event-key="event-key-1"]') as HTMLButtonElement).click()
    expect(client.selectLaneChangeRecord).toHaveBeenCalledWith({ eventKey: 'event-key-1' })
    ;(root.querySelector('[data-testid="records-tab-person-road"]') as HTMLButtonElement).click()
    expect(setActivePanel).toHaveBeenCalledWith({ panel: 'person-road' })
  })

  it('forwards the exact trackingId from the person-road child', async () => {
    const state: CaptureRecordsState = {
      activePanel: 'person-road',
      laneChange: { records: [], selectedEventKey: '' },
      personRoad: { records: [{ trackingId: 'tracking-1', folderId: 0, title: '行人上路抓拍', startedAt: 1, endedAt: 2, previewPhotoUrl: null, originalPhotoUrl: null, closeReason: 'manual', pending: false, position: null }], selectedTrackingId: '' },
    }
    const client = {
      state: { subscribe: (listener: (value: CaptureRecordsState) => void) => {
        listener(state)
        return { dispose () {} }
      } },
      setActivePanel: vi.fn(),
      selectLaneChangeRecord: vi.fn(),
      selectPersonRoadRecord: vi.fn(),
    }
    root = document.createElement('div')
    document.body.append(root)
    createApp(RecordsView, { client }).mount(root)
    await nextTick()
    ;(root.querySelector('[data-tracking-id="tracking-1"]') as HTMLButtonElement).click()
    expect(client.selectPersonRoadRecord).toHaveBeenCalledWith({ trackingId: 'tracking-1' })
  })
})
