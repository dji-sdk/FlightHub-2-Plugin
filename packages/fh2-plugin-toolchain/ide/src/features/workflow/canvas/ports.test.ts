// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { TRIGGER_NODE_ID } from '../../../../../src/workflow/core/model.js'
import { NODE_HEIGHT, NODE_WIDTH, layoutWorkflow } from './layout.js'
import { buildRanks } from './ranks.js'
import { PORT_MIN_GAP, PORT_PADDING, assignPorts, isMonotoneEdge } from './ports.js'
import { FAN_IN, FAN_OUT, graphOf } from './fixtures.js'

function portsFor (json: string) {
  const graph = graphOf(json)
  const layout = layoutWorkflow(graph)
  const geometry = buildRanks(layout.nodes)
  return { graph, geometry, ports: assignPorts(geometry, graph.edges) }
}

describe('出端口分配（Plan §3.2/§8.1）', () => {
  it('单边使用中心端口', () => {
    const { graph, geometry, ports } = portsFor(`{"steps":[
      {"id":"a","action":"x"},
      {"id":"b","action":"x","needs":["a"]}
    ]}`)
    const node = geometry.nodes.find(item => item.node.id === 'a')!
    const key = `${'a'}\0${'b'}`
    const assignment = ports.assignments.get(key)!
    expect(assignment).toBeDefined()
    expect(assignment.source.x).toBe(node.x)
    expect(assignment.source.y).toBeCloseTo(node.y + NODE_HEIGHT / 2)
    const target = geometry.nodes.find(item => item.node.id === 'b')!
    expect(assignment.target.y).toBeCloseTo(target.y - NODE_HEIGHT / 2)
    void graph
  })

  it('多出边按目标 x 顺序分散在底边', () => {
    const { geometry, ports } = portsFor(FAN_OUT)
    const source = geometry.nodes.find(item => item.node.id === 'source')!
    const assignments = [...ports.assignments.values()]
      .filter(assignment => assignment.source.nodeId === 'source')
      .sort((a, b) => a.source.order - b.source.order)
    expect(assignments.length).toBe(5)
    // order 与目标 x 排序一致
    const targetXs = assignments.map(assignment =>
      geometry.nodes.find(item => item.node.id === assignment.target.nodeId)!.x)
    for (let i = 1; i < targetXs.length; i += 1) {
      expect(targetXs[i]!).toBeGreaterThanOrEqual(targetXs[i - 1]!)
    }
    // 端口都落在 [left+padding, right-padding] 内且不重复
    const xs = assignments.map(assignment => assignment.source.x)
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(source.x - NODE_WIDTH / 2 + PORT_PADDING - 0.01)
      expect(x).toBeLessThanOrEqual(source.x + NODE_WIDTH / 2 - PORT_PADDING + 0.01)
    }
    expect(new Set(xs).size).toBe(xs.length)
  })

  it('多入边按来源 x 顺序分散在顶边（左来源进左端口）', () => {
    const { geometry, ports } = portsFor(FAN_IN)
    const sink = geometry.nodes.find(item => item.node.id === 'sink')!
    const assignments = [...ports.assignments.values()]
      .filter(assignment => assignment.target.nodeId === 'sink')
      .sort((a, b) => a.target.order - b.target.order)
    expect(assignments.length).toBe(5)
    const sourceXs = assignments.map(assignment =>
      geometry.nodes.find(item => item.node.id === assignment.source.nodeId)!.x)
    for (let i = 1; i < sourceXs.length; i += 1) {
      expect(sourceXs[i]!).toBeGreaterThanOrEqual(sourceXs[i - 1]!)
    }
    // 端口 x 与来源 x 同序：来源在左的边进左侧端口
    const portXs = assignments.map(assignment => assignment.target.x)
    for (let i = 1; i < portXs.length; i += 1) {
      expect(portXs[i]!).toBeGreaterThan(portXs[i - 1]!)
    }
    void sink
  })

  it('输入顺序变化不改变稳定 edgeKey 的端口排序', () => {
    const graph = graphOf(FAN_OUT)
    const layout = layoutWorkflow(graph)
    const geometry = buildRanks(layout.nodes)
    const a = assignPorts(geometry, graph.edges)
    // 反转边序再分配一次
    const b = assignPorts(geometry, [...graph.edges].reverse())
    // 按边键排序后逐条比较（Map 序随插入顺序变化，键序不受影响）
    const canonical = (ports: typeof a): string => JSON.stringify([...ports.assignments.entries()].sort(([x], [y]) => (x < y ? -1 : 1)))
    expect(canonical(a)).toBe(canonical(b))
  })

  it('超容量时进入分组端口（distinct x ≤ capacity）并标记高连接数节点', () => {
    // 一个 source 直挂 30 个下游：底边可用宽度 172-40=132，PORT_MIN_GAP=16 → 容量 ~9
    const json = `{"steps":[${Array.from({ length: 30 }, (_, i) => `{"id":"t${i}","action":"x","needs":["src"]}`).join(',')},{"id":"src","action":"x"}]}`
    const { geometry, ports } = portsFor(json)
    expect(ports.overCapacityNodeIds.has('src')).toBe(true)
    const assignments = [...ports.assignments.values()]
      .filter(assignment => assignment.source.nodeId === 'src')
    const distinctX = new Set(assignments.map(assignment => assignment.source.x))
    const capacity = Math.floor((NODE_WIDTH - 2 * PORT_PADDING) / PORT_MIN_GAP) + 1
    expect(distinctX.size).toBeLessThanOrEqual(capacity)
    expect(assignments.length).toBe(30)
    void geometry
  })

  it('trigger 隐式边使用底部中心端口（Plan §3.4）', () => {
    const { ports } = portsFor(FAN_OUT)
    const implicit = [...ports.assignments.values()].find(assignment => assignment.source.nodeId === TRIGGER_NODE_ID)
    expect(implicit).toBeDefined()
    // trigger 全部隐式边共享底部中心（多根步骤时 order 递增、x 恒为中心）
    const implicits = [...ports.assignments.values()]
      .filter(assignment => assignment.source.nodeId === TRIGGER_NODE_ID)
    for (const assignment of implicits) {
      expect(assignment.source.x).toBe(implicit!.source.x)
    }
  })

  it('非单调边不进端口表', () => {
    const graph = graphOf(`{"steps":[
      {"id":"a","action":"x","needs":["b"]},
      {"id":"b","action":"x","needs":["a"]},
      {"id":"leaf","action":"x","needs":["b"]}
    ]}`)
    const layout = layoutWorkflow(graph)
    const geometry = buildRanks(layout.nodes)
    const index = { rankOf: new Map(geometry.nodes.map(item => [item.node.id, item.rank])) }
    // d3 反转环边后 a/b 的 rank 关系决定哪条非单调
    const nonMonotone = graph.edges.filter((edge) => {
      const monotone = isMonotoneEdge(index, edge)
      return !monotone
    })
    expect(nonMonotone.length).toBeGreaterThanOrEqual(1)
    const ports = assignPorts(geometry, graph.edges)
    for (const edge of nonMonotone) {
      expect(ports.assignments.has(`${edge.from}\0${edge.to}`)).toBe(false)
    }
  })
})
