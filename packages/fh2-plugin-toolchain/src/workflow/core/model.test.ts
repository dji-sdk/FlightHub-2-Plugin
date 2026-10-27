// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { detectIndent, parseJsonWithLayout, stringifyWithLayout } from './json-layout.js'
import {
  TRIGGER_NODE_ID,
  addStep,
  connect,
  disconnect,
  hasStep,
  parseWorkflowDocument,
  removeStep,
  renameStep,
  serializeWorkflow,
  setStepText,
  setTriggerDescription,
  toGraph,
  triggerKindOf,
  wouldCreateCycle,
} from './model.js'
import type { WorkflowDocument } from './model.js'

/**
 * 这组用例的核心断言是「画布是生成器不是运行时」：
 * 产出必须与手写 workflows/*.json 逐字节同构，否则每次在画布上点一下都会污染 diff。
 */

const HAND_WRITTEN = `{
  "name": "example-flow",
  "description": "可由 API 触发的最小 Workflow。",
  "trigger": {
    "api": {
      "seed": ["title"]
    }
  },
  "steps": [
    {
      "id": "fetch",
      "action": "run_script",
      "inputs": {
        "script": { "const": "fetch-script" },
        "title": { "from": "trigger.title" }
      }
    },
    {
      "id": "report",
      "needs": ["fetch"],
      "action": "run_script",
      "inputs": {
        "script": { "const": "report-script" }
      }
    }
  ]
}
`

function parse (text: string): WorkflowDocument {
  const result = parseWorkflowDocument(text)
  if (!result.ok) throw new Error(result.message)
  return result.document
}

describe('工作流 JSON 解析与排版保留', () => {
  it('两空格缩进 + 结尾换行的手写文件被识别为可无损复现', () => {
    const document = parse(`{\n  "name": "f",\n  "trigger": {\n    "api": {}\n  }\n}\n`)
    expect(document.layout.indent).toBe('  ')
    expect(document.layout.trailingNewline).toBe(true)
    expect(document.lossless).toBe(true)
  })

  it('紧凑内联写法（"trigger": { "api": {} }）原样保留，不被摊开', () => {
    // 仓库里的 valid-fixtures 就是这种写法，摊开会造出几十行伪 diff
    const text = `{\n  "name": "f",\n  "trigger": { "api": {} },\n  "steps": [\n    {\n      "id": "a",\n      "action": "x",\n      "inputs": {\n        "script": { "const": "s" }\n      }\n    }\n  ]\n}\n`
    const document = parse(text)
    expect(document.lossless).toBe(true)
    expect(serializeWorkflow(document)).toBe(text)
  })

  it('内联数组 ["title"] 不被摊开', () => {
    const text = `{\n  "trigger": {\n    "api": {\n      "seed": ["title", "id"]\n    }\n  }\n}\n`
    expect(serializeWorkflow(parse(text))).toBe(text)
  })

  it('四空格与制表符缩进都能还原', () => {
    expect(detectIndent(`{\n    "a": 1\n}\n`)).toBe('    ')
    expect(detectIndent(`{\n\t"a": 1\n}`)).toBe('\t')
    expect(parse(`{\n\t"a": 1\n}`).layout.trailingNewline).toBe(false)
  })

  it('不含换行的紧凑单行文件也能原样复现', () => {
    const text = `{"name":"f","trigger":{"api":{}}}`
    // 顶层容器本身是内联的，落盘仍是单行 —— 但键之间的空格会被规范化
    expect(parse(text).lossless).toBe(false)
    expect(serializeWorkflow(parse(text))).toBe(`{ "name": "f", "trigger": { "api": {} } }`)
  })

  it('非法 JSON 与非对象顶层都返回失败而不是抛异常', () => {
    expect(parseWorkflowDocument('{').ok).toBe(false)
    expect(parseWorkflowDocument('[]').ok).toBe(false)
    expect(parseWorkflowDocument('"x"').ok).toBe(false)
  })

  it('排版解析器与原生 JSON.parse 的结果始终一致（转义 / unicode / 科学计数法）', () => {
    const samples = [
      `{"a":"引号\\"与反斜杠\\\\","b":"\\u4e2d\\u6587"}`,
      `{"n":[1e3,-0.5,1.5e-8,0,true,false,null]}`,
      `{"nested":{"deep":[{"x":[[]]},{}]}}`,
      `{"emoji":"🚁","tab":"a\\tb\\nc"}`,
    ]
    for (const sample of samples) {
      expect(parseJsonWithLayout(sample).value).toEqual(JSON.parse(sample))
    }
  })

  it('新建的容器按「孩子全是标量」启发式内联，超长时摊开', () => {
    const layout = { inline: new WeakSet<object>(), block: new WeakSet<object>(), indent: '  ', trailingNewline: true }
    expect(stringifyWithLayout({ a: { const: 'x' } }, layout)).toBe(`{\n  "a": { "const": "x" }\n}\n`)
    const long = { a: { const: 'x'.repeat(90) } }
    expect(stringifyWithLayout(long, layout)).toContain('\n    "const"')
  })

  it('源文件刻意摊开的容器不会被启发式收成单行', () => {
    // "api": {} 是空容器可内联，但父层 trigger 原文是多行的，必须保持多行
    const text = `{\n  "trigger": {\n    "api": {}\n  }\n}\n`
    expect(serializeWorkflow(parse(text))).toBe(text)
  })
})

