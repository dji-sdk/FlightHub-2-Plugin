// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, expectTypeOf, it } from 'vitest'
import { definePlugin } from './runtime/index.js'
import { manifestSchema } from './schema/index.js'
import {
  CAPABILITY_DESCRIPTORS,
  CAPABILITY_SPECS,
} from './catalog/index.js'
import { definePluginService } from './service/index.js'
import { defineView } from './view/index.js'
import { PLUGIN_ERROR_CODES } from './contracts/errors.js'
import type { PluginErrorCode } from './contracts/errors.js'
import type {
  CockpitLiveLifecycleEventPayload,
  FlightTaskState,
  FlightTaskStatus,
  InFlightWaylineTaskSnapshot,
  PlatformEvent,
  PlatformLocationState,
  PlatformObjectUploadInput,
  PlatformWaylinePreviewInput,
  PluginCapabilityClient,
  PluginContext,
  ProjectContextState,
  WaylineTaskSnapshot,
} from './index.js'
import * as sdk from './index.js'
import { isPluginError } from './index.js'

function assertCapabilityTypes (context: PluginContext): void {
  expectTypeOf(context.capabilities.get('cockpit:telemetry'))
    .toEqualTypeOf<Promise<PluginCapabilityClient<'cockpit:telemetry'> | undefined>>()
  void context.capabilities.get('platform:object-upload').then(async (uploader) => {
    if (!uploader) return
    const input: PlatformObjectUploadInput = {
      endpoint: 'https://s3.example.com',
      bucket: 'plugin-objects',
      region: 'us-east-1',
      objectKey: 'plugins/exp_example/frame.jpg',
      accessKeyId: 'temporary-access-key',
      secretAccessKey: 'temporary-secret-key',
      securityToken: 'temporary-security-token',
      blob: new Blob(['frame'], { type: 'image/jpeg' }),
    }
    expectTypeOf(input).toEqualTypeOf<{
      readonly endpoint: string;
      readonly bucket: string;
      readonly region: string;
      readonly objectKey: string;
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly securityToken: string;
      readonly usePathStyle?: boolean;
      readonly blob: Blob;
    }>()
    const result = await uploader.upload(input)
    expectTypeOf(result).toEqualTypeOf<{ readonly etag: string | null }>()
  })
  // @ts-expect-error Capability 只保留单一可选 get
  void context.capabilities.tryGet('cockpit:telemetry')
  // @ts-expect-error Capability ID 必须来自 SDK Catalog
  void context.capabilities.get('unknown:capability')
  // @ts-expect-error 平台基础能力只使用 PluginContext 顶层入口
  void context.capabilities.get('platform:http')
  expectTypeOf(context.capabilities.get('platform:wpmz'))
    .toEqualTypeOf<Promise<PluginCapabilityClient<'platform:wpmz'> | undefined>>()
  void context.capabilities.get('platform:wpmz').then(async (wpmz) => {
    if (!wpmz) return
    const result = await wpmz.rewrite({
      target: { projectId: 'project-1', waylineId: 'wayline-1' },
      changes: { missionConfig: { finishAction: 'no-action' } },
    })
    expectTypeOf(result).toEqualTypeOf<{ readonly waylineId: string; readonly changed: boolean }>()
  })
  void context.capabilities.get('platform:audio').then(async (audio) => {
    if (!audio) return
    const player = await audio.createPlayer({
      source: { type: 'preset', sound: 'warning' },
      volume: 0.8,
      loop: false,
    })
    await player.play({ restart: true })
    await player.setVolume({ volume: 0.5 })
    await player.setLoop({ loop: true })
    await player.pause()
    await player.stop()
    await player.dispose()
  })
  expectTypeOf(context.capabilities.get('platform:notification'))
    .toEqualTypeOf<Promise<PluginCapabilityClient<'platform:notification'> | undefined>>()
  expectTypeOf(context.capabilities.get('platform:dialog'))
    .toEqualTypeOf<Promise<PluginCapabilityClient<'platform:dialog'> | undefined>>()
  expectTypeOf(context.capabilities.get('platform:map'))
    .toEqualTypeOf<Promise<PluginCapabilityClient<'platform:map'> | undefined>>()
  void context.capabilities.get('platform:map').then(async (map) => {
    if (!map) return
    const menuRegistration = await map.registerContextMenuItem({
      id: 'copy-coordinates',
      label: '获取并复制经纬度',
      group: { id: 'location', label: '位置' },
      onTrigger: ({ position }) => {
        expectTypeOf(position).toEqualTypeOf<import('./index.js').GeoPoint | null>()
      },
    })
    await menuRegistration.dispose()
  })
  void context.capabilities.get('platform:clipboard').then(async (clipboard) => {
    if (!clipboard) return
    await clipboard.writeText({ text: '22.5431,114.0579' })
  })
  void context.capabilities.get('platform:devices').then(async (devices) => {
    if (!devices) return
    const projectDevices = await devices.getProjectDevices({ projectId: 'project-1' })
    for (const device of projectDevices) {
      expectTypeOf(device.aircraft?.operatingState).toEqualTypeOf<
        import('./index.js').PlatformAircraftOperatingState | undefined
      >()
      expectTypeOf(device.dock?.model.id).toEqualTypeOf<
        import('./index.js').PlatformDeviceModelId | undefined
      >()
    }
  })
  void context.capabilities.get('platform:location').then(async (location) => {
    if (!location) return
    const state = await location.getState()
    expectTypeOf(state).toEqualTypeOf<PlatformLocationState>()
    const subscription = await location.onStateChanged((nextState) => {
      expectTypeOf(nextState.pathname).toEqualTypeOf<string>()
    })
    await subscription.dispose()
  })
  void context.capabilities.get('platform:navigation').then(async (navigation) => {
    if (!navigation) return
    await navigation.open('/organization/org-1/project/project-1#/cockpit', { target: 'blank' })
    await navigation.open('https://example.com/resource', { target: 'self' })
    // @ts-expect-error target 必须由插件显式选择
    await navigation.open('/missing-options')
    // @ts-expect-error 不再接受业务语义 target/input
    await navigation.open('cockpit.live', { organizationId: 'organization-1' })
  })
  expectTypeOf(context.capabilities.get('cockpit:context'))
    .toEqualTypeOf<Promise<PluginCapabilityClient<'cockpit:context'> | undefined>>()
  void context.capabilities.get('cockpit:scene-geometry').then(async (geometry) => {
    if (!geometry) return
    const result = await geometry.projectVideoToGround([{ x: 0.5, y: 0.5 }], { groundHeight: 20 })
    expectTypeOf(result).toEqualTypeOf<{
      readonly capturedAt: number;
      readonly points: readonly (import('./index.js').GeoPoint | null)[];
    } | null>()
    const projected = await geometry.projectGeoToVideo([{ lng: 113.9, lat: 22.5, height: 20 }])
    expectTypeOf(projected).toEqualTypeOf<{
      readonly capturedAt: number;
      readonly points: readonly (import('./index.js').VideoPoint | null)[];
    } | null>()
  })
  void context.capabilities.get('cockpit:live-pointer').then(async (pointer) => {
    if (!pointer) return
    const lease = await pointer.acquire('DronePayload')
    const revoked = await lease.onRevoked(() => {})
    await revoked.dispose()
    await lease.release()
    await lease.dispose()
  })

  const projectContext: ProjectContextState = {
    projectId: 'project-1',
    organizationId: 'organization-1',
    userInfo: {
      org_role: 'organization-member',
      project_role: 'project-member',
      user_id: 'user-1',
      nick_name: '用户一',
      account: 'user-1@example.com',
    },
  }
  expectTypeOf(projectContext.userInfo.project_role).toEqualTypeOf<string | null>()

  void context.capabilities.get('platform:wayline-preview').then(async (preview) => {
    if (!preview) return
    const input: PlatformWaylinePreviewInput = {
      points: [{ lng: 113.9, lat: 22.5, height: 20 }],
      startPosition: null,
      destination: { position: { lng: 113.91, lat: 22.51, height: 20 }, kind: 'alert' },
    }
    const handle = await preview.show(input)
    await handle.update({ ...input, destination: { position: { lng: 113.91, lat: 22.51, height: 20 }, kind: 'home' } })
    await handle.dispose()
  })

  void context.capabilities.get('cockpit:flight-task').then(async (flightTask) => {
    if (!flightTask) return
    const state = await flightTask.getState()
    expectTypeOf(state).toEqualTypeOf<FlightTaskState>()
    expectTypeOf(state.kind).toEqualTypeOf<'wayline' | 'in-flight-wayline' | null>()
    expectTypeOf(state.flightId).toEqualTypeOf<string | null>()
    expectTypeOf(state.wayline).toEqualTypeOf<WaylineTaskSnapshot | null>()
    expectTypeOf(state.inFlightWayline).toEqualTypeOf<InFlightWaylineTaskSnapshot | null>()
    if (state.wayline) {
      expectTypeOf(state.wayline.taskId).toEqualTypeOf<string | null>()
      expectTypeOf(state.wayline.status).toEqualTypeOf<FlightTaskStatus>()
      expectTypeOf(state.wayline.completedWaypointCount).toEqualTypeOf<number | null>()
      expectTypeOf(state.wayline.totalWaypointCount).toEqualTypeOf<number | null>()
    }
    if (state.inFlightWayline) {
      expectTypeOf(state.inFlightWayline.taskId).toEqualTypeOf<string | null>()
      expectTypeOf(state.inFlightWayline.status).toEqualTypeOf<FlightTaskStatus>()
    }
    const result = await flightTask.startInFlightWayline({
      waylineUuid: 'wayline-1',
      rthAltitude: 100,
      taskName: '事故处置',
      waylineDuration: 60,
      waylineLength: 500,
      finishAction: 'goHome',
    })
    expectTypeOf(result).toEqualTypeOf<{ readonly taskId: string }>()
    await flightTask.cancelInFlightWayline({ taskId: result.taskId, afterCancel: 'hover' })
  })
}

