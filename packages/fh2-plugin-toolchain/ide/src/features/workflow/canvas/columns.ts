// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 三列语义布局（semantic-columns plan §5）。
 *
 * 事故快处流程的三个残留问题：收尾节点内联在主链里挤得左右摆、状态链
 * （降级顺序边连成）没有空间表达、主链本身不直。本模块把 x 坐标后处理成
 * 三条语义泳道：主链（data 边最长路径）一列笔直、状态链（降级边链）右侧
 * 一列、收尾 rail（terminal-finalizer）最左一列。
 *
 * 纪律（plan §3）：不改 Workflow JSON、不按节点 ID 猜语义、纯函数确定性、
 * 宁可放弃对齐也不制造重叠。在 buildRanks 之后、expandBands 之前执行。
 */

import type { WorkflowEdge, WorkflowNode } from '../../../../../src/workflow/core/model.js'
import { GAP_X, NODE_HEIGHT, NODE_WIDTH } from './layout.js'
import type { NodePresentation } from './semantic-role.js'
import type { OrderingHints } from './ordering.js'
import type { RankGeometry, RankedNode } from './ranks.js'
import { RANK_EPSILON } from './ranks.js'

/** 列间距 = d3-dag 同层基线（routing-polish plan §4.1：一张表，不另写）。 */
export const COLUMN_GAP = GAP_X

/** rail 与主链/状态链之间为收尾干道预留的净空（专用竖直干道 + 两侧间距）。 */
export const FINALIZER_RAIL_GAP = 160

/** rail 内同层多收尾节点的错开间距（rail 列内部 slot）。 */
export const RAIL_SLOT_GAP = 32

export interface ColumnLayout {
  /** 主链节点 id（data 边最长路径，书写序）。 */
  readonly mainChain: readonly string[];
  /** 状态链节点 id（降级边弱连通链，对齐列的成员）。 */
  readonly stateChain: readonly string[];
  /** 收尾 rail 节点 id（laneHint = side-finalizer）。 */
  readonly railNodeIds: readonly string[];
  /** rail 专用竖直干道的 x（rail 列右缘 + 间距）。 */
  readonly railTrunkX: number;
  /** 布局后审计（§4.2）：正式 fixture 应为空；非空 = 有贴边/重叠，必须修布局。 */
  readonly audit: readonly ColumnAuditIssue[];
}

/**
 * 主链 = data 边（refKinds 含 input）构成的最长路径；$trigger 不计入。
 * 并列时取 steps[] 书写序靠前的（首节点最小 index）。
 * `avoid`（状态链成员）优先避开：并列最长有多条时，选尾节点不在 avoid 里的
 * 那条 —— 状态链成员（如 mark_handling）同时是 data 链尾时让位给主链的
 * 纯业务分支（如 poll），两条脊柱各自连贯。
 * 实现：在 data 边子图上做记忆化最长路径，返回路径上的全部节点 id（顺序无关，
 * 只用于对齐；返回顺序按书写序稳定排列）。
 */
