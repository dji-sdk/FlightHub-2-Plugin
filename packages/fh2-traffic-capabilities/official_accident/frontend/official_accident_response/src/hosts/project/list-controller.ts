// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createViewState } from 'fh2-plugin-sdk'
import type { JsonValue, PluginCapabilityClient, PluginWsEvent } from 'fh2-plugin-sdk'
import type { AccidentEventsApi } from '../../api/accident-events-api'
import { ACCIDENT_PAGE_SIZE } from '../../api/accident-events-api'
import type { FlightActionsApi } from '../../api/flight-actions-api'
import type { AccidentWorkflowApi } from '../../api/workflow-api'
import type { AlertFlowSnapshot } from '../../services/alert-flow'
import { continueIncidentWorkflow } from '../../workflow/incident-actions'
import { errorLogDetail } from '../../workflow/errors'
import { createDispatchRequest, toAccidentListItem } from '../../workflow/incident-message'
import type { AccidentListItem, AccidentRecord, AllEventsQuery, DispatchRequest } from '../../workflow/types'
import type { AccidentProjectContext } from '../../types'

type FetchSource = 'initial' | 'poll' | 'alert-notify' | 'acknowledge' | 'coordinates' | 'dispatch' | 'feedback' | 'ignore'

/** 警情实时通知的 WS biz_code / sub_biz_code 契约。 */
export const ACCIDENT_ALERT_WS_BIZ_CODE = 'scene_alert'
export const ACCIDENT_ALERT_WS_SUB_BIZ_CODE = 'alert_notify'

/** 全部事件列表「媒体库 / 飞行记录」跳转使用的导航能力。 */
export type NavigationCapability = PluginCapabilityClient<'platform:navigation'>

interface AccidentListControllerOptions {
  readonly ctx: AccidentProjectContext;
  readonly events: AccidentEventsApi;
  readonly workflow: AccidentWorkflowApi;
  readonly flightActions: FlightActionsApi;
  readonly navigation: NavigationCapability;
  readonly projectId: string;
  readonly organizationId: string;
  readonly updateBadgeVisibility: (visible: boolean) => void | Promise<void>;
  readonly notifyError: (message: string) => void | Promise<void>;
  readonly recenter: (record: AccidentRecord) => void | Promise<void>;
  readonly focusAlert: (record: AccidentRecord) => void | Promise<void>;
  readonly clearAlertFocus: () => void;
  readonly requestDispatch: (request: DispatchRequest) => void | Promise<void>;
  readonly openAllEventsDialog: () => void | Promise<void>;
}

export function hasPendingEvents (items: readonly AccidentListItem[]): boolean {
  return items.some(item => item.status === 'unacknowledged' || item.status === 'acknowledged' || item.status === 'handling')
}

