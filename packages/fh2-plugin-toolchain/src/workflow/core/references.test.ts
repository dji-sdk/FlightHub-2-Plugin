// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { applyJsonEditOps, parseJsonValue } from './json-edits.js'
import {
  collectReferences,
  findCycle,
  impactsOfDisconnect,
  impactsOfRemovingStep,
  reachableAncestors,
  renameRefStepId,
  renameStepEdits,
} from './references.js'

/**
 * 引用站点的用例。每一条对应一种**静默**失真：
 *   漏一个站点     → 重命名后那条 when 恒假，收尾节点再也不跑，日志里没有异常
 *   字符串整体替换 → 路径仍合法但指向不存在的键，发布期才报且离操作很远
 *   自动重接/删除  → 用户的接线被悄悄改指或丢掉
 *   环检查跑在增量上 → 一次加两条边的操作能把环放过去
 */

/** 五种引用站点各出现一次的文档。 */
const RAW = {
  name: 'f',
  trigger: { api: { seed: ['eventId'] } },
  steps: [
    { id: 'pick', action: 'run_script', inputs: { script: { const: 's1' } } },
    {
      id: 'evaluate',
      action: 'run_script',
      needs: ['pick'],
      inputs: {
        script: { const: 's2' },
        // ② inputs.*.from —— 注意键名 pickedId 里也含 "pick"，整体替换会连它一起改坏
        picked: { from: 'steps.pick.pickedId' },
        seeded: { from: 'trigger.eventId' },
      },
      // ③ when（嵌套在 and 里，只看顶层 field 会漏掉）
      when: { and: [{ field: 'steps.pick.$state', op: 'eq', value: 'succeeded' }] },
      // ④ await.timeoutSecFrom
      await: { signal: 'ack', timeoutSecFrom: 'steps.pick.waitSec' },
    },
    {
      id: 'finalize',
      action: 'update_event_status',
      needs: ['evaluate'],
      trigger: 'allDone',
      // ⑤ callback.timeoutSecFrom
      callback: { signal: 'done', timeoutSecFrom: 'steps.pick.cbSec' },
      inputs: { status: { const: 'closed' } },
    },
  ],
} as Record<string, unknown>

describe('collectReferences', () => {
  it('五种站点一个不漏', () => {
    const kinds = collectReferences(RAW).map(site => site.kind)
    expect(new Set(kinds)).toEqual(new Set(['needs', 'input', 'when', 'awaitTimeout', 'callbackTimeout']))
  })

  it('递归进 when 的 and/or，不只看顶层 field', () => {
    const when = collectReferences(RAW).filter(site => site.kind === 'when')
    expect(when).toHaveLength(1)
    expect(when[0]).toMatchObject({
      stepId: 'evaluate',
      at: 'when.and[0].field',
      value: 'steps.pick.$state',
      targetStepId: 'pick',
    })
  })

  it('trigger.* 与 run.* 根没有 targetStepId（它们不指向步骤）', () => {
    const seeded = collectReferences(RAW).find(site => site.at === 'inputs.seeded.from')
    expect(seeded?.value).toBe('trigger.eventId')
    expect(seeded?.targetStepId).toBeUndefined()
  })

  it('每个站点的 path 都能直接喂给 json-edits', () => {
    const text = `${JSON.stringify(RAW, null, 2)}\n`
    for (const site of collectReferences(RAW)) {
      const next = applyJsonEditOps(text, [{ path: [...site.path], value: '标记' }])
      expect(next, `${site.stepId}/${site.at} 的 path 写不进去`).not.toBe(text)
    }
  })
})

describe('renameRefStepId', () => {
  it('只换 step id 段，不动后面同名的键', () => {
    // 整体字符串替换会得到 steps.chosen.chosenedId —— 仍然合法，但指向不存在的键。
    expect(renameRefStepId('steps.pick.pickedId', 'pick', 'chosen')).toBe('steps.chosen.pickedId')
  })

  it('不匹配的引用原样返回', () => {
    expect(renameRefStepId('steps.other.x', 'pick', 'chosen')).toBe('steps.other.x')
    expect(renameRefStepId('trigger.pick', 'pick', 'chosen')).toBe('trigger.pick')
    expect(renameRefStepId('run.now', 'pick', 'chosen')).toBe('run.now')
  })

  it('保留深路径与保留段', () => {
    expect(renameRefStepId('steps.pick.$state', 'pick', 'chosen')).toBe('steps.chosen.$state')
    expect(renameRefStepId('steps.pick.a.b.c', 'pick', 'chosen')).toBe('steps.chosen.a.b.c')
  })
})

describe('renameStepEdits', () => {
  it('改 id 字段 + 全部五种引用站点', () => {
    const text = `${JSON.stringify(RAW, null, 2)}\n`
    const next = applyJsonEditOps(text, [...renameStepEdits(RAW, 'pick', 'chosen')])
    const value = parseJsonValue(next) as typeof RAW & {
      steps: Record<string, any>[];
    }

    expect(value.steps[0]!.id).toBe('chosen')
    expect(value.steps[1]!.needs).toEqual(['chosen'])
    expect(value.steps[1]!.inputs.picked.from).toBe('steps.chosen.pickedId')
    expect(value.steps[1]!.when.and[0].field).toBe('steps.chosen.$state')
    expect(value.steps[1]!.await.timeoutSecFrom).toBe('steps.chosen.waitSec')
    expect(value.steps[2]!.callback.timeoutSecFrom).toBe('steps.chosen.cbSec')
    // 与被改步骤无关的引用一个都没动。
    expect(value.steps[1]!.inputs.seeded.from).toBe('trigger.eventId')
    expect(value.steps[2]!.needs).toEqual(['evaluate'])
  })

  it('改完之后文档里不再有旧 id 的任何引用', () => {
    const text = `${JSON.stringify(RAW, null, 2)}\n`
    const next = applyJsonEditOps(text, [...renameStepEdits(RAW, 'pick', 'chosen')])
    const leftovers = collectReferences(parseJsonValue(next) as Record<string, unknown>)
      .filter(site => site.targetStepId === 'pick')
    expect(leftovers).toEqual([])
  })

  it('不存在的 id 回空编辑（不该凭空改任何东西）', () => {
    expect(renameStepEdits(RAW, 'nope', 'x')).toEqual([])
  })
})