export function computeMainChain (nodes: readonly WorkflowNode[], edges: readonly WorkflowEdge[], avoid: ReadonlySet<string> = new Set<string>()): readonly string[] {
  const dataEdges = edges.filter(edge => edge.refKinds.includes('input'))
  if (dataEdges.length === 0) return []

  const indexById = new Map(nodes.map(node => [node.id, node.index]))
  const incoming = new Map<string, string[]>()
  for (const edge of dataEdges) {
    if (edge.from === '$trigger') continue
    const list = incoming.get(edge.to) ?? []
    list.push(edge.from)
    incoming.set(edge.to, list)
  }
  const nodesById = new Map(nodes.map(node => [node.id, node]))
  const dataNodeIds = new Set<string>()
  for (const edge of dataEdges) {
    if (edge.from !== '$trigger') dataNodeIds.add(edge.from)
    dataNodeIds.add(edge.to)
  }

  // 最长路径长度 + 起点记录（并列取书写序靠前的起点；递归深度可控：data 子图无环
  // —— 有环图的环边已是 invalid 视觉、且 needs 环会在建图阶段被挡）。
  const best = new Map<string, { readonly length: number; readonly from: string | null }>()
  const resolving = new Set<string>()
  const longestOf = (id: string): { readonly length: number; readonly from: string | null } => {
    const cached = best.get(id)
    if (cached !== undefined) return cached
    if (resolving.has(id)) return { length: 0, from: null }
    resolving.add(id)
    let length = 0
    let source: string | null = null
    for (const parent of incoming.get(id) ?? []) {
      const candidate = longestOf(parent)
      if (candidate.length + 1 > length) {
        length = candidate.length + 1
        source = parent
      }
    }
    resolving.delete(id)
    const result = { length, from: source }
    best.set(id, result)
    return result
  }

  let tail: string | null = null
  let bestLength = -1
  let bestAvoided = false
  const chainNodes = [...dataNodeIds].filter(id => nodesById.has(id))
  for (const id of chainNodes) {
    const candidate = longestOf(id)
    const avoided = !avoid.has(id)
    // 并列最长时：不在 avoid 里的尾优先；avoid 情况只在长度严格更长时胜出
    if (candidate.length > bestLength || (candidate.length === bestLength && avoided && !bestAvoided)) {
      bestLength = candidate.length
      tail = id
      bestAvoided = avoided
    }
  }
  if (tail === null || bestLength < 1) return []

  const chain: string[] = [tail]
  let cursor = best.get(tail)?.from ?? null
  while (cursor !== null) {
    chain.push(cursor)
    cursor = best.get(cursor)?.from ?? null
  }
  // 书写序稳定排列（对齐只关心集合；顺序影响测试断言的可读性）
  return chain.filter(id => indexById.has(id)).sort((a, b) => (indexById.get(a)! - indexById.get(b)!))
}

/**
 * 状态链 = 降级顺序边连成的弱连通链上的节点，其中对齐到「右侧一列」的成员：
 * 沿降级边从链首走，分叉时只取第一个后继（书写序），不做树形展开
 * （plan §5.2）。返回参与对齐的成员（书写序）。
 */
export function computeStateChain (
  nodes: readonly WorkflowNode[],
  demoted: ReadonlySet<string>,
  edges: readonly WorkflowEdge[],
  railNodeIds: ReadonlySet<string>,
): readonly string[] {
  if (demoted.size === 0) return []
  const indexById = new Map(nodes.map(node => [node.id, node.index]))

  // 降级边的邻接表（书写序）；成员必须不是 rail（rail 由 §5.3 抢走，优先级更高）
  const successors = new Map<string, string[]>()
  const hasDemotedIncoming = new Set<string>()
  for (const edge of edges) {
    const key = `${edge.from}\0${edge.to}`
    if (!demoted.has(key)) continue
    hasDemotedIncoming.add(edge.to)
    const list = successors.get(edge.from) ?? []
    list.push(edge.to)
    successors.set(edge.from, list)
  }

  // 链首：有降级出边、没有降级入边的节点（多条链时按书写序全部纳入遍历）
  const chainHeads = [...successors.keys()]
    .filter(id => !hasDemotedIncoming.has(id) && !railNodeIds.has(id))
    .sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0))

  const members = new Set<string>()
  const visited = new Set<string>()
  const walk = (id: string, isHead: boolean): void => {
    if (visited.has(id)) return
    visited.add(id)
    if (!railNodeIds.has(id) && isHead) members.add(id)
    const next = (successors.get(id) ?? [])
      .filter(target => !railNodeIds.has(target))
      .sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0))
    // 分叉只对齐第一个后继；其余不进对齐集合（其链下延从它自己重新起头）
    if (next.length > 0) {
      members.add(next[0]!)
      walk(next[0]!, true)
      for (let i = 1; i < next.length; i += 1) walk(next[i]!, false)
    }
  }
  for (const head of chainHeads) walk(head, true)
  return [...members].sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0))
}

