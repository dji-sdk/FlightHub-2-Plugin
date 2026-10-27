// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { JsonValue } from 'fh2-plugin-sdk'
import type { AccidentEventsApi } from '../../api/accident-events-api'
import type { FlightActionsApi } from '../../api/flight-actions-api'
import type { AccidentWorkflowApi } from '../../api/workflow-api'
import type { AccidentListItem, AccidentRecord } from '../../workflow/types'
import {
  ACCIDENT_ALERT_WS_BIZ_CODE,
  ACCIDENT_ALERT_WS_SUB_BIZ_CODE,
  type NavigationCapability,
  createAccidentListController,
  hasPendingEvents,
} from './list-controller'

function event (status: AccidentListItem['status']): AccidentListItem {
  return {
    pluginEventId: status,
    title: '报警事件',
    occurredAt: 0,
    status,
    address: '测试地点',
    hasCoordinates: true,
  }
}

describe('accident project sidebar badge', () => {
  it('仅存在待处理事件时显示红点', () => {
    expect(hasPendingEvents([])).toBe(false)
    expect(hasPendingEvents([event('completed'), event('ignored')])).toBe(false)
    expect(hasPendingEvents([event('handling'), event('completed')])).toBe(true)
    expect(hasPendingEvents([event('unacknowledged')])).toBe(true)
  })
})

const record: AccidentRecord = {
  pluginEventId: 'incident-1',
  title: '测试事故',
  createdAt: 1,
  status: 'unacknowledged',
  priority: 'high',
  address: '福田测试路口',
  latitude: 22.5431,
  longitude: 114.0579,
  height: 0,
  rawPayload: {},
  result: null,
}

function createControllerFixture () {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const events: AccidentEventsApi = {
    listActive: vi.fn(async () => [record]),
    listAll: vi.fn(),
    getEvent: vi.fn(),
    updateEventRawPayload: vi.fn(async () => {}),
  }
  const workflow: AccidentWorkflowApi = {
    getStatus: vi.fn(async () => ({
      flow: 'accident-response',
      currentStep: 'ack',
      executed: [],
      skipped: [],
      awaitingSignal: 'acknowledge',
    })),
    acknowledge: vi.fn(async () => {}),
    selectRoute: vi.fn(async () => {}),
    ignore: vi.fn(async () => {}),
  }
  const flightActions: FlightActionsApi = {
    getMediaFolderId: vi.fn(async () => '2001'),
  }
  const navigation: NavigationCapability = {
    open: vi.fn(async () => {}),
    back: vi.fn(async () => {}),
  }
  const notifyError = vi.fn(async () => {})
  const recenter = vi.fn(async () => {})
  const focusAlert = vi.fn(async () => {})
  const clearAlertFocus = vi.fn()
  const requestDispatch = vi.fn(async () => {})
  const controller = createAccidentListController({
    ctx: { logger } as never,
    events,
    workflow,
    flightActions,
    navigation,
    projectId: 'project-1',
    organizationId: 'organization-1',
    updateBadgeVisibility: vi.fn(),
    notifyError,
    recenter,
    focusAlert,
    clearAlertFocus,
    requestDispatch,
    openAllEventsDialog: vi.fn(),
  })
  return { events, workflow, controller, logger, notifyError, requestDispatch, recenter, focusAlert, clearAlertFocus, flightActions, navigation }
}

