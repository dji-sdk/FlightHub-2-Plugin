// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 次要顺序边的降级判据（ordering-edge-semantics plan §4）。
 *
 * needs 同时承载三件事：数据依赖、判据依赖、纯顺序。第三类在真实流程里
 * 不是边角料（事故快处 17 条边里 7 条只买顺序，其中 5 条还是跨 Rank 长线），
 * 但把它们画成线会淹没真正要追的数据流 —— 这里把它们从布线通道里移出，
 * 降级为节点角标 + 按需临时高亮。
 *
 * 纯函数、确定性输出；只消费 {@link WorkflowGraph} 的只读事实（refKinds），
 * 不读 JSON、不猜语义。降级 ≠ 删除：buildFocusIndex 仍基于完整边集。
 */

import type { WorkflowEdge, WorkflowGraph } from '../../../../../src/workflow/core/model.js'
import { edgeKeyOf } from './layout.js'

export interface OrderingHints {
  /** 不进路由器的边（稳定 edgeKey）。 */
  readonly demoted: ReadonlySet<string>;
  /** 节点 id → 它被要求排在哪些步之后（按 needs 书写序，只含被降级的来源）。 */
  readonly afterBadges: ReadonlyMap<string, readonly string[]>;
}

/**
 * 一条边是否可降级为角标（plan §4.1 三条件缺一不可）：
 *
 * 1. 显式 needs（implicit 边不是顺序边 —— 挂 trigger 下是「无依赖」的表达）。
 * 2. refKinds 为空：这条边不承载任何数据/判据引用。
 * 3. 目标节点**另有一条带引用的入边**：只有那时顺序边才是「附加的先后约束」，
 *    才可以让位。目标只有这一个父节点时（如 ack → pick）降级它会把主链
 *    在画面上剪断。
 */
export function isDemotableOrderingEdge (
  edge: WorkflowEdge,
  edges: readonly WorkflowEdge[],
): boolean {
  if (edge.origin !== 'needs') return false
  if (edge.refKinds.length > 0) return false
  return edges.some(other =>
    other !== edge && other.to === edge.to && other.refKinds.length > 0)
}

/** 按降级判据计算全部角标提示（demoted 集 + 每个目标的 after 名单）。 */
export function computeOrderingHints (graph: WorkflowGraph): OrderingHints {
  const demoted = new Set<string>()
  const afterBadges = new Map<string, string[]>()
  // 目标节点的 needs 书写序决定角标名单顺序；graph.edges 已按 steps 顺序产出。
  for (const edge of graph.edges) {
    if (!isDemotableOrderingEdge(edge, graph.edges)) continue
    demoted.add(edgeKeyOf(edge.from, edge.to))
    const list = afterBadges.get(edge.to) ?? []
    list.push(edge.from)
    afterBadges.set(edge.to, list)
  }
  return { demoted, afterBadges }
}

/**
 * 角标文案（plan §4.2 / §6）：写它真正买到的东西，不写干巴巴的「排在…之后」。
 * 默认 allSucceeded 下被降级的边仍传播跳过（上游 skipped ⟹ 本步 skipped）；
 * 目标 allDone 时跳过确实不传播，换「仅顺序」。
 * 多来源折叠为「N 步」—— 具体名单进 tooltip（完整列表由调用方拼），
 * 否则角标必然超宽（semantic-columns plan §6 的截断问题从源头收敛）。
 */
export function orderingBadgeLabel (
  targetTriggerMode: 'allSucceeded' | 'allDone' | undefined,
  afterIds: readonly string[],
): string {
  if (targetTriggerMode === 'allDone') {
    return afterIds.length === 1
      ? `⟲ 仅顺序跟随 ${afterIds[0]}`
      : `⟲ 仅顺序跟随 ${afterIds.length} 步`
  }
  return afterIds.length === 1
    ? `⟲ 跟随 ${afterIds[0]}（顺序 / 连坐跳过）`
    : `⟲ 跟随 ${afterIds.length} 步（顺序 / 连坐跳过）`
}

/** 角标 tooltip：完整来源列表 + 语义说明（触屏拿不到 hover，Inspector 同文案）。 */
export function orderingBadgeTooltip (afterIds: readonly string[]): string {
  return `顺序依赖：${afterIds.join('、')}。不取任何产出，只约束先后与跳过传染（allDone 目标仅顺序）。`
}

/**
 * 超宽时截 id 而不是截句尾（semantic-columns plan §6）：句尾那半句才是语义。
 * 汉字按全宽计（1），ASCII 按半宽（0.5）；maxWidth 默认按节点可用宽度估算。
 */
export function truncateBadgeId (id: string, budget: number): string {
  let width = 0
  let cut = 0
  for (const ch of id) {
    const w = ch.charCodeAt(0) > 0xFF ? 1 : 0.5
    if (width + w > budget) break
    width += w
    cut += ch.length
  }
  if (cut >= id.length) return id
  return `${id.slice(0, Math.max(0, cut - 1))}…`
}

/**
 * 单来源角标的完整渲染文案：超宽时截 id 保句尾。
 * budget = 可容纳的字宽（汉字 1、ASCII 0.5）。
 */
export function orderingBadgeText (
  targetTriggerMode: 'allSucceeded' | 'allDone' | undefined,
  afterIds: readonly string[],
  budget: number,
): string {
  if (afterIds.length !== 1) return orderingBadgeLabel(targetTriggerMode, afterIds)
  const full = orderingBadgeLabel(targetTriggerMode, afterIds)
  if (visualWidth(full) <= budget) return full
  // 截 id：句式 = 前缀 + id + 尾句；id 可用预算 = budget − 前后文案宽度
  const id = afterIds[0]!
  const prefix = targetTriggerMode === 'allDone' ? '⟲ 仅顺序跟随 ' : '⟲ 跟随 '
  const suffix = targetTriggerMode === 'allDone' ? '' : '（顺序 / 连坐跳过）'
  const idBudget = budget - visualWidth(prefix) - visualWidth(suffix) - 1
  return `${prefix}${truncateBadgeId(id, Math.max(0, idBudget))}${suffix}`
}

/** 汉字全宽、ASCII 半宽的可视宽度。 */
export function visualWidth (text: string): number {
  let width = 0
  for (const ch of text) {
    width += ch.charCodeAt(0) > 0xFF ? 1 : 0.5
  }
  return width
}
