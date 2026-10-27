// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type {
  CockpitContextState,
  Disposable,
  FlightTaskState,
  TrackedTimers,
} from 'fh2-plugin-sdk'
import type { PatrolApi } from '../../api/patrol-api'
import { parsePatrolWsEvent } from '../../api/patrol-api'
import type { PatrolTaskSnapshot } from '../../api/types'
import type { PatrolTaskState, PatrolWsMessage } from '../../workflow/patrol-session'
import {
  activatePatrolTask,
  applyRouteName,
  applyTaskSnapshot,
  applyWsMessage,
  createInitialPatrolState,
  isPollingFinished,
  setInitialProgress,
} from '../../workflow/patrol-session'
import type { PatrolRuntimeControlEvent, PatrolRuntimeControlState } from './patrol-runtime-machine'
import { createInitialRuntimeControlState, reducePatrolRuntimeControl } from './patrol-runtime-machine'

const POLL_INTERVAL_MS = 2000
const MAX_POLL_BACKOFF_MS = 30_000
const MAX_IDENTIFICATION_ATTEMPTS = 3
// /current 发现的快慢两档：连续未发现活跃任务（null 或终态）先按 2s 快查，
// 累计 DISCOVERY_FAST_POLLS 次未命中后降频为 15s 慢查；发现活跃任务或观察
// 对象变化（epoch+1）即恢复快查。空闲会话请求量约降 87%，定时巡逻最长延迟 15s。
const DISCOVERY_FAST_POLLS = 10
const DISCOVERY_SLOW_MS = 15_000

interface StateStore<T> {
  get (): T;
  update (updater: (current: T) => T): void;
  subscribe (listener: (state: T) => void): Disposable;
}

interface ContextSource {
  getState (): Promise<CockpitContextState>;
  onStateChanged (handler: (state: CockpitContextState) => void): Promise<Disposable>;
}

interface FlightTaskSource {
  getState (): Promise<FlightTaskState>;
  onStateChanged (handler: (state: FlightTaskState) => void): Promise<Disposable>;
}

interface MockEvents {
  onTaskArrived (handler: (taskUuid: string, startedAtMs: number) => void): () => void;
  onWsMessage (handler: (message: PatrolWsMessage) => void): () => void;
  onFlightTaskProgress (handler: (event: { taskUuid: string; done: number; total: number }) => void): () => void;
}

export interface PatrolRuntimeDeps {
  readonly api: PatrolApi;
  readonly timers: TrackedTimers;
  readonly taskState: StateStore<PatrolTaskState>;
  readonly context: ContextSource | null;
  readonly flightTask: FlightTaskSource | null;
  readonly mockEvents: MockEvents | null;
  readonly subscribeWs: ((handler: (event: { subBizCode: string | null; data: unknown }) => void) => Promise<Disposable>) | null;
  readonly onTaskActivated: (taskUuid: string) => Promise<void>;
  readonly onError: (operation: string, error: unknown) => void;
}

export interface PatrolRuntime {
  start (): Promise<void>;
  refresh (): void;
  dispose (): Promise<void>;
}

interface ActiveRequest {
  readonly id: number;
  readonly epoch: number;
}

interface RouteLoad {
  readonly key: string;
  readonly epoch: number;
}

