// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 工作流 DAG 画布：SVG 自绘节点与正交连线（DAG 正交连线 Plan §4/§5/§6）。
 *
 * 只管「画 + 交互」，不碰文件读写与校验 —— 那些由 {@link ../app.js} 编排。
 * 几何管线在 {@link composeCanvasLayout}（纯函数）：d3-dag 分层 → Rank/Band →
 * 收尾侧移 → 端口 → 正交通道路由。渲染与选中/悬停只切换 class，不重建
 * DOM（Plan §5.2）；拓扑变化才整帧重画。
 *
 * 回退开关（Plan §10）：routingMode 可切回 legacy-smooth（贝塞尔）对比一轮。
 */

import { TRIGGER_NODE_ID } from '../../../../../src/workflow/core/model.js'
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from '../../../../../src/workflow/core/model.js'
import type { BindingState, NodeBindingStatus } from '../../../../../src/workflow/core/binding-status.js'
import type { SemanticIssue } from '../semantics.js'
import { PALETTE_MIME, SCRIPT_MIME } from '../store.js'
import { NODE_HEIGHT, NODE_WIDTH, buildSkeletons, edgeKeyOf, layoutWorkflow } from './layout.js'
import type { NodePresentation } from './semantic-role.js'
import { TRAIT_LABELS, TRIGGER_LABEL, displayTraits, nodeDisplayName } from './semantic-role.js'
import { buildRanks, expandBands, normalizeGeometry } from './ranks.js'
import type { RankGeometry } from './ranks.js'
import type { PortResult } from './ports.js'
import type { EdgeVisualKind, RoutedEdge } from './routing.js'
import { routeEdges, visualKindOf } from './routing.js'
import { orthogonalPath, previewPath } from './edge-path.js'
import { buildFocusIndex, computeEdgeFocusState } from './focus.js'
import type { FocusIndex } from './focus.js'
import { computeOrderingHints, orderingBadgeText, orderingBadgeTooltip } from './ordering.js'
import { applySemanticColumns } from './columns.js'
import type { OrderingHints } from './ordering.js'
import { CanvasInteraction } from './interaction.js'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 路由模式（Plan §10 回退开关）：legacy 一轮回归周期后删除。 */
export type EdgeRoutingMode = 'legacy-smooth' | 'orthogonal-v1'

export const DEFAULT_ROUTING_MODE: EdgeRoutingMode = 'orthogonal-v1'

export interface CanvasOptions {
  readonly onSelect: (nodeId: string | null) => void;
  /** 在节点上右键。 */
  readonly onNodeContextMenu: (nodeId: string, x: number, y: number) => void;
  /** 在空白处右键。 */
  readonly onBlankContextMenu: (x: number, y: number) => void;
  /** 拖拽一个节点到另一个节点上，请求连边。 */
  readonly onConnect: (from: string, to: string) => void;
  readonly onEdgeContextMenu: (from: string, to: string, x: number, y: number) => void;
  /**
   * 从左侧面板拖了一个条目进来。
   * `upstream` 非空 = 落在某个节点上，要建成它的下游（写进 needs）。
   * `scriptId` 非空 = 拖的是业务功能条目（调用它，而不是弹选择框）。
   */
  readonly onDropAction: (action: string, upstream?: string, scriptId?: string) => void;
  /** 路由模式（默认 orthogonal-v1；开发对比期可切 legacy-smooth）。 */
  readonly routingMode?: EdgeRoutingMode;
  /**
   * 次要顺序边呈现模式（ordering plan §4.3）：
   * - `demoted`（默认）：纯顺序边不进路由器，降级为节点角标 + 按需点线。
   * - `inline`：全部边照旧布线（回归对比期保留，一个周期后删除）。
   */
  readonly orderingEdgeMode?: 'inline' | 'demoted';
}

const EMPTY_ORDERING: OrderingHints = { demoted: new Set<string>(), afterBadges: new Map<string, readonly string[]>() }

export interface ComposedCanvasModel {
  readonly mode: EdgeRoutingMode;
  /** 最终节点几何（legacy 模式下为 d3 原样坐标的 Rank 包装）。 */
  readonly geometry: RankGeometry;
  readonly routedEdges: readonly RoutedEdge[];
  readonly ports: PortResult | null;
  readonly width: number;
  readonly height: number;
  readonly fallbackCount: number;
  /** 顺序边降级提示（demoted 模式下生效；inline 模式为空集）。 */
  readonly ordering: OrderingHints;
  /** 收尾 rail 成员节点 id（semantic-columns §5.3；空集 = 无 rail）。 */
  readonly railNodeIds: ReadonlySet<string>;
}

/**
 * 几何管线（纯函数）：
 * d3-dag → Rank 聚类 → 三列语义布局（主链/状态链/收尾 rail，semantic-columns
 * plan §5）→ 归一化 → 端口 + 正交路由（rail 边走专用干道）；Band 通道耗尽时
 * 扩层后重路由一次（Plan §2.3「不静默穿节点」）。
 * 次要顺序边（ordering plan §4）默认不进入路由器：端口不占名额、Band 不占
 * 通道 —— 降级只影响布线，buildFocusIndex 仍基于完整边集。
 */
