// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PlatformObjectUploadInput } from 'fh2-plugin-sdk'
import type { TeachApi } from '../api/teach-api'
import { isTeachConflictError, isTeachStateError } from '../api/teach-api'
import {
  beginGenerating,
  createInitialTeachSession,
  enterRecording,
  failGenerating,
  finishGenerating,
  resetTeachSession,
  restoreTeachSession,
  updateTeachRoute,
} from './teach-session'
import type { TeachAiTargetType, TeachSessionState, TeachWaypoint } from './teach-session'
import type { TeachTelemetryState } from './teach-telemetry'
import { compressScreenshot } from './screenshot-compression'

export type TeachConflictDecision = 'load' | 'recreate' | 'cancel'

export interface TeachControllerDependencies {
  readonly api: TeachApi;
  readonly telemetry: { getState(): Promise<TeachTelemetryState> };
  /**
   * 无人机机型 key 来源（生成时按当前架次飞机匹配项目拓扑），结构对齐
   * platform:devices capability 的 getProjectDevices 契约；录点不依赖此能力，
   * 生成时必须取得机型 key，否则阻断生成并保留录制内容。
   */
  readonly devices?: {
    getProjectDevices(input: { readonly projectId: string }): Promise<ReadonlyArray<{
      readonly aircraft: { readonly sn: string; readonly model: { readonly modelKey: string | null } } | null;
    }>>;
  };
  /**
   * 车辆 AI 识别门使用，结构对齐 cockpit:ai-config capability 的 ensure 契约。
   * 写侧目标类型词表是 vehicle（真实宿主不认 car）；读侧遥测会归一化为 car。
   */
  readonly ai: {
    ensure(input: {
      readonly model?: 'dji-visible';
      readonly recognitionEnabled?: boolean;
      readonly targetTypes?: readonly string[];
    }): Promise<{
      readonly confirmed: boolean;
      readonly reason: string | null;
    }>;
  };
  readonly camera: {
    captureFrame(options: { readonly scale: number; readonly mime: 'image/jpeg'; readonly quality: number; readonly requireGeometry: false }): Promise<{
      readonly blob: Blob;
      readonly geometrySnapshotId: string | null;
    }>;
  };
  readonly sceneGeometry: {
    releaseSnapshot(snapshotId: string): Promise<void>;
  };
  readonly objectUpload: {
    upload(input: PlatformObjectUploadInput): Promise<{ readonly etag: string | null }>;
  };
  readonly resolveConflict: (route: TeachSessionState) => Promise<TeachConflictDecision>;
  readonly onCleanupError: (error: unknown) => void;
  readonly onTelemetrySnapshot?: (state: TeachTelemetryState) => void;
  readonly onScreenshotError?: (input: {
    readonly stage: 'create-sts' | 'upload' | 'attach';
    readonly routeId: string;
    readonly waypointId: string;
    readonly error: unknown;
  }) => void;
}

export interface GenerateTeachInput {
  readonly name: string;
  readonly globalSpeed: number;
  readonly waypointSpeed: number;
}

export interface TeachController {
  getState(): TeachSessionState;
  isBusy(): boolean;
  subscribe(listener: (state: TeachSessionState) => void): { dispose(): void };
  restore(): Promise<void>;
  recordWaypoint(): Promise<void>;
  retryScreenshot(waypointId: string): Promise<void>;
  updateWaypoint(waypointId: string, patch: Partial<Pick<TeachWaypoint, 'focalLength' | 'selected'>>): Promise<void>;
  deleteWaypoint(waypointId: string): Promise<void>;
  generate(input: GenerateTeachInput): Promise<void>;
  startNewTeaching(): void;
  exitTeaching(): Promise<void>;
  dispose(): void;
}

const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024
const MAX_ROUTE_SCREENSHOT_BYTES = 80 * 1024 * 1024
const VALID_AI_TARGET_TYPES = new Set<TeachAiTargetType>(['person', 'car', 'boat'])

