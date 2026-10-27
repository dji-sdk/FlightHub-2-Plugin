// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import type { PluginLogger } from 'fh2-plugin-sdk'
import { createWaylinePreview } from './wayline-preview'

function previewHandle () {
  return {
    update: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  }
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as PluginLogger

const input = {
  previewId: 'cockpit:return-route',
  routes: [
    { id: 'route-1', label: '路线一', coordinates: [{ lng: 114, lat: 22, height: 0 }] },
    { id: 'route-2', label: '路线二', coordinates: [{ lng: 114.2, lat: 22.2, height: 0 }] },
  ],
  selectedIndex: 0,
  startPosition: { lng: 114, lat: 22, height: 0 },
  destination: { position: { lng: 114.1, lat: 22.1, height: 0 }, kind: 'home' as const },
}

describe('accident platform wayline preview', () => {
  it('只显示选中路线并按 previewId 清理自己的句柄', async () => {
    const first = previewHandle()
    const second = previewHandle()
    const capability = { show: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) }
    const preview = createWaylinePreview(
      capability as unknown as Parameters<typeof createWaylinePreview>[0],
      logger,
    )

    await preview.show(input)
    await preview.show({ ...input, selectedIndex: 1 })

    expect(capability.show).toHaveBeenNthCalledWith(1, {
      points: [{ lng: 114, lat: 22, height: 0 }],
      startPosition: { lng: 114, lat: 22, height: 0 },
      destination: { position: { lng: 114.1, lat: 22.1, height: 0 }, kind: 'home' },
    })
    expect(capability.show).toHaveBeenNthCalledWith(2, expect.objectContaining({ points: input.routes[1]?.coordinates }))
    const firstInput = capability.show.mock.calls[0]?.[0]
    expect(firstInput?.points).not.toBe(input.routes[0]?.coordinates)
    expect(firstInput?.startPosition).not.toBe(input.startPosition)
    expect(firstInput?.destination).not.toBe(input.destination)
    expect(first.dispose).toHaveBeenCalledOnce()
    await preview.clear(input.previewId)
    expect(second.dispose).toHaveBeenCalledOnce()
  })

  it('并发 show 只保留同 owner 的最后一次预览', async () => {
    const stale = previewHandle()
    const latest = previewHandle()
    let release!: (handle: ReturnType<typeof previewHandle>) => void
    const firstShow = new Promise<ReturnType<typeof previewHandle>>((resolve) => {
      release = resolve
    })
    const capability = { show: vi.fn().mockReturnValueOnce(firstShow).mockResolvedValueOnce(latest) }
    const preview = createWaylinePreview(
      capability as unknown as Parameters<typeof createWaylinePreview>[0],
      logger,
    )

    const firstResult = preview.show(input)
    await preview.show(input)
    release(stale)
    await firstResult

    expect(stale.dispose).toHaveBeenCalledOnce()
    expect(latest.dispose).not.toHaveBeenCalled()
  })

  it('宿主未提供预览能力时保持 no-op', async () => {
    const preview = createWaylinePreview(undefined, logger)
    await expect(preview.show(input)).resolves.toBeUndefined()
    await expect(preview.clear(input.previewId)).resolves.toBeUndefined()
  })

  it('宿主修改预览输入时不污染派遣卡片路线状态', async () => {
    const handle = previewHandle()
    const capability = {
      show: vi.fn(async (previewInput: { points: Array<{ lng: number; lat: number; height: number }> }) => {
        previewInput.points[0]!.lng = 0
        return handle
      }),
    }
    const preview = createWaylinePreview(
      capability as unknown as Parameters<typeof createWaylinePreview>[0],
      logger,
    )

    await preview.show(input)

    expect(input.routes[0]?.coordinates?.[0]?.lng).toBe(114)
  })
})
