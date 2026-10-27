// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { GeoPoint, PlatformMapBillboardInput, PlatformMapElementHandle } from 'fh2-plugin-sdk'

/**
 * 证据预览地图联动：打开预览时在车辆位置创建照片图钉并飞过去，
 * 切换/关闭/卸载时清理（对齐原生 PatrolPreview 的 addBillboard/recenterMap）。
 *
 * Map Handle 只留在 Entry Realm，不进 View。
 */
export interface MapPreviewInput {
  readonly thumbUrl: string;
  readonly longitude: number;
  readonly latitude: number;
  readonly height: number;
}

export interface MapPreviewController {
  show (input: MapPreviewInput): Promise<void>;
  clear (): void;
}

/** platform:map 能力子集（capability client 的 Promise 形态）。 */
export interface MapPreviewPort {
  addBillboard (input: PlatformMapBillboardInput): Promise<PlatformMapElementHandle<Partial<PlatformMapBillboardInput>>>;
  recenter (input: { readonly points: readonly GeoPoint[]; readonly padding?: number }): Promise<void>;
}

export function createMapPreviewController (
  map: MapPreviewPort | null,
  buildIcon: (thumbUrl: string) => string,
): MapPreviewController {
  let handle: { dispose (): void } | null = null
  let generation = 0

  function clear (): void {
    generation++
    const current = handle
    handle = null
    current?.dispose()
  }

  async function show (input: MapPreviewInput): Promise<void> {
    clear()
    if (!map) return
    if (!Number.isFinite(input.longitude) || !Number.isFinite(input.latitude)) return
    const ticket = generation
    try {
      const element = await map.addBillboard({
        position: { lng: input.longitude, lat: input.latitude, height: input.height },
        image: buildIcon(input.thumbUrl),
        width: 48,
        height: 54,
      })
      // 异步竞态：创建完成前预览已切换/关闭 → 立即清理
      if (ticket !== generation) {
        element.dispose()
        return
      }
      handle = element
      await map.recenter({ points: [{ lng: input.longitude, lat: input.latitude, height: input.height }] })
    } catch {
      // 地图能力异常不影响证据预览本身
    }
  }

  return { show, clear }
}