/**
 * Cockpit 外部数据的唯一入口：识别任务，合并 HTTP/WS/航点进度，并维护轮询生命周期。
 *
 * 模块架构与数据流（真实宿主，enableMock=false）：
 *
 *   宿主 context(项目/机场) ─┐
 *   宿主 flightTask(任务)   ─┼─→ 【本文件：副作用层】
 *   巡逻业务 WS ────────────┘         │ ① 订阅事件，transition() 推进控制状态机
 *                                    │ ② runPoll() 按当前状态决定发什么 HTTP 请求
 *                                    │ ③ 响应先过 epoch 身份校验，过期即丢弃，否则写 taskState
 *                                    ▼
 *         ┌─ patrol-runtime-machine.ts：控制状态机（纯函数）★状态流转图见其顶部注释
 *         └─ patrol-session.ts：快照/WS/进度合并（纯函数）
 *                                    │
 *                                    ▼
 *                         taskState（Panel 共享状态）
 *
 * 本文件只负责订阅、调度和提交数据；「现在该处于什么阶段」的判断全部交给
 * 状态机（`control` 就是它的当前快照），「业务字段怎么合并」全部交给 patrol-session。
 *
 * Mock（enableMock=true）没有 context/flightTask/WS，只走 mockEvents 三条回调，
 * 任务激活由 Mock 事件直接驱动。
 *
 * 任务识别有两条入口：flightTask 有 taskId 时拉详情读 biz_ext；页面刷新、其他
 * 操作员和定时巡逻等无 taskId 场景从 /current 发现，拿到 taskId 后统一转 tracking。
 * /current 发现按快慢两档调度：连续未命中（null/终态）先 2s 快查 10 次，再降频
 * 15s 慢查；发现活跃任务或 epoch 变化恢复快查。
 *
 * 并发防护全部围绕 control.epoch：任务/项目/机场任一变化都会让 epoch +1，
 * 旧请求稍后返回时经 isCurrentRequest 校验失败被直接丢弃，绝不会写进 taskState。
 */