describe('工作流 → 图模型', () => {
  it('trigger 合成一个节点，种类取自 trigger 下非 description 的键', () => {
    const graph = toGraph(parse(HAND_WRITTEN))
    const trigger = graph.nodes.find(node => node.kind === 'trigger')!
    expect(trigger.id).toBe(TRIGGER_NODE_ID)
    expect(trigger.action).toBe('api')
    expect(triggerKindOf(parse(`{"trigger":{"description":"d","schedule":{"intervalSec":1}}}`).raw)).toBe('schedule')
  })

  it('没有 needs 的 step 隐式挂在 trigger 下，不会变成游离节点', () => {
    const graph = toGraph(parse(HAND_WRITTEN))
    expect(graph.edges).toContainEqual({ from: TRIGGER_NODE_ID, to: 'fetch', origin: 'implicit', refKinds: [] })
    expect(graph.edges).toContainEqual({ from: 'fetch', to: 'report', origin: 'needs', refKinds: [] })
    // 有 needs 的 step 不再额外连 trigger
    expect(graph.edges.filter(edge => edge.to === 'report')).toHaveLength(1)
  })

  it('inputs 的 from / const 都提取成 refs，const 保留 JSON 字面量形态', () => {
    const graph = toGraph(parse(HAND_WRITTEN))
    const fetch = graph.nodes.find(node => node.id === 'fetch')!
    expect(fetch.refs).toEqual([
      { key: 'script', kind: 'const', value: '"fetch-script"' },
      { key: 'title', kind: 'from', value: 'trigger.title' },
    ])
  })

  it('needs 指向不存在的 step 记为 DANGLING_NEEDS 且不画这条边', () => {
    const graph = toGraph(parse(`{"name":"f","trigger":{"api":{}},"steps":[{"id":"a","needs":["ghost"],"action":"x"}]}`))
    expect(graph.issues).toEqual([
      { code: 'DANGLING_NEEDS', nodeId: 'a', message: 'step a 的 needs 引用了不存在的 ghost。' },
    ])
    expect(graph.edges).toEqual([])
  })

  it('needs 指向自己记为 SELF_LOOP —— d3-dag 不支持自环，必须在建图前挡掉', () => {
    const graph = toGraph(parse(`{"name":"f","trigger":{"api":{}},"steps":[{"id":"a","needs":["a"],"action":"x"}]}`))
    expect(graph.issues.map(issue => issue.code)).toEqual(['SELF_LOOP'])
    expect(graph.edges).toEqual([])
  })

  it('重复 step id 与缺失 id 都被记为 issue', () => {
    const graph = toGraph(parse(`{"steps":[{"id":"a","action":"x"},{"id":"a","action":"y"},{"action":"z"}]}`))
    expect(graph.issues.map(issue => issue.code).sort()).toEqual(['DUPLICATE_STEP_ID', 'MISSING_STEP_ID'])
  })

  it('同一条 needs 写两遍只产生一条边', () => {
    const graph = toGraph(parse(`{"steps":[{"id":"a","action":"x"},{"id":"b","needs":["a","a"],"action":"y"}]}`))
    expect(graph.edges.filter(edge => edge.from === 'a' && edge.to === 'b')).toHaveLength(1)
  })

  it('同一条 needs 写两遍记为 DUPLICATE_NEEDS —— 静默去重会让画布与源 JSON 长期不一致', () => {
    const graph = toGraph(parse(`{"steps":[{"id":"a","action":"x"},{"id":"b","needs":["a","a"],"action":"y"}]}`))
    expect(graph.issues.map(issue => issue.code)).toEqual(['DUPLICATE_NEEDS'])
  })

  it('两个及以上节点构成的 needs 环记为 CYCLE，同一环只报一次', () => {
    const two = toGraph(parse(`{"steps":[{"id":"a","needs":["b"],"action":"x"},{"id":"b","needs":["a"],"action":"y"}]}`))
    expect(two.issues.filter(issue => issue.code === 'CYCLE')).toHaveLength(1)
    const three = toGraph(parse(`{"steps":[{"id":"a","needs":["c"],"action":"x"},{"id":"b","needs":["a"],"action":"y"},{"id":"c","needs":["b"],"action":"z"}]}`))
    const cycles = three.issues.filter(issue => issue.code === 'CYCLE')
    expect(cycles).toHaveLength(1)
    expect(cycles[0]!.message).toContain('环')
  })

  it('step id 占用 $trigger 保留字记为 RESERVED_STEP_ID', () => {
    const graph = toGraph(parse(`{"steps":[{"id":"$trigger","action":"x"}]}`))
    expect(graph.issues.map(issue => issue.code)).toContain('RESERVED_STEP_ID')
  })

  it('空 steps 记为 EMPTY_STEPS —— 声明了触发器却没有任何可执行步骤', () => {
    const graph = toGraph(parse(`{"name":"f","trigger":{"api":{}},"steps":[]}`))
    expect(graph.issues).toEqual([
      { code: 'EMPTY_STEPS', nodeId: TRIGGER_NODE_ID, message: '没有步骤：这条流程什么都不会执行。' },
    ])
  })

  it('steps 缺失或不是数组时只剩 trigger 节点，不抛异常', () => {
    expect(toGraph(parse(`{"name":"f","trigger":{"api":{}}}`)).nodes).toHaveLength(1)
    expect(toGraph(parse(`{"steps":"oops"}`)).nodes).toHaveLength(1)
  })

  it('只读语义字段（triggerMode / hasWhen / hasAwait / hasCallback）按实际 JSON 投影', () => {
    const graph = toGraph(parse(`{"trigger":{"api":{}},"steps":[
      {"id":"plain","action":"x"},
      {"id":"finalizer","action":"x","needs":["plain"],"trigger":"allDone"},
      {"id":"explicit_ok","action":"x","needs":["plain"],"trigger":"allSucceeded"},
      {"id":"guarded","action":"x","needs":["plain"],"when":{"field":"trigger.a","op":"present"}},
      {"id":"waiting","action":"wait_signal","needs":["plain"],"await":{"signal":"s","timeoutSec":5}},
      {"id":"cb","action":"x","needs":["plain"],"callback":{"signal":"c","timeoutSec":5}},
      {"id":"combo","action":"x","needs":["plain"],"trigger":"allDone","when":{"field":"trigger.a","op":"present"},"await":{"signal":"s2","timeoutSec":5},"callback":{"signal":"c2","timeoutSec":5}}
    ]}`))
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    const plain = byId.get('plain')!
    expect(plain.triggerMode).toBeUndefined()
    expect(plain.hasWhen).toBe(false)
    expect(plain.hasAwait).toBe(false)
    expect(plain.hasCallback).toBe(false)
    expect(byId.get('finalizer')!.triggerMode).toBe('allDone')
    expect(byId.get('explicit_ok')!.triggerMode).toBe('allSucceeded')
    expect(byId.get('guarded')!.hasWhen).toBe(true)
    expect(byId.get('waiting')!.hasAwait).toBe(true)
    expect(byId.get('waiting')!.hasWhen).toBe(false)
    expect(byId.get('cb')!.hasCallback).toBe(true)
    const combo = byId.get('combo')!
    expect(combo.triggerMode).toBe('allDone')
    expect(combo.hasWhen).toBe(true)
    expect(combo.hasAwait).toBe(true)
    expect(combo.hasCallback).toBe(true)
    // trigger 合成节点不带任何 step 语义
    const trigger = byId.get(TRIGGER_NODE_ID)!
    expect(trigger.triggerMode).toBeUndefined()
    expect(trigger.hasWhen).toBe(false)
    expect(trigger.hasAwait).toBe(false)
    expect(trigger.hasCallback).toBe(false)
  })

  it('词表外的 trigger 值不投影成已知档位（语义层裁决，投影不猜）', () => {
    const graph = toGraph(parse(`{"steps":[{"id":"a","action":"x","trigger":"weird"}]}`))
    expect(graph.nodes.find(node => node.id === 'a')!.triggerMode).toBeUndefined()
  })
})

