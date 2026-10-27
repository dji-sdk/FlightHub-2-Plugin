// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Disposable, TrackedTimers } from 'fh2-plugin-sdk'
import type { CaptureSettingsState } from '../../views/capture-settings/contract'
import type { CaptureEvidencePreviewState } from '../../views/capture-evidence-preview/contract'
import type { CaptureRecordsPanel, CaptureRecordsState } from '../../views/capture-records/contract'
import type { LaneChangeRenameDialogState } from '../../views/lane-change-rename-dialog/contract'
import { testTelemetryState } from '../../shared/test-telemetry'
import type { TrafficCaptureContext } from './context'
import { activate } from './activate'

interface StateSource<T> {
  subscribe (handler: (state: T) => void): Disposable;
}

interface CapturedProvider<TState, TMethods> {
  state: StateSource<TState>;
  methods: TMethods;
}

interface WorkbenchStateSnapshot {
  readonly captureStatus: string;
  readonly annotations: ReadonlyArray<{ readonly id: string; readonly name: string; readonly coordinateMode: string }>;
}

const providers = vi.hoisted(() => ({
  settings: undefined as CapturedProvider<CaptureSettingsState, {
    close (): void;
    setLaneChangeEnabled (input: { enabled: boolean }): Promise<void>;
    setPersonRoadEnabled (input: { enabled: boolean }): Promise<void>;
    setAlertEnabled (input: { enabled: boolean }): void;
    setAlertPopup (input: { popup: boolean }): void;
    setAlertSound (input: { sound: boolean }): void;
  }> | undefined,
  records: undefined as CapturedProvider<CaptureRecordsState, {
    selectLaneChangeRecord (input: { eventKey: string }): Promise<void>;
    selectPersonRoadRecord (input: { trackingId: string }): Promise<void>;
    setActivePanel (input: { panel: CaptureRecordsPanel }): void;
  }> | undefined,
  preview: undefined as CapturedProvider<CaptureEvidencePreviewState, {
    selectPersonRoadPhoto (input: { index: number }): void;
    openPersonRoadMediaLibrary (): Promise<void>;
    close (): void;
  }> | undefined,
  workbench: undefined as CapturedProvider<WorkbenchStateSnapshot, {
    beginDraw (input: { kind: 'solid-line' | 'guide-area' }): Promise<void>;
    finishEdit (): Promise<void>;
    toggleCapture (): Promise<void>;
    requestRename (input: { id: string }): Promise<void>;
  }> | undefined,
  canvas: undefined as CapturedProvider<unknown, {
    addDraftPoint (input: { point: { x: number; y: number } }): Promise<void>;
    finishDraft (): Promise<void>;
  }> | undefined,
  renameDialog: undefined as CapturedProvider<LaneChangeRenameDialogState, {
    confirm (input: { name: string }): Promise<void>;
    cancel (): void;
  }> | undefined,
  alertToast: undefined as CapturedProvider<{ visible: boolean; message: string }, {
    click (): void;
  }> | undefined,
}))

const viewMocks = vi.hoisted(() => {
  const viewMock = (viewId: string, capture?: (provider: unknown) => void) => ({
    get: vi.fn(() => ({ viewId, initialState: null })),
    handle: vi.fn(async (_ctx: unknown, provider: unknown) => {
      capture?.(provider)
      return provider
    }),
  })
  return {
    settingsView: viewMock('capture-settings', (provider) => {
      providers.settings = provider as typeof providers.settings
    }),
    workbenchView: viewMock('lane-change-workbench', (provider) => {
      providers.workbench = provider as typeof providers.workbench
    }),
    canvasView: viewMock('lane-change-annotation-canvas', (provider) => {
      providers.canvas = provider as typeof providers.canvas
    }),
    recordsView: viewMock('capture-records', (provider) => {
      providers.records = provider as typeof providers.records
    }),
    previewView: viewMock('capture-evidence-preview', (provider) => {
      providers.preview = provider as typeof providers.preview
    }),
    skipHintView: viewMock('person-road-skip-hint'),
    renameDialogView: viewMock('lane-change-rename-dialog', (provider) => {
      providers.renameDialog = provider as typeof providers.renameDialog
    }),
    alertToastView: viewMock('capture-alert-toast', (provider) => {
      providers.alertToast = provider as typeof providers.alertToast
    }),
  }
})

vi.mock('../../views/capture-settings/contract', () => ({ captureSettingsView: viewMocks.settingsView }))
vi.mock('../../views/lane-change-workbench/contract', () => ({ laneChangeWorkbenchView: viewMocks.workbenchView }))
vi.mock('../../views/lane-change-annotation-canvas/contract', () => ({ laneChangeCanvasView: viewMocks.canvasView }))
vi.mock('../../views/capture-records/contract', () => ({ captureRecordsView: viewMocks.recordsView }))
vi.mock('../../views/capture-evidence-preview/contract', () => ({ captureEvidencePreviewView: viewMocks.previewView }))
vi.mock('../../views/person-road-skip-hint/contract', () => ({ personRoadSkipHintView: viewMocks.skipHintView }))
vi.mock('../../views/lane-change-rename-dialog/contract', () => ({ laneChangeRenameDialogView: viewMocks.renameDialogView }))
vi.mock('../../views/capture-alert-toast/contract', () => ({ captureAlertToastView: viewMocks.alertToastView }))

function createReader<T> (source: StateSource<T>): () => T {
  let latest: T | undefined
  source.subscribe((value) => {
    latest = value
  })
  return () => latest as T
}

/** 毫秒感知的假时钟：advance 推进虚拟时间并执行到期任务（间隔任务按周期重排）。 */
function createFakeTimers (): TrackedTimers & { advance (ms: number): void } {
  const tasks = new Map<number, { callback: () => void; dueAt: number; interval: boolean; period: number }>()
  let clock = 0
  let seq = 0
  const runDue = (): void => {
    for (const [handle, task] of [...tasks.entries()]) {
      if (task.dueAt > clock) continue
      if (task.interval) {
        task.dueAt = clock + task.period
      } else {
        tasks.delete(handle)
      }
      task.callback()
    }
  }
  return {
    setTimeout (callback, ms) {
      seq += 1
      tasks.set(seq, { callback, dueAt: clock + ms, interval: false, period: ms })
      return seq
    },
    clearTimeout (handle) {
      tasks.delete(handle as number)
    },
    setInterval (callback, ms) {
      seq += 1
      tasks.set(seq, { callback, dueAt: clock + ms, interval: true, period: ms })
      return seq
    },
    clearInterval (handle) {
      tasks.delete(handle as number)
    },
    advance (ms) {
      clock += ms
      runDue()
    },
  }
}

