// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { TeachRoute } from './teach-session'
import type { TeachTelemetryState } from './teach-telemetry'
import { createTeachController } from './teach-controller'
import type { TeachControllerDependencies } from './teach-controller'

const telemetry: TeachTelemetryState = {
  capturedAt: 1000,
  source: 'drc' as const,
  projectId: 'project-1',
  flightId: 'flight-1',
  dockSn: 'dock-1',
  droneSn: 'drone-1',
  gatewaySn: 'gateway-1',
  longitude: 113.9,
  latitude: 22.5,
  height: 171.6,
  cameraYaw: -20,
  gimbalPitch: -30,
  focalLength: 24,
  horizontalSpeed: 8,
  verticalSpeed: -1,
  aiAvailable: true,
  aiRecognitionOn: true,
  aiTargetTypes: ['car'],
}

const existingRoute: TeachRoute = {
  id: 'route-1',
  projectId: 'project-1',
  name: '示教航线',
  flightId: 'flight-1',
  createdAt: '2026-09-01T00:00:00Z',
  globalSpeed: 15,
  waypointSpeed: 5,
  screenshotBytes: 0,
  waylineUuid: null,
  waylineFileId: null,
  kmzObjectKey: null,
  waypointCount: 0,
  waypoints: [],
}

function setup (decision: 'load' | 'recreate' | 'cancel' = 'load', devices: TeachControllerDependencies['devices'] | null = {
  getProjectDevices: vi.fn(async () => [{ aircraft: { sn: 'drone-1', model: { modelKey: '0-100-1' } } }]),
}) {
  let telemetryState = telemetry
  const conflict = Object.assign(new Error('冲突'), {
    code: 'PLUGIN_GATEWAY_ERROR',
    detail: { httpStatus: 409, gatewayCode: 40901 },
  })
  let sequence = 0
  const api = {
    getStatus: vi.fn(async () => existingRoute),
    enter: vi.fn().mockRejectedValueOnce(conflict).mockResolvedValue(existingRoute),
    deleteRoute: vi.fn(async () => {}),
    createScreenshotUpload: vi.fn(async () => ({
      endpoint: 'https://storage.example.com',
      bucket: 'teach-bucket',
      region: 'us-east-1',
      objectKey: 'teach/route-1/file-1.jpg',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      securityToken: 'security-token',
      usePathStyle: true,
    })),
    attachScreenshot: vi.fn(async () => ({ screenshotFileId: null, screenshotUrl: null })),
    appendWaypoint: vi.fn(async (_routeId, input) => ({
      ...input,
      id: `point-${++sequence}`,
      seq: sequence - 1,
      screenshotFileId: null,
      screenshotUrl: null,
      screenshotBytes: 0,
      screenshotError: null,
      selected: true,
    })),
    updateWaypoint: vi.fn(async () => {}),
    deleteWaypoint: vi.fn(async () => {}),
    generate: vi.fn(async () => ({
      waylineUuid: 'wayline-1',
      waylineFileId: 'wayline-file-1',
      kmzObjectKey: 'teach/route-1.kmz',
    })),
  }
  const camera = {
    captureFrame: vi.fn(async () => ({
      blob: new Blob(['frame'], { type: 'image/jpeg' }),
      geometrySnapshotId: 'snapshot-1',
    })),
  }
  const sceneGeometry = { releaseSnapshot: vi.fn(async () => {}) }
  const objectUpload = { upload: vi.fn(async () => ({ etag: 'etag-1' })) }
  const telemetryGetState = vi.fn(async (): Promise<TeachTelemetryState> => telemetryState)
  const ai = {
    ensure: vi.fn(async (): Promise<{ confirmed: boolean; reason: string | null }> => ({ confirmed: true, reason: null })),
  }
  const controller = createTeachController({
    api,
    telemetry: { getState: telemetryGetState },
    ai,
    camera,
    sceneGeometry,
    objectUpload,
    ...(devices ? { devices } : {}),
    resolveConflict: vi.fn(async () => decision),
    onCleanupError: vi.fn(),
  })
  return {
    ai,
    api,
    camera,
    controller,
    objectUpload,
    sceneGeometry,
    telemetryGetState,
    setTelemetry: (next: typeof telemetry) => {
      telemetryState = next
    },
  }
}

