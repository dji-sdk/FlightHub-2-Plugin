// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import { createHttpPatrolApi, parsePatrolWsEvent } from './patrol-api'
import type { ApiCallFn } from './patrol-api'

function apiCallFrom (routes: Record<string, unknown>): ApiCallFn {
  return vi.fn(async (endpoint: string, options?: { readonly method?: string }) => {
    const key = `${options?.method ?? 'GET'} ${endpoint}`
    if (!(key in routes)) throw new Error(`unexpected call: ${key}`)
    return routes[key] as never
  })
}

const ACTIVE_TASK = {
  code: 0,
  message: 'success',
  data: {
    link_state: 'active',
    task_uuid: 'task-1',
    reject_reason: '',
    session_id: '1024',
    wayline_uuid: 'wl-1',
    phase: 'phase2',
    completion_reason: '',
    state_revision: 37,
    allowed_actions: ['abort'],
    abort_pending: false,
    return_home_state: 'none',
    return_home_due_at_ms: 0,
    target_stats: { total: 12, pending: 3, processing: 1, completed: 7, failed: 1, skipped: 0 },
    targets: [
      {
        target_id: '88',
        status: 'completed',
        display_name: '粤B·12345',
        vehicle_class: 'car',
        lat: 22.5431,
        lng: 113.9268,
        best_frame_thumb_url: 'https://thumb',
        photo_taken_at_ms: 1756542962000,
        fail_reason: '',
      },
    ],
  },
}

