// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { TRIGGER_NODE_ID } from '../../../../../src/workflow/core/model.js'
import type { WorkflowNode } from '../../../../../src/workflow/core/model.js'
import type { LaidOutNode } from './layout.js'
import { NODE_HEIGHT, NODE_WIDTH } from './layout.js'
import {
  CHANNEL_GAP,
  RANK_EPSILON,
  bandHeightForSlots,
  buildRanks,
  expandBands,
  normalizeGeometry,
  obstacleOf,
} from './ranks.js'

/** 测试用最小节点（绕开 JSON 解析，直接构造图）。 */
function node (id: string, index: number, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id,
    kind: 'step',
    action: 'x',
    description: undefined,
    needs: [],
    refs: [],
    index,
    hasWhen: false,
    hasAwait: false,
    hasCallback: false,
    ...extra,
  }
}

function laid (n: WorkflowNode, x: number, y: number): LaidOutNode {
  return { node: n, x, y }
}

describe('buildRanks：y 聚类与 Band（Plan §2.3/§8.6 前置）', () => {
  it('同一 y（epsilon 内）的节点归入同一层，Rank 按 y 升序', () => {
    const geometry = buildRanks([
      laid({ ...node('t', -1), kind: 'trigger', id: TRIGGER_NODE_ID }, 106, 36),
      laid(node('a', 0), 100, 196.2), // epsilon 内的抖动 → 同层
      laid(node('b', 1), 400, 196),
      laid(node('c', 2), 250, 356),
    ])
    expect(geometry.ranks).toHaveLength(3)
    expect(geometry.ranks.map(rank => rank.index)).toEqual([0, 1, 2])
    expect(geometry.ranks[0]!.nodeIds).toEqual([TRIGGER_NODE_ID])
    // 层内按 x 升序
    expect(geometry.ranks[1]!.nodeIds).toEqual(['a', 'b'])
    expect(geometry.ranks[1]!.top).toBeCloseTo(196 - NODE_HEIGHT / 2)
    expect(geometry.ranks[1]!.bottom).toBeCloseTo(196 + NODE_HEIGHT / 2)
    // y 吸附到层中心：抖动节点吸附到 196
    expect(geometry.nodes.find(item => item.node.id === 'a')!.y).toBe(196)
    expect(geometry.nodes.find(item => item.node.id === 'a')!.rank).toBe(1)
  })

  it('两层之间形成 RoutingBand，边界确定', () => {
    const geometry = buildRanks([
      laid(node('a', 0), 100, 36),
      laid(node('b', 1), 100, 200),
    ])
    expect(geometry.bands).toHaveLength(1)
    expect(geometry.bands[0]!.top).toBeCloseTo(36 + NODE_HEIGHT / 2)
    expect(geometry.bands[0]!.bottom).toBeCloseTo(200 - NODE_HEIGHT / 2)
    expect(geometry.bands[0]!.bottom - geometry.bands[0]!.top).toBeGreaterThan(2 * CHANNEL_GAP)
  })

  it('空输入返回空几何', () => {
    expect(buildRanks([]).ranks).toHaveLength(0)
  })
})

describe('expandBands（Plan §2.3：Band 不足时拉大下游层）', () => {
  it('需要的通道数超过当前高度时，下游所有层 y 顺次下移', () => {
    const geometry = buildRanks([
      laid(node('a', 0), 100, 36),
      laid(node('b', 1), 100, 200),
      laid(node('c', 2), 100, 364),
    ])
    const before = geometry.ranks.map(rank => rank.centerY)
    const needed = 12 // 88 高度只容 7 档
    const expanded = expandBands(geometry, [needed, 1])
    // 第 0 层不动，第 1/2 层被往下推
    expect(expanded.ranks[0]!.centerY).toBe(before[0])
    expect(expanded.ranks[1]!.centerY).toBeGreaterThan(before[1]!)
    expect(expanded.ranks[2]!.centerY).toBeGreaterThan(before[2]!)
    // 推开后 Band 0 容得下 12 档
    const height = expanded.bands[0]!.bottom - expanded.bands[0]!.top
    expect(height).toBeGreaterThanOrEqual(bandHeightForSlots(needed))
    // Band 1 无需求，不扩
    const height1 = expanded.bands[1]!.bottom - expanded.bands[1]!.top
    expect(height1).toBeCloseTo(geometry.bands[1]!.bottom - geometry.bands[1]!.top)
  })

  it('需求不超过容量时几何不变', () => {
    const geometry = buildRanks([laid(node('a', 0), 100, 36), laid(node('b', 1), 100, 200)])
    const expanded = expandBands(geometry, [1, 1])
    expect(expanded.ranks.map(rank => rank.centerY)).toEqual(geometry.ranks.map(rank => rank.centerY))
  })
})

describe('normalizeGeometry', () => {
  it('侧移产生的负坐标被平移到原点，并报告位移量', () => {
    const geometry = buildRanks([
      laid(node('a', 0), 100, 36),
      laid(node('b', 1), 100, 200),
    ])
    const shifted = { ...geometry, nodes: geometry.nodes.map(item => ({ ...item, x: item.x - 500 })) }
    const result = normalizeGeometry(shifted)
    // 新左缘 = min(x) - 106 = (100-500) - 106 = -506 → dx = 506
    expect(result.dx).toBe(506)
    expect(result.dy).toBe(0)
    for (const item of result.geometry.nodes) {
      expect(item.x - NODE_WIDTH / 2).toBeGreaterThanOrEqual(-RANK_EPSILON)
    }
  })
})

describe('obstacleOf（Plan §4.4：node bounds + ROUTE_CLEARANCE）', () => {
  it('障碍矩形比节点矩形四边各大 ROUTE_CLEARANCE', () => {
    const geometry = buildRanks([laid(node('a', 0), 300, 100)])
    const item = geometry.nodes[0]!
    const obstacle = obstacleOf(item)
    expect(obstacle.left).toBeCloseTo(300 - NODE_WIDTH / 2 - 12)
    expect(obstacle.right).toBeCloseTo(300 + NODE_WIDTH / 2 + 12)
    expect(obstacle.top).toBeCloseTo(100 - NODE_HEIGHT / 2 - 12)
    expect(obstacle.bottom).toBeCloseTo(100 + NODE_HEIGHT / 2 + 12)
  })
})

describe('rANK_EPSILON / 常量 sanity（Plan §2.2）', () => {
  it('常量保持计划值', () => {
    expect(CHANNEL_GAP).toBe(10)
    expect(RANK_EPSILON).toBe(0.5)
  })
})
