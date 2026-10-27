// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
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

const route = {
  id: 'route-1',
  projectId: 'project-1',
  name: '示教航线',
  flightId: 'flight-1',
  createdAt: '2026-09-01T00:00:00Z',
  globalSpeed: 15,
  waypointSpeed: 5,
  screenshotBytes: 1024,
  waylineUuid: null,
  waylineFileId: null,
  kmzObjectKey: null,
  waypointCount: 2,
  waypoints: [
    {
      id: 'point-1',
      seq: 0,
      selected: true,
      longitude: 113.9,
      latitude: 22.5,
      height: 171.6,
      cameraYaw: -20,
      gimbalPitch: -30,
      focalLength: 24,
      aiRecognitionOn: true,
      aiTargetTypes: ['car'] as const,
      screenshotFileId: 'file-1',
      screenshotUrl: null,
      screenshotBytes: 512,
      screenshotError: null,
    },
    {
      id: 'point-2',
      seq: 1,
      selected: true,
      longitude: 113.91,
      latitude: 22.51,
      height: 172,
      cameraYaw: -22,
      gimbalPitch: -32,
      focalLength: 48,
      aiRecognitionOn: false,
      aiTargetTypes: [] as const,
      screenshotFileId: 'file-2',
      screenshotUrl: null,
      screenshotBytes: 512,
      screenshotError: null,
    },
  ],
} as const

describe('示教状态机', () => {
  it('idle -> recording，并保留后端路线', () => {
    expect(enterRecording(createInitialTeachSession(), route)).toMatchObject({ phase: 'recording', route })
  })

  it('recording -> generating -> generated，生成后清空航点', () => {
    const generating = beginGenerating(enterRecording(createInitialTeachSession(), route))
    const generated = finishGenerating(generating, {
      waylineUuid: 'wayline-1',
      waylineFileId: 'file-1',
      kmzObjectKey: 'teach/route-1.kmz',
    })

    expect(generated.phase).toBe('generated')
    expect(generated.route?.waypoints).toEqual([])
    expect(generated.route?.waypointCount).toBe(2)
  })

  it('generated 是终态，不能重新生成或编辑航点', () => {
    const generated = finishGenerating(
      beginGenerating(enterRecording(createInitialTeachSession(), route)),
      { waylineUuid: 'wayline-1', waylineFileId: 'file-1', kmzObjectKey: null },
    )
    expect(() => beginGenerating(generated)).toThrow('不能生成')
    expect(() => updateTeachRoute(generated, value => value)).toThrow('不能编辑')
  })

  it('生成失败回到 recording，并保留可编辑航点', () => {
    const generating = beginGenerating(enterRecording(createInitialTeachSession(), route))
    const recording = failGenerating(generating)
    expect(recording.phase).toBe('recording')
    expect(recording.route?.waypoints).toEqual(route.waypoints)
  })

  it('少于两个选中航点时禁止生成', () => {
    const recording = enterRecording(createInitialTeachSession(), { ...route, waypoints: [route.waypoints[0]] })
    expect(() => beginGenerating(recording)).toThrow('至少选择两个航点')
  })

  it('status 只恢复 recording，reset 回到 idle', () => {
    expect(restoreTeachSession(route).phase).toBe('recording')
    expect(resetTeachSession(restoreTeachSession(route))).toEqual(createInitialTeachSession())
  })
})
