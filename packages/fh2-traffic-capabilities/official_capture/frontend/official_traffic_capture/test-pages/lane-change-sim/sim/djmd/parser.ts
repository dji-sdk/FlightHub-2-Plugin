// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * DJI 机载录像 djmd 数据轨解析（移植自 post-process-demo djmd_parser.py）。
 *
 * 数据轨经 `ffmpeg -map 0:d:0 -c copy -f data` 抽出，整体是一段 protobuf：
 * 顶层 field 3 重复携带帧包；帧包 field 1 为 ai_timestamp_ms、field 2 为
 * device_info；device_info field 13 再嵌套 obj 列表（field 6），obj 的
 * cx/cy/w/h（field 4-7）为万分比 fixed32，distance_mm 为 field 8。
 */

export interface DjmdDetection {
  readonly objId: number;
  readonly objType: number | string;
  readonly objState: number;
  /** 万分比坐标，/10000 后为录像画面归一化坐标。 */
  readonly cx: number;
  readonly cy: number;
  readonly w: number;
  readonly h: number;
  readonly distanceMm: number;
}

export interface DjmdFrame {
  readonly frameIndex: number;
  readonly aiTimestampMs: number;
  /** field13 存在才表示一次 AI 检测回调；普通视频元数据包不能送入 detector。 */
  readonly hasDetectionPayload?: boolean;
  readonly detections: readonly DjmdDetection[];
}

export interface ParsedDjmd {
  readonly frames: readonly DjmdFrame[];
  readonly framesWithDetections: number;
  readonly totalDetections: number;
  readonly uniqueObjIds: number;
}

type FieldValue =
  | { readonly wire: 'varint'; readonly value: number }
  | { readonly wire: 'bytes'; readonly value: Uint8Array }
  | { readonly wire: 'fixed32'; readonly uint: number; readonly float: number }
  | { readonly wire: 'fixed64'; readonly double: number; readonly biguint: bigint }

type Fields = Map<number, FieldValue[]>

function readVarint (buf: Uint8Array, pos: number): { value: number; pos: number } | null {
  let result = 0
  let shift = 0
  while (pos < buf.length) {
    const byte = buf[pos]!
    result += (byte & 0x7F) * 2 ** shift
    pos += 1
    if (!(byte & 0x80)) return { value: result, pos }
    shift += 7
    if (shift > 63) return null
  }
  return null
}

function decodeFields (buf: Uint8Array, start = 0, end = buf.length): Fields {
  const fields: Fields = new Map()
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const append = (fieldNum: number, entry: FieldValue) => {
    const list = fields.get(fieldNum)
    if (list) list.push(entry)
    else fields.set(fieldNum, [entry])
  }
  let pos = start
  while (pos < end) {
    const tag = readVarint(buf, pos)
    if (!tag) break
    pos = tag.pos
    const fieldNum = Math.floor(tag.value / 8)
    const wireType = tag.value % 8
    if (wireType === 0) {
      const value = readVarint(buf, pos)
      if (!value) break
      pos = value.pos
      append(fieldNum, { wire: 'varint', value: value.value })
    } else if (wireType === 2) {
      const length = readVarint(buf, pos)
      if (!length) break
      pos = length.pos
      if (pos + length.value > end) break
      append(fieldNum, { wire: 'bytes', value: buf.subarray(pos, pos + length.value) })
      pos += length.value
    } else if (wireType === 5) {
      if (pos + 4 > end) break
      append(fieldNum, { wire: 'fixed32', uint: view.getUint32(pos, true), float: view.getFloat32(pos, true) })
      pos += 4
    } else if (wireType === 1) {
      if (pos + 8 > end) break
      append(fieldNum, { wire: 'fixed64', double: view.getFloat64(pos, true), biguint: view.getBigUint64(pos, true) })
      pos += 8
    } else {
      break
    }
  }
  return fields
}

/** obj 数值字段：varint 直接取值，fixed32 取 uint 解释，fixed64 取 uint64 解释。 */
function objNumericValue (fields: Fields, fieldNum: number): number {
  const entry = fields.get(fieldNum)?.[0]
  if (!entry) return 0
  if (entry.wire === 'varint') return entry.value
  if (entry.wire === 'fixed32') return entry.uint
  if (entry.wire === 'fixed64') return Number(entry.biguint)
  return 0
}

function objTypeValue (fields: Fields): number | string {
  const entry = fields.get(2)?.[0]
  if (!entry) return 'unknown'
  if (entry.wire === 'bytes') return new TextDecoder().decode(entry.value)
  if (entry.wire === 'varint') return entry.value
  if (entry.wire === 'fixed32') return entry.uint
  if (entry.wire === 'fixed64') return Number(entry.biguint)
  return 'unknown'
}

function firstBytes (fields: Fields, fieldNum: number): Uint8Array | null {
  const entry = fields.get(fieldNum)?.[0]
  return entry && entry.wire === 'bytes' ? entry.value : null
}

function parseFramePacket (packet: Uint8Array): { aiTimestampMs: number; hasDetectionPayload: boolean; detections: DjmdDetection[] } {
  const inner = decodeFields(packet)
  const timestamp = inner.get(1)?.[0]
  const aiTimestampMs = timestamp && timestamp.wire === 'varint' ? timestamp.value : 0

  const detections: DjmdDetection[] = []
  const deviceInfo = firstBytes(inner, 2)
  const vm13 = deviceInfo ? firstBytes(decodeFields(deviceInfo), 13) : null
  if (vm13) {
    for (const entry of decodeFields(vm13).get(6) ?? []) {
      if (entry.wire !== 'bytes') continue
      const obj = decodeFields(entry.value)
      detections.push({
        objId: objNumericValue(obj, 1),
        objType: objTypeValue(obj),
        objState: objNumericValue(obj, 3),
        cx: objNumericValue(obj, 4),
        cy: objNumericValue(obj, 5),
        w: objNumericValue(obj, 6),
        h: objNumericValue(obj, 7),
        distanceMm: objNumericValue(obj, 8),
      })
    }
  }
  return { aiTimestampMs, hasDetectionPayload: vm13 !== null, detections }
}

export function parseDjmd (data: Uint8Array): ParsedDjmd {
  const frames: DjmdFrame[] = []
  let framesWithDetections = 0
  let totalDetections = 0
  const objIds = new Set<number>()

  let frameIndex = 0
  for (const entry of decodeFields(data).get(3) ?? []) {
    if (entry.wire !== 'bytes') continue
    const parsed = parseFramePacket(entry.value)
    if (parsed.detections.length > 0) framesWithDetections += 1
    totalDetections += parsed.detections.length
    for (const det of parsed.detections) objIds.add(det.objId)
    frames.push({
      frameIndex,
      aiTimestampMs: parsed.aiTimestampMs,
      hasDetectionPayload: parsed.hasDetectionPayload,
      detections: parsed.detections,
    })
    frameIndex += 1
  }

  return { frames, framesWithDetections, totalDetections, uniqueObjIds: objIds.size }
}