describe('createHttpPatrolApi', () => {
  it('请求新版 Engine 端点并解析 active 快照', async () => {
    const apiCall = apiCallFrom({
      'GET /plugin-scene/api/v1/patrol/tasks/task-1': ACTIVE_TASK,
    })
    const api = createHttpPatrolApi(apiCall)

    const snapshot = await api.getTask('task-1')
    expect(snapshot).toEqual({
      link_state: 'active',
      task_uuid: 'task-1',
      reject_reason: '',
      session_id: '1024',
      wayline_uuid: 'wl-1',
      phase: 'phase2',
      completion_reason: '',
      state_revision: 37,
      allowed_actions: ['abort'],
      abort_pending: false,
      return_home_state: 'none',
      return_home_due_at_ms: 0,
      target_stats: { total: 12, pending: 3, processing: 1, completed: 7, failed: 1, skipped: 0 },
      targets: [expect.objectContaining({ target_id: '88', status: 'completed' })],
    })
  })

  it('非 active 快照只保留三个基础字段（不读其余数据）', async () => {
    const apiCall = apiCallFrom({
      'GET /plugin-scene/api/v1/patrol/tasks/task-1': {
        code: 0,
        data: { link_state: 'waiting', task_uuid: 'task-1', reject_reason: '', phase: 'phase2', targets: [] },
      },
    })
    const api = createHttpPatrolApi(apiCall)

    await expect(api.getTask('task-1')).resolves.toEqual({
      link_state: 'waiting',
      task_uuid: 'task-1',
      reject_reason: '',
    })
  })

  it('/current：data=null 是正常响应（当前机场没在巡逻）', async () => {
    const apiCall = apiCallFrom({
      'GET /plugin-scene/api/v1/patrol/current?dock_sn=DOCK-001': { code: 0, message: 'success', data: null },
    })
    const api = createHttpPatrolApi(apiCall)

    await expect(api.getCurrent('DOCK-001')).resolves.toBeNull()
  })

  it('/current：发现任务时解析快照', async () => {
    const apiCall = apiCallFrom({
      'GET /plugin-scene/api/v1/patrol/current?dock_sn=DOCK-001': ACTIVE_TASK,
    })
    const api = createHttpPatrolApi(apiCall)

    const snapshot = await api.getCurrent('DOCK-001')
    expect(snapshot?.link_state).toBe('active')
    expect(snapshot && snapshot.link_state === 'active' ? snapshot.task_uuid : '').toBe('task-1')
  })

  it('三个动作接口 POST 空 body 并解析统一出参', async () => {
    const apiCall = apiCallFrom({
      'POST /plugin-scene/api/v1/patrol/tasks/task-1/return-now': { code: 0, data: { return_home_state: 'pending' } },
      'POST /plugin-scene/api/v1/patrol/tasks/task-1/cancel-return': { code: 0, data: { return_home_state: 'cancelled' } },
      'POST /plugin-scene/api/v1/patrol/tasks/task-1/abort': { code: 0, data: { effective: 'pending', return_home_state: 'none' } },
    })
    const api = createHttpPatrolApi(apiCall)

    await expect(api.returnNow('task-1')).resolves.toEqual({ return_home_state: 'pending' })
    await expect(api.cancelReturn('task-1')).resolves.toEqual({ return_home_state: 'cancelled' })
    await expect(api.abort('task-1')).resolves.toEqual({ effective: 'pending', return_home_state: 'none' })
  })

  it('平台任务服务 v1 单任务详情：按路径参数请求并解析 biz_ext 与 begin_at', async () => {
    const apiCall = apiCallFrom({
      'GET /task/api/v1/workspaces/proj%2F1/flight-tasks/task%201': {
        code: 0,
        data: { uuid: 'task-1', biz_ext: { 'es-patrol': {} }, name: '任务', begin_at: '2026-09-08T11:26:14.144869+08:00' },
      },
    })
    const api = createHttpPatrolApi(apiCall)

    await expect(api.getFlightTaskDetail('proj/1', 'task 1')).resolves.toEqual({
      uuid: 'task-1',
      biz_ext: { 'es-patrol': {} },
      begin_at_ms: Date.parse('2026-09-08T11:26:14.144869+08:00'),
    })
  })

  it('平台任务服务 begin_at 缺失或非法时归 0（不抛错）', async () => {
    const apiCall = apiCallFrom({
      'GET /task/api/v1/workspaces/proj%2F1/flight-tasks/task%201': { code: 0, data: { uuid: 'task-1', biz_ext: null, begin_at: null } },
      'GET /task/api/v1/workspaces/proj%2F1/flight-tasks/task%202': { code: 0, data: { uuid: 'task-2', biz_ext: null, begin_at: 'not-a-date' } },
    })
    const api = createHttpPatrolApi(apiCall)

    await expect(api.getFlightTaskDetail('proj/1', 'task 1')).resolves.toMatchObject({ begin_at_ms: 0 })
    await expect(api.getFlightTaskDetail('proj/1', 'task 2')).resolves.toMatchObject({ begin_at_ms: 0 })
  })

  it('媒体接口：initial + recheck 分组解析', async () => {
    const apiCall = apiCallFrom({
      'GET /plugin-scene/api/v1/patrol/targets/88/media': {
        code: 0,
        data: {
          target_id: '88',
          status: 'completed',
          url_expires_at_ms: 1756546562000,
          initial: { url: 'https://initial', captured_at_ms: 1756541564000, lat: 22.5431, lng: 113.9268 },
          recheck: [
            { url: 'https://preview', original_url: 'https://original', media_type: 1, file_name: 'DJI_0042.jpg', captured_at_ms: 1756542962000 },
          ],
        },
      },
    })
    const api = createHttpPatrolApi(apiCall)

    const media = await api.getTargetMedia('88')
    expect(media.initial).toMatchObject({ url: 'https://initial' })
    expect(media.recheck).toHaveLength(1)
    expect(media.recheck[0]).toMatchObject({ original_url: 'https://original', file_name: 'DJI_0042.jpg' })
  })

  it('失败信封：code≠0 抛错（无 data 键）', async () => {
    const apiCall = apiCallFrom({
      'POST /plugin-scene/api/v1/patrol/tasks/task-1/return-now': { code: 40901, message: '当前不在等这个操作' },
    })
    const api = createHttpPatrolApi(apiCall)

    await expect(api.returnNow('task-1')).rejects.toThrow('当前不在等这个操作（code: 40901）')
  })

  it('畸形数据防御：字段缺失/类型错误归一为安全默认值', async () => {
    const apiCall = apiCallFrom({
      'GET /plugin-scene/api/v1/patrol/tasks/task-1': {
        code: 0,
        data: {
          link_state: 'active',
          task_uuid: 'task-1',
          session_id: 1024,
          state_revision: 'bad',
          allowed_actions: 'abort',
          targets: [{ no_id: true }, { target_id: '88', status: 1, lat: 'x' }],
        },
      },
    })
    const api = createHttpPatrolApi(apiCall)

    const snapshot = await api.getTask('task-1')
    expect(snapshot && snapshot.link_state === 'active').toBe(true)
    if (snapshot && snapshot.link_state === 'active') {
      expect(snapshot.session_id).toBe('1024')
      expect(snapshot.state_revision).toBe(0)
      expect(snapshot.allowed_actions).toEqual([])
      // 无 target_id 的项被丢弃；类型错误字段归一
      expect(snapshot.targets).toHaveLength(1)
      expect(snapshot.targets[0]).toMatchObject({ target_id: '88', status: 'pending' })
    }
  })
})