async function flush (rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

const envelope = (data: unknown): { code: number; data: unknown } => ({ code: 0, data })

interface FlowFrame {
  readonly frameId: string;
  readonly capturedAt: number;
  readonly targets: ReadonlyArray<{
    readonly targetId: string;
    readonly type: string;
    readonly state: string;
    readonly bbox: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  }>;
}

interface TestHarness {
  context: TrafficCaptureContext;
  implementations: Map<string, Record<string, unknown>>;
  handles: Map<string, { reveal: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>;
  timers: ReturnType<typeof createFakeTimers>;
  hotkeys: { register: ReturnType<typeof vi.fn> };
  map: { addBillboard: ReturnType<typeof vi.fn>; recenter: ReturnType<typeof vi.fn> };
  notification: { show: ReturnType<typeof vi.fn> };
  navigation: { open: ReturnType<typeof vi.fn>; back: ReturnType<typeof vi.fn> };
  audio: { createPlayer: ReturnType<typeof vi.fn>; player: { play: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } };
  ws: { onBizCode: ReturnType<typeof vi.fn> };
  apiCall: ReturnType<typeof vi.fn>;
  contextCapability: { getState: ReturnType<typeof vi.fn>; onStateChanged: ReturnType<typeof vi.fn> };
  dialog: { open: ReturnType<typeof vi.fn> };
  dialogPresentation: { close: ReturnType<typeof vi.fn> };
  camera: {
    takePhoto: ReturnType<typeof vi.fn>;
    acquireRecording: ReturnType<typeof vi.fn>;
    ensureMode: ReturnType<typeof vi.fn>;
    captureFrame: ReturnType<typeof vi.fn>;
  };
  smartTrack: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  gimbal: { lookAt: ReturnType<typeof vi.fn> };
  recordingLease: { stop: ReturnType<typeof vi.fn> };
  emitContext(input: { projectId?: string; flightId?: string | null }): void;
  emitDetectionFrame(frame: FlowFrame): void;
  emitPersonTarget(): void;
  emitCarCrossing(): void;
  entryHandle(): { reveal: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } | undefined;
  run(): Promise<{ dispose: () => Promise<void> }>;
}

function createHarness (options: {
  enableMock?: boolean;
  withDevice?: boolean;
  withoutDialog?: boolean;
  apiRoutes?: Record<string, unknown>;
} = {}): TestHarness {
  const implementations = new Map<string, Record<string, unknown>>()
  const handles = new Map<string, { reveal: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>()
  const timers = createFakeTimers()

  const map = {
    addBillboard: vi.fn(async () => ({ dispose: vi.fn(), update: vi.fn(async () => {}) })),
    recenter: vi.fn(async () => {}),
  }
  const notification = { show: vi.fn(() => ({ dispose: () => {} })) }
  const navigation = { open: vi.fn(async () => {}), back: vi.fn(async () => {}) }
  // closed 只在 close 时兑现：模块依赖「宿主关闭前 closed 保持 pending」清理句柄
  let resolveDialogClosed!: () => void
  const dialogClosed = new Promise<void>((resolve) => {
    resolveDialogClosed = resolve
  })
  const dialogPresentation = {
    close: vi.fn(async () => {
      resolveDialogClosed()
    }),
    closed: dialogClosed,
  }
  const dialog = { open: vi.fn(async (_view: unknown, _options?: unknown) => dialogPresentation) }
  const audioPlayer = {
    play: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    setVolume: vi.fn(async () => {}),
    setLoop: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  }
  const audio = { createPlayer: vi.fn(async () => audioPlayer) }
  const ws = { onBizCode: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })) }
  const hotkeys = { register: vi.fn(async (_input: { key: string; onTrigger: () => void }) => ({ dispose: vi.fn(), update: vi.fn() })) }

  let currentContext = {
    organizationId: 'org-1',
    projectId: 'proj-1',
    droneSn: 'DRONE-1',
    gatewaySn: 'DOCK-1',
    alertExecutionId: null,
    liveReady: true,
    flightId: 'flight-1' as string | null,
  }
  const contextListeners = new Set<(state: typeof currentContext) => void>()
  const contextCapability = {
    getState: vi.fn(async () => currentContext),
    onStateChanged: vi.fn(async (handler: (state: typeof currentContext) => void) => {
      contextListeners.add(handler)
      return { dispose: () => contextListeners.delete(handler) }
    }),
  }

  // --- 设备能力替身（真实 Capability 契约形状；Mock 后端只替代 HTTP/WS 数据源） ---

  const recordingLease = {
    stop: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    onRevoked: vi.fn(async () => ({ dispose: (): void => {} })),
  }
  let cameraZoom = 1
  let photoCount = 0
  const camera = {
    getState: async () => ({ availability: { status: 'available' as const, reason: null }, mode: 'photo' as const, lens: 'wide' as const, zoom: cameraZoom, recording: false }),
    onStateChanged: async () => ({ dispose: () => {} }),
    ensureMode: vi.fn(async () => {}),
    switchLens: async () => {},
    ensureZoom: vi.fn(async () => {}),
    boundingZoom: async () => {},
    takePhoto: vi.fn(async () => {
      photoCount += 1
      if (photoCount === 1) {
        const zoomSequence = [2, 4, 3.5, 3.8]
        zoomSequence.forEach((zoom, index) => {
          timers.setTimeout(() => {
            cameraZoom = zoom
          }, 150 + index * 200)
        })
      }
      return { accepted: true, capturedAt: 1 }
    }),
    acquireRecording: vi.fn(async () => recordingLease),
    captureFrame: vi.fn(async () => ({ blob: new Blob(['png']), width: 640, height: 360, capturedAt: 1, geometrySnapshotId: 'snap-1' })),
  }
  let smartTrackState = { phase: 'off', targetId: null as string | null }
  let smartTrackStateHandler: ((state: { phase: string; targetId: string | null }) => void) | undefined
  const smartTrack = {
    getState: async () => smartTrackState,
    onStateChanged: async (handler: typeof smartTrackStateHandler) => {
      smartTrackStateHandler = handler
      return { dispose: () => {
        smartTrackStateHandler = undefined
      } }
    },
    start: vi.fn(async (input: { kind: string; targetId?: string }) => {
      smartTrackState = { phase: 'tracking', targetId: input.targetId ?? null }
      smartTrackStateHandler?.(smartTrackState)
      return smartTrackState
    }),
    stop: vi.fn(async () => {
      smartTrackState = { phase: 'off', targetId: null }
      smartTrackStateHandler?.(smartTrackState)
      return smartTrackState
    }),
  }
  const detectionHandlers = new Set<(frame: FlowFrame) => void>()
  const detection = {
    onFrame: vi.fn(async (handler: (frame: FlowFrame) => void) => {
      detectionHandlers.add(handler)
      return { dispose: () => {
        detectionHandlers.delete(handler)
      } }
    }),
    projectFromGround: vi.fn(async (_frameId: string, points: ReadonlyArray<{ lng: number; lat: number }>) => ({
      capturedAt: 1,
      points: points.map(point => ({ x: point.lng, y: point.lat })),
    })),
  }
  const sceneGeometry = {
    projectVideoToGround: vi.fn(async (points: ReadonlyArray<{ x: number; y: number }>) => ({
      capturedAt: 1,
      points: points.map(point => ({ lng: point.x, lat: point.y, height: 20 })),
    })),
    projectGeoToVideo: vi.fn(async (points: ReadonlyArray<{ lng: number; lat: number }>) => ({
      capturedAt: 1,
      points: points.map(point => ({ x: point.lng, y: point.lat })),
    })),
    projectSnapshotVideoToGround: vi.fn(async () => null),
    projectSnapshotGeoToVideo: vi.fn(async () => null),
    releaseSnapshot: vi.fn(async () => {}),
  }
  const pointer = {
    acquire: vi.fn(async () => ({
      stream: 'DronePayload',
      release: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
      onRevoked: vi.fn(async () => ({ dispose: vi.fn() })),
    })),
  }
  const telemetry = {
    getState: async () => testTelemetryState(),
    onStateChanged: async () => ({ dispose: () => {} }),
  }
  let aiConfigState = { availability: { status: 'available' as const, reason: null }, model: 'dji-visible', recognitionEnabled: true, targetTypes: ['person'] as string[] }
  const aiConfig = {
    getState: async () => aiConfigState,
    onStateChanged: async () => ({ dispose: () => {} }),
    ensure: vi.fn(async (input: { model?: 'dji-visible'; recognitionEnabled?: boolean; targetTypes?: readonly string[] }) => {
      aiConfigState = {
        ...aiConfigState,
        model: input.model ?? aiConfigState.model,
        recognitionEnabled: input.recognitionEnabled ?? aiConfigState.recognitionEnabled,
        targetTypes: input.targetTypes ? [...input.targetTypes] : aiConfigState.targetTypes,
      }
      return { confirmed: true, reason: null }
    }),
  }
  const gimbal = {
    reset: async () => {},
    lookAt: vi.fn(async () => {}),
  }

  const apiRoutes = options.apiRoutes ?? {}
  const apiCall = vi.fn(async (endpoint: string, requestOptions?: { readonly method?: string; readonly body?: unknown }) => {
    const body = requestOptions?.body as { handler?: unknown } | undefined
    const handler = typeof body?.handler === 'string' ? ` ${body.handler}` : ''
    const key = `${requestOptions?.method ?? 'GET'} ${endpoint}${handler}`
    if (key in apiRoutes) return apiRoutes[key]
    throw new Error(`unexpected apiCall: ${key}`)
  })

  const withDevice = options.withDevice === true
  const capabilities = {
    get: vi.fn(async (id: string) => {
      if (id === 'cockpit:context') return contextCapability
      if (id === 'platform:map') {
        return {
          addMarker: vi.fn(async () => ({ dispose: vi.fn(), update: vi.fn(async () => {}) })),
          addBillboard: map.addBillboard,
          addLabel: vi.fn(async () => ({ dispose: vi.fn(), update: vi.fn(async () => {}) })),
          addPolyline: vi.fn(async () => ({ dispose: vi.fn(), update: vi.fn(async () => {}) })),
          addPolygon: vi.fn(async () => ({ dispose: vi.fn(), update: vi.fn(async () => {}) })),
          recenter: map.recenter,
          onClick: vi.fn(() => ({ dispose: vi.fn() })),
          onHover: vi.fn(() => ({ dispose: vi.fn() })),
        }
      }
      if (id === 'platform:notification') return notification
      if (id === 'platform:navigation') return navigation
      if (id === 'platform:audio') return audio
      if (id === 'cockpit:hotkeys') return hotkeys
      if (id === 'platform:dialog') return options.withoutDialog === true ? undefined : dialog
      if (!withDevice) return undefined
      if (id === 'cockpit:telemetry') return telemetry
      if (id === 'cockpit:camera') return camera
      if (id === 'cockpit:detection') return detection
      if (id === 'cockpit:scene-geometry') return sceneGeometry
      if (id === 'cockpit:live-pointer') return pointer
      if (id === 'cockpit:smart-track') return smartTrack
      if (id === 'cockpit:ai-config') return aiConfig
      if (id === 'cockpit:gimbal') return gimbal
      return undefined
    }),
  }

  const blobs = new Map<string, Blob>()
  const context = {
    host: { id: 'cockpit' },
    config: {
      enableMock: options.enableMock ?? true,
    },
    timers,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    apiCall,
    ws,
    capabilities,
    storage: {
      session: { get: async () => undefined, set: async () => {} },
    },
    blobs: {
      put: async (key: string, value: Blob) => {
        blobs.set(key, value)
      },
      url: async (key: string) => (blobs.has(key) ? `blob:${key}` : undefined),
    },
    extensions: {
      contribute: vi.fn(async (id: string, implementation: Record<string, unknown>) => {
        implementations.set(id, implementation)
        const handle = { reveal: vi.fn(async () => {}), update: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
        handles.set(id, handle)
        return handle
      }),
    },
  } as unknown as TrafficCaptureContext

  let frameSeq = 0
  const emitDetectionFrame = (frame: FlowFrame): void => {
    for (const handler of [...detectionHandlers]) handler(frame)
  }
  /** 行人目标帧（type '2' tracked）。 */
  const emitPersonTarget = (): void => {
    frameSeq += 1
    emitDetectionFrame({
      frameId: `person-frame-${frameSeq}`,
      capturedAt: Date.now(),
      targets: [{ targetId: 'person-1', type: '2', state: 'tracked', bbox: { x: 0.3, y: 0.5, width: 0.06, height: 0.12 } }],
    })
  }
  /** 车辆跨线帧序列：3 帧预热 + 主动穿越 y=0.5 实线。 */
  const emitCarCrossing = (): void => {
    for (const cy of [0.65, 0.60, 0.55, 0.42]) {
      frameSeq += 1
      emitDetectionFrame({
        frameId: `car-frame-${frameSeq}`,
        capturedAt: Date.now(),
        targets: [{ targetId: 'car-1', type: '3', state: 'tracked', bbox: { x: 0.34, y: cy - 0.06, width: 0.12, height: 0.12 } }],
      })
    }
  }

  return {
    context,
    implementations,
    handles,
    timers,
    hotkeys,
    map,
    notification,
    navigation,
    audio: { createPlayer: audio.createPlayer, player: audioPlayer },
    ws,
    apiCall,
    contextCapability,
    dialog,
    dialogPresentation,
    camera,
    smartTrack,
    gimbal,
    recordingLease,
    emitContext (input) {
      currentContext = { ...currentContext, ...input }
      for (const listener of contextListeners) listener(currentContext)
    },
    emitDetectionFrame,
    emitPersonTarget,
    emitCarCrossing,
    entryHandle: () => handles.get('traffic-capture-popover-entry'),
    async run () {
      return activate(context)
    },
  }
}

/**
 * 真实时间泵：以固定节奏推进假时钟，使依赖 Date.now 的变焦稳定等待
 * （1s 真实时间）与 Mock 媒体延迟（假时钟毫秒）协同推进。
 */
function startTicker (harness: TestHarness, fakePerTick = 100, intervalMs = 50): () => void {
  const timer = setInterval(() => {
    harness.timers.advance(fakePerTick)
  }, intervalMs)
  return () => clearInterval(timer)
}

function readSettings (): CaptureSettingsState {
  return createReader(providers.settings!.state)()
}

function readRecords () {
  const state = createReader(providers.records!.state)()
  const panel = state.activePanel === 'lane-change' ? state.laneChange : state.personRoad
  const selectedIdentifier = state.activePanel === 'lane-change' ? state.laneChange.selectedEventKey : state.personRoad.selectedTrackingId
  return { ...state, records: panel.records, selectedIdentifier, displayedKind: state.activePanel }
}

function readPreview () {
  const state = createReader(providers.preview!.state)()
  const panel = state.activePanel === 'lane-change' ? state.laneChange : state.personRoad
  return {
    ...state,
    record: panel.record,
    photos: state.personRoad.photos,
    activeIndex: state.personRoad.activeIndex,
    loading: state.personRoad.loading,
    loadError: state.personRoad.loadError,
  }
}

function readWorkbench (): WorkbenchStateSnapshot {
  return createReader(providers.workbench!.state)()
}

function readAlertToast (): { visible: boolean; message: string } {
  return createReader(providers.alertToast!.state)()
}

function readRenameDialog (): LaneChangeRenameDialogState {
  return createReader(providers.renameDialog!.state)()
}

/** 驱动一次完整的变道抓拍（开启 → 绘制实线 → 抓拍 → 跨线 → 实时截图），返回 eventKey。 */
async function driveLaneChangeCapture (harness: TestHarness): Promise<string> {
  await providers.settings!.methods.setLaneChangeEnabled({ enabled: true })
  await flush()
  await providers.workbench!.methods.beginDraw({ kind: 'solid-line' })
  await providers.canvas!.methods.addDraftPoint({ point: { x: 0.2, y: 0.5 } })
  await providers.canvas!.methods.addDraftPoint({ point: { x: 0.8, y: 0.5 } })
  await providers.canvas!.methods.finishDraft()
  await providers.workbench!.methods.finishEdit()
  await providers.workbench!.methods.toggleCapture()
  await flush()
  harness.emitCarCrossing()
  await flush(20)
  harness.timers.advance(3_100)
  await flush(20)
  const records = readRecords().records
  expect(records).toHaveLength(1)
  return readRecords().laneChange.records[0]!.eventKey
}

beforeEach(() => {
  providers.settings = undefined
  providers.records = undefined
  providers.preview = undefined
  providers.workbench = undefined
  providers.canvas = undefined
  providers.renameDialog = undefined
  providers.alertToast = undefined
  for (const mock of Object.values(viewMocks)) {
    mock.get.mockClear()
    mock.handle.mockClear()
  }
})

describe('traffic-capture Cockpit 装配（数据源切换）', () => {
  it('enableMock=true：贡献设置/记录/预览/告警，不触达 ctx.apiCall 与 ctx.ws', async () => {
    const harness = createHarness()
    const runtime = await harness.run()
    await flush()

    expect([...harness.implementations.keys()]).toEqual(expect.arrayContaining([
      'traffic-capture-popover-entry',
      'capture-records',
      'capture-preview',
      'capture-alert-toast',
      'person-road-skip-hint',
      'lane-change-workbench',
      'lane-change-annotation-canvas',
    ]))
    // 旁路剧本按钮已移除：Mock 模式也必须走正式 Controller
    expect(harness.implementations.has('mock-lane-change-scenario')).toBe(false)
    expect(harness.implementations.has('mock-person-road-scenario')).toBe(false)
    expect(harness.ws.onBizCode).not.toHaveBeenCalled()
    expect(harness.apiCall).not.toHaveBeenCalled()
    expect(harness.audio.createPlayer).toHaveBeenCalledWith({
      source: { type: 'preset', sound: 'warning' },
      volume: 1,
      loop: false,
    })
    expect(readRecords().records).toEqual([])
    // 左栏面板声明初始宽度 260px，并使用插件内交通抓拍图标。
    expect(harness.implementations.get('capture-records')).toMatchObject({ visible: true, width: 260, icon: 'cockpit-violation-event' })
    const workbenchPanel = harness.implementations.get('lane-change-workbench')
    expect(workbenchPanel).toMatchObject({ visible: false, interactive: true, width: 280 })
    expect(workbenchPanel).not.toHaveProperty('height')
    expect(workbenchPanel).not.toHaveProperty('placement')
    expect(workbenchPanel).not.toHaveProperty('offsetX')
    expect(workbenchPanel).not.toHaveProperty('offsetY')
    // SubLive tab 不渲染图标（原生 tab 纯文字），icon 字段不再声明
    expect(harness.implementations.get('capture-preview')?.icon).toBeUndefined()

    await runtime.dispose()
  })

  it('enableMock=false：走 HTTP apiCall 与 ctx.ws', async () => {
    const harness = createHarness({
      enableMock: false,
      withDevice: true,
      apiRoutes: {
        'POST /plugin/invoke h_laneChange_getMode': envelope({ is_active: false, project_id: 'proj-1', dock_sn: 'dock-1', flight_id: '', started_at: 0 }),
        'POST /plugin/invoke h_laneChange_listEvents': envelope({ total: 0, page: 1, page_size: 100, events: [] }),
        'POST /plugin/invoke h_laneChange_startMode': envelope({ is_active: true, project_id: 'proj-1', dock_sn: 'dock-1', flight_id: 'flight-1', started_at: 1 }),
        'POST /plugin/invoke h_laneChange_stopMode': envelope({ is_active: false, project_id: 'proj-1', dock_sn: 'dock-1', stopped_at: 2 }),
        'POST /plugin/invoke h_illegalRoad_getStatus': envelope({ is_active: false, session_id: '', project_id: 'proj-1', dock_sn: 'dock-1', flight_id: '', started_at: 0, tracking_count: 0, open_tracking: null }),
        'POST /plugin/invoke h_illegalRoad_listTrackings': envelope({ total: 0, page: 1, page_size: 100, session: null, trackings: [] }),
      },
    })
    const runtime = await harness.run()
    await flush()

    expect(harness.ws.onBizCode).toHaveBeenCalled()
    expect(harness.apiCall).toHaveBeenCalled()

    await providers.settings!.methods.setLaneChangeEnabled({ enabled: true })
    await providers.settings!.methods.setLaneChangeEnabled({ enabled: false })
    const handlers = harness.apiCall.mock.calls.map(([, request]) => (
      (request?.body as { handler?: string } | undefined)?.handler
    ))
    expect(handlers).toEqual(expect.arrayContaining(['h_laneChange_startMode', 'h_laneChange_stopMode']))

    await runtime.dispose()
  })

  it('enableMock=false：卸载时 stop-mode 失败不阻断其余模块清理', async () => {
    const routes: Record<string, unknown> = {
      'POST /plugin/invoke h_laneChange_getMode': envelope({ is_active: false, project_id: 'proj-1', dock_sn: 'dock-1', flight_id: '', started_at: 0 }),
      'POST /plugin/invoke h_laneChange_listEvents': envelope({ total: 0, page: 1, page_size: 100, events: [] }),
      'POST /plugin/invoke h_laneChange_startMode': envelope({ is_active: true, project_id: 'proj-1', dock_sn: 'dock-1', flight_id: 'flight-1', started_at: 1 }),
      'POST /plugin/invoke h_illegalRoad_getStatus': envelope({ is_active: false, session_id: '', project_id: 'proj-1', dock_sn: 'dock-1', flight_id: '', started_at: 0, tracking_count: 0, open_tracking: null }),
      'POST /plugin/invoke h_illegalRoad_listTrackings': envelope({ total: 0, page: 1, page_size: 100, session: null, trackings: [] }),
    }
    const harness = createHarness({ enableMock: false, withDevice: true, apiRoutes: routes })
    const runtime = await harness.run()
    await flush()

    await providers.settings!.methods.setLaneChangeEnabled({ enabled: true })
    await flush()
    const stopModeFailure = Promise.reject(new Error('stop-mode down'))
    stopModeFailure.catch(() => {})
    routes['POST /plugin/invoke h_laneChange_stopMode'] = stopModeFailure

    await expect(runtime.dispose()).resolves.toBeUndefined()
    expect(harness.context.logger.warn).toHaveBeenCalledWith('交通抓拍卸载清理失败', 'stop-mode down')
    expect(harness.audio.player.dispose).toHaveBeenCalled()
  })
})

describe('traffic-capture 行人上路全流程（Mock 后端 + 真实设备编排）', () => {
  it('检测 → SPZ → 远景/近景拍照 → 录像 → 媒体回传 → 预览翻页 → K 键收尾', async () => {
    const harness = createHarness({ withDevice: true })
    const runtime = await harness.run()
    await flush()

    await providers.settings!.methods.setPersonRoadEnabled({ enabled: true })
    await flush()

    harness.emitPersonTarget()
    await vi.waitFor(() => expect(harness.gimbal.lookAt).toHaveBeenCalledOnce())
    // LookAt 后真机会继续推送 SEI；第二帧用于验证控制器不会复用转动前的旧帧。
    harness.emitPersonTarget()
    const stopTicker = startTicker(harness)
    try {
      // 远景 → 变焦稳定（1s 真实时间）→ 近景
      await vi.waitFor(() => expect(harness.camera.takePhoto).toHaveBeenCalledTimes(2), { timeout: 8_000 })
    } finally {
      stopTicker()
    }
    await flush()

    // 真实设备编排：SPZ 跟踪 + 录像接管
    expect(harness.smartTrack.start).toHaveBeenCalledTimes(1)
    expect(harness.camera.acquireRecording).toHaveBeenCalledTimes(1)
    // 临时记录 + 告警
    expect(readAlertToast()).toEqual({ visible: true, message: '发现目标' })
    expect(harness.audio.player.play).toHaveBeenCalledWith({ restart: true })
    const records0 = readRecords().records
    expect(records0).toHaveLength(1)
    expect(records0[0]).toMatchObject({ trackingId: expect.any(String) })

    // Mock 后端依次回传照片：记录去 pending，列表使用 latest_photo.preview_url
    harness.timers.advance(10_000)
    await flush(20)
    const records = readRecords().personRoad.records
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ pending: false })
    expect(decodeURIComponent(records[0]?.previewPhotoUrl ?? '')).toContain('近景')
    expect(decodeURIComponent(records[0]?.originalPhotoUrl ?? '')).toContain('近景')
    // toast 5 秒自动消失
    expect(readAlertToast().visible).toBe(false)

    // 预览：使用 latest_photo.original_url + 地图照片图钉
    await providers.records!.methods.selectPersonRoadRecord({ trackingId: records[0]!.trackingId })
    await flush()
    const preview = readPreview()
    expect(preview.personRoad.record?.trackingId).toBe(readRecords().personRoad.records[0]!.trackingId)
    expect(preview.loading).toBe(false)
    expect(preview.photos).toEqual([{ url: records[0]!.originalPhotoUrl }])
    expect(preview.activeIndex).toBe(0)
    await providers.preview!.methods.openPersonRoadMediaLibrary()
    expect(harness.navigation.open).toHaveBeenCalledWith('/organization/org-1/project/proj-1#/media?pid=2001', { target: 'blank' })
    expect(harness.map.addBillboard).toHaveBeenCalled()

    // K 键收尾：停录像 + 停 SPZ + 切回拍照模式
    const hotkeyInput = harness.hotkeys.register.mock.calls[0]?.[0] as { onTrigger: () => void }
    hotkeyInput.onTrigger()
    await vi.waitFor(() => expect(harness.recordingLease.stop).toHaveBeenCalled())
    expect(harness.smartTrack.stop).toHaveBeenCalled()
    expect(harness.camera.ensureMode).toHaveBeenCalledWith('photo')

    await runtime.dispose()
  })
})