describe('accident project handle diagnostics', () => {
  it('收到 scene_alert/alert_notify 实时通知后立即刷新列表', async () => {
    const fixture = createControllerFixture()
    await fixture.controller.fetchEvents('initial')
    vi.mocked(fixture.events.listActive).mockClear()

    fixture.controller.handleAlertNotifyWsEvent({
      bizCode: ACCIDENT_ALERT_WS_BIZ_CODE,
      subBizCode: ACCIDENT_ALERT_WS_SUB_BIZ_CODE,
      timestamp: 1_000,
      data: { incident_id: 'mock-incident-ws-1' } as JsonValue,
    })
    await vi.waitFor(() => expect(fixture.events.listActive).toHaveBeenCalledTimes(1))

    expect(fixture.logger.debug).toHaveBeenCalledWith('收到警情实时通知，刷新列表', {
      bizCode: 'scene_alert',
      subBizCode: 'alert_notify',
    })
    expect(fixture.logger.debug).toHaveBeenCalledWith(
      '事故列表请求成功',
      expect.objectContaining({ source: 'alert-notify' }),
    )
  })

  it('scene_alert 其他 sub_biz_code 不触发刷新', async () => {
    const fixture = createControllerFixture()
    await fixture.controller.fetchEvents('initial')
    vi.mocked(fixture.events.listActive).mockClear()

    fixture.controller.handleAlertNotifyWsEvent({
      bizCode: 'scene_alert',
      subBizCode: 'alert_ack_result',
      timestamp: 1_000,
      data: {},
    })

    expect(fixture.events.listActive).not.toHaveBeenCalled()
  })

  it('警情 WS 契约常量与后端协议一致', () => {
    expect(ACCIDENT_ALERT_WS_BIZ_CODE).toBe('scene_alert')
    expect(ACCIDENT_ALERT_WS_SUB_BIZ_CODE).toBe('alert_notify')
  })

  it('派遣成功后立即刷新警情列表', async () => {
    const fixture = createControllerFixture()
    await fixture.controller.fetchEvents('initial')
    vi.mocked(fixture.events.listActive).mockResolvedValueOnce([])

    await fixture.controller.handleFlowState({
      status: 'dispatched',
      pluginEventId: record.pluginEventId,
      projectId: 'project-1',
      title: record.title,
      occurredAt: record.createdAt,
    })

    expect(fixture.events.listActive).toHaveBeenCalledTimes(2)
    expect(fixture.controller.state.get().items).toEqual([])
    expect(fixture.logger.debug).toHaveBeenCalledWith(
      '事故列表请求成功',
      expect.objectContaining({ source: 'dispatch' }),
    )
  })

  it('签收成功后立即更新状态并刷新列表', async () => {
    const fixture = createControllerFixture()
    vi.mocked(fixture.events.listActive).mockImplementation(async () => [record])
    await fixture.controller.fetchEvents('initial')
    // 签收生效后活动查询返回已签收状态。
    vi.mocked(fixture.events.listActive).mockImplementation(async () => [
      { ...record, status: 'acknowledged' },
    ])

    await fixture.controller.listMethods.handle({ pluginEventId: record.pluginEventId })

    expect(fixture.events.listActive).toHaveBeenCalledTimes(2)
    expect(fixture.controller.state.get().items).toEqual([
      expect.objectContaining({ pluginEventId: record.pluginEventId, status: 'acknowledged' }),
    ])
    expect(fixture.logger.debug).toHaveBeenCalledWith(
      '事故列表请求成功',
      expect.objectContaining({ source: 'acknowledge' }),
    )
  })

  it('签收成功后保持选中并联动地图告警点', async () => {
    const fixture = createControllerFixture()
    vi.mocked(fixture.events.listActive).mockImplementation(async () => [record])
    await fixture.controller.fetchEvents('initial')

    await fixture.controller.listMethods.handle({ pluginEventId: record.pluginEventId })

    expect(fixture.controller.state.get().selectedId).toBe(record.pluginEventId)
    expect(fixture.focusAlert).toHaveBeenCalledWith({ ...record, status: 'acknowledged' })
  })

  it('地图回中失败时记录阶段警告并继续签收', async () => {
    const fixture = createControllerFixture()
    fixture.recenter.mockRejectedValueOnce(new Error('mapAppState Not Found'))
    await fixture.controller.fetchEvents('initial')

    await fixture.controller.listMethods.handle({ pluginEventId: record.pluginEventId })

    expect(fixture.workflow.getStatus).toHaveBeenCalledWith(record.pluginEventId)
    expect(fixture.workflow.acknowledge).toHaveBeenCalledWith(record.pluginEventId)
    expect(fixture.notifyError).not.toHaveBeenCalled()
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      '报警事件地图回中失败，继续处理',
      expect.objectContaining({
        action: 'handle-record',
        recordId: record.pluginEventId,
        stage: 'recenter',
        errorMessage: 'mapAppState Not Found',
        errorStack: expect.any(String),
      }),
    )
  })

  it('工作流查询失败时记录准确阶段和错误码', async () => {
    const fixture = createControllerFixture()
    const error = Object.assign(new Error('网关不可用'), { code: 'PLUGIN_GATEWAY_ERROR' })
    vi.mocked(fixture.workflow.getStatus).mockRejectedValueOnce(error)
    await fixture.controller.fetchEvents('initial')

    await expect(fixture.controller.listMethods.handle({ pluginEventId: record.pluginEventId })).rejects.toThrow('网关不可用')

    expect(fixture.workflow.acknowledge).not.toHaveBeenCalled()
    expect(fixture.notifyError).toHaveBeenCalledWith('报警事件处理失败，请稍后重试')
    expect(fixture.logger.error).toHaveBeenCalledWith(
      '报警事件处理失败',
      expect.objectContaining({
        action: 'handle-record',
        recordId: record.pluginEventId,
        stage: 'continue-workflow',
        errorCode: 'PLUGIN_GATEWAY_ERROR',
        errorMessage: '网关不可用',
      }),
    )
  })

  it('签收接口失败时记录 acknowledge 阶段且不刷新列表', async () => {
    const fixture = createControllerFixture()
    vi.mocked(fixture.workflow.acknowledge).mockRejectedValueOnce(new Error('签收信号投递失败'))
    await fixture.controller.fetchEvents('initial')
    vi.mocked(fixture.events.listActive).mockClear()

    await expect(fixture.controller.listMethods.handle({ pluginEventId: record.pluginEventId })).rejects.toThrow('签收信号投递失败')

    expect(fixture.events.listActive).not.toHaveBeenCalled()
    expect(fixture.notifyError).toHaveBeenCalledWith('报警事件处理失败，请稍后重试')
    expect(fixture.logger.error).toHaveBeenCalledWith(
      '报警事件处理失败',
      expect.objectContaining({
        recordId: record.pluginEventId,
        stage: 'continue-workflow',
        errorMessage: '签收信号投递失败',
      }),
    )
  })

  it('派遣交接失败时记录 present-dispatch 阶段', async () => {
    const fixture = createControllerFixture()
    vi.mocked(fixture.workflow.getStatus).mockResolvedValueOnce({
      flow: 'accident-response',
      currentStep: 'pick',
      executed: ['ack'],
      skipped: [],
      awaitingSignal: 'route_selected',
    })
    fixture.requestDispatch.mockRejectedValueOnce(new Error('派遣卡打开失败'))
    await fixture.controller.fetchEvents('initial')

    await expect(fixture.controller.listMethods.handle({ pluginEventId: record.pluginEventId })).rejects.toThrow('派遣卡打开失败')

    expect(fixture.logger.error).toHaveBeenCalledWith(
      '报警事件处理失败',
      expect.objectContaining({
        recordId: record.pluginEventId,
        stage: 'continue-workflow',
        errorMessage: '派遣卡打开失败',
      }),
    )
  })
})

