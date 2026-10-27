// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { PatrolTargetMedia } from '../../api/types'
import type { RecordsState } from '../../views/patrol-records/contract'
import type { PreviewState } from '../../views/patrol-preview/contract'
import type { PatrolTaskState } from '../../workflow/patrol-session'
import { createInitialPatrolState } from '../../workflow/patrol-session'
import { createEvidencePreview } from './evidence-preview'

function taskState (overrides: Partial<PatrolTaskState> = {}): PatrolTaskState {
  return { ...createInitialPatrolState(), ...overrides }
}

function target (overrides: Partial<PatrolTaskState['targets'][number]> = {}): PatrolTaskState['targets'][number] {
  return {
    target_id: 't-1',
    status: 'pending',
    display_name: '粤B·12345',
    vehicle_class: 'car',
    lat: 22.5,
    lng: 113.9,
    best_frame_thumb_url: 'https://thumb',
    photo_taken_at_ms: 1756542962000,
    fail_reason: '',
    ...overrides,
  }
}

function setup () {
  const taskStore = { current: taskState(), get: () => taskStore.current }
  const recordsStore = {
    current: { group: null, activeTargetId: '' } as RecordsState,
    get: () => recordsStore.current,
    update: (updater: (current: RecordsState) => RecordsState) => {
      recordsStore.current = updater(recordsStore.current)
    },
  }
  const previewUpdates: PreviewState[] = []
  const previewState = {
    update: (updater: (current: PreviewState) => PreviewState) => {
      previewUpdates.push(updater({ displayName: '', photos: [], initialIndex: 0 }))
    },
  }
  const previewTab = {
    update: vi.fn(async (patch: { visible: boolean }) => patch),
    reveal: vi.fn(async (options: { reason: string; targetId: string }) => options),
  }
  const mapPreview = { show: vi.fn(async () => {}), clear: vi.fn() }
  const getTargetMedia = vi.fn(async (_targetId: string): Promise<PatrolTargetMedia> => ({
    target_id: 't-1',
    status: 'completed',
    url_expires_at_ms: 0,
    initial: { url: 'https://initial', captured_at_ms: 1, lat: 22.5, lng: 113.9 },
    recheck: [{ url: 'https://recheck-preview', original_url: 'https://recheck-original', media_type: 1, file_name: 'DJI.jpg', captured_at_ms: 2 }],
  }))
  const controller = createEvidencePreview({
    api: { getTargetMedia },
    taskState: taskStore,
    recordsState: recordsStore,
    previewState,
    previewTab,
    mapPreview,
  })
  return { taskStore, recordsStore, previewUpdates, previewTab, mapPreview, getTargetMedia, controller }
}

