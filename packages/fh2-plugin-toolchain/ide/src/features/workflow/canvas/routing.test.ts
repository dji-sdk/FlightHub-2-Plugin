// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { EMPTY_CATALOG } from '../../../../../src/workflow/core/catalog.js'
import type { WorkflowGraph } from '../../../../../src/workflow/core/model.js'
import { composeCanvasLayout } from './workflow-canvas.js'
import { projectNodePresentations } from './semantic-role.js'
import { NODE_HEIGHT, NODE_WIDTH } from './layout.js'
import { CHANNEL_GAP, RANK_EPSILON, ROUTE_CLEARANCE } from './ranks.js'
import {
  ACCIDENT_RESPONSE,
  CYCLE_MUTUAL,
  DIAMOND,
  FAN_IN,
  FAN_OUT,
  FINALIZERS,
  INVALID_CYCLE,
  LINEAR,
  LONG_EDGE,
  PARKING_PATROL,
  VALID_FIXTURES,
  graphOf,
} from './fixtures.js'

function compose (graph: WorkflowGraph, options: { orderingEdgeMode?: 'inline' | 'demoted' } = {}) {
  const presentations = projectNodePresentations(graph, EMPTY_CATALOG)
  return composeCanvasLayout(graph, presentations, {
    routingMode: 'orthogonal-v1',
    ...(options.orderingEdgeMode === undefined ? {} : { orderingEdgeMode: options.orderingEdgeMode }),
  })
}

/** rail 边里落在干道走廊（railRight..mainLeft）内的竖直段 x —— 真实 trunk 候选。 */
function railTrunkVerticalXs (
  edge: { readonly segments: readonly { readonly orientation: 'h' | 'v'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }[] },
  railRight: number,
  mainLeft: number,
): readonly number[] {
  return edge.segments
    .filter(segment => segment.orientation === 'v')
    .map(segment => Math.round(segment.x1))
    .filter(x => x > railRight && x < mainLeft)
}

/** 水平段是否横跨给定 x（同 Band 直穿的 rail 边对走廊的要求）。 */
function horizontalSpans (
  edge: { readonly segments: readonly { readonly orientation: 'h' | 'v'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }[] },
  x: number,
): boolean {
  return edge.segments.some(segment =>
    segment.orientation === 'h'
    && Math.min(segment.x1, segment.x2) <= x
    && Math.max(segment.x1, segment.x2) >= x)
}

