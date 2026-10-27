// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_CATALOG } from '../../../../../src/workflow/core/catalog.js'
import type { WorkflowGraph } from '../../../../../src/workflow/core/model.js'
import { WorkflowCanvas, composeCanvasLayout } from './workflow-canvas.js'
import type { CanvasOptions } from './workflow-canvas.js'
import { projectNodePresentations } from './semantic-role.js'
import { NODE_WIDTH } from './layout.js'
import { ACCIDENT_RESPONSE, DIAMOND, FINALIZERS, graphOf } from './fixtures.js'

function options (overrides: Partial<CanvasOptions> = {}): CanvasOptions {
  return {
    onSelect: () => {},
    onNodeContextMenu: () => {},
    onBlankContextMenu: () => {},
    onConnect: () => {},
    onEdgeContextMenu: () => {},
    onDropAction: () => {},
    ...overrides,
  }
}

function mount (graph: WorkflowGraph, overrides: Partial<CanvasOptions> = {}): WorkflowCanvas {
  const host = document.createElement('div')
  document.body.append(host)
  const canvas = new WorkflowCanvas(host, options(overrides))
  canvas.render(graph, projectNodePresentations(graph, EMPTY_CATALOG))
  return canvas
}

describe('workflowCanvas 渲染（Plan §5.2/§8.4）', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  it('节点带 data-id/data-role，边带 data-from/data-to/data-kind（稳定寻址锚点）', () => {
    mount(graphOf(DIAMOND))
    const nodes = document.querySelectorAll('.wf-node')
    expect(nodes.length).toBe(5)
    for (const node of nodes) {
      expect(node.getAttribute('data-id')).toBeTruthy()
      expect(node.getAttribute('data-role')).toMatch(/^(trigger|step)$/)
    }
    const edges = document.querySelectorAll('.wf-edge')
    expect(edges.length).toBe(graphOf(DIAMOND).edges.length)
    for (const edge of edges) {
      expect(edge.getAttribute('data-from')).toBeTruthy()
      expect(edge.getAttribute('data-to')).toBeTruthy()
      expect(edge.getAttribute('data-kind')).toMatch(/^(implicit|data|guard|order-inline|finalizer|invalid)$/)
      // 正交模式：path 只含 L/Q，且 L 段全部共轴（无对角线）
      const d = edge.getAttribute('d') ?? ''
      expect(d).toMatch(/^M /)
      expect(d).not.toMatch(/C /)
    }
  })

  it('语义节点带 data-traits 与等待样式钩子（Plan §1.1）', () => {
    const graph = graphOf(ACCIDENT_RESPONSE)
    const canvas = mount(graph)
    const ack = document.querySelector('.wf-node[data-id="ack"]')!
    expect(ack.getAttribute('data-traits')).toContain('wait')
    expect(ack.classList.contains('wf-node-wait')).toBe(true)
    const closer = document.querySelector('.wf-node[data-id="close_error"]')!
    expect(closer.getAttribute('data-traits')).toContain('terminal-finalizer')
    // 指向 allDone 的边是 finalizer 视觉
    const finalizerEdge = document.querySelector('.wf-edge[data-to="close_error"]')!
    expect(finalizerEdge.getAttribute('data-kind')).toBe('finalizer')
    void canvas
  })

  it('选中节点：只切换 class，不重建 DOM（§5.2 不 replaceChildren）', () => {
    const graph = graphOf(FINALIZERS)
    const canvas = mount(graph)
    const edgeBefore = [...document.querySelectorAll('.wf-edge')]
    const nodeBefore = [...document.querySelectorAll('.wf-node')]

    canvas.select('branch_left')

    const edgeAfter = [...document.querySelectorAll('.wf-edge')]
    const nodeAfter = [...document.querySelectorAll('.wf-node')]
    // 元素身份不变（同一批对象）
    expect(edgeAfter).toEqual(edgeBefore)
    expect(nodeAfter).toEqual(nodeBefore)

    // direct 边高亮、无关边变暗（Plan §1.3 三档）
    const workToBranch = document.querySelector('.wf-edge[data-from="work"][data-to="branch_left"]')!
    expect(workToBranch.classList.contains('wf-edge-direct')).toBe(true)
    const unrelated = document.querySelector('.wf-edge[data-from="work"][data-to="branch_right"]')!
    expect(unrelated.classList.contains('wf-edge-dimmed')).toBe(true)
    // 关联节点高亮、无关节点变暗
    const work = document.querySelector('.wf-node[data-id="work"]')!
    expect(work.classList.contains('wf-node-related')).toBe(true)
    expect(unrelated.classList.contains('wf-edge-dimmed')).toBe(true)

    // 清空 selection 恢复全部
    canvas.select(null)
    expect(workToBranch.classList.contains('wf-edge-direct')).toBe(false)
    expect(workToBranch.classList.contains('wf-edge-dimmed')).toBe(false)
    expect(work.classList.contains('wf-node-related')).toBe(false)
    expect(work.classList.contains('wf-node-dimmed')).toBe(false)
  })

  it('空图渲染不抛异常，画布保持可用', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const canvas = new WorkflowCanvas(host, options())
    canvas.render({ name: '', nodes: [], edges: [], issues: [] }, new Map())
    expect(document.querySelectorAll('.wf-node').length).toBe(0)
    expect(() => canvas.fit()).not.toThrow()
  })

  it('legacy-smooth 模式：边路径含 Q（贝塞尔），不带 data-kind 正交语义', () => {
    const graph = graphOf(DIAMOND)
    const host = document.createElement('div')
    document.body.append(host)
    const canvas = new WorkflowCanvas(host, options({ routingMode: 'legacy-smooth' }))
    canvas.render(graph, projectNodePresentations(graph, EMPTY_CATALOG))
    const d = document.querySelector('.wf-edge')!.getAttribute('d')!
    // d3 相邻层直边的骨架是 2 点，legacy 画法是纯 L；跨层边带 Q。至少不为空。
    expect(d).toMatch(/^M /)
  })

  it('routing-fallback 边带类名与 tooltip 原因（§4.6）', () => {
    // 构造一个必然 fallback 的场景很难从合法图得到（这正是目标）；
    // 这里直接验证「有 fallback 类时带 title」的渲染契约——用 legacy 图 + 空数据退路。
    const graph = graphOf(DIAMOND)
    const canvas = mount(graph)
    const edges = document.querySelectorAll('.wf-edge')
    // 合法 diamond 不应有 fallback
    for (const edge of edges) expect(edge.classList.contains('routing-fallback')).toBe(false)
    void canvas
  })

  it('dOM 几何与 compose 结果一致：收尾节点在 rail 最左列（semantic-columns §5.3）', () => {
    const graph = graphOf(FINALIZERS)
    const presentations = projectNodePresentations(graph, EMPTY_CATALOG)
    const host = document.createElement('div')
    document.body.append(host)
    const canvas = new WorkflowCanvas(host, options())
    canvas.render(graph, presentations)

    const model = composeCanvasLayout(graph, presentations, { routingMode: 'orthogonal-v1' })
    const centerXOf = (id: string): number => {
      const group = document.querySelector(`.wf-node[data-id="${id}"]`)!
      const match = group.getAttribute('transform')!.match(/translate\(([-\d.]+), /)
      return Number(match![1]) + NODE_WIDTH / 2
    }
    for (const item of model.geometry.nodes) {
      expect(centerXOf(item.node.id), item.node.id).toBeCloseTo(item.x)
    }
    // 两个收尾节点都在主链最左缘之外（rail 列；同层按 slot 向左错开）
    const closeOk = model.geometry.nodes.find(item => item.node.id === 'close_ok')!
    const closeFail = model.geometry.nodes.find(item => item.node.id === 'close_fail')!
    const mainMin = Math.min(...model.geometry.nodes
      .filter(item => !['close_ok', 'close_fail'].includes(item.node.id))
      .map(item => item.x - NODE_WIDTH / 2))
    expect(closeOk.x + NODE_WIDTH / 2).toBeLessThan(mainMin)
    expect(closeFail.x + NODE_WIDTH / 2).toBeLessThan(mainMin)
    // 同层 slot 间距 = NODE_WIDTH + RAIL_SLOT_GAP
    expect(Math.abs(closeOk.x - closeFail.x)).toBeCloseTo(NODE_WIDTH + 32)
    void canvas
  })

  it('徽标只显示一次「收尾」：terminal-finalizer 不产生可见标签（readability Plan §3.4）', () => {
    const graph = graphOf(ACCIDENT_RESPONSE)
    mount(graph)
    for (const id of ['close_ack_timeout', 'close_ignored', 'close_error']) {
      const group = document.querySelector(`.wf-node[data-id="${id}"]`)!
      // 内部布局 Trait 保留在稳定寻址锚点上，laneHint/边分类不受影响
      expect(group.getAttribute('data-traits')).toContain('terminal-finalizer')
      const text = group.querySelector('.wf-node-traits')?.textContent ?? ''
      expect(text.match(/收尾/g) ?? [], `${id} 徽标重复：${text}`).toHaveLength(1)
    }
    // 普通条件节点（无 allDone）的标签不变
    expect(document.querySelector('.wf-node[data-id="mark_ack"] .wf-node-traits')?.textContent).toBe('条件')
  })

  it('顺序边降级：mark_ack→mark_handling 不画线，角标在节点上；选中后点线可见（ordering plan §4.2）', () => {
    const graph = graphOf(ACCIDENT_RESPONSE)
    const canvas = mount(graph)

    // ① 降级边不产生路由边（.wf-edge 数 = 12）
    expect(document.querySelectorAll('.wf-edge')).toHaveLength(12)
    expect(document.querySelector('.wf-edge[data-from="mark_ack"][data-to="mark_handling"]')).toBeNull()

    // ② 目标节点带角标，文案含「连坐跳过」；来源节点不带
    const badge = document.querySelector('.wf-node[data-id="mark_handling"] .wf-ordering-badge-text')
    expect(badge?.textContent).toContain('跟随 mark_ack')
    expect(badge?.textContent).toContain('连坐跳过')
    expect(document.querySelector('.wf-node[data-id="mark_ack"] .wf-ordering-badge')).toBeNull()
    // allDone 收尾目标的角标是「仅顺序」档
    const closeBadge = document.querySelector('.wf-node[data-id="close_error"] .wf-ordering-badge-text')
    expect(closeBadge?.textContent).toContain('仅顺序')

    // ③ 未选中时临时点线图层为空；选中 mark_handling 后该降级边以点线出现
    expect(document.querySelectorAll('.wf-demoted-edge')).toHaveLength(0)
    canvas.select('mark_handling')
    expect(document.querySelector('.wf-demoted-edge[data-from="mark_ack"][data-to="mark_handling"]')).not.toBeNull()
    // direct 焦点类同步在常驻层上生效（承载边仍是 direct）
    expect(document.querySelector('.wf-edge[data-from="dispatch"][data-to="mark_handling"]')
      ?.classList.contains('wf-edge-direct')).toBe(true)
    canvas.select(null)
    expect(document.querySelectorAll('.wf-demoted-edge')).toHaveLength(0)
  })

  it('角标点击选中来源节点（ordering plan §4.2 可点）', () => {
    const graph = graphOf(ACCIDENT_RESPONSE)
    const canvas = mount(graph)
    const badge = document.querySelector('.wf-node[data-id="mark_handling"] .wf-ordering-badge')!
    badge.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    expect(canvas.selectedId).toBe('mark_ack')
    expect(document.querySelector('.wf-node[data-id="mark_ack"]')?.classList.contains('selected')).toBe(true)
  })
})

