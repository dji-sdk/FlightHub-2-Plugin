// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, h, nextTick, provide } from 'vue'
import type { Component } from 'vue'
import * as monaco from 'monaco-editor'
import { IDE_KEY } from '../composables/use-ide'
import type { IdeContext } from '../composables/use-ide'
import { pathToUri } from '../editor/document-store.js'
import NodePalette from '../features/workflow/components/NodePalette.vue'
import WorkflowInspector from '../features/workflow/components/WorkflowInspector.vue'
import EditorEmpty from './editor/EditorEmpty.vue'
import EditorTabs from './editor/EditorTabs.vue'
import FileTree from './tree/FileTree.vue'
import SideBar from './layout/SideBar.vue'
import StatusBar from './layout/StatusBar.vue'
import ProblemsList from './panel/ProblemsList.vue'

/**
 * 组件挂载测试：沿用仓内先例（裸 createApp + DOM 断言，不引 @vue/test-utils）。
 * IDE_KEY 注入动作桩，数据走真实 pinia store。
 */

const openFile = vi.fn()
const jumpTo = vi.fn()
const promptCreate = vi.fn()
const revealWorkflowNodeStub = vi.fn(async (_workflowPath: string, _nodeId: string, _inputKey?: string) => {})

/** 非冒泡 click：handler 都挂在本元素上，冒泡到 body 会触发 monaco 剪贴板监听的 happy-dom 假错误。 */
function clickElement (element: Element | undefined | null): void {
  element?.dispatchEvent(new MouseEvent('click', { bubbles: false }))
}

function stubContext (): IdeContext {
  return {
    start: vi.fn(),
    switchView: vi.fn(async () => {}),
    openFile: async path => openFile(path),
    closeFile: vi.fn(),
    saveActive: vi.fn(async () => {}),
    saveAll: vi.fn(async () => true),
    runPack: vi.fn(async () => {}),
    cancelTask: vi.fn(async () => {}),
    openWorkspacePath: vi.fn(async () => {}),
    trackInstallTask: vi.fn(),
    downloadArtifact: vi.fn(async () => {}),
    jumpTo: async (path, line, column) => jumpTo(path, line, column),
    revealWorkflowNode: async (workflowPath, nodeId, inputKey) =>
      revealWorkflowNodeStub(workflowPath, nodeId, inputKey),
    showTreeMenu: vi.fn(),
    promptCreate: async (kind, base) => promptCreate(kind, base),
    createTreeEntry: vi.fn(async () => true),
    renameTreeEntry: vi.fn(async () => true),
    moveTreeEntry: vi.fn(async () => true),
    refreshTree: vi.fn(async () => {}),
    loadTreeChildren: vi.fn(async () => {}),
    runValidate: vi.fn(async () => {}),
    toggleRun: vi.fn(async () => {}),
    openRunUrl: vi.fn(),
    openInCanvas: vi.fn(async () => {}),
  }
}

interface Mount {
  readonly root: HTMLElement;
  readonly unmount: () => void;
}

const mounts: Mount[] = []

/**
 * 挂载组件并让全局 active pinia 指向组件树用的同一个实例 ——
 * 测试里 useXStore() 与组件内 useXStore() 必须拿到同一份 store。
 */
function mountComponent (component: Component, props: Record<string, unknown> = {}): Mount {
  const pinia = createPinia()
  setActivePinia(pinia)
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({
    setup () {
      provide(IDE_KEY, stubContext())
      return () => h(component, props)
    },
  })
  app.use(pinia)
  app.mount(root)
  return { root, unmount: () => app.unmount() }
}

beforeEach(() => {
  openFile.mockReset()
  jumpTo.mockReset()
  promptCreate.mockReset()
  revealWorkflowNodeStub.mockReset()
})

afterEach(() => {
  for (const { unmount } of mounts.splice(0)) unmount()
  for (const model of monaco.editor.getModels()) model.dispose()
})