describe('traffic-capture 变道抓拍全流程（Mock 后端 + 真实 detector）', () => {
  it('绘制实线 → 开始抓拍 → 车辆跨线 confirm → 实时截图预览 → 去重 → 取消选中', async () => {
    const harness = createHarness({ withDevice: true })
    const runtime = await harness.run()
    await flush()

    await providers.settings!.methods.setLaneChangeEnabled({ enabled: true })
    await flush()
    await providers.workbench!.methods.beginDraw({ kind: 'solid-line' })
    await providers.canvas!.methods.addDraftPoint({ point: { x: 0.2, y: 0.5 } })
    await providers.canvas!.methods.addDraftPoint({ point: { x: 0.8, y: 0.5 } })
    await providers.canvas!.methods.finishDraft()
    await providers.workbench!.methods.finishEdit()
    await providers.workbench!.methods.toggleCapture()
    await flush()
    expect(readWorkbench().captureStatus).toBe('capturing')

    // 真实检测帧 → detector confirm（非剧本伪造）
    harness.emitCarCrossing()
    await flush(20)

    let records = readRecords().records
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ collisionType: 'solid_line' })
    expect(readAlertToast()).toEqual({ visible: true, message: '发现目标' })
    expect(harness.camera.captureFrame).toHaveBeenCalled()

    // create-event 只确认事件，不等待返航后的三帧和视频后处理。
    await flush(20)
    records = readRecords().records
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ postStatus: 'pending_video' })
    expect(records[0]).toMatchObject({ eventId: expect.any(String), eventKey: expect.any(String) })

    // 预览：只使用违章发生时保存的实时码流截图 + 地图图钉。
    await providers.records!.methods.selectLaneChangeRecord({ eventKey: readRecords().laneChange.records[0]!.eventKey })
    await flush()
    const preview = readPreview()
    expect(preview.laneChange.screenshotUrl).toMatch(/^blob:/)
    expect(preview.personRoad.photos).toEqual([])
    expect(harness.map.addBillboard).toHaveBeenCalledOnce()
    expect(harness.handles.get('capture-preview')?.reveal).toHaveBeenCalled()

    // 未明确离开前仍属于同一违规 episode，不重复上报。
    harness.emitCarCrossing()
    await flush(20)
    expect(readRecords().records).toHaveLength(1)

    // 再次点击同一卡片：取消选中并关闭预览
    await providers.records!.methods.selectLaneChangeRecord({ eventKey: readRecords().laneChange.records[0]!.eventKey })
    await flush()
    expect(readRecords().selectedIdentifier).toBe('')
    expect(readPreview().record).toBeNull()
    expect(harness.handles.get('capture-preview')?.update).toHaveBeenCalledWith({ visible: false })

    await runtime.dispose()
  })

  it('预览 close：清空 selectedEventKey，卡片选中环不残留', async () => {
    const harness = createHarness({ withDevice: true })
    const runtime = await harness.run()
    await flush()

    const eventKey = await driveLaneChangeCapture(harness)
    await providers.records!.methods.selectLaneChangeRecord({ eventKey })
    await flush()
    expect(readRecords().selectedIdentifier).toBe(eventKey)

    // 预览 View 卸载（SubLive 切走）时调用 close
    providers.preview!.methods.close()
    expect(readRecords().selectedIdentifier).toBe('')
    expect(readPreview().record).toBeNull()
    expect(harness.handles.get('capture-preview')?.update).toHaveBeenCalledWith({ visible: false })

    await runtime.dispose()
  })
})