describe('accident list selection', () => {
  const record2: AccidentRecord = {
    ...record,
    pluginEventId: 'incident-2',
    createdAt: 2,
    address: '福田二号路口',
  }

  it('点击卡片选中并联动地图告警点', async () => {
    const fixture = createControllerFixture()
    vi.mocked(fixture.events.listActive).mockResolvedValue([record, record2])
    await fixture.controller.fetchEvents('initial')

    await fixture.controller.listMethods.selectEvent({ pluginEventId: record.pluginEventId })

    expect(fixture.controller.state.get().selectedId).toBe(record.pluginEventId)
    expect(fixture.focusAlert).toHaveBeenCalledWith(record)
    expect(fixture.clearAlertFocus).not.toHaveBeenCalled()
  })

  it('重复点击同一警情取消选中并撤下告警点', async () => {
    const fixture = createControllerFixture()
    await fixture.controller.fetchEvents('initial')

    await fixture.controller.listMethods.selectEvent({ pluginEventId: record.pluginEventId })
    await fixture.controller.listMethods.selectEvent({ pluginEventId: record.pluginEventId })

    expect(fixture.controller.state.get().selectedId).toBe('')
    expect(fixture.clearAlertFocus).toHaveBeenCalledOnce()
  })

  it('切换选中时联动新警情，不撤旧点（由 focus 内部切换清理）', async () => {
    const fixture = createControllerFixture()
    vi.mocked(fixture.events.listActive).mockResolvedValue([record, record2])
    await fixture.controller.fetchEvents('initial')

    await fixture.controller.listMethods.selectEvent({ pluginEventId: record.pluginEventId })
    await fixture.controller.listMethods.selectEvent({ pluginEventId: record2.pluginEventId })

    expect(fixture.controller.state.get().selectedId).toBe(record2.pluginEventId)
    expect(fixture.focusAlert).toHaveBeenNthCalledWith(2, record2)
    expect(fixture.clearAlertFocus).not.toHaveBeenCalled()
  })

  it('选中的警情不存在时保持原状且不联动地图', async () => {
    const fixture = createControllerFixture()
    await fixture.controller.fetchEvents('initial')

    await fixture.controller.listMethods.selectEvent({ pluginEventId: 'incident-missing' })

    expect(fixture.controller.state.get().selectedId).toBe('')
    expect(fixture.focusAlert).not.toHaveBeenCalled()
    expect(fixture.clearAlertFocus).not.toHaveBeenCalled()
  })

  it('选中警情被列表移除时自动清空并撤下告警点', async () => {
    const fixture = createControllerFixture()
    await fixture.controller.fetchEvents('initial')
    await fixture.controller.listMethods.selectEvent({ pluginEventId: record.pluginEventId })
    fixture.clearAlertFocus.mockClear()

    vi.mocked(fixture.events.listActive).mockResolvedValueOnce([])
    await fixture.controller.fetchEvents('poll')

    expect(fixture.controller.state.get().selectedId).toBe('')
    expect(fixture.clearAlertFocus).toHaveBeenCalledOnce()
  })

  it('dispose 清理地图告警点', async () => {
    const fixture = createControllerFixture()
    await fixture.controller.fetchEvents('initial')

    fixture.controller.dispose()

    expect(fixture.clearAlertFocus).toHaveBeenCalledOnce()
  })
})

