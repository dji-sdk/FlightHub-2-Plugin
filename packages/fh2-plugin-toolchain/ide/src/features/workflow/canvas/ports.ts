// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 入/出端口分配（Plan §3）。
 *
 * 高入度/高出度节点的边不再共用底部/顶部中心点：
 * - 出边按目标 x 排序，在底边 [left+PORT_PADDING, right-PORT_PADDING] 均匀分布；
 * - 入边按来源 x 排序，在顶边均匀分布 —— 来源在左的边进左侧端口，从源头降低交叉；
 * - Trigger 隐式边固定用底部中心 → 根步骤顶部端口（§3.4）；
 * - 非单调边（环/反向）不参与端口分配，由路由器走右侧错误 gutter；
 * - 超容量时相邻边共享端口组（§3.2），节点进入「高连接数」提示集合。
 *
 * 纯函数、确定性：输入顺序变化不改变稳定 edgeKey 的端口排序（§8.1）。
 */

import type { WorkflowEdge } from '../../../../../src/workflow/core/model.js'
import { TRIGGER_NODE_ID } from '../../../../../src/workflow/core/model.js'
import { NODE_HEIGHT, NODE_WIDTH, edgeKeyOf } from './layout.js'
import type { LayoutRank, RankGeometry, RankedNode } from './ranks.js'

export const PORT_PADDING = 20
export const PORT_MIN_GAP = 16