export function composeCanvasLayout (
  model: WorkflowGraph,
  presentations: ReadonlyMap<string, NodePresentation>,
  options: { readonly routingMode: EdgeRoutingMode; readonly orderingEdgeMode?: 'inline' | 'demoted' },
): ComposedCanvasModel {
  const ordering = options.orderingEdgeMode === 'inline'
    ? EMPTY_ORDERING
    : computeOrderingHints(model)
  const layout = layoutWorkflow(model)
  if (model.nodes.length === 0 || layout.nodes.length === 0) {
    return {
      mode: options.routingMode,
      geometry: { nodes: [], ranks: [], bands: [], width: 0, height: 0 },
      routedEdges: [],
      ports: null,
      width: 0,
      height: 0,
      fallbackCount: 0,
      ordering,
      railNodeIds: new Set<string>(),
    }
  }

  const allDoneNodeIds = new Set(model.nodes
    .filter(node => node.triggerMode === 'allDone')
    .map(node => node.id))

  if (options.routingMode === 'legacy-smooth') {
    return composeLegacy(layout, model, allDoneNodeIds)
  }

  // 布线子集：被降级的顺序边不进端口分配与路由器（ordering plan §4.2）。
  const routableEdges = ordering.demoted.size === 0
    ? model.edges
    : model.edges.filter(edge => !ordering.demoted.has(edgeKeyOf(edge.from, edge.to)))

  const skeletons = buildSkeletons(layout)
  let geometry = buildRanks(layout.nodes)
  // ★ 状态链识别需要降级边（它们是链的连接件），传完整边集；
  //   rail/主链判定同样基于完整图。
  const columned = applySemanticColumns(geometry, presentations, model.edges, ordering)
  geometry = columned.geometry
  const rail = columned.layout.railNodeIds.length > 0
    ? { nodeIds: new Set(columned.layout.railNodeIds), trunkX: columned.layout.railTrunkX }
    : undefined
  const normalized = normalizeGeometry(geometry)
  geometry = normalized.geometry
  const shiftedSkeletons = shiftSkeletons(skeletons, normalized.dx, normalized.dy)
  const shiftedRail = rail === undefined
    ? undefined
    : { nodeIds: rail.nodeIds, trunkX: rail.trunkX + normalized.dx }

  let result = routeEdges({ edges: routableEdges, geometry, skeletons: shiftedSkeletons, allDoneNodeIds, ...(shiftedRail === undefined ? {} : { rail: shiftedRail }) })
  // 通道耗尽 → 扩层重排（Plan §2.3「不允许路由穿节点来保持紧凑」）。
  // 每轮按 used + exhausted + 1 档余量扩；上限 3 轮防御性收敛（同输入确定性）。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const exhausted = result.exhaustedPerBand.reduce((sum, count) => sum + count, 0)
    if (exhausted === 0) break
    const required = result.usedSlotsPerBand.map((used, index) =>
      Math.max(used + (result.exhaustedPerBand[index] ?? 0) + 1, 1))
    geometry = expandBands(geometry, required)
    result = routeEdges({ edges: routableEdges, geometry, skeletons: shiftedSkeletons, allDoneNodeIds, ...(shiftedRail === undefined ? {} : { rail: shiftedRail }) })
  }

  return {
    mode: options.routingMode,
    geometry,
    routedEdges: result.routed,
    ports: result.ports,
    width: geometry.width,
    height: geometry.height,
    fallbackCount: result.routed.filter(edge => edge.fallback).length,
    ordering,
    railNodeIds: new Set(rail === undefined ? [] : rail.nodeIds),
  }
}

function composeLegacy (
  layout: ReturnType<typeof layoutWorkflow>,
  model: WorkflowGraph,
  allDoneNodeIds: ReadonlySet<string>,
): ComposedCanvasModel {
  // legacy 模式：d3 坐标原样使用，边为贝塞尔骨架（旧 edgePath 行为）；
  // 顺序边降级对 legacy 不生效 —— 它是对照模式，保持旧行为完整。
  const ranked = layout.nodes.map((item, index) => ({
    node: item.node,
    x: item.x,
    y: item.y,
    rank: index,
  }))
  const geometry = buildLegacyGeometry(ranked)
  const routed: RoutedEdge[] = layout.edges.map(item => ({
    edge: item.edge,
    points: item.points,
    segments: [],
    visualKind: visualKindOfLegacy(item.edge, allDoneNodeIds),
    fallback: false,
  }))
  return {
    mode: 'legacy-smooth',
    geometry,
    routedEdges: routed,
    ports: null,
    width: layout.width,
    height: layout.height,
    fallbackCount: 0,
    ordering: EMPTY_ORDERING,
    railNodeIds: new Set<string>(),
  }
}

/** legacy 模式只需要节点位置表；Rank 结构退化为每节点一层（无 Band 语义）。 */
function buildLegacyGeometry (nodes: readonly { readonly node: WorkflowNode; readonly x: number; readonly y: number }[]): RankGeometry {
  return {
    nodes: nodes.map((item, index) => ({ node: item.node, x: item.x, y: item.y, rank: index })),
    ranks: [],
    bands: [],
    width: 0,
    height: 0,
  }
}

function shiftSkeletons (
  skeletons: ReadonlyMap<string, readonly (readonly [number, number])[]>,
  dx: number,
  dy: number,
): ReadonlyMap<string, readonly (readonly [number, number])[]> {
  if (dx === 0 && dy === 0) return skeletons
  const shifted = new Map<string, readonly (readonly [number, number])[]>()
  for (const [key, points] of skeletons) {
    shifted.set(key, points.map(([x, y]) => [x + dx, y + dy] as const))
  }
  return shifted
}

