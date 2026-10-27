// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { GeoPoint, PlatformMapBillboardInput, PlatformMapElementHandle } from 'fh2-plugin-sdk'

function createPhotoMarkerIcon (thumbUrl: string | null, accent: string): string {
  const imageTag = thumbUrl
    ? `<image href="${thumbUrl}" x="8" y="6" width="32" height="32" preserveAspectRatio="xMidYMid slice"/>`
    : '<rect x="8" y="6" width="32" height="32" rx="4" fill="#3f3f46"/>'
      + '<path d="M17 15l9 7-9 7z" fill="#d4d4d8"/>'
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="54">'
    + `<rect x="4" y="2" width="40" height="40" rx="10" fill="#18181b" stroke="${accent}" stroke-width="2"/>${imageTag}`
    + `<path d="M24 40L17 52h14z" fill="${accent}"/>`
    + '</svg>'
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/**
 * blob: 缩略图转嵌套 data: URL：billboard 的 SVG data URL 会被宿主地图（Cesium Image）
 * 当作「图片」解码，浏览器对 SVG-as-image 启用安全静态模式——blob:/http(s): 等外部
 * 引用一律不加载，只有嵌套 data: URL 可见。失败由调用方降级为占位图。
 */
async function blobUrlToDataUrl (thumbUrl: string, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(thumbUrl)
  if (cached !== undefined) return cached
  const blob = await fetch(thumbUrl).then(response => response.blob())
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  const dataUrl = `data:${blob.type || 'image/png'};base64,${btoa(binary)}`
  cache.set(thumbUrl, dataUrl)
  return dataUrl
}

/**
 * 证据预览地图联动：选中记录时在拍摄位置创建照片图钉（行人蓝框/变道黄框），
 * 切换/关闭/卸载时清理；Map Handle 只留在 Entry Realm，不进 View。
 * 相同输入的 show 幂等：不清理、不重建、不重定位——记录状态重放（遥测帧、
 * 后端刷新合并）不得让图元闪烁。
 */
export interface MapPreviewInput {
  readonly thumbUrl: string | null;
  readonly longitude: number;
  readonly latitude: number;
  readonly height: number;
  /** 行人蓝框（#268AFF）/ 变道黄框（#FFD800），对齐原生 marker 配色。 */
  readonly accent: 'person-road' | 'lane-change';
}

/** platform:map 能力子集（capability client 的 Promise 形态）。 */
export interface MapPreviewPort {
  addBillboard (input: PlatformMapBillboardInput): Promise<PlatformMapElementHandle<Partial<PlatformMapBillboardInput>>>;
  recenter (input: { readonly points: readonly GeoPoint[]; readonly padding?: number }): Promise<void>;
}

export interface MapPreviewController {
  show (input: MapPreviewInput): Promise<void>;
  clear (): void;
}

function sameMapPreviewInput (left: MapPreviewInput, right: MapPreviewInput): boolean {
  return left.thumbUrl === right.thumbUrl
    && left.longitude === right.longitude
    && left.latitude === right.latitude
    && left.height === right.height
    && left.accent === right.accent
}

export function createMapPreviewController (map: MapPreviewPort | null): MapPreviewController {
  let handle: { dispose (): void } | null = null
  let input: MapPreviewInput | null = null
  let generation = 0
  const thumbCache = new Map<string, string>()

  function clear (): void {
    generation += 1
    input = null
    const current = handle
    handle = null
    current?.dispose()
  }

  async function show (next: MapPreviewInput): Promise<void> {
    // 幂等：记录状态重放会再次 show 同一输入，跳过以免清理+重建造成图元闪烁
    if (input !== null && sameMapPreviewInput(input, next)) return
    clear()
    if (!map) return
    if (!Number.isFinite(next.longitude) || !Number.isFinite(next.latitude)) return
    input = next
    const accent = next.accent === 'person-road' ? '#268AFF' : '#FFD800'
    const ticket = generation
    // blob: 缩略图转嵌套 data: URL；转换失败降级占位图，不阻断图钉创建。
    // 非 blob: URL 无需转换，保持同步创建路径。
    let thumbUrl = next.thumbUrl
    if (thumbUrl !== null && thumbUrl.startsWith('blob:')) {
      try {
        thumbUrl = await blobUrlToDataUrl(thumbUrl, thumbCache)
      } catch {
        thumbUrl = null
      }
    }
    try {
      if (ticket !== generation) return
      const element = await map.addBillboard({
        position: { lng: next.longitude, lat: next.latitude, height: next.height },
        image: createPhotoMarkerIcon(thumbUrl, accent),
        width: 48,
        height: 54,
      })
      // 异步竞态：创建完成前预览已切换/关闭 → 立即清理
      if (ticket !== generation) {
        element.dispose()
        return
      }
      handle = element
      await map.recenter({ points: [{ lng: next.longitude, lat: next.latitude, height: next.height }] })
    } catch {
      // 失败复位输入以便后续相同输入重试；地图能力异常不影响证据预览本身
      if (ticket === generation) input = null
    }
  }

  return { show, clear }
}
