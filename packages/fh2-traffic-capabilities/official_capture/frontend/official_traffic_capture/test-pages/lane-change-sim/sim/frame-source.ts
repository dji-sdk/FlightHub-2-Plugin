// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 合成轨迹数据源：keyframe 插值 → 生产 target 过滤 → CoreBBox。
 *
 * 与参考仓 lane-change-sim 的差异：插件版检测协议 target 为
 * { targetId, type: '3', state: 'tracked', bbox: {x,y,width,height} }（归一化），
 * 因此扰动直接施加在归一化 bbox 上，并复用生产 toCoreBBoxes 过滤契约。
 */
import type { CoreBBox } from '../../../src/hosts/cockpit/lane-change/detector-core'
import { type CarTargetLike, toCoreBBoxes } from '../../../src/hosts/cockpit/lane-change/target-filter'
import type { BBoxTrack, KeyframeBBox, NoiseProfile } from './types'

export interface SimFrameSource {
  getBBoxesAtTime (t: number): CoreBBox[];
  getFrameTimes? (duration?: number): number[];
  /** 录制源的原始检测序号；跳号表示检测输入不连续。 */
  getSequenceAtTime? (t: number): number | null;
  /** 调试开关用：返回未过 type/state 白名单的原始目标。 */
  getRawTargetsAtTime? (t: number): CarTargetLike[];
  /**
   * 画布展示用 bbox；与 getBBoxesAtTime 语义可不同。缺省回退前者。
   */
  getDisplayBBoxesAtTime? (t: number): CoreBBox[];
  /** 同上，对应未过滤原始目标的展示。 */
  getDisplayRawTargetsAtTime? (t: number): CarTargetLike[];
}

function interpolate (v1: number, v2: number, ratio: number) {
  return v1 + (v2 - v1) * ratio
}

function clamp (v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

function hashString (value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function seededRandom (seed: number, key: string): number {
  let x = (seed ^ hashString(key)) >>> 0
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  return ((x >>> 0) % 1000000) / 1000000
}

function seededGaussian (seed: number, key: string): number {
  const u1 = Math.max(seededRandom(seed, `${key}:u1`), 1e-9)
  const u2 = seededRandom(seed, `${key}:u2`)
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

function latestOverride<T> (
  keyframes: readonly { readonly time: number }[],
  t: number,
  key: 'objIdOverride' | 'stateOverride',
): T | undefined {
  let out: T | undefined
  for (const frame of keyframes as readonly KeyframeBBox[]) {
    if (frame.time > t) break
    const value = frame[key]
    if (value !== undefined) out = value as T
  }
  return out
}

/** 合成 CoreBBox 附带的语义状态（不参与 detector 判定，仅用于生产白名单过滤）。 */
export interface SyntheticBBox extends CoreBBox {
  state?: string;
}

export function getBBoxesAtTime (tracks: BBoxTrack[], t: number): SyntheticBBox[] {
  const result: CoreBBox[] = []
  for (const track of tracks) {
    const kf = track.keyframes
    if (kf.length === 0) continue

    if (t < kf[0]!.time) continue

    const last = kf[kf.length - 1]!
    if (t > last.time) continue

    const objId = latestOverride<string | number>(kf, t, 'objIdOverride') ?? track.objId
    const state = latestOverride<string>(kf, t, 'stateOverride')

    let found = false
    for (let i = 0; i < kf.length - 1; i++) {
      const cur = kf[i]!
      const next = kf[i + 1]!
      if (t >= cur.time && t <= next.time) {
        if (cur.present === false || next.present === false) {
          continue
        }
        const span = next.time - cur.time
        const ratio = span === 0 ? 1 : (t - cur.time) / span
        result.push({
          objId,
          rect: {
            x1: interpolate(cur.rect.x1, next.rect.x1, ratio),
            y1: interpolate(cur.rect.y1, next.rect.y1, ratio),
            x2: interpolate(cur.rect.x2, next.rect.x2, ratio),
            y2: interpolate(cur.rect.y2, next.rect.y2, ratio),
          },
          ...(state === undefined ? {} : { state }),
        })
        found = true
        break
      }
    }

    if (!found && t === last.time && last.present !== false) {
      result.push({
        objId,
        rect: { ...last.rect },
        ...(state === undefined ? {} : { state }),
      })
    }
  }

  const uniq = new Map<string | number, SyntheticBBox>()
  for (const bbox of result) {
    uniq.set(bbox.objId, bbox)
  }
  return Array.from(uniq.values())
}

function toSyntheticTarget (bbox: SyntheticBBox): CarTargetLike {
  const width = bbox.rect.x2 - bbox.rect.x1
  const height = bbox.rect.y2 - bbox.rect.y1
  return {
    targetId: bbox.objId,
    type: '3',
    state: bbox.state ?? 'tracked',
    bbox: {
      x: bbox.rect.x1,
      y: bbox.rect.y1,
      width,
      height,
    },
  }
}

function perturbBBox (bbox: SyntheticBBox, t: number, profile: NoiseProfile): SyntheticBBox | null {
  const seed = profile.seed ?? 1
  const id = String(bbox.objId)
  if ((profile.dropoutRate ?? 0) > 0) {
    const dropped = seededRandom(seed, `${id}:${Math.round(t)}:drop`) < (profile.dropoutRate ?? 0)
    if (dropped) return null
  }

  const positionSigma = profile.positionSigma ?? 0
  const sizeSigma = profile.sizeSigma ?? 0
  const cx = (bbox.rect.x1 + bbox.rect.x2) / 2 + seededGaussian(seed, `${id}:${Math.round(t)}:cx`) * positionSigma
  const cy = (bbox.rect.y1 + bbox.rect.y2) / 2 + seededGaussian(seed, `${id}:${Math.round(t)}:cy`) * positionSigma
  const w = (bbox.rect.x2 - bbox.rect.x1) + seededGaussian(seed, `${id}:${Math.round(t)}:w`) * sizeSigma
  const h = (bbox.rect.y2 - bbox.rect.y1) + seededGaussian(seed, `${id}:${Math.round(t)}:h`) * sizeSigma

  return {
    ...bbox,
    rect: {
      x1: clamp(cx - w / 2, 0, 1),
      y1: clamp(cy - h / 2, 0, 1),
      x2: clamp(cx + w / 2, 0, 1),
      y2: clamp(cy + h / 2, 0, 1),
    },
  }
}

export class SyntheticFrameSource implements SimFrameSource {
  public readonly getFrameTimes?: (duration?: number) => number[]

  constructor (
    private readonly tracks: BBoxTrack[],
    private readonly noiseProfile: NoiseProfile | null = null,
    frameTimes?: number[],
    private readonly stateOverride: string | null = null,
  ) {
    if (frameTimes) {
      const sortedFrameTimes = Array.from(new Set(frameTimes)).sort((a, b) => a - b)
      this.getFrameTimes = () => sortedFrameTimes
    }
  }

  getBBoxesAtTime (t: number): CoreBBox[] {
    const bboxes = getBBoxesAtTime(this.tracks, t)
    return bboxes
      .map(bbox => (this.stateOverride !== null ? { ...bbox, state: this.stateOverride } : bbox))
      .map(bbox => (this.noiseProfile ? perturbBBox(bbox, t, this.noiseProfile) : bbox))
      .filter((bbox): bbox is SyntheticBBox => !!bbox)
      .map(toSyntheticTarget)
      .filter(target => target.bbox.width > 0 && target.bbox.height > 0)
      .flatMap(target => toCoreBBoxes([target]))
  }
}
