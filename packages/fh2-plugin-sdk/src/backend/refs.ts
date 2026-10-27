// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin-toolchain typegen 生成,勿手改。
// 来源契约: 平台契约 backend catalog 与 errors（contractsVersion 1.1.0）。
// 重新生成: WRITE_BACKEND_TYPES=1 pnpm --filter fh2-plugin-toolchain test -- src/backend/typegen
// 共享小类型(VideoRef 等)是模板事实:来自对 hostapi.go 的核实,fixture 未覆盖参数形状。

/** 平台契约里的视频引用:fileId + objectKey。objectKey 只接受回调消息透传值,插件不许自己拼。 */
export interface VideoRef {
  readonly fileId: string
  readonly objectKey: string
}

/** 媒体产出的业务归属(注册进媒体库要它)。 */
export interface MediaOwner {
  readonly projectId: string
  readonly dockSn: string
  readonly flightId: string
}

/** 视频叠加颜色，RGBA 各通道取 0～255。 */
export interface VideoRGBA {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a: number
}

/** 视频帧内的归一化坐标点。 */
export interface VideoPoint {
  readonly x: number
  readonly y: number
}

/** 视频帧上的折线或多边形。 */
export interface VideoOverlayPath {
  readonly type: 'line' | 'polygon'
  readonly points: readonly VideoPoint[]
  readonly stroke?: VideoRGBA
  readonly fill?: VideoRGBA
}

/** 视频帧上的矩形框与可选标签。 */
export interface VideoOverlayBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly stroke: VideoRGBA
  readonly label?: string
}

/** 单帧烧录的受控图形集合。 */
export interface VideoFrameOverlay {
  readonly paths: readonly VideoOverlayPath[]
  readonly boxes: readonly VideoOverlayBox[]
}

/** notify.publish 的意图(对象入参:字符串参数写错顺序不会报错,只会前端不认)。 */
export interface NotifyIntent {
  readonly channel: string
  readonly to: readonly string[]
  readonly bizCode: string
  readonly subCode?: string
  readonly data?: Record<string, unknown>
}

/** wayline.generate 的意图。 */
export interface WaylineGenerateIntent {
  readonly name: string
  readonly projectId: string
  readonly globalSpeed?: number
  readonly waypointSpeed?: number
  /** 无人机 device_enum_key(三段式 domain-type-subtype,如 "0-100-1"),决定航线文件机型枚举。 */
  readonly droneEnumKey: string
  /** 载荷 device_enum_key,可选:缺省时由宿主按机身推导;同机身多云台机型(如 H30/H30T)必须传。 */
  readonly payloadEnumKey?: string
  readonly waypoints: ReadonlyArray<{
    readonly latitude: number
    readonly longitude: number
    readonly height: number
    readonly gimbalPitch?: number
    readonly cameraYaw?: number
    readonly focalLength?: number
    readonly aiRecognitionOn?: boolean
    readonly aiTargetTypes?: readonly string[]
  }>
}

export interface WaylineGenerateResult {
  readonly waylineUuid: string
  readonly objectKey: string
  readonly name: string
  readonly waypointCount: number
}

export interface ScreenshotUploadGrant {
  readonly accessKeyID: string
  readonly secretAccessKey: string
  readonly securityToken: string
  readonly endpoint: string
  readonly bucket: string
  readonly region: string
  readonly objectKeyPrefix: string
  readonly expiresIn: number
  readonly usePathStyle: boolean
  /** 条件字段:仅非空时出现(平台按需附带)。 */
  readonly objectKey?: string
}

export interface FetchResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string
}