export class WorkflowCanvas {
  private readonly host: HTMLElement
  private readonly options: CanvasOptions
  private readonly svg: SVGSVGElement
  private readonly viewportGroup: SVGGElement
  private readonly edgeLayer: SVGGElement
  private readonly nodeLayer: SVGGElement
  private readonly linkPreview: SVGPathElement
  private readonly zoomLabel: HTMLElement
  private readonly interaction: CanvasInteraction
  /** 降级顺序边的临时点线图层（选中/悬停端点时按需出现，不占通道）。 */
  private readonly demotedLayer: SVGGElement
  private composed: ComposedCanvasModel = {
    mode: DEFAULT_ROUTING_MODE,
    geometry: { nodes: [], ranks: [], bands: [], width: 0, height: 0 },
    routedEdges: [],
    ports: null,
    width: 0,
    height: 0,
    fallbackCount: 0,
    ordering: { demoted: new Set<string>(), afterBadges: new Map<string, readonly string[]>() },
    railNodeIds: new Set<string>(),
  }

  private model: WorkflowGraph | null = null
  private focusIndex: FocusIndex | null = null
  /** 节点 id → 该节点的语义问题计数，驱动卡片右上角的红/黄点。 */
  private issueCounts = new Map<string, { errors: number; warnings: number }>()
  /** 节点 id → 绑定完整度（计划 §E5 的五档）。 */
  private bindingStates = new Map<string, BindingState>()
  private presentations = new Map<string, NodePresentation>()
  private selected: string | null = null
  /** 悬停高亮的边（edgeKey → 可见 path / 两端节点组）。 */
  private hoveredEdge: { key: string; path: SVGPathElement; from: string; to: string } | null = null

  constructor (host: HTMLElement, options: CanvasOptions) {
    this.host = host
    this.options = options

    this.svg = document.createElementNS(SVG_NS, 'svg')
    this.svg.setAttribute('class', 'wf-svg')
    this.svg.append(createDefs())

    this.viewportGroup = document.createElementNS(SVG_NS, 'g')
    this.edgeLayer = document.createElementNS(SVG_NS, 'g')
    this.nodeLayer = document.createElementNS(SVG_NS, 'g')
    this.demotedLayer = document.createElementNS(SVG_NS, 'g')
    this.demotedLayer.setAttribute('class', 'wf-demoted-layer')
    this.linkPreview = document.createElementNS(SVG_NS, 'path')
    this.linkPreview.setAttribute('class', 'wf-link-preview')
    this.viewportGroup.append(this.edgeLayer, this.demotedLayer, this.linkPreview, this.nodeLayer)
    this.svg.append(this.viewportGroup)

    this.zoomLabel = document.createElement('div')
    this.zoomLabel.className = 'wf-zoom-label'

    host.replaceChildren(this.svg, this.zoomLabel)

    this.interaction = new CanvasInteraction({
      size: () => {
        const box = this.host.getBoundingClientRect()
        return { width: box.width, height: box.height }
      },
      hitTest: (x, y) => this.nodeIdAt(x, y),
      onViewportChange: () => this.applyViewport(),
      onLinkPreview: (from, pointer) => this.updateLinkPreview(from, pointer),
      onLinkCommit: (from, targetId) => this.commitLink(from, targetId),
      onBlankPress: () => {
        if (this.selected !== null) {
          this.selected = null
          this.select(null)
          this.options.onSelect(null)
        }
      },
    })

    this.wireInteraction()
    this.applyViewport()
  }

  render (
    model: WorkflowGraph,
    presentations: ReadonlyMap<string, NodePresentation>,
    issues: readonly SemanticIssue[] = [],
    bindings: readonly NodeBindingStatus[] = [],
  ): void {
    // 绑定状态比「有几个 error/warning」更有信息量：它区分「契约没解开」
    // 与「必填没接」与「接了但可能取不到值」—— 三者的下一步动作完全不同。
    this.bindingStates = new Map(bindings.map(status => [status.nodeId, status.state]))
    this.issueCounts = new Map()
    for (const issue of issues) {
      const current = this.issueCounts.get(issue.nodeId) ?? { errors: 0, warnings: 0 }
      if (issue.level === 'error') current.errors += 1
      else current.warnings += 1
      this.issueCounts.set(issue.nodeId, current)
    }
    this.model = model
    this.presentations = new Map(presentations)

    // 仅拓扑变化时重建聚焦索引（Plan §5.1）；选中变化不重布局/重路由。
    // ★ 降级只影响渲染不影响聚焦：索引始终基于完整边集（ordering plan §4.4）。
    this.focusIndex = buildFocusIndex(model)
    this.composed = composeCanvasLayout(model, this.presentations, {
      routingMode: this.options.routingMode ?? DEFAULT_ROUTING_MODE,
      orderingEdgeMode: this.options.orderingEdgeMode ?? 'demoted',
    })
    this.draw()
  }

  get selectedId (): string | null {
    return this.selected
  }

  /**
   * 选中节点：只切换 class（§5.2）。选中后按 direct/transitive/unrelated
   * 三档突出关联路径、压低无关边（§1.3）；null 恢复全部。
   */
  select (nodeId: string | null): void {
    this.selected = nodeId
    for (const element of this.nodeLayer.querySelectorAll('.wf-node')) {
      element.classList.toggle('selected', element.getAttribute('data-id') === nodeId)
    }
    this.applyFocusClasses(nodeId)
  }

