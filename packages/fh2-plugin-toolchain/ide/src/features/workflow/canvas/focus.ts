// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 选中聚焦的图关系索引（Plan §5.1）。
 *
 * 只从 WorkflowGraph 的边构建：direct/transitive/unrelated 三档分类供画布
 * 切换 class 使用；选中变化不触发重布局/重路由 —— 本模块不持有几何信息。
 */

import type { WorkflowEdge, WorkflowGraph } from '../../../../../src/workflow/core/model.js'
import { edgeKeyOf } from './layout.js'

export interface FocusIndex {
  /** 直接入边来源（含环边）。 */
  readonly incoming: ReadonlyMap<string, readonly string[]>;
  /** 直接入边去向之外的直接出边目标（含环边）。 */
  readonly outgoing: ReadonlyMap<string, readonly string[]>;
  ancestorsOf (id: string): ReadonlySet<string>;
  descendantsOf (id: string): ReadonlySet<string>;
}

export function buildFocusIndex (graph: WorkflowGraph): FocusIndex {
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  for (const edge of graph.edges) {
    pushTo(incoming, edge.to, edge.from)
    pushTo(outgoing, edge.from, edge.to)
  }

  const ancestorCache = new Map<string, ReadonlySet<string>>()
  const descendantCache = new Map<string, ReadonlySet<string>>()

  const closureOf = (
    id: string,
    next: ReadonlyMap<string, readonly string[]>,
    cache: Map<string, ReadonlySet<string>>,
  ): ReadonlySet<string> => {
    const cached = cache.get(id)
    if (cached !== undefined) return cached
    const resolving = new Set<string>()
    const resolve = (current: string): void => {
      for (const neighbor of next.get(current) ?? []) {
        // 已缓存闭包直接并入（它自身及其上游都已是完整结果）
        const cachedClosure = cache.get(neighbor)
        if (cachedClosure !== undefined) {
          for (const item of cachedClosure) resolving.add(item)
          continue
        }
        // 环防御：正在解析链上的节点不再下钻；环本身由结构诊断负责
        if (resolving.has(neighbor)) continue
        resolving.add(neighbor)
        resolve(neighbor)
      }
    }
    resolving.add(id)
    resolve(id)
    resolving.delete(id)
    const result: ReadonlySet<string> = resolving
    cache.set(id, result)
    return result
  }

  return {
    incoming,
    outgoing,
    ancestorsOf: id => closureOf(id, incoming, ancestorCache),
    descendantsOf: id => closureOf(id, outgoing, descendantCache),
  }
}

function pushTo (map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else list.push(value)
}

export type EdgeFocusClass = 'direct' | 'transitive' | 'unrelated'

export interface EdgeFocusState {
  /** edgeKey → 聚焦档位。 */
  readonly edges: ReadonlyMap<string, EdgeFocusClass>;
  /** 与选中节点相关（自身/祖先/后代）的节点 id；无关节点以此取补集。 */
  readonly relatedNodeIds: ReadonlySet<string>;
}

/**
 * 选中一个节点后的三档分类（Plan §1.3）。
 *
 * transitive = 边落在一条穿过选中节点的路径上：两端都落在祖先侧（含自身）
 * 或都落在后代侧（含自身）。祖先→后代的「跨侧」边不属于穿过选中节点的路径。
 */
export function computeEdgeFocusState (
  edges: readonly WorkflowEdge[],
  selectedId: string,
  focus: FocusIndex,
): EdgeFocusState {
  const ancestors = focus.ancestorsOf(selectedId)
  const descendants = focus.descendantsOf(selectedId)
  const up = new Set<string>([...ancestors, selectedId])
  const down = new Set<string>([...descendants, selectedId])

  const classes = new Map<string, EdgeFocusClass>()
  for (const edge of edges) {
    const direct = edge.from === selectedId || edge.to === selectedId
    const transitive = (up.has(edge.from) && up.has(edge.to)) || (down.has(edge.from) && down.has(edge.to))
    classes.set(edgeKeyOf(edge.from, edge.to), direct ? 'direct' : transitive ? 'transitive' : 'unrelated')
  }
  return { edges: classes, relatedNodeIds: new Set<string>([...up, ...down]) }
}
