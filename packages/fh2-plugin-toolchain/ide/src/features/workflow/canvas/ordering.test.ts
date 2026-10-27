// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { ACCIDENT_RESPONSE, graphOf } from './fixtures.js'
import { buildFocusIndex, computeEdgeFocusState } from './focus.js'
import { edgeKeyOf } from './layout.js'
import { computeOrderingHints, isDemotableOrderingEdge, orderingBadgeLabel, orderingBadgeText, orderingBadgeTooltip } from './ordering.js'

/**
 * 次要顺序边降级判据（ordering plan §4.4）。
 *
 * ★ 防回归关键用例：`ack → pick` 必须**不**被降级 —— 判据的第三个条件
 *   （目标另有一条带引用的入边）写松了它就会被吃掉，主链在画面上剪断。
 *
 * ACCIDENT_RESPONSE 用 canvas fixtures 里的等价转写（与仓内真实文件
 * accident-response-cascade.json 逐步对齐；期望表与 worker 仓 flowviz 的
 * TestEdgeClassesSeparateRealDepsFromOrdering 逐条一致，plan §7）。
 */

function key (from: string, to: string): string {
  return edgeKeyOf(from, to)
}

describe('computeOrderingHints（plan §4.1 判据）', () => {
  it('aCCIDENT_RESPONSE：恰好 5 条降级边（17 条边里），逐条断言', () => {
    const graph = graphOf(ACCIDENT_RESPONSE)
    const hints = computeOrderingHints(graph)
    expect(graph.edges).toHaveLength(17)
    expect([...hints.demoted].sort()).toEqual([
      key('mark_ack', 'close_ignored'),
      key('mark_ack', 'mark_handling'),
      key('mark_handling', 'close_error'),
      key('mark_handling', 'mark_completed'),
      key('mark_handling', 'mark_terminated'),
    ].sort())
  })

  it('ack → pick 不降级（唯一父节点的顺序边是主链，防回归关键用例）', () => {
    const graph = graphOf(ACCIDENT_RESPONSE)
    const hints = computeOrderingHints(graph)
    expect(hints.demoted.has(key('ack', 'pick'))).toBe(false)
    expect(hints.demoted.has(key('ack', 'mark_ack'))).toBe(false)
  })

  it('afterBadges 按目标节点给出降级来源名单（needs 书写序）', () => {
    const graph = graphOf(ACCIDENT_RESPONSE)
    const hints = computeOrderingHints(graph)
    expect(hints.afterBadges.get('mark_handling')).toEqual(['mark_ack'])
    expect(hints.afterBadges.get('mark_completed')).toEqual(['mark_handling'])
    expect(hints.afterBadges.get('close_error')).toEqual(['mark_handling'])
    expect(hints.afterBadges.has('pick')).toBe(false)
  })

  it('implicit 边与带引用的 needs 边永不降级', () => {
    const graph = graphOf(ACCIDENT_RESPONSE)
    const implicit = graph.edges.find(edge => edge.origin === 'implicit')!
    expect(isDemotableOrderingEdge(implicit, graph.edges)).toBe(false)
    const dataEdge = graph.edges.find(edge => edge.from === 'dispatch' && edge.to === 'mark_handling')!
    expect(isDemotableOrderingEdge(dataEdge, graph.edges)).toBe(false)
  })

  it('目标的所有入边都是纯顺序时不降级（没有可让位的承载边）', () => {
    const graph = graphOf(`{"name":"f","trigger":{"api":{}},"steps":[
      {"id":"a","action":"x"},
      {"id":"b","action":"x"},
      {"id":"c","action":"x","needs":["a","b"]}
    ]}`)
    const hints = computeOrderingHints(graph)
    expect(hints.demoted.size).toBe(0)
  })

  it('角标文案：allSucceeded 写「顺序 / 连坐跳过」，allDone 写「仅顺序」', () => {
    expect(orderingBadgeLabel(undefined, ['mark_ack'])).toBe('⟲ 跟随 mark_ack（顺序 / 连坐跳过）')
    expect(orderingBadgeLabel('allDone', ['mark_handling'])).toBe('⟲ 仅顺序跟随 mark_handling')
  })

  it('角标聚合（semantic-columns §6）：多来源折叠为「N 步」，不出现具体 id', () => {
    expect(orderingBadgeLabel('allSucceeded', ['mark_ack', 'poll']))
      .toBe('⟲ 跟随 2 步（顺序 / 连坐跳过）')
    expect(orderingBadgeLabel('allDone', ['a', 'b', 'c']))
      .toBe('⟲ 仅顺序跟随 3 步')
    // 文案里不出现具体 id（超宽源头从源头收敛）
    expect(orderingBadgeLabel('allSucceeded', ['mark_ack', 'poll'])).not.toContain('mark_ack')
  })

  it('角标 tooltip 携带完整来源列表（触屏拿不到 hover 的兜底）', () => {
    expect(orderingBadgeTooltip(['mark_ack', 'poll'])).toContain('mark_ack、poll')
    expect(orderingBadgeTooltip(['mark_ack'])).toContain('跳过传染')
  })

  it('单来源超宽：截 id 保句尾，不出现半截句尾（semantic-columns §6）', () => {
    // 预算 18（汉字宽）：完整文案 ⟲ 跟随 mark_handling（顺序 / 连坐跳过）≈ 20+ 宽 → 截 id
    const text = orderingBadgeText(undefined, ['mark_handling'], 18)
    expect(text).toContain('（顺序 / 连坐跳过）')
    expect(text).toContain('mark_h')
    expect(text).not.toBe('⟲ 跟随 mark_handling（顺序 / 连坐跳过）')
    // 不超宽时完整保留
    expect(orderingBadgeText(undefined, ['mark_ack'], 30)).toBe('⟲ 跟随 mark_ack（顺序 / 连坐跳过）')
    // allDone 档句尾没有括号句，超宽同样截 id
    const short = orderingBadgeText('allDone', ['close_ack_timeout'], 12)
    expect(short).toContain('close_a')
    expect(short.endsWith('…')).toBe(true)
  })
})

describe('降级不影响聚焦闭包（plan §4.4）', () => {
  it('buildFocusIndex 基于完整边集：mark_ack 仍是 mark_handling 的 direct 祖先', () => {
    const graph = graphOf(ACCIDENT_RESPONSE)
    const focus = buildFocusIndex(graph)
    expect(graph.edges.some(edge => edge.from === 'mark_ack' && edge.to === 'mark_handling')).toBe(true)
    // 闭包可达性：mark_handling 的祖先闭包含 mark_ack（若降级当删除会拿不到）
    expect(focus.ancestorsOf('mark_handling').has('mark_ack')).toBe(true)
    // direct 判定也基于完整边集
    const state = computeEdgeFocusState(graph.edges, 'mark_handling', focus)
    expect(state.edges.get(key('mark_ack', 'mark_handling'))).toBe('direct')
  })
})
