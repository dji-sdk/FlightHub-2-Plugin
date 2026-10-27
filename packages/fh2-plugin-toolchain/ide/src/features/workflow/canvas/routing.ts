// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 正交路由器（Plan §4）：端口 → 层间通道 → 避让 → 折线点。
 *
 * 输入：节点几何（Rank 系）、全部边、d3-dag 骨架点、端口分配结果。
 * 输出：每条边的正交折线（只有水平/垂直段）+ 视觉种类 + fallback 标记。
 *
 * 职责边界（Plan §6.4）：纯函数，不 import DOM/Vue/Store；d3-dag 只提供
 * 分层与骨架，最终路径由这里决定。合法性 fixture 的 fallback 目标为 0，
 * 环/反向边进入右侧错误 gutter（红色虚线，帮助定位与删除）。
 *
 * 算法骨架（§4.2/§4.3）：
 * 1. 骨架点首尾替换为 source/target 端口，中间虚拟点保留。
 * 2. 为每个锚点解析一条贯穿 stem x：优先锚点 x，被非起止节点挡住时按
 *    步长左右找空闲 lane；相邻 Band 共用同一 stem x，不在层中心线抖动。
 *    ★ 目标侧例外（routing-polish §5.2）：末 stem 钉死在 target 顶端口 x，
 *    横向换道只发生在目标上方的 Band 通道里 —— 端口前最后一段恒垂直，
 *    逃逸换道会把箭头变成水平进入节点。
 * 3. 相邻锚点对之间的 Band 内选一条水平通道（midY 起左右交替扩张），
 *    与已占用通道保持 CHANNEL_GAP、不进节点扩展矩形。
 * 4. 单边失败不抛异常：计入 fallback 指标，Band 耗尽可由上层扩层后重排。
 */

import type { WorkflowEdge } from '../../../../../src/workflow/core/model.js'
import { NODE_WIDTH, edgeKeyOf } from './layout.js'
import type { RankGeometry, RankedNode, RoutingBand } from './ranks.js'
import { CHANNEL_GAP, RANK_EPSILON, ROUTE_CLEARANCE, obstacleOf } from './ranks.js'
import type { EdgePort, PortAssignment, PortResult } from './ports.js'
import { assignPorts, isMonotoneEdge } from './ports.js'

/**
 * 边的视觉种类（semantic-columns plan §4）。
 *
 * 判据只读 `edge.refKinds`（投影层事实），不看节点：
 * - `data`：含 input 引用 —— 传值。
 * - `guard`：只含 when / awaitTimeout / callbackTimeout —— 只读判据。
 * - `order-inline`：refKinds 为空的 needs 边（未降级、仍布线的纯顺序边）。
 *   与 guard 分开：它既不传值也不读状态，混进 guard 会让线型说谎。
 *
 * 优先级表驱动（plan §4 ⚠️）：加一档必须补一行，不允许 if 链漏分支。
 */
export type EdgeVisualKind =
  | 'implicit'
  | 'data'
  | 'guard'
  | 'order-inline'
  | 'finalizer'
  | 'invalid'