function mountTrack (component: Component, props?: Record<string, unknown>): Mount {
  const mounted = mountComponent(component, props)
  mounts.push(mounted)
  return mounted
}

describe('statusBar', () => {
  it('渲染消息/位置/连接态，并随 store 更新', async () => {
    const { root } = mountTrack(StatusBar)
    const { useStatusStore } = await import('../stores/status')
    const status = useStatusStore()
    expect(root.querySelector('#status-message')?.textContent).toBe('就绪')
    expect(root.querySelector('.statusbar-dot')?.classList.contains('connected')).toBe(false)

    status.set('出错了', true)
    status.setPosition('行 3，列 5')
    status.setConnected(true)
    await nextTick()
    expect(root.querySelector('#status-message')?.textContent).toBe('出错了')
    expect(root.querySelector('#status-position')?.textContent).toBe('行 3，列 5')
    expect(root.querySelector('.statusbar')?.classList.contains('error')).toBe(true)
    expect(root.querySelector('.statusbar-dot')?.classList.contains('connected')).toBe(true)
  })
})

describe('fileTree', () => {
  it('目录默认折叠，点击只展开下一层，文件点击打开', async () => {
    const { root } = mountTrack(FileTree)
    const { useFileTreeStore } = await import('../stores/file-tree')
    const tree = useFileTreeStore()
    tree.setTree([
      {
        name: 'src',
        path: 'src',
        kind: 'dir',
        children: [
          { name: 'nested', path: 'src/nested', kind: 'dir', children: [{ name: 'deep.ts', path: 'src/nested/deep.ts', kind: 'file' }] },
          { name: 'a.ts', path: 'src/a.ts', kind: 'file' },
        ],
      },
      { name: 'b.ts', path: 'b.ts', kind: 'file' },
    ], false)
    await nextTick()

    expect(root.querySelectorAll('.tree-row.tree-file')).toHaveLength(1)
    expect(root.querySelector('.tree-row[data-path="src"]')?.getAttribute('data-kind')).toBe('dir')

    clickElement(root.querySelector('.tree-row[data-path="src"]'))
    await nextTick()
    expect(tree.collapsed.has('src')).toBe(false)
    expect(tree.collapsed.has('src/nested')).toBe(true)
    expect(root.querySelectorAll('.tree-row.tree-file')).toHaveLength(2)
    expect(root.querySelector('.tree-row[data-path="src/nested/deep.ts"]')).toBeNull()

    clickElement(root.querySelector('.tree-row[data-path="src/nested"]'))
    await nextTick()
    expect(root.querySelectorAll('.tree-row.tree-file')).toHaveLength(3)

    clickElement(root.querySelector('.tree-row[data-path="src/a.ts"]'))
    expect(openFile).toHaveBeenCalledWith('src/a.ts')
  })

  it('活动文档高亮 + 空态 + 截断提示', async () => {
    const { root } = mountTrack(FileTree)
    const { useFileTreeStore } = await import('../stores/file-tree')
    const { useDocumentsStore } = await import('../stores/documents')
    const tree = useFileTreeStore()
    const documents = useDocumentsStore()

    expect(root.querySelector('.tree-empty')?.textContent?.trim()).toBe('工作区为空')

    tree.setTree([{ name: 'a.ts', path: 'a.ts', kind: 'file' }], true)
    documents.open('a.ts', 'x')
    await nextTick()
    expect(root.querySelector('.tree-row[data-path="a.ts"]')?.classList.contains('active')).toBe(true)
    expect(root.querySelector('.tree-truncated')?.textContent).toContain('已截断')
  })

  /** tab 切换 → 资源树 reveal：父目录自动展开 + 行滚动进可视区（nearest）。 */
  it('活动文档变化时自动展开父目录并滚动到该文件行', async () => {
    const { root } = mountTrack(FileTree)
    const { useFileTreeStore } = await import('../stores/file-tree')
    const { useDocumentsStore } = await import('../stores/documents')
    const tree = useFileTreeStore()
    const documents = useDocumentsStore()

    tree.setTree([
      {
        name: 'src',
        path: 'src',
        kind: 'dir',
        children: [
          { name: 'nested', path: 'src/nested', kind: 'dir', children: [{ name: 'deep.ts', path: 'src/nested/deep.ts', kind: 'file' }] },
        ],
      },
      { name: 'a.ts', path: 'a.ts', kind: 'file' },
    ], false)
    await nextTick()
    expect(root.querySelector('.tree-row[data-path="src/nested/deep.ts"]')).toBeNull()

    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView')
    documents.open('src/nested/deep.ts', 'x')
    await nextTick()
    await nextTick()

    expect(tree.collapsed.has('src')).toBe(false)
    expect(tree.collapsed.has('src/nested')).toBe(false)
    const row = root.querySelector('.tree-row[data-path="src/nested/deep.ts"]')
    expect(row?.classList.contains('active')).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    scrollIntoView.mockRestore()
  })

  /** 手动折叠当前文件父目录后切走再切回：重新展开并再次滚动；active 清空不触发。 */
  it('切回已折叠的活动文件会重新展开，关闭全部文档不触发滚动', async () => {
    const { root } = mountTrack(FileTree)
    const { useFileTreeStore } = await import('../stores/file-tree')
    const { useDocumentsStore } = await import('../stores/documents')
    const tree = useFileTreeStore()
    const documents = useDocumentsStore()

    tree.setTree([
      {
        name: 'src',
        path: 'src',
        kind: 'dir',
        children: [{ name: 'nested', path: 'src/nested', kind: 'dir', children: [{ name: 'deep.ts', path: 'src/nested/deep.ts', kind: 'file' }] }],
      },
      { name: 'a.ts', path: 'a.ts', kind: 'file' },
    ], false)
    documents.open('src/nested/deep.ts', 'x')
    await nextTick()
    await nextTick()
    documents.open('a.ts', 'x')
    await nextTick()
    await nextTick()
    expect(tree.collapsed.has('src')).toBe(false)

    tree.toggle('src')
    await nextTick()
    expect(tree.collapsed.has('src')).toBe(true)

    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView')
    documents.activate('src/nested/deep.ts')
    await nextTick()
    await nextTick()
    expect(tree.collapsed.has('src')).toBe(false)
    expect(root.querySelector('.tree-row[data-path="src/nested/deep.ts"]')).not.toBeNull()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })

    // 关闭 deep.ts 会回退激活 a.ts（此时才发生最后一次滚动）；
    // 关闭最后一个文档 → active 变 null：不滚动、不报错。
    documents.close('src/nested/deep.ts')
    await nextTick()
    await nextTick()
    scrollIntoView.mockClear()
    documents.close('a.ts')
    await nextTick()
    await nextTick()
    expect(documents.active).toBeNull()
    expect(scrollIntoView).not.toHaveBeenCalled()
    scrollIntoView.mockRestore()
  })
})

