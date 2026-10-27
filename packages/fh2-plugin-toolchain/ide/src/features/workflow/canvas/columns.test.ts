// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { EMPTY_CATALOG } from '../../../../../src/workflow/core/catalog.js'
import type { WorkflowEdge, WorkflowNode } from '../../../../../src/workflow/core/model.js'
import { NODE_WIDTH, layoutWorkflow } from './layout.js'
import type { NodePresentation } from './semantic-role.js'
import { buildRanks } from './ranks.js'
import { COLUMN_GAP, applySemanticColumns, computeMainChain, computeStateChain } from './columns.js'
import { computeOrderingHints } from './ordering.js'
import { projectNodePresentations } from './semantic-role.js'
import { ACCIDENT_RESPONSE, FINALIZERS, PARKING_PATROL, graphOf } from './fixtures.js'

/**
 * 三列语义布局（semantic-columns plan §5.5）：
 * 主链（data 边最长路径）同列笔直、状态链（降级边链）右侧同列、
 * 收尾 rail（terminal-finalizer）最左一列。冲突即放弃对齐，绝不重叠。
 */

function accidentColumns () {
  const graph = graphOf(ACCIDENT_RESPONSE)
  const presentations = projectNodePresentations(graph, EMPTY_CATALOG)
  const ordering = computeOrderingHints(graph)
  const layout = layoutWorkflow(graph)
  const geometry = buildRanks(layout.nodes)
  const stateChain = computeStateChain(graph.nodes, ordering.demoted, graph.edges, new Set(['close_ack_timeout', 'close_ignored', 'close_error']))
  const result = applySemanticColumns(geometry, presentations, graph.edges, ordering)
  return { graph, stateChain, ...result }
}

describe('computeMainChain（plan §5.1）', () => {
  /**
   * ⓘ 计划示意的主链是 ack→pick→dispatch→poll，但 JSON 事实是 pick/dispatch
   * 不读 steps.ack 任何产出（ack→pick 是纯顺序边，eventId 来自 trigger 根）。
   * 判据只读 refKinds（不看节点、不猜语义）→ 事实主链 = pick→dispatch→…，
   * 并列最长（mark_handling / poll 都从 dispatch 取值）取书写序 mark_handling。
   */
  it('事故流程：主链 = pick → dispatch → poll（避开状态链成员 mark_handling 取并列最长）', () => {
    const { layout } = accidentColumns()
    expect(layout.mainChain).toEqual(['pick', 'dispatch', 'poll'])
  })

  it('并列最长时取书写序靠前的（确定性）', () => {
    const graph = graphOf(`{"name":"f","trigger":{"api":{}},"steps":[
      {"id":"b_first","action":"x","inputs":{"v":{"from":"trigger.x"}}},
      {"id":"a_second","action":"x","inputs":{"v":{"from":"trigger.x"}}},
      {"id":"left","action":"x","needs":["b_first"],"inputs":{"v":{"from":"steps.b_first.v"}}},
      {"id":"right","action":"x","needs":["a_second"],"inputs":{"v":{"from":"steps.a_second.v"}}}
    ]}`)
    const layout = layoutWorkflow(graph)
    const chain = computeMainChain(graph.nodes, graph.edges)
    expect(chain).toHaveLength(2)
    expect(chain[0]).toBe('b_first')
    void layout
  })

  it('无 data 边时主链为空', () => {
    const graph = graphOf(`{"name":"f","trigger":{"api":{}},"steps":[
      {"id":"a","action":"x"},
      {"id":"b","action":"x","needs":["a"]}
    ]}`)
    expect(computeMainChain(graph.nodes, graph.edges)).toEqual([])
  })
})

describe('computeStateChain（plan §5.2）', () => {
  it('事故流程：状态链含 mark_ack / mark_handling / mark_completed，rail 成员不入链', () => {
    const { graph, layout, stateChain } = accidentColumns()
    // mark_handling 分叉三个后继，对齐的只有第一个（书写序 mark_completed）
    for (const id of ['mark_ack', 'mark_handling', 'mark_completed']) {
      expect(stateChain, id).toContain(id)
    }
    // close_error 是 rail（finalizer），被 §5.3 抢走
    expect(stateChain).not.toContain('close_error')
    // 链外主链节点不入
    expect(stateChain).not.toContain('ack')
    void graph
    void layout
  })
})