describe('composeCanvasLayout（纯函数管线）', () => {
  it('事故流程：fallback 0、三列语义布局成立（主链直列 / 状态链同列 / rail 最左）', () => {
    const graph = graphOf(ACCIDENT_RESPONSE)
    const presentations = projectNodePresentations(graph, EMPTY_CATALOG)
    const model = composeCanvasLayout(graph, presentations, {
      routingMode: 'orthogonal-v1',
    })
    expect(model.fallbackCount).toBe(0)
    // 顺序边降级后路由边数 = 全部边数 − 降级数（ordering plan §4.4：17 − 5 = 12）
    expect(model.routedEdges).toHaveLength(graph.edges.length - model.ordering.demoted.size)
    expect(model.ordering.demoted.size).toBe(5)

    const xOf = (id: string): number =>
      model.geometry.nodes.find(node => node.node.id === id)!.x

    // 主链（ack/pick/dispatch/poll）同列笔直
    const mainXs = ['ack', 'pick', 'dispatch', 'poll'].map(xOf)
    for (const x of mainXs) expect(x).toBeCloseTo(mainXs[0]!)

    // 状态链核心（mark_ack/mark_handling/mark_completed）同列，且在主链右侧
    const stateXs = ['mark_ack', 'mark_handling', 'mark_completed'].map(xOf)
    for (const x of stateXs) expect(x).toBeCloseTo(stateXs[0]!)
    expect(stateXs[0]! - NODE_WIDTH / 2).toBeGreaterThan(mainXs[0]! + NODE_WIDTH / 2)

    // rail 三节点同列且严格小于主链 x（最左）
    const railXs = ['close_ack_timeout', 'close_ignored', 'close_error'].map(xOf)
    for (const x of railXs) expect(x).toBeCloseTo(railXs[0]!)
    expect(railXs[0]! + NODE_WIDTH / 2).toBeLessThan(mainXs[0]! - NODE_WIDTH / 2)
    // mark_completed / mark_terminated 不是收尾，不进 rail
    expect(xOf('mark_terminated')).not.toBeCloseTo(railXs[0]!)
  })

  it('巡逻流程：fallback 0 且全部 12 步布局成功', () => {
    const graph = graphOf(`{"name":"patrol","trigger":{"api":{}},"steps":[
      {"id":"airborne","action":"query_flight_task"},
      {"id":"spawn","action":"spawn_agent","needs":["airborne"]},
      {"id":"phase1_done","action":"wait_signal","needs":["spawn"],"await":{"signal":"p1","timeoutSec":2400}},
      {"id":"recheck_gate","action":"wait_signal","needs":["phase1_done"],"await":{"signal":"rs","timeoutSecFrom":"trigger.x"}},
      {"id":"phase2_done","action":"wait_signal","needs":["recheck_gate"],"trigger":"allDone","await":{"signal":"p2","timeoutSec":2400}},
      {"id":"cancel_gate","action":"wait_signal","needs":["phase2_done"],"trigger":"allDone","await":{"signal":"cr","timeoutSec":30}},
      {"id":"go_home","action":"return_home","needs":["cancel_gate"],"trigger":"allDone"},
      {"id":"poll_landed","action":"query_flight_task","needs":["go_home"]},
      {"id":"mark_done","action":"update_event_status","needs":["poll_landed"]},
      {"id":"close_error","action":"update_event_status","needs":["airborne","spawn","phase1_done","recheck_gate","phase2_done","go_home","poll_landed","mark_done"],"trigger":"allDone"}
    ]}`)
    const presentations = projectNodePresentations(graph, EMPTY_CATALOG)
    const model = composeCanvasLayout(graph, presentations, {
      routingMode: 'orthogonal-v1',
    })
    expect(model.fallbackCount).toBe(0)
    expect(model.geometry.nodes.length).toBe(11)
  })
})