describe('sideBar', () => {
  it('顶部新建按钮不写死根目录，由 IDE 按活动文件解析位置', () => {
    const { root } = mountTrack(SideBar)
    clickElement(root.querySelector('#btn-new-file'))
    clickElement(root.querySelector('#btn-new-dir'))
    expect(promptCreate).toHaveBeenNthCalledWith(1, 'file', undefined)
    expect(promptCreate).toHaveBeenNthCalledWith(2, 'dir', undefined)
  })
})

describe('problemsList', () => {
  it('工作流问题点击走节点定位（P2-2），文件问题走 jumpTo；来源标签用任务语言', async () => {
    const { root } = mountTrack(ProblemsList)
    const { useProblemsStore } = await import('../stores/problems')
    const problems = useProblemsStore()
    problems.setProblems('workflow', [{
      origin: 'workflow',
      severity: 'error',
      path: 'workflows/a.json',
      line: 1,
      column: 1,
      code: 'R3_UNRESOLVABLE_REF',
      message: '[consume] 参数 eventId 的取值无法解析',
      source: 'workflow',
      target: { kind: 'workflow-node', workflowPath: 'workflows/a.json', nodeId: 'consume', inputKey: 'eventId' },
    }])
    await nextTick()
    const row = root.querySelector('.problem')
    expect(row?.querySelector('.problem-origin')?.textContent).toBe('工作流检查')
    expect(row?.getAttribute('data-node-id')).toBe('consume')

    clickElement(row)
    expect(revealWorkflowNodeStub).toHaveBeenCalledWith('workflows/a.json', 'consume', 'eventId')
  })

  it('双源渲染 + 计数 + 点击跳转', async () => {
    const { root } = mountTrack(ProblemsList)
    const { useProblemsStore } = await import('../stores/problems')
    const problems = useProblemsStore()

    expect(root.querySelector('.panel-empty')?.textContent?.trim()).toBe('未发现问题')

    problems.setApiProblems([{
      origin: 'api',
      severity: 'error',
      path: 'a.ts',
      line: 3,
      column: 1,
      code: 'X1',
      message: '坏了',
      hint: '看文档',
    }])
    problems.setEditorProblems([{
      origin: 'editor',
      severity: 'warning',
      path: 'b.ts',
      line: 1,
      column: 1,
      code: 'TS1',
      message: '小心',
    }])
    await nextTick()
    const rows = root.querySelectorAll('.problem')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.classList.contains('problem-error')).toBe(true)
    expect(rows[0]?.querySelector('.problem-hint')?.textContent).toContain('看文档')

    rows[0]?.querySelector('.problem-loc')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: false }))
    expect(jumpTo).toHaveBeenCalledWith('a.ts', 3, 1)
  })
})

