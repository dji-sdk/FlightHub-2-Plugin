// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EMPTY_CATALOG } from '../../../../../src/workflow/core/catalog.js'
import type { WorkflowGraph } from '../../../../../src/workflow/core/model.js'
import { composeCanvasLayout } from './workflow-canvas.js'
import { displayTraits, projectNodePresentations } from './semantic-role.js'
import { orderingBadgeText } from './ordering.js'
import { orthogonalPath } from './edge-path.js'
import { NODE_HEIGHT, NODE_WIDTH } from './layout.js'
import {
  ACCIDENT_RESPONSE,
  CYCLE_MUTUAL,
  FINALIZERS,
  PARKING_PATROL,
  SNAPSHOT_OUTPUT_DIR,
  VALID_FIXTURES,
  graphOf,
} from './fixtures.js'

/**
 * 视觉 fixture 快照（Plan §7.4-17/§8.6）：把正式 fixture 渲染成独立 SVG，
 * 供人工截图评审与视觉 token 冻结比对。几何正确性由 routing.test.ts 的
 * 结构断言负责，快照只用于发现布局变化。
 *
 * 产物目录 .canvas-snapshots/ 不进 git；跑一次测试即刷新。
 */

const EDGE_KIND_COLOR: Readonly<Record<string, string>> = {
  implicit: '#4d5052',
  data: '#7d8187',
  guard: '#5f6368',
  'order-inline': '#5f6368',
  finalizer: '#5a5d61',
  invalid: '#d64545',
}

/** 线宽与虚线（semantic-columns plan §4）：data 2 实线 > order-inline 1.1 实线 > guard 点线。 */
const EDGE_KIND_STYLE: Readonly<Record<string, { readonly width: number; readonly dash: string }>> = {
  implicit: { width: 1.6, dash: '5 4' },
  data: { width: 2, dash: 'none' },
  guard: { width: 1.6, dash: '3 4' },
  'order-inline': { width: 1.1, dash: 'none' },
  finalizer: { width: 1.6, dash: 'none' },
  invalid: { width: 2, dash: '6 4' },
}

function fixtureSvg (graph: WorkflowGraph): string {
  const presentations = projectNodePresentations(graph, EMPTY_CATALOG)
  const model = composeCanvasLayout(graph, presentations, {
    routingMode: 'orthogonal-v1',
  })
  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(model.width)}" height="${Math.ceil(model.height)}" viewBox="0 0 ${Math.ceil(model.width)} ${Math.ceil(model.height)}" font-family="sans-serif">`)
  parts.push('<rect width="100%" height="100%" fill="#1e1e1e"/>')
  for (const edge of model.routedEdges) {
    if (edge.points.length < 2) continue
    const color = edge.fallback ? '#b8870b' : EDGE_KIND_COLOR[edge.visualKind] ?? '#6f7276'
    const style = EDGE_KIND_STYLE[edge.visualKind] ?? { width: 1.6, dash: 'none' }
    const dash = edge.fallback ? '2 3' : style.dash
    const dashAttr = dash === 'none' ? '' : ` stroke-dasharray="${dash}"`
    const width = edge.visualKind === 'invalid' ? 2 : style.width
    parts.push(`<path d="${orthogonalPath(edge.points)}" fill="none" stroke="${color}" stroke-width="${width}"${dashAttr}/>`)
  }
  for (const item of model.geometry.nodes) {
    const presentation = presentations.get(item.node.id)
    // 徽标只画展示性 Trait（readability Plan §3.4，与画布一致）
    const traits = displayTraits(presentation?.traits ?? []).join(' ')
    // 顺序依赖角标（ordering plan §4.2）：与画布同文案
    const afterIds = model.ordering.afterBadges.get(item.node.id)
    const fill = item.node.kind === 'trigger' ? '#1f3330' : '#2b2d31'
    const stroke = presentation?.traits.includes('wait') === true ? '#3fa9a0' : '#45484d'
    parts.push(`<g transform="translate(${item.x - NODE_WIDTH / 2}, ${item.y - NODE_HEIGHT / 2})">`)
    parts.push(`<rect width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>`)
    parts.push(`<text x="12" y="24" fill="#e4e6e9" font-size="13" font-weight="600">${escapeXml(item.node.id)}</text>`)
    parts.push(`<text x="12" y="43" fill="#9aa0a6" font-size="11" font-family="monospace">${escapeXml(item.node.action)}</text>`)
    if (traits !== '') {
      parts.push(`<text x="${NODE_WIDTH - 12}" y="24" fill="#7e848a" font-size="10" text-anchor="end">${escapeXml(traits)}</text>`)
    }
    if (afterIds !== undefined && afterIds.length > 0) {
      parts.push(`<text x="12" y="${NODE_HEIGHT - 6}" fill="#7e848a" font-size="10">${escapeXml(orderingBadgeText(item.node.triggerMode, afterIds, (NODE_WIDTH - 24) / 10))}</text>`)
    }
    parts.push('</g>')
  }
  parts.push(`<text x="8" y="${Math.max(12, model.height - 8)}" fill="#7e848a" font-size="10">nodes=${model.geometry.nodes.length} edges=${model.routedEdges.length} demoted=${model.ordering.demoted.size} fallback=${model.fallbackCount}</text>`)
  parts.push('</svg>')
  return parts.join('\n')
}

function escapeXml (text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

describe('视觉 fixture 快照（Plan §8.6，人工评审用）', () => {
  it('把正式 fixture 输出为独立 SVG 文件', () => {
    mkdirSync(SNAPSHOT_OUTPUT_DIR, { recursive: true })
    const outputs: ReadonlyArray<readonly [string, WorkflowGraph]> = [
      ['accident-response', graphOf(ACCIDENT_RESPONSE)],
      ['parking-patrol', graphOf(PARKING_PATROL)],
      ['finalizers', graphOf(FINALIZERS)],
      ['invalid-cycle', graphOf(CYCLE_MUTUAL)],
      ...VALID_FIXTURES.filter(([name]) => name === 'large'),
    ]
    for (const [name, graph] of outputs) {
      const svg = fixtureSvg(graph)
      expect(svg.length, name).toBeGreaterThan(500)
      writeFileSync(join(SNAPSHOT_OUTPUT_DIR, `${name}.svg`), svg, 'utf8')
    }
    expect(outputs.length).toBeGreaterThanOrEqual(5)
  })
})