void assertCapabilityTypes

function assertPlatformEventTypes (context: PluginContext): void {
  context.events.on('cockpit.live.lifecycle', (event) => {
    expectTypeOf(event).toEqualTypeOf<PlatformEvent<'cockpit.live.lifecycle'>>()
    expectTypeOf(event.payload).toEqualTypeOf<CockpitLiveLifecycleEventPayload>()
    expectTypeOf(event.payload.phase).toEqualTypeOf<'started' | 'first-frame' | 'stopped' | 'channel-changed'>()
    // @ts-expect-error payload 只能使用目录中为该事件声明的字段
    void event.payload.sequence
  })
  // @ts-expect-error 事件名必须来自 PlatformEventMap
  context.events.on('hello.semantic', () => {})
}

void assertPlatformEventTypes

function assertLoggerTypes (context: PluginContext): void {
  interface LogDetail {
    readonly filter: 'all' | 'done';
    readonly icon: string;
    readonly tasks: readonly {
      readonly id: number;
      readonly completed: boolean;
    }[];
  }

  const detail: LogDetail = {
    filter: 'all',
    icon: './capture.svg',
    tasks: [{ id: 1, completed: true }],
  }
  context.logger.info('普通 interface 可直接记录', detail)
  context.logger.debug('联合基础类型可直接记录', Math.random() > 0.5 ? 'ready' : 1)
  // @ts-expect-error 函数不能跨 Realm 传输
  context.logger.warn('非法详情', { callback: () => {} })
  context.logger.error('结构化克隆原生类型可直接记录', { createdAt: new Date() })
}