/**
 * 应用三列语义布局（x 坐标后处理，主入口）。
 *
 * 顺序：① rail 固定最左一列（纵向保留自己的 rank）；② 主链对齐到中位数列；
 * ③ 状态链对齐到主链右侧一列（分叉只对齐第一个后继已由 computeStateChain
 * 处理）。每一步都做「冲突即放弃」：对齐目标列会导致与同层其它节点重叠时，
 * 该节点放弃对齐保持原位，绝不挤压。
 *
 * 返回应用后的几何与布局事实（railTrunkX 供路由的专用干道使用）。
 */
export function applySemanticColumns (
  geometry: RankGeometry,
  presentations: ReadonlyMap<string, NodePresentation>,
  edges: readonly WorkflowEdge[],
  ordering: OrderingHints,
): { readonly geometry: RankGeometry; readonly layout: ColumnLayout } {
  const nodes = geometry.nodes
  if (nodes.length === 0) return { geometry, layout: { mainChain: [], stateChain: [], railNodeIds: [], railTrunkX: 0, audit: [] } }

  const nodeById = new Map(nodes.map(node => [node.node.id, node]))
  const railNodeIds = nodes
    .filter(node => presentations.get(node.node.id)?.laneHint === 'side-finalizer')
    .map(node => node.node.id)
  const railSet = new Set(railNodeIds)

  // 状态链先算（rail 成员被 §5.3 抢走不入链），主链再避开状态链成员取最长
  // data 路径 —— 两条脊柱各自连贯，不抢同一个节点。
  const stateChain = computeStateChain(nodes.map(node => node.node), ordering.demoted, edges, railSet)
  const stateSet = new Set(stateChain)
  const mainChain = computeMainChain(nodes.map(node => node.node), edges, stateSet)

  const moves = new Map<string, number>()

  // ① 主链对齐：目标 x = 主链节点当前 x 的中位数（不整图平移）。
  //    冲突放弃：对齐后与同层非豁免节点净距不足 COLUMN_GAP → 该节点放弃
  //    （routing-polish §4.2：对齐只许改善阅读，不许产出贴边布局）。
  const align = (ids: readonly string[], targetX: number, exempt: ReadonlySet<string>): void => {
    for (const id of ids) {
      const node = nodeById.get(id)
      if (node === undefined) continue
      if (!clearsAt(node, targetX, nodeById, exempt)) continue
      moves.set(id, targetX)
    }
  }

  const mainSet = new Set(mainChain)
  if (mainChain.length > 0) {
    const mainXs = mainChain.map(id => nodeById.get(id)?.x ?? 0).sort((a, b) => a - b)
    const median = mainXs[Math.floor((mainXs.length - 1) / 2)]!
    align(mainChain, median, new Set([...railSet]))
  }

  // ② 状态链列：主链列右缘 + 状态链当前 x 中位数 + 同层障碍的最小可行 x
  //    三者取最大（列只能往右让 —— 往左会压主链/rail；同层非链节点是硬障碍，
  //    列右移到全部成员可行，而不是放弃某个成员：整条脊柱的价值大于紧凑）。
  if (stateChain.length > 0) {
    const mainRight = mainChain.length > 0
      ? Math.max(...mainChain.map(id => (moves.get(id) ?? nodeById.get(id)?.x ?? 0))) + NODE_WIDTH / 2
      : Number.NEGATIVE_INFINITY
    const stateXs = stateChain.map(id => nodeById.get(id)?.x ?? 0).sort((a, b) => a - b)
    const stateMedian = stateXs[Math.floor((stateXs.length - 1) / 2)]!
    // 每个成员同层非链障碍（非 rail、非 main、非链内）的右缘 + 半宽 = 该成员可行的最小 x
    let feasible = Number.NEGATIVE_INFINITY
    for (const id of stateChain) {
      const node = nodeById.get(id)
      if (node === undefined) continue
      for (const other of nodeById.values()) {
        if (other.node.id === id || other.rank !== node.rank) continue
        if (railSet.has(other.node.id) || stateSet.has(other.node.id)) continue
        if (moves.has(other.node.id) && mainSet.has(other.node.id)) continue
        // ★ routing-polish §4.1：可行 x = blocker.right + COLUMN_GAP + 半宽。
        //   从前是 blocker.x + NODE_WIDTH（刚好贴边、净距 0）——事故快处
        //   mark_terminated | mark_completed 贴边就是这么来的。
        feasible = Math.max(feasible, other.x + NODE_WIDTH / 2 + COLUMN_GAP + NODE_WIDTH / 2)
      }
    }
    const preferred = Math.max(stateMedian, mainRight + COLUMN_GAP + NODE_WIDTH / 2, feasible)
    align(stateChain, preferred, new Set([...railSet, ...mainSet]))
  }

  // ③ 收尾 rail：固定最左一列。目标 x = 全部非 rail 节点（对齐后）的最小左缘
  //    − 干道净空。同层多个收尾节点按书写序向左错开一档（rail 内 slot），
  //    避免同层 rail 互叠；干道取 rail 基准列右缘与主区左缘的中点。
  let railTrunkX = 0
  if (railNodeIds.length > 0) {
    let minX = Number.POSITIVE_INFINITY
    for (const node of nodes) {
      if (railSet.has(node.node.id)) continue
      const x = moves.get(node.node.id) ?? node.x
      minX = Math.min(minX, x - NODE_WIDTH / 2)
    }
    const railX = minX - FINALIZER_RAIL_GAP - NODE_WIDTH / 2
    const slotsByRank = new Map<number, number>()
    for (const id of railNodeIds) {
      const node = nodeById.get(id)
      if (node === undefined) continue
      const slot = slotsByRank.get(node.rank) ?? 0
      slotsByRank.set(node.rank, slot + 1)
      moves.set(id, railX - slot * (NODE_WIDTH + RAIL_SLOT_GAP))
    }
    // 专用干道 x：rail 基准列右缘与主区左缘之间，从 rail 侧向右扫到第一个
    // 不落在任何节点净空带内的位置（$trigger/主链首层可能压进这条缝 ——
    // 干道必须真正避让，而不是取几何中点）。
    const railRight = railX + NODE_WIDTH / 2
    const probeClear = (x: number): boolean => {
      for (const node of nodes) {
        if (railSet.has(node.node.id)) continue
        const x0 = moves.get(node.node.id) ?? node.x
        if (x > x0 - NODE_WIDTH / 2 - 16 && x < x0 + NODE_WIDTH / 2 + 16) return false
      }
      return true
    }
    let trunk = railRight + 24
    while (trunk < minX - 16 && !probeClear(trunk)) trunk += 16
    railTrunkX = probeClear(trunk) ? trunk : railRight + 24
  }

  const moved = nodes.map((node) => {
    const x = moves.get(node.node.id)
    return x === undefined ? node : { ...node, x }
  })
  // 层内顺序随 x 更新；y/层级不变
  const ranks = geometry.ranks.map(rank => ({
    ...rank,
    nodeIds: moved.filter(node => node.rank === rank.index)
      .sort((a, b) => a.x - b.x || compareText(a.node.id, b.node.id))
      .map(node => node.node.id),
  }))
  const next: RankGeometry = { ...geometry, nodes: moved, ranks }
  const columnOf = new Map<string, 'main' | 'state' | 'rail' | 'none'>()
  for (const node of moved) {
    columnOf.set(node.node.id, railSet.has(node.node.id)
      ? 'rail'
      : mainSet.has(node.node.id)
        ? 'main'
        : stateSet.has(node.node.id)
          ? 'state'
          : 'none')
  }
  return {
    geometry: withBounds(next),
    layout: { mainChain, stateChain, railNodeIds, railTrunkX, audit: auditColumnClearance(next, columnOf) },
  }
}