describe('editorTabs', () => {
  it('openPaths 驱动 tab 渲染；dirty 圆点出现后 markSaved 消失', async () => {
    const { root } = mountTrack(EditorTabs)
    const { useDocumentsStore } = await import('../stores/documents')
    const documents = useDocumentsStore()
    await nextTick()

    expect(root.querySelectorAll('.tab')).toHaveLength(0)

    documents.open('a.ts', 'let a = 1')
    documents.open('b.ts', 'let b = 2')
    await nextTick()
    expect(root.querySelectorAll('.tab')).toHaveLength(2)
    expect(root.querySelector('.tab[data-path="b.ts"]')?.classList.contains('active')).toBe(true)

    const model = monaco.editor.getModel(pathToUri('b.ts'))
    model?.pushEditOperations([], [{ range: model.getFullModelRange(), text: 'let b = 3' }], () => null)
    model?.pushStackElement()
    await nextTick()
    expect(root.querySelector('.tab[data-path="b.ts"] .tab-close')?.classList.contains('tab-dirty')).toBe(true)

    documents.markSaved('b.ts', 'let b = 3', 'r1')
    await nextTick()
    expect(root.querySelector('.tab[data-path="b.ts"] .tab-close')?.classList.contains('tab-dirty')).toBe(false)
  })
})

describe('editorEmpty', () => {
  it('无活动文档时渲染占位页；打开文档后隐藏', async () => {
    const { root } = mountTrack(EditorEmpty)
    const { useDocumentsStore } = await import('../stores/documents')
    const documents = useDocumentsStore()
    await nextTick()

    expect(root.querySelector('.editor-empty')).not.toBeNull()
    expect(root.querySelector('.editor-empty-art')).not.toBeNull()
    expect(root.querySelector('.editor-empty-hint')?.textContent).toContain('资源管理器')

    documents.open('a.ts', 'let a = 1')
    await nextTick()
    expect(root.querySelector('.editor-empty')).toBeNull()

    documents.close('a.ts')
    await nextTick()
    expect(root.querySelector('.editor-empty')).not.toBeNull()
  })
})