  /** 把某个节点滚进可视区（新增步骤后必须调用）。已在视口内则不动。 */
  revealNode (nodeId: string): void {
    const target = this.nodePosition(nodeId)
    if (target === undefined || target === null) return
    this.interaction.reveal(target, { x: (NODE_WIDTH / 2) + 16, y: (NODE_HEIGHT / 2) + 16 })
  }

  /** 缩放到「整图可见」。布局为空时退回 1:1，避免除零。 */
  fit (): void {
    this.interaction.fit(this.composed.width, this.composed.height)
  }

  zoomBy (factor: number): void {
    this.interaction.zoomBy(factor)
  }

  resetZoom (): void {
    this.interaction.resetZoom()
  }

  // ── 绘制 ────────────────────────────────────────

  private draw (): void {
    this.edgeLayer.replaceChildren()
    this.nodeLayer.replaceChildren()
    this.demotedLayer.replaceChildren()
    this.hoveredEdge = null

    const nodeById = new Map(this.composed.geometry.nodes.map(item => [item.node.id, item]))
    for (const routed of this.composed.routedEdges) {
      this.edgeLayer.append(this.createEdge(routed, nodeById))
    }
    for (const item of this.composed.geometry.nodes) {
      this.nodeLayer.append(this.createNode(item.node, item.x, item.y))
    }
    this.select(this.selected)
  }

  private edgePathD (routed: RoutedEdge): string {
    if (this.composed.mode === 'legacy-smooth') return legacyBezierPath(routed.points)
    return orthogonalPath(routed.points)
  }

