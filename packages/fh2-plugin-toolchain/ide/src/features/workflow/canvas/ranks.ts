// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 层级（Rank）与层间通道带（RoutingBand）的几何（Plan §2.3）。
 *
 * d3-dag 继续负责分层、同层顺序与节点中心坐标；本模块把 y 坐标聚类成
 * Rank，在两层之间定义可分配水平通道的 RoutingBand，并做 Band 高度不足时
 * 动态拉大下游所有层的 y（§2.3），不允许路由穿节点换紧凑。
 * 收尾 rail 的 x 布局已移至 columns.ts（semantic-columns plan §5）。
 *
 * 全部纯函数、不碰 DOM；相同输入产生相同输出（Plan §0.2.7）。
 */

import type { WorkflowNode } from '../../../../../src/workflow/core/model.js'
import type { LaidOutNode } from './layout.js'
import { NODE_HEIGHT, NODE_WIDTH } from './layout.js'

/** y 聚类容差：d3-dag 同层节点 y 完全相等，epsilon 只为浮点兜底。 */
export const RANK_EPSILON = 0.5
/** 路由与节点矩形之间的最小净空（Plan §2.2）。 */
export const ROUTE_CLEARANCE = 12
/** 同一 Band 内相邻通道的垂直间距（Plan §2.2）。 */
export const CHANNEL_GAP = 10
export interface RankedNode {
  readonly node: WorkflowNode;
  readonly x: number;
  readonly y: number;
  readonly rank: number;
}

export interface LayoutRank {
  readonly index: number;
  readonly centerY: number;
  readonly top: number;
  readonly bottom: number;
  /** 按 x 升序、同 x 按 id 的稳定顺序。 */
  readonly nodeIds: readonly string[];
}

export interface RoutingBand {
  /** 位于 rank[index] 与 rank[index+1] 之间。 */
  readonly index: number;
  readonly top: number;
  readonly bottom: number;
}

export interface RankGeometry {
  readonly nodes: readonly RankedNode[];
  readonly ranks: readonly LayoutRank[];
  readonly bands: readonly RoutingBand[];
  readonly width: number;
  readonly height: number;
}

export function nodeBoundsOf (node: RankedNode): { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } {
  return {
    left: node.x - NODE_WIDTH / 2,
    right: node.x + NODE_WIDTH / 2,
    top: node.y - NODE_HEIGHT / 2,
    bottom: node.y + NODE_HEIGHT / 2,
  }
}

/** 节点矩形外扩 ROUTE_CLEARANCE 后的障碍矩形（Plan §4.4）。 */
export function obstacleOf (node: RankedNode): { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } {
  return {
    left: node.x - NODE_WIDTH / 2 - ROUTE_CLEARANCE,
    right: node.x + NODE_WIDTH / 2 + ROUTE_CLEARANCE,
    top: node.y - NODE_HEIGHT / 2 - ROUTE_CLEARANCE,
    bottom: node.y + NODE_HEIGHT / 2 + ROUTE_CLEARANCE,
  }
}

/**
 * 把 d3-dag 节点按 y 聚类成 Rank（Plan §2.3）：
 * 同一 y（允许 epsilon）的节点属于同一层，Rank 按 y 升序编号；
 * 节点 y 吸附到层中心，保证层内顶/底边一致、Band 边界确定。
 */
export function buildRanks (nodes: readonly LaidOutNode[]): RankGeometry {
  if (nodes.length === 0) return { nodes: [], ranks: [], bands: [], width: 0, height: 0 }

  const sorted = [...nodes].sort((a, b) => (Math.abs(a.y - b.y) <= RANK_EPSILON ? a.x - b.x || compareText(a.node.id, b.node.id) : a.y - b.y))
  const ranks: LayoutRank[] = []
  const rankOfNode = new Map<string, number>()
  let cluster: LaidOutNode[] = []
  let clusterY = sorted[0]!.y

  const flushCluster = (): void => {
    if (cluster.length === 0) return
    const index = ranks.length
    // 层中心取聚类内最小 y：抖动值不影响锚定（d3-dag 同层 y 本就相等）
    const centerY = Math.min(...cluster.map(item => item.y))
    for (const item of cluster) rankOfNode.set(item.node.id, index)
    ranks.push({
      index,
      centerY,
      top: centerY - NODE_HEIGHT / 2,
      bottom: centerY + NODE_HEIGHT / 2,
      nodeIds: [...cluster].sort((a, b) => a.x - b.x || compareText(a.node.id, b.node.id)).map(item => item.node.id),
    })
    cluster = []
  }

  for (const item of sorted) {
    if (cluster.length > 0 && Math.abs(item.y - clusterY) > RANK_EPSILON) {
      flushCluster()
      clusterY = item.y
    }
    if (cluster.length === 0) clusterY = item.y
    cluster.push(item)
  }
  flushCluster()

  // y 吸附到层中心：同层节点共享 top/bottom，Band 边界从而确定
  const ranked: RankedNode[] = nodes.map((item) => {
    const rank = rankOfNode.get(item.node.id)!
    return { node: item.node, x: item.x, y: ranks[rank]!.centerY, rank }
  })

  const bands: RoutingBand[] = []
  for (let i = 0; i + 1 < ranks.length; i += 1) {
    bands.push({ index: i, top: ranks[i]!.bottom, bottom: ranks[i + 1]!.top })
  }

  return withBounds(ranked, ranks, bands)
}

