// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import { describe, expect, it, vi } from 'vitest'
import { createPersonRoadPreview } from './preview'

describe('person-road preview', () => {
  it('uses the original photo and builds the media-library URL from the tracking folder', () => {
    const recordsState = createViewState({ records: [{ trackingId: 'tracking-1', folderId: 42, title: '行人上路', startedAt: 1, endedAt: 2, previewPhotoUrl: '/preview.jpg', originalPhotoUrl: '/original.jpg', closeReason: 'manual' as const, position: { lng: 113, lat: 23 }, pending: false }], selectedTrackingId: '' })
    const map = {
      addBillboard: vi.fn(async () => ({ id: 'marker-1', dispose: vi.fn(), update: vi.fn(async () => {}) })),
      recenter: vi.fn(async () => {}),
    }
    const navigation = { open: vi.fn(async () => {}), back: vi.fn(async () => {}) }
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const preview = createPersonRoadPreview({
      recordsState,
      map,
      getContextSnapshot: () => ({ organizationId: 'org/1', projectId: 'project 1', droneSn: null, gatewaySn: null, alertExecutionId: null, liveReady: true }),
      navigation,
      logger,
    })
    preview.selectRecord('tracking-1')

    expect(preview.state.get()).toMatchObject({
      photos: [{ url: '/original.jpg' }],
      activeIndex: 0,
    })
    expect(logger.info).toHaveBeenCalledWith('行人抓拍媒体库跳转上下文', expect.objectContaining({ folderId: 42, organizationId: 'org/1', projectId: 'project 1', navigationAvailable: true }))
    void preview.openMediaLibrary()
    expect(navigation.open).toHaveBeenCalledWith('/organization/org%2F1/project/project%201#/media?pid=42', { target: 'blank' })
    expect(map.addBillboard).toHaveBeenCalled()
    preview.dispose()
  })

  it('记录状态重放同一选中时不重建地图图元', async () => {
    const recordsState = createViewState({ records: [{ trackingId: 'tracking-1', folderId: 42, title: '行人上路', startedAt: 1, endedAt: 2, previewPhotoUrl: '/preview.jpg', originalPhotoUrl: '/original.jpg', closeReason: 'manual' as const, position: { lng: 113, lat: 23 }, pending: false }], selectedTrackingId: '' })
    const marker = { id: 'marker-1', dispose: vi.fn(), update: vi.fn(async () => {}) }
    const map = {
      addBillboard: vi.fn(async () => marker),
      recenter: vi.fn(async () => {}),
    }
    const preview = createPersonRoadPreview({
      recordsState,
      map,
      getContextSnapshot: () => null,
      navigation: undefined,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
    preview.selectRecord('tracking-1')
    await Promise.resolve()
    expect(map.addBillboard).toHaveBeenCalledOnce()

    // 后端刷新/合并产生新数组、相同内容：订阅重放 selectRecord 不得清理重建图元
    recordsState.update(current => ({ ...current, records: [...current.records] }))
    await Promise.resolve()

    expect(map.addBillboard).toHaveBeenCalledOnce()
    expect(map.recenter).toHaveBeenCalledOnce()
    expect(marker.dispose).not.toHaveBeenCalled()
    preview.dispose()
    expect(marker.dispose).toHaveBeenCalledOnce()
  })

  it('uses the local original photo while media is pending', () => {
    const recordsState = createViewState({ records: [{ trackingId: 'tracking-1', folderId: 7, title: '行人上路', startedAt: 1, endedAt: null, previewPhotoUrl: '/local.jpg', originalPhotoUrl: '/local.jpg', closeReason: '' as const, position: null, pending: true }], selectedTrackingId: '' })
    const preview = createPersonRoadPreview({
      recordsState,
      map: null,
      getContextSnapshot: () => ({ organizationId: 'org-1', projectId: 'project-1', droneSn: null, gatewaySn: null, alertExecutionId: null, liveReady: true }),
      navigation: undefined,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
    preview.selectRecord('tracking-1')

    expect(preview.state.get()).toMatchObject({ photos: [{ url: '/local.jpg' }] })
    preview.dispose()
  })

  it('hides the media-library URL when the folder is unavailable', () => {
    const recordsState = createViewState({ records: [{ trackingId: 'tracking-1', folderId: 0, title: '行人上路', startedAt: 1, endedAt: null, previewPhotoUrl: '/preview.jpg', originalPhotoUrl: '/original.jpg', closeReason: '' as const, position: null, pending: false }], selectedTrackingId: '' })
    const preview = createPersonRoadPreview({
      recordsState,
      map: null,
      getContextSnapshot: () => ({ organizationId: 'org-1', projectId: 'project-1', droneSn: null, gatewaySn: null, alertExecutionId: null, liveReady: true }),
      navigation: undefined,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
    preview.selectRecord('tracking-1')

    expect(preview.state.get()).toMatchObject({ photos: [{ url: '/original.jpg' }] })
    preview.dispose()
  })

  it('logs the folder and missing Cockpit context for field diagnosis', async () => {
    const recordsState = createViewState({ records: [{ trackingId: 'tracking-1', folderId: 42, title: '行人上路', startedAt: 1, endedAt: 2, previewPhotoUrl: '/preview.jpg', originalPhotoUrl: '/original.jpg', closeReason: 'manual' as const, position: null, pending: false }], selectedTrackingId: '' })
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const preview = createPersonRoadPreview({
      recordsState,
      map: null,
      getContextSnapshot: () => ({ organizationId: null, projectId: 'project-1', droneSn: null, gatewaySn: null, alertExecutionId: null, liveReady: true }),
      navigation: undefined,
      logger,
    })
    preview.selectRecord('tracking-1')

    expect(logger.warn).toHaveBeenCalledWith('行人抓拍媒体库跳转缺少组织或项目上下文', expect.objectContaining({ folderId: 42, organizationId: null, projectId: 'project-1' }))
    await preview.openMediaLibrary()
    expect(logger.warn).toHaveBeenCalledWith('打开行人抓拍媒体库失败：缺少组织或项目上下文', { trackingId: 'tracking-1', folderId: 42 })
    preview.dispose()
  })
})