export interface NodeBounds {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface EdgePort {
  readonly edgeKey: string;
  readonly nodeId: string;
  /** top = 入边端口；bottom = 出边端口。rail 也走顶部（routing-polish §5.1：右侧水平入边已废）。 */
  readonly side: 'top' | 'bottom';
  readonly x: number;
  readonly y: number;
  /** 在该节点该侧端口列表中的序（0 起）。 */
  readonly order: number;
}

export interface PortAssignment {
  readonly source: EdgePort;
  readonly target: EdgePort;
}

export interface PortResult {
  readonly assignments: ReadonlyMap<string, PortAssignment>;
  /** 出边数超过端口容量的节点（高连接数提示，§3.2）。 */
  readonly overCapacityNodeIds: ReadonlySet<string>;
}

export interface PortNodeIndex {
  readonly nodes: ReadonlyMap<string, RankedNode>;
  readonly rankOf: ReadonlyMap<string, number>;
  readonly slotOf: ReadonlyMap<string, number>;
  readonly geometry: RankGeometry;
}

export function buildPortNodeIndex (geometry: RankGeometry): PortNodeIndex {
  const nodes = new Map<string, RankedNode>()
  const rankOf = new Map<string, number>()
  const slotOf = new Map<string, number>()
  for (const node of geometry.nodes) {
    nodes.set(node.node.id, node)
    rankOf.set(node.node.id, node.rank)
  }
  for (const rank of geometry.ranks) {
    rank.nodeIds.forEach((id, slot) => slotOf.set(id, slot))
  }
  return { nodes, rankOf, slotOf, geometry }
}

/** 单调边判定需要的最小索引（Plan §3.4）：目标层严格低于来源层才走普通层间路由。 */
export interface RankLookup {
  readonly rankOf: ReadonlyMap<string, number>;
}

export function isMonotoneEdge (index: RankLookup, edge: WorkflowEdge): boolean {
  const fromRank = index.rankOf.get(edge.from)
  const toRank = index.rankOf.get(edge.to)
  if (fromRank === undefined || toRank === undefined) return false
  return toRank > fromRank
}

/**
 * 分配全部单调边的端口。非单调边（环/反向）不进端口表 —— 路由器把它们送进
 * 右侧错误 gutter；自环在图投影阶段已被阻断（§3.4）。
 */
export function assignPorts (geometry: RankGeometry, edges: readonly WorkflowEdge[]): PortResult {
  const index = buildPortNodeIndex(geometry)
  const outEdges = new Map<string, WorkflowEdge[]>()
  const inEdges = new Map<string, WorkflowEdge[]>()
  for (const edge of edges) {
    if (edge.from === edge.to) continue
    if (!isMonotoneEdge(index, edge)) continue
    pushTo(outEdges, edge.from, edge)
    pushTo(inEdges, edge.to, edge)
  }

  // 排序必须全序且稳定：目标/来源 x → rank → 层内 slot → ID → edgeKey
  const outSorted = sortByCounterpart(index, outEdges, 'to')
  const inSorted = sortByCounterpart(index, inEdges, 'from')

  const sourcePorts = new Map<string, EdgePort>()
  const targetPorts = new Map<string, EdgePort>()
  const overCapacity = new Set<string>()

  for (const [nodeId, list] of outSorted) {
    if (nodeId === TRIGGER_NODE_ID) {
      // Trigger 隐式边：底部中心一个端口（§3.4）
      const trigger = index.nodes.get(TRIGGER_NODE_ID)!
      list.forEach((edge, order) => {
        sourcePorts.set(edgeKeyOf(edge.from, edge.to), {
          edgeKey: edgeKeyOf(edge.from, edge.to),
          nodeId,
          side: 'bottom',
          x: trigger.x,
          y: trigger.y + NODE_HEIGHT / 2,
          order,
        })
      })
      continue
    }
    const node = index.nodes.get(nodeId)
    if (node === undefined) continue
    assignSidePorts(sourcePorts, node, list, 'bottom', overCapacity)
  }

  for (const [nodeId, list] of inSorted) {
    const node = index.nodes.get(nodeId)
    if (node === undefined) continue
    assignSidePorts(targetPorts, node, list, 'top', overCapacity)
  }

  const assignments = new Map<string, PortAssignment>()
  for (const edge of edges) {
    const key = edgeKeyOf(edge.from, edge.to)
    const source = sourcePorts.get(key)
    const target = targetPorts.get(key)
    if (source === undefined || target === undefined) continue
    assignments.set(key, { source, target })
  }
  return { assignments, overCapacityNodeIds: overCapacity }
}

function sortByCounterpart (
  index: PortNodeIndex,
  grouped: ReadonlyMap<string, WorkflowEdge[]>,
  counterpart: 'from' | 'to',
): ReadonlyMap<string, WorkflowEdge[]> {
  const sorted = new Map<string, WorkflowEdge[]>()
  for (const [nodeId, list] of grouped) {
    sorted.set(nodeId, [...list].sort((a, b) => {
      const ca = index.nodes.get(a[counterpart])
      const cb = index.nodes.get(b[counterpart])
      const xa = ca?.x ?? 0
      const xb = cb?.x ?? 0
      if (xa !== xb) return xa - xb
      const ra = index.rankOf.get(a[counterpart]) ?? 0
      const rb = index.rankOf.get(b[counterpart]) ?? 0
      if (ra !== rb) return ra - rb
      const sa = index.slotOf.get(a[counterpart]) ?? 0
      const sb = index.slotOf.get(b[counterpart]) ?? 0
      if (sa !== sb) return sa - sb
      const ida = a[counterpart]
      const idb = b[counterpart]
      if (ida !== idb) return ida < idb ? -1 : 1
      return edgeKeyOf(a.from, a.to) < edgeKeyOf(b.from, b.to) ? -1 : 1
    }))
  }
  return sorted
}

/**
 * 在节点某条边（顶/底）上分布端口：
 * 单边用中心；多边均匀分布；超过容量时收敛到容量槽位（相邻边共享端口组），
 * 共享组内的边在第一个 Band 内由路由器分配不同通道（§3.2）。
 */
function assignSidePorts (
  into: Map<string, EdgePort>,
  node: RankedNode,
  edges: readonly WorkflowEdge[],
  side: 'top' | 'bottom',
  overCapacity: Set<string>,
): void {
  const left = node.x - NODE_WIDTH / 2 + PORT_PADDING
  const right = node.x + NODE_WIDTH / 2 - PORT_PADDING
  const span = Math.max(right - left, 0)
  const capacity = Math.floor(span / PORT_MIN_GAP) + 1
  const y = side === 'bottom' ? node.y + NODE_HEIGHT / 2 : node.y - NODE_HEIGHT / 2

  if (edges.length > capacity) overCapacity.add(node.node.id)

  edges.forEach((edge, order) => {
    let x: number
    if (edges.length === 1) {
      x = node.x
    } else if (edges.length <= capacity) {
      x = left + (span * order) / (edges.length - 1)
    } else {
      // 超容量：映射到容量槽位，相邻边共享端口
      const slot = Math.floor((order * capacity) / edges.length)
      x = capacity === 1 ? node.x : left + (span * slot) / (capacity - 1)
    }
    into.set(edgeKeyOf(edge.from, edge.to), {
      edgeKey: edgeKeyOf(edge.from, edge.to),
      nodeId: node.node.id,
      side,
      x,
      y,
      order,
    })
  })
}

function pushTo<K> (map: Map<K, WorkflowEdge[]>, key: K, edge: WorkflowEdge): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [edge])
  else list.push(edge)
}

/** 路由输入用的节点几何（Plan §4.1 的 NodeBounds）。 */
export function nodeBoundsList (geometry: RankGeometry): readonly NodeBounds[] {
  return geometry.nodes.map(node => ({
    id: node.node.id,
    x: node.x,
    y: node.y,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  }))
}

export type { LayoutRank }