describe('parsePatrolWsEvent（biz_code=patrol_progress 信封）', () => {
  const META = { dock_sn: 'DOCK-1', task_uuid: 'task-1', session_id: '1024', state_revision: 6 }

  it('progress：phase/completion_reason/target_stats 三字段', () => {
    expect(parsePatrolWsEvent('progress', {
      ...META,
      phase: 'phase2',
      completion_reason: '',
      target_stats: { total: 2, pending: 0, processing: 1, completed: 1, failed: 0, skipped: 0 },
    })).toEqual({
      kind: 'progress',
      dockSn: 'DOCK-1',
      taskUuid: 'task-1',
      sessionId: '1024',
      stateRevision: 6,
      phase: 'phase2',
      completionReason: '',
      targetStats: { total: 2, pending: 0, processing: 1, completed: 1, failed: 0, skipped: 0 },
    })
  })

  it('target_updated：目标经 parseTarget 归一；缺 target_id 整条丢弃', () => {
    expect(parsePatrolWsEvent('target_updated', {
      ...META,
      target: { target_id: '88', status: 'pending', display_name: '粤B·12345', lat: 22.5, lng: 113.9 },
    })).toEqual({
      kind: 'target_updated',
      dockSn: 'DOCK-1',
      taskUuid: 'task-1',
      sessionId: '1024',
      stateRevision: 6,
      target: expect.objectContaining({ target_id: '88', status: 'pending' }),
    })
    expect(parsePatrolWsEvent('target_updated', { ...META, target: { no_id: true } })).toBeNull()
  })

  it('return_pending / return_state：due_at_ms 与 return_home_state 归一', () => {
    expect(parsePatrolWsEvent('return_pending', { ...META, due_at_ms: 12345 })).toEqual({
      kind: 'return_pending',
      dockSn: 'DOCK-1',
      taskUuid: 'task-1',
      sessionId: '1024',
      stateRevision: 6,
      dueAtMs: 12345,
    })
    expect(parsePatrolWsEvent('return_state', { ...META, return_home_state: 'pending' })).toMatchObject({
      kind: 'return_state',
      returnHomeState: 'pending',
    })
    expect(parsePatrolWsEvent('return_state', META)).toMatchObject({ kind: 'return_state', returnHomeState: 'none' })
  })

  it('未知 sub_biz_code / 非 object data 返回 null', () => {
    expect(parsePatrolWsEvent('legacy', META)).toBeNull()
    expect(parsePatrolWsEvent(null, META)).toBeNull()
    expect(parsePatrolWsEvent('progress', 'not-an-object')).toBeNull()
    expect(parsePatrolWsEvent('progress', [1, 2])).toBeNull()
  })
})