describe('正交路由：全部 fixture 的结构断言（Plan §8.2）', () => {
  const cases: ReadonlyArray<readonly [string, WorkflowGraph]> = [
    ['linear', graphOf(LINEAR)],
    ['fan-out', graphOf(FAN_OUT)],
    ['fan-in', graphOf(FAN_IN)],
    ['diamond', graphOf(DIAMOND)],
    ['long-edge', graphOf(LONG_EDGE)],
    ['finalizers', graphOf(FINALIZERS)],
    ['accident-response', graphOf(ACCIDENT_RESPONSE)],
    ['parking-patrol', graphOf(PARKING_PATROL)],
    ...VALID_FIXTURES.filter(([name]) => name === 'large' || name === 'wait-callback'),
  ]

  for (const [name, graph] of cases) {
    it(`${name}：所有 segment 只能水平或垂直`, () => {
      const model = compose(graph)
      expect(model.routedEdges.length).toBeGreaterThan(0)
      for (const edge of model.routedEdges) {
        for (const segment of edge.segments) {
          if (segment.orientation === 'h') {
            expect(Math.abs(segment.y1 - segment.y2)).toBeLessThanOrEqual(RANK_EPSILON)
          } else {
            expect(Math.abs(segment.x1 - segment.x2)).toBeLessThanOrEqual(RANK_EPSILON)
          }
        }
      }
    })

    it(`${name}：首点位于 source 底边，末点位于 target 顶边且末段垂直（含 rail）`, () => {
      const model = compose(graph)
      const nodes = new Map(model.geometry.nodes.map(item => [item.node.id, item]))
      for (const edge of model.routedEdges) {
        if (edge.visualKind === 'invalid' || edge.points.length < 2) continue
        const source = nodes.get(edge.edge.from)!
        const target = nodes.get(edge.edge.to)!
        const [firstX, firstY] = edge.points[0]!
        const [lastX, lastY] = edge.points.at(-1)!
        expect(firstY).toBeCloseTo(source.y + NODE_HEIGHT / 2, 0)
        expect(firstX).toBeGreaterThanOrEqual(source.x - NODE_WIDTH / 2 - RANK_EPSILON)
        expect(firstX).toBeLessThanOrEqual(source.x + NODE_WIDTH / 2 + RANK_EPSILON)
        // routing-polish §5.1：全部合法边（rail 含）从 target 顶部垂直进入 ——
        // 右侧水平入箭头已废，仅 invalid gutter 允许侧入。
        expect(lastY).toBeCloseTo(target.y - NODE_HEIGHT / 2, 0)
        expect(lastX).toBeGreaterThanOrEqual(target.x - NODE_WIDTH / 2 - RANK_EPSILON)
        expect(lastX).toBeLessThanOrEqual(target.x + NODE_WIDTH / 2 + RANK_EPSILON)
        // §5.2.3：末段必须垂直
        expect(edge.segments.at(-1)!.orientation, `${edge.edge.from}→${edge.edge.to} 末段水平`).toBe('v')
      }
    })

    it(`${name}：除 source/target 外不穿节点扩展矩形（+${ROUTE_CLEARANCE}px 净空）`, () => {
      const model = compose(graph)
      const nodes = model.geometry.nodes
      for (const edge of model.routedEdges) {
        if (edge.visualKind === 'invalid' || edge.points.length < 2) continue
        for (const segment of edge.segments) {
          for (const nodeItem of nodes) {
            if (nodeItem.node.id === edge.edge.from || nodeItem.node.id === edge.edge.to) continue
            const left = nodeItem.x - NODE_WIDTH / 2 - ROUTE_CLEARANCE
            const right = nodeItem.x + NODE_WIDTH / 2 + ROUTE_CLEARANCE
            const top = nodeItem.y - NODE_HEIGHT / 2 - ROUTE_CLEARANCE
            const bottom = nodeItem.y + NODE_HEIGHT / 2 + ROUTE_CLEARANCE
            if (segment.orientation === 'h') {
              const y = segment.y1
              const x1 = Math.min(segment.x1, segment.x2)
              const x2 = Math.max(segment.x1, segment.x2)
              const hits = y > top + RANK_EPSILON && y < bottom - RANK_EPSILON
                && x2 > left + RANK_EPSILON && x1 < right - RANK_EPSILON
              expect(hits, `${name}：${edge.edge.from}→${edge.edge.to} 的水平段穿过 ${nodeItem.node.id}`).toBe(false)
            } else {
              const x = segment.x1
              const y1 = Math.min(segment.y1, segment.y2)
              const y2 = Math.max(segment.y1, segment.y2)
              const hits = x > left + RANK_EPSILON && x < right - RANK_EPSILON
                && y2 > top + RANK_EPSILON && y1 < bottom - RANK_EPSILON
              expect(hits, `${name}：${edge.edge.from}→${edge.edge.to} 的垂直段穿过 ${nodeItem.node.id}`).toBe(false)
            }
          }
        }
      }
    })

    it(`${name}：同一 Band 内 x 重叠的水平段彼此相距 ≥ CHANNEL_GAP`, () => {
      const model = compose(graph)
      const horizontals = model.routedEdges
        .filter(edge => edge.visualKind !== 'invalid')
        .flatMap(edge => edge.segments
          .filter(segment => segment.orientation === 'h')
          .map(segment => ({
            key: `${edge.edge.from}\0${edge.edge.to}`,
            y: segment.y1,
            x1: Math.min(segment.x1, segment.x2),
            x2: Math.max(segment.x1, segment.x2),
          })))
      for (let i = 0; i < horizontals.length; i += 1) {
        for (let j = i + 1; j < horizontals.length; j += 1) {
          const a = horizontals[i]!
          const b = horizontals[j]!
          if (a.key === b.key) continue
          const overlaps = a.x2 >= b.x1 && a.x1 <= b.x2
          if (!overlaps) continue
          // 只约束 Band 内的通道段：节点边缘（Band 边界 ±净空之外）不算
          const inBand = model.geometry.bands.some(band =>
            a.y > band.top + ROUTE_CLEARANCE - RANK_EPSILON
            && a.y < band.bottom - ROUTE_CLEARANCE + RANK_EPSILON
            && b.y > band.top + ROUTE_CLEARANCE - RANK_EPSILON
            && b.y < band.bottom - ROUTE_CLEARANCE + RANK_EPSILON)
          if (!inBand) continue
          expect(
            Math.abs(a.y - b.y),
            `${name}：通道间距不足（${a.key} @${a.y} vs ${b.key} @${b.y}）`,
          ).toBeGreaterThanOrEqual(CHANNEL_GAP - RANK_EPSILON)
        }
      }
    })

    it(`${name}：合法 fixture 的 fallback 数为 0（Plan §4.6）`, () => {
      const model = compose(graph)
      expect(model.fallbackCount, `${name} 出现路由降级：${
        model.routedEdges.filter(edge => edge.fallback)
          .map(edge => `${edge.edge.from}→${edge.edge.to}(${edge.fallbackReason})`).join('、')
      }`).toBe(0)
    })

    it(`${name}：确定性 —— 同一模型重复运行输出完全一致（Plan §0.2.7）`, () => {
      const first = compose(graph)
      const second = compose(graph)
      expect(JSON.stringify(first.routedEdges.map(edge => [edge.edge.from, edge.edge.to, edge.points])))
        .toBe(JSON.stringify(second.routedEdges.map(edge => [edge.edge.from, edge.edge.to, edge.points])))
      expect(JSON.stringify(first.geometry.nodes.map(item => [item.node.id, item.x, item.y])))
        .toBe(JSON.stringify(second.geometry.nodes.map(item => [item.node.id, item.x, item.y])))
    })
  }
})