describe('画布编辑的字节同构性', () => {
  it('解析后原样序列化，与原文逐字节一致', () => {
    expect(serializeWorkflow(parse(HAND_WRITTEN))).toBe(HAND_WRITTEN)
  })

  it('改一个 step 的 action 只影响那一处，其余字节不动', () => {
    const document = parse(HAND_WRITTEN)
    expect(setStepText(document, 'report', 'action', 'run_other')).toBe(true)
    const output = serializeWorkflow(document)
    expect(output).toBe(HAND_WRITTEN.replace(
      `"id": "report",\n      "needs": ["fetch"],\n      "action": "run_script",`,
      `"id": "report",\n      "needs": ["fetch"],\n      "action": "run_other",`,
    ))
  })

  it('未知字段（schema 之外的键）在编辑后仍被原样保留', () => {
    const withUnknown = `{\n  "name": "f",\n  "x-internal": { "owner": "team" },\n  "trigger": {\n    "api": {}\n  },\n  "steps": [\n    {\n      "id": "a",\n      "action": "x",\n      "x-note": 1\n    }\n  ]\n}\n`
    const document = parse(withUnknown)
    setStepText(document, 'a', 'action', 'y')
    const output = serializeWorkflow(document)
    expect(output).toContain('"x-internal"')
    expect(output).toContain('"x-note": 1')
    // 键序也没动：x-internal 仍在 name 之后、trigger 之前
    expect(output.indexOf('"x-internal"')).toBeLessThan(output.indexOf('"trigger"'))
  })

  it('新增 step 的键序是 id → needs → action，与手写风格一致', () => {
    const document = parse(HAND_WRITTEN)
    expect(addStep(document, { id: 'notify', action: 'run_script', needs: ['report'] })).toBe(true)
    expect(serializeWorkflow(document)).toContain(`{
      "id": "notify",
      "needs": ["report"],
      "action": "run_script"
    }`)
  })

  it('新增 step 不带 needs 时不写该字段（保持隐式挂 trigger）', () => {
    const document = parse(`{"steps":[]}`)
    addStep(document, { id: 'a', action: 'x' })
    expect(JSON.parse(serializeWorkflow(document))).toEqual({ steps: [{ id: 'a', action: 'x' }] })
  })

  it('id 或 action 为空、id 撞车时拒绝新增', () => {
    const document = parse(HAND_WRITTEN)
    expect(addStep(document, { id: '', action: 'x' })).toBe(false)
    expect(addStep(document, { id: 'a', action: '  ' })).toBe(false)
    expect(addStep(document, { id: 'fetch', action: 'x' })).toBe(false)
  })

  it('description 置空等于删字段而不是留空串（schema 对 action 要求 minLength 1）', () => {
    const document = parse(`{"steps":[{"id":"a","description":"d","action":"x"}]}`)
    expect(setStepText(document, 'a', 'description', '   ')).toBe(true)
    expect(JSON.parse(serializeWorkflow(document))).toEqual({ steps: [{ id: 'a', action: 'x' }] })
    // 已经没有该字段时再置空是无改动
    expect(setStepText(document, 'a', 'description', '')).toBe(false)
  })

  it('setTriggerDescription 同样遵守「空串即删字段」', () => {
    const document = parse(`{"trigger":{"description":"d","api":{}}}`)
    expect(setTriggerDescription(document, '新说明')).toBe(true)
    expect(setTriggerDescription(document, '')).toBe(true)
    expect(JSON.parse(serializeWorkflow(document))).toEqual({ trigger: { api: {} } })
  })
})