  private createEdge (
    routed: RoutedEdge,
    nodeById: ReadonlyMap<string, { node: WorkflowNode; x: number; y: number }>,
  ): SVGGElement {
    const group = document.createElementNS(SVG_NS, 'g')
    const key = edgeKeyOf(routed.edge.from, routed.edge.to)
    const d = this.edgePathD(routed)

    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('class', `wf-edge wf-edge-kind-${routed.visualKind}${routed.fallback ? ' routing-fallback' : ''}`)
    path.setAttribute('d', d)
    path.setAttribute('marker-end', markerIdOf(routed.visualKind))
    // §5.2：selection/hover 只切换 class；data-* 是稳定的寻址锚点
    path.setAttribute('data-from', routed.edge.from)
    path.setAttribute('data-to', routed.edge.to)
    path.setAttribute('data-kind', routed.visualKind)
    // routing-polish §8：浏览器验收锚点 —— 拐弯数 / 末段方向 / 降级标记
    path.setAttribute('data-bends', String(Math.max(0, routed.points.length - 2)))
    path.setAttribute('data-last-seg', routed.segments.at(-1)?.orientation ?? '')
    path.setAttribute('data-fallback', routed.fallback ? 'true' : 'false')
    if (routed.fallback && routed.fallbackReason !== undefined && routed.fallbackReason !== '') {
      const title = document.createElementNS(SVG_NS, 'title')
      title.textContent = `路由降级：${routed.fallbackReason}`
      path.append(title)
    }
    group.append(path)

    // 细线难点中，叠一条透明宽线专门吃指针事件；可见路径与 hit path 共用
    // 同一 points/path（Plan §10 命中不回归）
    const hit = document.createElementNS(SVG_NS, 'path')
    hit.setAttribute('class', 'wf-edge-hit')
    hit.setAttribute('d', d)
    hit.setAttribute('data-from', routed.edge.from)
    hit.setAttribute('data-to', routed.edge.to)
    const tooltip = document.createElementNS(SVG_NS, 'title')
    tooltip.textContent = edgeTooltip(routed, nodeById)
    hit.append(tooltip)
    hit.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.options.onEdgeContextMenu(routed.edge.from, routed.edge.to, event.clientX, event.clientY)
    })
    // §5.3：Hover 边只临时高亮该边和两个端点，不改 selection
    hit.addEventListener('pointerenter', () => this.setEdgeHover(key, path, routed.edge.from, routed.edge.to))
    hit.addEventListener('pointerleave', () => this.setEdgeHover(null))
    group.append(hit)
    return group
  }

  private setEdgeHover (
    key: string | null,
    path?: SVGPathElement,
    from?: string,
    to?: string,
  ): void {
    if (this.hoveredEdge !== null) {
      this.hoveredEdge.path.classList.remove('wf-edge-hover')
      for (const id of [this.hoveredEdge.from, this.hoveredEdge.to]) {
        this.nodeLayer.querySelector(`.wf-node[data-id="${cssEscape(id)}"]`)?.classList.remove('hover-endpoint')
      }
      this.hoveredEdge = null
    }
    if (key === null || path === undefined || from === undefined || to === undefined) return
    path.classList.add('wf-edge-hover')
    for (const id of [from, to]) {
      this.nodeLayer.querySelector(`.wf-node[data-id="${cssEscape(id)}"]`)?.classList.add('hover-endpoint')
    }
    this.hoveredEdge = { key, path, from, to }
  }

  private createNode (node: WorkflowNode, cx: number, cy: number): SVGGElement {
    const group = document.createElementNS(SVG_NS, 'g')
    const isTrigger = node.kind === 'trigger'
    const presentation = this.presentations.get(node.id)
    const counts = this.issueCounts.get(node.id)
    const severity = counts === undefined
      ? ''
      : counts.errors > 0 ? ' has-error' : counts.warnings > 0 ? ' has-warning' : ''
    const waitTrait = presentation?.traits.includes('wait') === true ? ' wf-node-wait' : ''
    group.setAttribute('class', `wf-node wf-node-${node.kind}${severity}${waitTrait}`)
    group.setAttribute('data-id', node.id)
    group.setAttribute('data-role', presentation?.role ?? (isTrigger ? 'trigger' : 'step'))
    if (presentation !== undefined && presentation.traits.length > 0) {
      group.setAttribute('data-traits', presentation.traits.join(' '))
    }
    // 绑定状态挂成 data 属性：样式与 e2e 都按它取，不必解析 class 串。
    const bindingState = this.bindingStates.get(node.id)
    if (bindingState !== undefined) group.setAttribute('data-binding-state', bindingState)
    group.setAttribute('transform', `translate(${cx - NODE_WIDTH / 2}, ${cy - NODE_HEIGHT / 2})`)

    const box = document.createElementNS(SVG_NS, 'rect')
    box.setAttribute('class', 'wf-node-box')
    box.setAttribute('width', String(NODE_WIDTH))
    box.setAttribute('height', String(NODE_HEIGHT))
    box.setAttribute('rx', '8')
    group.append(box)

    const title = document.createElementNS(SVG_NS, 'text')
    title.setAttribute('class', 'wf-node-title')
    title.setAttribute('x', '12')
    title.setAttribute('y', '24')
    title.textContent = truncate(isTrigger ? TRIGGER_LABEL : node.id, 22)
    group.append(title)

    const subtitle = document.createElementNS(SVG_NS, 'text')
    subtitle.setAttribute('class', 'wf-node-subtitle')
    subtitle.setAttribute('x', '12')
    subtitle.setAttribute('y', '43')
    subtitle.textContent = truncate(node.action === '' ? '（未设置）' : node.action, 24)
    group.append(subtitle)

    // 语义徽标（Plan §1.1）：wait/callback/conditional/all-done 的中文短语。
    // terminal-finalizer 是内部布局 Trait，不参与徽标（readability Plan §3.4）。
    const shownTraits = presentation === undefined ? [] : displayTraits(presentation.traits)
    if (shownTraits.length > 0) {
      const traits = document.createElementNS(SVG_NS, 'text')
      traits.setAttribute('class', 'wf-node-traits')
      traits.setAttribute('x', String(NODE_WIDTH - 12))
      traits.setAttribute('y', '24')
      traits.setAttribute('text-anchor', 'end')
      traits.textContent = shownTraits.map(trait => TRAIT_LABELS[trait]).join(' · ')
      group.append(traits)
    }

    if (node.refs.length > 0) {
      const badge = document.createElementNS(SVG_NS, 'text')
      badge.setAttribute('class', 'wf-node-badge')
      badge.setAttribute('x', String(NODE_WIDTH - 12))
      badge.setAttribute('y', '43')
      badge.setAttribute('text-anchor', 'end')
      badge.textContent = `${node.refs.length} 入参`
      group.append(badge)
    }

    // 顺序依赖角标（ordering plan §4.2 + semantic-columns §6）：降级的 needs
    // 不画线，画在目标节点上。超宽截 id 不截句尾；完整来源列表进 tooltip
    // （触屏拿不到 hover，Inspector 同文案兜底）。点击即选中来源节点。
    const afterIds = this.composed.ordering.afterBadges.get(node.id)
    if (afterIds !== undefined && afterIds.length > 0) {
      // 10px 字号下汉字约 10px、ASCII 约 5.5px；预算按（宽−左右 padding）/10 保守
      const budget = (NODE_WIDTH - 24) / 10
      const badgeGroup = document.createElementNS(SVG_NS, 'g')
      badgeGroup.setAttribute('class', 'wf-ordering-badge')
      badgeGroup.setAttribute('data-after', afterIds.join(' '))
      const badge = document.createElementNS(SVG_NS, 'text')
      badge.setAttribute('class', 'wf-ordering-badge-text')
      badge.setAttribute('x', '12')
      badge.setAttribute('y', String(NODE_HEIGHT - 6))
      badge.textContent = orderingBadgeText(node.triggerMode, afterIds, budget)
      const tooltip = document.createElementNS(SVG_NS, 'title')
      tooltip.textContent = `${orderingBadgeTooltip(afterIds)}。点击角标选中来源节点；选中本节点时以点线显示该依赖。`
      badgeGroup.append(badge, tooltip)
      badgeGroup.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return
        event.stopPropagation()
        this.selected = afterIds[0]!
        this.select(afterIds[0]!)
        this.options.onSelect(afterIds[0]!)
      })
      group.append(badgeGroup)
    }

    // 语义问题计数：红点在卡片右上角，一眼看得出哪个节点要改。
    if (counts !== undefined && (counts.errors > 0 || counts.warnings > 0)) {
      const isError = counts.errors > 0
      const dot = document.createElementNS(SVG_NS, 'circle')
      dot.setAttribute('class', `wf-node-issue-dot ${isError ? 'error' : 'warning'}`)
      dot.setAttribute('cx', String(NODE_WIDTH - 14))
      dot.setAttribute('cy', '60')
      dot.setAttribute('r', '8')
      group.append(dot)

      const count = document.createElementNS(SVG_NS, 'text')
      count.setAttribute('class', 'wf-node-issue-count')
      count.setAttribute('x', String(NODE_WIDTH - 14))
      count.setAttribute('y', '64')
      count.setAttribute('text-anchor', 'middle')
      count.textContent = String(isError ? counts.errors : counts.warnings)
      group.append(count)

      const tooltip = document.createElementNS(SVG_NS, 'title')
      tooltip.textContent = isError
        ? `${counts.errors} 个错误：点击节点查看详情`
        : `${counts.warnings} 个警告：点击节点查看详情`
      group.append(tooltip)
    }

    // 连线把手：从这里按下拖到别的节点上即建 needs。
    // trigger 没有把手 —— 「挂在 trigger 下」是「没有 needs」的隐式形态，连不出实体边。
    if (!isTrigger) {
      const handle = document.createElementNS(SVG_NS, 'circle')
      handle.setAttribute('class', 'wf-node-handle')
      handle.setAttribute('cx', String(NODE_WIDTH / 2))
      handle.setAttribute('cy', String(NODE_HEIGHT))
      handle.setAttribute('r', '6')
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.svg.setPointerCapture(event.pointerId)
        const local = this.toLocal(event)
        this.interaction.pressLink(node.id, local.x, local.y)
        this.svg.classList.add('linking')
      })
      group.append(handle)
    }

    group.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.stopPropagation()
      this.selected = node.id
      this.select(node.id)
      this.options.onSelect(node.id)
    })
    group.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.selected = node.id
      this.select(node.id)
      this.options.onSelect(node.id)
      this.options.onNodeContextMenu(node.id, event.clientX, event.clientY)
    })
    return group
  }

  // ── 聚焦（§1.3/§5.2：只切 class；降级边走临时图层重建） ────────

  private applyFocusClasses (nodeId: string | null): void {
    const focus = this.focusIndex
    const model = this.model
    if (focus === null || model === null) return

    if (nodeId === null) {
      for (const path of this.edgeLayer.querySelectorAll('.wf-edge')) {
        path.classList.remove('wf-edge-direct', 'wf-edge-transitive', 'wf-edge-dimmed')
      }
      for (const element of this.nodeLayer.querySelectorAll('.wf-node')) {
        element.classList.remove('wf-node-related', 'wf-node-dimmed', 'wf-ordering-hit')
      }
      this.redrawDemotedEdges([])
      return
    }

    const state = computeEdgeFocusState(model.edges, nodeId, focus)
    for (const path of this.edgeLayer.querySelectorAll('.wf-edge')) {
      const key = edgeKeyOf(path.getAttribute('data-from') ?? '', path.getAttribute('data-to') ?? '')
      const cls = state.edges.get(key)
      path.classList.toggle('wf-edge-direct', cls === 'direct')
      path.classList.toggle('wf-edge-transitive', cls === 'transitive')
      path.classList.toggle('wf-edge-dimmed', cls === 'unrelated')
    }
    for (const element of this.nodeLayer.querySelectorAll('.wf-node')) {
      const id = element.getAttribute('data-id') ?? ''
      const related = state.relatedNodeIds.has(id)
      element.classList.toggle('wf-node-related', related && id !== nodeId)
      element.classList.toggle('wf-node-dimmed', !related)
    }
    // 降级边临时点线：选中节点时它的 direct/transitive 降级边要看得见
    // （ordering plan §4.2 —— 降级 ≠ 隐藏，选中时完整入边立即可见）。
    const demotedVisible = model.edges.filter((edge) => {
      if (!this.composed.ordering.demoted.has(edgeKeyOf(edge.from, edge.to))) return false
      const cls = state.edges.get(edgeKeyOf(edge.from, edge.to))
      return cls === 'direct' || cls === 'transitive'
    })
    this.redrawDemotedEdges(demotedVisible)
  }

  /**
   * 临时图层：降级边按需画成不占通道的直连点线，允许与其它元素交叉。
   * 拓扑变化（draw）清空；focus/hover 重建。纯 DOM 重建量 ≤ 降级边数，
   * 且只在选中/悬停变化时发生 —— 不进 §5.2 的「只切 class」热路径。
   */
  private redrawDemotedEdges (edges: readonly WorkflowEdge[]): void {
    this.demotedLayer.replaceChildren()
    const nodeById = new Map(this.composed.geometry.nodes.map(item => [item.node.id, item]))
    for (const edge of edges) {
      const source = nodeById.get(edge.from)
      const target = nodeById.get(edge.to)
      if (source === undefined || target === undefined) continue
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('class', 'wf-demoted-edge')
      path.setAttribute('d', demotedEdgePath(source.x, source.y, target.x, target.y))
      path.setAttribute('data-from', edge.from)
      path.setAttribute('data-to', edge.to)
      const tooltip = document.createElementNS(SVG_NS, 'title')
      tooltip.textContent = `${edge.from} → ${edge.to}（顺序依赖：不取任何产出，只约束先后与跳过传染）`
      path.append(tooltip)
      this.demotedLayer.append(path)
    }
  }

  // ── 交互 ────────────────────────────────────────

  private wireInteraction (): void {
    this.svg.addEventListener('pointerdown', (event) => {
      if (event.button === 2) return
      this.svg.setPointerCapture(event.pointerId)
      this.svg.classList.add('panning')
      const local = this.toLocal(event)
      this.interaction.pressBlank(local.x, local.y, event.button)
    })

    this.svg.addEventListener('pointermove', (event) => {
      const local = this.toLocal(event)
      this.interaction.move(local.x, local.y)
    })

    this.svg.addEventListener('pointerup', (event) => {
      this.svg.classList.remove('panning', 'linking')
      if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId)
      const local = this.toLocal(event)
      this.interaction.release(local.x, local.y)
    })
    // pointercancel（窗口失焦 / 触摸被打断 / 输入法抢占）绝不能当成一次提交：
    // 把预览丢弃即可 —— 半途的连线意图没有用户的松手确认（P2-4）。
    this.svg.addEventListener('pointercancel', () => this.cancelInteraction())

    this.svg.addEventListener('wheel', (event) => {
      event.preventDefault()
      const local = this.toLocal(event)
      this.interaction.wheel(local.x, local.y, event.deltaY, event.deltaMode)
    }, { passive: false })

    this.svg.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      this.options.onBlankContextMenu(event.clientX, event.clientY)
    })

    this.wireDropTarget()
  }

  /**
   * 接住从左侧面板拖来的 action。
   *
   * 落点决定语义：落在节点上 = 建它的下游（写 needs），落在空白 = 独立节点。
   * dragover 必须 preventDefault，否则浏览器根本不会派发 drop。
   */
  private wireDropTarget (): void {
    const isPaletteDrag = (event: DragEvent): boolean =>
      event.dataTransfer?.types.includes(PALETTE_MIME) === true

    this.host.addEventListener('dragover', (event) => {
      if (!isPaletteDrag(event)) return
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
      this.host.classList.add('drop-active')
      // 高亮将要成为上游的那个节点，让「会连上谁」在松手前就看得见
      const point = this.toCanvasPoint(event.clientX, event.clientY)
      const hovered = this.nodeIdAt(point.x, point.y)
      for (const element of this.nodeLayer.querySelectorAll('.wf-node')) {
        const id = element.getAttribute('data-id')
        element.classList.toggle('drop-target', hovered !== null && id === hovered && id !== TRIGGER_NODE_ID)
      }
    })

    const clearDropState = (): void => {
      this.host.classList.remove('drop-active')
      for (const element of this.nodeLayer.querySelectorAll('.wf-node')) {
        element.classList.remove('drop-target')
      }
    }

    this.host.addEventListener('dragleave', (event) => {
      // 只在真正离开画布时清状态：在子元素之间移动也会冒泡 dragleave
      if (event.relatedTarget !== null && this.host.contains(event.relatedTarget as Node)) return
      clearDropState()
    })

    this.host.addEventListener('drop', (event) => {
      if (!isPaletteDrag(event)) return
      event.preventDefault()
      clearDropState()
      const action = event.dataTransfer?.getData(PALETTE_MIME) ?? ''
      if (action === '') return
      // 业务功能条目把 scriptId 一并带上：拖的是哪个功能，落成哪个调用（P1-1 拖拽）。
      const scriptId = event.dataTransfer?.getData(SCRIPT_MIME) ?? ''
      const point = this.toCanvasPoint(event.clientX, event.clientY)
      const target = this.nodeIdAt(point.x, point.y)
      // 落在 trigger 上等同落在空白：「挂在 trigger 下」是「没有 needs」的隐式形态
      const upstream = target === null || target === TRIGGER_NODE_ID ? undefined : target
      this.options.onDropAction(action, upstream, scriptId === '' ? undefined : scriptId)
    })
  }

  /**
   * 丢弃一切进行中的交互（连线预览 / 平移原点），**不提交任何意图**。
   *
   * ★ 切换工作流、pointercancel、组件失活都走这里 —— 半途状态留在画布上，
   * 松手时会指向新文档里可能已不存在的节点。
   */
  cancelInteraction (): void {
    this.interaction.cancel()
    this.svg.classList.remove('linking', 'panning')
    this.linkPreview.classList.remove('active')
    this.linkPreview.removeAttribute('d')
    for (const element of this.nodeLayer.querySelectorAll('.wf-node')) {
      element.classList.remove('link-target', 'drop-target')
    }
  }

  private updateLinkPreview (from: string, pointer: { readonly x: number; readonly y: number } | null): void {
    if (pointer === null) {
      this.linkPreview.classList.remove('active')
      this.linkPreview.removeAttribute('d')
      for (const element of this.nodeLayer.querySelectorAll('.wf-node')) element.classList.remove('link-target')
      return
    }
    const source = this.nodePosition(from)
    if (source === null) return
    // §5.3：连线预览用正交两折线，不再用单条对角线
    this.linkPreview.setAttribute('d', previewPath(
      [source.x, source.y + NODE_HEIGHT / 2],
      [pointer.x, pointer.y],
    ))
    this.linkPreview.classList.add('active')

    const hovered = this.nodeIdAt(pointer.x, pointer.y)
    for (const element of this.nodeLayer.querySelectorAll('.wf-node')) {
      element.classList.toggle('link-target', hovered !== null && element.getAttribute('data-id') === hovered)
    }
  }

  private commitLink (from: string, targetId: string | null): void {
    if (targetId === null || targetId === from || targetId === TRIGGER_NODE_ID) return
    this.options.onConnect(from, targetId)
  }

  /** 指针位置命中哪个节点。用布局坐标做矩形命中，比 elementFromPoint 稳（不受 pointer capture 影响）。 */
  private nodeIdAt (canvasX: number, canvasY: number): string | null {
    for (const item of this.composed.geometry.nodes) {
      if (Math.abs(canvasX - item.x) <= NODE_WIDTH / 2 && Math.abs(canvasY - item.y) <= NODE_HEIGHT / 2) {
        return item.node.id
      }
    }
    return null
  }

  private nodePosition (nodeId: string): { readonly x: number; readonly y: number } | null {
    for (const item of this.composed.geometry.nodes) {
      if (item.node.id === nodeId) return { x: item.x, y: item.y }
    }
    return null
  }

  /** 事件坐标 → 宿主内坐标（interaction 的输入约定）。 */
  private toLocal (event: { readonly clientX: number; readonly clientY: number }): { readonly x: number; readonly y: number } {
    const box = this.host.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }

  /** 事件坐标 → 画布坐标（drop 命中用）。 */
  private toCanvasPoint (clientX: number, clientY: number): { readonly x: number; readonly y: number } {
    const local = this.toLocal({ clientX, clientY })
    const viewport = this.interaction.getViewport()
    return {
      x: (local.x - viewport.x) / viewport.scale,
      y: (local.y - viewport.y) / viewport.scale,
    }
  }

  private applyViewport (): void {
    const { x, y, scale } = this.interaction.getViewport()
    this.viewportGroup.setAttribute('transform', `translate(${x}, ${y}) scale(${scale})`)
    this.zoomLabel.textContent = `${Math.round(scale * 100)}%`
  }
}

