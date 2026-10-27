// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 节点表现语义：把 projection 的只读事实（triggerMode / hasWhen / hasAwait /
 * hasCallback）+ 受审词表（await_signal）映射成视觉角色（Plan §1.1）。
 *
 * 纪律（Plan §6.4）：
 * - 不读取节点 ID 字符串猜语义（`close_` 前缀不代表收尾）。
 * - 分类只写表现（role / traits / laneHint），不写回 Workflow JSON。
 * - 词表取不到时按「未知动作」处理：除 await_signal 之外的判据全部来自
 *   工作文档本身，不受词表降级影响。
 */

import { TRIGGER_NODE_ID } from '../../../../../src/workflow/core/model.js'
import type { WorkflowGraph, WorkflowNode } from '../../../../../src/workflow/core/model.js'
import { findFixedStep } from '../../../../../src/workflow/core/catalog.js'
import type { ActionCatalog } from '../../../../../src/workflow/core/catalog.js'

export type NodeTrait = 'wait' | 'callback' | 'conditional' | 'all-done' | 'terminal-finalizer'

export interface NodePresentation {
  readonly role: 'trigger' | 'step';
  readonly traits: readonly NodeTrait[];
  /** side-finalizer = 终点型 allDone，画布可把它移到主链外侧（Plan §2.4）。 */
  readonly laneHint: 'main' | 'side-finalizer';
}

/**
 * 投影每个节点的表现语义。
 *
 * `terminal-finalizer` 判据 = triggerMode allDone 且没有任何下游节点：
 * allDone 节点不一定是终点（Plan §1.1），只有「无下游」的才参与侧边布局，
 * 非终点 allDone 仅做样式区分。
 */
export function projectNodePresentations (
  graph: WorkflowGraph,
  catalog: ActionCatalog,
): ReadonlyMap<string, NodePresentation> {
  // 有下游的节点（自环不算）：terminal-finalizer 判据要用（Plan §1.1）。
  const hasDownstream = new Set<string>()
  for (const edge of graph.edges) {
    if (edge.from === edge.to) continue
    hasDownstream.add(edge.from)
  }

  const presentations = new Map<string, NodePresentation>()
  for (const node of graph.nodes) {
    presentations.set(node.id, projectNode(node, catalog, hasDownstream))
  }
  return presentations
}

function projectNode (
  node: WorkflowNode,
  catalog: ActionCatalog,
  hasDownstream: ReadonlySet<string>,
): NodePresentation {
  if (node.kind === 'trigger') return { role: 'trigger', traits: [], laneHint: 'main' }

  const traits: NodeTrait[] = []
  // wait：显式 await 段，或词表把该 action 归类为 await_signal（挂起等待动作）
  if (node.hasAwait || isAwaitSignalAction(catalog, node.action)) traits.push('wait')
  if (node.hasCallback) traits.push('callback')
  if (node.hasWhen) traits.push('conditional')
  const isAllDone = node.triggerMode === 'allDone'
  if (isAllDone) traits.push('all-done')
  const terminal = isAllDone && !hasDownstream.has(node.id)
  if (terminal) traits.push('terminal-finalizer')

  return {
    role: 'step',
    traits,
    laneHint: terminal ? 'side-finalizer' : 'main',
  }
}

function isAwaitSignalAction (catalog: ActionCatalog, action: string): boolean {
  if (action === '') return false
  // 词表取不到（available=false）时不判：宁可漏判，不可误报（core 语义层的纪律）
  if (!catalog.available) return false
  return findFixedStep(catalog, action)?.kind === 'await_signal'
}

/**
 * 悬停/徽标的中文标签（不含 trigger —— 它有专属卡片样式）。
 * `terminal-finalizer` 是内部布局 Trait，徽标不展示（见 {@link displayTraits}），
 * 词条保留只为让 Record 全量可检索（readability Plan §3.4）。
 */
export const TRAIT_LABELS: Readonly<Record<NodeTrait, string>> = {
  wait: '等待',
  callback: '等回调',
  conditional: '条件',
  'all-done': '收尾',
  'terminal-finalizer': '收尾',
}

/** 只参与布局/样式判断、不生成可见徽标的内部 Trait。 */
const INTERNAL_TRAITS: ReadonlySet<NodeTrait> = new Set(['terminal-finalizer'])

/**
 * 徽标展示的 Trait 序列：过滤内部布局 Trait。
 * `terminal-finalizer` 是 `all-done` 的「无下游」细化，两者同显会重复「收尾」
 * （readability Plan §3.4）。
 */
export function displayTraits (traits: readonly NodeTrait[]): readonly NodeTrait[] {
  return traits.filter(trait => !INTERNAL_TRAITS.has(trait))
}

/** 触发器在 tooltip / 边标签里显示的名称。 */
export const TRIGGER_LABEL = '触发器'

export function nodeDisplayName (node: WorkflowNode | undefined): string {
  if (node === undefined) return ''
  if (node.kind === 'trigger') return TRIGGER_LABEL
  return node.description !== undefined && node.description !== '' ? node.description : node.id
}

/** 表现是否含某 trait（空 traits 的 step / trigger 恒 false）。 */
export function hasTrait (presentation: NodePresentation | undefined, trait: NodeTrait): boolean {
  return presentation?.traits.includes(trait) === true
}

export { TRIGGER_NODE_ID }
