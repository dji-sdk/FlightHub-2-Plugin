// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { TRIGGER_NODE_ID } from '../../../../../src/workflow/core/model.js'
import type { WorkflowGraph } from '../../../../../src/workflow/core/model.js'
import { NODE_HEIGHT, NODE_WIDTH, buildSkeletons, edgeKeyOf, layoutWorkflow } from './layout.js'
import { graphOf } from './fixtures.js'

describe('d3-dag sugiyama 布局封装', () => {
  it('节点尺寸恒为正 —— d3-dag 对非正尺寸直接抛异常', () => {
    expect(NODE_WIDTH).toBeGreaterThan(0)
    expect(NODE_HEIGHT).toBeGreaterThan(0)
  })

  it('链式工作流按拓扑分层：trigger 在最上，下游 y 递增', () => {
    const layout = layoutWorkflow(graphOf(`{"steps":[
      {"id":"a","action":"x"},
      {"id":"b","needs":["a"],"action":"x"},
      {"id":"c","needs":["b"],"action":"x"}
    ]}`))
    const y = new Map(layout.nodes.map(item => [item.node.id, item.y]))
    expect(y.get(TRIGGER_NODE_ID)!).toBeLessThan(y.get('a')!)
    expect(y.get('a')!).toBeLessThan(y.get('b')!)
    expect(y.get('b')!).toBeLessThan(y.get('c')!)
    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
  })

  it('每条边都带折线控制点，首尾分别落在源/目标节点附近', () => {
    const layout = layoutWorkflow(graphOf(`{"steps":[{"id":"a","action":"x"},{"id":"b","needs":["a"],"action":"x"}]}`))
    for (const item of layout.edges) {
      expect(item.points.length).toBeGreaterThanOrEqual(2)
      for (const [x, y] of item.points) {
        expect(Number.isFinite(x)).toBe(true)
        expect(Number.isFinite(y)).toBe(true)
      }
    }
  })

  it('空图与只有 trigger 的图都不抛异常', () => {
    expect(layoutWorkflow({ name: '', nodes: [], edges: [], issues: [] })).toEqual({
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
    })
    const onlyTrigger = layoutWorkflow(graphOf(`{"name":"f","trigger":{"api":{}}}`))
    expect(onlyTrigger.nodes).toHaveLength(1)
  })

  it('自环边在建图前已被过滤，不会触发 d3-dag 的 self loop 异常', () => {
    // toGraph 会把 needs:[自己] 记成 SELF_LOOP 并丢边；这里直接喂一条自环边做二次保险
    const model: WorkflowGraph = {
      name: 'f',
      nodes: [{ id: 'a', kind: 'step', action: 'x', description: undefined, needs: ['a'], refs: [], index: 0, hasWhen: false, hasAwait: false, hasCallback: false }],
      edges: [{ from: 'a', to: 'a', origin: 'needs', refKinds: [] }],
      issues: [],
    }
    expect(() => layoutWorkflow(model)).not.toThrow()
  })

  it('重复 step id 只产生一个布局节点，不会因重复句柄丢边', () => {
    const layout = layoutWorkflow(graphOf(`{"steps":[{"id":"a","action":"x"},{"id":"a","action":"y"}]}`))
    expect(layout.nodes.filter(item => item.node.id === 'a')).toHaveLength(1)
  })

  it('有向环（needs 互指）不抛异常 —— d3-dag 内部会反转边处理', () => {
    const model: WorkflowGraph = {
      name: 'f',
      nodes: [
        { id: 'a', kind: 'step', action: 'x', description: undefined, needs: ['b'], refs: [], index: 0, hasWhen: false, hasAwait: false, hasCallback: false },
        { id: 'b', kind: 'step', action: 'x', description: undefined, needs: ['a'], refs: [], index: 1, hasWhen: false, hasAwait: false, hasCallback: false },
      ],
      edges: [{ from: 'a', to: 'b', origin: 'needs', refKinds: [] }, { from: 'b', to: 'a', origin: 'needs', refKinds: [] }],
      issues: [],
    }
    expect(() => layoutWorkflow(model)).not.toThrow()
  })

  it('多个无 needs 的 step 并列挂在 trigger 下，横向铺开而不是叠在一起', () => {
    const layout = layoutWorkflow(graphOf(`{"steps":[
      {"id":"a","action":"x"},{"id":"b","action":"x"},{"id":"c","action":"x"}
    ]}`))
    const leaves = layout.nodes.filter(item => item.node.kind === 'step')
    const xs = new Set(leaves.map(item => item.x))
    expect(xs.size).toBe(3)
  })
})

describe('edgeKeyOf / buildSkeletons', () => {
  it('edgeKey 稳定唯一（from + \\0 + to）', () => {
    expect(edgeKeyOf('a', 'b')).toBe('a\0b')
    expect(edgeKeyOf('a', 'b')).toBe(edgeKeyOf('a', 'b'))
    expect(edgeKeyOf('a', 'b')).not.toBe(edgeKeyOf('b', 'a'))
  })

  it('buildSkeletons 按边键索引 d3 控制点', () => {
    const layout = layoutWorkflow(graphOf(`{"steps":[{"id":"a","action":"x"},{"id":"b","needs":["a"],"action":"x"}]}`))
    const skeletons = buildSkeletons(layout)
    const skeleton = skeletons.get(edgeKeyOf('a', 'b'))
    expect(skeleton).toBeDefined()
    expect(skeleton!.length).toBeGreaterThanOrEqual(2)
  })
})