describe('画布编辑：重命名 / 删除 / 连断边', () => {
  it('重命名 step 会同步改掉下游的 needs', () => {
    const document = parse(HAND_WRITTEN)
    expect(renameStep(document, 'fetch', 'load')).toBe(true)
    const parsed = JSON.parse(serializeWorkflow(document)) as { steps: { id: string; needs?: string[] }[] }
    expect(parsed.steps[0]!.id).toBe('load')
    expect(parsed.steps[1]!.needs).toEqual(['load'])
  })

  it('重命名到已存在的 id 被拒绝，文档不变', () => {
    const document = parse(HAND_WRITTEN)
    expect(renameStep(document, 'fetch', 'report')).toBe(false)
    expect(serializeWorkflow(document)).toBe(HAND_WRITTEN)
  })

  it('删除 step 会摘掉下游对它的 needs；摘空后 needs 字段整个消失', () => {
    const document = parse(HAND_WRITTEN)
    expect(removeStep(document, 'fetch')).toBe(true)
    const parsed = JSON.parse(serializeWorkflow(document)) as { steps: Record<string, unknown>[] }
    expect(parsed.steps).toHaveLength(1)
    expect(parsed.steps[0]).not.toHaveProperty('needs')
    expect(hasStep(document, 'fetch')).toBe(false)
  })

  it('connect 往 needs 追加；重复 connect 无改动', () => {
    const document = parse(`{"steps":[{"id":"a","action":"x"},{"id":"b","action":"y"}]}`)
    expect(connect(document, 'a', 'b')).toBe(true)
    expect(connect(document, 'a', 'b')).toBe(false)
    expect(JSON.parse(serializeWorkflow(document))).toEqual({
      steps: [{ id: 'a', action: 'x' }, { id: 'b', action: 'y', needs: ['a'] }],
    })
  })

  it('从 trigger 连出去是隐式形态，不写任何字段', () => {
    const document = parse(`{"steps":[{"id":"a","action":"x"}]}`)
    expect(connect(document, TRIGGER_NODE_ID, 'a')).toBe(false)
    expect(JSON.parse(serializeWorkflow(document))).toEqual({ steps: [{ id: 'a', action: 'x' }] })
  })

  it('disconnect 摘到空就删 needs 字段，回到隐式挂 trigger', () => {
    const document = parse(HAND_WRITTEN)
    expect(disconnect(document, 'fetch', 'report')).toBe(true)
    const parsed = JSON.parse(serializeWorkflow(document)) as { steps: Record<string, unknown>[] }
    expect(parsed.steps[1]).not.toHaveProperty('needs')
    expect(toGraph(document).edges).toContainEqual({ from: TRIGGER_NODE_ID, to: 'report', origin: 'implicit', refKinds: [] })
  })

  it('对不存在的节点做编辑一律返回 false 且不改文档', () => {
    const document = parse(HAND_WRITTEN)
    expect(setStepText(document, 'ghost', 'action', 'x')).toBe(false)
    expect(renameStep(document, 'ghost', 'y')).toBe(false)
    expect(removeStep(document, 'ghost')).toBe(false)
    expect(connect(document, 'ghost', 'fetch')).toBe(false)
    expect(disconnect(document, 'ghost', 'fetch')).toBe(false)
    expect(serializeWorkflow(document)).toBe(HAND_WRITTEN)
  })
})