/** 候选 x 上与同层非豁免节点的水平净距是否 ≥ COLUMN_GAP（node 自身与豁免集不算）。 */
function clearsAt (
  node: RankedNode,
  candidateX: number,
  nodeById: ReadonlyMap<string, RankedNode>,
  exempt: ReadonlySet<string>,
): boolean {
  const left = candidateX - NODE_WIDTH / 2
  const right = candidateX + NODE_WIDTH / 2
  for (const other of nodeById.values()) {
    if (other.node.id === node.node.id) continue
    if (other.rank !== node.rank) continue
    if (exempt.has(other.node.id)) continue
    const otherRight = other.x + NODE_WIDTH / 2
    const otherLeft = other.x - NODE_WIDTH / 2
    // 贴边（净距 0）也算不过 —— 宁可放弃对齐也不产出贴边布局（§4.2）
    if (right > otherLeft - COLUMN_GAP && left < otherRight + COLUMN_GAP) return false
  }
  return true
}

/**
 * 布局后审计（routing-polish §4.2）：同 Rank 相邻节点不重叠；
 * 不同语义列的相邻节点净距 ≥ COLUMN_GAP。rail 同列 slot 间距（RAIL_SLOT_GAP）
 * 属同列关系，不按列间距判。返回可测试的诊断；applySemanticColumns
 * 在返回值里携带（列布局必须自证清白，不能静默产出贴边布局）。
 */