describe('accident feedback and ignore', () => {
  it('提交人工反馈合并 rawPayload 并回写 correctionNote', async () => {
    const fixture = createControllerFixture()
    vi.mocked(fixture.events.listActive).mockImplementation(async () => [
      { ...record, correctionNote: '警官王小明二次核对后修正' },
    ])
    await fixture.controller.fetchEvents('initial')

    await fixture.controller.listMethods.submitFeedback({ pluginEventId: record.pluginEventId, note: '警官王小明二次核对后修正' })

    expect(fixture.events.updateEventRawPayload).toHaveBeenCalledWith('incident-1', {
      correction_note: '警官王小明二次核对后修正',
    })
    expect(fixture.controller.state.get().items).toEqual([
      expect.objectContaining({ pluginEventId: record.pluginEventId, correctionNote: '警官王小明二次核对后修正' }),
    ])
    expect(fixture.events.listActive).toHaveBeenCalledTimes(2)
  })

  it('人工反馈携带原有 rawPayload 字段一起提交', async () => {
    const fixture = createControllerFixture()
    vi.mocked(fixture.events.listActive).mockImplementation(async () => [{
      ...record,
      rawPayload: { alarm_id: '20260811-001', plate_number: '粤B12345' },
    }])
    await fixture.controller.fetchEvents('initial')

    await fixture.controller.listMethods.submitFeedback({ pluginEventId: record.pluginEventId, note: '补录说明' })

    expect(fixture.events.updateEventRawPayload).toHaveBeenCalledWith('incident-1', {
      alarm_id: '20260811-001',
      plate_number: '粤B12345',
      correction_note: '补录说明',
    })
  })

  it('人工反馈接口失败时通知且不更新本地状态', async () => {
    const fixture = createControllerFixture()
    await fixture.controller.fetchEvents('initial')
    vi.mocked(fixture.events.updateEventRawPayload).mockRejectedValueOnce(new Error('网关超时'))

    await expect(fixture.controller.listMethods.submitFeedback({ pluginEventId: record.pluginEventId, note: '补录说明' }))
      .rejects.toThrow('网关超时')

    expect(fixture.notifyError).toHaveBeenCalledWith('人工反馈提交失败，请稍后重试')
    expect(fixture.controller.state.get().items).toEqual([
      expect.not.objectContaining({ correctionNote: '补录说明' }),
    ])
  })

  it('已签收警情可忽略，忽略后状态置 ignored 并刷新', async () => {
    const fixture = createControllerFixture()
    const acknowledged = { ...record, status: 'acknowledged' as const }
    vi.mocked(fixture.events.listActive).mockImplementation(async () => [acknowledged])
    await fixture.controller.fetchEvents('initial')
    // 忽略是终态，刷新后不应再出现在活动查询结果中。
    vi.mocked(fixture.events.listActive).mockImplementation(async () => [])

    await fixture.controller.listMethods.ignoreIncident({ pluginEventId: record.pluginEventId })

    expect(fixture.workflow.ignore).toHaveBeenCalledWith('incident-1')
    expect(fixture.controller.state.get().items).toEqual([])
    expect(fixture.events.listActive).toHaveBeenCalledTimes(2)
  })

  it('未签收警情忽略被拒绝且不发信号', async () => {
    const fixture = createControllerFixture()
    await fixture.controller.fetchEvents('initial')

    await expect(fixture.controller.listMethods.ignoreIncident({ pluginEventId: record.pluginEventId }))
      .rejects.toThrow('仅已签收警情可以忽略')

    expect(fixture.workflow.ignore).not.toHaveBeenCalled()
    expect(fixture.controller.state.get().items).toEqual([
      expect.objectContaining({ pluginEventId: record.pluginEventId, status: 'unacknowledged' }),
    ])
  })

  it('忽略信号失败时通知且状态保持已签收', async () => {
    const fixture = createControllerFixture()
    const acknowledged = { ...record, status: 'acknowledged' as const }
    vi.mocked(fixture.events.listActive).mockImplementation(async () => [acknowledged])
    await fixture.controller.fetchEvents('initial')
    vi.mocked(fixture.workflow.ignore).mockRejectedValueOnce(new Error('信号投递失败'))

    await expect(fixture.controller.listMethods.ignoreIncident({ pluginEventId: record.pluginEventId }))
      .rejects.toThrow('信号投递失败')

    expect(fixture.notifyError).toHaveBeenCalledWith('警情忽略失败，请稍后重试')
    expect(fixture.controller.state.get().items).toEqual([
      expect.objectContaining({ pluginEventId: record.pluginEventId, status: 'acknowledged' }),
    ])
  })
})