describe('applySemanticColumns（plan §5.5 验收断言）', () => {
  it('事故流程：主链 x 相等、状态链 x 相等且在主链右、rail x 相等且严格小于主链', () => {
    const { geometry, layout } = accidentColumns()
    const xOf = (id: string): number => geometry.nodes.find(node => node.node.id === id)!.x

    const mainXs = layout.mainChain.map(xOf)
    for (const x of mainXs) expect(x).toBeCloseTo(mainXs[0]!)

    const stateXs = ['mark_ack', 'mark_handling', 'mark_completed'].map(xOf)
    for (const x of stateXs) expect(x).toBeCloseTo(stateXs[0]!)
    expect(stateXs[0]! - NODE_WIDTH / 2).toBeGreaterThan(mainXs[0]! + NODE_WIDTH / 2)

    const railXs = layout.railNodeIds.map(xOf)
    for (const x of railXs) expect(x).toBeCloseTo(railXs[0]!)
    expect(railXs[0]! + NODE_WIDTH / 2).toBeLessThan(mainXs[0]! - NODE_WIDTH / 2)
    expect(layout.railNodeIds.slice().sort()).toEqual(['close_ack_timeout', 'close_error', 'close_ignored'])
    // 干道在 rail 右缘与主链最左缘之间
    const mainLeft = mainXs[0]! - NODE_WIDTH / 2
    expect(layout.railTrunkX).toBeGreaterThan(xOf('close_error') + NODE_WIDTH / 2)
    expect(layout.railTrunkX).toBeLessThan(mainLeft)
  })
  it('rail 纵向保留自己的 rank（不堆到底部）', () => {
    const { geometry } = accidentColumns()
    const rankOf = (id: string): number => geometry.nodes.find(node => node.node.id === id)!.rank
    // close_ack_timeout 在 rank2（跟 ack/pick 同层），不是最后一层
    expect(rankOf('close_ack_timeout')).toBe(2)
    expect(rankOf('close_error')).toBe(5)
  })

  it('冲突用例：对齐会导致重叠时放弃该节点的对齐，不制造重叠', () => {
    // 同层已有两个节点占住主链列两侧：b 与 main 同层且正好在目标列上 → main 放弃对齐
    const graph = graphOf(`{"name":"f","trigger":{"api":{}},"steps":[
      {"id":"top","action":"x","inputs":{"v":{"from":"trigger.x"}}},
      {"id":"bottom","action":"x","needs":["top"],"inputs":{"v":{"from":"steps.top.v"}}},
      {"id":"blocker","action":"x","needs":["top"]}
    ]}`)
    const presentations = projectNodePresentations(graph, EMPTY_CATALOG)
    const ordering = computeOrderingHints(graph)
    const layout = layoutWorkflow(graph)
    const geometry = buildRanks(layout.nodes)
    const result = applySemanticColumns(geometry, presentations, graph.edges, ordering)
    // 全部节点两两不重叠（同层 x 间距 ≥ NODE_WIDTH）
    for (let i = 0; i < result.geometry.nodes.length; i += 1) {
      for (let j = i + 1; j < result.geometry.nodes.length; j += 1) {
        const a = result.geometry.nodes[i]!
        const b = result.geometry.nodes[j]!
        if (a.rank !== b.rank) continue
        expect(Math.abs(a.x - b.x), `${a.node.id}/${b.node.id} 重叠`).toBeGreaterThanOrEqual(NODE_WIDTH - 0.5)
      }
    }
  })

  it('无 data 边 / 无降级边 / 无 finalizer 的图原样返回（不抛、不移）', () => {
    const graph = graphOf(`{"name":"f","trigger":{"api":{}},"steps":[
      {"id":"a","action":"x"},
      {"id":"b","action":"x","needs":["a"]}
    ]}`)
    const presentations = projectNodePresentations(graph, EMPTY_CATALOG)
    const ordering = computeOrderingHints(graph)
    const layout = layoutWorkflow(graph)
    const before = buildRanks(layout.nodes)
    const result = applySemanticColumns(before, presentations, graph.edges, ordering)
    expect(result.layout.mainChain).toEqual([])
    expect(result.layout.railNodeIds).toEqual([])
    const beforeX = new Map(before.nodes.map(node => [node.node.id, node.x]))
    for (const node of result.geometry.nodes) {
      expect(node.x).toBeCloseTo(beforeX.get(node.node.id)!)
    }
  })
})

// ── routing-polish plan §4：节点最小净距 ──

/** 合成几何：精确控制同层布局，直测 applySemanticColumns 的净距数学。 */
function syntheticNode (id: string, x: number, y: number, rank: number): { node: WorkflowNode; x: number; y: number; rank: number } {
  return {
    node: { id, kind: 'step', action: 'x', description: undefined, needs: [], refs: [], index: 0, hasWhen: false, hasAwait: false, hasCallback: false },
    x,
    y,
    rank,
  }
}

function edge (from: string, to: string, refKinds: readonly string[] = []): WorkflowEdge {
  return { from, to, origin: 'needs', refKinds: refKinds as WorkflowEdge['refKinds'] }
}