describe('nodePalette', () => {
  it('词表不可用时降级提示，不渲染节点清单', async () => {
    const { root } = mountTrack(NodePalette)
    expect(root.querySelector('.wf-palette-empty')?.textContent).toContain('平台动作目录未加载')
    expect(root.querySelectorAll('.wf-palette-item')).toHaveLength(0)
  })

  /**
   * P1-1：目录分组（项目业务功能 / 平台动作 / 流程控制）、业务语言主标题 +
   * 机器副标题、业务功能条目可拖拽（携带 scriptId）。
   */
  it('有词表时按三组渲染；平台动作中文名为主标题、action 为副标题；业务功能可拖拽', async () => {
    const { root, unmount } = mountComponent(NodePalette)
    mounts.push({ root, unmount })
    const { useWorkflowResources } = await import('../features/workflow/resources')
    const { toCatalog } = await import('../features/workflow/catalog')
    const resources = useWorkflowResources()
    resources.catalog = toCatalog({
      fixedSteps: [
        {
          action: 'dispatch_mission',
          displayName: '下发飞行任务',
          kind: 'activity',
          owner: 'platform',
          nonIdempotent: true,
          capability: 'device.mission:execute',
          inputs: [],
          outputs: [],
        },
        { action: 'wait_signal', displayName: '等待人工信号', kind: 'await_signal', owner: 'platform', inputs: [], outputs: [] },
      ],
      scripts: [{
        id: 'evaluate_demo',
        description: '评估派遣方案',
        allowlist: ['egress:fetch', 'config:get'],
        inputs: [],
        outputs: [],
      }],
      triggerSeeds: {},
      runRoot: [],
      scriptAction: 'run_script',
      pluginActionPrefix: 'plugin.',
      stepStates: [],
      conditionOps: [],
      stepTriggers: [],
      grantableCaps: [],
      pluginManifestFound: true,
      pluginManifestPath: 'fh2-plugin.json',
      scriptLanguage: 'typescript',
      catalogSource: { kind: 'builtin-snapshot', revision: 'test' },
    })
    await nextTick()

    const groups = [...root.querySelectorAll('.wf-palette-group-title')].map(node => (node.textContent ?? '').trim())
    expect(groups).toContain('本工程的业务功能')
    expect(groups).toContain('平台动作')
    expect(groups).toContain('等待与回调')

    const scriptItem = root.querySelector('.wf-palette-item[data-script-id="evaluate_demo"]')
    expect(scriptItem).not.toBeNull()
    // 主标题 = 业务说明；副标题 = 稳定 ID。
    expect(scriptItem?.querySelector('.wf-palette-item-title')?.textContent).toBe('评估派遣方案')
    expect(scriptItem?.querySelector('.wf-palette-item-sub')?.textContent).toBe('evaluate_demo')

    const dispatchItem = [...root.querySelectorAll('.wf-palette-item')].find(
      item => item.getAttribute('data-script-id') === null && item.querySelector('.wf-palette-item-sub')?.textContent === 'dispatch_mission',
    )
    expect(dispatchItem?.querySelector('.wf-palette-item-title')?.textContent).toBe('下发飞行任务')

    // 能力徽标不进选择面（fixture 带 capability / allowlist，验证它们不被渲染）：
    // 平台动作的 host capability 与脚本的 allowlist 都不是拖入决策输入，
    // 选中节点后在检查器里查（配置期可追溯）。
    const badgeTexts = [...root.querySelectorAll('.wf-palette-item .wf-badge')]
      .map(badge => (badge.textContent ?? '').trim())
    expect(badgeTexts).not.toContain('device.mission:execute')
    expect(badgeTexts).not.toContain('egress:fetch')
    expect(badgeTexts).not.toContain('config:get')
    // 编排决策徽标保留：非幂等仍在。
    expect(badgeTexts).toContain('非幂等')

    // 通用 JS 脚本步骤入口常驻（不预选功能，点击/拖入后由选择框决定）。
    const scriptStepEntry = root.querySelector('.wf-palette-item[data-kind="script-step"]')
    expect(scriptStepEntry).not.toBeNull()
    expect((scriptStepEntry?.querySelector('.wf-palette-item-title')?.textContent ?? '').trim()).toBe('业务脚本步骤')
    expect((scriptStepEntry?.querySelector('.wf-palette-item-sub')?.textContent ?? '').trim()).toBe('run_script')

    // 拖拽事件源在业务功能条目上（携带 scriptId 的 drop 由画布侧处理）。
    expect(scriptItem?.classList.contains('disabled')).toBe(true) // 未载入工作流时禁用但可见
  })
})