describe('accident all-events dialog resource actions', () => {
  it('getMediaFolderId 用 projectId 查询并返回 folderId', async () => {
    const fixture = createControllerFixture()

    await expect(fixture.controller.dialogMethods.getMediaFolderId({ flightMissionId: 'flight-1' }))
      .resolves.toBe('2001')

    expect(fixture.flightActions.getMediaFolderId).toHaveBeenCalledWith('project-1', 'flight-1')
  })

  it('getMediaFolderId 失败时静默返回 null 不弹错误通知', async () => {
    const fixture = createControllerFixture()
    vi.mocked(fixture.flightActions.getMediaFolderId).mockRejectedValueOnce(new Error('网关 404'))

    await expect(fixture.controller.dialogMethods.getMediaFolderId({ flightMissionId: 'flight-1' }))
      .resolves.toBeNull()

    expect(fixture.notifyError).not.toHaveBeenCalled()
    expect(fixture.logger.debug).toHaveBeenCalledWith(
      '媒体文件夹查询失败，按未生成处理',
      expect.objectContaining({ flightMissionId: 'flight-1' }),
    )
  })

  it('openFlightRecord 新标签打开飞行记录 URL', async () => {
    const fixture = createControllerFixture()

    fixture.controller.dialogMethods.openFlightRecord({ flightMissionId: 'flight-1' })
    await Promise.resolve()

    expect(fixture.navigation.open).toHaveBeenCalledWith(
      '/organization/organization-1/project/project-1#/flight-path?id=flight-1',
      { target: 'blank' },
    )
  })

  it('openMediaLibrary 新标签打开媒体库 URL', async () => {
    const fixture = createControllerFixture()

    fixture.controller.dialogMethods.openMediaLibrary({ folderId: '2001' })
    await Promise.resolve()

    expect(fixture.navigation.open).toHaveBeenCalledWith(
      '/organization/organization-1/project/project-1#/media?pid=2001',
      { target: 'blank' },
    )
  })

  it('空 id 时跳转为 no-op', () => {
    const fixture = createControllerFixture()

    fixture.controller.dialogMethods.openFlightRecord({ flightMissionId: '' })
    fixture.controller.dialogMethods.openMediaLibrary({ folderId: '' })

    expect(fixture.navigation.open).not.toHaveBeenCalled()
  })
})

function recordWithoutCoordinates (rawPayload: Readonly<Record<string, JsonValue>> = {}): AccidentRecord {
  return {
    pluginEventId: record.pluginEventId,
    title: record.title,
    createdAt: record.createdAt,
    status: record.status,
    priority: record.priority,
    address: record.address,
    height: record.height,
    rawPayload,
    result: record.result,
  }
}

