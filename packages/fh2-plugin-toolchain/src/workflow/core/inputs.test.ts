// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { parseWorkflowDocument, serializeWorkflow } from './model.js'
import {
  clearStepInput,
  ensureStepWhen,
  removeStepWhen,
  setStepAwait,
  setStepInput,
  setStepNumber,
  setStepSectionField,
  setStepTrigger,
  setStepWhenField,
  setTriggerAxis,
  setTriggerField,
  toggleTriggerAxis,
} from './inputs.js'
import type { WorkflowDocument } from './model.js'

/**
 * 与 model.test.ts 同一条纪律：**画布是生成器，产出必须与手写 JSON 同构**。
 * 所以这组用例除了断言「改对了」，还要断言「没动别的」——
 * 键序、未知字段、排版都不许被编辑操作顺手改掉。
 */

const SOURCE = `{
  "name": "example",
  "description": "带未知字段的流程",
  "trigger": {
    "api": {
      "seed": ["title"]
    }
  },
  "steps": [
    {
      "id": "go",
      "action": "dispatch_mission",
      "futureField": "平台还不认识这个字段",
      "inputs": {
        "waylineUuid": { "from": "trigger.title" }
      }
    }
  ]
}
`

function load (text = SOURCE): WorkflowDocument {
  const parsed = parseWorkflowDocument(text)
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.document
}

describe('setStepInput', () => {
  it('写一条 from 接线', () => {
    const document = load()
    expect(setStepInput(document, 'go', 'dockSn', 'from', 'trigger.title')).toBe(true)
    expect(serializeWorkflow(document)).toContain('"dockSn": {')
    expect(serializeWorkflow(document)).toContain('"from": "trigger.title"')
  })

  it('写一条 const 字面量', () => {
    const document = load()
    setStepInput(document, 'go', 'lat', 'const', 22.5)
    expect(serializeWorkflow(document)).toContain('"const": 22.5')
  })

  it('from 与 const 互斥：切模式时整条替换，不留残余', () => {
    const document = load()
    setStepInput(document, 'go', 'waylineUuid', 'const', 'w-1')
    const text = serializeWorkflow(document)
    expect(text).toContain('"const": "w-1"')
    // 同时留着 from 会让 worker 的 UnmarshalJSON 当场报错
    expect(text).not.toContain('"from": "trigger.title"')
  })

  it('值没变时回 false（不制造假的 dirty）', () => {
    const document = load()
    expect(setStepInput(document, 'go', 'waylineUuid', 'from', 'trigger.title')).toBe(false)
  })

  it('不认识的 step 回 false', () => {
    expect(setStepInput(load(), 'ghost', 'k', 'const', 1)).toBe(false)
  })

  it('不动未知字段与键序', () => {
    const document = load()
    setStepInput(document, 'go', 'dockSn', 'const', 'd')
    const text = serializeWorkflow(document)
    expect(text).toContain('"futureField": "平台还不认识这个字段"')
    // id 仍在 action 之前
    expect(text.indexOf('"id"')).toBeLessThan(text.indexOf('"action"'))
  })
})

describe('clearStepInput', () => {
  it('删一条接线', () => {
    const document = load()
    expect(clearStepInput(document, 'go', 'waylineUuid')).toBe(true)
    expect(serializeWorkflow(document)).not.toContain('waylineUuid')
  })

  it('删空后把 inputs 字段一起摘掉（空对象是噪音）', () => {
    const document = load()
    clearStepInput(document, 'go', 'waylineUuid')
    expect(serializeWorkflow(document)).not.toContain('"inputs"')
  })

  it('本来就没有时回 false', () => {
    expect(clearStepInput(load(), 'go', 'nope')).toBe(false)
  })
})

describe('setStepTrigger', () => {
  it('设成 allDone', () => {
    const document = load()
    expect(setStepTrigger(document, 'go', 'allDone')).toBe(true)
    expect(serializeWorkflow(document)).toContain('"trigger": "allDone"')
  })

  it('设回 allSucceeded = 删字段（默认值不写进 JSON）', () => {
    const document = load()
    setStepTrigger(document, 'go', 'allDone')
    expect(setStepTrigger(document, 'go', 'allSucceeded')).toBe(true)
    expect(serializeWorkflow(document)).not.toContain('"trigger": "allDone"')
  })
})