void assertLoggerTypes

function assertJsonValueTypes (context: PluginContext): void {
  interface ViewIdentity {
    readonly filter: 'all' | 'done';
    readonly selectedTaskId: number | null;
  }

  const identity: ViewIdentity = { filter: 'all', selectedTaskId: null }
  const handle = context.views.get('task-list', identity)
  expectTypeOf(handle.initialState).toEqualTypeOf<ViewIdentity>()
  // @ts-expect-error View initialState 使用 JSON 通道，不能传 Date
  context.views.get('task-list', { createdAt: new Date() })
}

void assertJsonValueTypes

async function assertServiceTypes (context: PluginContext): Promise<void> {
  interface AlertFlowState {
    readonly status: 'idle' | 'pending' | 'processing';
    readonly alertId: string | null;
    readonly unreadCount: number;
  }
  interface AlertFlowMethods {
    getState(): AlertFlowState;
    acknowledge(input: { readonly alertId: string }): { readonly accepted: boolean };
    presentDispatch(input: {
      readonly executionId: string;
      readonly projectId: string;
    }): { readonly accepted: boolean };
  }
  interface AlertFlowEvents {
    readonly stateChanged: AlertFlowState;
  }
  const alertFlowService = definePluginService<AlertFlowMethods, AlertFlowEvents>('alert-flow')

  await context.services.provide(alertFlowService, {
    getState: () => ({ status: 'pending' as const, alertId: 'alert-1', unreadCount: 1 }),
    acknowledge: ({ alertId }) => {
      expectTypeOf(alertId).toEqualTypeOf<string>()
      return { accepted: true }
    },
    presentDispatch: (input) => {
      expectTypeOf(input.executionId).toEqualTypeOf<string>()
      return { accepted: true }
    },
    stateChanged: (emit) => {
      emit({
        status: 'processing',
        alertId: 'alert-1',
        unreadCount: 1,
      })
    },
  })
  const client = await context.services.connect(alertFlowService)
  expectTypeOf(client.presentDispatch({
    executionId: 'execution-1',
    projectId: 'project-1',
  })).toEqualTypeOf<Promise<{ readonly accepted: boolean }>>()
  // @ts-expect-error Service Consumer 只保留稳定 connect
  void context.services.tryConnect(alertFlowService)
  // @ts-expect-error Provider 生命周期由稳定 Client 内部吸收
  void context.services.observe(alertFlowService, () => {})
  // @ts-expect-error Service 公开入口只接受 descriptor
  void context.services.connect('alert-flow')
  // @ts-expect-error 方法名来自函数契约
  void client.missing()
  // @ts-expect-error presentDispatch 参数必须满足契约
  void client.presentDispatch({ executionId: 'missing-fields' })
  // @ts-expect-error Provider 必须实现 descriptor 声明的全部成员
  void context.services.provide(alertFlowService, {})
}

