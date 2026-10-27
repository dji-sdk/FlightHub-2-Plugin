// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { buildFocusIndex, computeEdgeFocusState } from './focus.js'
import { edgeKeyOf } from './layout.js'
import { DIAMOND, graphOf } from './fixtures.js'

describe('focusIndex（Plan §5.1/§8.4）', () => {
  it('diamond 图上 ancestors/descendants 闭包正确', () => {
    const graph = graphOf(DIAMOND)
    const focus = buildFocusIndex(graph)
    // bottom 的祖先：top + left + right（left/right 互相不是祖先）+ trigger（top 无 needs）
    const ancestors = focus.ancestorsOf('bottom')
    expect([...ancestors].sort()).toEqual(['$trigger', 'left', 'right', 'top'])
    // top 的后代：left + right + bottom
    const descendants = focus.descendantsOf('top')
    expect([...descendants].sort()).toEqual(['bottom', 'left', 'right'])
    // left 的后代只有 bottom；祖先只有 top（top 无 needs → 隐式连 trigger）
    expect([...focus.descendantsOf('left')]).toEqual(['bottom'])
    expect([...focus.ancestorsOf('left')].sort()).toEqual(['$trigger', 'top'])
  })

  it('环图不无限递归（互指闭包收敛）', () => {
    const graph = graphOf(`{"steps":[
      {"id":"a","action":"x","needs":["b"]},
      {"id":"b","action":"x","needs":["a"]}
    ]}`)
    const focus = buildFocusIndex(graph)
    expect(() => focus.ancestorsOf('a')).not.toThrow()
    expect(() => focus.descendantsOf('b')).not.toThrow()
  })
})

describe('computeEdgeFocusState（Plan §1.3/§8.4）', () => {
  it('direct / transitive / unrelated 三档分类正确', () => {
    // cross 之外的旁路：side → other 与选中链路无关
    const graph = graphOf(`{"steps":[
      {"id":"start","action":"x"},
      {"id":"mid","action":"x","needs":["start"]},
      {"id":"end","action":"x","needs":["mid"]},
      {"id":"side","action":"x"},
      {"id":"other","action":"x","needs":["side"]}
    ]}`)
    const focus = buildFocusIndex(graph)
    const state = computeEdgeFocusState(graph.edges, 'mid', focus)

    expect(state.edges.get(edgeKeyOf('start', 'mid'))).toBe('direct')
    expect(state.edges.get(edgeKeyOf('mid', 'end'))).toBe('direct')
    // start→mid 的上游边（无）与 mid→end 的下游边（无）；start 与 end 之间无直接边。
    // 与选中节点无关的旁路：
    expect(state.edges.get(edgeKeyOf('side', 'other'))).toBe('unrelated')
    expect(state.edges.get(edgeKeyOf('$trigger', 'side'))).toBe('unrelated')

    // relatedNodeIds：链路上的节点都相关，side/other 不相关
    expect(state.relatedNodeIds.has('start')).toBe(true)
    expect(state.relatedNodeIds.has('mid')).toBe(true)
    expect(state.relatedNodeIds.has('end')).toBe(true)
    expect(state.relatedNodeIds.has('side')).toBe(false)
    expect(state.relatedNodeIds.has('other')).toBe(false)
  })

  it('diamond 图选中 top：left/right→bottom 的汇合边是 transitive（同属后代侧）', () => {
    const graph = graphOf(DIAMOND)
    const focus = buildFocusIndex(graph)
    const state = computeEdgeFocusState(graph.edges, 'top', focus)
    expect(state.edges.get(edgeKeyOf('top', 'left'))).toBe('direct')
    expect(state.edges.get(edgeKeyOf('top', 'right'))).toBe('direct')
    expect(state.edges.get(edgeKeyOf('left', 'bottom'))).toBe('transitive')
    expect(state.edges.get(edgeKeyOf('right', 'bottom'))).toBe('transitive')
  })

  it('长链上选中中段：祖先侧与后代侧的边都是 transitive', () => {
    const graph = graphOf(`{"steps":[
      {"id":"a","action":"x"},
      {"id":"b","action":"x","needs":["a"]},
      {"id":"c","action":"x","needs":["b"]},
      {"id":"d","action":"x","needs":["c"]}
    ]}`)
    const focus = buildFocusIndex(graph)
    const state = computeEdgeFocusState(graph.edges, 'b', focus)
    expect(state.edges.get(edgeKeyOf('$trigger', 'a'))).toBe('transitive')
    expect(state.edges.get(edgeKeyOf('a', 'b'))).toBe('direct')
    expect(state.edges.get(edgeKeyOf('b', 'c'))).toBe('direct')
    expect(state.edges.get(edgeKeyOf('c', 'd'))).toBe('transitive')
  })
})