describe('示教录点控制器', () => {
  it('首次录点懒创建路线，并记录 WGS84 高度、相机偏航和 AI 状态', async () => {
    const { api, controller, objectUpload, sceneGeometry } = setup('load')
    await controller.recordWaypoint()

    expect(api.enter).toHaveBeenCalledOnce()
    expect(api.appendWaypoint).toHaveBeenCalledWith('route-1', expect.objectContaining({
      height: 171.6,
      cameraYaw: -20,
      aiRecognitionOn: true,
      aiTargetTypes: ['car'],
    }))
    expect(controller.getState().route?.waypoints[0]).toMatchObject({
      screenshotFileId: null,
      screenshotError: null,
    })
    expect(objectUpload.upload).toHaveBeenCalledWith({
      endpoint: 'https://storage.example.com',
      bucket: 'teach-bucket',
      region: 'us-east-1',
      objectKey: 'teach/route-1/file-1.jpg',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      securityToken: 'security-token',
      usePathStyle: true,
      blob: expect.any(Blob),
    })
    expect(api.attachScreenshot).toHaveBeenCalledWith('point-1', {
      objectKey: 'teach/route-1/file-1.jpg',
      bytes: 5,
    })
    expect(sceneGeometry.releaseSnapshot).toHaveBeenCalledWith('snapshot-1')
  })

  it('车辆 AI 已开启时录点不重复下发 AI 配置', async () => {
    const { ai, controller } = setup()
    await controller.recordWaypoint()

    expect(ai.ensure).not.toHaveBeenCalled()
    expect(controller.getState().phase).toBe('recording')
  })

  it('未开启车辆 AI 时录点前自动开启，并用刷新后的遥测记录航点', async () => {
    const { ai, api, controller, telemetryGetState } = setup()
    telemetryGetState
      .mockResolvedValueOnce({ ...telemetry, aiRecognitionOn: false, aiTargetTypes: [] })
      .mockResolvedValueOnce({ ...telemetry, aiRecognitionOn: true, aiTargetTypes: ['car'] })
    await controller.recordWaypoint()

    expect(ai.ensure).toHaveBeenCalledWith({ model: 'dji-visible', recognitionEnabled: true, targetTypes: ['vehicle'] })
    expect(api.appendWaypoint).toHaveBeenCalledWith('route-1', expect.objectContaining({
      aiRecognitionOn: true,
      aiTargetTypes: ['car'],
    }))
  })

  it('识别开启但目标不含 car 时同样自动补开车辆识别', async () => {
    const { ai, controller, telemetryGetState } = setup()
    telemetryGetState.mockResolvedValueOnce({ ...telemetry, aiTargetTypes: ['person'] })
    await controller.recordWaypoint()

    expect(ai.ensure).toHaveBeenCalledOnce()
    expect(controller.getState().phase).toBe('recording')
  })

  it('自动开启失败时提示手动开启，且不创建示教路线', async () => {
    const { ai, api, controller, telemetryGetState } = setup()
    telemetryGetState.mockResolvedValueOnce({ ...telemetry, aiRecognitionOn: false, aiTargetTypes: [] })
    ai.ensure.mockResolvedValue({ confirmed: false, reason: 'DJI 可见光模型不可用' })
    await expect(controller.recordWaypoint()).rejects.toThrow('自动开启车辆 AI 识别失败：DJI 可见光模型不可用，请手动开启后再录入航点')
    expect(api.enter).not.toHaveBeenCalled()
  })

  it('自动开启抛错时同样提示手动开启', async () => {
    const { ai, api, controller, telemetryGetState } = setup()
    telemetryGetState.mockResolvedValueOnce({ ...telemetry, aiRecognitionOn: false, aiTargetTypes: [] })
    ai.ensure.mockRejectedValue(new Error('下发超时'))
    await expect(controller.recordWaypoint()).rejects.toThrow('自动开启车辆 AI 识别失败：下发超时，请手动开启后再录入航点')
    expect(api.enter).not.toHaveBeenCalled()
  })

  it('自动开启确认后识别仍未生效时提示手动开启，不创建空路线', async () => {
    const { ai, api, controller, setTelemetry } = setup()
    setTelemetry({ ...telemetry, aiTargetTypes: [] })
    await expect(controller.recordWaypoint()).rejects.toThrow('车辆 AI 识别未能生效，请手动开启后再录入航点')
    expect(ai.ensure).toHaveBeenCalledOnce()
    expect(api.enter).not.toHaveBeenCalled()
  })

  it('409 可加载已有 recording 路线并继续录点', async () => {
    const { api, controller } = setup('load')
    await controller.recordWaypoint()

    expect(api.getStatus).toHaveBeenCalledOnce()
    expect(api.appendWaypoint).toHaveBeenCalledOnce()
    expect(controller.getState().phase).toBe('recording')
  })

  it('截图失败保留航点和失败状态，可在本会话重试', async () => {
    const { api, controller, objectUpload } = setup('load')
    objectUpload.upload.mockRejectedValueOnce(new Error('上传失败'))
    await controller.recordWaypoint()

    expect(api.deleteWaypoint).not.toHaveBeenCalled()
    expect(controller.getState().route?.waypoints[0]).toMatchObject({ screenshotError: '上传失败' })
    await controller.retryScreenshot('point-1')
    expect(controller.getState().route?.waypoints[0]).toMatchObject({
      screenshotFileId: null,
      screenshotError: null,
    })
  })

  it('仅允许编辑焦距和选中状态，不接受航点速度', async () => {
    const { api, controller } = setup('load')
    await controller.recordWaypoint()
    await controller.updateWaypoint('point-1', { focalLength: 48, selected: false })

    expect(api.updateWaypoint).toHaveBeenCalledWith('point-1', { focalLength: 48, selected: false })
    expect(controller.getState().route?.waypoints[0]).toMatchObject({ focalLength: 48, selected: false })
  })

  it('生成使用两条路线级速度，成功后清空航点且不可重新生成', async () => {
    const { api, controller } = setup('load')
    await controller.recordWaypoint()
    await controller.recordWaypoint()
    await controller.generate({ name: '航线 A', globalSpeed: 10, waypointSpeed: 4 })

    expect(api.generate).toHaveBeenCalledWith('route-1', {
      name: '航线 A',
      globalSpeed: 10,
      waypointSpeed: 4,
      droneModelKey: '0-100-1',
    })
    expect(controller.getState()).toMatchObject({ phase: 'generated', route: { waypoints: [], waypointCount: 2 } })
    await expect(controller.generate({ name: '航线 B', globalSpeed: 10, waypointSpeed: 4 })).rejects.toThrow('不能编辑')
  })

  it('生成时按遥测 droneSn 匹配项目拓扑并把原始机型 key 下发', async () => {
    const devices: TeachControllerDependencies['devices'] = {
      getProjectDevices: vi.fn(async () => [
        { aircraft: { sn: 'drone-other', model: { modelKey: '0-91-1' } } },
        { aircraft: { sn: 'drone-1', model: { modelKey: '0-100-1' } } },
      ]),
    }
    const { api, controller } = setup('load', devices)
    await controller.recordWaypoint()
    await controller.recordWaypoint()
    await controller.generate({ name: '航线 A', globalSpeed: 10, waypointSpeed: 4 })

    expect(devices!.getProjectDevices).toHaveBeenCalledWith({ projectId: 'project-1' })
    expect(api.generate).toHaveBeenCalledWith('route-1', {
      name: '航线 A',
      globalSpeed: 10,
      waypointSpeed: 4,
      droneModelKey: '0-100-1',
    })
  })

  it.each([
    { aircraft: { sn: 'drone-other', model: { modelKey: '0-91-1' } } },
    { aircraft: { sn: 'drone-1', model: { modelKey: null } } },
    { aircraft: { sn: 'drone-1', model: { modelKey: '   ' } } },
  ])('拓扑里找不到当前飞机或机型 key 为空时阻断生成：%j', async (device) => {
    const devices: TeachControllerDependencies['devices'] = {
      getProjectDevices: vi.fn(async () => [device]),
    }
    const { api, controller } = setup('load', devices)
    await controller.recordWaypoint()
    await controller.recordWaypoint()
    await expect(controller.generate({ name: '航线 A', globalSpeed: 10, waypointSpeed: 4 }))
      .rejects.toThrow('无法获取当前无人机机型，请稍后点击「生成航线」重试')
    expect(api.generate).not.toHaveBeenCalled()
    expect(controller.getState()).toMatchObject({ phase: 'recording', route: { waypoints: [{ id: 'point-1' }, { id: 'point-2' }] } })
    expect(controller.isBusy()).toBe(false)
  })

  it('设备能力查询失败时阻断生成并保留录制内容，可重试', async () => {
    const devices: TeachControllerDependencies['devices'] = {
      getProjectDevices: vi.fn().mockRejectedValueOnce(new Error('拓扑接口不可用'))
        .mockResolvedValue([{ aircraft: { sn: 'drone-1', model: { modelKey: '0-100-1' } } }]),
    }
    const { api, controller } = setup('load', devices)
    await controller.recordWaypoint()
    await controller.recordWaypoint()
    await expect(controller.generate({ name: '航线 A', globalSpeed: 10, waypointSpeed: 4 }))
      .rejects.toThrow('拓扑接口不可用')
    expect(api.generate).not.toHaveBeenCalled()
    expect(controller.getState()).toMatchObject({ phase: 'recording', route: { waypoints: [{ id: 'point-1' }, { id: 'point-2' }] } })
    expect(controller.isBusy()).toBe(false)
    await controller.generate({ name: '航线 A', globalSpeed: 10, waypointSpeed: 4 })
    expect(api.generate).toHaveBeenCalledWith('route-1', expect.objectContaining({ droneModelKey: '0-100-1' }))
    expect(controller.getState()).toMatchObject({ phase: 'generated' })
  })

  it('设备能力缺失时允许录点但阻断生成', async () => {
    const { api, controller } = setup('load', null)
    await controller.recordWaypoint()
    await controller.recordWaypoint()
    await expect(controller.generate({ name: '航线 A', globalSpeed: 10, waypointSpeed: 4 }))
      .rejects.toThrow('设备查询能力不可用')
    expect(api.generate).not.toHaveBeenCalled()
    expect(controller.getState().route?.waypoints).toHaveLength(2)
    expect(controller.getState().phase).toBe('recording')
  })

  it('新建示教仅允许从 generated 回到 idle', async () => {
    const { controller } = setup('load')
    await controller.recordWaypoint()
    await controller.recordWaypoint()
    await controller.generate({ name: '航线 A', globalSpeed: 10, waypointSpeed: 4 })
    controller.startNewTeaching()

    expect(controller.getState().phase).toBe('idle')
  })

  it('其他页面已生成路线时不回退为带旧航点的 recording', async () => {
    const { api, controller } = setup('load')
    await controller.recordWaypoint()
    await controller.recordWaypoint()
    api.generate.mockRejectedValueOnce(Object.assign(new Error('状态冲突'), {
      code: 'PLUGIN_GATEWAY_ERROR',
      detail: { httpStatus: 409, gatewayCode: 40902 },
    }))

    await expect(controller.generate({ name: '航线 A', globalSpeed: 10, waypointSpeed: 4 }))
      .rejects.toThrow('其他页面生成')
    expect(controller.getState()).toEqual({ phase: 'idle', route: null })
  })
})
