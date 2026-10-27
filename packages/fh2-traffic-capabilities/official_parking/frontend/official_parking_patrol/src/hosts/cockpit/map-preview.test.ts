// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import { type MapPreviewPort, createMapPreviewController } from './map-preview'

interface FakeElement {
  id: string;
  disposed: boolean;
  update: ReturnType<typeof vi.fn>;
  dispose (): void;
}

function createFakeMap () {
  const elements: FakeElement[] = []
  const map: MapPreviewPort = {
    addBillboard: vi.fn(async () => {
      const element: FakeElement = {
        id: `billboard-${elements.length + 1}`,
        disposed: false,
        update: vi.fn(),
        dispose: () => {
          element.disposed = true
        },
      }
      elements.push(element)
      return element
    }),
    recenter: vi.fn(async () => {}),
  }
  return { map, elements }
}

describe('map-preview 地图联动', () => {
  it('show 创建图钉并定位视口，clear 清理', async () => {
    const { map, elements } = createFakeMap()
    const controller = createMapPreviewController(map, url => `icon(${url})`)
    await controller.show({ thumbUrl: 'thumb-1', longitude: 113.95, latitude: 22.53, height: 90 })
    expect(map.addBillboard).toHaveBeenCalledWith({
      position: { lng: 113.95, lat: 22.53, height: 90 },
      image: 'icon(thumb-1)',
      width: 48,
      height: 54,
    })
    expect(map.recenter).toHaveBeenCalledWith({ points: [{ lng: 113.95, lat: 22.53, height: 90 }] })

    controller.clear()
    expect(elements[0]?.disposed).toBe(true)
  })

  it('切换目标：旧图钉先清理，只保留最新', async () => {
    const { map, elements } = createFakeMap()
    const controller = createMapPreviewController(map, () => 'icon')
    await controller.show({ thumbUrl: 'a', longitude: 1, latitude: 1, height: 0 })
    await controller.show({ thumbUrl: 'b', longitude: 2, latitude: 2, height: 0 })
    expect(elements).toHaveLength(2)
    expect(elements[0]?.disposed).toBe(true)
    expect(elements[1]?.disposed).toBe(false)
  })

  it('异步竞态：创建完成前已 clear → 立即销毁不泄漏', async () => {
    const { map, elements } = createFakeMap()
    const controller = createMapPreviewController(map, () => 'icon')
    const showing = controller.show({ thumbUrl: 'a', longitude: 1, latitude: 1, height: 0 })
    controller.clear()
    await showing
    expect(elements).toHaveLength(1)
    expect(elements[0]?.disposed).toBe(true)
    expect(map.recenter).not.toHaveBeenCalled()
  })

  it('无效坐标 / 无地图能力：安全跳过', async () => {
    const { map } = createFakeMap()
    const controller = createMapPreviewController(map, () => 'icon')
    await controller.show({ thumbUrl: 'a', longitude: Number.NaN, latitude: 22.53, height: 0 })
    expect(map.addBillboard).not.toHaveBeenCalled()

    const noMap = createMapPreviewController(null, () => 'icon')
    await expect(noMap.show({ thumbUrl: 'a', longitude: 1, latitude: 1, height: 0 })).resolves.toBeUndefined()
  })
})