describe('workflowInspector', () => {
  const WORKFLOW = `{
    "name": "f",
    "trigger": { "api": { "seed": ["eventId"] } },
    "steps": [
      { "id": "evaluate", "action": "run_script",
        "inputs": { "script": { "const": "evaluate_dispatch" }, "eventId": { "from": "trigger.eventId" } } },
      { "id": "fly", "action": "dispatch_mission", "needs": ["evaluate"],
        "when": { "field": "trigger.eventId", "op": "present" },
        "inputs": { "waylineUuid": { "from": "steps.evaluate.waylineUuid" } } },
      { "id": "gate", "action": "wait_signal", "needs": ["evaluate"],
        "await": { "signal": "supervisor_ack", "timeoutSec": 60 } }
    ]
  }`

  /**
   * 检查器需要的最小 store 状态：不经 bindDocuments（那是会话链路），
   * 直接喂 document/model/context/selectedId —— 与 refresh() 的产物同构。
   */
  async function mountInspectorWith (selectedId: string): Promise<HTMLElement> {
    const { root } = mountTrack(WorkflowInspector)
    const { useWorkflowResources } = await import('../features/workflow/resources')
    const { toCatalog } = await import('../features/workflow/catalog')
    const { useWorkflowStore } = await import('../features/workflow/store')
    const { buildContext } = await import('../features/workflow/semantics')
    const { parseWorkflowDocument, toGraph } = await import('../../../src/workflow/core/model.js')

    const catalog = toCatalog({
      fixedSteps: [
        {
          action: 'dispatch_mission',
          displayName: '下发飞行任务',
          kind: 'activity',
          owner: 'platform',
          inputs: [{ name: 'waylineUuid', type: 'id', required: true }, { name: 'lat', type: 'number' }],
          outputs: [{ name: 'missionId', type: 'id' }],
        },
        {
          action: 'wait_signal',
          displayName: '等待人工信号',
          kind: 'await_signal',
          owner: 'platform',
          inputs: [],
          outputs: [],
        },
      ],
      scripts: [{ id: 'evaluate_dispatch', description: '评估派遣方案', allowlist: [], inputs: [], outputs: [] }],
      triggerSeeds: { api: { available: ['eventId'], notGuaranteed: [] } },
      runRoot: [],
      scriptAction: 'run_script',
      pluginActionPrefix: 'plugin.',
      stepStates: [],
      conditionOps: ['eq', 'present'],
      stepTriggers: [],
      grantableCaps: [],
      pluginManifestFound: true,
      pluginManifestPath: 'fh2-plugin.json',
      scriptLanguage: 'javascript',
      catalogSource: { kind: 'builtin-snapshot', revision: 'test' },
    })
    useWorkflowResources().catalog = catalog

    const workflow = useWorkflowStore()
    const parsed = parseWorkflowDocument(WORKFLOW)
    if (!parsed.ok) throw new Error(parsed.message)
    workflow.document = parsed.document
    workflow.model = toGraph(parsed.document)
    workflow.context = buildContext(catalog, parsed.document)
    workflow.selectedId = selectedId
    await nextTick()
    await nextTick()
    return root
  }

  function tabsOf (root: HTMLElement): readonly string[] {
    return [...root.querySelectorAll('.wf-tab')].map(node => (node.textContent ?? '').trim())
  }

  /**
   * 执行内容选择器的选项契约：平台动作「中文名 —— 机器 action」；
   * 业务功能选项**任何步骤都可选**（切换后由业务功能选择器指定脚本）。
   */
  it('执行内容：平台动作显示「中文名 —— action」；非脚本步骤也能选业务功能调用', async () => {
    const root = await mountInspectorWith('fly') // fly 是 dispatch_mission（非脚本步骤）

    const platformOptions = [...root.querySelectorAll('optgroup[label="平台动作"] option')]
      .map(option => (option.textContent ?? '').trim())
    expect(platformOptions).toContain('下发飞行任务 —— dispatch_mission')

    // 回归（曾只在 run_script 步上出现）：平台动作步骤也能切到业务功能调用。
    const scriptOption = root.querySelector('optgroup[label="业务功能"] option')
    expect(scriptOption).not.toBeNull()
    expect(scriptOption?.getAttribute('value')).toBe('run_script')
    expect((scriptOption?.textContent ?? '').trim()).toBe('调用业务功能 —— run_script')
  })

  it('输入来源三态：from 档文案为「引用上游数据」', async () => {
    const root = await mountInspectorWith('fly')
    const row = root.querySelector('.wf-input-row[data-input-key="waylineUuid"]')
    expect(row).not.toBeNull()
    expect((row?.querySelector('.wf-input-mode option[value="from"]')?.textContent ?? '').trim())
      .toBe('引用上游数据')
  })

  /**
   * 页签按节点能力裁剪：等待与回调只属于挂起能力的步 —— await_signal 专属
   * 动作（wait_signal）或已声明挂起段的步；普通 activity / 无挂起段的
   * run_script 不显示。
   */
  it('等待与回调页签：wait_signal 步显示；activity 与无挂起段的 run_script 步不显示', async () => {
    const activityRoot = await mountInspectorWith('fly') // dispatch_mission（activity）
    expect(tabsOf(activityRoot)).toEqual(['步骤设置', '执行条件', '技术详情'])

    const gateRoot = await mountInspectorWith('gate') // wait_signal + await
    expect(tabsOf(gateRoot)).toContain('等待与回调')

    // run_script 无挂起段 → 不显示（与真实流程的用法一致）。
    const scriptRoot = await mountInspectorWith('evaluate')
    expect(tabsOf(scriptRoot)).not.toContain('等待与回调')
  })

  it('执行条件：删除条件按钮移除 when 段，恢复「总是执行」', async () => {
    const root = await mountInspectorWith('fly') // fixture 里 fly 带 when

    // 切到执行条件页签：有 when 时不显示「当前没有条件」，出现「删除条件」按钮。
    clickElement([...root.querySelectorAll('.wf-tab')].find(
      tab => (tab.textContent ?? '').trim() === '执行条件',
    ))
    await nextTick()
    expect(root.textContent).not.toContain('当前没有条件')
    const removeButton = [...root.querySelectorAll('button')].find(
      button => (button.textContent ?? '').trim() === '删除条件',
    )
    expect(removeButton).toBeDefined()

    clickElement(removeButton)
    await nextTick()
    await nextTick()
    // when 段被删除：UI 回到「当前没有条件（总是执行）」，文档里 fly 不再有 when。
    expect(root.textContent).toContain('当前没有条件（总是执行）')
    const { useWorkflowStore } = await import('../features/workflow/store')
    const fly = useWorkflowStore().rawStepById('fly')
    expect(fly !== undefined && 'when' in fly).toBe(false)
  })
})