export function createPatrolRuntime (deps: PatrolRuntimeDeps): PatrolRuntime {
  // start 期间拿到的全部订阅，dispose 时逆序释放。
  const localDisposables: Disposable[] = []
  // 控制状态机当前状态：唯一事实来源，只能通过 transition() 推进。
  let control: PatrolRuntimeControlState = createInitialRuntimeControlState()
  // 当前挂着的轮询定时器句柄（自调度模式：每轮结束后再排下一轮，没有永久 interval）。
  let scheduledPoll: unknown = null
  // 在途请求标记；同一 epoch 内同时只允许一个，后来的请求要么排队要么记 pending。
  let activeRequest: ActiveRequest | null = null
  // 请求自增 id：区分同 epoch 内先后两次轮询，防止旧 finally 误清新请求。
  let requestSequence = 0
  // 连续失败次数：决定下次退避时长，成功后清零。
  let pollFailureCount = 0
  // /current 连续未发现活跃任务（null 或终态）的次数：达到阈值后降频慢查；
  // 发现活跃任务或 epoch 变化清零。
  let discoveryMissCount = 0
  // 在途请求期间又来了 refresh：先记下，等在途请求结束后立刻补一轮。
  let refreshPending = false
  // 路段名查询的去重/过期标记：同一 (项目,任务,航线) 只查一次。
  let routeLoad: RouteLoad | null = null
  // start 装配完成前不发任何请求，避免订阅未就绪时丢事件。
  let ready = false
  // start / dispose 都幂等：重复调用复用同一个 Promise。
  let startPromise: Promise<void> | null = null
  let disposePromise: Promise<void> | null = null

  function isDisposed (): boolean {
    return control.kind === 'disposed'
  }

  function report (operation: string, error: unknown): void {
    if (!isDisposed()) deps.onError(operation, error)
  }

  function clearScheduledPoll (): void {
    if (scheduledPoll === null) return
    deps.timers.clearTimeout(scheduledPoll)
    scheduledPoll = null
  }

  function resetRouteLoad (): void {
    routeLoad = null
  }

  /** 推进控制状态机的唯一入口；epoch 变化 = 观察对象变了，立即作废挂起的轮询和在途标记。 */
  function transition (event: PatrolRuntimeControlEvent): PatrolRuntimeControlState {
    const previousEpoch = control.epoch
    control = reducePatrolRuntimeControl(control, event)
    if (control.epoch !== previousEpoch) {
      // 新 epoch 可以立刻发请求；旧请求即使稍后返回，也只能通过身份校验后被丢弃。
      clearScheduledPoll()
      refreshPending = false
      pollFailureCount = 0
      discoveryMissCount = 0
      resetRouteLoad()
    }
    return control
  }

  /** 自调度轮询的定时器：到点后若 epoch 未变，先解除识别退避（wait→candidate）再发起一轮请求。 */
  function schedulePoll (delayMs: number): void {
    if (!ready || isDisposed()) return
    clearScheduledPoll()
    const epoch = control.epoch
    scheduledPoll = deps.timers.setTimeout(() => {
      scheduledPoll = null
      if (control.epoch !== epoch || isDisposed()) return
      if (control.kind === 'classification-wait') transition({ type: 'classification-retry' })
      requestPoll()
    }, delayMs)
  }

  /** 失败退避：连续第 n 次失败等 2^n 秒（2s→4s→8s…），封顶 30s。 */
  function nextBackoff (): number {
    pollFailureCount++
    return Math.min(POLL_INTERVAL_MS * (2 ** (pollFailureCount - 1)), MAX_POLL_BACKOFF_MS)
  }

  /** 成功路径：失败计数清零，按正常 2s 节奏安排下一轮。 */
  function scheduleAfterSuccess (): void {
    pollFailureCount = 0
    schedulePoll(POLL_INTERVAL_MS)
  }

  /** 发现轮询未命中（null/终态）：失败计数清零，按快慢两档安排下一轮。 */
  function scheduleAfterDiscoveryMiss (): void {
    pollFailureCount = 0
    schedulePoll(discoveryMissCount >= DISCOVERY_FAST_POLLS ? DISCOVERY_SLOW_MS : POLL_INTERVAL_MS)
  }

  function isCurrentRequest (request: ActiveRequest): boolean {
    return !isDisposed() && control.epoch === request.epoch
  }

  function isClassifyingTask (taskUuid: string): boolean {
    return control.kind === 'classifying' && control.taskUuid === taskUuid
  }

  function isTrackingTask (taskUuid: string): boolean {
    return control.kind === 'tracking' && control.taskUuid === taskUuid
  }

  /**
   * 立即发起一轮轮询（取代已排定的定时器）。
   * force=true 表示用户显式 refresh：可以把已挂起的识别（classification-paused）重新拉起。
   * 同 epoch 已有在途请求时不并发，只记 refreshPending，等在途请求结束后补一轮。
   */
  function requestPoll (force = false): void {
    if (!ready || isDisposed()) return
    clearScheduledPoll()
    if (force && control.kind === 'classification-paused') {
      transition({ type: 'classification-refresh' })
    }
    if (activeRequest?.epoch === control.epoch) {
      // 操作接口后的 refresh 不能被正在执行的定时轮询吞掉。
      refreshPending = true
      return
    }
    void runPoll()
  }

  /**
   * 单轮轮询的调度核心：按控制状态决定这一轮做什么——
   * candidate → 识别观察中的任务；tracking → 拉巡逻快照；
   * idle 且无 mock → 通过 /current 发现没有 taskId 的当前巡逻任务（快慢两档降频）。
   * finally 里补执行被在途请求吞掉的 refresh。
   */
  async function runPoll (): Promise<void> {
    const request: ActiveRequest = { id: ++requestSequence, epoch: control.epoch }
    activeRequest = request
    try {
      if (control.kind === 'candidate') {
        await classifyObservedTask(request)
      } else if (control.kind === 'tracking') {
        await pollTrackedTask(request, control.taskUuid)
      } else if (control.kind === 'idle' && !deps.mockEvents && !control.observedTaskId && control.gatewaySn) {
        await discoverCurrentTask(request, control.gatewaySn)
      }
    } finally {
      if (activeRequest?.id === request.id) {
        activeRequest = null
        if (refreshPending && !isDisposed()) {
          refreshPending = false
          requestPoll()
        }
      }
    }
  }

  /**
   * 识别观察中的飞行任务是否为巡逻任务：拉 平台任务服务 详情，看 biz_ext 是否含 es-patrol。
   * 含 → 激活并立即进入跟踪轮询；详情存在但不含 → non-patrol（不再轮询）；
   * 失败/详情不存在 → 计一次识别失败。响应先过 isCurrentRequest/isClassifyingTask
   * 身份校验，过期即丢弃。
   */
  async function classifyObservedTask (request: ActiveRequest): Promise<void> {
    if (control.kind !== 'candidate' || !control.projectId) return
    const projectId = control.projectId
    const taskUuid = control.taskUuid
    transition({ type: 'classification-started' })
    try {
      const detail = await deps.api.getFlightTaskDetail(projectId, taskUuid)
      if (!isCurrentRequest(request) || !isClassifyingTask(taskUuid)) return
      if (detail?.biz_ext && 'es-patrol' in detail.biz_ext) {
        activateTask(taskUuid, undefined, detail.begin_at_ms)
        requestPoll()
        return
      }
      if (detail) {
        transition({ type: 'classified-non-patrol' })
        return
      }
      handleClassificationFailure()
    } catch (error) {
      if (!isCurrentRequest(request)) return
      report('识别巡逻任务失败', error)
      handleClassificationFailure()
    }
  }

  /** 识别失败：3 次以内按 2s/4s 退避重试；第 3 次失败转 classification-paused 挂起。 */
  function handleClassificationFailure (): void {
    transition({ type: 'classification-failed', maxAttempts: MAX_IDENTIFICATION_ATTEMPTS })
    if (control.kind !== 'classification-wait') return
    const delay = POLL_INTERVAL_MS * (2 ** (control.attempts - 1))
    schedulePoll(delay)
  }

  /** 激活巡逻任务：重置/更新 taskState、状态机转 tracking、展开记录面板并拉初始航点进度。 */
  function activateTask (taskUuid: string, snapshot?: PatrolTaskSnapshot, startedAtMs = 0): void {
    if (isDisposed()) return
    const isNewTask = deps.taskState.get().taskUuid !== taskUuid
    if (isNewTask) deps.taskState.update(state => activatePatrolTask(state, taskUuid, startedAtMs))
    transition({ type: 'task-activated', taskUuid })
    if (snapshot) applySnapshot(taskUuid, snapshot, deps.taskState.get().stateRevision)

    if (isNewTask) {
      // 展开 UI 是附属效果，失败或变慢都不能阻塞任务快照收敛。
      void deps.onTaskActivated(taskUuid).catch(error => report('展开巡逻记录面板失败', error))
      void refreshInitialProgress(taskUuid)
    }
  }

  /** 激活新任务后从宿主 flightTask 读一次当前航点进度，赶在第一轮 HTTP 快照前补上进度条。 */
  async function refreshInitialProgress (taskUuid: string): Promise<void> {
    if (!deps.flightTask || isDisposed()) return
    try {
      const snapshot = await deps.flightTask.getState()
      if (control.kind !== 'tracking' || control.taskUuid !== taskUuid) return
      const wayline = snapshot.wayline
      updateInitialProgress(
        wayline?.taskId ?? '',
        wayline?.completedWaypointCount ?? 0,
        wayline?.totalWaypointCount ?? 0,
      )
    } catch (error) {
      report('读取飞行任务进度失败', error)
    }
  }

  /**
   * HTTP 快照合并（合并语义在 patrol-session 纯函数里）：
   * 任务不匹配直接丢弃；非 active 快照没有 revision，仅当等待期间业务 revision
   * 未被 WS 推进时才接受，防止旧快照覆盖实时数据。快照宣告结束则转 reviewing。
   */
  function applySnapshot (taskUuid: string, snapshot: PatrolTaskSnapshot, requestedRevision: number): void {
    const current = deps.taskState.get()
    if (current.taskUuid !== taskUuid) return
    // 非 active 快照没有 revision；只在请求期间业务 revision 未推进时才允许提交。
    if (snapshot.link_state !== 'active' && current.stateRevision !== requestedRevision) return
    const next = applyTaskSnapshot(current, snapshot)
    deps.taskState.update(() => next)
    if (isPollingFinished(next)) transition({ type: 'task-finished' })
  }

  /** 跟踪轮询：拉快照 → 合并 → 成功按 2s 续轮，失败按退避续轮。 */
  async function pollTrackedTask (request: ActiveRequest, taskUuid: string): Promise<void> {
    const requestedRevision = deps.taskState.get().stateRevision
    try {
      const snapshot = await deps.api.getTask(taskUuid)
      if (!isCurrentRequest(request) || control.kind !== 'tracking' || control.taskUuid !== taskUuid) return
      applySnapshot(taskUuid, snapshot, requestedRevision)
      if (isTrackingTask(snapshot.task_uuid)) scheduleAfterSuccess()
    } catch (error) {
      if (!isCurrentRequest(request)) return
      report('刷新巡逻任务失败', error)
      schedulePoll(nextBackoff())
    }
  }

  /**
   * 无 taskId 时按机场发现当前巡逻任务。定时巡逻没有前端创建/判别步骤，必须从
   * 此入口进入；发现后立即切到 task_uuid 主键轮询。连续未命中时分级降频：先按
   * 2s 快查 DISCOVERY_FAST_POLLS 次（null 或终态均计一次），之后转 15s 慢查，
   * 发现活跃任务或 epoch 变化恢复快查。
   */
  async function discoverCurrentTask (request: ActiveRequest, gatewaySn: string): Promise<void> {
    try {
      const snapshot = await deps.api.getCurrent(gatewaySn)
      if (!isCurrentRequest(request) || control.kind !== 'idle' || control.gatewaySn !== gatewaySn) return
      if (!snapshot?.task_uuid) {
        discoveryMissCount++
        scheduleAfterDiscoveryMiss()
        return
      }
      const discovered = applyTaskSnapshot(
        activatePatrolTask(createInitialPatrolState(), snapshot.task_uuid),
        snapshot,
      )
      if (isPollingFinished(discovered)) {
        // 不恢复历史终态，但继续发现后续定时巡逻任务；直接进入慢查。
        discoveryMissCount = DISCOVERY_FAST_POLLS
        scheduleAfterDiscoveryMiss()
        return
      }
      const startedAtMs = await fetchStartAtMs(snapshot.task_uuid)
      if (!isCurrentRequest(request) || control.kind !== 'idle' || control.gatewaySn !== gatewaySn) return
      // 发现活跃任务：清零 miss 计数（epoch+1 也会重置，这里显式表达语义）。
      discoveryMissCount = 0
      activateTask(snapshot.task_uuid, snapshot, startedAtMs)
      if (isTrackingTask(snapshot.task_uuid)) scheduleAfterSuccess()
    } catch (error) {
      if (!isCurrentRequest(request)) return
      report('查询当前巡逻任务失败', error)
      schedulePoll(nextBackoff())
    }
  }

  /** 平台任务服务 详情补查任务开始时间：失败只记日志，时间显示占位。 */
  async function fetchStartAtMs (taskUuid: string): Promise<number> {
    if (!control.projectId) return 0
    try {
      const detail = await deps.api.getFlightTaskDetail(control.projectId, taskUuid)
      return detail?.begin_at_ms ?? 0
    } catch (error) {
      report('查询任务开始时间失败', error)
      return 0
    }
  }

  /** 宿主项目/机场变化：epoch+1 作废在途请求；项目变化才算换现场，清空旧任务数据。 */
  function updateContext (state: CockpitContextState): void {
    const previous = control
    const projectChanged = previous.projectId !== (state.projectId ?? '')
    const next = transition({
      type: 'context-changed',
      projectId: state.projectId ?? '',
      gatewaySn: state.gatewaySn ?? null,
    })
    if (next === previous) return
    if (projectChanged && previous.projectId && deps.taskState.get().taskUuid) {
      deps.taskState.update(() => createInitialPatrolState())
    }
    loadRouteName(deps.taskState.get())
    if (next.kind === 'candidate' || next.kind === 'idle') requestPoll()
  }

  /**
   * 宿主飞行任务变化：只消费普通航线通道（wayline）；复检即时航线在 inFlightWayline
   * 通道独立承载，不影响巡逻父任务。跨航次/新 taskId 替换上一次回顾数据（是否巡逻
   * 随后判别）；taskId 清空时若正在跟踪/回顾则保留数据。
   */
  function observeFlightTask (state: FlightTaskState): void {
    const wayline = state.wayline
    const taskId = wayline?.taskId ?? ''
    const previousEpoch = control.epoch
    const next = transition({
      type: 'wayline-task-changed',
      taskId,
      status: wayline?.status ?? null,
      flightId: state.flightId ?? '',
    })

    if (next.epoch !== previousEpoch) {
      // 状态机接受的新身份才替换回顾；即时航线不进入该状态机。
      deps.taskState.update(() => createInitialPatrolState())
    }

    updateInitialProgress(taskId, wayline?.completedWaypointCount ?? 0, wayline?.totalWaypointCount ?? 0)
    if (next.kind === 'candidate' || next.kind === 'idle') requestPoll()
  }

  /** 航点进度写入当前任务；任务不一致时丢弃，避免串台。 */
  function updateInitialProgress (taskUuid: string, done: number, total: number): void {
    if (!taskUuid || taskUuid !== deps.taskState.get().taskUuid) return
    deps.taskState.update(state => setInitialProgress(state, done, total))
  }

  /** 巡逻业务 WS 消息：合并进当前任务；WS 宣告结束则停掉定时轮询并转 reviewing。 */
  function applyWsUpdate (message: PatrolWsMessage): void {
    if (!deps.mockEvents && control.gatewaySn && message.dockSn && message.dockSn !== control.gatewaySn) return
    const current = deps.taskState.get()
    const next = applyWsMessage(current, message)
    if (next === current) return
    deps.taskState.update(() => next)
    if (isPollingFinished(next)) {
      transition({ type: 'task-finished' })
      clearScheduledPoll()
    }
  }

  /** 路段名懒加载：任务拿到 waylineUuid 后查一次；key 去重 + epoch 过期，防重复请求。 */
  function loadRouteName (state: PatrolTaskState): void {
    if (!state.taskUuid || !state.waylineUuid || !control.projectId || state.routeName || isDisposed()) return
    const key = `${control.projectId}:${state.taskUuid}:${state.waylineUuid}`
    if (routeLoad?.key === key) return
    resetRouteLoad()
    routeLoad = { key, epoch: control.epoch }
    requestRouteName(routeLoad, state.taskUuid, state.waylineUuid, control.projectId)
  }

  /** 路段名请求：返回/报错时都校验 routeLoad 身份和 epoch，迟到响应一律丢弃。 */
  function requestRouteName (load: RouteLoad, taskUuid: string, waylineUuid: string, projectId: string): void {
    if (routeLoad !== load || isDisposed()) return
    void deps.api.getWaylineInfo(projectId, waylineUuid)
      .then((info) => {
        if (routeLoad !== load || load.epoch !== control.epoch || isDisposed()) return
        const current = deps.taskState.get()
        if (current.taskUuid !== taskUuid || current.waylineUuid !== waylineUuid) return
        if (info.name) deps.taskState.update(value => applyRouteName(value, info.name))
      })
      .catch((error) => {
        if (routeLoad !== load || load.epoch !== control.epoch || isDisposed()) return
        report('查询巡逻路段失败', error)
      })
  }

  /** 登记订阅；若 dispose 已开始则立即释放，避免清理后残留。 */
  async function keepDisposable (resource: Disposable): Promise<void> {
    if (isDisposed()) {
      await resource.dispose()
      return
    }
    localDisposables.push(resource)
  }

  /**
   * 订阅装配（事务式，任一步失败 → dispose 回滚已取得的订阅并把错误抛给调用方）：
   * 1. taskState 变化 → 路段名懒加载；
   * 2. 真实宿主：订阅 context/flightTask/业务 WS 并各拉一次初始值
   *    （先订阅后取值，期间到达的变更会置 *Changed 标记，避免旧初始值覆盖新变更）；
   *    Mock：只挂 mockEvents 三条回调；
   * 3. ready=true 后发起第一轮轮询。
   */
  async function startInternal (): Promise<void> {
    try {
      await keepDisposable(deps.taskState.subscribe(loadRouteName))

      if (deps.context && !isDisposed()) {
        let contextChanged = false
        await keepDisposable(await deps.context.onStateChanged((state) => {
          if (isDisposed()) return
          contextChanged = true
          updateContext(state)
        }))
        if (!isDisposed()) {
          const initialContext = await deps.context.getState()
          if (!contextChanged && !isDisposed()) updateContext(initialContext)
        }
      }

      if (deps.mockEvents && !isDisposed()) {
        await keepDisposable({ dispose: deps.mockEvents.onTaskArrived((taskUuid, startedAtMs) => {
          if (isDisposed()) return
          deps.taskState.update(() => createInitialPatrolState())
          activateTask(taskUuid, undefined, startedAtMs)
          requestPoll()
        }) })
        await keepDisposable({ dispose: deps.mockEvents.onWsMessage(applyWsUpdate) })
        await keepDisposable({ dispose: deps.mockEvents.onFlightTaskProgress(({ taskUuid, done, total }) => {
          updateInitialProgress(taskUuid, done, total)
        }) })
      } else if (!isDisposed()) {
        if (deps.flightTask) {
          let flightTaskChanged = false
          await keepDisposable(await deps.flightTask.onStateChanged((state) => {
            if (isDisposed()) return
            flightTaskChanged = true
            observeFlightTask(state)
          }))
          if (!isDisposed()) {
            const initialFlightTask = await deps.flightTask.getState()
            if (!flightTaskChanged && !isDisposed()) observeFlightTask(initialFlightTask)
          }
        }
        if (deps.subscribeWs && !isDisposed()) {
          await keepDisposable(await deps.subscribeWs((event) => {
            if (isDisposed()) return
            const message = parsePatrolWsEvent(event.subBizCode, event.data)
            if (message) applyWsUpdate(message)
          }))
        }
      }

      if (isDisposed()) return
      ready = true
      requestPoll()
    } catch (error) {
      await dispose()
      throw error
    }
  }

  /** 幂等入口：重复调用复用同一次装配。 */
  function start (): Promise<void> {
    if (isDisposed()) return Promise.resolve()
    startPromise ??= startInternal()
    return startPromise
  }

  /**
   * 幂等清理：先转 disposed（epoch+1 作废所有在途请求），停定时器、清会话内存数据，
   * 再逆序释放订阅；单个订阅失败不阻断其余清理（Engine ResourceTracker 兜底）。
   */
  function dispose (): Promise<void> {
    disposePromise ??= (async () => {
      if (!isDisposed()) transition({ type: 'disposed' })
      ready = false
      clearScheduledPoll()
      resetRouteLoad()
      refreshPending = false
      deps.taskState.update(() => createInitialPatrolState())
      for (const resource of localDisposables.reverse()) {
        try {
          await resource.dispose()
        } catch {
          // Engine ResourceTracker 会继续兜底；一个订阅失败不能阻断其余业务清理。
        }
      }
      localDisposables.length = 0
    })()
    return disposePromise
  }

  return {
    start,
    refresh () {
      // 显式刷新：force 允许把挂起的识别（classification-paused）重新拉起。
      requestPoll(true)
    },
    dispose,
  }
}
