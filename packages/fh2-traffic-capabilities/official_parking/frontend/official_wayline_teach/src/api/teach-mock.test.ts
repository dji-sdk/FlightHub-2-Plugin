// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it, vi } from 'vitest'
import { createTeachApi } from './teach-api'
import { createTeachTransport } from './teach-mock'

describe('示教内存 Mock', () => {
  it('使用临时 STS 完成截图上传与绑定', async () => {
    const transport = createTeachTransport({
      apiCall: vi.fn(),
      objectUpload: { upload: vi.fn() },
      enableMock: true,
    })
    const api = createTeachApi(transport.apiCall)
    const route = await api.enter({
      projectId: 'project-1',
      flightId: 'flight-1',
      dockSn: 'dock-1',
      droneSn: 'drone-1',
    })
    const waypoint = await api.appendWaypoint(route.id, {
      longitude: 113.9,
      latitude: 22.5,
      height: 171.6,
      cameraYaw: -20,
      gimbalPitch: -30,
      focalLength: 24,
      aiRecognitionOn: true,
      aiTargetTypes: ['car'],
    })
    const otherWaypoint = await api.appendWaypoint(route.id, {
      longitude: 114,
      latitude: 22.6,
      height: 180,
      cameraYaw: -10,
      gimbalPitch: -20,
      focalLength: 24,
      aiRecognitionOn: false,
      aiTargetTypes: [],
    })

    const target = await api.createScreenshotUpload(route.id, waypoint.id)
    expect(target).toMatchObject({
      endpoint: 'https://mock-object-storage.invalid',
      bucket: 'fh2-plugin-mock',
      objectKey: expect.stringContaining(`/wp_${waypoint.id}_`),
      accessKeyId: 'mock-access-key',
    })
    const blob = new Blob(['frame'], { type: 'image/jpeg' })
    await expect(transport.objectUpload.upload({ ...target, blob }))
      .resolves.toMatchObject({ etag: expect.stringMatching(/^mock-/) })
    await expect(transport.objectUpload.upload({ ...target, blob }))
      .rejects.toThrow('已上传')
    await expect(api.attachScreenshot(otherWaypoint.id, {
      objectKey: target.objectKey,
      bytes: blob.size,
    })).rejects.toThrow('截图元信息非法')
    await expect(api.attachScreenshot(waypoint.id, {
      objectKey: target.objectKey,
      bytes: blob.size,
    })).resolves.toEqual({ screenshotFileId: null, screenshotUrl: null })

    transport.dispose()
  })
})