describe('setStepNumber', () => {
  it('写 timeoutSec', () => {
    const document = load()
    setStepNumber(document, 'go', 'timeoutSec', 300)
    expect(serializeWorkflow(document)).toContain('"timeoutSec": 300')
  })

  it('0 或 null = 删字段（回到平台默认值）', () => {
    const document = load()
    setStepNumber(document, 'go', 'timeoutSec', 300)
    expect(setStepNumber(document, 'go', 'timeoutSec', null)).toBe(true)
    expect(serializeWorkflow(document)).not.toContain('timeoutSec')
  })

  it('小数取整（秒数没有小数语义）', () => {
    const document = load()
    setStepNumber(document, 'go', 'timeoutSec', 30.7)
    expect(serializeWorkflow(document)).toContain('"timeoutSec": 30')
  })
})

describe('setStepAwait', () => {
  it('开启 await 并带上有界超时', () => {
    const document = load()
    expect(setStepAwait(document, 'go', 'await', { signal: 'acknowledge', timeoutSec: 600 })).toBe(true)
    const text = serializeWorkflow(document)
    expect(text).toContain('"signal": "acknowledge"')
    expect(text).toContain('"timeoutSec": 600')
  })

  it('关闭 await', () => {
    const document = load()
    setStepAwait(document, 'go', 'await', { signal: 's', timeoutSec: 10 })
    expect(setStepAwait(document, 'go', 'await', null)).toBe(true)
    expect(serializeWorkflow(document)).not.toContain('"await"')
  })

  it('空信号名不写（schema 要求 minLength 1）', () => {
    expect(setStepAwait(load(), 'go', 'await', { signal: '  ' })).toBe(false)
  })
})

describe('toggleTriggerAxis', () => {
  it('加一轴', () => {
    const document = load()
    expect(toggleTriggerAxis(document, 'job', true)).toBe(true)
    expect(serializeWorkflow(document)).toContain('"job"')
  })

  it('schedule 不写默认 intervalSec（P0-4：必填值由用户显式给，缺了让语义校验标红）', () => {
    const document = load()
    expect(toggleTriggerAxis(document, 'schedule', true)).toBe(true)
    expect(serializeWorkflow(document)).toContain('"schedule": {}')
    expect(serializeWorkflow(document)).not.toContain('intervalSec')
  })

  it('setTriggerAxis 一次性提交完整结构；删除与等值替换', () => {
    const document = load()
    expect(setTriggerAxis(document, 'stream', { match: { event_type: 'x' } })).toBe(true)
    expect(serializeWorkflow(document)).toContain('"event_type": "x"')
    // 等值替换回 false（无变更）。
    expect(setTriggerAxis(document, 'stream', { match: { event_type: 'x' } })).toBe(false)
    expect(setTriggerAxis(document, 'stream', null)).toBe(true)
    expect(serializeWorkflow(document)).not.toContain('"stream"')
    // 删不存在的轴回 false。
    expect(setTriggerAxis(document, 'stream', null)).toBe(false)
  })

  it('删一轴', () => {
    const document = load()
    expect(toggleTriggerAxis(document, 'api', false)).toBe(true)
    expect(serializeWorkflow(document)).not.toContain('"api"')
  })

  it('重复开启回 false', () => {
    expect(toggleTriggerAxis(load(), 'api', true)).toBe(false)
  })
})

describe('setTriggerField', () => {
  it('改 seed 数组', () => {
    const document = load()
    expect(setTriggerField(document, 'api', 'seed', ['a', 'b'])).toBe(true)
    expect(serializeWorkflow(document)).toContain('"a"')
  })

  it('空数组 = 删字段', () => {
    const document = load()
    expect(setTriggerField(document, 'api', 'seed', [])).toBe(true)
    expect(serializeWorkflow(document)).not.toContain('"seed"')
  })

  it('轴不存在时先建出来', () => {
    const document = load()
    setTriggerField(document, 'bizNotify', 'subscriber', 'traffic')
    expect(serializeWorkflow(document)).toContain('"subscriber": "traffic"')
  })

  it('值没变时回 false', () => {
    expect(setTriggerField(load(), 'api', 'seed', ['title'])).toBe(false)
  })
})

describe('整体无损性', () => {
  it('一串编辑之后，未参与编辑的部分逐字不变', () => {
    const document = load()
    setStepInput(document, 'go', 'dockSn', 'const', 'd-1')
    setStepTrigger(document, 'go', 'allDone')
    setTriggerField(document, 'api', 'seed', ['title', 'extra'])
    const text = serializeWorkflow(document)
    expect(text).toContain('"name": "example"')
    expect(text).toContain('"description": "带未知字段的流程"')
    expect(text).toContain('"futureField": "平台还不认识这个字段"')
  })
})