function edgeTooltip (
  routed: RoutedEdge,
  nodeById: ReadonlyMap<string, { node: WorkflowNode; x: number; y: number }>,
): string {
  const from = nodeById.get(routed.edge.from)?.node
  const to = nodeById.get(routed.edge.to)?.node
  const lines = [`${nodeDisplayName(from)} → ${nodeDisplayName(to)}`, '前置步骤关系']
  if (routed.visualKind === 'implicit') lines.push('隐式依赖（无 needs）')
  if (routed.visualKind === 'finalizer') lines.push('收尾/清理语义（allDone）')
  if (routed.visualKind === 'invalid') lines.push('无效或反向依赖，请删除')
  // 语义线型（semantic-columns plan §4）：传值 / 只读判据 / 纯顺序三档
  if (routed.visualKind === 'data') lines.push('传值：本步从前置取输入')
  if (routed.visualKind === 'guard') lines.push('判据：本步只读前置的产出做条件判断')
  if (routed.visualKind === 'order-inline') lines.push('纯顺序：不取任何产出，只约束先后与跳过传染')
  // 技术 ID 做副信息（§7.3-14）
  if (routed.edge.from !== TRIGGER_NODE_ID) lines.push(`${routed.edge.from} → ${routed.edge.to}`)
  return lines.join('\n')
}