export function createAccidentListController (options: AccidentListControllerOptions) {
  const { ctx, events, workflow, projectId } = options
  const records = new Map<string, AccidentRecord>()
  const state = createViewState({
    items: [] as readonly AccidentListItem[],
    loading: true,
    selectedId: '',
  })
  let fetchSequence = 0
  let disposed = false

  function publishList (loading = false): void {
    const items = [...records.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, ACCIDENT_PAGE_SIZE)
      .map(toAccidentListItem)
    // 选中警情已不在列表（被处理完/超时移除）时清空选中并撤下地图告警点。
    const previousSelectedId = state.get().selectedId
    const selectedId = previousSelectedId !== ''
      && items.some(item => item.pluginEventId === previousSelectedId)
      ? previousSelectedId
      : ''
    if (previousSelectedId !== '' && selectedId === '') options.clearAlertFocus()
    state.update(current => ({ ...current, items, loading, selectedId }))
    const pendingCount = items.filter(item => item.status === 'unacknowledged' || item.status === 'acknowledged' || item.status === 'handling').length
    void options.updateBadgeVisibility(hasPendingEvents(items))
    ctx.logger.debug('事故列表状态已发布', { itemCount: items.length, pendingCount })
  }

  /** 用户点击卡片：切换选中态并联动地图告警点；重复点击同一警情时取消选中。 */
  async function selectEvent (id: string): Promise<void> {
    if (disposed) return
    if (state.get().selectedId === id) {
      state.update(value => ({ ...value, selectedId: '' }))
      options.clearAlertFocus()
      return
    }
    await selectRecord(id)
  }

  /** 内部选中（签收/派遣成功路径）：非 toggle，已选中时 no-op。 */
  async function selectRecord (id: string): Promise<void> {
    if (disposed) return
    if (state.get().selectedId === id) return
    const record = records.get(id)
    if (!record) return
    state.update(value => ({ ...value, selectedId: id }))
    try {
      await options.focusAlert(record)
    } catch (error) {
      ctx.logger.warn('警情地图告警点联动失败', errorLogDetail(error, '地图告警点联动失败'))
    }
  }

  async function fetchEvents (source: FetchSource): Promise<void> {
    const request = ++fetchSequence
    state.update(current => ({ ...current, loading: current.items.length === 0 }))
    ctx.logger.debug('事故列表开始请求', { request, source })
    try {
      const fetched = await events.listActive()
      if (disposed || request !== fetchSequence) return
      const fetchedIds = new Set(fetched.map(record => record.pluginEventId))
      for (const id of records.keys()) {
        if (!fetchedIds.has(id)) records.delete(id)
      }
      for (const record of fetched) {
        const current = records.get(record.pluginEventId)
        const preserveHandling = current?.status === 'handling'
          && (record.status === 'unacknowledged' || record.status === 'acknowledged')
        records.set(record.pluginEventId, preserveHandling
          ? { ...record, status: 'handling' }
          : record)
      }
      const detail = { request, source, parsedCount: fetched.length }
      if (source === 'initial') ctx.logger.info('事故列表首次请求成功', detail)
      else ctx.logger.debug('事故列表请求成功', detail)
      publishList()
    } catch (error) {
      if (disposed || request !== fetchSequence) return
      const detail = errorLogDetail(error, '事故列表加载失败')
      if (source === 'poll') ctx.logger.warn('事故列表轮询失败', { request, ...detail })
      else ctx.logger.error('事故列表请求失败', { request, source, ...detail })
      publishList()
      if (source === 'initial') await options.notifyError('报警事件加载失败，请稍后重试')
    }
  }

  async function runUserAction<T> (message: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error) {
      ctx.logger.error(message, errorLogDetail(error, message))
      await options.notifyError(message)
      throw error
    }
  }

  async function handleRecord (id: string): Promise<void> {
    type HandleStage =
      | 'load-record'
      | 'recenter'
      | 'continue-workflow'
      | 'refresh-list'
      | 'present-dispatch'

    let stage: HandleStage = 'load-record'
    ctx.logger.info('报警事件处理开始', { action: 'handle-record', recordId: id })
    try {
      const record = requireRecord(records, id)
      stage = 'recenter'
      try {
        await options.recenter(record)
        ctx.logger.debug('报警事件地图回中完成', { action: 'handle-record', recordId: id, stage })
      } catch (error) {
        ctx.logger.warn('报警事件地图回中失败，继续处理', {
          action: 'handle-record',
          recordId: id,
          stage,
          ...errorLogDetail(error, '地图回中失败'),
        })
      }

      stage = 'continue-workflow'
      const result = await continueIncidentWorkflow({
        pluginEventId: record.pluginEventId,
        workflow,
        requestDispatch: () => options.requestDispatch(
          createDispatchRequest(record, projectId, options.organizationId),
        ),
      })
      ctx.logger.debug('报警事件工作流状态已读取', {
        action: 'handle-record',
        recordId: id,
        stage,
        awaitingSignal: result.workflow.awaitingSignal,
        currentStep: result.workflow.currentStep,
      })
      if (result.outcome === 'acknowledged') {
        ctx.logger.info('报警事件签收成功', { action: 'handle-record', recordId: id, stage })
        records.set(record.pluginEventId, { ...record, status: 'acknowledged' })
        publishList()
        await selectRecord(record.pluginEventId)
        stage = 'refresh-list'
        await fetchEvents('acknowledge')
        return
      }
      stage = 'present-dispatch'
      await selectRecord(record.pluginEventId)
      ctx.logger.info('报警事件已转交派遣', { action: 'handle-record', recordId: id, stage })
    } catch (error) {
      const message = '报警事件处理失败，请稍后重试'
      ctx.logger.error('报警事件处理失败', {
        action: 'handle-record',
        recordId: id,
        stage,
        ...errorLogDetail(error, message),
      })
      await options.notifyError(message)
      throw error
    }
  }

  const listMethods = {
    handle: ({ pluginEventId }: { readonly pluginEventId: string }) => handleRecord(pluginEventId),
    selectEvent: ({ pluginEventId }: { readonly pluginEventId: string }) => selectEvent(pluginEventId),
    submitFeedback: ({ pluginEventId, note }: { readonly pluginEventId: string; readonly note: string }) => (
      runUserAction('人工反馈提交失败，请稍后重试', async () => {
        const record = requireRecord(records, pluginEventId)
        const rawPayload: Record<string, JsonValue> = { ...record.rawPayload, correction_note: note }
        await events.updateEventRawPayload(record.pluginEventId, rawPayload)
        records.set(record.pluginEventId, { ...record, rawPayload, correctionNote: note })
        publishList()
        await fetchEvents('feedback')
      })
    ),
    ignoreIncident: ({ pluginEventId }: { readonly pluginEventId: string }) => (
      runUserAction('警情忽略失败，请稍后重试', async () => {
        const record = requireRecord(records, pluginEventId)
        if (record.status !== 'acknowledged') throw new Error('仅已签收警情可以忽略')
        await workflow.ignore(record.pluginEventId)
        records.set(record.pluginEventId, { ...record, status: 'ignored' })
        publishList()
        await fetchEvents('ignore')
      })
    ),
    submitCoordinates: ({ pluginEventId, lat, lng }: { readonly pluginEventId: string; readonly lat: number; readonly lng: number }) => (
      runUserAction('报警事件坐标补录失败，请稍后重试', async () => {
        const record = requireRecord(records, pluginEventId)
        if (record.latitude !== undefined && record.longitude !== undefined) {
          throw new Error('警情已有坐标，不能重复补录')
        }
        const rawPayload: Record<string, JsonValue> = { ...record.rawPayload, lat, lng }
        await events.updateEventRawPayload(record.pluginEventId, rawPayload)
        records.set(record.pluginEventId, { ...record, latitude: lat, longitude: lng, rawPayload })
        publishList()
        await fetchEvents('coordinates')
      })
    ),
    openAllEventsDialog: () => options.openAllEventsDialog(),
  }

  const dialogMethods = {
    loadAllEvents: (input: AllEventsQuery) => runUserAction(
      '警情列表加载失败，请稍后重试',
      () => events.listAll(input),
    ),
    getMediaFolderId: ({ flightMissionId }: { readonly flightMissionId: string }) => (
      options.flightActions.getMediaFolderId(projectId, flightMissionId).catch((error) => {
        // 媒体上传晚于任务完成，详情未就绪或网关暂缺端点都按「未生成」处理，不打扰用户。
        ctx.logger.debug('媒体文件夹查询失败，按未生成处理', {
          flightMissionId,
          ...errorLogDetail(error, '媒体文件夹查询失败'),
        })
        return null
      })
    ),
    openFlightRecord: ({ flightMissionId }: { readonly flightMissionId: string }) => {
      if (flightMissionId === '') return
      void options.navigation
        .open(projectUrl(`#/flight-path?id=${encodeURIComponent(flightMissionId)}`), { target: 'blank' })
        .catch(error => ctx.logger.warn('打开飞行记录失败', errorLogDetail(error, '打开飞行记录失败')))
    },
    openMediaLibrary: ({ folderId }: { readonly folderId: string }) => {
      if (folderId === '') return
      void options.navigation
        .open(projectUrl(`#/media?pid=${encodeURIComponent(folderId)}`), { target: 'blank' })
        .catch(error => ctx.logger.warn('打开媒体库失败', errorLogDetail(error, '打开媒体库失败')))
    },
  }

  function projectUrl (hash: string): string {
    return `/organization/${encodeURIComponent(options.organizationId)}`
      + `/project/${encodeURIComponent(projectId)}${hash}`
  }

  async function handleFlowState (snapshot: AlertFlowSnapshot): Promise<void> {
    if (!snapshot.pluginEventId || snapshot.status !== 'dispatched') return
    const record = records.get(snapshot.pluginEventId)
    if (record) {
      records.set(record.pluginEventId, { ...record, status: 'handling' })
      publishList()
    }
    await fetchEvents('dispatch')
  }

  /** 订阅 scene_alert biz_code 后的回调：仅警情通知触发即时刷新，其余 sub_biz_code 忽略。 */
  function handleAlertNotifyWsEvent (event: PluginWsEvent): void {
    if (event.subBizCode !== ACCIDENT_ALERT_WS_SUB_BIZ_CODE) return
    ctx.logger.debug('收到警情实时通知，刷新列表', {
      bizCode: event.bizCode,
      subBizCode: event.subBizCode,
    })
    void fetchEvents('alert-notify')
  }

  return {
    state,
    listMethods,
    dialogMethods,
    fetchEvents,
    handleFlowState,
    handleAlertNotifyWsEvent,
    dispose: () => {
      disposed = true
      fetchSequence++
      options.clearAlertFocus()
    },
  }
}

function requireRecord (records: ReadonlyMap<string, AccidentRecord>, id: string): AccidentRecord {
  const record = records.get(id)
  if (!record) throw new Error(`警情不存在：${id}`)
  return record
}
