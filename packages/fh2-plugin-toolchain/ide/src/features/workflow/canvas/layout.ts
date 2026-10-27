// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * d3-dag sugiyama 布局的薄封装：只算坐标，不碰 DOM（契约 §9 的选型）。
 *
 * 从 features/workflow/layout.ts 迁入 canvas/（DAG 正交连线 Plan §6.3），
 * 间距按 Plan §2.2 调大：节点加宽加高给徽标留位，层间距给正交通道留位。
 *
 * 已知坑：节点尺寸必须为正，否则 d3-dag 直接抛
 * `constant nodeSize must be positive`。这里的 NODE_WIDTH/HEIGHT 是常量且为正，
 * 不从外部传入，就是为了让这条永远不可能被违反。
 */

import { graph, sugiyama } from 'd3-dag'
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from '../../../../../src/workflow/core/model.js'

export const NODE_WIDTH = 212
export const NODE_HEIGHT = 72
/**
 * 同层节点的横向净距基线（d3-dag gap 同源）。
 * ★ 语义列布局（columns.ts）复用同一常量：列间净距与 d3 基线一张表，
 *    两处各写一份就会出现「列间距 < 基线间距」的贴边布局（routing-polish §4.1）。
 */
export const GAP_X = 80
const GAP_Y = 88

export interface LaidOutNode {
  readonly node: WorkflowNode;
  /** 节点中心坐标（d3-dag 的约定）。 */
  readonly x: number;
  readonly y: number;
}

export interface LaidOutEdge {
  readonly edge: WorkflowEdge;
  /** 折线控制点（含虚拟节点位置），已是布局坐标系下的绝对值。 */
  readonly points: readonly (readonly [number, number])[];
}

export interface WorkflowLayout {
  readonly nodes: readonly LaidOutNode[];
  readonly edges: readonly LaidOutEdge[];
  readonly width: number;
  readonly height: number;
}

const EMPTY: WorkflowLayout = { nodes: [], edges: [], width: 0, height: 0 }

/**
 * 布局。d3-dag 会拒绝自环（`self loops are not supported`），而 `needs: [自己]`
 * 是用户手写文件里真实会出现的错误，所以自环边在 {@link toGraph} 阶段就被挡成 issue，
 * 这里只做二次保险。有向环 d3-dag 自己能处理（内部会反转边），不需要额外拆环。
 */
export function layoutWorkflow (model: WorkflowGraph): WorkflowLayout {
  if (model.nodes.length === 0) return EMPTY

  const builder = graph<WorkflowNode, WorkflowEdge>()
  const handles = new Map<string, ReturnType<typeof builder.node>>()
  for (const node of model.nodes) {
    // 同名 step（DUPLICATE_STEP_ID）只建一个句柄，否则后建的会顶掉先建的连边
    if (handles.has(node.id)) continue
    handles.set(node.id, builder.node(node))
  }
  for (const edge of model.edges) {
    if (edge.from === edge.to) continue
    const source = handles.get(edge.from)
    const target = handles.get(edge.to)
    if (source === undefined || target === undefined) continue
    builder.link(source, target, edge)
  }

  const layout = sugiyama()
    .nodeSize([NODE_WIDTH, NODE_HEIGHT])
    .gap([GAP_X, GAP_Y])
  const { width, height } = layout(builder)

  const nodes: LaidOutNode[] = []
  for (const handle of builder.nodes()) nodes.push({ node: handle.data, x: handle.x, y: handle.y })
  const edges: LaidOutEdge[] = []
  for (const link of builder.links()) {
    edges.push({ edge: link.data, points: link.points.map(([x, y]) => [x, y] as const) })
  }

  return { nodes, edges, width, height }
}

/** 稳定边键：同一对节点不能有重复 needs，因此 `from + "\\0" + to` 唯一（Plan §3.1）。 */
export function edgeKeyOf (from: string, to: string): string {
  return `${from}\0${to}`
}

/** 骨架点：d3-dag 的 link.points，供 rank/路由消费。 */
export function buildSkeletons (layout: WorkflowLayout): ReadonlyMap<string, readonly (readonly [number, number])[]> {
  const skeletons = new Map<string, readonly (readonly [number, number])[]>()
  for (const item of layout.edges) {
    skeletons.set(edgeKeyOf(item.edge.from, item.edge.to), item.points)
  }
  return skeletons
}
