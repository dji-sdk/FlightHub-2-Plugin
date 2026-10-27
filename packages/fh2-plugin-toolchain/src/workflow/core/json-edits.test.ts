// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { applyJsonEditOp, applyJsonEditOps, detectEol, detectIndentUnit, hasJsonDuplicateKeys, parseJsonValue } from './json-edits.js'

/**
 * 计划 §D1 的准入门禁：删自研 json-layout.ts 之前，最小文本编辑必须先过
 * 「无编辑 round-trip」与「未知字段保留」。本文件是那道门禁，外加两条同等重要的：
 *
 *   ③ 未触及区域**逐字节**不变（这是最小编辑的全部意义）
 *   ④ 内联写法在结构性修改后仍然保留（jsonc-parser 传 formattingOptions 时会破坏它，
 *      见 json-edits.ts 头部那段 ⚠️⚠️ —— 本模块绕开了那个坑，这条用例钉住绕法有效）
 *
 * ⚠️ 第 ④ 条最容易在将来被「顺手加上 formattingOptions 让缩进更整齐」改掉。
 * 它红的时候，真正的症状是画布点一下就产生几十行无意义 diff。
 */

/** 一份混合了内联与多行写法的真实形状 workflow。 */
const SOURCE = `{
  "name": "dispatch_decision",
  "description": "事件到派飞",
  "trigger": { "stream": { "match": { "event_type": "illegal_parking" }, "seed": ["eventId", "lat", "lng"] } },
  "steps": [
    { "id": "evaluate", "action": "run_script",
      "inputs": { "script": { "const": "evaluate_dispatch" }, "eventId": { "from": "trigger.eventId" } } },
    {
      "id": "fly",
      "action": "dispatch_mission",
      "needs": ["evaluate"],
      "inputs": {
        "waylineUuid": { "from": "steps.evaluate.waylineUuid" }
      }
    }
  ]
}
`