describe('setStepSectionField / setStepWhenField / ensureStepWhen（P1-2/P1-5）', () => {
  const AWAIT_SOURCE = `{
  "name": "example",
  "trigger": { "api": { "seed": ["title"] } },
  "steps": [
    {
      "id": "ack",
      "action": "wait_signal",
      "await": {
        "signal": "operator_ack",
        "timeoutSec": 300,
        "provides": [{ "key": "decision", "type": "string" }],
        "interruptedBy": ["user_cancel"]
      }
    }
  ]
}`

  it('改挂起段单字段：其余字段（含 provides 对象形态）原样保留', () => {
    const document = load(AWAIT_SOURCE)
    expect(setStepSectionField(document, 'ack', 'await', 'signal', 'supervisor_ack')).toBe(true)
    const serialized = serializeWorkflow(document)
    expect(serialized).toContain('"signal": "supervisor_ack"')
    // provides 的 {key,type} 形态不被拍平。
    expect(serialized).toContain('"key": "decision"')
    expect(serialized).toContain('"interruptedBy"')
    expect(serialized).toContain('"timeoutSec": 300')
  })

  it('空值删字段；等值返回 false；不存在的步返回 false', () => {
    const document = load(AWAIT_SOURCE)
    expect(setStepSectionField(document, 'ack', 'await', 'interruptedBy', null)).toBe(true)
    expect(serializeWorkflow(document)).not.toContain('interruptedBy')
    expect(setStepSectionField(document, 'ack', 'await', 'signal', 'operator_ack')).toBe(false)
    expect(setStepSectionField(document, 'nobody', 'await', 'signal', 'x')).toBe(false)
  })

  it('when 叶子字段编辑；组合条件拒绝；ensureStepWhen 建骨架且不覆盖', () => {
    const source = `{
  "name": "example",
  "trigger": { "api": { "seed": ["title"] } },
  "steps": [
    { "id": "go", "action": "wait_signal", "when": { "field": "trigger.title", "op": "eq", "value": "x" } },
    { "id": "combo", "action": "wait_signal", "when": { "and": [{ "field": "trigger.title", "op": "exists" }] } }
  ]
}`
    const document = load(source)
    expect(setStepWhenField(document, 'go', 'field', 'steps.go.$state')).toBe(true)
    expect(setStepWhenField(document, 'go', 'value', 'succeeded')).toBe(true)
    expect(setStepWhenField(document, 'go', 'value', null)).toBe(true)
    expect(serializeWorkflow(document)).not.toContain('"value": "succeeded"')
    // 组合条件拒绝字段级编辑（结构化拆开会破坏嵌套语义）。
    expect(setStepWhenField(document, 'combo', 'field', 'x')).toBe(false)

    const fresh = load(source)
    expect(ensureStepWhen(fresh, 'combo', 'eq')).toBe(false)
    expect(ensureStepWhen(fresh, 'go', 'eq')).toBe(false)
    const bare = load(`{ "name": "x", "trigger": { "api": {} }, "steps": [{ "id": "s", "action": "wait_signal" }] }`)
    expect(ensureStepWhen(bare, 's', 'eq')).toBe(true)
    expect(serializeWorkflow(bare)).toContain('"op": "eq"')
  })

  it('removeStepWhen 删整段 when（叶子/组合都可删）；没有 when 或步不存在返回 false', () => {
    const source = `{
  "name": "example",
  "trigger": { "api": { "seed": ["title"] } },
  "steps": [
    { "id": "go", "action": "wait_signal", "when": { "field": "trigger.title", "op": "eq", "value": "x" } },
    { "id": "combo", "action": "wait_signal", "when": { "and": [{ "field": "trigger.title", "op": "exists" }] } },
    { "id": "bare", "action": "wait_signal" }
  ]
}`
    const document = load(source)
    expect(removeStepWhen(document, 'go')).toBe(true)
    expect(removeStepWhen(document, 'combo')).toBe(true)
    const serialized = serializeWorkflow(document)
    expect(serialized).not.toContain('"when"')
    // 没改别的：steps 数量、其余字段原样。
    expect(serialized).toContain('"id": "bare"')
    expect(removeStepWhen(document, 'bare')).toBe(false)
    expect(removeStepWhen(document, 'nobody')).toBe(false)
    // 幂等：删过的再删返回 false。
    expect(removeStepWhen(document, 'go')).toBe(false)
  })
})