describe('impactsOfRemovingStep', () => {
  it('列出全部受影响站点，但不产出任何编辑（只报告，不自动改）', () => {
    const impacts = impactsOfRemovingStep(RAW, 'pick')
    expect(impacts.map(impact => impact.at).sort()).toEqual([
      'await.timeoutSecFrom',
      'callback.timeoutSecFrom',
      'inputs.picked.from',
      'needs[0]',
      'when.and[0].field',
    ])
    // 每条都要说清「为什么会受影响」——它是用户唯一能看到的解释。
    for (const impact of impacts) expect(impact.why).not.toBe('')
  })

  it('不把被删步骤自己的引用算进影响（它要跟着一起走）', () => {
    expect(impactsOfRemovingStep(RAW, 'evaluate').map(impact => impact.stepId)).toEqual(['finalize'])
  })

  it('没人引用时回空', () => {
    expect(impactsOfRemovingStep(RAW, 'finalize')).toEqual([])
  })
})

describe('impactsOfDisconnect', () => {
  it('断控制依赖时把还指着它的取值列出来（数据依赖不随控制依赖自动消失）', () => {
    const impacts = impactsOfDisconnect(RAW, 'pick', 'evaluate')
    expect(impacts.map(impact => impact.at).sort()).toEqual([
      'await.timeoutSecFrom',
      'inputs.picked.from',
      'when.and[0].field',
    ])
    // needs 自己不算影响：它就是被断的那条边。
    expect(impacts.some(impact => impact.at.startsWith('needs'))).toBe(false)
  })

  it('目标步没引用上游产出时回空（可以安全断开）', () => {
    expect(impactsOfDisconnect(RAW, 'evaluate', 'finalize')).toEqual([])
  })

  it('dAG-005-11：断开后仍传递可达时不算 broken impact（不误弹断引用审批）', () => {
    // pick → middle → evaluate：断开 pick → evaluate 后 evaluate 仍经 middle 可达 pick，
    // 指向 pick 的取值接线依旧解得开，不该弹确认。
    const raw = {
      steps: [
        { id: 'pick', action: 'run_script' },
        { id: 'middle', action: 'run_script', needs: ['pick'] },
        { id: 'evaluate', action: 'run_script', needs: ['pick', 'middle'], inputs: { picked: { from: 'steps.pick.pickedId' } } },
      ],
    }
    expect(impactsOfDisconnect(raw, 'pick', 'evaluate')).toEqual([])
    // 对照：没有 middle 时同一处接线会解不开，仍要弹。
    const direct = {
      steps: [
        { id: 'pick', action: 'run_script' },
        { id: 'evaluate', action: 'run_script', needs: ['pick'], inputs: { picked: { from: 'steps.pick.pickedId' } } },
      ],
    }
    expect(impactsOfDisconnect(direct, 'pick', 'evaluate')).toHaveLength(1)
  })
})

describe('reachableAncestors', () => {
  it('算传递闭包，不只算直接上游', () => {
    const closures = reachableAncestors(RAW)
    expect([...closures.get('finalize')!].sort()).toEqual(['evaluate', 'pick'])
    expect([...closures.get('evaluate')!]).toEqual(['pick'])
    expect([...closures.get('pick')!]).toEqual([])
  })

  it('有环时不死循环', () => {
    const cyclic = {
      steps: [
        { id: 'a', needs: ['b'] },
        { id: 'b', needs: ['a'] },
      ],
    }
    expect(() => reachableAncestors(cyclic)).not.toThrow()
  })
})

describe('findCycle', () => {
  it('无环回 null', () => {
    expect(findCycle(RAW)).toBeNull()
  })

  it('自环与两点环都能找出来', () => {
    expect(findCycle({ steps: [{ id: 'a', needs: ['a'] }] })).toEqual(['a', 'a'])
    const two = findCycle({ steps: [{ id: 'a', needs: ['b'] }, { id: 'b', needs: ['a'] }] })
    expect(two).not.toBeNull()
    expect(new Set(two!)).toEqual(new Set(['a', 'b']))
  })

  it('跑在完整结果图上：一次加两条边形成的环也能抓到', () => {
    // 单看任一条新边都不指回祖先，只有两条一起看才成环。
    const both = {
      steps: [
        { id: 'a', needs: ['c'] },
        { id: 'b', needs: ['a'] },
        { id: 'c', needs: ['b'] },
      ],
    }
    expect(findCycle(both)).not.toBeNull()
  })

  it('指向不存在的步骤不算环（那是悬空引用，另有检查）', () => {
    expect(findCycle({ steps: [{ id: 'a', needs: ['ghost'] }] })).toBeNull()
  })

  it('长链无环不误报', () => {
    const chain = {
      steps: Array.from({ length: 30 }, (_unused, index) => ({
        id: `s${index}`,
        ...(index === 0 ? {} : { needs: [`s${index - 1}`] }),
      })),
    }
    expect(findCycle(chain)).toBeNull()
  })
})
