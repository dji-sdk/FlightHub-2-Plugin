// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { TRIGGER_NODE_ID } from '../../../../../src/workflow/core/model.js'
import { EMPTY_CATALOG } from '../../../../../src/workflow/core/catalog.js'
import type { ActionCatalog } from '../../../../../src/workflow/core/catalog.js'
import type { NodeTrait } from './semantic-role.js'
import { TRAIT_LABELS, displayTraits, projectNodePresentations } from './semantic-role.js'
import { ACCIDENT_RESPONSE, FINALIZERS, graphOf } from './fixtures.js'

/** 可判 await_signal 的最小词表（available=true 才会查 fixedSteps）。 */
function catalogWithAwaitSignal (): ActionCatalog {
  return {
    ...EMPTY_CATALOG,
    available: true,
    fixedSteps: [
      { action: 'wait_signal', kind: 'await_signal', owner: 'platform', inputs: [], outputs: [] },
      { action: 'update_event_status', kind: 'activity', owner: 'platform', inputs: [], outputs: [] },
    ],
  }
}

describe('semantic-role 投影（Plan §1.1/§8.3）', () => {
  it('trigger 节点投影为 trigger 角色，不带任何 trait', () => {
    const presentations = projectNodePresentations(graphOf(`{"steps":[{"id":"a","action":"x"}]}`), EMPTY_CATALOG)
    const trigger = presentations.get(TRIGGER_NODE_ID)!
    expect(trigger.role).toBe('trigger')
    expect(trigger.traits).toEqual([])
    expect(trigger.laneHint).toBe('main')
  })

  it('allDone 且无下游 → terminal-finalizer + side-finalizer lane', () => {
    const presentations = projectNodePresentations(graphOf(`{"steps":[
      {"id":"work","action":"x"},
      {"id":"close","action":"x","needs":["work"],"trigger":"allDone"}
    ]}`), EMPTY_CATALOG)
    const close = presentations.get('close')!
    expect(close.traits).toContain('all-done')
    expect(close.traits).toContain('terminal-finalizer')
    expect(close.laneHint).toBe('side-finalizer')
    expect(presentations.get('work')!.laneHint).toBe('main')
  })

  it('allDone 有下游节点 → 仅 all-done 样式，不侧移（Plan §1.1）', () => {
    const presentations = projectNodePresentations(graphOf(`{"steps":[
      {"id":"work","action":"x"},
      {"id":"mid","action":"x","needs":["work"],"trigger":"allDone"},
      {"id":"final","action":"x","needs":["mid"]}
    ]}`), EMPTY_CATALOG)
    const mid = presentations.get('mid')!
    expect(mid.traits).toContain('all-done')
    expect(mid.traits).not.toContain('terminal-finalizer')
    expect(mid.laneHint).toBe('main')
  })

  it('显式 await 段 → wait trait；词表 await_signal 动作同样 → wait', () => {
    const catalog = catalogWithAwaitSignal()
    const presentations = projectNodePresentations(graphOf(`{"steps":[
      {"id":"explicit","action":"update_event_status","await":{"signal":"s","timeoutSec":5}},
      {"id":"by_kind","action":"wait_signal"},
      {"id":"plain","action":"update_event_status"}
    ]}`), catalog)
    expect(presentations.get('explicit')!.traits).toContain('wait')
    expect(presentations.get('by_kind')!.traits).toContain('wait')
    expect(presentations.get('plain')!.traits).not.toContain('wait')
  })

  it('词表不可用（available=false）时 wait 只认显式 await 段（宁可漏判）', () => {
    const presentations = projectNodePresentations(graphOf(`{"steps":[
      {"id":"by_kind","action":"wait_signal"},
      {"id":"explicit","action":"x","await":{"signal":"s","timeoutSec":5}}
    ]}`), EMPTY_CATALOG)
    expect(presentations.get('by_kind')!.traits).not.toContain('wait')
    expect(presentations.get('explicit')!.traits).toContain('wait')
  })

  it('callback / when 各自投影为独立 trait，可组合', () => {
    const presentations = projectNodePresentations(graphOf(`{"steps":[
      {"id":"combo","action":"x","callback":{"signal":"c","timeoutSec":5},"when":{"field":"trigger.a","op":"present"}}
    ]}`), EMPTY_CATALOG)
    const traits = presentations.get('combo')!.traits
    expect(traits).toContain('callback')
    expect(traits).toContain('conditional')
    expect(traits).not.toContain('wait')
  })

  it('不根据节点名称（如 close_ 前缀）推断语义（Plan §0.3/§8.3）', () => {
    const presentations = projectNodePresentations(graphOf(`{"steps":[
      {"id":"close_whatever","action":"update_event_status","needs":[]}
    ]}`), EMPTY_CATALOG)
    const traits = presentations.get('close_whatever')!.traits
    expect(traits).not.toContain('all-done')
    expect(traits).not.toContain('terminal-finalizer')
    expect(traits).not.toContain('wait')
  })

  it('真实事故流程：3 个收尾 allDone 全部识别为 terminal-finalizer', () => {
    const presentations = projectNodePresentations(graphOf(ACCIDENT_RESPONSE), EMPTY_CATALOG)
    expect(presentations.get('close_ack_timeout')!.traits).toContain('terminal-finalizer')
    expect(presentations.get('close_ignored')!.traits).toContain('terminal-finalizer')
    expect(presentations.get('close_error')!.traits).toContain('terminal-finalizer')
    // 等待步
    expect(presentations.get('ack')!.traits).toContain('wait')
    expect(presentations.get('pick')!.traits).toContain('wait')
    // 条件步
    expect(presentations.get('mark_ack')!.traits).toContain('conditional')
  })

  it('finalizers fixture：两个终点型 allDone 都是 side-finalizer，普通步留在 main', () => {
    const presentations = projectNodePresentations(graphOf(FINALIZERS), EMPTY_CATALOG)
    expect(presentations.get('close_ok')!.laneHint).toBe('side-finalizer')
    expect(presentations.get('close_fail')!.laneHint).toBe('side-finalizer')
    expect(presentations.get('work')!.laneHint).toBe('main')
  })
})