export interface ColumnAuditIssue {
  readonly kind: 'overlap' | 'clearance';
  readonly rank: number;
  readonly a: string;
  readonly b: string;
  /** overlap 恒 0；clearance 为实际净距（负值即重叠）。 */
  readonly gap: number;
}

function auditColumnClearance (
  geometry: RankGeometry,
  columnOf: ReadonlyMap<string, 'main' | 'state' | 'rail' | 'none'>,
): readonly ColumnAuditIssue[] {
  const issues: ColumnAuditIssue[] = []
  for (const rank of geometry.ranks) {
    const row = rank.nodeIds
      .map(id => geometry.nodes.find(node => node.node.id === id))
      .filter((node): node is RankedNode => node !== undefined)
      .sort((a, b) => a.x - b.x)
    for (let i = 0; i + 1 < row.length; i += 1) {
      const a = row[i]!
      const b = row[i + 1]!
      const gap = (b.x - NODE_WIDTH / 2) - (a.x + NODE_WIDTH / 2)
      if (gap < -RANK_EPSILON) {
        issues.push({ kind: 'overlap', rank: rank.index, a: a.node.id, b: b.node.id, gap })
        continue
      }
      const colA = columnOf.get(a.node.id) ?? 'none'
      const colB = columnOf.get(b.node.id) ?? 'none'
      if (colA !== colB && gap < COLUMN_GAP - RANK_EPSILON) {
        issues.push({ kind: 'clearance', rank: rank.index, a: a.node.id, b: b.node.id, gap })
      }
    }
  }
  return issues
}

function withBounds (geometry: RankGeometry): RankGeometry {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const node of geometry.nodes) {
    minX = Math.min(minX, node.x - NODE_WIDTH / 2)
    maxX = Math.max(maxX, node.x + NODE_WIDTH / 2)
    minY = Math.min(minY, node.y - NODE_HEIGHT / 2)
    maxY = Math.max(maxY, node.y + NODE_HEIGHT / 2)
  }
  return {
    ...geometry,
    width: geometry.nodes.length === 0 ? 0 : maxX - minX,
    height: geometry.nodes.length === 0 ? 0 : maxY - minY,
  }
}

function compareText (a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
