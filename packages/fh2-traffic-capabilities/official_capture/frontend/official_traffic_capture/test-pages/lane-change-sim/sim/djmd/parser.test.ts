// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { type DjmdDetection, parseDjmd } from './parser'

/** protobuf 编码工具：构造与 DJI djmd 同构的字节流。 */
function encodeVarint (value: number): number[] {
  const bytes: number[] = []
  let v = value
  while (v > 0x7F) {
    bytes.push((v & 0x7F) | 0x80)
    v = Math.floor(v / 128)
  }
  bytes.push(v)
  return bytes
}

function varintField (fieldNum: number, value: number): number[] {
  return [...encodeVarint(fieldNum * 8), ...encodeVarint(value)]
}

function fixed32Field (fieldNum: number, uint: number): number[] {
  const view = new DataView(new ArrayBuffer(4))
  view.setUint32(0, uint, true)
  return [fieldNum * 8 + 5, ...new Uint8Array(view.buffer)]
}

function bytesField (fieldNum: number, payload: number[]): number[] {
  return [...encodeVarint(fieldNum * 8 + 2), ...encodeVarint(payload.length), ...payload]
}

function objBytes (det: DjmdDetection): number[] {
  const typeField = typeof det.objType === 'string'
    ? bytesField(2, [...new TextEncoder().encode(det.objType)])
    : varintField(2, det.objType)
  return [
    ...varintField(1, det.objId),
    ...typeField,
    ...varintField(3, det.objState),
    ...fixed32Field(4, det.cx),
    ...fixed32Field(5, det.cy),
    ...fixed32Field(6, det.w),
    ...fixed32Field(7, det.h),
    ...varintField(8, det.distanceMm),
  ]
}

function framePacket (aiTimestampMs: number, detections: DjmdDetection[], hasDetectionPayload = true): number[] {
  if (!hasDetectionPayload) return [...varintField(1, aiTimestampMs), ...bytesField(2, [])]
  const vm13 = detections.map(det => bytesField(6, objBytes(det))).flat()
  return [...varintField(1, aiTimestampMs), ...bytesField(2, bytesField(13, vm13))]
}

const DET: DjmdDetection = {
  objId: 19,
  objType: 0,
  objState: 1,
  cx: 4400,
  cy: 5000,
  w: 600,
  h: 800,
  distanceMm: 20000,
}

describe('parseDjmd', () => {
  it('解析顶层 field 3 帧包与嵌套 obj 字段（fixed32 万分比）', () => {
    const data = new Uint8Array([
      ...bytesField(3, framePacket(1000, [DET, { ...DET, objId: 25 }])),
      ...bytesField(3, framePacket(1100, [DET])),
    ].flat())

    const parsed = parseDjmd(data)
    expect(parsed.frames).toHaveLength(2)
    expect(parsed.totalDetections).toBe(3)
    expect(parsed.uniqueObjIds).toBe(2)

    const det = parsed.frames[0]!.detections[0]!
    expect(det.objId).toBe(19)
    expect(det.objType).toBe(0)
    expect(det.cx).toBe(4400)
    expect(det.w).toBe(600)
    expect(det.distanceMm).toBe(20000)
    expect(parsed.frames[1]!.aiTimestampMs).toBe(1100)
  })

  it('空数据与截断字节流不抛错', () => {
    expect(parseDjmd(new Uint8Array(0)).frames).toEqual([])

    const full = new Uint8Array([
      ...bytesField(3, framePacket(1, [DET])),
      ...bytesField(3, framePacket(2, [DET])),
    ].flat())
    const truncated = parseDjmd(full.subarray(0, Math.floor(full.length * 0.6)))
    expect(truncated.frames.length).toBeLessThanOrEqual(2)
  })

  it('区分普通视频包、AI 空结果和含目标检测帧，并显式解析 car 类型', () => {
    const car = { ...DET, objType: 'car' as const }
    const data = new Uint8Array([
      ...bytesField(3, framePacket(1000, [], false)),
      ...bytesField(3, framePacket(1033, [])),
      ...bytesField(3, framePacket(1066, [car])),
    ].flat())
    const parsed = parseDjmd(data)
    expect(parsed.frames.map(frame => frame.hasDetectionPayload)).toEqual([false, true, true])
    expect(parsed.frames[2]!.detections[0]!.objType).toBe('car')
  })
})
