// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { Point2D } from './detector-core'

export interface BottomEdge {
  readonly left: number;
  readonly right: number;
  readonly y: number;
}

export type Interval = readonly [number, number]
const EPSILON = 1e-10

/** 在给定参数区间内裁剪线性不等式 value(t) >= 0。 */
export function clipLinearInterval (range: Interval, value0: number, value1: number): Interval | null {
  const delta = value1 - value0
  if (Math.abs(delta) < EPSILON) return value0 >= -EPSILON ? range : null
  const root = -value0 / delta
  const lo = delta > 0 ? Math.max(range[0], root) : range[0]
  const hi = delta < 0 ? Math.min(range[1], root) : range[1]
  if (lo > hi + EPSILON) return null
  return [Math.min(lo, hi), hi]
}

export interface BottomEdgeContact {
  /** 两有效帧之间实际接触线段的时间区间，0..1。 */
  readonly time: Interval;
  /** 曾真实接触线段的底边位置区间；u=0 左角，u=1 右角。 */
  readonly positions: Interval;
}

/**
 * 水平底边线性移动/变宽时与有限线段的连续碰撞。底中心复用零宽底边。
 * 非水平标线由 y 求交点，四个线性不等式精确裁剪接触时间；不做离散采样。
 */
export function sweepBottomEdge (
  previous: BottomEdge,
  current: BottomEdge,
  a: Point2D,
  b: Point2D,
): BottomEdgeContact | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.hypot(dx, dy) < EPSILON) return null
  const bottomMove = current.y - previous.y
  const lerp = (from: number, to: number, t: number) => from + (to - from) * t
  const position = (x: number, t: number) => {
    const left = lerp(previous.left, current.left, t)
    const width = lerp(previous.right - previous.left, current.right - current.left, t)
    return width < EPSILON ? 0.5 : Math.max(0, Math.min(1, (x - left) / width))
  }

  if (Math.abs(dy) < EPSILON) {
    const minX = Math.min(a.x, b.x)
    const maxX = Math.max(a.x, b.x)
    let time: Interval = [0, 1]
    if (Math.abs(bottomMove) < EPSILON) {
      if (Math.abs(previous.y - a.y) > EPSILON) return null
    } else {
      const t = (a.y - previous.y) / bottomMove
      if (t < -EPSILON || t > 1 + EPSILON) return null
      time = [Math.max(0, Math.min(1, t)), Math.max(0, Math.min(1, t))]
    }
    const afterLeft = clipLinearInterval(time, previous.right - minX, current.right - minX)
    const overlap = afterLeft && clipLinearInterval(afterLeft, maxX - previous.left, maxX - current.left)
    if (!overlap) return null
    const positions = overlap.flatMap(t => [position(minX, t), position(maxX, t)])
    return { time: overlap, positions: [Math.min(...positions), Math.max(...positions)] }
  }

  const s0 = (previous.y - a.y) / dy
  const s1 = (current.y - a.y) / dy
  const x0 = a.x + dx * s0
  const x1 = a.x + dx * s1
  let time: Interval | null = [0, 1]
  for (const [value0, value1] of [
    [s0, s1],
    [1 - s0, 1 - s1],
    [x0 - previous.left, x1 - current.left],
    [previous.right - x0, current.right - x1],
  ] as const) {
    time = clipLinearInterval(time, value0, value1)
    if (!time) return null
  }
  // u(t) 为线性/正线性函数，在接触区间内单调，其极值位于两端。
  const u0 = position(lerp(x0, x1, time[0]), time[0])
  const u1 = position(lerp(x0, x1, time[1]), time[1])
  return { time, positions: [Math.min(u0, u1), Math.max(u0, u1)] }
}
