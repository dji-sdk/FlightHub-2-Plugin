// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 正交折线 → 圆角 SVG path（Plan §4.5）。
 *
 * 直线用 `L`；拐角前后各截取 `min(CORNER_RADIUS, 前后段长度/2)`，用二次
 * 贝塞尔 `Q` 抹圆。曲线只存在于拐角局部，不跨越整个层间区域。
 * 箭头尖端位于 target 顶边端口：path 末端即端口点，marker 挂在线端。
 */

import { RANK_EPSILON } from './ranks.js'

export const CORNER_RADIUS = 7

/**
 * 折线 → SVG path 字符串。
 * 输入必须已是正交折线（相邻点共轴）；共线相邻点应已由路由器合并。
 */
export function orthogonalPath (points: readonly (readonly [number, number])[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) {
    const [x, y] = points[0]!
    return `M ${x} ${y}`
  }

  let d = `M ${points[0]![0]} ${points[0]![1]}`
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]!
    const current = points[i]!
    const next = points[i + 1]

    if (next === undefined) {
      d += ` L ${current[0]} ${current[1]}`
      continue
    }
    // 退化保护：与下一点重合/共轴时按直线走
    if (samePoint(prev, current) || samePoint(current, next) || collinear(prev, current, next)) {
      d += ` L ${current[0]} ${current[1]}`
      continue
    }
    // 拐角：prev→current 与 current→next 各截取 corner 截距
    const radius = Math.min(
      CORNER_RADIUS,
      segmentLength(prev, current) / 2,
      segmentLength(current, next) / 2,
    )
    const before = approachPoint(current, prev, radius)
    const after = approachPoint(current, next, radius)
    d += ` L ${before[0]} ${before[1]}`
    d += ` Q ${current[0]} ${current[1]} ${after[0]} ${after[1]}`
  }
  return d
}

/**
 * 连线预览的正交两折线路径（Plan §5.3）：起点 → 中途水平通道 → 指针点。
 * 不再使用单条对角线。
 */
export function previewPath (
  from: readonly [number, number],
  to: readonly [number, number],
): string {
  const channelY = (from[1] + to[1]) / 2
  const points: Array<readonly [number, number]> = [from, [from[0], channelY], [to[0], channelY], to]
  return orthogonalPath(dedupePoints(points))
}

function approachPoint (
  corner: readonly [number, number],
  toward: readonly [number, number],
  distance: number,
): readonly [number, number] {
  const dx = toward[0] - corner[0]
  const dy = toward[1] - corner[1]
  const length = Math.hypot(dx, dy)
  if (length === 0) return corner
  return [
    corner[0] + (dx / length) * distance,
    corner[1] + (dy / length) * distance,
  ]
}

function segmentLength (a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

function samePoint (a: readonly [number, number], b: readonly [number, number]): boolean {
  return Math.abs(a[0] - b[0]) <= RANK_EPSILON && Math.abs(a[1] - b[1]) <= RANK_EPSILON
}

function collinear (
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
): boolean {
  const sameX = Math.abs(a[0] - b[0]) <= RANK_EPSILON && Math.abs(b[0] - c[0]) <= RANK_EPSILON
  const sameY = Math.abs(a[1] - b[1]) <= RANK_EPSILON && Math.abs(b[1] - c[1]) <= RANK_EPSILON
  return sameX || sameY
}

function dedupePoints (points: readonly (readonly [number, number])[]): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = []
  for (const point of points) {
    if (out.length > 0 && samePoint(out[out.length - 1]!, point)) continue
    out.push(point)
  }
  return out
}
