// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import type { ActionCatalog } from './catalog.js'
import { applyJsonEditOps, parseJsonValue } from './json-edits.js'
import type { PrepareResult } from './commands.js'
import {
  prepareAddStep,
  prepareConnectDependency,
  prepareCreateWorkflow,
  prepareDisconnectDependency,
  prepareRemoveStep,
  prepareRenameStep,
  prepareSetCondition,
  prepareSetInput,
} from './step-commands.js'
import {
  prepareChangeScriptIo,
  prepareCreateScriptAndBind,
  prepareCreateScriptFunction,
  prepareMoveScriptFile,
  prepareRenameScriptEntry,
  prepareRenameScriptId,
} from './script-commands.js'

/**
 * 13 条命令的用例。重点**不是**「能改对」，而是那些**静默**的错法：
 * 自动重接、自动删接线、拿 falsy 常量当没填、环检查跑在增量上、
 * 跨文件只写了一半、把三个 id 混着改。
 */

const CATALOG: ActionCatalog = {
  available: true,
  scriptLanguage: 'javascript',
  fixedSteps: [
    {
      action: 'dispatch_mission',
      capability: 'device.mission:execute',
      isFlight: true,
      kind: 'activity',
      owner: 'platform',
      nonIdempotent: true,
      inputs: [
        { name: 'waylineUuid', type: 'id', required: true },
        { name: 'lat', type: 'number' },
      ],
      outputs: [{ name: 'missionId', type: 'id' }],
    },
    { action: 'wait_signal', kind: 'await_signal', owner: 'platform', inputs: [], outputs: [] },
  ],
  scripts: [
    {
      id: 'evaluate_dispatch',
      path: 'adapters/evaluate.js',
      filePath: 'adapters/evaluate.js',
      allowlist: ['data:read'],
      inputs: [{ name: 'eventId', type: 'string', required: true }],
      outputs: [{ name: 'decision', type: 'string' }, { name: 'waylineUuid', type: 'string' }],
    },
  ],
  triggerSeeds: { api: { available: [], notGuaranteed: [] } },
  runRoot: ['now', 'idempotencyKey', 'intervalSec'],
  scriptAction: 'run_script',
  pluginActionPrefix: 'plugin.',
  stepStates: ['succeeded', 'failed', 'skipped', 'timedOut', 'interrupted'],
  conditionOps: ['eq', 'ne', 'in', 'exists', 'blank', 'present'],
  stepTriggers: ['allSucceeded', 'allDone'],
  grantableCaps: ['data:read', 'data:write', 'egress:fetch'],
  ioFieldTypes: ['string', 'number', 'bool', 'object', 'array'],
  pluginManifestFound: true,
  pluginManifestPath: 'fh2-plugin.json',
  source: { kind: 'knowledge', revision: 'bpk-test' },
}

const WORKFLOW_TEXT = `{
  "name": "dispatch_decision",
  "trigger": { "api": { "seed": ["eventId"] } },
  "steps": [
    { "id": "evaluate", "action": "run_script",
      "inputs": { "script": { "const": "evaluate_dispatch" }, "eventId": { "from": "trigger.eventId" } } },
    {
      "id": "fly",
      "action": "dispatch_mission",
      "needs": ["evaluate"],
      "inputs": { "waylineUuid": { "from": "steps.evaluate.waylineUuid" } }
    }
  ]
}
`

const MANIFEST_TEXT = `{
  "pluginId": "demo",
  "name": "demo",
  "version": "0.1.0",
  "flows": ["workflows/dispatch.json"],
  "connections": [],
  "scripts": [
    { "name": "evaluate_dispatch", "path": "adapters/evaluate.js", "allowlist": ["data:read"],
      "io": { "inputs": [{ "name": "eventId", "type": "string", "required": true }],
              "outputs": [{ "name": "decision", "type": "string" }, { "name": "waylineUuid", "type": "string" }] } }
  ]
}
`

function workflowContext (text = WORKFLOW_TEXT) {
  return {
    workspaceEpoch: 1,
    knowledgeId: 'bpk-test',
    workflow: { path: 'workflows/dispatch.json', text, generation: 10 },
    catalog: CATALOG,
  }
}

function scriptContext (manifestText = MANIFEST_TEXT, workflowText = WORKFLOW_TEXT) {
  return {
    workspaceEpoch: 1,
    knowledgeId: 'bpk-test',
    manifest: { path: 'fh2-plugin.json', text: manifestText, generation: 20 },
    workflow: { path: 'workflows/dispatch.json', text: workflowText, generation: 10 },
    catalog: CATALOG,
  }
}

/** 把一条 ok 的命令应用到对应文件上，回解析后的值。 */
function applyTo (result: PrepareResult, path: string, text: string): Record<string, any> {
  expect(result.ok, result.ok ? '' : result.reason).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  const edit = result.command.edits.find(item => item.path === path)
  expect(edit, `命令里没有针对 ${path} 的编辑`).toBeDefined()
  if (edit!.kind !== 'modify') throw new Error(`${path} 不是 modify 编辑`)
  return parseJsonValue(applyJsonEditOps(text, edit!.ops)) as Record<string, any>
}

