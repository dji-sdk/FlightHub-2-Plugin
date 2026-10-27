// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { afterEach, describe, expect, it } from 'vitest'
import * as monaco from 'monaco-editor'
import type { ActionCatalog } from '../../../../src/workflow/core/catalog.js'
import {
  prepareAddStep,
  prepareConnectDependency,
  prepareRemoveStep,
  prepareSetInput,
} from '../../../../src/workflow/core/step-commands.js'
import {
  prepareCreateScriptAndBind,
  prepareRenameScriptId,
} from '../../../../src/workflow/core/script-commands.js'
import { DocumentStore } from '../../editor/document-store.js'
import { WorkflowSession } from './session.js'

/**
 * 会话的用例：意图 → 命令 → 原子应用 这条通道。
 *
 * ★★ 重点在三种结果必须分得开：
 *   applied  已落内存（可能带 advisories：还有活儿但本次管不到）
 *   rejected 命令自己拒了（reason / impacts），**重试没用**，要用户先决定
 *   stale    前置失效（文档被改过 / 切了工作区），**重算后重试才有意义**
 * 三者合成一个「失败」的话，UI 只能给一句「操作失败」，而用户不知道下一步做什么。
 */

const CATALOG: ActionCatalog = {
  available: true,
  scriptLanguage: 'javascript',
  fixedSteps: [
    {
      action: 'dispatch_mission',
      kind: 'activity',
      owner: 'platform',
      nonIdempotent: true,
      inputs: [{ name: 'waylineUuid', type: 'id', required: true }, { name: 'lat', type: 'number' }],
      outputs: [{ name: 'missionId', type: 'id' }],
    },
  ],
  scripts: [{
    id: 'evaluate_dispatch',
    path: 'adapters/evaluate.js',
    filePath: 'adapters/evaluate.js',
    allowlist: [],
    inputs: [{ name: 'eventId', type: 'id', required: true }],
    outputs: [{ name: 'waylineUuid', type: 'id' }],
  }],
  triggerSeeds: { api: { available: [], notGuaranteed: [] } },
  runRoot: ['now', 'idempotencyKey', 'intervalSec'],
  scriptAction: 'run_script',
  pluginActionPrefix: 'plugin.',
  stepStates: ['succeeded', 'failed', 'skipped', 'timedOut', 'interrupted'],
  conditionOps: ['eq', 'ne', 'in', 'exists', 'blank', 'present'],
  stepTriggers: ['allSucceeded', 'allDone'],
  grantableCaps: ['data:read'],
  ioFieldTypes: ['string', 'number', 'bool', 'object', 'array'],
  pluginManifestFound: true,
  pluginManifestPath: 'fh2-plugin.json',
  source: { kind: 'knowledge', revision: 'bpk-test' },
}

const WORKFLOW = `{
  "name": "f",
  "trigger": { "api": { "seed": ["eventId"] } },
  "steps": [
    { "id": "evaluate", "action": "run_script",
      "inputs": { "script": { "const": "evaluate_dispatch" }, "eventId": { "from": "trigger.eventId" } } },
    { "id": "fly", "action": "dispatch_mission", "needs": ["evaluate"],
      "inputs": { "waylineUuid": { "from": "steps.evaluate.waylineUuid" } } }
  ]
}
`

const MANIFEST = `{
  "pluginId": "demo",
  "scripts": [
    { "name": "evaluate_dispatch", "path": "adapters/evaluate.js", "allowlist": [],
      "io": { "inputs": [{ "name": "eventId", "type": "id", "required": true }],
              "outputs": [{ "name": "waylineUuid", "type": "id" }] } }
  ]
}
`

const stores: DocumentStore[] = []

function setup (): { documents: DocumentStore; session: WorkflowSession } {
  const documents = new DocumentStore()
  documents.setWorkspaceRoot('/repo')
  stores.push(documents)
  documents.open('workflows/f.json', WORKFLOW, 'rev-f')
  documents.open('fh2-plugin.json', MANIFEST, 'rev-m')
  const session = new WorkflowSession({
    // ⓘ 用例里直接喂 DocumentStore；生产里喂的是包着它的 DocumentService。
    //   两者都满足 SessionDocuments 这个最小面（workspaceEpoch 在 store 上是 getter，
    //   故这里包一层函数 —— 这一点差异正是 SessionDocuments 收窄成结构类型的价值）。
    documents: {
      snapshot: paths => documents.snapshot(paths),
      applyPrepared: command => documents.applyPrepared(command),
      generationOf: path => documents.generationOf(path),
      workspaceEpoch: () => documents.workspaceEpoch,
    },
    catalog: () => CATALOG,
    knowledgeId: () => 'bpk-test',
  })
  session.setPath('workflows/f.json')
  return { documents, session }
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    for (const path of [...store.openPaths]) store.close(path, true)
  }
  for (const model of monaco.editor.getModels()) model.dispose()
})