describe('对仓库内真实工作流文件的字节级往返', () => {
  /**
   * 这是「画布是生成器不是运行时」最硬的一条验收：
   * 仓库里**已存在**的手写 workflow 读进来再写出去必须一字不差，
   * 否则画布一打开就会污染这些文件的 diff。
   */
  const fixtures = [
    'packages/fh2-plugin-toolchain/template-backend/workflows/example-flow.json',
    'packages/fh2-plugin-toolchain/src/backend/__fixtures__/valid/packed-plugin/workflows/packed-flow.json',
    'packages/fh2-plugin-toolchain/src/backend/__fixtures__/valid/full-plugin/workflows/example-flow.json',
    'packages/fh2-plugin-toolchain/src/backend/__fixtures__/invalid/workflow-without-trigger/workflows/missing-trigger.json',
    'packages/fh2-plugin-toolchain/src/backend/__fixtures__/invalid/trigger-description-only/workflows/no-trigger-kind.json',
  ]
  const repoRoot = resolve(import.meta.dirname, '../../../../..')

  for (const fixture of fixtures) {
    it(`${fixture} 读写往返逐字节一致`, () => {
      const text = readFileSync(join(repoRoot, fixture), 'utf8')
      const document = parse(text)
      expect(document.lossless).toBe(true)
      expect(serializeWorkflow(document)).toBe(text)
    })
  }
})

describe('成环检测', () => {
  const chain = toGraph(parse(`{"steps":[
    {"id":"a","action":"x"},
    {"id":"b","needs":["a"],"action":"x"},
    {"id":"c","needs":["b"],"action":"x"}
  ]}`))

  it('回连上游会成环', () => {
    expect(wouldCreateCycle(chain, 'c', 'a')).toBe(true)
    expect(wouldCreateCycle(chain, 'b', 'a')).toBe(true)
  })

  it('顺着方向连不成环；连自己必然成环', () => {
    expect(wouldCreateCycle(chain, 'a', 'c')).toBe(false)
    expect(wouldCreateCycle(chain, 'a', 'a')).toBe(true)
  })
})