describe('addStep', () => {
  it('加一个平台动作节点，带上游', () => {
    const value = applyTo(
      prepareAddStep(workflowContext(), { id: 'notice', action: 'dispatch_mission', upstream: 'fly' }),
      'workflows/dispatch.json',
      WORKFLOW_TEXT,
    )
    expect(value.steps).toHaveLength(3)
    expect(value.steps[2]).toEqual({ id: 'notice', action: 'dispatch_mission', needs: ['fly'] })
  })

  it('脚本步必须给功能 ID，且自动写进 inputs.script.const', () => {
    expect(prepareAddStep(workflowContext(), { id: 'n', action: 'run_script' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('必须指定要调用的业务功能') })

    const value = applyTo(
      prepareAddStep(workflowContext(), { id: 'n', action: 'run_script', scriptId: 'evaluate_dispatch' }),
      'workflows/dispatch.json',
      WORKFLOW_TEXT,
    )
    expect(value.steps[2].inputs.script).toEqual({ const: 'evaluate_dispatch' })
  })

  it('拒绝：重名 id、非法 id、词表外动作、不存在的功能、触发器当上游', () => {
    const context = workflowContext()
    expect(prepareAddStep(context, { id: 'fly', action: 'dispatch_mission' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('已存在') })
    // id 里带点会把引用路径切错 —— 这是必须拦的那一类。
    expect(prepareAddStep(context, { id: 'a.b', action: 'dispatch_mission' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('不合法') })
    expect(prepareAddStep(context, { id: 'n', action: 'made_up_action' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('不在平台动作目录里') })
    expect(prepareAddStep(context, { id: 'n', action: 'run_script', scriptId: 'ghost' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('没有业务功能') })
    expect(prepareAddStep(context, { id: 'n', action: 'dispatch_mission', upstream: '$trigger' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('触发器不是步骤') })
  })

  it('插件自定义能力（plugin.<名>）放行', () => {
    expect(prepareAddStep(workflowContext(), { id: 'n', action: 'plugin.my_cap' }).ok).toBe(true)
  })

  it('空流程（没有 steps 数组）也能加第一个节点', () => {
    const empty = '{\n  "name": "f"\n}\n'
    const value = applyTo(
      prepareAddStep(workflowContext(empty), { id: 'first', action: 'dispatch_mission' }),
      'workflows/dispatch.json',
      empty,
    )
    expect(value.steps).toEqual([{ id: 'first', action: 'dispatch_mission' }])
  })
})

describe('removeStep', () => {
  it('被引用时先给影响清单，不自动改（默认拒）', () => {
    const result = prepareRemoveStep(workflowContext(), { id: 'evaluate' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.impacts?.map(impact => impact.at).sort())
      .toEqual(['inputs.waylineUuid.from', 'needs[0]'])
  })

  it('force 之后才删，且**只删那一步**，不顺手清理引用', () => {
    const value = applyTo(
      prepareRemoveStep(workflowContext(), { id: 'evaluate', force: true }),
      'workflows/dispatch.json',
      WORKFLOW_TEXT,
    )
    expect(value.steps.map((step: any) => step.id)).toEqual(['fly'])
    // 那条悬空引用**留在原处**：替用户删掉等于替他丢配置。
    expect(value.steps[0].inputs.waylineUuid.from).toBe('steps.evaluate.waylineUuid')
    expect(value.steps[0].needs).toEqual(['evaluate'])
  })

  it('没人引用时直接可删', () => {
    expect(prepareRemoveStep(workflowContext(), { id: 'fly' }).ok).toBe(true)
  })
})

describe('renameStep', () => {
  it('同时改 id 与全部引用', () => {
    const value = applyTo(
      prepareRenameStep(workflowContext(), { from: 'evaluate', to: 'judge' }),
      'workflows/dispatch.json',
      WORKFLOW_TEXT,
    )
    expect(value.steps[0].id).toBe('judge')
    expect(value.steps[1].needs).toEqual(['judge'])
    expect(value.steps[1].inputs.waylineUuid.from).toBe('steps.judge.waylineUuid')
  })

  it('拒绝重名与非法 id', () => {
    expect(prepareRenameStep(workflowContext(), { from: 'evaluate', to: 'fly' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('已存在') })
    expect(prepareRenameStep(workflowContext(), { from: 'evaluate', to: 'evaluate' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('相同') })
  })
})

describe('connectDependency / DisconnectDependency', () => {
  it('加一条依赖', () => {
    const three = applyJsonEditOps(WORKFLOW_TEXT, [
      { path: ['steps', 2], value: { id: 'notice', action: 'dispatch_mission' }, insert: true },
    ])
    const value = applyTo(
      prepareConnectDependency(workflowContext(three), { from: 'fly', to: 'notice' }),
      'workflows/dispatch.json',
      three,
    )
    expect(value.steps[2].needs).toEqual(['fly'])
  })

  it('拒绝自环、重复、触发器、不存在的步骤', () => {
    const context = workflowContext()
    expect(prepareConnectDependency(context, { from: 'fly', to: 'fly' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('不能依赖自己') })
    expect(prepareConnectDependency(context, { from: 'evaluate', to: 'fly' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('已经依赖') })
    expect(prepareConnectDependency(context, { from: '$trigger', to: 'fly' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('触发器是合成视图节点') })
    expect(prepareConnectDependency(context, { from: 'ghost', to: 'fly' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('不存在') })
  })

  it('环检查跑在应用之后的完整图上', () => {
    // fly 已依赖 evaluate；再让 evaluate 依赖 fly 就成环。
    const result = prepareConnectDependency(workflowContext(), { from: 'fly', to: 'evaluate' })
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('形成环') })
    if (!result.ok) expect(result.reason).toMatch(/evaluate|fly/)
  })

  it('断依赖时先列出还指着上游的取值（数据依赖不随控制依赖消失）', () => {
    const result = prepareDisconnectDependency(workflowContext(), { from: 'evaluate', to: 'fly' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.impacts?.map(impact => impact.at)).toEqual(['inputs.waylineUuid.from'])
  })

  it('force 之后只删 needs 里那一项，取值留着', () => {
    const value = applyTo(
      prepareDisconnectDependency(workflowContext(), { from: 'evaluate', to: 'fly', force: true }),
      'workflows/dispatch.json',
      WORKFLOW_TEXT,
    )
    expect(value.steps[1].needs).toEqual([])
    expect(value.steps[1].inputs.waylineUuid.from).toBe('steps.evaluate.waylineUuid')
  })
})

describe('setInput', () => {
  it('接一条在闭包里的引用', () => {
    const value = applyTo(
      prepareSetInput(workflowContext(), {
        stepId: 'fly',
        key: 'lat',
        mode: 'from',
        value: 'steps.evaluate.decision',
      }),
      'workflows/dispatch.json',
      WORKFLOW_TEXT,
    )
    expect(value.steps[1].inputs.lat).toEqual({ from: 'steps.evaluate.decision' })
  })

  it('来源不在依赖闭包里时拒绝，并提示先加依赖（**不自动加**）', () => {
    // evaluate 不依赖 fly，所以 evaluate 引用 fly 的产出是解不开的。
    const result = prepareSetInput(workflowContext(), {
      stepId: 'evaluate',
      key: 'x',
      mode: 'from',
      value: 'steps.fly.missionId',
    })
    expect(result).toMatchObject({ ok: false })
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('不在')
    expect(result.reason).toContain('请先把')
  })

  it('null / false / 0 是**有意义的显式绑定**，不能当没填', () => {
    for (const constant of [null, false, 0, '']) {
      const value = applyTo(
        prepareSetInput(workflowContext(), { stepId: 'fly', key: 'lat', mode: 'const', value: constant }),
        'workflows/dispatch.json',
        WORKFLOW_TEXT,
      )
      expect(value.steps[1].inputs.lat).toEqual({ const: constant })
    }
  })

  it('undefined 不是常量（要清除请用 clear）', () => {
    expect(prepareSetInput(workflowContext(), { stepId: 'fly', key: 'lat', mode: 'const', value: undefined }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('undefined') })
  })

  it('clear 删掉整条接线', () => {
    const value = applyTo(
      prepareSetInput(workflowContext(), { stepId: 'fly', key: 'waylineUuid', mode: 'clear' }),
      'workflows/dispatch.json',
      WORKFLOW_TEXT,
    )
    expect(value.steps[1].inputs.waylineUuid).toBeUndefined()
  })

  it('非法引用路径直接拒', () => {
    expect(prepareSetInput(workflowContext(), { stepId: 'fly', key: 'lat', mode: 'from', value: 'nonsense' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('不合法') })
    expect(prepareSetInput(workflowContext(), { stepId: 'fly', key: 'lat', mode: 'from', value: 'steps.ghost.x' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('不存在') })
  })
})

describe('setCondition', () => {
  it('写一条叶子条件', () => {
    const value = applyTo(
      prepareSetCondition(workflowContext(), {
        stepId: 'fly',
        condition: { field: 'steps.evaluate.decision', op: 'eq', value: 'go' },
      }),
      'workflows/dispatch.json',
      WORKFLOW_TEXT,
    )
    expect(value.steps[1].when).toEqual({ field: 'steps.evaluate.decision', op: 'eq', value: 'go' })
  })

  it('未知算子必须拒 —— 它不会报错，只会让这条 when 恒为假', () => {
    const result = prepareSetCondition(workflowContext(), {
      stepId: 'fly',
      condition: { field: 'steps.evaluate.$state', op: 'equals', value: 'x' },
    })
    expect(result).toMatchObject({ ok: false })
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('恒为假')
  })

  it('叶子与 and/or 三选一，不能同时写；空 and/or 是写坏了', () => {
    const context = workflowContext()
    expect(prepareSetCondition(context, {
      stepId: 'fly',
      condition: { field: 'steps.evaluate.decision', op: 'eq', and: [] },
    })).toMatchObject({ ok: false, reason: expect.stringContaining('三选一') })
    expect(prepareSetCondition(context, { stepId: 'fly', condition: { and: [] } }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('空的 and/or') })
  })

  it('递归校验 and/or 的成员', () => {
    expect(prepareSetCondition(workflowContext(), {
      stepId: 'fly',
      condition: { and: [{ field: 'steps.evaluate.decision', op: 'bogus' }] },
    })).toMatchObject({ ok: false, reason: expect.stringContaining('bogus') })
  })

  it('condition 缺省 = 删掉 when', () => {
    expect(prepareSetCondition(workflowContext(), { stepId: 'fly' }).ok).toBe(true)
  })
})

describe('createScriptFunction', () => {
  it('同时改清单与建 JS 文件（跨文件一条命令）', () => {
    const result = prepareCreateScriptFunction(scriptContext(), {
      name: 'build_notice',
      path: 'adapters/build-notice.js',
      description: '拼通知文案',
      allowlist: ['data:read'],
      inputs: [{ name: 'decision', type: 'string', required: true }],
      outputs: [{ name: 'text', type: 'string' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    expect(result.command.edits.map(edit => `${edit.kind}:${edit.path}`)).toEqual([
      'modify:fh2-plugin.json',
      'create:adapters/build-notice.js',
    ])
    const value = applyTo(result, 'fh2-plugin.json', MANIFEST_TEXT)
    expect(value.scripts[1]).toMatchObject({
      name: 'build_notice',
      path: 'adapters/build-notice.js',
      allowlist: ['data:read'],
      io: { inputs: [{ name: 'decision', type: 'string', required: true }], outputs: [{ name: 'text', type: 'string' }] },
    })
    // entry 缺省是 handle，不写进清单（少一个可以漂移的字段）。
    expect(value.scripts[1].entry).toBeUndefined()
  })

  it('复用同一份文件的另一个入口是受支持的，且**不重建文件**', () => {
    const result = prepareCreateScriptFunction(scriptContext(), {
      name: 'second_entry',
      path: 'adapters/evaluate.js',
      entry: 'handleOther',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // 只改清单：再 create 一次会用模板盖掉已有实现。
    expect(result.command.edits.map(edit => edit.kind)).toEqual(['modify'])
    const value = applyTo(result, 'fh2-plugin.json', MANIFEST_TEXT)
    expect(value.scripts[1]).toMatchObject({ entry: 'handleOther' })
  })

  it('path + entry 都撞才算重复', () => {
    expect(prepareCreateScriptFunction(scriptContext(), { name: 'dup', path: 'adapters/evaluate.js' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('同一个 path + entry') })
  })

  it('拒绝：重名功能、非法路径、逃逸路径、非 .js、授不出的能力', () => {
    const context = scriptContext()
    expect(prepareCreateScriptFunction(context, { name: 'evaluate_dispatch', path: 'a.js' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('已存在') })
    expect(prepareCreateScriptFunction(context, { name: 'x', path: '../out.js' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('..') })
    expect(prepareCreateScriptFunction(context, { name: 'x', path: '/abs.js' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('相对') })
    expect(prepareCreateScriptFunction(context, { name: 'x', path: 'a.ts' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('.js') })
    const bad = prepareCreateScriptFunction(context, { name: 'x', path: 'a.js', allowlist: ['made:up'] })
    expect(bad).toMatchObject({ ok: false })
    if (!bad.ok) expect(bad.reason).toContain('装载期拒掉整个插件包')
  })

  it('模板源码按语言档案生成：JS 注明 goja 运行时约束 + 明确未实现', () => {
    const result = prepareCreateScriptFunction(scriptContext(), { name: 'x', path: 'adapters/x.js', entry: 'run' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const create = result.command.edits.find(edit => edit.kind === 'create')
    const content = create?.kind === 'create' ? create.content : ''
    // P0-1：入口函数名与 entry 一致；不引用不存在的 ctx.log；不生成伪成功返回值。
    expect(content).toContain('function run (input)')
    expect(content).not.toContain('ctx.log')
    expect(content).toContain('throw new Error(\'TODO: implement business logic\')')
    expect(content).not.toContain('return {')
  })

  it('tS 工程生成命名导出且扩展名校验按语言收严（P0-1）', () => {
    const tsContext = { ...scriptContext(), scriptLanguage: 'typescript' as const }
    // JS 扩展名在 TS 工程被拒。
    const bad = prepareCreateScriptFunction(tsContext, { name: 'x', path: 'adapters/x.js' })
    expect(bad).toMatchObject({ ok: false })
    if (!bad.ok) expect(bad.reason).toContain('.ts')

    const result = prepareCreateScriptFunction(tsContext, {
      name: 'x',
      path: 'adapters/x.ts',
      entry: 'handle',
      inputs: [{ name: 'title', type: 'string' }, { name: 'count', type: 'number' }],
      outputs: [{ name: 'decision', type: 'string' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const create = result.command.edits.find(edit => edit.kind === 'create')
    const content = create?.kind === 'create' ? create.content : ''
    expect(content).toContain('export function handle (input: { "title": string, "count": number }): { "decision": string }')
    expect(content).toContain('throw new Error(\'TODO: implement business logic\')')

    // JS 工程不接受 .ts。
    const reversed = prepareCreateScriptFunction(scriptContext(), { name: 'x', path: 'adapters/x.ts' })
    expect(reversed).toMatchObject({ ok: false })
    if (!reversed.ok) expect(reversed.reason).toContain('.js')
  })
})

describe('createScriptAndBind', () => {
  it('一条命令改三个东西：清单 + JS + 流程节点', () => {
    const result = prepareCreateScriptAndBind(scriptContext(), {
      name: 'build_notice',
      path: 'adapters/build-notice.js',
      stepId: 'notice',
      upstream: 'fly',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    expect(result.command.edits.map(edit => `${edit.kind}:${edit.path}`)).toEqual([
      'modify:fh2-plugin.json',
      'create:adapters/build-notice.js',
      'modify:workflows/dispatch.json',
    ])
    // 前置要覆盖两个被改的 JSON 文件 —— 少一个就有半写风险。
    expect(result.command.expected.documents.map(doc => doc.path).sort())
      .toEqual(['fh2-plugin.json', 'workflows/dispatch.json'])

    const flow = applyTo(result, 'workflows/dispatch.json', WORKFLOW_TEXT)
    expect(flow.steps[2]).toEqual({
      id: 'notice',
      action: 'run_script',
      needs: ['fly'],
      inputs: { script: { const: 'build_notice' } },
    })
    expect(result.command.focus).toMatchObject({ stepId: 'notice', openPath: 'adapters/build-notice.js' })
  })

  it('节点 id 撞了就整条拒（不能只建功能不建节点）', () => {
    expect(prepareCreateScriptAndBind(scriptContext(), {
      name: 'ok_name',
      path: 'adapters/ok.js',
      stepId: 'fly',
    })).toMatchObject({ ok: false, reason: expect.stringContaining('已存在') })
  })

  it('没给流程文档时拒绝（不能假装建了节点）', () => {
    const { workflow: _omitted, ...withoutWorkflow } = scriptContext()
    expect(prepareCreateScriptAndBind(withoutWorkflow, { name: 'x', path: 'a.js', stepId: 's' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('必须提供当前工作流文档') })
  })
})

describe('renameScriptId', () => {
  it('改清单 name，同时改当前流程里的 inputs.script.const', () => {
    const result = prepareRenameScriptId(scriptContext(), { from: 'evaluate_dispatch', to: 'judge_dispatch' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    expect(applyTo(result, 'fh2-plugin.json', MANIFEST_TEXT).scripts[0].name).toBe('judge_dispatch')
    expect(applyTo(result, 'workflows/dispatch.json', WORKFLOW_TEXT).steps[0].inputs.script)
      .toEqual({ const: 'judge_dispatch' })
  })

  it('没打开的其他流程以 advisories 交回，**不丢掉**', () => {
    const result = prepareRenameScriptId(scriptContext(), {
      from: 'evaluate_dispatch',
      to: 'judge_dispatch',
      otherFlows: ['workflows/other.json'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.advisories).toHaveLength(1)
    expect(result.advisories![0]).toMatchObject({ at: 'workflows/other.json' })
    expect(result.advisories![0]!.why).toContain('手动')
  })

  it('**不**顺手改节点 id（三个 id 不能混）', () => {
    const result = prepareRenameScriptId(scriptContext(), { from: 'evaluate_dispatch', to: 'judge_dispatch' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(applyTo(result, 'workflows/dispatch.json', WORKFLOW_TEXT).steps[0].id).toBe('evaluate')
  })
})

describe('moveScriptFile', () => {
  it('改 path + 建新文件 + 删旧文件', () => {
    const result = prepareMoveScriptFile(scriptContext(), {
      name: 'evaluate_dispatch',
      toPath: 'adapters/judge/evaluate.js',
      currentSource: 'function handle () { return {} }\n',
      sourceGeneration: 30,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.command.edits.map(edit => `${edit.kind}:${edit.path}`)).toEqual([
      'modify:fh2-plugin.json',
      'create:adapters/judge/evaluate.js',
      'delete:adapters/evaluate.js',
    ])
    // 旧文件的 generation 要进前置：搬动期间用户对它的编辑不能被静默丢掉。
    expect(result.command.expected.documents).toEqual([
      { path: 'fh2-plugin.json', generation: 20 },
      { path: 'adapters/evaluate.js', generation: 30 },
    ])
    expect(applyTo(result, 'fh2-plugin.json', MANIFEST_TEXT).scripts[0].path).toBe('adapters/judge/evaluate.js')
  })

  it('旧文件被多个功能共用时**不删**它', () => {
    const shared = applyJsonEditOps(MANIFEST_TEXT, [
      {
        path: ['scripts', 1],
        value: { name: 'other', path: 'adapters/evaluate.js', entry: 'other', allowlist: [], io: { inputs: [], outputs: [] } },
        insert: true,
      },
    ])
    const result = prepareMoveScriptFile(scriptContext(shared), {
      name: 'evaluate_dispatch',
      toPath: 'adapters/moved.js',
      currentSource: 'x\n',
      sourceGeneration: 30,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.command.edits.some(edit => edit.kind === 'delete')).toBe(false)
    expect(result.command.label).toContain('保留')
  })
})

describe('renameScriptEntry', () => {
  it('只改清单 entry，并明说源码要自己改', () => {
    const result = prepareRenameScriptEntry(scriptContext(), { name: 'evaluate_dispatch', entry: 'judge' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.command.edits).toHaveLength(1)
    expect(result.command.label).toContain('源码里的函数名要你自己改')
    expect(applyTo(result, 'fh2-plugin.json', MANIFEST_TEXT).scripts[0].entry).toBe('judge')
  })

  it('拒绝非法标识符与 path+entry 撞车', () => {
    expect(prepareRenameScriptEntry(scriptContext(), { name: 'evaluate_dispatch', entry: '2bad' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('标识符') })
    expect(prepareRenameScriptEntry(scriptContext(), { name: 'evaluate_dispatch', entry: 'handle' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('没有变化') })
  })
})

describe('changeScriptIO', () => {
  it('改 I/O 声明', () => {
    const result = prepareChangeScriptIo(scriptContext(), {
      name: 'evaluate_dispatch',
      inputs: [{ name: 'eventId', type: 'string', required: true }, { name: 'hint', type: 'string' }],
      outputs: [{ name: 'decision', type: 'string' }, { name: 'waylineUuid', type: 'string' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(applyTo(result, 'fh2-plugin.json', MANIFEST_TEXT).scripts[0].io.inputs).toHaveLength(2)
  })

  it('删掉被引用的出参时先给影响清单', () => {
    const result = prepareChangeScriptIo(scriptContext(), {
      name: 'evaluate_dispatch',
      inputs: [{ name: 'eventId', type: 'string', required: true }],
      // 去掉 waylineUuid —— fly.inputs.waylineUuid 正引用它。
      outputs: [{ name: 'decision', type: 'string' }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.impacts).toHaveLength(1)
    expect(result.impacts![0]).toMatchObject({ stepId: 'fly', at: 'inputs.waylineUuid.from' })
  })

  it('force 之后放行', () => {
    expect(prepareChangeScriptIo(scriptContext(), {
      name: 'evaluate_dispatch',
      inputs: [],
      outputs: [{ name: 'decision', type: 'string' }],
      force: true,
    }).ok).toBe(true)
  })

  it('拒绝重名字段、空名与平台保留键', () => {
    const context = scriptContext()
    expect(prepareChangeScriptIo(context, {
      name: 'evaluate_dispatch',
      inputs: [{ name: 'a', type: 'string' }, { name: 'a', type: 'string' }],
      outputs: [],
      force: true,
    })).toMatchObject({ ok: false, reason: expect.stringContaining('重名') })
    expect(prepareChangeScriptIo(context, {
      name: 'evaluate_dispatch',
      inputs: [{ name: 'now', type: 'string' }],
      outputs: [],
      force: true,
    })).toMatchObject({ ok: false, reason: expect.stringContaining('保留键') })
    // script 是脚本寻址键（worker 的 addressingKeys），和 now / idempotencyKey 同档。
    expect(prepareChangeScriptIo(context, {
      name: 'evaluate_dispatch',
      inputs: [{ name: 'script', type: 'string' }],
      outputs: [],
      force: true,
    })).toMatchObject({ ok: false, reason: expect.stringContaining('保留键') })
  })

  /**
   * 嵌套成员必须能原样写回。
   *
   * ⚠️ 这条守的是一种**只丢约束、不报错**的失真：画布拿平铺模型读进来再写回去，
   * 手写的 fields 就没了，而没了之后 worker 的 projectValue 把整块原样放行 ——
   * 声明还在、约束消失，任何一侧都不会红。
   */
  it('嵌套 fields 原样写回，不被抹平', () => {
    const result = prepareChangeScriptIo(scriptContext(), {
      name: 'evaluate_dispatch',
      inputs: [{
        name: 'plan',
        type: 'object',
        required: true,
        fields: [
          { name: 'waylineUuid', type: 'string', required: true },
          { name: 'legs', type: 'array', fields: [{ name: 'lat', type: 'number' }] },
        ],
      }],
      outputs: [{ name: 'decision', type: 'string' }],
      force: true,
    })
    const io = applyTo(result, 'fh2-plugin.json', MANIFEST_TEXT).scripts[0].io
    expect(io.inputs[0].fields).toHaveLength(2)
    expect(io.inputs[0].fields[1].fields).toEqual([{ name: 'lat', type: 'number' }])
  })

  it('拒绝词表外的类型；词表为空时不判', () => {
    expect(prepareChangeScriptIo(scriptContext(), {
      name: 'evaluate_dispatch',
      inputs: [{ name: 'flag', type: 'bolean' }],
      outputs: [],
      force: true,
    })).toMatchObject({ ok: false, reason: expect.stringContaining('不在类型列表里') })

    // 取不到词表时一律不判：拿一份可能已漂移的枚举去拒，拒掉的是合法声明。
    const noVocabulary = { ...scriptContext(), catalog: { ...CATALOG, ioFieldTypes: [] } }
    expect(prepareChangeScriptIo(noVocabulary, {
      name: 'evaluate_dispatch',
      inputs: [{ name: 'flag', type: 'bolean' }],
      outputs: [],
      force: true,
    }).ok).toBe(true)
  })

  it('拒绝挂在标量上的 fields（平台对它是静默忽略）', () => {
    expect(prepareChangeScriptIo(scriptContext(), {
      name: 'evaluate_dispatch',
      inputs: [{ name: 'hint', type: 'string', fields: [{ name: 'x', type: 'string' }] }],
      outputs: [],
      force: true,
    })).toMatchObject({ ok: false, reason: expect.stringContaining('不能带嵌套成员') })
  })

  it('嵌套层里同样查重名与类型', () => {
    expect(prepareChangeScriptIo(scriptContext(), {
      name: 'evaluate_dispatch',
      inputs: [{ name: 'plan', type: 'object', fields: [{ name: 'a', type: 'string' }, { name: 'a', type: 'string' }] }],
      outputs: [],
      force: true,
    })).toMatchObject({ ok: false, reason: expect.stringContaining('重名') })
  })

  /** 出参「声明即必产」，worker 不读 required —— 剥掉，但要说一声。 */
  it('出参上的 required 被剥掉，并回一条 advisory', () => {
    const result = prepareChangeScriptIo(scriptContext(), {
      name: 'evaluate_dispatch',
      inputs: [],
      outputs: [{ name: 'decision', type: 'string', required: true }],
      force: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(applyTo(result, 'fh2-plugin.json', MANIFEST_TEXT).scripts[0].io.outputs[0])
      .toEqual({ name: 'decision', type: 'string' })
    expect(result.advisories?.some(item => item.at === 'io.outputs.decision')).toBe(true)
  })

  /**
   * ★★ 透传悬崖。`outputs: []` 是**透传**（脚本 return 什么都进黑板），
   * 声明第一个出参就翻成投影 —— 下游引用的其余键当场取不到值。
   *
   * ⚠️ 这一格最早是漏的：影响按「删掉的键」算，空集减去新集恒为空，
   * 于是一条影响都不报，用户点完保存什么都没发生，而接线已经死了。
   */
  it('从透传改成声明出参时，列出会取不到值的接线', () => {
    // 先把清单改成「没有出参声明」的样子。
    const passthrough = MANIFEST_TEXT.replace(
      /"outputs": \[[^\]]*\]/,
      '"outputs": []',
    )
    const context = {
      ...scriptContext(passthrough),
      // 词表也要同步成「没有出参声明」，否则 before 取错。
      catalog: {
        ...CATALOG,
        scripts: [{ ...CATALOG.scripts[0]!, outputs: [] }],
      },
    }
    const result = prepareChangeScriptIo(context, {
      name: 'evaluate_dispatch',
      inputs: [],
      // 只声明 decision —— fly 引用的 waylineUuid 不在其中。
      outputs: [{ name: 'decision', type: 'string' }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('原先没有出参声明')
    expect(result.reason).toContain('其余一律丢掉')
    expect(result.impacts).toHaveLength(1)
    expect(result.impacts![0]).toMatchObject({ stepId: 'fly', at: 'inputs.waylineUuid.from' })

    // force 之后放行 —— 拦的是「没看见就做了」，不是这件事本身。
    expect(prepareChangeScriptIo(context, {
      name: 'evaluate_dispatch',
      inputs: [],
      outputs: [{ name: 'decision', type: 'string' }],
      force: true,
    }).ok).toBe(true)
  })

  /** 反方向（清空出参声明）是**放宽**：原先声明的键照样 return 得出来，不该拦。 */
  it('清空出参声明不算破坏，但要提示回到了透传', () => {
    const result = prepareChangeScriptIo(scriptContext(), {
      name: 'evaluate_dispatch',
      inputs: [],
      outputs: [],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.advisories?.some(item => item.why.includes('原样输出'))).toBe(true)
  })
})

describe('所有命令的共同性质', () => {
  it('损坏的 JSON 一律拒，不产出「成功但什么都没改」的命令', () => {
    const broken = workflowContext('{ 这不是 JSON')
    expect(prepareAddStep(broken, { id: 'n', action: 'dispatch_mission' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('不是合法 JSON') })
    expect(prepareRemoveStep(broken, { id: 'fly', force: true }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('不是合法 JSON') })
    expect(prepareCreateScriptFunction(scriptContext('{ 坏'), { name: 'x', path: 'a.js' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('不是合法 JSON') })
  })

  it('前置一律带上 workspaceEpoch 与 knowledgeId', () => {
    const result = prepareAddStep(workflowContext(), { id: 'n', action: 'dispatch_mission' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.command.expected).toMatchObject({ workspaceEpoch: 1, knowledgeId: 'bpk-test' })
  })

  it('拒绝时的 reason 从不是空话', () => {
    const rejections = [
      prepareAddStep(workflowContext(), { id: 'fly', action: 'dispatch_mission' }),
      prepareRenameStep(workflowContext(), { from: 'ghost', to: 'x' }),
      prepareConnectDependency(workflowContext(), { from: 'fly', to: 'fly' }),
      prepareSetInput(workflowContext(), { stepId: 'ghost', key: 'a', mode: 'clear' }),
    ]
    for (const result of rejections) {
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.reason.length).toBeGreaterThan(6)
      expect(result.reason).not.toBe('操作失败')
    }
  })
})

describe('createScriptAndBind（P0-5：绑定已有节点共用同一条原子命令）', () => {
  it('bindExisting：建功能 + 只写该步的 inputs.script.const，不动其它接线', () => {
    const result = prepareCreateScriptAndBind(scriptContext(), {
      name: 'fresh_fn',
      path: 'adapters/fresh-fn.js',
      stepId: 'evaluate',
      bindExisting: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.command.edits.map(edit => `${edit.kind}:${edit.path}`)).toEqual([
      'modify:fh2-plugin.json',
      'create:adapters/fresh-fn.js',
      'modify:workflows/dispatch.json',
    ])
    // 绑定编辑只动 evaluate 的 inputs.script；eventId 接线原样保留。
    const bound = applyTo(result, 'workflows/dispatch.json', WORKFLOW_TEXT)
    const evaluate = (bound.steps as { id: string; inputs?: Record<string, unknown> }[])
      .find(step => step.id === 'evaluate')
    expect(evaluate?.inputs?.script).toEqual({ const: 'fresh_fn' })
    expect(evaluate?.inputs?.eventId).toEqual({ from: 'trigger.eventId' })
    expect(result.command.focus).toMatchObject({ stepId: 'evaluate' })
  })

  it('bindExisting：非脚本步被拒；不存在的步被拒；缺 bindExisting 时已存在 id 被拒', () => {
    const nonScript = prepareCreateScriptAndBind(scriptContext(), {
      name: 'x',
      path: 'adapters/x.js',
      stepId: 'fly',
      bindExisting: true,
    })
    expect(nonScript).toMatchObject({ ok: false })
    if (!nonScript.ok) expect(nonScript.reason).toContain('action')

    const absent = prepareCreateScriptAndBind(scriptContext(), {
      name: 'x',
      path: 'adapters/x.js',
      stepId: 'ghost',
      bindExisting: true,
    })
    expect(absent).toMatchObject({ ok: false })
    if (!absent.ok) expect(absent.reason).toContain('不存在')

    const dup = prepareCreateScriptAndBind(scriptContext(), {
      name: 'x',
      path: 'adapters/x.js',
      stepId: 'evaluate',
    })
    expect(dup).toMatchObject({ ok: false })
    if (!dup.ok) expect(dup.reason).toContain('已存在')
  })
})

describe('createWorkflow（P2-1 新建工作流向导命令）', () => {
  it('产出最小合法 JSON 的 create 编辑；焦点指向新文件', () => {
    const result = prepareCreateWorkflow({ workspaceEpoch: 1, knowledgeId: 'bpk-test' }, {
      path: 'workflows/patrol.json',
      name: '违停巡逻',
      description: '白天巡逻',
      axis: 'schedule',
      axisSpec: { intervalSec: 300 },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const edit = result.command.edits[0]!
    expect(edit.kind).toBe('create')
    if (edit.kind !== 'create') throw new Error('unreachable')
    const document = JSON.parse(edit.content) as Record<string, unknown>
    expect(document).toEqual({
      name: '违停巡逻',
      description: '白天巡逻',
      trigger: { schedule: { intervalSec: 300 } },
      steps: [],
    })
    expect(result.command.expected.documents).toEqual([])
    expect(result.command.focus).toEqual({ openPath: 'workflows/patrol.json' })
  })

  it('拒绝空名、非法路径与非 .json 扩展名', () => {
    const context = { workspaceEpoch: 1 }
    const cases: Parameters<typeof prepareCreateWorkflow>[1][] = [
      { path: 'workflows/x.json', name: '  ', axis: 'api', axisSpec: {} },
      { path: '/abs.json', name: 'x', axis: 'api', axisSpec: {} },
      { path: '../escape.json', name: 'x', axis: 'api', axisSpec: {} },
      { path: 'workflows/x.txt', name: 'x', axis: 'api', axisSpec: {} },
    ]
    for (const input of cases) {
      const result = prepareCreateWorkflow(context, input)
      expect(result).toMatchObject({ ok: false })
    }
  })
})