describe('traffic-capture 重命名弹窗（platform:dialog）', () => {
  /** 开启变道并绘制一条实线，返回标注 id。 */
  async function drawSolidLine (): Promise<string> {
    await providers.settings!.methods.setLaneChangeEnabled({ enabled: true })
    await flush()
    await providers.workbench!.methods.beginDraw({ kind: 'solid-line' })
    await providers.canvas!.methods.addDraftPoint({ point: { x: 0.2, y: 0.5 } })
    await providers.canvas!.methods.addDraftPoint({ point: { x: 0.8, y: 0.5 } })
    await providers.canvas!.methods.finishDraft()
    await providers.workbench!.methods.finishEdit()
    return readWorkbench().annotations[0]!.id
  }

  it('requestRename 用 platform:dialog 打开；确认 trim 改名并延后一拍关闭', async () => {
    const harness = createHarness({ withDevice: true })
    const runtime = await harness.run()
    await flush()
    const annotationId = await drawSolidLine()

    await providers.workbench!.methods.requestRename({ id: annotationId })
    await flush()

    expect(harness.dialog.open).toHaveBeenCalledOnce()
    const [viewHandle, options] = harness.dialog.open.mock.calls[0] as unknown as [
      { viewId: string },
      { title: string; width: number; height: number },
    ]
    expect(viewHandle).toMatchObject({ viewId: 'lane-change-rename-dialog' })
    expect(options).toMatchObject({ title: '重命名标注', width: 360, height: 108 })
    expect(readRenameDialog().initialName).toBe('实线 1')

    await providers.renameDialog!.methods.confirm({ name: '  主路实线  ' })
    await flush()
    expect(readWorkbench().annotations[0]).toMatchObject({ id: annotationId, name: '主路实线' })

    // 关闭延后一拍（先让本次 View RPC 返回）
    harness.timers.advance(0)
    await flush()
    expect(harness.dialogPresentation.close).toHaveBeenCalledOnce()

    await runtime.dispose()
  })

  it('空名称不提交不关闭；取消关闭且不改名', async () => {
    const harness = createHarness({ withDevice: true })
    const runtime = await harness.run()
    await flush()
    const annotationId = await drawSolidLine()

    await providers.workbench!.methods.requestRename({ id: annotationId })
    await flush()

    await providers.renameDialog!.methods.confirm({ name: '   ' })
    await flush()
    harness.timers.advance(0)
    await flush()
    expect(harness.dialogPresentation.close).not.toHaveBeenCalled()
    expect(readWorkbench().annotations[0]?.name).toBe('实线 1')

    await providers.renameDialog!.methods.cancel()
    await flush()
    expect(harness.dialogPresentation.close).toHaveBeenCalledOnce()
    expect(readWorkbench().annotations[0]?.name).toBe('实线 1')

    await runtime.dispose()
  })

  it('platform:dialog 不可用时提示且不抛错', async () => {
    const harness = createHarness({ withDevice: true, withoutDialog: true })
    const runtime = await harness.run()
    await flush()
    const annotationId = await drawSolidLine()

    await providers.workbench!.methods.requestRename({ id: annotationId })
    await flush()

    expect(harness.dialog.open).not.toHaveBeenCalled()
    expect(harness.notification.show).toHaveBeenCalledWith(expect.objectContaining({ intent: 'warning' }))
    expect(readWorkbench().annotations[0]?.name).toBe('实线 1')

    await runtime.dispose()
  })
})