function normalizeAiTargetTypes (value: readonly string[]): readonly TeachAiTargetType[] {
  const result = new Set<TeachAiTargetType>()
  for (const item of value) {
    if (VALID_AI_TARGET_TYPES.has(item as TeachAiTargetType)) result.add(item as TeachAiTargetType)
  }
  return [...result].sort()
}

/** requireTelemetry 校验通过后可用于录点的遥测快照：标识与姿态字段均为非空有限值。 */
type ValidTeachTelemetry = TeachTelemetryState & {
  readonly projectId: string;
  readonly flightId: string;
  readonly dockSn: string;
  readonly droneSn: string;
  readonly longitude: number;
  readonly latitude: number;
  readonly height: number;
  readonly cameraYaw: number;
  readonly gimbalPitch: number;
  readonly focalLength: number;
}

function requireTelemetry (state: TeachTelemetryState): asserts state is ValidTeachTelemetry {
  const identifiers = [state.projectId, state.flightId, state.dockSn, state.droneSn]
  if (identifiers.some(value => !value)) throw new Error('项目、航次或设备上下文不可用')
  if (!Number.isFinite(state.longitude) || !Number.isFinite(state.latitude)) throw new Error('经纬度不可用')
  if (!Number.isFinite(state.height)) throw new Error('WGS84 椭球高不可用')
  if (!Number.isFinite(state.cameraYaw) || !Number.isFinite(state.gimbalPitch)) throw new Error('云台姿态不可用')
  if (!Number.isFinite(state.focalLength) || (state.focalLength ?? 0) < 24) throw new Error('焦距不可用')
  if (!state.aiAvailable) throw new Error('AI 识别状态不可用')
  // 「识别开启但目标不含 car」不再在此处拦截：由录点前的车辆 AI 门统一自动开启（见 ensureVehicleAiForRecord）。
}