function truncate (text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * 降级边的临时直连路径：三段正交（底边出发 → 中线 → 顶边进入）。
 * 临时图层允许与其它元素交叉，不参与通道分配（ordering plan §4.2）。
 */
function demotedEdgePath (sourceX: number, sourceY: number, targetX: number, targetY: number): string {
  const startX = sourceX
  const startY = sourceY + NODE_HEIGHT / 2
  const endX = targetX
  const endY = targetY - NODE_HEIGHT / 2
  const midY = (startY + endY) / 2
  return `M ${startX} ${startY} L ${startX} ${midY} L ${endX} ${midY} L ${endX} ${endY}`
}

/** d3-dag 给的是折线控制点；这里用二次贝塞尔把拐角抹圆（legacy 模式保留一轮）。 */
function legacyBezierPath (points: readonly (readonly [number, number])[]): string {
  if (points.length === 0) return ''
  const [first, ...rest] = points
  if (rest.length === 0) return `M ${first![0]} ${first![1]}`
  let d = `M ${first![0]} ${first![1]}`
  for (let i = 0; i < rest.length - 1; i += 1) {
    const [cx, cy] = rest[i]!
    const [nx, ny] = rest[i + 1]!
    d += ` Q ${cx} ${cy} ${(cx + nx) / 2} ${(cy + ny) / 2}`
  }
  const last = rest.at(-1)!
  d += ` L ${last[0]} ${last[1]}`
  return d
}

function createDefs (): SVGDefsElement {
  const defs = document.createElementNS(SVG_NS, 'defs')
  defs.append(
    createArrowMarker('wf-arrow', 'wf-arrow'),
    createArrowMarker('wf-arrow-invalid', 'wf-arrow-invalid'),
    createArrowMarker('wf-arrow-finalizer', 'wf-arrow-finalizer'),
  )
  return defs
}

/** 箭头与线条同色（readability Plan §3.5）：invalid 红、finalizer 低饱和灰、其余默认灰。 */
function markerIdOf (kind: RoutedEdge['visualKind']): string {
  if (kind === 'invalid') return 'url(#wf-arrow-invalid)'
  if (kind === 'finalizer') return 'url(#wf-arrow-finalizer)'
  return 'url(#wf-arrow)'
}

/** legacy 对照模式的视觉档：与正交模式同一张优先级表，不另写一份。 */
function visualKindOfLegacy (edge: WorkflowEdge, allDoneNodeIds: ReadonlySet<string>): EdgeVisualKind {
  return visualKindOf(edge, allDoneNodeIds)
}

function createArrowMarker (id: string, className: string): SVGMarkerElement {
  const marker = document.createElementNS(SVG_NS, 'marker')
  marker.setAttribute('id', id)
  marker.setAttribute('viewBox', '0 0 10 10')
  marker.setAttribute('refX', '9')
  marker.setAttribute('refY', '5')
  marker.setAttribute('markerWidth', '6')
  marker.setAttribute('markerHeight', '6')
  marker.setAttribute('orient', 'auto-start-reverse')
  const arrow = document.createElementNS(SVG_NS, 'path')
  arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z')
  arrow.setAttribute('class', className)
  marker.append(arrow)
  return marker
}

function cssEscape (value: string): string {
  // data-id 里只需要处理属性选择器的两个元字符；节点 id 不会含控制字符
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