describe('traffic-capture 记录列表与上下文', () => {
  it('恢复发现两个模式同时开启时全部关闭', async () => {
    const routes: Record<string, unknown> = {
      'POST /plugin/invoke h_laneChange_getMode': envelope({ is_active: true, project_id: 'proj-1', dock_sn: 'DOCK-1', flight_id: 'flight-1', started_at: 1 }),
      'POST /plugin/invoke h_laneChange_listEvents': envelope({ total: 0, page: 1, page_size: 100, events: [] }),
      'POST /plugin/invoke h_laneChange_stopMode': envelope({ is_active: false, project_id: 'proj-1', dock_sn: 'DOCK-1', flight_id: 'flight-1', stopped_at: 2 }),
      'POST /plugin/invoke h_illegalRoad_getStatus': envelope({ is_active: true, session_id: 'session-1', project_id: 'proj-1', dock_sn: 'DOCK-1', flight_id: 'flight-1', started_at: 1, tracking_count: 0, open_tracking: null }),
      'POST /plugin/invoke h_illegalRoad_listTrackings': envelope({ total: 0, page: 1, page_size: 100, session: null, trackings: [] }),
      'POST /plugin/invoke h_illegalRoad_stopSession': envelope({ is_active: false, session_id: 'session-1', stopped_at: 2, closed_tracking_ids: [] }),
    }
    const harness = createHarness({ enableMock: false, withDevice: true, apiRoutes: routes })
    const runtime = await harness.run()

    expect(readSettings()).toMatchObject({ laneChange: { enabled: false }, personRoad: { enabled: false } })
    const handlers = harness.apiCall.mock.calls.map(([, request]) => (request?.body as { handler?: string } | undefined)?.handler)
    expect(handlers).toContain('h_illegalRoad_stopSession')
    expect(handlers).toContain('h_laneChange_stopMode')
    expect(harness.notification.show).toHaveBeenCalledWith(expect.objectContaining({
      intent: 'warning',
      message: expect.stringContaining('已自动全部关闭'),
    }))
    await runtime.dispose()
  })

  it('恢复双开时一个模式关闭失败仍继续关闭另一个模式', async () => {
    const stopModeFailure = Promise.reject(new Error('stop-mode down'))
    stopModeFailure.catch(() => {})
    const routes: Record<string, unknown> = {
      'POST /plugin/invoke h_laneChange_getMode': envelope({ is_active: true, project_id: 'proj-1', dock_sn: 'DOCK-1', flight_id: 'flight-1', started_at: 1 }),
      'POST /plugin/invoke h_laneChange_listEvents': envelope({ total: 0, page: 1, page_size: 100, events: [] }),
      'POST /plugin/invoke h_laneChange_stopMode': stopModeFailure,
      'POST /plugin/invoke h_illegalRoad_getStatus': envelope({ is_active: true, session_id: 'session-1', project_id: 'proj-1', dock_sn: 'DOCK-1', flight_id: 'flight-1', started_at: 1, tracking_count: 0, open_tracking: null }),
      'POST /plugin/invoke h_illegalRoad_listTrackings': envelope({ total: 0, page: 1, page_size: 100, session: null, trackings: [] }),
      'POST /plugin/invoke h_illegalRoad_stopSession': envelope({ is_active: false, session_id: 'session-1', stopped_at: 2, closed_tracking_ids: [] }),
    }
    const harness = createHarness({ enableMock: false, withDevice: true, apiRoutes: routes })
    const runtime = await harness.run()

    expect(readSettings()).toMatchObject({ laneChange: { enabled: true }, personRoad: { enabled: false } })
    expect(harness.context.logger.warn).toHaveBeenCalledWith('恢复双开状态时关闭变道模式失败', 'stop-mode down')
    expect(harness.notification.show).toHaveBeenCalledWith(expect.objectContaining({
      intent: 'error',
      message: expect.stringContaining('自动关闭未完全成功'),
    }))
    await runtime.dispose()
  })

  it('快速切换两个模式时通过共享队列保持本地状态互斥', async () => {
    const harness = createHarness({ withDevice: true })
    const runtime = await harness.run()
    await flush()

    const lane = providers.settings!.methods.setLaneChangeEnabled({ enabled: true })
    const person = providers.settings!.methods.setPersonRoadEnabled({ enabled: true })
    await Promise.all([lane, person])
    await flush()

    expect(readSettings().laneChange.enabled).toBe(false)
    expect(readSettings().personRoad.enabled).toBe(true)
    await runtime.dispose()
  })

  it('立即卸载会排空当前模式切换并丢弃尚未执行的切换', async () => {
    let resolveStartMode!: (value: unknown) => void
    const routes: Record<string, unknown> = {
      'POST /plugin/invoke h_laneChange_getMode': envelope({ is_active: false, project_id: 'proj-1', dock_sn: 'dock-1', flight_id: '', started_at: 0 }),
      'POST /plugin/invoke h_laneChange_listEvents': envelope({ total: 0, page: 1, page_size: 100, events: [] }),
      'POST /plugin/invoke h_laneChange_startMode': new Promise((resolve) => {
        resolveStartMode = resolve
      }),
      'POST /plugin/invoke h_laneChange_stopMode': envelope({ is_active: false, project_id: 'proj-1', dock_sn: 'dock-1', stopped_at: 2 }),
      'POST /plugin/invoke h_illegalRoad_getStatus': envelope({ is_active: false, session_id: '', project_id: 'proj-1', dock_sn: 'dock-1', flight_id: '', started_at: 0, tracking_count: 0, open_tracking: null }),
      'POST /plugin/invoke h_illegalRoad_listTrackings': envelope({ total: 0, page: 1, page_size: 100, session: null, trackings: [] }),
    }
    const harness = createHarness({ enableMock: false, withDevice: true, apiRoutes: routes })
    const runtime = await harness.run()
    const laneToggle = providers.settings!.methods.setLaneChangeEnabled({ enabled: true })
    const personToggle = providers.settings!.methods.setPersonRoadEnabled({ enabled: true })
    await vi.waitFor(() => expect(harness.apiCall).toHaveBeenCalledWith('/plugin/invoke', expect.objectContaining({ body: expect.objectContaining({ handler: 'h_laneChange_startMode' }) })))

    const disposing = runtime.dispose()
    resolveStartMode(envelope({ is_active: true, project_id: 'proj-1', dock_sn: 'dock-1', flight_id: 'flight-1', started_at: 1 }))
    await Promise.all([laneToggle, personToggle, disposing])

    const handlers = harness.apiCall.mock.calls.map(([, request]) => (request?.body as { handler?: string } | undefined)?.handler)
    expect(handlers).not.toContain('h_illegalRoad_startSession')
    expect(handlers).toContain('h_laneChange_stopMode')
  })

  it('kind tab 手动切换：切换列表类型，开启新模式仍自动跟随', async () => {
    const harness = createHarness()
    const runtime = await harness.run()
    await flush()

    await providers.settings!.methods.setLaneChangeEnabled({ enabled: true })
    await flush()
    expect(readRecords().displayedKind).toBe('lane-change')

    // 用户手动切到行人 tab：仅改展示，不影响记录数据
    providers.records!.methods.setActivePanel({ panel: 'person-road' })
    const afterSwitch = readRecords()
    expect(afterSwitch.displayedKind).toBe('person-road')

    // 开启行人模式仍自动切到对应 tab
    await providers.settings!.methods.setPersonRoadEnabled({ enabled: true })
    await flush()
    expect(readRecords().displayedKind).toBe('person-road')

    await runtime.dispose()
  })

  it('航次变化关闭旧会话并清空旧航次记录', async () => {
    const harness = createHarness({ withDevice: true })
    const runtime = await harness.run()
    await flush()

    await driveLaneChangeCapture(harness)
    expect(readRecords().records).toHaveLength(1)

    harness.emitContext({ flightId: 'flight-2' })
    await flush(80)

    expect(readRecords().records).toEqual([])
    expect(readPreview().record).toBeNull()
    await runtime.dispose()
  })

  it('航次切换时一个模式关闭失败仍关闭另一模式并采用新上下文', async () => {
    const stopSessionFailure = Promise.reject(new Error('stop-session down'))
    stopSessionFailure.catch(() => {})
    const routes: Record<string, unknown> = {
      'POST /plugin/invoke h_laneChange_getMode': envelope({ is_active: true, project_id: 'proj-1', dock_sn: 'dock-1', flight_id: 'flight-1', started_at: 1 }),
      'POST /plugin/invoke h_laneChange_listEvents': envelope({ total: 0, page: 1, page_size: 100, events: [] }),
      'POST /plugin/invoke h_laneChange_stopMode': envelope({ is_active: false, project_id: 'proj-1', dock_sn: 'dock-1', stopped_at: 2 }),
      'POST /plugin/invoke h_illegalRoad_getStatus': envelope({ is_active: true, session_id: 'session-1', project_id: 'proj-1', dock_sn: 'dock-1', flight_id: 'flight-1', started_at: 1, tracking_count: 0, open_tracking: null }),
      'POST /plugin/invoke h_illegalRoad_listTrackings': envelope({ total: 0, page: 1, page_size: 100, session: null, trackings: [] }),
      'POST /plugin/invoke h_illegalRoad_stopSession': stopSessionFailure,
    }
    const harness = createHarness({ enableMock: false, withDevice: true, apiRoutes: routes })
    const runtime = await harness.run()

    harness.emitContext({ flightId: 'flight-2' })
    await vi.waitFor(() => {
      const handlers = harness.apiCall.mock.calls.map(([, request]) => (request?.body as { handler?: string } | undefined)?.handler)
      expect(handlers).toContain('h_laneChange_stopMode')
    })
    await flush(80)

    expect(readSettings()).toMatchObject({ laneChange: { enabled: false }, personRoad: { enabled: false } })
    expect(readRecords().records).toEqual([])
    expect(harness.context.logger.warn).toHaveBeenCalledWith('切换抓拍航次时关闭行人上路模式失败', 'stop-session down')
    await runtime.dispose()
  })

  it('启动恢复期间的上下文事件排在初始恢复之后执行', async () => {
    let resolveInitialMode!: (value: unknown) => void
    const routes: Record<string, unknown> = {
      'POST /plugin/invoke h_laneChange_getMode': new Promise((resolve) => {
        resolveInitialMode = resolve
      }),
      'POST /plugin/invoke h_laneChange_listEvents': envelope({ total: 0, page: 1, page_size: 100, events: [] }),
      'POST /plugin/invoke h_laneChange_stopMode': envelope({ is_active: false, project_id: 'proj-1', dock_sn: 'dock-1', stopped_at: 2 }),
      'POST /plugin/invoke h_illegalRoad_getStatus': envelope({ is_active: false, session_id: '', project_id: 'proj-1', dock_sn: 'dock-1', flight_id: '', started_at: 0, tracking_count: 0, open_tracking: null }),
      'POST /plugin/invoke h_illegalRoad_listTrackings': envelope({ total: 0, page: 1, page_size: 100, session: null, trackings: [] }),
    }
    const harness = createHarness({ enableMock: false, withDevice: true, apiRoutes: routes })
    const running = harness.run()
    await vi.waitFor(() => expect(harness.contextCapability.onStateChanged).toHaveBeenCalledOnce())
    harness.emitContext({ flightId: 'flight-2' })
    routes['POST /plugin/invoke h_laneChange_getMode'] = envelope({ is_active: false, project_id: 'proj-1', dock_sn: 'dock-1', flight_id: '', started_at: 0 })
    resolveInitialMode(envelope({ is_active: true, project_id: 'proj-1', dock_sn: 'dock-1', flight_id: 'flight-1', started_at: 1 }))

    const runtime = await running
    const statusInputs = harness.apiCall.mock.calls
      .map(([, request]) => request?.body as { handler?: string; input?: { flight_id?: string } } | undefined)
      .filter(body => body?.handler === 'h_illegalRoad_getStatus')
      .map(body => body?.input?.flight_id)
    expect(statusInputs).toContain('flight-2')
    expect(readSettings()).toMatchObject({ laneChange: { enabled: false }, personRoad: { enabled: false } })
    await runtime.dispose()
  })
})

