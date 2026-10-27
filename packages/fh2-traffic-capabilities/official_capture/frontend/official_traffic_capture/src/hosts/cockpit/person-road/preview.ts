// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import type { CockpitContextState, PluginCapabilityClient, PluginLogger, PluginState } from 'fh2-plugin-sdk'
import type { PersonRoadPreviewPhotoDto, PersonRoadPreviewState } from '../../../views/capture-evidence-preview/person-road/contract'
import type { PersonRoadRecordItemDto, PersonRoadRecordsState } from '../../../views/capture-records/person-road/contract'
import { createMapPreviewController } from '../capture/map-preview'
import type { MapPreviewPort } from '../capture/map-preview'

export interface PersonRoadPreview {
  readonly state: PluginState<PersonRoadPreviewState>;
  selectRecord(trackingId: string): void;
  selectPhoto(index: number): void;
  openMediaLibrary(): Promise<void>;
  clearSelection(): void;
  dispose(): void;
}

export function createPersonRoadPreview (deps: {
  readonly recordsState: PluginState<PersonRoadRecordsState>;
  readonly map: MapPreviewPort | null;
  readonly getContextSnapshot: () => CockpitContextState | null;
  readonly navigation: PluginCapabilityClient<'platform:navigation'> | undefined;
  readonly logger: PluginLogger;
}): PersonRoadPreview {
  const state = createViewState<PersonRoadPreviewState>({ record: null, photos: [], activeIndex: 0, loading: false, loadError: null })
  const mapPreview = createMapPreviewController(deps.map)

  let selectedTrackingId = ''
  const fallbackPhotos = (record: PersonRoadRecordItemDto): readonly PersonRoadPreviewPhotoDto[] => {
    return record.originalPhotoUrl ? [{ url: record.originalPhotoUrl }] : []
  }
  const showMarker = (record: PersonRoadRecordItemDto, thumbUrl: string | null): void => {
    if (!record.position) {
      mapPreview.clear()
      return
    }
    void mapPreview.show({
      thumbUrl,
      longitude: record.position.lng,
      latitude: record.position.lat,
      height: 0,
      accent: 'person-road',
    })
  }
  const mediaLibraryUrl = (folderId: number): string | null => {
    const context = deps.getContextSnapshot()
    if (folderId === 0 || !context?.organizationId || !context.projectId) return null
    return `/organization/${encodeURIComponent(context.organizationId)}`
      + `/project/${encodeURIComponent(context.projectId)}#/media?pid=${encodeURIComponent(String(folderId))}`
  }
  const selectRecord = (trackingId: string): void => {
    selectedTrackingId = trackingId
    const record = deps.recordsState.get().records.find(item => item.trackingId === trackingId) ?? null
    if (!record) {
      mapPreview.clear()
      state.update(() => ({ record: null, photos: [], activeIndex: 0, loading: false, loadError: null }))
      return
    }
    const context = deps.getContextSnapshot()
    deps.logger.info('行人抓拍媒体库跳转上下文', {
      trackingId: record.trackingId,
      folderId: record.folderId,
      organizationId: context?.organizationId ?? null,
      projectId: context?.projectId ?? null,
      navigationAvailable: deps.navigation !== undefined,
    })
    if (record.folderId > 0 && (!context?.organizationId || !context.projectId)) {
      deps.logger.warn('行人抓拍媒体库跳转缺少组织或项目上下文', {
        trackingId: record.trackingId,
        folderId: record.folderId,
        organizationId: context?.organizationId ?? null,
        projectId: context?.projectId ?? null,
      })
    }
    const photos = fallbackPhotos(record)
    state.update(() => ({ record, photos, activeIndex: 0, loading: false, loadError: null }))
    showMarker(record, photos[0]?.url ?? null)
  }
  const selectPhoto = (index: number): void => {
    const current = state.get()
    const activeIndex = Math.max(0, Math.min(index, current.photos.length - 1))
    state.update(() => ({ ...current, activeIndex }))
    if (current.record) showMarker(current.record, current.photos[activeIndex]?.url ?? null)
  }
  const subscription = deps.recordsState.subscribe(() => {
    if (selectedTrackingId !== '') selectRecord(selectedTrackingId)
  })

  return {
    state,
    selectRecord,
    selectPhoto,
    async openMediaLibrary () {
      const record = state.get().record
      if (!record || record.folderId <= 0) return
      const url = mediaLibraryUrl(record.folderId)
      if (!url) {
        deps.logger.warn('打开行人抓拍媒体库失败：缺少组织或项目上下文', {
          trackingId: record.trackingId,
          folderId: record.folderId,
        })
        return
      }
      if (!deps.navigation) {
        deps.logger.warn('打开行人抓拍媒体库失败：宿主未提供 platform:navigation', {
          trackingId: record.trackingId,
          folderId: record.folderId,
        })
        return
      }
      await deps.navigation.open(url, { target: 'blank' })
    },
    clearSelection () {
      selectRecord('')
    },
    dispose () {
      subscription.dispose()
      selectRecord('')
    },
  }
}
