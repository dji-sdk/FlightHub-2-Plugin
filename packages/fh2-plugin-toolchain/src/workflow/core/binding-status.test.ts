// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import {
  BINDING_STATES,
  blocksHandoff,
  describeBindingState,
  overallBindingState,
  summarizeBindings,
} from './binding-status.js'
import type { SemanticIssue, SemanticRule } from './semantics.js'

/**
 * 绑定完整度归纳的用例。要紧的几条：
 *   干净节点必须出现在结果里（缺席在 UI 上表现为「没有状态」，用户分不清）
 *   同一节点多个问题时取**最严重**的那个（取第一个会让红点被黄标盖住）
 *   没归类的新规则落到偏重的一档，不静默变成 locally-complete
 *   文案里不许出现「通过 / 可部署 / 已验证」—— 本轮没有权威 checker
 */

function issue (nodeId: string, rule: SemanticRule, inputKey?: string): SemanticIssue {
  return {
    rule,
    level: rule === 'R3_UNCERTAIN_REF' ? 'warning' : 'error',
    nodeId,
    ...(inputKey === undefined ? {} : { inputKey }),
    message: `${rule} on ${nodeId}`,
  }
}

describe('summarizeBindings', () => {
  it('没有任何问题的节点是 locally-complete，且**出现在结果里**', () => {
    const statuses = summarizeBindings(['a', 'b'], [])
    expect(statuses.map(status => [status.nodeId, status.state])).toEqual([
      ['a', 'locally-complete'],
      ['b', 'locally-complete'],
    ])
  })

  it('按规则分到对应的档', () => {
    const statuses = summarizeBindings(['a', 'b', 'c', 'd'], [
      issue('a', 'SCRIPT_MISSING'),
      issue('b', 'R3_UNRESOLVABLE_REF', 'x'),
      issue('c', 'R1_REQUIRED_INPUT_UNWIRED', 'y'),
      issue('d', 'R3_UNCERTAIN_REF', 'z'),
    ])
    expect(Object.fromEntries(statuses.map(status => [status.nodeId, status.state]))).toEqual({
      a: 'unresolved-contract',
      b: 'invalid-binding',
      c: 'incomplete-binding',
      d: 'complete-with-uncertainty',
    })
  })

  it('同一节点多个问题时取最严重的那个', () => {
    const [status] = summarizeBindings(['a'], [
      issue('a', 'R3_UNCERTAIN_REF', 'soft'),
      issue('a', 'R1_REQUIRED_INPUT_UNWIRED', 'missing'),
      issue('a', 'SCRIPT_MISSING'),
    ])
    expect(status!.state).toBe('unresolved-contract')
    // issues 按严重度排好，最严重在前 —— 检查器按这个顺序显示。
    expect(status!.issues[0]!.rule).toBe('SCRIPT_MISSING')
  })

  it('收集出问题的入参名（去重）', () => {
    const [status] = summarizeBindings(['a'], [
      issue('a', 'R1_REQUIRED_INPUT_UNWIRED', 'waylineUuid'),
      issue('a', 'R1_REQUIRED_INPUT_UNWIRED', 'dockSn'),
      issue('a', 'INPUT_TYPE_MISMATCH', 'dockSn'),
    ])
    expect([...status!.inputKeys].sort()).toEqual(['dockSn', 'waylineUuid'])
  })

  it('流程级问题（nodeId 为空）不归任何节点', () => {
    const statuses = summarizeBindings(['a'], [issue('', 'R6_AWAIT_ORDER')])
    expect(statuses).toHaveLength(1)
    expect(statuses[0]!.state).toBe('locally-complete')
  })

  it('指到未列出节点的问题（如触发器合成节点）也保留，不丢', () => {
    const statuses = summarizeBindings(['a'], [issue('$trigger', 'R3_UNRESOLVABLE_REF')])
    expect(statuses.map(status => status.nodeId).sort()).toEqual(['$trigger', 'a'])
  })

  it('未归类的规则落到偏重的一档，**不会**静默变成 locally-complete', () => {
    const [status] = summarizeBindings(['a'], [issue('a', 'FUTURE_RULE' as SemanticRule)])
    expect(status!.state).toBe('invalid-binding')
  })
})

describe('overallBindingState', () => {
  it('取最严重的节点状态', () => {
    expect(overallBindingState(summarizeBindings(['a', 'b'], [
      issue('a', 'R3_UNCERTAIN_REF'),
      issue('b', 'R1_REQUIRED_INPUT_UNWIRED'),
    ]))).toBe('incomplete-binding')
  })

  it('空流程算 locally-complete', () => {
    expect(overallBindingState([])).toBe('locally-complete')
  })

  it('全干净时算 locally-complete', () => {
    expect(overallBindingState(summarizeBindings(['a'], []))).toBe('locally-complete')
  })
})

describe('blocksHandoff', () => {
  it('三个硬问题挡住后续交接，两个软状态不挡', () => {
    expect(blocksHandoff('unresolved-contract')).toBe(true)
    expect(blocksHandoff('invalid-binding')).toBe(true)
    expect(blocksHandoff('incomplete-binding')).toBe(true)
    expect(blocksHandoff('complete-with-uncertainty')).toBe(false)
    expect(blocksHandoff('locally-complete')).toBe(false)
  })
})

describe('describeBindingState', () => {
  it('每档都有一句人话', () => {
    for (const state of BINDING_STATES) {
      expect(describeBindingState(state).length).toBeGreaterThan(4)
    }
  })

  it('**不出现**「通过 / 可部署 / 已验证」—— 本轮没有权威 checker', () => {
    for (const state of BINDING_STATES) {
      const text = describeBindingState(state)
      for (const forbidden of ['可部署', '已验证', '验证通过', '校验通过', '运行通过']) {
        expect(text, `${state} 的文案出现了 ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  it('本轮不存在 worker-check-valid 这一档', () => {
    expect(BINDING_STATES).not.toContain('worker-check-valid' as never)
  })
})