describe('traffic-capture 设置入口与快捷键', () => {
  it('footer toolbar 设置 Popover：openView 挂载；蓝条只随抓拍开关激活，Popover 开关不驱动', async () => {
    const harness = createHarness({ withDevice: true })
    const runtime = await harness.run()
    await flush()

    const entry = harness.implementations.get('traffic-capture-popover-entry') as {
      onTrigger: (ctx: { openView: (view: unknown, options?: { placement?: string }) => Promise<{ close: () => Promise<void>; closed: Promise<void> }> }) => Promise<void>;
    }
    const entryHandle = harness.entryHandle()
    expect(entryHandle?.update).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }))

    // 打开 Popover：不产生任何入口 active 写入
    const callsAfterInit = entryHandle?.update.mock.calls.length ?? 0
    let closeCount = 0
    let presentation: { close: () => Promise<void>; closed: Promise<void> } | undefined
    await entry.onTrigger({
      async openView (view, options) {
        expect(view).toMatchObject({ viewId: 'capture-settings' })
        expect(options).toEqual({ placement: 'right' })
        let resolveClosed!: () => void
        const closed = new Promise<void>((resolve) => {
          resolveClosed = resolve
        })
        presentation = {
          async close () {
            closeCount += 1
            resolveClosed()
          },
          closed,
        }
        return presentation
      },
    })
    await flush()
    expect(presentation).toBeDefined()
    expect(entryHandle?.update.mock.calls.length).toBe(callsAfterInit)
    expect(readSettings().alert).toEqual({ enabled: true, popup: true, sound: true })

    // 开启变道开关 → 蓝条亮
    await providers.settings!.methods.setLaneChangeEnabled({ enabled: true })
    await flush()
    expect(entryHandle?.update).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }))

    // 关闭变道开关 → 蓝条灭
    await providers.settings!.methods.setLaneChangeEnabled({ enabled: false })
    await flush()
    expect(entryHandle?.update).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }))

    // 开启行人上路开关 → 蓝条亮（单行人模式同样激活入口）
    await providers.settings!.methods.setPersonRoadEnabled({ enabled: true })
    await flush()
    expect(entryHandle?.update).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }))

    // 关闭行人上路开关 → 蓝条灭
    await providers.settings!.methods.setPersonRoadEnabled({ enabled: false })
    await flush()
    expect(entryHandle?.update).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }))

    // 告警开关走协调器
    providers.settings!.methods.setAlertEnabled({ enabled: false })
    expect(readSettings().alert.enabled).toBe(false)
    providers.settings!.methods.setAlertSound({ sound: false })
    expect(readSettings().alert.sound).toBe(false)

    // Popover 打开状态下再点一次 = 关闭，不产生入口 active 写入
    const callsBeforeClose = entryHandle?.update.mock.calls.length ?? 0
    await entry.onTrigger({
      async openView () {
        throw new Error('关闭路径不应重新 openView')
      },
    })
    await flush()
    expect(closeCount).toBe(1)
    expect(entryHandle?.update.mock.calls.length).toBe(callsBeforeClose)

    await runtime.dispose()
  })

  it('k 快捷键注册；未开启时触发无副作用', async () => {
    const harness = createHarness({ withDevice: true })
    const runtime = await harness.run()
    await flush()

    expect(harness.hotkeys.register).toHaveBeenCalledWith(expect.objectContaining({ key: 'k' }))
    const hotkeyInput = harness.hotkeys.register.mock.calls[0]?.[0] as { onTrigger: () => void }
    hotkeyInput.onTrigger()
    await flush()
    expect(readRecords().records).toEqual([])
    expect(harness.recordingLease.stop).not.toHaveBeenCalled()

    await runtime.dispose()
  })
})
