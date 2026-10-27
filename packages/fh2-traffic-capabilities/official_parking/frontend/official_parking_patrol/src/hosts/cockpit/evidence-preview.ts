// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PatrolApi } from '../../api/patrol-api'
import type { PatrolTarget } from '../../api/types'
import type { RecordsState } from '../../views/patrol-records/contract'
import type { PreviewState } from '../../views/patrol-preview/contract'
import type { PatrolTaskState } from '../../workflow/patrol-session'
import type { MapPreviewController } from './map-preview'

const EMPTY_PREVIEW: PreviewState = { displayName: '', photos: [], initialIndex: 0 }
const EMPTY_RECORDS: RecordsState = { group: null, activeTargetId: '' }

export interface EvidencePreviewDeps {
  readonly api: Pick<PatrolApi, 'getTargetMedia'>;
  readonly taskState: {
    readonly get: () => PatrolTaskState;
  };
  readonly recordsState: {
    readonly get: () => RecordsState;
    readonly update: (updater: (current: RecordsState) => RecordsState) => void;
  };
  readonly previewState: {
    readonly update: (updater: (current: PreviewState) => PreviewState) => void;
  };
  readonly previewTab: {
    readonly update: (patch: { visible: boolean }) => Promise<unknown>;
    readonly reveal: (options: { reason: string; targetId: string }) => Promise<unknown>;
  };
  readonly mapPreview: MapPreviewController;
}

export interface EvidencePreviewController {
  /** 点击卡片：选中并加载预览；再次点击同一卡片关闭预览 */
  select (targetId: string): Promise<void>;
  /** 选中车辆照片入库（photo_pending → completed）→ 刷新预览 */
  handleTaskStateChange (state: PatrolTaskState): void;
  /** 换任务时：清掉选中的卡片、预览、地图图钉和预览 tab */
  reset (): void;
}

/** 抓拍预览：点记录卡片 → 加载照片预览 + 在地图上标出车辆位置；媒体请求带编号，晚到的旧响应不会覆盖新选择。 */
export function createEvidencePreview (deps: EvidencePreviewDeps): EvidencePreviewController {
  let selectedTargetStatus = ''
  let previewRequestSeq = 0

  function clearSelection (): void {
    previewRequestSeq++
    selectedTargetStatus = ''
    deps.recordsState.update(state => ({ ...state, activeTargetId: '' }))
    deps.previewState.update(() => EMPTY_PREVIEW)
    void deps.previewTab.update({ visible: false })
    deps.mapPreview.clear()
  }

  async function select (targetId: string): Promise<void> {
    if (deps.recordsState.get().activeTargetId === targetId) {
      // 再次点击同一卡片 → 关闭预览 tab；旧请求作废
      clearSelection()
      return
    }
    const target = deps.taskState.get().targets.find(item => item.target_id === targetId)
    if (!target) return
    deps.recordsState.update(state => ({ ...state, activeTargetId: targetId }))
    selectedTargetStatus = target.status
    const loaded = await loadPreview(target)
    if (!loaded) return
    await deps.previewTab.reveal({ reason: 'patrol-record-selected', targetId })
  }

  /** 统一媒体接口：initial（恒定一张）+ recheck（0..N）；URL 现签现用不持久化。 */
  async function loadPreview (target: PatrolTarget): Promise<boolean> {
    const requestSeq = ++previewRequestSeq
    const media = await deps.api.getTargetMedia(target.target_id).catch(() => null)
    const photos: string[] = []
    if (media?.initial?.url) photos.push(media.initial.url)
    for (const item of media?.recheck ?? []) {
      const url = item.original_url || item.url
      if (url) photos.push(url)
    }
    if (requestSeq !== previewRequestSeq || deps.recordsState.get().activeTargetId !== target.target_id) return false
    // photo_pending：复检照片回传中，初检图顶上；skipped_no_car：仅初检图
    deps.previewState.update(() => ({
      displayName: target.display_name || '待识别车牌',
      photos,
      initialIndex: Math.max(0, photos.length - 1),
    }))
    await deps.mapPreview.show({
      thumbUrl: media?.initial?.url || target.best_frame_thumb_url,
      longitude: target.lng,
      latitude: target.lat,
      height: 0,
    })
    return requestSeq === previewRequestSeq && deps.recordsState.get().activeTargetId === target.target_id
  }

  function handleTaskStateChange (state: PatrolTaskState): void {
    const selectedTargetId = deps.recordsState.get().activeTargetId
    if (!selectedTargetId) return
    const target = state.targets.find(item => item.target_id === selectedTargetId)
    if (!target) {
      clearSelection()
      return
    }
    const status = target.status
    if (status !== selectedTargetStatus) {
      selectedTargetStatus = status
      if (status === 'completed') void loadPreview(target)
    }
  }

  function reset (): void {
    clearSelection()
    deps.recordsState.update(() => EMPTY_RECORDS)
  }

  return { select, handleTaskStateChange, reset }
}
