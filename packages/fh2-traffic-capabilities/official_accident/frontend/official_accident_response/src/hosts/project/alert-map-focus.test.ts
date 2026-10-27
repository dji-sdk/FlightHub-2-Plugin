// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { AccidentRecord } from '../../workflow/types'
import {
  ALERT_POINT_ICON_SIZE,
  ALERT_POINT_ICON_SVG,
  ALERT_POINT_ICON_URL,
  createAlertMapFocusController,
} from './alert-map-focus'
import type { AlertMapFocusPort } from './alert-map-focus'

const BASE_RECORD: AccidentRecord = {
  pluginEventId: 'incident-1',
  title: '测试事故',
  createdAt: 1,
  status: 'unacknowledged',
  priority: 'high',
  address: '福田测试路口',
  latitude: 22.5431,
  longitude: 114.0579,
  height: 0,
  rawPayload: {},
  result: null,
}

function record (options: { pluginEventId?: string; omitCoordinates?: boolean } = {}): AccidentRecord {
  const merged: AccidentRecord = {
    ...BASE_RECORD,
    ...(options.pluginEventId !== undefined ? { pluginEventId: options.pluginEventId } : {}),
  }
  if (!options.omitCoordinates) return merged
  const { latitude: _latitude, longitude: _longitude, ...rest } = merged
  return rest
}

function mapMock (): AlertMapFocusPort & {
  addBillboard: ReturnType<typeof vi.fn>;
  recenter: ReturnType<typeof vi.fn>;
} {
  return {
    addBillboard: vi.fn(async () => ({ id: 'billboard-1', update: vi.fn(), dispose: vi.fn() })),
    recenter: vi.fn(async () => {}),
  }
}

describe('alert map focus', () => {
  it('选中时用原生告警图标创建 billboard 并回中', async () => {
    const map = mapMock()
    const focus = createAlertMapFocusController(map)

    await focus.focus(record())

    expect(map.addBillboard).toHaveBeenCalledWith({
      position: { lat: 22.5431, lng: 114.0579, height: 0 },
      image: ALERT_POINT_ICON_URL,
      width: ALERT_POINT_ICON_SIZE,
      height: ALERT_POINT_ICON_SIZE,
      clampToGround: true,
    })
    expect(map.recenter).toHaveBeenCalledWith({
      points: [{ lat: 22.5431, lng: 114.0579, height: 0 }],
      padding: 48,
    })
  })

  it('警情带高度时不贴地，按绝对高度渲染', async () => {
    const map = mapMock()
    const focus = createAlertMapFocusController(map)

    await focus.focus({ ...record(), height: 30 })

    expect(map.addBillboard).toHaveBeenCalledWith(expect.objectContaining({
      position: { lat: 22.5431, lng: 114.0579, height: 30 },
      clampToGround: false,
    }))
  })

  it('告警点图标是 data URL 且为原生告警点样式', () => {
    expect(ALERT_POINT_ICON_URL).toMatch(/^data:image\/svg\+xml;base64,/)
    const svg = atob(ALERT_POINT_ICON_URL.slice(ALERT_POINT_ICON_URL.indexOf(',') + 1))
    expect(svg).toBe(ALERT_POINT_ICON_SVG)
    expect(svg).toContain('width="56" height="56"')
    expect(svg).toContain('fill="#E70102"')
    expect(svg).toContain('fill="#FFFFFF"')
  })

  it('缺少经纬度时不创建告警点也不回中', async () => {
    const map = mapMock()
    const focus = createAlertMapFocusController(map)

    await focus.focus(record({ omitCoordinates: true }))

    expect(map.addBillboard).not.toHaveBeenCalled()
    expect(map.recenter).not.toHaveBeenCalled()
  })

  it('切换到无坐标警情时清除旧告警点且不创建新点', async () => {
    const map = mapMock()
    const first = { id: 'billboard-1', update: vi.fn(), dispose: vi.fn() }
    map.addBillboard.mockResolvedValueOnce(first)
    const focus = createAlertMapFocusController(map)

    await focus.focus(record())
    await focus.focus(record({ omitCoordinates: true }))

    expect(first.dispose).toHaveBeenCalledOnce()
    expect(map.addBillboard).toHaveBeenCalledTimes(1)
    expect(map.recenter).toHaveBeenCalledTimes(1)
  })

  it('异步 dispose 失败被吞掉，不产生未处理拒绝', async () => {
    // 注意：dispose 不能用 vi.fn 包装——vi.fn 内部会附加 then 处理器，
    // 让 rejected Promise 永远不会触发 unhandledRejection，测试会退化为恒真。
    let disposeCalls = 0
    const billboard = {
      id: 'billboard-1',
      update: vi.fn(),
      dispose: (): Promise<void> => {
        disposeCalls += 1
        return Promise.reject(new Error('map gone'))
      },
    }
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const map = mapMock()
      map.addBillboard.mockResolvedValueOnce(billboard)
      const focus = createAlertMapFocusController(map)

      await focus.focus(record())
      focus.clear()
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(disposeCalls).toBe(1)
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('地图能力缺失时 no-op 不抛错', async () => {
    const focus = createAlertMapFocusController(null)
    await expect(focus.focus(record())).resolves.toBeUndefined()
  })

  it('切换焦点时清除旧告警点', async () => {
    const map = mapMock()
    const first = { id: 'billboard-1', update: vi.fn(), dispose: vi.fn() }
    map.addBillboard.mockResolvedValueOnce(first)
    const focus = createAlertMapFocusController(map)

    await focus.focus(record())
    await focus.focus(record({ pluginEventId: 'incident-2' }))

    expect(first.dispose).toHaveBeenCalledOnce()
    expect(map.addBillboard).toHaveBeenCalledTimes(2)
  })

  it('创建完成前已清除时迟到告警点立即释放且不回中', async () => {
    const map = mapMock()
    const lateBillboard = { id: 'billboard-late', dispose: vi.fn() }
    let releaseBillboard!: (element: { id: string; dispose: () => void }) => void
    map.addBillboard.mockImplementationOnce(() => new Promise((resolve) => {
      releaseBillboard = resolve
    }))
    const focus = createAlertMapFocusController(map)

    const pending = focus.focus(record())
    focus.clear()
    releaseBillboard(lateBillboard)
    await pending

    expect(lateBillboard.dispose).toHaveBeenCalledOnce()
    expect(map.recenter).not.toHaveBeenCalled()
  })

  it('clear 释放当前告警点', async () => {
    const map = mapMock()
    const billboard = { id: 'billboard-1', update: vi.fn(), dispose: vi.fn() }
    map.addBillboard.mockResolvedValueOnce(billboard)
    const focus = createAlertMapFocusController(map)

    await focus.focus(record())
    focus.clear()

    expect(billboard.dispose).toHaveBeenCalledOnce()
  })
})