describe('正交路由：专项行为', () => {
  it('长边按每层 Band 逐层通过（折线 y 覆盖每个中间 Band）', () => {
    const graph = graphOf(LONG_EDGE)
    const model = compose(graph)
    const nodes = new Map(model.geometry.nodes.map(item => [item.node.id, item]))
    const start = nodes.get('start')!
    const end = nodes.get('end')!
    const edge = model.routedEdges.find(item => item.edge.from === 'start' && item.edge.to === 'end')!
    expect(edge).toBeDefined()
    const crossedBands = model.geometry.bands.filter(band =>
      band.index >= start.rank && band.index < end.rank)
    expect(crossedBands.length).toBeGreaterThanOrEqual(3)
    for (const band of crossedBands) {
      // 边的折线必须与该 Band 的 y 区间有重叠（同 x 的连续通道点会被合并，
      // 但垂直 stem 仍然逐层穿越 —— 覆盖性是「逐层通过」的结构判据）
      const covered = edge.segments.some((segment) => {
        const y1 = Math.min(segment.y1, segment.y2)
        const y2 = Math.max(segment.y1, segment.y2)
        return y2 > band.top + RANK_EPSILON && y1 < band.bottom - RANK_EPSILON
      })
      expect(covered, `长边未覆盖 Band ${band.index}`).toBe(true)
    }
    // 跨三层以上的长边不出现单条对角线（全部共轴段）
    for (const segment of edge.segments) {
      const diagonal = segment.x1 !== segment.x2 && segment.y1 !== segment.y2
      expect(diagonal).toBe(false)
    }
  })

  it('指向 allDone 的边获得 finalizer 视觉（Plan §1.2/§8.3）', () => {
    const model = compose(graphOf(FINALIZERS))
    const finalizerEdges = model.routedEdges.filter(edge => edge.visualKind === 'finalizer')
    expect(finalizerEdges.length).toBeGreaterThanOrEqual(3)
    for (const edge of finalizerEdges) {
      expect(edge.edge.to === 'close_ok' || edge.edge.to === 'close_fail').toBe(true)
    }
    // work → branch_left 无任何引用（refKinds 空、未降级）→ order-inline
    const branch = model.routedEdges.find(edge =>
      edge.edge.from === 'work' && edge.edge.to === 'branch_left')
    expect(branch!.visualKind).toBe('order-inline')
  })

  /**
   * 语义线型分档（semantic-columns plan §4）：判据只读 refKinds，
   * finalizer 档（目标 allDone）优先于 data/guard —— 表驱动优先级。
   */
  it('事故流程代表边的 visualKind：data / guard / order-inline / finalizer / implicit 分得开', () => {
    const model = compose(graphOf(ACCIDENT_RESPONSE))
    const kindOf = (from: string, to: string): string | undefined =>
      model.routedEdges.find(edge => edge.edge.from === from && edge.edge.to === to)?.visualKind
    // data：传值
    expect(kindOf('dispatch', 'mark_handling')).toBe('data')
    expect(kindOf('dispatch', 'poll')).toBe('data')
    // guard：只读判据（when 读 $state / taskStatus）
    expect(kindOf('poll', 'mark_completed')).toBe('guard')
    expect(kindOf('poll', 'mark_terminated')).toBe('guard')
    // order-inline：refKinds 为空且未降级（唯一父节点，不满足降级第三条件）
    expect(kindOf('ack', 'pick')).toBe('order-inline')
    // implicit：$trigger 挂载
    expect(kindOf('$trigger', 'ack')).toBe('implicit')
    // finalizer 优先于 guard：ack→close_ack_timeout 的 refKinds 是 when，
    // 但目标 allDone → finalizer 档（收尾语义压过判据语义）
    expect(kindOf('ack', 'close_ack_timeout')).toBe('finalizer')
  })

  it('rail 干道共用：全部 rail 边共用同一条 trunk 走廊，且干道不贴任何节点', () => {
    const model = compose(graphOf(ACCIDENT_RESPONSE))
    const railEdges = model.routedEdges.filter(edge => model.railNodeIds.has(edge.edge.to))
    // 事故流程指向 rail 的边：4 条常规来源走干道，2 条本身是降级边（角标表达）
    expect(railEdges.length).toBe(4)
    const railRight = Math.max(...model.geometry.nodes
      .filter(node => model.railNodeIds.has(node.node.id))
      .map(node => node.x + NODE_WIDTH / 2))
    const mainLeft = Math.min(...model.geometry.nodes
      .filter(node => !model.railNodeIds.has(node.node.id))
      .map(node => node.x - NODE_WIDTH / 2))
    // routing-polish §6.1/§6.4.2：跨 Band 的 rail 边在 trunk x 上有竖直段；
    // 相邻层（同 Band）的 rail 边合并为单通道后直穿 trunk 走廊 —— 共用的
    // 事实是「全部 rail 流量经过同一条走廊 x」，不是每条边都在那里拐弯。
    // 跨 Band 的 rail 边提供真实 trunk x（竖直段）；同 Band 直穿的边以
    // 「水平段横跨该 x」为共用凭证 —— 全部 rail 流量走同一条走廊。
    const verticalXs = new Set<number>()
    for (const edge of railEdges) {
      for (const x of railTrunkVerticalXs(edge, railRight, mainLeft)) verticalXs.add(x)
    }
    expect(verticalXs.size, 'rail 干道竖直段出现多条平行 x').toBe(1)
    const trunkX = [...verticalXs][0]!
    for (const edge of railEdges) {
      const passes = railTrunkVerticalXs(edge, railRight, mainLeft).includes(trunkX)
        || horizontalSpans(edge, trunkX)
      expect(passes, `${edge.edge.from}→${edge.edge.to} 未经过干道 ${trunkX}`).toBe(true)
    }
    // 干道不贴任何节点（含净空）
    for (const node of model.geometry.nodes) {
      expect(trunkX < node.x - NODE_WIDTH / 2 - ROUTE_CLEARANCE
        || trunkX > node.x + NODE_WIDTH / 2 + ROUTE_CLEARANCE, `干道 ${trunkX} 贴近 ${node.node.id}`).toBe(true)
    }
  })

  it('poll → mark_completed 在 mark_handling 正上方时仍垂直进入（目标 stem 避障）', () => {
    // routing-polish §5.3.6：mark_handling（状态列）直邻目标上方，旧实现把
    // stem 判定区间扩大到整个 Band 导致误逃逸、端口层水平 jog；
    // 新契约：末 stem 钉在端口 x，换道发生在目标上方 Band 通道内。
    const model = compose(graphOf(ACCIDENT_RESPONSE))
    const edge = model.routedEdges.find(item => item.edge.from === 'poll' && item.edge.to === 'mark_completed')!
    expect(edge.segments.at(-1)!.orientation).toBe('v')
    const target = model.geometry.nodes.find(node => node.node.id === 'mark_completed')!
    const [lastX, lastY] = edge.points.at(-1)!
    expect(lastY).toBeCloseTo(target.y - NODE_HEIGHT / 2, 0)
    expect(lastX).toBeCloseTo(target.x, 0) // 单入边端口 = 顶部中心
    expect(edge.fallback).toBe(false)
  })

  it('事故流程三个 close_* 收尾节点的箭头全部垂直进入顶部', () => {
    // routing-polish §5.3.4：rail 边从右缘水平进入已废，与全部合法边同规
    const model = compose(graphOf(ACCIDENT_RESPONSE))
    const nodes = new Map(model.geometry.nodes.map(item => [item.node.id, item]))
    for (const edge of model.routedEdges) {
      if (!model.railNodeIds.has(edge.edge.to)) continue
      const target = nodes.get(edge.edge.to)!
      expect(edge.segments.at(-1)!.orientation, `${edge.edge.from}→${edge.edge.to}`).toBe('v')
      const [lastX, lastY] = edge.points.at(-1)!
      expect(lastY).toBeCloseTo(target.y - NODE_HEIGHT / 2, 0)
      expect(lastX).toBeGreaterThan(target.x - NODE_WIDTH / 2)
      expect(lastX).toBeLessThan(target.x + NODE_WIDTH / 2)
    }
  })

  it('rail 边拐弯数 ≤ 4，且不出现短往返段（全部含 rail 的 fixture）', () => {
    // routing-polish §6.4.1/§6.4.5：≤5 段 ≤4 拐；每段长度 ≥ ROUTE_CLEARANCE
    // —— 干道上的两条通道间短竖折返（同 Band 双通道）已被单通道合并消除。
    for (const [name, json] of [['accident', ACCIDENT_RESPONSE], ['finalizers', FINALIZERS], ['parking', PARKING_PATROL]] as const) {
      const model = compose(graphOf(json))
      const railEdges = model.routedEdges.filter(edge => model.railNodeIds.has(edge.edge.to))
      expect(railEdges.length, name).toBeGreaterThan(0)
      for (const edge of railEdges) {
        const bends = edge.points.length - 2
        expect(bends, `${name} ${edge.edge.from}→${edge.edge.to} bends=${bends}`).toBeLessThanOrEqual(4)
        for (const segment of edge.segments) {
          const length = Math.abs(segment.orientation === 'h'
            ? segment.x2 - segment.x1
            : segment.y2 - segment.y1)
          expect(length, `${name} ${edge.edge.from}→${edge.edge.to} 存在 ${length.toFixed(1)}px 短段`).toBeGreaterThanOrEqual(ROUTE_CLEARANCE - RANK_EPSILON)
        }
      }
    }
  })

  it('parking 的 close_error 8 needs 压力用例：路由/角标各就各位且 fallback 0', () => {
    // routing-polish §6.4.7：8 条 needs 的压力落在「降级 + 布线」组合上 ——
    // 带引用的边（mark_done→close_error，when 读 mark_done）走 rail 干道；
    // 其余 7 条纯顺序边降级为 afterBadges 角标（ordering plan §4）。
    // 可路由的 rail 边拐弯 ≤ 4、末段垂直、整图 fallback 0。
    const model = compose(graphOf(PARKING_PATROL))
    const intoClose = model.routedEdges.filter(edge => edge.edge.to === 'close_error')
    expect(intoClose.length).toBeGreaterThanOrEqual(1)
    const badges = model.ordering.afterBadges.get('close_error') ?? []
    expect(intoClose.length + badges.length, '8 条 needs 必须路由或降级，一个不落').toBe(8)
    for (const edge of intoClose) {
      expect(edge.fallback, `${edge.edge.from}→close_error fallback`).toBe(false)
      expect(edge.points.length - 2).toBeLessThanOrEqual(4)
      expect(edge.segments.at(-1)!.orientation).toBe('v')
    }
    expect(model.fallbackCount).toBe(0)
  })

  it('trigger 隐式边获得 implicit 视觉', () => {
    const model = compose(graphOf(LINEAR))
    const implicit = model.routedEdges.find(edge => edge.edge.from === '$trigger')
    expect(implicit!.visualKind).toBe('implicit')
  })

  it('非单调/环边进入右侧错误 gutter（红色虚线展示，Plan §3.4）', () => {
    for (const json of [INVALID_CYCLE, CYCLE_MUTUAL]) {
      const graph = graphOf(json)
      const model = compose(graph)
      const invalid = model.routedEdges.filter(edge => edge.visualKind === 'invalid')
      expect(invalid.length).toBeGreaterThanOrEqual(1)
      const rightmost = Math.max(...model.geometry.nodes.map(item => item.x + NODE_WIDTH / 2))
      for (const edge of invalid) {
        // gutter 段在最右节点的右侧
        const maxX = Math.max(...edge.points.map(point => point[0]))
        expect(maxX).toBeGreaterThan(rightmost)
      }
      // 环边不算 fallback（错误可见可删即可）
      for (const edge of invalid) expect(edge.fallback).toBe(false)
    }
  })

  it('band 通道耗尽时扩层重排，不静默穿节点（Plan §2.3/§4.3）', () => {
    // 同一 source → 20 个目标的跨层边会需要多条平行通道
    const json = `{"steps":[
      {"id":"hub","action":"x"},
      ${Array.from({ length: 20 }, (_, i) => `{"id":"wide_${i}","action":"x","needs":["hub"]}`).join(',')}
    ]}`
    const model = compose(graphOf(json))
    expect(model.fallbackCount).toBe(0)
    // Band 1（hub → 20 个目标）扩层后高于原始 88（20 条通道 × 10px > 容量 7）
    expect(model.geometry.bands[1]!.bottom - model.geometry.bands[1]!.top).toBeGreaterThan(88)
  })

  it('legacy-smooth 模式：边为贝塞尔骨架（Q 出现），无 Band/端口语义', () => {
    const graph = graphOf(DIAMOND)
    const presentations = projectNodePresentations(graph, EMPTY_CATALOG)
    const model = composeCanvasLayout(graph, presentations, {
      routingMode: 'legacy-smooth',
    })
    expect(model.mode).toBe('legacy-smooth')
    expect(model.ports).toBeNull()
    expect(model.geometry.bands).toHaveLength(0)
    expect(model.routedEdges.length).toBeGreaterThan(0)
  })

  it('收尾 rail（semantic-columns §5.3）：finalizers fixture 的收尾节点固定最左列', () => {
    const graph = graphOf(FINALIZERS)
    const model = compose(graph)
    const mainIds = ['work', 'branch_left', 'branch_right']
    const mainMin = Math.min(...model.geometry.nodes
      .filter(item => mainIds.includes(item.node.id))
      .map(item => item.x - NODE_WIDTH / 2))
    for (const id of ['close_ok', 'close_fail']) {
      const x = model.geometry.nodes.find(item => item.node.id === id)!.x
      expect(x + NODE_WIDTH / 2, `${id} 应在主链最左侧之外（rail 列）`).toBeLessThan(mainMin)
    }
    expect(model.fallbackCount).toBe(0)
  })

  it('全部 fixture 满足正交/不穿节点/fallback 0（semantic-columns 后）', () => {
    for (const [name, graph] of VALID_FIXTURES) {
      const model = compose(graph)
      expect(model.fallbackCount, `${name}`).toBe(0)
      const nodes = model.geometry.nodes
      for (const edge of model.routedEdges) {
        if (edge.visualKind === 'invalid' || edge.points.length < 2) continue
        for (const segment of edge.segments) {
          if (segment.orientation === 'h') {
            expect(Math.abs(segment.y1 - segment.y2), `${name} 出现斜线`).toBeLessThanOrEqual(RANK_EPSILON)
          } else {
            expect(Math.abs(segment.x1 - segment.x2), `${name} 出现斜线`).toBeLessThanOrEqual(RANK_EPSILON)
          }
          for (const nodeItem of nodes) {
            if (nodeItem.node.id === edge.edge.from || nodeItem.node.id === edge.edge.to) continue
            const left = nodeItem.x - NODE_WIDTH / 2 - ROUTE_CLEARANCE
            const right = nodeItem.x + NODE_WIDTH / 2 + ROUTE_CLEARANCE
            const top = nodeItem.y - NODE_HEIGHT / 2 - ROUTE_CLEARANCE
            const bottom = nodeItem.y + NODE_HEIGHT / 2 + ROUTE_CLEARANCE
            let hits: boolean
            if (segment.orientation === 'h') {
              const x1 = Math.min(segment.x1, segment.x2)
              const x2 = Math.max(segment.x1, segment.x2)
              hits = segment.y1 > top + RANK_EPSILON && segment.y1 < bottom - RANK_EPSILON
                && x2 > left + RANK_EPSILON && x1 < right - RANK_EPSILON
            } else {
              const y1 = Math.min(segment.y1, segment.y2)
              const y2 = Math.max(segment.y1, segment.y2)
              hits = segment.x1 > left + RANK_EPSILON && segment.x1 < right - RANK_EPSILON
                && y2 > top + RANK_EPSILON && y1 < bottom - RANK_EPSILON
            }
            expect(hits, `${name}：${edge.edge.from}→${edge.edge.to} 穿过 ${nodeItem.node.id}`).toBe(false)
          }
        }
      }
    }
  })
})