describe('workflowSession 上下文构造', () => {
  it('text 与 generation 来自同一次快照', () => {
    const { documents, session } = setup()
    const context = session.workflowContext()!
    expect(context.workflow.text).toBe(WORKFLOW)
    expect(context.workflow.generation).toBe(documents.generationOf('workflows/f.json'))
    expect(context.workspaceEpoch).toBe(documents.workspaceEpoch)
    expect(context.knowledgeId).toBe('bpk-test')
  })

  it('没选文件时回 null（而不是拿一个空文档去算命令）', () => {
    const { session } = setup()
    session.setPath(null)
    expect(session.workflowContext()).toBeNull()
  })

  it('脚本上下文同时带清单与当前流程', () => {
    const { session } = setup()
    const context = session.scriptContext()!
    expect(context.manifest.path).toBe('fh2-plugin.json')
    expect(context.workflow?.path).toBe('workflows/f.json')
  })
})

describe('workflowSession.dispatch', () => {
  it('applied：改动落进文档，焦点跟着命令走', async () => {
    const { documents, session } = setup()
    const outcome = await session.dispatch(() =>
      prepareAddStep(session.workflowContext()!, { id: 'notice', action: 'dispatch_mission', upstream: 'fly' }))

    expect(outcome.status).toBe('applied')
    expect(documents.contentOf('workflows/f.json')).toContain('"id": "notice"')
    expect(session.selectedNodeId).toBe('notice')
  })

  it('rejected：命令自己拒了，文档一个字节没动', async () => {
    const { documents, session } = setup()
    const before = documents.contentOf('workflows/f.json')
    const outcome = await session.dispatch(() =>
      prepareAddStep(session.workflowContext()!, { id: 'fly', action: 'dispatch_mission' }))

    expect(outcome.status).toBe('rejected')
    if (outcome.status !== 'rejected') throw new Error('unreachable')
    expect(outcome.reason).toContain('已存在')
    expect(documents.contentOf('workflows/f.json')).toBe(before)
  })

  it('rejected 带 impacts：把受影响的地方交给 UI，不自动改', async () => {
    const { session } = setup()
    const outcome = await session.dispatch(() =>
      prepareRemoveStep(session.workflowContext()!, { id: 'evaluate' }))

    expect(outcome.status).toBe('rejected')
    if (outcome.status !== 'rejected') throw new Error('unreachable')
    expect(outcome.impacts?.length).toBeGreaterThan(0)
  })

  it('stale：prepare 之后文档被改过 → 报可重试，且不覆盖用户内容', async () => {
    const { documents, session } = setup()
    const context = session.workflowContext()!

    const outcome = await session.dispatch(() => {
      // 模拟「算好命令之后，用户在 Monaco 里又敲了一下」。
      documents.applyEdit('workflows/f.json', `${WORKFLOW}\n`, documents.modelVersion('workflows/f.json')!)
      return prepareAddStep(context, { id: 'notice', action: 'dispatch_mission' })
    })

    expect(outcome.status).toBe('stale')
    expect(documents.contentOf('workflows/f.json')).toBe(`${WORKFLOW}\n`)
  })

  it('切工作区之后旧上下文算出的命令也是 stale', async () => {
    const { documents, session } = setup()
    const context = session.workflowContext()!
    const prepared = prepareAddStep(context, { id: 'notice', action: 'dispatch_mission' })
    documents.setWorkspaceRoot('/other')

    const outcome = await session.dispatch(() => prepared)
    expect(outcome.status).toBe('stale')
  })

  it('invalid（命令算错了）报 rejected 而不是 stale —— 重试没用', async () => {
    const { documents, session } = setup()
    // 把文档改成非 JSON，让命令的编辑算不出来。
    documents.applyEdit('workflows/f.json', '不是 JSON', documents.modelVersion('workflows/f.json')!)
    const outcome = await session.dispatch(() =>
      prepareAddStep(session.workflowContext()!, { id: 'n', action: 'dispatch_mission' }))
    expect(outcome.status).toBe('rejected')
  })

  it('跨文件命令一次落两个文件，并带上 focus.openPath', async () => {
    const { documents, session } = setup()
    const outcome = await session.dispatch(() =>
      prepareCreateScriptAndBind(session.scriptContext()!, {
        name: 'build_notice',
        path: 'adapters/build-notice.js',
        stepId: 'notice',
        upstream: 'fly',
      }))

    expect(outcome.status).toBe('applied')
    if (outcome.status !== 'applied') throw new Error('unreachable')
    expect(outcome.focus?.openPath).toBe('adapters/build-notice.js')
    expect(documents.contentOf('fh2-plugin.json')).toContain('build_notice')
    expect(documents.contentOf('workflows/f.json')).toContain('"id": "notice"')
    // 新建的 JS 成了虚拟文件（dirty，待保存）。
    expect(documents.snapshot(['adapters/build-notice.js'])[0]).toMatchObject({
      existsOnDisk: false,
      dirty: true,
    })
  })

  it('advisories 原样交给 UI（本次管不到的活儿不能丢）', async () => {
    const { session } = setup()
    const outcome = await session.dispatch(() =>
      prepareRenameScriptId(session.scriptContext()!, {
        from: 'evaluate_dispatch',
        to: 'judge_dispatch',
        otherFlows: ['workflows/other.json'],
      }))

    expect(outcome.status).toBe('applied')
    if (outcome.status !== 'applied') throw new Error('unreachable')
    expect(outcome.advisories).toHaveLength(1)
  })

  it('连线走同一条通道，环被拒', async () => {
    const { session } = setup()
    const outcome = await session.dispatch(() =>
      prepareConnectDependency(session.workflowContext()!, { from: 'fly', to: 'evaluate' }))
    expect(outcome.status).toBe('rejected')
    if (outcome.status !== 'rejected') throw new Error('unreachable')
    expect(outcome.reason).toContain('环')
  })
})