describe('createEvidencePreview', () => {
  it('select：加载统一媒体（initial + recheck），落地图钉并展示预览 tab', async () => {
    const { taskStore, recordsStore, previewUpdates, previewTab, mapPreview, controller } = setup()
    taskStore.current = taskState({
      taskUuid: 'task-1',
      targets: [target(), target({ target_id: 't-2', status: 'in_progress', display_name: '' })],
    })

    await controller.select('t-1')

    expect(recordsStore.current.activeTargetId).toBe('t-1')
    // 初检 1 张 + 复检 1 张，复检图优先 original_url；initialIndex 指向最后一张
    expect(previewUpdates.at(-1)).toEqual({
      displayName: '粤B·12345',
      photos: ['https://initial', 'https://recheck-original'],
      initialIndex: 1,
    })
    expect(mapPreview.show).toHaveBeenCalledWith({
      thumbUrl: 'https://initial',
      longitude: 113.9,
      latitude: 22.5,
      height: 0,
    })
    expect(previewTab.reveal).toHaveBeenCalledWith({ reason: 'patrol-record-selected', targetId: 't-1' })
  })

  it('select：displayName 缺失时用「待识别车牌」兜底；thumb 回退 best_frame', async () => {
    const { taskStore, previewUpdates, mapPreview, getTargetMedia, controller } = setup()
    getTargetMedia.mockResolvedValue({
      target_id: 't-2',
      status: 'photo_pending',
      url_expires_at_ms: 0,
      initial: null,
      recheck: [],
    })
    taskStore.current = taskState({
      taskUuid: 'task-1',
      targets: [target({ target_id: 't-2', status: 'photo_pending', display_name: '' })],
    })

    await controller.select('t-2')

    expect(previewUpdates.at(-1)).toEqual({ displayName: '待识别车牌', photos: [], initialIndex: 0 })
    expect(mapPreview.show).toHaveBeenCalledWith(expect.objectContaining({ thumbUrl: 'https://thumb' }))
  })

  it('再次点击同一卡片：关闭预览、清选中、旧请求作废，但保留记录分组', async () => {
    const { recordsStore, previewUpdates, previewTab, mapPreview, controller } = setup()
    recordsStore.current = {
      group: { id: 'task-1', routeName: '--', timeText: '--', isActive: true, statText: '0/0', items: [] },
      activeTargetId: 't-1',
    }
    await controller.select('t-1')

    expect(recordsStore.current.activeTargetId).toBe('')
    // 分组保留（只有任务切换才整体清空）
    expect(recordsStore.current.group).not.toBeNull()
    expect(previewUpdates.at(-1)).toEqual({ displayName: '', photos: [], initialIndex: 0 })
    expect(previewTab.update).toHaveBeenCalledWith({ visible: false })
    expect(mapPreview.clear).toHaveBeenCalled()
  })

  it('媒体响应乱序：过期请求不覆盖新选中', async () => {
    const { taskStore, recordsStore, previewUpdates, previewTab, getTargetMedia, controller } = setup()
    const EMPTY_MEDIA: PatrolTargetMedia = {
      target_id: 't-slow',
      status: 'pending',
      url_expires_at_ms: 0,
      initial: null,
      recheck: [],
    }
    let resolveSlow: ((value: PatrolTargetMedia) => void) | undefined
    getTargetMedia.mockImplementation(async (targetId: string): Promise<PatrolTargetMedia> => {
      if (targetId === 't-slow') {
        return new Promise<PatrolTargetMedia>((resolve) => {
          resolveSlow = resolve
        })
      }
      return { target_id: targetId, status: 'pending', url_expires_at_ms: 0, initial: null, recheck: [] }
    })
    taskStore.current = taskState({
      taskUuid: 'task-1',
      targets: [target({ target_id: 't-slow' }), target({ target_id: 't-fast' })],
    })

    const slow = controller.select('t-slow')
    const fast = controller.select('t-fast')
    await fast
    resolveSlow?.(EMPTY_MEDIA)
    await slow

    // 慢响应到达时选中已切到 t-fast → 不覆盖预览
    expect(recordsStore.current.activeTargetId).toBe('t-fast')
    expect(previewUpdates.at(-1)).toEqual({ displayName: '粤B·12345', photos: [], initialIndex: 0 })
    expect(previewTab.reveal).toHaveBeenCalledTimes(1)
    expect(previewTab.reveal).toHaveBeenCalledWith({ reason: 'patrol-record-selected', targetId: 't-fast' })
  })

  it('任务状态变化：选中车辆 photo_pending → completed 时重载媒体；无关状态变化不触发', async () => {
    const { taskStore, getTargetMedia, controller } = setup()
    taskStore.current = taskState({ taskUuid: 'task-1', targets: [target({ status: 'photo_pending' })] })
    await controller.select('t-1')
    expect(getTargetMedia).toHaveBeenCalledTimes(1)

    // 无关状态变化：status 未变
    controller.handleTaskStateChange(taskState({ taskUuid: 'task-1', targets: [target({ status: 'photo_pending' })] }))
    expect(getTargetMedia).toHaveBeenCalledTimes(1)

    // 照片入库 → 重载
    controller.handleTaskStateChange(taskState({ taskUuid: 'task-1', targets: [target({ status: 'completed' })] }))
    await vi.waitFor(() => expect(getTargetMedia).toHaveBeenCalledTimes(2))
  })

  it('任务状态变化：选中目标被移除时关闭预览', async () => {
    const { taskStore, recordsStore, previewTab, mapPreview, controller } = setup()
    taskStore.current = taskState({ taskUuid: 'task-1', targets: [target()] })
    await controller.select('t-1')

    controller.handleTaskStateChange(taskState({ taskUuid: 'task-1', targets: [] }))

    expect(recordsStore.current.activeTargetId).toBe('')
    expect(previewTab.update).toHaveBeenLastCalledWith({ visible: false })
    expect(mapPreview.clear).toHaveBeenCalled()
  })

  it('reset：清空选中、预览、图钉、tab，记录面板回到空态', async () => {
    const { recordsStore, previewTab, mapPreview, controller } = setup()
    recordsStore.current = {
      group: { id: 'task-1', routeName: '--', timeText: '--', isActive: true, statText: '0/0', items: [] },
      activeTargetId: 't-1',
    }
    await controller.select('t-2')
    controller.reset()

    expect(recordsStore.current).toEqual({ group: null, activeTargetId: '' })
    expect(previewTab.update).toHaveBeenLastCalledWith({ visible: false })
    expect(mapPreview.clear).toHaveBeenCalled()
  })
})