describe('节点最小净距（routing-polish plan §4）', () => {
  it('事故流程：mark_completed.left - mark_terminated.right >= COLUMN_GAP（80）', () => {
    const { geometry } = accidentColumns()
    const xOf = (id: string): number => geometry.nodes.find(node => node.node.id === id)!.x
    const gap = (xOf('mark_completed') - NODE_WIDTH / 2) - (xOf('mark_terminated') + NODE_WIDTH / 2)
    expect(gap).toBeGreaterThanOrEqual(COLUMN_GAP - 0.5)
  })

  it('状态链整体右移后仍同列：三个成员 x 相等（不单独挪某一个）', () => {
    const { geometry } = accidentColumns()
    const xOf = (id: string): number => geometry.nodes.find(node => node.node.id === id)!.x
    const xs = ['mark_ack', 'mark_handling', 'mark_completed'].map(xOf)
    for (const x of xs) expect(x).toBeCloseTo(xs[0]!)
  })

  it('合成几何：多个同层 blocker 时状态列右移到全部让开，净距恰为 COLUMN_GAP', () => {
    // rank1 上有两个 blocker（b1=400, b2=700），状态链 s2 原在 x=1000。
    // 期望列 x = max(状态中位数, 主链右缘+80+半宽, 最紧 blocker 右缘+80+半宽) = 992。
    const nodes = [
      syntheticNode('m1', 0, 0, 0),
      syntheticNode('s1', 800, 0, 0),
      syntheticNode('m2', 0, 160, 1),
      syntheticNode('b1', 400, 160, 1),
      syntheticNode('b2', 700, 160, 1),
      syntheticNode('s2', 1000, 160, 1),
      syntheticNode('s3', 900, 320, 2),
    ]
    const geometry = buildRanks(nodes.map(n => ({ node: n.node, x: n.x, y: n.y })))
    const edges = [
      edge('m1', 'm2', ['input']),
      edge('s1', 's2'),
      edge('s2', 's3'),
    ]
    const demoted = new Set(['s1\0s2', 's2\0s3'])
    const presentations = new Map<string, NodePresentation>()
    const result = applySemanticColumns(geometry, presentations, edges, { demoted, afterBadges: new Map() })
    const xOf = (id: string): number => result.geometry.nodes.find(node => node.node.id === id)!.x
    // 整列右移：三个成员同列，且对最紧 blocker（b2）净距恰为 80
    expect(xOf('s1')).toBeCloseTo(xOf('s2'))
    expect(xOf('s2')).toBeCloseTo(xOf('s3'))
    expect((xOf('s2') - NODE_WIDTH / 2) - (xOf('b2') + NODE_WIDTH / 2)).toBeCloseTo(COLUMN_GAP, -1)
    // 对 b1 的净距更大；审计无问题
    expect((xOf('s2') - NODE_WIDTH / 2) - (xOf('b1') + NODE_WIDTH / 2)).toBeGreaterThan(COLUMN_GAP)
    expect(result.layout.audit).toEqual([])
  })

  it('审计能捕获真实违规：双状态链同 rank 对齐到同一列 → overlap 必须报出来', () => {
    // 两条独立状态链（s 链与 t 链）在 rank1 各有一个成员，无同层 blocker；
    // 状态列 preferred 落在两成员之间 → 两条链的成员都被对齐到同一 x（各自
    // 的 clearsAt 只看原始位置，互相看不见对方的新位置）→ 重叠。
    // ★ 这是审计存在的意义：对齐守卫覆盖不到的组合，由审计说出来说明
    //   布局有限制，而不是静默产出重叠图。
    const nodes = [
      syntheticNode('m1', 0, 0, 0),
      syntheticNode('s1', 1200, 0, 0),
      syntheticNode('t1', 1400, 0, 0),
      syntheticNode('m2', 0, 160, 1),
      syntheticNode('s2', 1000, 160, 1),
      syntheticNode('t2', 1600, 160, 1),
    ]
    const geometry = buildRanks(nodes.map(n => ({ node: n.node, x: n.x, y: n.y })))
    const edges = [
      edge('m1', 'm2', ['input']),
      edge('s1', 's2'),
      edge('t1', 't2'),
    ]
    const demoted = new Set(['s1\0s2', 't1\0t2'])
    const result = applySemanticColumns(geometry, new Map(), edges, { demoted, afterBadges: new Map() })
    expect(result.layout.audit.length).toBeGreaterThan(0)
    expect(result.layout.audit.some(issue => issue.kind === 'overlap')).toBe(true)
  })

  it('相同输入重复运行坐标完全一致（确定性）', () => {
    const first = accidentColumns()
    const second = accidentColumns()
    const xs = (result: typeof first): string => result.geometry.nodes.map(n => `${n.node.id}:${n.x.toFixed(3)}`).join(',')
    expect(xs(second)).toBe(xs(first))
  })

  it('三份正式 fixture 的布局审计均为空（无贴边/无重叠）', () => {
    for (const [name, json] of [['accident', ACCIDENT_RESPONSE], ['finalizers', FINALIZERS], ['parking', PARKING_PATROL]] as const) {
      const graph = graphOf(json)
      const presentations = projectNodePresentations(graph, EMPTY_CATALOG)
      const ordering = computeOrderingHints(graph)
      const layout = layoutWorkflow(graph)
      const result = applySemanticColumns(buildRanks(layout.nodes), presentations, graph.edges, ordering)
      expect(result.layout.audit, name).toEqual([])
    }
  })
})