describe('displayTraits：展示 Trait 与内部布局 Trait 分离（readability Plan §3.4）', () => {
  it('同时具有 all-done 与 terminal-finalizer 时，徽标只保留一个「收尾」', () => {
    const presentations = projectNodePresentations(graphOf(ACCIDENT_RESPONSE), EMPTY_CATALOG)
    for (const id of ['close_ack_timeout', 'close_ignored', 'close_error']) {
      const close = presentations.get(id)!
      expect(close.traits).toContain('all-done')
      expect(close.traits).toContain('terminal-finalizer')
      const shown = displayTraits(close.traits)
      expect(shown, id).not.toContain('terminal-finalizer')
      expect(shown, id).toContain('all-done')
      const label = shown.map(trait => TRAIT_LABELS[trait]).join(' · ')
      expect(label.match(/收尾/g) ?? [], `${id} 徽标重复：${label}`).toHaveLength(1)
    }
  })

  it('displayTraits 只影响展示，不改 traits/laneHint 等内部判据', () => {
    const presentations = projectNodePresentations(graphOf(ACCIDENT_RESPONSE), EMPTY_CATALOG)
    const close = presentations.get('close_error')!
    const expected: readonly NodeTrait[] = [...displayTraits(close.traits), 'terminal-finalizer']
    expect(expected.every(trait => close.traits.includes(trait))).toBe(true)
    expect(close.laneHint).toBe('side-finalizer')
    // 非终点 allDone（有下游）本就没有 terminal-finalizer，展示不受影响
    const mid = projectNodePresentations(graphOf(`{"steps":[
      {"id":"work","action":"x"},
      {"id":"mid","action":"x","needs":["work"],"trigger":"allDone"},
      {"id":"final","action":"x","needs":["mid"]}
    ]}`), EMPTY_CATALOG).get('mid')!
    expect(displayTraits(mid.traits)).toEqual(mid.traits)
  })
})
