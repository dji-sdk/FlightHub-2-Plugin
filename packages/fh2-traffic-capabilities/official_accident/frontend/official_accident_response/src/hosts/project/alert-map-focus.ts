// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { GeoPoint, PlatformMapBillboardInput, PlatformMapElementHandle } from 'fh2-plugin-sdk'
import type { AccidentRecord } from '../../workflow/types'

// 原生 alarm_activepoint.svg 源码（与宿主 PlatformWaylinePreview 告警终点同款图标）。
// Entry 模块图禁止图片资源导入，因此在浏览器运行时转为 宿主地图栈已验证可消费的
// base64 data URI；源码只含 ASCII，btoa 不会失真。
export const ALERT_POINT_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" fill="none" version="1.1" width="56" height="56" viewBox="0 0 56 56"><g><g><g><path d="M8.707107,27.2929C8.316583,27.6834,8.316583,28.3166,8.707107,28.7071L27.2929,47.2929C27.6834,47.6834,28.3166,47.6834,28.7071,47.2929L47.2929,28.7071C47.6834,28.3166,47.6834,27.6834,47.2929,27.2929L28.7071,8.707107C28.3166,8.316583,27.6834,8.316583,27.2929,8.707107L8.707107,27.2929Z" fill="#E70102" fill-opacity="1"/></g><g><g><path d="M26.271267,18C25.986958,18,25.75986469,18.236753,25.7717006,18.520815L26.230034,29.5208C26.241193,29.788600000000002,26.461555,30,26.7296,30L29.2704,30C29.53845,30,29.75881,29.788600000000002,29.76997,29.5208L30.2283,18.520815C30.24014,18.236753,30.01304,18,29.72873,18L26.271267,18Z" fill="#FFFFFF" fill-opacity="1"/></g><g><rect x="26.25" y="31.5" width="3.5" height="3.5" rx="0.5" fill="#FFFFFF" fill-opacity="1"/></g></g></g></g></svg>'

/** 告警点图标的 data URL；对齐宿主告警终点 billboard 的 36×36 渲染参数。 */
export const ALERT_POINT_ICON_URL = `data:image/svg+xml;base64,${btoa(ALERT_POINT_ICON_SVG)}`
export const ALERT_POINT_ICON_SIZE = 36

/** platform:map 能力子集（capability client 的 Promise 形态）。 */
export interface AlertMapFocusPort {
  addBillboard (input: PlatformMapBillboardInput): Promise<PlatformMapElementHandle<Partial<PlatformMapBillboardInput>>>;
  recenter (input: { readonly points: readonly GeoPoint[]; readonly padding?: number }): Promise<void>;
}

type BillboardHandle = PlatformMapElementHandle<Partial<PlatformMapBillboardInput>>

/**
 * 列表选中态的地图联动：选中警情时创建原生告警图标（billboard）并回中，
 * 取消/切换/卸载时清理；Map Handle 只留在 Entry Realm，不进 View。
 */
export interface AlertMapFocusController {
  focus (record: AccidentRecord): Promise<void>;
  clear (): void;
}

export function createAlertMapFocusController (map: AlertMapFocusPort | null): AlertMapFocusController {
  let handle: BillboardHandle | null = null
  let generation = 0

  /** 释放是尽力而为：dispose 允许异步，失败不产生未处理拒绝，也不影响后续焦点切换。 */
  function disposeElement (element: BillboardHandle): void {
    void Promise.resolve(element.dispose()).catch(() => {})
  }

  function clear (): void {
    generation += 1
    const current = handle
    handle = null
    if (current) disposeElement(current)
  }

  async function focus (record: AccidentRecord): Promise<void> {
    // 先清除旧焦点再校验坐标：切换到无坐标警情时不能残留上一个告警点。
    clear()
    if (record.latitude === undefined || record.longitude === undefined) return
    if (!map) return
    const position: GeoPoint = { lat: record.latitude, lng: record.longitude, height: record.height }
    const ticket = generation
    try {
      const element = await map.addBillboard({
        position,
        image: ALERT_POINT_ICON_URL,
        width: ALERT_POINT_ICON_SIZE,
        height: ALERT_POINT_ICON_SIZE,
        // 与宿主告警终点一致：无高度（height=0）时贴地，避免地形/视角下悬空或漂移。
        clampToGround: !record.height,
      })
      // 异步竞态：创建完成前焦点已切换/清除 → 立即清理
      if (ticket !== generation) {
        disposeElement(element)
        return
      }
      handle = element
      await map.recenter({ points: [position], padding: 48 })
    } catch {
      // 地图能力异常不影响列表选中态本身
    }
  }

  return { focus, clear }
}
