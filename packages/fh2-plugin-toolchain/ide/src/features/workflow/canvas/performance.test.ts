// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { EMPTY_CATALOG } from '../../../../../src/workflow/core/catalog.js'
import { composeCanvasLayout } from './workflow-canvas.js'
import { projectNodePresentations } from './semantic-role.js'
import { graphOf } from './fixtures.js'

/**
 * 性能门槛（Plan §9）：200 节点 / 400 边在常规开发机 150ms 内完成
 * layout + routing。CI 时间抖动大，断言用 10 倍余量防病理性退化
 * （实测 2026-09 本机 ≈52ms）；精确数字记录在 findings.md。
 */
describe('性能门槛（Plan §9）', () => {
  it('201 节点 / 395 边：完整管线在 1.5s 内完成且 fallback 为 0', () => {
    // 40 层 × 5 节点 = 200 step + trigger；每层向下两连 → ~395 边
    const steps: string[] = []
    const tiers = 40
    const per = 5
    for (let t = 0; t < tiers; t += 1) {
      for (let i = 0; i < per; i += 1) {
        steps.push(`{"id":"n${t}_${i}","action":"x"${t === 0 ? '' : `,"needs":["n${t - 1}_${i}","n${t - 1}_${(i + 2) % per}"]`}}`)
      }
    }
    const graph = graphOf(`{"trigger":{"api":{}},"steps":[${steps.join(',')}]}`)
    expect(graph.nodes.length).toBeGreaterThanOrEqual(200)
    expect(graph.edges.length).toBeGreaterThanOrEqual(390)

    const presentations = projectNodePresentations(graph, EMPTY_CATALOG)
    // 预热一次（JIT / 模块加载），计时从第二次开始
    composeCanvasLayout(graph, presentations, { routingMode: 'orthogonal-v1' })
    const start = performance.now()
    const model = composeCanvasLayout(graph, presentations, { routingMode: 'orthogonal-v1' })
    const elapsed = performance.now() - start
    expect(model.fallbackCount).toBe(0)
    expect(elapsed).toBeLessThan(1500)
  })
})