function validateGenerateInput (input: GenerateTeachInput): GenerateTeachInput {
  const name = input.name.trim()
  if (!name || name.length > 100) throw new Error('航线名称必须为 1 至 100 个字符')
  for (const [label, speed] of [['全局速度', input.globalSpeed], ['航点速度', input.waypointSpeed]] as const) {
    if (!Number.isFinite(speed) || speed < 0.1 || speed > 15) {
      throw new Error(`${label}必须在 0.1 至 15m/s 之间`)
    }
  }
  return { ...input, name }
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createTeachController (dependencies: TeachControllerDependencies): TeachController {
  let state = createInitialTeachSession()
  let busy = false
  let restoreGeneration = 0
  let operationGeneration = 0
  const screenshotBlobs = new Map<string, Blob>()
  const screenshotPreviewUrls = new Map<string, string>()
  const listeners = new Set<(state: TeachSessionState) => void>()

  const revokeScreenshotPreview = (waypointId: string): void => {
    const url = screenshotPreviewUrls.get(waypointId)
    if (url) URL.revokeObjectURL(url)
    screenshotPreviewUrls.delete(waypointId)
  }
  const clearScreenshotResources = (): void => {
    screenshotBlobs.clear()
    for (const waypointId of screenshotPreviewUrls.keys()) revokeScreenshotPreview(waypointId)
  }
  const screenshotPreview = (waypointId: string, blob: Blob, remoteUrl: string | null): string => {
    revokeScreenshotPreview(waypointId)
    if (remoteUrl) return remoteUrl
    const localUrl = URL.createObjectURL(blob)
    screenshotPreviewUrls.set(waypointId, localUrl)
    return localUrl
  }

  const setState = (next: TeachSessionState): void => {
    state = next
    for (const listener of listeners) listener(state)
  }
  const isOperationCurrent = (generation: number): boolean => generation === operationGeneration
  const currentTelemetry = async (): Promise<TeachTelemetryState> => dependencies.telemetry.getState()
  const updateWaypointLocally = (waypointId: string, patch: Partial<TeachWaypoint>): void => {
    setState(updateTeachRoute(state, route => ({
      ...route,
      waypoints: route.waypoints.map(waypoint => waypoint.id === waypointId ? { ...waypoint, ...patch } : waypoint),
    })))
  }

  /**
   * 解析当前架次飞机的原始机型 key（domain-type-subtype，如 '0-100-1'）。
   * 匹配口径：遥测 roster 的 droneSn 对项目拓扑里的 aircraft.sn。
   * 取不到机型时抛错，避免生成请求缺少后端必填字段；仅过期操作返回 undefined。
   */
  async function resolveDroneModelKey (generation: number): Promise<string | undefined> {
    const devices = dependencies.devices
    if (!devices) throw new Error('设备查询能力不可用，无法获取无人机机型')
    const snapshot = await currentTelemetry()
    if (!isOperationCurrent(generation)) return undefined
    if (!snapshot.projectId || !snapshot.droneSn) throw new Error('项目或无人机上下文不可用，无法获取无人机机型')
    const projectDevices = await devices.getProjectDevices({ projectId: snapshot.projectId })
    if (!isOperationCurrent(generation)) return undefined
    const aircraft = projectDevices.find(device => device.aircraft?.sn === snapshot.droneSn)?.aircraft
    const modelKey = aircraft?.model.modelKey?.trim()
    if (!modelKey) throw new Error('无法获取当前无人机机型，请稍后点击「生成航线」重试')
    return modelKey
  }

  /** 车辆识别已生效：遥测读侧把宿主的 vehicle 归一化为 car，这里只需判断 car 在目标集内。 */
  const vehicleAiActive = (snapshot: TeachTelemetryState): boolean =>
    snapshot.aiRecognitionOn && normalizeAiTargetTypes(snapshot.aiTargetTypes).includes('car')

  /**
   * 录点前的车辆 AI 识别门（入参须已通过 requireTelemetry 校验）：
   * - 已开启（目标含 car）直接透传当前快照，不重复下发；
   * - 未开启先自动开启（目标类型按契约语义精确替换为 vehicle），失败抛错并提示手动开启，
   *   此时后端路线尚未创建（门位于 ensureRoute 之前）；
   * - 自动开启成功后重拉遥测复核并返回刷新后的快照供录点使用（航点记录开启后的 AI 状态）；
   * - 操作过期（generation 变化）返回 null，由调用方终止录点。
   */
  async function ensureVehicleAiForRecord (snapshot: ValidTeachTelemetry, generation: number): Promise<ValidTeachTelemetry | null> {
    if (vehicleAiActive(snapshot)) return snapshot
    let result: { confirmed: boolean; reason: string | null }
    try {
      result = await dependencies.ai.ensure({
        model: 'dji-visible',
        recognitionEnabled: true,
        targetTypes: ['vehicle'],
      })
    } catch (error) {
      if (!isOperationCurrent(generation)) return null
      throw new Error(`自动开启车辆 AI 识别失败：${errorMessage(error)}，请手动开启后再录入航点`)
    }
    if (!isOperationCurrent(generation)) return null
    if (!result.confirmed) {
      throw new Error(`自动开启车辆 AI 识别失败：${result.reason ?? '未知原因'}，请手动开启后再录入航点`)
    }
    const latest = await currentTelemetry()
    if (!isOperationCurrent(generation)) return null
    requireTelemetry(latest)
    if (!vehicleAiActive(latest)) throw new Error('车辆 AI 识别未能生效，请手动开启后再录入航点')
    return latest
  }

  async function ensureRoute (snapshot: TeachTelemetryState, generation: number): Promise<boolean> {
    if (state.route?.projectId === snapshot.projectId && state.route.flightId === snapshot.flightId) {
      return isOperationCurrent(generation)
    }
    if (state.route) {
      clearScreenshotResources()
      setState(resetTeachSession(state))
    }
    requireTelemetry(snapshot)
    try {
      const route = await dependencies.api.enter({
        projectId: snapshot.projectId,
        flightId: snapshot.flightId,
        dockSn: snapshot.dockSn,
        droneSn: snapshot.droneSn,
      })
      if (!isOperationCurrent(generation)) {
        try {
          await dependencies.api.deleteRoute(route.id)
        } catch (error) {
          dependencies.onCleanupError(error)
        }
        return false
      }
      setState(enterRecording(state, route))
      return true
    } catch (error) {
      if (!isTeachConflictError(error)) throw error
      const existing = await dependencies.api.getStatus(snapshot.projectId, snapshot.flightId)
      if (!isOperationCurrent(generation)) return false
      if (!existing) throw new Error('检测到示教冲突，但未找到可恢复路线')
      const existingState = restoreTeachSession(existing)
      const decision = await dependencies.resolveConflict(existingState)
      if (!isOperationCurrent(generation)) return false
      if (decision === 'cancel') return false
      if (decision === 'load') {
        setState(existingState)
        return true
      }
      await dependencies.api.deleteRoute(existing.id)
      const route = await dependencies.api.enter({
        projectId: snapshot.projectId,
        flightId: snapshot.flightId,
        dockSn: snapshot.dockSn,
        droneSn: snapshot.droneSn,
      })
      if (!isOperationCurrent(generation)) {
        try {
          await dependencies.api.deleteRoute(route.id)
        } catch (error) {
          dependencies.onCleanupError(error)
        }
        return false
      }
      setState(enterRecording(createInitialTeachSession(), route))
      return true
    }
  }

  async function uploadScreenshot (routeId: string, waypointId: string, blob: Blob): Promise<{
    readonly screenshotFileId: string | null;
    readonly screenshotUrl: string | null;
  }> {
    if (blob.size > MAX_SCREENSHOT_BYTES) throw new Error('截图超过 2MB，请降低画质后重试')
    let stage: 'create-sts' | 'upload' | 'attach' = 'create-sts'
    try {
      const target = await dependencies.api.createScreenshotUpload(routeId, waypointId)
      stage = 'upload'
      await dependencies.objectUpload.upload({ ...target, blob })
      stage = 'attach'
      return await dependencies.api.attachScreenshot(waypointId, {
        objectKey: target.objectKey,
        bytes: blob.size,
      })
    } catch (error) {
      dependencies.onScreenshotError?.({ stage, routeId, waypointId, error })
      throw error
    }
  }

  return {
    getState: () => state,
    isBusy: () => busy,
    subscribe (listener) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    async restore () {
      if (busy) {
        restoreGeneration += 1
        return
      }
      const generation = ++restoreGeneration
      const currentOperation = operationGeneration
      const snapshot = await currentTelemetry()
      if (!isOperationCurrent(currentOperation)) return
      if (!snapshot.projectId || !snapshot.flightId) {
        clearScreenshotResources()
        setState(resetTeachSession(state))
        return
      }
      const restoreKey = `${snapshot.projectId}:${snapshot.flightId}`
      const route = await dependencies.api.getStatus(snapshot.projectId, snapshot.flightId)
      if (generation !== restoreGeneration || !isOperationCurrent(currentOperation)) return
      const latest = await currentTelemetry()
      if (!isOperationCurrent(currentOperation) || `${latest.projectId}:${latest.flightId}` !== restoreKey) return
      if (!route) {
        clearScreenshotResources()
        setState(resetTeachSession(state))
        return
      }
      clearScreenshotResources()
      setState(restoreTeachSession(route))
    },
    async recordWaypoint () {
      if (busy) throw new Error('正在处理上一个示教操作')
      restoreGeneration += 1
      const generation = operationGeneration
      busy = true
      try {
        const snapshot = await currentTelemetry()
        if (!isOperationCurrent(generation)) return
        dependencies.onTelemetrySnapshot?.(snapshot)
        requireTelemetry(snapshot)
        // 录点前的车辆 AI 识别门：未开启先自动开启，失败提示手动开启；成功后用刷新快照继续。
        const recordingSnapshot = await ensureVehicleAiForRecord(snapshot, generation)
        if (!recordingSnapshot || !isOperationCurrent(generation)) return
        if (state.route && (state.route.projectId !== recordingSnapshot.projectId || state.route.flightId !== recordingSnapshot.flightId)) {
          setState(resetTeachSession(state))
        }
        if (!await ensureRoute(recordingSnapshot, generation) || !state.route || !isOperationCurrent(generation)) return
        const route = state.route
        if (route.screenshotBytes >= MAX_ROUTE_SCREENSHOT_BYTES) {
          throw new Error('本条航线的截图空间已用尽（80MB）')
        }
        const frame = await dependencies.camera.captureFrame({ scale: 1, mime: 'image/jpeg', quality: 0.85, requireGeometry: false })
        try {
          if (!isOperationCurrent(generation)) return
          const screenshotBlob = await compressScreenshot(frame.blob)
          if (!isOperationCurrent(generation)) return
          const waypoint = await dependencies.api.appendWaypoint(route.id, {
            longitude: recordingSnapshot.longitude,
            latitude: recordingSnapshot.latitude,
            height: recordingSnapshot.height,
            cameraYaw: recordingSnapshot.cameraYaw,
            gimbalPitch: recordingSnapshot.gimbalPitch,
            focalLength: recordingSnapshot.focalLength,
            aiRecognitionOn: recordingSnapshot.aiRecognitionOn,
            aiTargetTypes: normalizeAiTargetTypes(recordingSnapshot.aiTargetTypes),
          })
          if (!isOperationCurrent(generation)) return
          screenshotBlobs.set(waypoint.id, screenshotBlob)
          let savedWaypoint = waypoint
          let addedBytes = 0
          try {
            const screenshot = await uploadScreenshot(route.id, waypoint.id, screenshotBlob)
            if (!isOperationCurrent(generation)) return
            screenshotBlobs.delete(waypoint.id)
            savedWaypoint = {
              ...waypoint,
              ...screenshot,
              screenshotUrl: screenshotPreview(waypoint.id, screenshotBlob, screenshot.screenshotUrl),
              screenshotBytes: screenshotBlob.size,
              screenshotError: null,
            }
            addedBytes = screenshotBlob.size
          } catch (error) {
            if (!isOperationCurrent(generation)) return
            savedWaypoint = { ...waypoint, screenshotError: errorMessage(error) }
          }
          if (!isOperationCurrent(generation)) return
          setState(updateTeachRoute(state, current => ({
            ...current,
            screenshotBytes: current.screenshotBytes + addedBytes,
            waypoints: [...current.waypoints, savedWaypoint],
          })))
        } finally {
          try {
            if (frame.geometrySnapshotId) await dependencies.sceneGeometry.releaseSnapshot(frame.geometrySnapshotId)
          } catch (error) {
            dependencies.onCleanupError(error)
          }
        }
      } catch (error) {
        if (!isOperationCurrent(generation)) return
        throw error
      } finally {
        if (isOperationCurrent(generation)) busy = false
      }
    },
    async retryScreenshot (waypointId) {
      if (busy) throw new Error('正在处理上一个示教操作')
      const route = state.route
      const waypoint = route?.waypoints.find(item => item.id === waypointId)
      if (!route || !waypoint) throw new Error('航点不存在')
      const generation = operationGeneration
      busy = true
      let snapshotId: string | undefined
      try {
        let blob = screenshotBlobs.get(waypointId)
        if (!blob) {
          const frame = await dependencies.camera.captureFrame({ scale: 1, mime: 'image/jpeg', quality: 0.85, requireGeometry: false })
          blob = await compressScreenshot(frame.blob)
          snapshotId = frame.geometrySnapshotId ?? undefined
          screenshotBlobs.set(waypointId, blob)
        }
        const screenshot = await uploadScreenshot(route.id, waypointId, blob)
        if (!isOperationCurrent(generation)) return
        screenshotBlobs.delete(waypointId)
        updateWaypointLocally(waypointId, {
          ...screenshot,
          screenshotUrl: screenshotPreview(waypointId, blob, screenshot.screenshotUrl),
          screenshotBytes: blob.size,
          screenshotError: null,
        })
        setState(updateTeachRoute(state, current => ({
          ...current,
          screenshotBytes: current.screenshotBytes - waypoint.screenshotBytes + blob.size,
        })))
      } catch (error) {
        if (!isOperationCurrent(generation)) return
        updateWaypointLocally(waypointId, { screenshotError: errorMessage(error) })
        throw error
      } finally {
        if (snapshotId) {
          try {
            await dependencies.sceneGeometry.releaseSnapshot(snapshotId)
          } catch (error) {
            dependencies.onCleanupError(error)
          }
        }
        if (isOperationCurrent(generation)) busy = false
      }
    },
    async updateWaypoint (waypointId, patch) {
      if (busy) throw new Error('正在处理上一个示教操作')
      if (patch.focalLength !== undefined && (!Number.isFinite(patch.focalLength) || patch.focalLength < 24)) {
        throw new Error('焦距不得小于 24mm')
      }
      const generation = operationGeneration
      busy = true
      try {
        await dependencies.api.updateWaypoint(waypointId, patch)
        if (!isOperationCurrent(generation)) return
        updateWaypointLocally(waypointId, patch)
      } finally {
        if (isOperationCurrent(generation)) busy = false
      }
    },
    async deleteWaypoint (waypointId) {
      if (busy) throw new Error('正在处理上一个示教操作')
      const waypoint = state.route?.waypoints.find(item => item.id === waypointId)
      const generation = operationGeneration
      busy = true
      try {
        await dependencies.api.deleteWaypoint(waypointId)
        if (!isOperationCurrent(generation)) return
        screenshotBlobs.delete(waypointId)
        revokeScreenshotPreview(waypointId)
        setState(updateTeachRoute(state, route => ({
          ...route,
          screenshotBytes: route.screenshotBytes - (waypoint?.screenshotBytes ?? 0),
          waypoints: route.waypoints.filter(item => item.id !== waypointId),
        })))
      } finally {
        if (isOperationCurrent(generation)) busy = false
      }
    },
    async generate (rawInput) {
      if (busy) throw new Error('正在处理上一个示教操作')
      const input = validateGenerateInput(rawInput)
      const configured = updateTeachRoute(state, route => ({
        ...route,
        name: input.name,
        globalSpeed: input.globalSpeed,
        waypointSpeed: input.waypointSpeed,
      }))
      const generating = beginGenerating(configured)
      const generation = operationGeneration
      busy = true
      setState(generating)
      try {
        if (!generating.route) throw new Error('示教路线不存在')
        // 后端机型必填：取不到时保留录制内容并报错，不能发送缺字段的生成请求。
        const droneModelKey = await resolveDroneModelKey(generation)
        if (!isOperationCurrent(generation) || droneModelKey === undefined) return
        const result = await dependencies.api.generate(generating.route.id, { ...input, droneModelKey })
        if (!isOperationCurrent(generation)) return
        setState(finishGenerating(generating, result))
        clearScreenshotResources()
      } catch (error) {
        if (!isOperationCurrent(generation)) return
        if (isTeachStateError(error)) {
          clearScreenshotResources()
          setState(resetTeachSession(generating))
          throw new Error('该示教路线已在其他页面生成，请从航线列表查看结果')
        }
        if (state.phase === 'generating' && state.route?.id === generating.route?.id) {
          setState(failGenerating(generating))
        }
        throw error
      } finally {
        if (isOperationCurrent(generation)) busy = false
      }
    },
    startNewTeaching () {
      if (state.phase !== 'generated') throw new Error('当前状态不能新建示教')
      clearScreenshotResources()
      setState(resetTeachSession(state))
    },
    async exitTeaching () {
      const route = state.route
      const phase = state.phase
      operationGeneration += 1
      restoreGeneration += 1
      busy = false
      clearScreenshotResources()
      setState(resetTeachSession(state))
      if (route && phase !== 'generated') await dependencies.api.deleteRoute(route.id)
    },
    dispose () {
      operationGeneration += 1
      clearScreenshotResources()
      listeners.clear()
    },
  }
}