void assertServiceTypes

describe('sDK 公开面冒烟', () => {
  it('只公开语义明确的 View state 工厂', () => {
    expect(typeof sdk.createViewState).toBe('function')
    expect('createState' in sdk).toBe(false)
  })

  it('definePlugin 原样返回定义', () => {
    const activate = () => {}
    expect(definePlugin({ activate }).activate).toBe(activate)
  })

  it('defineView 返回的是**可调用函数**（ViewRuntime 会断言 typeof default === function）', async () => {
    const instance = { dispose: () => {} }
    const register = defineView({ mount: () => instance })
    expect(typeof register).toBe('function')
    await expect(register({} as never)).resolves.toBe(instance)
  })

  it('definePluginService 记住 serviceId', () => {
    expect(definePluginService('alert')).toEqual({ serviceId: 'alert' })
  })

  it('公开目录固定为 29 Capability', () => {
    expect(CAPABILITY_SPECS.map(descriptor => descriptor.id)).toEqual([
      'platform:http',
      'platform:events',
      'platform:websocket',
      'platform:storage',
      'platform:navigation',
      'platform:location',
      'platform:wpmz',
      'platform:audio',
      'platform:clipboard',
      'platform:notification',
      'platform:dialog',
      'platform:map',
      'platform:wayline-preview',
      'platform:object-upload',
      'platform:devices',
      'cockpit:context',
      'cockpit:camera',
      'cockpit:telemetry',
      'cockpit:detection',
      'cockpit:ai-config',
      'cockpit:scene-geometry',
      'cockpit:live-pointer',
      'cockpit:flight-control',
      'cockpit:gimbal',
      'cockpit:hotkeys',
      'cockpit:smart-track',
      'cockpit:flight-task',
      'project:context',
      'plan:form-context',
    ])
  })

  it('service args/result/event 必须满足 PluginValue', () => {
    definePluginService<{ date(input: Date): Blob }>('native-values')
    definePluginService<Record<never, never>, { changed: Map<string, string> }>('collection-values')
    // @ts-expect-error method args 不能包含函数
    definePluginService<{ bad(input: { callback(): void }): null }>('bad-args')
    // @ts-expect-error method result 不能包含函数
    definePluginService<{ bad(): { callback(): void } }>('bad-result')
    // @ts-expect-error event payload 不能包含函数
    definePluginService<Record<never, never>, { bad: { callback(): void } }>('bad-event')
    // @ts-expect-error Service 方法只允许零个或一个 DTO 参数
    definePluginService<{ bad(left: string, right: string): null }>('bad-args-count')
    // @ts-expect-error on/dispose 是 Client 控制方法，不能作为业务方法名
    definePluginService<{ dispose(): null }>('reserved-method')
  })

  it('manifest schema 拒绝未知顶层字段', () => {
    expect(manifestSchema.additionalProperties).toBe(false)
    expect(manifestSchema.required).toContain('entry')
    expect(Object.hasOwn(manifestSchema.properties, 'capabilityId')).toBe(false)
    expect(manifestSchema.properties.views.additionalProperties.properties.styles.items.pattern).toBe('^\\./')
  })

  it('稳定错误码覆盖 Engine §11.1 清单且只增不改', () => {
    const codes: readonly PluginErrorCode[] = [
      'MANIFEST_INVALID',
      'ENGINE_INCOMPATIBLE',
      'PLUGIN_ENTRY_INVALID',
      'EXTENSION_POINT_NOT_FOUND',
      'EXTENSION_DECLARATION_INVALID',
      'EXTENSION_IMPLEMENTATION_MISSING',
      'EXTENSION_IMPLEMENTATION_INVALID',
      'EXTENSION_NOT_FOUND',
      'HANDLER_STATE_INVALID',
      'CONTRIBUTION_UPDATE_FAILED',
      'HOST_ADAPTER_FAILED',
      'EXTENSION_REVEAL_UNAVAILABLE',
      'REGISTRATION_CONFLICT',
      'POINT_CONSUMER_CONFLICT',
      'CAPABILITY_NOT_AVAILABLE',
      'CAPABILITY_CONTRACT_INVALID',
      'CAPABILITY_REALM_MISMATCH',
      'CAPABILITY_RATE_UNSUPPORTED',
      'COCKPIT_SDK_ERROR',
      'SERVICE_CONTRACT_INVALID',
      'SERVICE_UNAVAILABLE',
      'VIEW_NOT_DECLARED',
      'VIEW_LOAD_FAILED',
      'VIEW_CONTRIBUTION_ALREADY_MOUNTED',
      'HOST_RUNTIME_DISPOSED',
      'PLUGIN_VALUE_INVALID',
      'CONFIG_VALUE_INVALID',
      'STORAGE_QUOTA_EXCEEDED',
      'RUNTIME_UNRESPONSIVE',
      'RESOURCE_LEAK',
      'PLUGIN_NETWORK_BLOCKED',
      'PLUGIN_GATEWAY_ERROR',
      'TIMEOUT',
    ]
    expect(PLUGIN_ERROR_CODES).toEqual(codes)
  })

  it('isPluginError 跨 Realm 按稳定结构判断', () => {
    const error = Object.assign(new Error('不可用'), {
      code: 'CAPABILITY_NOT_AVAILABLE',
      pluginId: 'com.test',
    })
    expect(isPluginError(error)).toBe(true)
    expect(isPluginError({ code: 'UNKNOWN', message: '未知' })).toBe(false)
    expect(isPluginError(new Error('普通错误'))).toBe(false)
  })

  it('capability descriptor 是类型、权限与运行时成员的唯一目录', () => {
    expect(Object.keys(CAPABILITY_DESCRIPTORS)).toHaveLength(29)
    expect(CAPABILITY_DESCRIPTORS['platform:devices']).toEqual({
      id: 'platform:devices',
      permission: 'platform:devices',
      realm: 'any',
      providerScope: 'platform',
      providerRequirement: 'optional',
      members: { getProjectDevices: 'method' },
    })
    expect(CAPABILITY_DESCRIPTORS['platform:storage']).toEqual({
      id: 'platform:storage',
      permission: 'platform:storage',
      realm: 'any',
      providerScope: 'builtin',
      providerRequirement: 'required',
      members: { local: 'value', session: 'value', blobs: 'value' },
    })
    expect(CAPABILITY_DESCRIPTORS['platform:wpmz']).toMatchObject({
      providerScope: 'platform',
      providerRequirement: 'required',
      members: { parseCoordinates: 'method', rewrite: 'method' },
    })
    expect(CAPABILITY_DESCRIPTORS['platform:audio']).toEqual({
      id: 'platform:audio',
      permission: 'platform:audio',
      realm: 'any',
      providerScope: 'platform',
      providerRequirement: 'required',
      members: { createPlayer: 'method' },
    })
    expect(CAPABILITY_DESCRIPTORS['plan:form-context']).toMatchObject({
      providerScope: 'host',
      providerRequirement: 'optional',
      members: { getState: 'method', onStateChanged: 'method' },
    })
    expect(CAPABILITY_DESCRIPTORS['platform:dialog'].providerScope).toBe('platform')
    expect(CAPABILITY_DESCRIPTORS['platform:clipboard']).toEqual({
      id: 'platform:clipboard',
      permission: 'platform:clipboard',
      realm: 'any',
      providerScope: 'platform',
      providerRequirement: 'optional',
      members: { writeText: 'method' },
    })
    expect(CAPABILITY_DESCRIPTORS['platform:map']).toMatchObject({
      providerScope: 'platform',
      members: {
        addMarker: 'method',
        addPolygon: 'method',
        onClick: 'method',
        onHover: 'method',
        registerContextMenuItem: 'method',
      },
    })
    expect(CAPABILITY_DESCRIPTORS['platform:location']).toEqual({
      id: 'platform:location',
      permission: 'platform:location',
      realm: 'any',
      providerScope: 'host',
      providerRequirement: 'optional',
      members: { getState: 'method', onStateChanged: 'method' },
    })
    expect(CAPABILITY_DESCRIPTORS['cockpit:detection'].realm).toBe('any')
    expect(CAPABILITY_DESCRIPTORS['cockpit:scene-geometry']).toMatchObject({
      realm: 'any',
      members: {
        projectVideoToGround: 'method',
        projectGeoToVideo: 'method',
        projectSnapshotVideoToGround: 'method',
        projectSnapshotGeoToVideo: 'method',
        releaseSnapshot: 'method',
      },
    })
    expect(CAPABILITY_DESCRIPTORS['cockpit:detection'].members).toMatchObject({
      onFrame: 'method',
      projectToGround: 'method',
      projectFromGround: 'method',
    })
    expect(CAPABILITY_DESCRIPTORS['cockpit:camera'].members).toMatchObject({
      ensureMode: 'method',
      switchLens: 'method',
      ensureZoom: 'method',
      boundingZoom: 'method',
      takePhoto: 'method',
      acquireRecording: 'method',
      captureFrame: 'method',
    })
    expect(CAPABILITY_DESCRIPTORS['cockpit:smart-track'].members).toEqual({
      getState: 'method',
      onStateChanged: 'method',
      start: 'method',
      stop: 'method',
    })
    expect(CAPABILITY_DESCRIPTORS['cockpit:flight-task'].members).toEqual({
      getState: 'method',
      onStateChanged: 'method',
      startInFlightWayline: 'method',
      cancelInFlightWayline: 'method',
    })
    expect(CAPABILITY_DESCRIPTORS['platform:wayline-preview']).toEqual({
      id: 'platform:wayline-preview',
      permission: 'platform:wayline-preview',
      realm: 'any',
      providerScope: 'platform',
      providerRequirement: 'optional',
      members: { show: 'method' },
    })
    expect(CAPABILITY_DESCRIPTORS['platform:object-upload']).toEqual({
      id: 'platform:object-upload',
      permission: 'platform:object-upload',
      realm: 'same-origin',
      providerScope: 'platform',
      providerRequirement: 'optional',
      members: { upload: 'method' },
    })
    expect(CAPABILITY_DESCRIPTORS['cockpit:live-pointer'].members).toEqual({ acquire: 'method' })
    expect(CAPABILITY_DESCRIPTORS['cockpit:hotkeys']).toMatchObject({
      realm: 'any',
      members: { register: 'method' },
    })
    const schemaPermissions = manifestSchema.properties.permissions.items.enum
    expect(schemaPermissions).toEqual(CAPABILITY_SPECS.map(descriptor => descriptor.permission))
  })
})