/**
 * 边分类 refKinds（ordering-edge-semantics plan §3.4）。
 *
 * ★★ 期望表必须与 worker 仓 flowviz 的
 * TestEdgeClassesSeparateRealDepsFromOrdering 逐条一致（plan §7）：任一侧改
 * 判据，另一侧的表会红。ACCIDENT_RESPONSE 用仓内真实文件，不抄写副本。
 */
describe('边分类 refKinds（plan §3.4）', () => {
  const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url))
  const ACCIDENT_PATH = 'packages/fh2-traffic-capabilities/official_accident/backend/official_accident_plugin/workflows/accident-response-cascade.json'

  function accidentGraph (): ReturnType<typeof toGraph> {
    const text = readFileSync(join(REPO_ROOT, ACCIDENT_PATH), 'utf8')
    const parsed = parseJsonWithLayout(text)
    return toGraph({ raw: parsed.value as Record<string, unknown> })
  }

  function refKindsOf (graph: ReturnType<typeof toGraph>, from: string, to: string): readonly string[] {
    const edge = graph.edges.find(item => item.from === from && item.to === to)
    if (edge === undefined) throw new Error(`边 ${from} → ${to} 不存在`)
    return edge.refKinds
  }

  it('accident 期望表：数据依赖 / 判据依赖 / 纯顺序三类钉死', () => {
    const graph = accidentGraph()
    // 数据依赖（inputs.from）
    expect(refKindsOf(graph, 'dispatch', 'mark_handling')).toEqual(['input'])
    // 判据依赖（when）
    expect(refKindsOf(graph, 'poll', 'mark_completed')).toEqual(['when'])
    expect(refKindsOf(graph, 'ack', 'close_ack_timeout')).toEqual(['when'])
    expect(refKindsOf(graph, 'dispatch', 'close_error')).toEqual(['when'])
    // 纯顺序：一个值都不取
    expect(refKindsOf(graph, 'mark_ack', 'mark_handling')).toEqual([])
    expect(refKindsOf(graph, 'mark_handling', 'mark_completed')).toEqual([])
  })

  it('负向：引用落在传递祖先上时不算中间那条边的事实', () => {
    // a → b → c，c 读 steps.a.x：那是 a → c 之间（经 b 传递）的引用，
    // b → c 这条边本身没承载任何引用。
    const graph = toGraph(parse(`{"name":"f","trigger":{"api":{}},"steps":[
      {"id":"a","action":"x"},
      {"id":"b","needs":["a"],"action":"x"},
      {"id":"c","needs":["b"],"action":"x","inputs":{"v":{"from":"steps.a.x"}}}
    ]}`))
    expect(refKindsOf(graph, 'b', 'c')).toEqual([])
    expect(refKindsOf(graph, 'a', 'b')).toEqual([])
  })

  it('一个 needs 同时承载多种引用时去重且稳定定序；timeoutSecFrom 归入对应档', () => {
    const graph = toGraph(parse(`{"name":"f","trigger":{"api":{}},"steps":[
      {"id":"a","action":"x"},
      {"id":"b","needs":["a"],"action":"wait_signal",
        "when":{"field":"steps.a.state","op":"eq","value":"s"},
        "inputs":{"x":{"from":"steps.a.x"},"y":{"from":"steps.a.y"}},
        "await":{"signal":"s","timeoutSecFrom":"steps.a.waitSec"},
        "callback":{"signal":"c","timeoutSecFrom":"steps.a.cbSec"}}
    ]}`))
    expect(refKindsOf(graph, 'a', 'b')).toEqual(['input', 'when', 'awaitTimeout', 'callbackTimeout'])
  })

  it('implicit 边 refKinds 恒为空（先判 origin 再判 refKinds 的契约前提）', () => {
    const graph = toGraph(parse(`{"name":"f","trigger":{"api":{}},"steps":[
      {"id":"a","action":"x","inputs":{"v":{"from":"steps.a.self"}}}
    ]}`))
    const implicit = graph.edges.find(edge => edge.origin === 'implicit')!
    expect(implicit.refKinds).toEqual([])
  })
})