export interface OrthogonalSegment {
  readonly orientation: 'h' | 'v';
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export type FallbackKind = 'band-exhausted' | 'blocked' | 'degenerate'

export interface RoutedEdge {
  readonly edge: WorkflowEdge;
  /** 正交折线点（已去重、合并共线相邻点）。 */
  readonly points: readonly (readonly [number, number])[];
  readonly segments: readonly OrthogonalSegment[];
  readonly visualKind: EdgeVisualKind;
  /** 无法在 Band 内合法布线时置位（§4.6）；错误 gutter 边不算 fallback。 */
  readonly fallback: boolean;
  readonly fallbackKind?: FallbackKind;
  /** 开发模式诊断用的人类可读原因（§4.6）。 */
  readonly fallbackReason?: string;
}

export interface RouteInput {
  readonly edges: readonly WorkflowEdge[];
  readonly geometry: RankGeometry;
  /** d3-dag link.points（含虚拟节点），键为 edgeKey；贡献虚拟节点 lane x。 */
  readonly skeletons: ReadonlyMap<string, readonly (readonly [number, number])[]>;
  /** triggerMode 为 allDone 的节点 id（指向它们的边是 finalizer 视觉）。 */
  readonly allDoneNodeIds: ReadonlySet<string>;
  /**
   * 收尾 rail（semantic-columns §5.3 + routing-polish §2/§6）：成员节点与
   * 专用干道 x。提供时指向 rail 成员的单调边走固定最简路径：
   * 来源底端口 → 下方 Band 通道 → 共享干道 → 目标上方 Band 通道 →
   * **目标顶端口**（垂直进入，与全部合法边一致）；同 Band 的出口/入口
   * 合并成一条通道，不产生干道上的短折返。干道/通道不可用时回退常规
   * 路由并计 fallback（不能静默）。缺省 = 无 rail，行为与之前完全一致。
   */
  readonly rail?: { readonly nodeIds: ReadonlySet<string>; readonly trunkX: number };
}

export interface RouteResult {
  readonly routed: readonly RoutedEdge[];
  readonly ports: PortResult;
  /** 每个 Band 实际用到的通道档数（供 expandBands 决定是否拉层）。 */
  readonly usedSlotsPerBand: readonly number[];
  /** 每个 Band 通道耗尽的次数（扩层依据：used + exhausted + 余量）。 */
  readonly exhaustedPerBand: readonly number[];
}

/** 通道占用记录（Plan §4.3）：Band 内一段已占用的水平区间。 */
interface ChannelReservation {
  readonly y: number;
  readonly minX: number;
  readonly maxX: number;
}

interface BandState {
  readonly reservations: ChannelReservation[];
  readonly usedChannels: Set<number>;
  /** 通道耗尽次数（wanted-but-failed），扩层依据。 */
  exhausted: number;
}

const STEM_STEP = 16
const STEM_SEARCH_LIMIT = 2048
const GUTTER_OFFSET = 64

/**
 * 单次完整路由：确定性顺序处理（§4.3），同输入同输出。
 *
 * 顺序：非单调边（环/反向）排最后进错误 gutter；单调边先按跨度（相邻层
 * 短边优先）、再按视觉种类（主流程 → 收尾）、最后按稳定坐标序排列。
 */
export function routeEdges (input: RouteInput): RouteResult {
  const { geometry, edges, skeletons, allDoneNodeIds, rail } = input
  const ports = assignPorts(geometry, edges)
  const nodeById = new Map(geometry.nodes.map(node => [node.node.id, node]))
  const order = orderIndex(geometry)
  const railTargets = rail === undefined ? new Set<string>() : new Set(rail.nodeIds)

  const ordered = [...edges].filter(edge => edge.from !== edge.to).sort((a, b) => {
    const aMono = isMonotoneEdge(order, a)
    const bMono = isMonotoneEdge(order, b)
    if (aMono !== bMono) return aMono ? -1 : 1
    const aRail = railTargets.has(a.to) && aMono
    const bRail = railTargets.has(b.to) && bMono
    if (aRail !== bRail) return aRail ? 1 : -1
    const aRank = order.rankOf.get(a.from) ?? 0
    const bRank = order.rankOf.get(b.from) ?? 0
    const aTarget = order.rankOf.get(a.to) ?? 0
    const bTarget = order.rankOf.get(b.to) ?? 0
    const aSpan = aTarget - aRank
    const bSpan = bTarget - bRank
    if (aSpan !== bSpan) return aSpan - bSpan
    const aKind = visualKindOf(a, allDoneNodeIds)
    const bKind = visualKindOf(b, allDoneNodeIds)
    // 主流程（data/guard/order-inline/implicit）先占通道，收尾（finalizer）后占
    const kindOrder = (kind: EdgeVisualKind): number => (kind === 'finalizer' ? 1 : 0)
    if (kindOrder(aKind) !== kindOrder(bKind)) return kindOrder(aKind) - kindOrder(bKind)
    const bySource = compareStable(order, a, b)
    if (bySource !== 0) return bySource
    return edgeKeyOf(a.from, a.to) < edgeKeyOf(b.from, b.to) ? -1 : 1
  })

  const bands = new Map<number, BandState>()
  for (const band of geometry.bands) {
    bands.set(band.index, { reservations: [], usedChannels: new Set<number>(), exhausted: 0 })
  }

  const routed: RoutedEdge[] = []
  for (const edge of ordered) {
    const key = edgeKeyOf(edge.from, edge.to)
    const assignment = ports.assignments.get(key)
    const visualKind = visualKindOf(edge, allDoneNodeIds)
    if (assignment === undefined) {
      // 非单调边（环/反向）：右侧错误 gutter（§3.4/§1.2），不算 fallback。
      // rail 目标的非单调边同走 gutter —— 收尾与「配置写错了」必须分得开（plan §5.3）。
      routed.push(routeInvalidEdge(edge, nodeById))
      continue
    }
    // rail 成员的单调边：专用干道路由（routing-polish §6）。
    // 失败回退常规路由（assignment 仍在：端口名额已占）并计 fallback ——
    // 「静默换一种画法」比显式降级更难排查（§6.4：正式 fixture 必须 0）。
    if (rail !== undefined && railTargets.has(edge.to) && assignment !== undefined) {
      const railRouted = routeRailEdge(edge, assignment, geometry, bands, nodeById, rail.trunkX, visualKind)
      if (railRouted !== null) {
        routed.push(railRouted)
        continue
      }
      const degraded = routeMonotoneEdge(edge, assignment, skeletons.get(key) ?? [], geometry, bands, nodeById, visualKind)
      routed.push({
        ...degraded,
        fallback: true,
        fallbackKind: 'blocked',
        fallbackReason: 'rail 干道通道不可用，回退常规路由',
      })
      continue
    }
    routed.push(routeMonotoneEdge(edge, assignment, skeletons.get(key) ?? [], geometry, bands, nodeById, visualKind))
  }

  const usedSlotsPerBand = geometry.bands.map(band => bands.get(band.index)?.usedChannels.size ?? 0)
  const exhaustedPerBand = geometry.bands.map(band => bands.get(band.index)?.exhausted ?? 0)
  return { routed, ports, usedSlotsPerBand, exhaustedPerBand }
}

interface OrderIndex {
  readonly nodes: ReadonlyMap<string, RankedNode>;
  readonly rankOf: ReadonlyMap<string, number>;
  readonly slotOf: ReadonlyMap<string, number>;
}

function orderIndex (geometry: RankGeometry): OrderIndex {
  const nodes = new Map(geometry.nodes.map(node => [node.node.id, node]))
  const rankOf = new Map<string, number>()
  for (const node of geometry.nodes) rankOf.set(node.node.id, node.rank)
  const slotOf = new Map<string, number>()
  for (const rank of geometry.ranks) rank.nodeIds.forEach((id, slot) => slotOf.set(id, slot))
  return { nodes, rankOf, slotOf }
}

function compareStable (order: OrderIndex, a: WorkflowEdge, b: WorkflowEdge): number {
  const aRank = order.rankOf.get(a.from) ?? 0
  const bRank = order.rankOf.get(b.from) ?? 0
  if (aRank !== bRank) return aRank - bRank
  const aSlot = order.slotOf.get(a.from) ?? 0
  const bSlot = order.slotOf.get(b.from) ?? 0
  if (aSlot !== bSlot) return aSlot - bSlot
  const aTarget = order.rankOf.get(a.to) ?? 0
  const bTarget = order.rankOf.get(b.to) ?? 0
  if (aTarget !== bTarget) return aTarget - bTarget
  const aTargetSlot = order.slotOf.get(a.to) ?? 0
  const bTargetSlot = order.slotOf.get(b.to) ?? 0
  if (aTargetSlot !== bTargetSlot) return aTargetSlot - bTargetSlot
  return 0
}

/**
 * 视觉种类判定（semantic-columns plan §4）。
 * 优先级定死：implicit > finalizer > data > guard > order-inline，表驱动 ——
 * 加一档必须补一行，不允许 if 链漏分支。invalid 由调用方在端口缺席时单独
 * 判定（非单调边不进端口表），不参与本表。
 */
const EDGE_KIND_PRIORITY: ReadonlyArray<{
  readonly kind: EdgeVisualKind;
  readonly when: (edge: WorkflowEdge, allDoneNodeIds: ReadonlySet<string>) => boolean;
}> = [
  { kind: 'implicit', when: edge => edge.origin === 'implicit' },
  { kind: 'finalizer', when: (edge, allDoneNodeIds) => allDoneNodeIds.has(edge.to) },
  { kind: 'data', when: edge => edge.refKinds.includes('input') },
  { kind: 'guard', when: edge => edge.refKinds.length > 0 },
  { kind: 'order-inline', when: () => true },
]

function visualKindOf (edge: WorkflowEdge, allDoneNodeIds: ReadonlySet<string>): EdgeVisualKind {
  for (const rule of EDGE_KIND_PRIORITY) {
    if (rule.when(edge, allDoneNodeIds)) return rule.kind
  }
  return 'order-inline'
}

export { visualKindOf }

function routeMonotoneEdge (
  edge: WorkflowEdge,
  assignment: PortAssignment,
  skeleton: readonly (readonly [number, number])[],
  geometry: RankGeometry,
  bands: Map<number, BandState>,
  nodeById: ReadonlyMap<string, RankedNode>,
  visualKind: EdgeVisualKind,
): RoutedEdge {
  const source = nodeById.get(edge.from)
  const target = nodeById.get(edge.to)
  if (source === undefined || target === undefined) {
    return degenerate(edge, visualKind, '端点节点缺失')
  }
  const sourcePort = portPoint(assignment.source)
  const targetPort = portPoint(assignment.target)

  // Band 链：sourceRank..targetRank-1（按 rank 索引取 Band，对扩层后的
  // y 位移免疫 —— 锚点只贡献 x（d3 虚拟节点 lane），y 不再参与判定）
  const bandList: Array<{ readonly index: number; readonly top: number; readonly bottom: number }> = []
  for (let rank = source.rank; rank < target.rank; rank += 1) {
    const band = geometry.bands[rank]
    if (band === undefined || band.index !== rank) {
      return degenerate(edge, visualKind, `Band ${rank} 缺失`)
    }
    bandList.push(band)
  }

  // 边界 stem x：band 边界 j ∈ [0, bandList.length]。两端是端口 x；
  // 中间边界优先用骨架虚拟节点 x（d3 保留的 lane），被挡时左右找空闲 lane
  const stemCount = bandList.length + 1
  const stemSpan = (j: number): readonly [number, number] => {
    if (j === 0) return [sourcePort[1], bandList[0]!.bottom]
    if (j === stemCount - 1) return [bandList[bandList.length - 1]!.top, targetPort[1]]
    return [bandList[j - 1]!.top, bandList[j]!.bottom]
  }
  const stems: number[] = []
  for (let j = 0; j < stemCount; j += 1) {
    if (j === stemCount - 1) {
      // ★ routing-polish §5.2：末 stem 钉死在 target 顶端口 x，不做端点逃逸。
      //   逃逸会在端口层生成水平 jog，箭头横向进入节点；换道只发生在
      //   目标上方的 Band 通道里（见下方 lastBandDropClear）。
      stems.push(targetPort[0])
      continue
    }
    const preferred = j === 0
      ? sourcePort[0]
      : (skeleton[j]?.[0] ?? sourcePort[0])
    const [spanTop, spanBottom] = stemSpan(j)
    // 来源侧 stem 的挪动会生成端口侧横向 jog（§4.4）：候选 x 必须同时保证
    // 垂直段与 jog 都不穿节点，否则逃逸位置会把污染转嫁给 jog（readability Plan §3.3 配套）
    const portJog = j === 0
      ? { y: sourcePort[1], portX: sourcePort[0] }
      : undefined
    stems.push(resolveStemX(preferred, spanTop, spanBottom, nodeById, source, target, portJog))
  }

  // 逐 Band 选通道；失败记 fallback 但继续（不抛异常，§4.6）。
  // ★ 末 Band 的候选通道还要满足「端口垂直末段」净空（routing-polish §5.2.4：
  //   通道换道让位，而不是把污染转嫁给节点边缘的水平 jog）。
  const lastBandDropClear = (y: number): boolean =>
    !verticalStemBlocked(targetPort[0], Math.min(y, targetPort[1]), Math.max(y, targetPort[1]), nodeById, source, target)
  const channels: number[] = []
  let fallbackKind: FallbackKind | undefined
  let fallbackReason: string | undefined
  for (let b = 0; b < bandList.length; b += 1) {
    const band = bandList[b]!
    const state = bands.get(band.index)!
    const stemA = stems[b]!
    const stemB = stems[b + 1]!
    const isLastBand = b === bandList.length - 1
    const channel = pickChannel(state, band, stemA, stemB, nodeById, source, target, isLastBand ? lastBandDropClear : undefined)
    if (isLastBand && channel === undefined) {
      // §5.2.5：固定末 stem 无合法通道 —— 先退「只保水平净空」的通道保住正交
      // 结构，末段垂直性受影响时计入 fallback，不抛异常、不退回水平 jog。
      const relaxed = pickChannel(state, band, stemA, stemB, nodeById, source, target)
      if (relaxed !== undefined) {
        channels.push(relaxed)
        if (!lastBandDropClear(relaxed)) {
          fallbackKind = fallbackKind ?? 'blocked'
          fallbackReason = fallbackReason ?? `末段垂直进入 ${edge.to} 的通道被占`
        }
        state.usedChannels.add(relaxed)
        state.reservations.push({ y: relaxed, minX: Math.min(stemA, stemB), maxX: Math.max(stemA, stemB) })
        continue
      }
    }
    if (channel === undefined) {
      fallbackKind = fallbackKind ?? 'band-exhausted'
      fallbackReason = fallbackReason ?? `Band ${band.index} 通道耗尽`
      state.exhausted += 1
      // 占用 Band 中央作为降级通道，后续边仍按占用规则避让
      const midY = (band.top + band.bottom) / 2
      channels.push(midY)
      state.usedChannels.add(midY)
      state.reservations.push({ y: midY, minX: Math.min(stemA, stemB), maxX: Math.max(stemA, stemB) })
      continue
    }
    channels.push(channel)
    state.usedChannels.add(channel)
    state.reservations.push({ y: channel, minX: Math.min(stemA, stemB), maxX: Math.max(stemA, stemB) })
  }

  // 组折线：port → [jog] → (V H)+ → [jog] → port
  const points: Array<readonly [number, number]> = [sourcePort]
  const emitJog = (x: number, y: number): void => {
    // 端口侧的横向挪动沿起止节点边缘走（§4.4 允许接触自身边界），
    // 但不允许穿过**其它**节点的扩展矩形
    if (horizontalHitsObstacle(y, points[points.length - 1]![0], x, nodeById, source, target)) {
      fallbackKind = fallbackKind ?? 'blocked'
      fallbackReason = fallbackReason ?? '端口挪动穿过其它节点'
    }
    pushPoint(points, [x, y])
  }

  for (let b = 0; b < bandList.length; b += 1) {
    const stemA = stems[b]!
    const stemB = stems[b + 1]!
    const channel = channels[b]!
    if (b === 0 && stemA !== sourcePort[0]) emitJog(stemA, sourcePort[1])
    pushPoint(points, [stemA, channel])
    pushPoint(points, [stemB, channel])
  }
  // ★ 末 stem 恒等于 targetPort[0]（上方钉死）：末点直接落端口，
  //   最后一段恒为垂直段（routing-polish §5.2.3）。目标侧没有 jog。
  pushPoint(points, targetPort)

  const merged = mergeCollinear(dedupe(points))
  if (merged.length < 2 || !isOrthogonal(merged)) {
    return degenerate(edge, visualKind, '路由产出退化')
  }
  return {
    edge,
    points: merged,
    segments: segmentsOf(merged),
    visualKind,
    fallback: fallbackKind !== undefined,
    ...(fallbackKind !== undefined ? { fallbackKind, fallbackReason: fallbackReason ?? '' } : {}),
  }
}

function degenerate (edge: WorkflowEdge, visualKind: EdgeVisualKind, reason: string): RoutedEdge {
  return {
    edge,
    points: [],
    segments: [],
    visualKind,
    fallback: true,
    fallbackKind: 'degenerate',
    ...(reason === '' ? {} : { fallbackReason: reason }),
  }
}

function portPoint (port: EdgePort): readonly [number, number] {
  return [port.x, port.y]
}

/**
 * Band 内选水平通道（§4.3 候选顺序）：midY 起左右交替扩张，吸附
 * ROUTE_CLEARANCE 网格；要求与 x 重叠的既有通道垂直距离 ≥ CHANNEL_GAP，
 * 且水平段不进任何非起止节点的扩展矩形。全失败 → undefined（上层计 fallback）。
 *
 * `extraClear`（routing-polish §5.2.4）：目标上方 Band 传入「通道 → 端口的
 * 垂直末段」净空判定 —— 换通道让位，而不是把污染转嫁给节点边缘水平 jog。
 */
function pickChannel (
  state: BandState,
  band: { readonly top: number; readonly bottom: number },
  stemA: number,
  stemB: number,
  nodeById: ReadonlyMap<string, RankedNode>,
  source: RankedNode,
  target: RankedNode,
  extraClear?: (y: number) => boolean,
): number | undefined {
  const hTop = band.top + ROUTE_CLEARANCE
  const hBottom = band.bottom - ROUTE_CLEARANCE
  if (hBottom - hTop < -RANK_EPSILON) return undefined
  const midY = (hTop + hBottom) / 2
  const slots = Math.max(1, Math.floor((hBottom - hTop) / CHANNEL_GAP) + 1)

  const minX = Math.min(stemA, stemB)
  const maxX = Math.max(stemA, stemB)
  for (let i = 0; i < slots * 2 + 1; i += 1) {
    // midY 起左右交替（§4.3 候选通道顺序）
    const offset = i === 0 ? 0 : Math.ceil(i / 2) * CHANNEL_GAP * (i % 2 === 1 ? 1 : -1)
    const y = midY + offset
    if (y < hTop - RANK_EPSILON || y > hBottom + RANK_EPSILON) continue
    if (channelConflicts(state.reservations, y, minX, maxX)) continue
    if (horizontalHitsObstacle(y, minX, maxX, nodeById, source, target)) continue
    if (extraClear !== undefined && !extraClear(y)) continue
    return y
  }
  return undefined
}

/** 与重叠 x 区间的已有通道垂直距离 ≥ CHANNEL_GAP（§4.3）。 */
function channelConflicts (reservations: readonly ChannelReservation[], y: number, minX: number, maxX: number): boolean {
  for (const reservation of reservations) {
    const overlaps = maxX >= reservation.minX && minX <= reservation.maxX
    if (!overlaps) continue
    if (Math.abs(reservation.y - y) < CHANNEL_GAP - RANK_EPSILON) return true
  }
  return false
}

/** 水平段不进入非起止节点的扩展矩形（§4.3/§4.4）。 */
function horizontalHitsObstacle (
  y: number,
  x1: number,
  x2: number,
  nodeById: ReadonlyMap<string, RankedNode>,
  source: RankedNode,
  target: RankedNode,
): boolean {
  const minX = Math.min(x1, x2)
  const maxX = Math.max(x1, x2)
  for (const node of nodeById.values()) {
    if (node.node.id === source.node.id || node.node.id === target.node.id) continue
    const obstacle = obstacleOf(node)
    if (y < obstacle.top - RANK_EPSILON || y > obstacle.bottom + RANK_EPSILON) continue
    if (maxX < obstacle.left - RANK_EPSILON || minX > obstacle.right + RANK_EPSILON) continue
    return true
  }
  return false
}

/**
 * stem x 选择：锚点 x 被非起止节点挡住时按步长左右找空闲 lane（§4.4）。
 * 检查范围 = 该 stem 实际承担的垂直区间；端口侧挪动沿节点边缘另行检查。
 * 两端 stem 传 `portJog` 时，候选 x 与端口的横向 jog 也必须无障碍 ——
 * stem 逃逸不能把穿越转嫁给端口挪动段。
 */
function resolveStemX (
  preferred: number,
  spanTop: number,
  spanBottom: number,
  nodeById: ReadonlyMap<string, RankedNode>,
  source: RankedNode,
  target: RankedNode,
  portJog?: { readonly y: number; readonly portX: number },
): number {
  const blocked = (x: number): boolean => {
    if (verticalStemBlocked(x, spanTop, spanBottom, nodeById, source, target)) return true
    return portJog !== undefined
      && x !== portJog.portX
      && horizontalHitsObstacle(portJog.y, portJog.portX, x, nodeById, source, target)
  }
  if (!blocked(preferred)) return preferred
  for (let offset = STEM_STEP; offset <= STEM_SEARCH_LIMIT; offset += STEM_STEP) {
    if (!blocked(preferred + offset)) return preferred + offset
    if (!blocked(preferred - offset)) return preferred - offset
  }
  return preferred
}

/** 垂直段不穿过非起止节点（§4.3/§4.4）；起止节点自身允许端口侧接触。 */
function verticalStemBlocked (
  x: number,
  y1: number,
  y2: number,
  nodeById: ReadonlyMap<string, RankedNode>,
  source: RankedNode,
  target: RankedNode,
): boolean {
  const minY = Math.min(y1, y2)
  const maxY = Math.max(y1, y2)
  for (const node of nodeById.values()) {
    if (node.node.id === source.node.id || node.node.id === target.node.id) continue
    const obstacle = obstacleOf(node)
    if (x < obstacle.left - RANK_EPSILON || x > obstacle.right + RANK_EPSILON) continue
    if (maxY < obstacle.top - RANK_EPSILON || minY > obstacle.bottom + RANK_EPSILON) continue
    return true
  }
  return false
}

/**
 * rail 成员边的专用干道路由（routing-polish §6 固定最简路径）：
 *
 * ```text
 * source bottom port
 *         ↓
 * source 下方 Band 通道
 *         └────────→ shared trunk
 *                           ↓
 * target 上方 Band 通道 ←──┘
 *         ↓
 * target top port（垂直进入，§5.1 与全部合法边一致）
 * ```
 *
 * - 最多 5 段 / 4 拐；出口 Band = 入口 Band（相邻层收尾）时合并为一条通道，
 *   路径退化为 ↓←↓（3 段 2 拐）—— 从前的「干道上两条通道间短竖折返」
 *   就是视觉多段绕行的来源（§6.1）。
 * - 端口用 assignPorts 的正式分配（来源底部端口按目标 x 分布、目标顶部
 *   端口按来源 x 分布）—— 多条 rail 边不再叠在同一点上。
 * - 干道 x 固定（rail 列右缘 + 间距），全部 rail 边共用（§6.3.2：通道与
 *   普通边共用 BandState.reservations）。
 * - 干道/横向段/末段不得穿任何非起止节点（含净空）；不满足回 null →
 *   调用方回退常规路由并计 fallback。
 */
function routeRailEdge (
  edge: WorkflowEdge,
  assignment: PortAssignment,
  geometry: RankGeometry,
  bands: Map<number, BandState>,
  nodeById: ReadonlyMap<string, RankedNode>,
  trunkX: number,
  visualKind: EdgeVisualKind,
): RoutedEdge | null {
  const source = nodeById.get(edge.from)
  const target = nodeById.get(edge.to)
  if (source === undefined || target === undefined) return null
  if (target.rank <= source.rank) return null

  const startPort = portPoint(assignment.source)
  const endPort = portPoint(assignment.target)
  const exitBand = geometry.bands[source.rank]
  const entryBand = geometry.bands[target.rank - 1]
  if (exitBand === undefined || entryBand === undefined) return null

  // 末段（通道 → 目标顶端口）的垂直净空判定（§5.2.4 同款）
  const dropClear = (y: number): boolean =>
    !verticalStemBlocked(endPort[0], Math.min(y, endPort[1]), Math.max(y, endPort[1]), nodeById, source, target)

  let exitY: number | undefined
  let entryY: number | undefined
  if (exitBand.index === entryBand.index) {
    // 相邻层收尾：一条通道同时承担出口与入口，水平段是贯穿的
    // source.x → trunkX → endPort.x（trunkX 在两点之间，折线自然合并共线）。
    const y = pickChannel(bands.get(exitBand.index)!, exitBand, startPort[0], endPort[0], nodeById, source, target, dropClear)
    if (y === undefined) return null
    exitY = y
    entryY = y
  } else {
    exitY = pickChannel(bands.get(exitBand.index)!, exitBand, startPort[0], trunkX, nodeById, source, target)
    if (exitY === undefined) return null
    entryY = pickChannel(bands.get(entryBand.index)!, entryBand, trunkX, endPort[0], nodeById, source, target, dropClear)
    if (entryY === undefined) return null
  }

  const reserve = (band: RoutingBand, y: number, minX: number, maxX: number): void => {
    bands.get(band.index)!.reservations.push({ y, minX: Math.min(minX, maxX), maxX: Math.max(minX, maxX) })
    bands.get(band.index)!.usedChannels.add(y)
  }
  if (exitBand.index === entryBand.index) {
    reserve(exitBand, exitY, startPort[0], endPort[0])
  } else {
    reserve(exitBand, exitY, startPort[0], trunkX)
    reserve(entryBand, entryY, trunkX, endPort[0])
  }

  // 合法性：干道竖直段不穿非起止节点；末段净空已由 dropClear 保证
  if (verticalStemBlocked(trunkX, Math.min(exitY, entryY), Math.max(exitY, entryY), nodeById, source, target)) return null

  const points: Array<readonly [number, number]> = [
    startPort,
    [startPort[0], exitY],
    [trunkX, exitY],
    [trunkX, entryY],
    [endPort[0], entryY],
    endPort,
  ]
  const merged = mergeCollinear(dedupe(points))
  if (merged.length < 2 || !isOrthogonal(merged)) return null
  return {
    edge,
    points: merged,
    segments: segmentsOf(merged),
    visualKind,
    fallback: false,
  }
}

/** 非单调边：右侧错误 gutter（§3.4），红色虚线帮助定位与删除。 */
function routeInvalidEdge (edge: WorkflowEdge, nodeById: ReadonlyMap<string, RankedNode>): RoutedEdge {
  const source = nodeById.get(edge.from)
  const target = nodeById.get(edge.to)
  if (source === undefined || target === undefined) {
    return degenerate(edge, 'invalid', '端点节点缺失')
  }
  const halfWidth = NODE_WIDTH / 2
  let rightmost = 0
  for (const node of nodeById.values()) rightmost = Math.max(rightmost, node.x + halfWidth)
  const gutterX = rightmost + GUTTER_OFFSET
  const points: Array<readonly [number, number]> = [
    [source.x + halfWidth, source.y],
    [gutterX, source.y],
    [gutterX, target.y],
    [target.x + halfWidth, target.y],
  ]
  const merged = mergeCollinear(dedupe(points))
  return {
    edge,
    points: merged,
    segments: segmentsOf(merged),
    visualKind: 'invalid',
    fallback: false,
  }
}

/** 折线 → 正交段列表（相邻点必共轴）。 */
export function segmentsOf (points: readonly (readonly [number, number])[]): readonly OrthogonalSegment[] {
  const segments: OrthogonalSegment[] = []
  for (let i = 0; i + 1 < points.length; i += 1) {
    const [x1, y1] = points[i]!
    const [x2, y2] = points[i + 1]!
    segments.push({
      orientation: Math.abs(y1 - y2) <= RANK_EPSILON ? 'h' : 'v',
      x1,
      y1,
      x2,
      y2,
    })
  }
  return segments
}

function isOrthogonal (points: readonly (readonly [number, number])[]): boolean {
  for (let i = 0; i + 1 < points.length; i += 1) {
    const [x1, y1] = points[i]!
    const [x2, y2] = points[i + 1]!
    const sameX = Math.abs(x1 - x2) <= RANK_EPSILON
    const sameY = Math.abs(y1 - y2) <= RANK_EPSILON
    if (!sameX && !sameY) return false
  }
  return true
}

function pushPoint (into: Array<readonly [number, number]>, point: readonly [number, number]): void {
  const last = into.at(-1)
  if (last !== undefined && Math.abs(last[0] - point[0]) <= RANK_EPSILON && Math.abs(last[1] - point[1]) <= RANK_EPSILON) return
  into.push(point)
}

function dedupe (points: readonly (readonly [number, number])[]): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = []
  for (const point of points) {
    const last = out.at(-1)
    if (last !== undefined && Math.abs(last[0] - point[0]) <= RANK_EPSILON && Math.abs(last[1] - point[1]) <= RANK_EPSILON) continue
    out.push(point)
  }
  return out
}

/** 相邻共线点合并（§4.2）。 */
function mergeCollinear (points: readonly (readonly [number, number])[]): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = []
  for (const point of points) {
    if (out.length >= 2) {
      const a = out[out.length - 2]!
      const b = out[out.length - 1]!
      const collinear
        = (Math.abs(a[0] - b[0]) <= RANK_EPSILON && Math.abs(b[0] - point[0]) <= RANK_EPSILON)
          || (Math.abs(a[1] - b[1]) <= RANK_EPSILON && Math.abs(b[1] - point[1]) <= RANK_EPSILON)
      if (collinear) {
        out[out.length - 1] = point
        continue
      }
    }
    out.push(point)
  }
  return out
}