describe('accident coordinate supplement', () => {
  it('补录坐标合并原 rawPayload 写入 lat/lng 并回写本地', async () => {
    const fixture = createControllerFixture()
    let current: AccidentRecord = recordWithoutCoordinates({ addr: '北环大道' })
    vi.mocked(fixture.events.listActive).mockImplementation(async () => [current])
    vi.mocked(fixture.events.updateEventRawPayload).mockImplementation(async (_id, rawPayload) => {
      const payload = rawPayload as Readonly<Record<string, JsonValue>>
      const lat = typeof payload.lat === 'number' ? payload.lat : Number(payload.lat)
      const lng = typeof payload.lng === 'number' ? payload.lng : Number(payload.lng)
      current = {
        ...recordWithoutCoordinates(payload),
        ...(Number.isFinite(lat) && Number.isFinite(lng) ? { latitude: lat, longitude: lng } : {}),
      }
    })
    await fixture.controller.fetchEvents('initial')

    await fixture.controller.listMethods.submitCoordinates({ pluginEventId: record.pluginEventId, lat: 22.5, lng: 114.05 })

    expect(fixture.events.updateEventRawPayload).toHaveBeenCalledWith('incident-1', {
      addr: '北环大道',
      lat: 22.5,
      lng: 114.05,
    })
    expect(fixture.controller.state.get().items).toEqual([
      expect.objectContaining({ pluginEventId: record.pluginEventId, latitude: 22.5, longitude: 114.05, hasCoordinates: true }),
    ])
    expect(fixture.events.listActive).toHaveBeenCalledTimes(2)
  })

  it('已有坐标时拒绝二次补录且不调用接口', async () => {
    const fixture = createControllerFixture()
    await fixture.controller.fetchEvents('initial')

    await expect(fixture.controller.listMethods.submitCoordinates({ pluginEventId: record.pluginEventId, lat: 22.6, lng: 114.1 }))
      .rejects.toThrow('警情已有坐标，不能重复补录')

    expect(fixture.events.updateEventRawPayload).not.toHaveBeenCalled()
    expect(fixture.controller.state.get().items).toEqual([
      expect.objectContaining({ pluginEventId: record.pluginEventId, latitude: 22.5431, longitude: 114.0579 }),
    ])
  })

  it('补录接口失败时通知且不更新本地坐标', async () => {
    const fixture = createControllerFixture()
    vi.mocked(fixture.events.listActive).mockImplementation(async () => [recordWithoutCoordinates()])
    await fixture.controller.fetchEvents('initial')
    vi.mocked(fixture.events.updateEventRawPayload).mockRejectedValueOnce(new Error('网关超时'))

    await expect(fixture.controller.listMethods.submitCoordinates({ pluginEventId: record.pluginEventId, lat: 22.5, lng: 114.05 }))
      .rejects.toThrow('网关超时')

    expect(fixture.notifyError).toHaveBeenCalledWith('报警事件坐标补录失败，请稍后重试')
    expect(fixture.controller.state.get().items).toEqual([
      expect.not.objectContaining({ latitude: 22.5 }),
    ])
  })

  it('补录后人工反馈合并 rawPayload 时保留已补录坐标', async () => {
    const fixture = createControllerFixture()
    let current: AccidentRecord = recordWithoutCoordinates({ id: 'MOCKP-000018' })
    vi.mocked(fixture.events.listActive).mockImplementation(async () => [current])
    vi.mocked(fixture.events.updateEventRawPayload).mockImplementation(async (_id, rawPayload) => {
      const payload = rawPayload as Readonly<Record<string, JsonValue>>
      const lat = typeof payload.lat === 'number' ? payload.lat : Number(payload.lat)
      const lng = typeof payload.lng === 'number' ? payload.lng : Number(payload.lng)
      current = {
        ...recordWithoutCoordinates(payload),
        ...(Number.isFinite(lat) && Number.isFinite(lng) ? { latitude: lat, longitude: lng } : {}),
      }
    })
    await fixture.controller.fetchEvents('initial')

    await fixture.controller.listMethods.submitCoordinates({ pluginEventId: record.pluginEventId, lat: 22.5, lng: 114.05 })
    await fixture.controller.listMethods.submitFeedback({ pluginEventId: record.pluginEventId, note: '补录说明' })

    expect(fixture.events.updateEventRawPayload).toHaveBeenLastCalledWith('incident-1', {
      id: 'MOCKP-000018',
      lat: 22.5,
      lng: 114.05,
      correction_note: '补录说明',
    })
  })
})
