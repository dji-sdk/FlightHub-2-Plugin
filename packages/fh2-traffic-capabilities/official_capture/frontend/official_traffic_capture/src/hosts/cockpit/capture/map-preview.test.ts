// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMapPreviewController } from './map-preview'
import type { MapPreviewInput, MapPreviewPort } from './map-preview'

const baseInput: MapPreviewInput = {
  thumbUrl: 'blob:photo',
  longitude: 113,
  latitude: 23,
  height: 0,
  accent: 'lane-change',
}

function fakeElement (id: string) {
  return { id, dispose: vi.fn(), update: vi.fn(async () => {}) }
}

function pngResponse (bytes: readonly number[]) {
  return { blob: async () => new Blob([new Uint8Array(bytes)], { type: 'image/png' }) }
}

function failingFetch () {
  return vi.fn(async () => {
    throw new TypeError('fetch failed')
  })
}

function billboardImage (map: MapPreviewPort): string {
  const calls = vi.mocked(map.addBillboard).mock.calls
  return calls[calls.length - 1]?.[0]?.image ?? ''
}

describe('map preview controller', () => {
  beforeEach(() => {
    // 默认 fetch 失败（blob: 转换降级占位图）；需要成功路径的用例自行重新 stub
    vi.stubGlobal('fetch', failingFetch())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('相同输入重复 show 幂等：不清理、不重建、不重定位', async () => {
    const element = fakeElement('marker-1')
    const map: MapPreviewPort = {
      addBillboard: vi.fn(async () => element),
      recenter: vi.fn(async () => {}),
    }
    const controller = createMapPreviewController(map)

    await controller.show(baseInput)
    await controller.show(baseInput)

    expect(map.addBillboard).toHaveBeenCalledOnce()
    expect(map.recenter).toHaveBeenCalledOnce()
    expect(element.dispose).not.toHaveBeenCalled()
  })

  it('创建进行中收到相同输入不触发第二次创建', async () => {
    const element = fakeElement('marker-1')
    let release: ((value: typeof element) => void) | undefined
    const pending = new Promise<typeof element>((resolve) => {
      release = resolve
    })
    const map: MapPreviewPort = {
      addBillboard: vi.fn(() => pending),
      recenter: vi.fn(async () => {}),
    }
    const controller = createMapPreviewController(map)

    const showing = controller.show(baseInput)
    await controller.show(baseInput)
    release!(element)
    await showing

    expect(map.addBillboard).toHaveBeenCalledOnce()
    expect(element.dispose).not.toHaveBeenCalled()
    expect(map.recenter).toHaveBeenCalledOnce()
  })

  it('输入变化时清理旧图元并创建新图元', async () => {
    const first = fakeElement('marker-1')
    const second = fakeElement('marker-2')
    const elements = [first, second]
    const map: MapPreviewPort = {
      addBillboard: vi.fn(async () => elements.shift()!),
      recenter: vi.fn(async () => {}),
    }
    const controller = createMapPreviewController(map)

    await controller.show(baseInput)
    await controller.show({ ...baseInput, thumbUrl: 'blob:other' })

    expect(first.dispose).toHaveBeenCalledOnce()
    expect(map.addBillboard).toHaveBeenCalledTimes(2)
    expect(second.dispose).not.toHaveBeenCalled()
    expect(map.recenter).toHaveBeenCalledTimes(2)
  })

  it('clear 清理当前图元，随后相同输入会重建', async () => {
    const element = fakeElement('marker-1')
    const map: MapPreviewPort = {
      addBillboard: vi.fn(async () => element),
      recenter: vi.fn(async () => {}),
    }
    const controller = createMapPreviewController(map)

    await controller.show(baseInput)
    controller.clear()
    expect(element.dispose).toHaveBeenCalledOnce()

    await controller.show(baseInput)
    expect(map.addBillboard).toHaveBeenCalledTimes(2)
    expect(map.recenter).toHaveBeenCalledTimes(2)
  })

  it('创建失败后复位输入，相同输入可重试', async () => {
    const element = fakeElement('marker-1')
    let calls = 0
    const map: MapPreviewPort = {
      addBillboard: vi.fn(async () => {
        calls += 1
        if (calls === 1) throw new Error('map unavailable')
        return element
      }),
      recenter: vi.fn(async () => {}),
    }
    const controller = createMapPreviewController(map)

    await controller.show(baseInput)
    await controller.show(baseInput)

    expect(map.addBillboard).toHaveBeenCalledTimes(2)
    expect(element.dispose).not.toHaveBeenCalled()
    expect(map.recenter).toHaveBeenCalledOnce()
  })

  it('无效坐标不创建图元', async () => {
    const map: MapPreviewPort = {
      addBillboard: vi.fn(async () => fakeElement('marker-1')),
      recenter: vi.fn(async () => {}),
    }
    const controller = createMapPreviewController(map)

    await controller.show({ ...baseInput, longitude: Number.NaN })

    expect(map.addBillboard).not.toHaveBeenCalled()
  })

  it('blob: 缩略图转换为嵌套 data: URL 再创建 billboard', async () => {
    const element = fakeElement('marker-1')
    const map: MapPreviewPort = {
      addBillboard: vi.fn(async () => element),
      recenter: vi.fn(async () => {}),
    }
    const fetchMock = vi.fn(async () => pngResponse([1, 2, 3]))
    vi.stubGlobal('fetch', fetchMock)
    const controller = createMapPreviewController(map)

    await controller.show(baseInput)

    expect(fetchMock).toHaveBeenCalledWith('blob:photo')
    expect(decodeURIComponent(billboardImage(map))).toContain('href="data:image/png;base64,AQID"')
    expect(decodeURIComponent(billboardImage(map))).not.toContain('blob:')
    expect(map.recenter).toHaveBeenCalledOnce()
  })

  it('data: 缩略图原样嵌入，不触发 fetch', async () => {
    const element = fakeElement('marker-1')
    const map: MapPreviewPort = {
      addBillboard: vi.fn(async () => element),
      recenter: vi.fn(async () => {}),
    }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = createMapPreviewController(map)

    await controller.show({ ...baseInput, thumbUrl: 'data:image/png;base64,BBBB' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(decodeURIComponent(billboardImage(map))).toContain('href="data:image/png;base64,BBBB"')
  })

  it('http(s) 缩略图原样透传，不触发 fetch', async () => {
    const element = fakeElement('marker-1')
    const map: MapPreviewPort = {
      addBillboard: vi.fn(async () => element),
      recenter: vi.fn(async () => {}),
    }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = createMapPreviewController(map)

    await controller.show({ ...baseInput, thumbUrl: 'https://example.com/photo.png' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(decodeURIComponent(billboardImage(map))).toContain('href="https://example.com/photo.png"')
  })

  it('blob: 转换失败降级占位图，仍创建图元', async () => {
    const element = fakeElement('marker-1')
    const map: MapPreviewPort = {
      addBillboard: vi.fn(async () => element),
      recenter: vi.fn(async () => {}),
    }
    vi.stubGlobal('fetch', failingFetch())
    const controller = createMapPreviewController(map)

    await controller.show(baseInput)

    expect(map.addBillboard).toHaveBeenCalledOnce()
    expect(decodeURIComponent(billboardImage(map))).toContain('<rect x="8"')
    expect(decodeURIComponent(billboardImage(map))).not.toContain('<image href')
    expect(element.dispose).not.toHaveBeenCalled()
  })

  it('转换期间 clear：迟到转换不创建图元', async () => {
    const element = fakeElement('marker-1')
    const map: MapPreviewPort = {
      addBillboard: vi.fn(async () => element),
      recenter: vi.fn(async () => {}),
    }
    let releaseFetch: ((response: unknown) => void) | undefined
    const pending = new Promise<unknown>((resolve) => {
      releaseFetch = resolve
    })
    vi.stubGlobal('fetch', vi.fn(() => pending))
    const controller = createMapPreviewController(map)

    const showing = controller.show(baseInput)
    controller.clear()
    releaseFetch!(pngResponse([1, 2, 3]))
    await showing

    expect(map.addBillboard).not.toHaveBeenCalled()
    expect(map.recenter).not.toHaveBeenCalled()
  })

  it('相同 blob: URL 二次 show 复用转换缓存', async () => {
    const element = fakeElement('marker-1')
    const map: MapPreviewPort = {
      addBillboard: vi.fn(async () => element),
      recenter: vi.fn(async () => {}),
    }
    const fetchMock = vi.fn(async () => pngResponse([1, 2, 3]))
    vi.stubGlobal('fetch', fetchMock)
    const controller = createMapPreviewController(map)

    await controller.show(baseInput)
    controller.clear()
    await controller.show(baseInput)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(map.addBillboard).toHaveBeenCalledTimes(2)
    expect(decodeURIComponent(billboardImage(map))).toContain('href="data:image/png;base64,AQID"')
  })
})
