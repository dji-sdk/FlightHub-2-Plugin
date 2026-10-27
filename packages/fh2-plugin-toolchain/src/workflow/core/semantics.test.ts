// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import type { ActionsCatalogData } from './catalog.js'
import { EMPTY_CATALOG, toCatalog } from './catalog.js'
import { parseRef, validateSemantics } from './semantics.js'

/**
 * S8：Core 侧语义校验测试。与 IDE 的 semantics.test.ts 共用同一实现与判据
 * （IDE 侧是薄壳再导出，其 719 行用例即「同输入同诊断」的回归面）；
 * 这里只锁 Core 模块自身的关键行为。
 */

const ACTIONS: ActionsCatalogData = {
  fixedSteps: [
    {
      action: 'wait_signal',
      kind: 'await_signal',
      owner: 'platform',
      inputs: [],
      outputs: [],
    },
    {
      action: 'dispatch_mission',
      capability: 'device.mission:execute',
      isFlight: true,
      kind: 'activity',
      owner: 'platform',
      nonIdempotent: true,
      inputs: [
        { name: 'waylineUuid', type: 'id', required: true },
        { name: 'dockSn', type: 'id', required: true },
      ],
      outputs: [{ name: 'missionId', type: 'id' }],
    },
  ],
  scripts: [
    {
      id: 'postprocess',
      entry: 'handle',
      allowlist: [],
      inputs: [{ name: 'eventKey', type: 'string', required: true }],
      outputs: [{ name: 'verified', type: 'bool' }],
    },
  ],
  triggerSeeds: {
    api: { available: [], notGuaranteed: [] },
  },
  runRoot: ['now', 'idempotencyKey'],
  scriptAction: 'run_script',
  pluginActionPrefix: 'plugin.',
  stepStates: ['succeeded', 'failed', 'skipped', 'timedOut', 'interrupted'],
  conditionOps: ['eq', 'ne', 'in', 'exists'],
  stepTriggers: ['allSucceeded', 'allDone'],
  grantableCaps: [],
  pluginManifestFound: true,
  catalogSource: { kind: 'knowledge' as const, revision: 'test' },
}

const CATALOG = toCatalog(ACTIONS)

function rules (raw: unknown): string[] {
  return validateSemantics(CATALOG, { raw: raw as Record<string, unknown> }).map(issue => issue.rule)
}

describe('workflow semantics（S8 Core）', () => {
  it('词表不可用时整体放行（宁可漏判，不可误报）', () => {
    const issues = validateSemantics(EMPTY_CATALOG, { raw: { steps: [] } })
    expect(issues).toEqual([])
  })

  it('r1：必填入参未接线报错；R2：声明外的入参报错', () => {
    const raw = {
      trigger: { api: { seed: ['eventId'] } },
      steps: [
        { id: 'pick', action: 'dispatch_mission', inputs: { dockSn: { const: 'dock-1' }, typo: { const: 'x' } } },
      ],
    }
    const found = rules(raw)
    expect(found).toContain('R1_REQUIRED_INPUT_UNWIRED')
    expect(found).toContain('R2_UNDECLARED_INPUT')
  })

  it('uNKNOWN_ACTION：平台未知动作为 error，插件自定义能力仅 warning（不以快照枚举判错插件动作）', () => {
    const base = { trigger: { api: { seed: ['k'] } }, steps: [] }
    const platformUnknown = JSON.parse(JSON.stringify(base)) as { steps: { id: string; action: string }[] }
    platformUnknown.steps.push({ id: 'a', action: 'no_such_action' })
    const pluginCustom = JSON.parse(JSON.stringify(base)) as { steps: { id: string; action: string }[] }
    pluginCustom.steps.push({ id: 'b', action: 'plugin.custom_thing' })

    expect(validateSemantics(CATALOG, { raw: platformUnknown as Record<string, unknown> })
      .find(issue => issue.nodeId === 'a')?.level).toBe('error')
    expect(validateSemantics(CATALOG, { raw: pluginCustom as Record<string, unknown> })
      .find(issue => issue.nodeId === 'b')?.level).toBe('warning')
  })

  it('r3：接线引用不在 needs 闭包内报错；$state 终态引用放行', () => {
    const raw = {
      trigger: { api: { seed: ['k'] } },
      steps: [
        { id: 'a', action: 'dispatch_mission', inputs: { waylineUuid: { const: 'w' }, dockSn: { const: 'd' } } },
        { id: 'b', action: 'dispatch_mission', inputs: { waylineUuid: { from: 'steps.a.missionId' }, dockSn: { const: 'd' } } },
      ],
    }
    expect(rules(raw)).toContain('R3_UNRESOLVABLE_REF')

    const withNeeds = JSON.parse(JSON.stringify(raw)) as { steps: { id: string; needs?: string[] }[] }
    withNeeds.steps[1]!.needs = ['a']
    expect(rules(withNeeds)).not.toContain('R3_UNRESOLVABLE_REF')
  })

  it('parseRef：三根语法', () => {
    expect(parseRef('trigger.eventId')).toEqual({ root: 'trigger', stepId: '', rest: ['eventId'] })
    expect(parseRef('steps.pick.missionId')).toEqual({ root: 'steps', stepId: 'pick', rest: ['missionId'] })
    expect(parseRef('run.now')).toEqual({ root: 'run', stepId: '', rest: ['now'] })
    expect(parseRef('nope')).toBeNull()
  })
})

describe('挂起段语义缺口（DAG-019 bare-wait / timeout-from）', () => {
  it('wait_signal 步没有 await 段报 AWAIT_SIGNAL_MISSING', () => {
    const found = rules({ steps: [{ id: 'wait', action: 'wait_signal' }] })
    expect(found).toContain('AWAIT_SIGNAL_MISSING')
  })

  it('await.timeoutSecFrom 接到不在闭包里的步骤报 AWAIT_TIMEOUT_UNRESOLVABLE', () => {
    const found = rules({
      steps: [
        { id: 'pick', action: 'run_script', inputs: { script: { const: 'postprocess' } } },
        { id: 'use', action: 'run_script', needs: ['pick'], await: { signal: 'ack', timeoutSecFrom: 'steps.missing.seconds' }, inputs: { script: { const: 'postprocess' } } },
      ],
    })
    expect(found).toContain('AWAIT_TIMEOUT_UNRESOLVABLE')
  })

  it('带 await 段的 wait_signal 与可解析的 timeoutSecFrom 不误报', () => {
    const found = rules({
      steps: [
        { id: 'pick', action: 'run_script', inputs: { script: { const: 'postprocess' } } },
        { id: 'wait', action: 'wait_signal', needs: ['pick'], await: { signal: 'ack', timeoutSecFrom: 'steps.pick.verified' } },
      ],
    })
    expect(found).not.toContain('AWAIT_SIGNAL_MISSING')
    expect(found).not.toContain('AWAIT_TIMEOUT_UNRESOLVABLE')
  })
})