describe('workflowSession.bindingStatuses', () => {
  it('必填未接的节点是 incomplete-binding，其余 locally-complete', async () => {
    const { session } = setup()
    // 加一个必填参数没接的节点。
    await session.dispatch(() =>
      prepareAddStep(session.workflowContext()!, { id: 'bare', action: 'dispatch_mission' }))

    const byNode = Object.fromEntries(session.bindingStatuses().map(status => [status.nodeId, status.state]))
    expect(byNode.bare).toBe('incomplete-binding')
    expect(byNode.fly).toBe('locally-complete')
  })

  it('接到闭包外/解不开的来源是 invalid-binding', async () => {
    const { documents, session } = setup()
    // 直接写一条指向不存在步骤的接线（绕过命令校验，模拟手写 JSON）。
    documents.applyEdit(
      'workflows/f.json',
      WORKFLOW.replace('"from": "steps.evaluate.waylineUuid"', '"from": "steps.ghost.x"'),
      documents.modelVersion('workflows/f.json')!,
    )
    const byNode = Object.fromEntries(session.bindingStatuses().map(status => [status.nodeId, status.state]))
    expect(byNode.fly).toBe('invalid-binding')
  })

  it('半截 JSON 时回空数组，不抛（编辑中是常态）', () => {
    const { documents, session } = setup()
    documents.applyEdit('workflows/f.json', '{ "steps": [', documents.modelVersion('workflows/f.json')!)
    expect(() => session.bindingStatuses()).not.toThrow()
    expect(session.bindingStatuses()).toEqual([])
  })

  it('设置入参后节点变成 locally-complete', async () => {
    const { session } = setup()
    await session.dispatch(() =>
      prepareAddStep(session.workflowContext()!, { id: 'bare', action: 'dispatch_mission', upstream: 'evaluate' }))
    expect(Object.fromEntries(session.bindingStatuses().map(s => [s.nodeId, s.state])).bare)
      .toBe('incomplete-binding')

    await session.dispatch(() =>
      prepareSetInput(session.workflowContext()!, {
        stepId: 'bare',
        key: 'waylineUuid',
        mode: 'from',
        value: 'steps.evaluate.waylineUuid',
      }))
    expect(Object.fromEntries(session.bindingStatuses().map(s => [s.nodeId, s.state])).bare)
      .toBe('locally-complete')
  })
})