describe('视觉 fixture 门槛（Plan §8.6）', () => {
  it('large fixture 至少 30 节点 / 60 边且全部路由成功', () => {
    const large = VALID_FIXTURES.find(([name]) => name === 'large')![1]
    expect(large.nodes.length).toBeGreaterThanOrEqual(30)
    expect(large.edges.length).toBeGreaterThanOrEqual(60)
    const model = compose(large)
    expect(model.routedEdges).toHaveLength(large.edges.length)
    expect(model.fallbackCount).toBe(0)
  })

  it('全部正式 fixture 的 fallback 汇总为 0', () => {
    for (const [name, graph] of VALID_FIXTURES) {
      const model = compose(graph)
      expect(model.fallbackCount, `${name}`).toBe(0)
    }
  })
})

describe('顺序边降级：进入路由器的边数（ordering plan §4.4）', () => {
  it('aCCIDENT_RESPONSE 从 17 条降到 12 条，fallback 仍为 0', () => {
    const graph = graphOf(ACCIDENT_RESPONSE)
    expect(graph.edges).toHaveLength(17)
    const model = compose(graph)
    expect(model.routedEdges).toHaveLength(12)
    expect(model.fallbackCount).toBe(0)
    // 降级的 5 条不在路由产物里（无端口、无通道）
    expect(model.routedEdges.some(edge => edge.edge.from === 'mark_ack' && edge.edge.to === 'mark_handling'))
      .toBe(false)
    // inline 模式（回归开关）：全部 17 条照旧布线
    const inline = compose(graph, { orderingEdgeMode: 'inline' })
    expect(inline.routedEdges).toHaveLength(17)
    expect(inline.fallbackCount).toBe(0)
  })
})
