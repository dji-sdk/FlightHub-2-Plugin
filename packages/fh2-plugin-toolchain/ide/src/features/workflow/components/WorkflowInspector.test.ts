// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, nextTick } from 'vue'
import * as monaco from 'monaco-editor'
import { ideApi } from '../../../api/client.js'
import { createDocumentService } from '../../../editor/document-service.js'
import type { SaveRequestItem } from '../../../editor/save-coordinator.js'
import { useDocumentsStore } from '../../../stores/documents.js'
import { useStatusStore } from '../../../stores/status.js'
import { toCatalog } from '../catalog.js'
import { useWorkflowResources } from '../resources.js'
import { useWorkflowStore } from '../store.js'
import WorkflowInspector from './WorkflowInspector.vue'

const apps: ReturnType<typeof createApp>[] = []
const workflows: ReturnType<typeof useWorkflowStore>[] = []

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  for (const workflow of workflows.splice(0)) workflow.reset()
  for (const model of monaco.editor.getModels()) model.dispose()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function source (value = 'old'): string {
  return JSON.stringify({
    name: 'example',
    trigger: { api: { seed: [] } },
    steps: [{ id: 'step1', action: 'example', inputs: { record_key: { const: value } } }],
  }, null, 2)
}

function setCatalog (): void {
  useWorkflowResources().catalog = toCatalog({
    fixedSteps: [{
      action: 'example',
      displayName: '测试步骤',
      kind: 'activity',
      owner: 'platform',
      inputs: [{ name: 'record_key', type: 'string', required: true }],
      outputs: [],
    }],
    scripts: [],
    triggerSeeds: { api: { available: [], notGuaranteed: [] } },
    runRoot: [],
    scriptAction: 'run_script',
    pluginActionPrefix: 'plugin.',
    stepStates: [],
    conditionOps: [],
    stepTriggers: [],
    grantableCaps: [],
    pluginManifestFound: false,
    pluginManifestPath: '',
    scriptLanguage: 'javascript',
    catalogSource: { kind: 'builtin-snapshot', revision: 'test' },
  })
}

async function fixture (workspaceRoot = '/review-workspace') {
  const pinia = createPinia()
  setActivePinia(pinia)
  const documents = useDocumentsStore()
  documents.setWorkspaceRoot(workspaceRoot)
  setCatalog()
  vi.spyOn(useWorkflowResources(), 'refreshCatalog').mockResolvedValue(undefined)
  const workflow = useWorkflowStore()
  workflows.push(workflow)
  const service = createDocumentService(documents, () => 'session')
  workflow.bindDocuments(service)
  documents.open('workflows/a.json', source(), 'rev-a')
  await workflow.load('workflows/a.json')
  workflow.select('step1')
  const calls: SaveRequestItem[][] = []
  vi.spyOn(ideApi, 'save').mockImplementation(async (items) => {
    calls.push(items.map(item => ({ ...item })))
    return {
      ok: true,
      partial: false,
      items: items.map(item => ({ path: item.path, kind: item.kind, ok: true, revision: 'saved-rev' })),
    }
  })
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(WorkflowInspector)
  app.use(pinia)
  app.mount(root)
  apps.push(app)
  await nextTick()
  function input (): HTMLInputElement {
    const element = root.querySelector<HTMLInputElement>('.wf-input-row[data-input-key="record_key"] input')
    expect(element).not.toBeNull()
    return element!
  }
  function value (path = 'workflows/a.json'): string {
    return JSON.parse(documents.contentOf(path)!).steps[0].inputs.record_key.const
  }
  return { workflow, documents, service, calls, input, value, status: useStatusStore() }
}