describe('workflow/core/json-edits', () => {
  it('零编辑 round-trip：逐字节相同', () => {
    expect(applyJsonEditOps(SOURCE, [])).toBe(SOURCE)
  })

  it('改一个深层标量：只有那几个字节变', () => {
    const next = applyJsonEditOp(SOURCE, { path: ['steps', 1, 'action'], value: 'return_home' })
    expect(next).toBe(SOURCE.replace('"action": "dispatch_mission"', '"action": "return_home"'))
  })

  it('未触及区域逐字节不变（含内联 trigger 与内联 step）', () => {
    const next = applyJsonEditOp(SOURCE, { path: ['steps', 1, 'action'], value: 'return_home' })
    // 内联的 trigger 一整行原样保留。
    expect(next).toContain('"trigger": { "stream": { "match": { "event_type": "illegal_parking" }, "seed": ["eventId", "lat", "lng"] } }')
    // 第一个 step 那种「跨两行但紧凑」的手写排版也原样保留。
    expect(next).toContain('{ "id": "evaluate", "action": "run_script",')
    // 改动点之前的前缀逐字节相同。
    const prefix = SOURCE.slice(0, SOURCE.indexOf('"action": "dispatch_mission"'))
    expect(next.startsWith(prefix)).toBe(true)
  })

  it('未知字段（含未来字段与注释）原样保留', () => {
    const withUnknown = `{
  // 这条注释必须活下来
  "name": "f",
  "未来平台字段": { "a": 1, "b": [2, 3] },
  "steps": [{ "id": "s", "action": "x" }]
}
`
    const next = applyJsonEditOp(withUnknown, { path: ['steps', 0, 'action'], value: 'y' })
    expect(next).toContain('// 这条注释必须活下来')
    expect(next).toContain('"未来平台字段": { "a": 1, "b": [2, 3] }')
    expect(next).toContain('"action": "y"')
  })

  describe('内联容器在结构性修改后仍是内联', () => {
    it('往内联对象加属性', () => {
      const next = applyJsonEditOp(SOURCE, { path: ['steps', 0, 'connectorId'], value: 'c-1' })
      // 仍在同一行，且逗号后有空格（不是 `},"connectorId"`）。
      expect(next).toContain('"eventId": { "from": "trigger.eventId" } }, "connectorId": "c-1" }')
      expect(next).not.toMatch(/\n\s+"connectorId"/)
    })

    it('从内联对象删属性', () => {
      const next = applyJsonEditOp(SOURCE, { path: ['trigger', 'stream', 'seed'], value: undefined })
      expect(next).toContain('"trigger": { "stream": { "match": { "event_type": "illegal_parking" } } }')
    })

    it('往内联数组追加元素', () => {
      const next = applyJsonEditOp(SOURCE, {
        path: ['trigger', 'stream', 'seed', 3],
        value: 'status',
        insert: true,
      })
      expect(next).toContain('"seed": ["eventId", "lat", "lng", "status"]')
    })

    it('从内联数组删元素', () => {
      const next = applyJsonEditOp(SOURCE, { path: ['trigger', 'stream', 'seed', 1], value: undefined })
      expect(next).toContain('"seed": ["eventId", "lng"]')
    })
  })

  describe('多行容器按缩进插入', () => {
    it('往多行数组尾插一个 step', () => {
      const next = applyJsonEditOp(SOURCE, {
        path: ['steps', 2],
        value: { id: 'notice', action: 'run_script' },
        insert: true,
      })
      // 新元素自己换行并缩进，不是挤在上一个元素后面。
      expect(next).not.toMatch(/\},\{"id":"notice"/)
      expect(next).toMatch(/\n\s+\{\s*\n?\s*"id": "notice"/)
      // 既有的两个 step 都还在。
      expect(next).toContain('"id": "evaluate"')
      expect(next).toContain('"id": "fly"')
      expect(parseJsonValue(next)).toMatchObject({
        steps: [{ id: 'evaluate' }, { id: 'fly' }, { id: 'notice', action: 'run_script' }],
      })
    })

    it('往多行对象加属性', () => {
      const next = applyJsonEditOp(SOURCE, { path: ['steps', 1, 'timeoutSec'], value: 60 })
      expect(next).toMatch(/\n\s+"timeoutSec": 60/)
      expect(parseJsonValue(next)).toMatchObject({ steps: [{}, { timeoutSec: 60 }] })
    })

    it('从多行数组删元素', () => {
      const next = applyJsonEditOp(SOURCE, { path: ['steps', 0], value: undefined })
      const value = parseJsonValue(next) as { steps: { id: string }[] }
      expect(value.steps.map(step => step.id)).toEqual(['fly'])
      // 留下的那个多行 step 排版不变。
      expect(next).toContain('      "needs": ["evaluate"],')
    })
  })

  it('批量编辑逐条重算 offset，不互相错位', () => {
    const next = applyJsonEditOps(SOURCE, [
      { path: ['steps', 1, 'action'], value: 'return_home' },
      { path: ['steps', 1, 'timeoutSec'], value: 30 },
      { path: ['steps', 0, 'action'], value: 'run_script' },
    ])
    expect(parseJsonValue(next)).toMatchObject({
      steps: [{ action: 'run_script' }, { action: 'return_home', timeoutSec: 30 }],
    })
  })

  it('insert 缺省时数组下标是**替换**，不是插入', () => {
    const replaced = applyJsonEditOp(SOURCE, { path: ['trigger', 'stream', 'seed', 0], value: 'x' })
    expect(parseJsonValue(replaced)).toMatchObject({ trigger: { stream: { seed: ['x', 'lat', 'lng'] } } })

    const inserted = applyJsonEditOp(SOURCE, { path: ['trigger', 'stream', 'seed', 0], value: 'x', insert: true })
    expect(parseJsonValue(inserted)).toMatchObject({ trigger: { stream: { seed: ['x', 'eventId', 'lat', 'lng'] } } })
  })

  describe('缩进与行尾探测', () => {
    it('认出 2 空格、4 空格与 tab', () => {
      expect(detectIndentUnit('{\n  "a": 1\n}')).toBe('  ')
      expect(detectIndentUnit('{\n    "a": 1\n}')).toBe('    ')
      expect(detectIndentUnit('{\n\t"a": 1\n}')).toBe('\t')
    })

    it('认出 CRLF', () => {
      expect(detectEol('{\r\n  "a": 1\r\n}')).toBe('\r\n')
      expect(detectEol('{\n  "a": 1\n}')).toBe('\n')
    })
  })

  describe('parseJsonValue 与编辑侧同一个解析器', () => {
    it('容忍注释与尾随逗号', () => {
      expect(parseJsonValue('{ /* c */ "a": 1, }')).toEqual({ a: 1 })
    })

    it('嵌套结构完整取出', () => {
      expect(parseJsonValue(SOURCE)).toMatchObject({
        name: 'dispatch_decision',
        trigger: { stream: { seed: ['eventId', 'lat', 'lng'] } },
        steps: [{ id: 'evaluate' }, { id: 'fly', needs: ['evaluate'] }],
      })
    })
  })

  it('末尾换行与 CRLF 文件不被改写', () => {
    const crlf = '{\r\n  "steps": [\r\n    { "id": "a", "action": "x" }\r\n  ]\r\n}\r\n'
    const next = applyJsonEditOp(crlf, { path: ['steps', 0, 'action'], value: 'y' })
    expect(next.endsWith('\r\n')).toBe(true)
    // 只该有一处变化：原文其余部分（含所有 \r\n）保持不变。
    expect(next).toBe(crlf.replace('"action": "x"', '"action": "y"'))
  })
})

describe('重复键识别（结构化编辑的拒绝前置）', () => {
  it('同层重复键识别，跨层同名不算', () => {
    expect(hasJsonDuplicateKeys('{"name":"a","name":"b"}')).toBe(true)
    expect(hasJsonDuplicateKeys('{"a":{"x":1,"x":2},"b":{}}')).toBe(true)
    expect(hasJsonDuplicateKeys('{"name":"a","other":"b"}')).toBe(false)
    expect(hasJsonDuplicateKeys('{"a":{"x":1},"b":{"x":2}}')).toBe(false)
  })
})