function withBounds (nodes: readonly RankedNode[], ranks: readonly LayoutRank[], bands: readonly RoutingBand[]): RankGeometry {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const node of nodes) {
    minX = Math.min(minX, node.x - NODE_WIDTH / 2)
    maxX = Math.max(maxX, node.x + NODE_WIDTH / 2)
    minY = Math.min(minY, node.y - NODE_HEIGHT / 2)
    maxY = Math.max(maxY, node.y + NODE_HEIGHT / 2)
  }
  return {
    nodes,
    ranks,
    bands,
    width: nodes.length === 0 ? 0 : maxX - minX,
    height: nodes.length === 0 ? 0 : maxY - minY,
  }
}

/** Band 能容纳 n 条通道（含净空）所需的最小高度。 */
export function bandHeightForSlots (slots: number): number {
  if (slots <= 1) return 0
  return (slots - 1) * CHANNEL_GAP + 2 * ROUTE_CLEARANCE
}

/**
 * Band 间距扩展（Plan §2.3）：某条 Band 需要的通道数超过当前高度所能容纳时，
 * 拉大该 Band 并把下游所有层的 y 顺次下移 —— 不允许靠路由穿节点保持紧凑。
 */
export function expandBands (geometry: RankGeometry, requiredSlotsPerBand: readonly number[]): RankGeometry {
  if (geometry.ranks.length === 0) return geometry

  const offsets: number[] = Array.from<number, number>({ length: geometry.ranks.length }, () => 0)
  let accumulated = 0
  for (const band of geometry.bands) {
    const required = requiredSlotsPerBand[band.index] ?? 0
    const needed = bandHeightForSlots(required)
    const current = band.bottom - band.top
    if (needed > current) accumulated += needed - current
    if (band.index + 1 < offsets.length) offsets[band.index + 1] = accumulated
  }

  const ranks = geometry.ranks.map((rank) => {
    const offset = offsets[rank.index]!
    if (offset === 0) return rank
    const centerY = rank.centerY + offset
    return { ...rank, centerY, top: centerY - NODE_HEIGHT / 2, bottom: centerY + NODE_HEIGHT / 2 }
  })
  const bands = geometry.bands.map((band, i) => ({ ...band, top: ranks[i]!.bottom, bottom: ranks[i + 1]!.top }))
  const nodes = geometry.nodes.map(node =>
    offsets[node.rank] === 0 ? node : { ...node, y: ranks[node.rank]!.centerY })
  return withBounds(nodes, ranks, bands)
}

/** 坐标归一化结果：几何 + 平移量（调用方用它同步平移骨架锚点）。 */
export interface NormalizedGeometry {
  readonly geometry: RankGeometry;
  readonly dx: number;
  readonly dy: number;
}

/**
 * 坐标归一化：平移到左上角为原点（侧移 rail 可能产生负坐标），便于 fit/滚动。
 */
export function normalizeGeometry (geometry: RankGeometry): NormalizedGeometry {
  if (geometry.nodes.length === 0) return { geometry, dx: 0, dy: 0 }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  for (const node of geometry.nodes) {
    minX = Math.min(minX, node.x - NODE_WIDTH / 2)
    minY = Math.min(minY, node.y - NODE_HEIGHT / 2)
  }
  // 避免产生 -0（测试断言与 JSON 序列化的稳定性）
  const dx = minX === 0 ? 0 : -minX
  const dy = minY === 0 ? 0 : -minY
  if (dx === 0 && dy === 0) return { geometry, dx: 0, dy: 0 }
  const nodes = geometry.nodes.map(node => ({ ...node, x: node.x + dx, y: node.y + dy }))
  const ranks = geometry.ranks.map((rank) => {
    const centerY = rank.centerY + dy
    return { ...rank, centerY, top: centerY - NODE_HEIGHT / 2, bottom: centerY + NODE_HEIGHT / 2 }
  })
  const bands = geometry.bands.map((band, i) => ({ ...band, top: ranks[i]!.bottom, bottom: ranks[i + 1]!.top }))
  return { geometry: withBounds(nodes, ranks, bands), dx, dy }
}

function compareText (a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