function typeOnly (input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('workflowInspector 保存真实提交链', () => {
  it.each(['/review-workspace', 'C:\\研发 测试\\workspace'])('输入不失焦时第一次保存就提交新值（%s）', async (root) => {
    const f = await fixture(root)
    typeOnly(f.input(), 'new')
    expect(f.documents.isDirty('workflows/a.json')).toBe(false)
    await f.workflow.save()
    expect(f.calls).toHaveLength(1)
    expect(JSON.parse(f.calls[0]![0]!.content!).steps[0].inputs.record_key.const).toBe('new')
    expect(f.value()).toBe('new')
    expect(f.documents.isDirty('workflows/a.json')).toBe(false)
    expect(f.status.message).toContain('保存完成')
  })

  it('文件已脏时也保存输入框新值，而不是前一版内容', async () => {
    const f = await fixture()
    f.documents.applyEdit('workflows/a.json', source('dirty-old'), f.documents.modelVersion('workflows/a.json')!)
    await nextTick()
    typeOnly(f.input(), 'new')
    await f.workflow.save()
    expect(f.calls).toHaveLength(1)
    expect(JSON.parse(f.calls[0]![0]!.content!).steps[0].inputs.record_key.const).toBe('new')
    expect(f.documents.isDirty('workflows/a.json')).toBe(false)
  })

  it('change/blur 后立即保存与并发保存仍只发一次请求', async () => {
    const f = await fixture()
    const input = f.input()
    typeOnly(input, 'new')
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.dispatchEvent(new Event('blur'))
    await Promise.all([f.workflow.save(), f.workflow.save()])
    expect(f.calls).toHaveLength(1)
    expect(f.value()).toBe('new')
    expect(f.documents.isDirty('workflows/a.json')).toBe(false)
  })

  it('真实焦点保存后正常失焦，不回退新值或再次产生待保存内容', async () => {
    const f = await fixture()
    const input = f.input()
    input.focus()
    typeOnly(input, 'new')
    await f.workflow.save()
    input.blur()
    await Promise.resolve()
    await nextTick()
    await f.workflow.save()
    expect(f.calls).toHaveLength(1)
    expect(f.value()).toBe('new')
    expect(f.documents.isDirty('workflows/a.json')).toBe(false)
  })

  it('保存关联流程仍提交草稿，不保存无关流程', async () => {
    const f = await fixture()
    f.documents.open('workflows/b.json', source('b-original'), 'rev-b')
    f.documents.applyEdit('workflows/b.json', source('b-dirty'), f.documents.modelVersion('workflows/b.json')!)
    typeOnly(f.input(), 'new')
    await f.workflow.saveRelated()
    expect(f.calls[0]!.map(item => item.path)).toEqual(['workflows/a.json'])
    expect(f.documents.isDirty('workflows/b.json')).toBe(true)
  })

  it('同工作区切到同名步骤的另一个流程，不带入旧草稿', async () => {
    const f = await fixture()
    typeOnly(f.input(), 'draft-from-a')
    f.documents.open('workflows/b.json', source('b-original'), 'rev-b')
    await f.workflow.load('workflows/b.json')
    f.workflow.select('step1')
    await f.workflow.save()
    expect(f.calls).toHaveLength(0)
    expect(f.value('workflows/b.json')).toBe('b-original')
    expect(f.documents.isDirty('workflows/b.json')).toBe(false)
  })

  it('节点切换后的迟到 change/blur 不把旧输入写入新节点', async () => {
    const f = await fixture()
    const raw = JSON.parse(source('a-old'))
    raw.steps.push({ id: 'step2', action: 'example', inputs: { record_key: { const: 'b-old' } } })
    f.documents.applyEdit('workflows/a.json', JSON.stringify(raw), f.documents.modelVersion('workflows/a.json')!)
    await nextTick()
    const oldInput = f.input()
    typeOnly(oldInput, 'a-new')
    f.workflow.select('step2')
    oldInput.dispatchEvent(new Event('change', { bubbles: true }))
    oldInput.dispatchEvent(new Event('blur'))
    await Promise.resolve()
    await nextTick()
    const values = JSON.parse(f.documents.contentOf('workflows/a.json')!).steps
      .map((step: { inputs: { record_key: { const: string } } }) => step.inputs.record_key.const)
    expect(values).toEqual(['a-old', 'b-old'])
    typeOnly(f.input(), 'b-new')
    await f.workflow.save()
    expect(JSON.parse(f.calls[0]![0]!.content!).steps[1].inputs.record_key.const).toBe('b-new')
  })

  it('新流程读取期间重新编辑旧节点，实际切换后仍清掉旧草稿', async () => {
    const f = await fixture()
    f.documents.open('workflows/b.json', source('b-original'), 'rev-b')
    const open = f.service.open
    let finish!: () => void
    const completion = new Promise<void>((resolve) => {
      finish = resolve
    })
    vi.spyOn(f.service, 'open').mockImplementation(async (path) => {
      if (path === 'workflows/b.json') await completion
      await open(path)
    })
    const loading = f.workflow.load('workflows/b.json')
    f.workflow.select('step1')
    await nextTick()
    typeOnly(f.input(), 'draft-during-switch')
    finish()
    await loading
    f.workflow.select('step1')
    await f.workflow.save()
    expect(f.calls).toHaveLength(0)
    expect(f.value('workflows/b.json')).toBe('b-original')
  })

  it('工作区 reset 后立即载入同路径同名步骤，不写入旧草稿', async () => {
    const f = await fixture()
    typeOnly(f.input(), 'draft-from-a')
    f.workflow.reset()
    f.documents.reset()
    f.documents.setWorkspaceRoot('C:\\另一个 工作区')
    setCatalog()
    f.documents.open('workflows/a.json', source('b-original'), 'rev-b')
    await f.workflow.load('workflows/a.json')
    f.workflow.select('step1')
    await f.workflow.save()
    expect(f.calls).toHaveLength(0)
    expect(f.value()).toBe('b-original')
    await nextTick()
    typeOnly(f.input(), 'b-new')
    await f.workflow.save()
    expect(f.calls).toHaveLength(1)
    expect(f.value()).toBe('b-new')
    expect(f.documents.isDirty('workflows/a.json')).toBe(false)
  })

  it('重新绑定文档服务使旧草稿过期，新草稿仍可保存', async () => {
    const f = await fixture()
    typeOnly(f.input(), 'draft-from-a')
    f.workflow.bindDocuments(createDocumentService(f.documents, () => 'new-session'))
    await f.workflow.load('workflows/a.json')
    f.workflow.select('step1')
    await f.workflow.save()
    expect(f.calls).toHaveLength(0)
    expect(f.value()).toBe('old')
    await nextTick()
    typeOnly(f.input(), 'new')
    await f.workflow.save()
    expect(f.calls).toHaveLength(1)
    expect(f.value()).toBe('new')
  })

  it('等待草稿期间工作区切换，旧保存不提交新工作区的改动', async () => {
    const f = await fixture()
    typeOnly(f.input(), 'a-new')
    let finish!: () => void
    let entered!: () => void
    const completion = new Promise<void>((resolve) => {
      finish = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.workflow.registerDraftFlush(async () => {
      entered()
      await completion
    })
    const saving = f.workflow.save()
    await started
    f.workflow.reset()
    f.documents.reset()
    f.documents.setWorkspaceRoot('C:\\新的 工作区')
    setCatalog()
    f.documents.open('workflows/a.json', source('b-original'), 'rev-b')
    f.documents.applyEdit('workflows/a.json', source('b-pending'), f.documents.modelVersion('workflows/a.json')!)
    finish()
    await saving
    expect(f.calls).toHaveLength(0)
    expect(f.value()).toBe('b-pending')
    expect(f.documents.isDirty('workflows/a.json')).toBe(true)
    expect(f.status.message).toContain('已停止旧保存')
  })
})
