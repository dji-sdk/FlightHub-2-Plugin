// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { DocumentService } from '../../editor/document-service.js'
import { showContextMenu } from '../../services/context-menu.js'
import type { MenuEntry } from '../../services/context-menu.js'
import { showDialog } from '../../services/dialog.js'
import {
  TRIGGER_NODE_ID,
  hasStep,
  setStepText,
  setTriggerDescription,
  toGraph,
} from '../../../../src/workflow/core/model.js'
import type { WorkflowDocument, WorkflowGraph, WorkflowNode } from '../../../../src/workflow/core/model.js'
import {
  ensureStepWhen,
  removeStepWhen,
  setStepAwait,
  setStepNumber,
  setStepSectionField,
  setStepTrigger,
  setStepWhenField,
  setTriggerAxis,
  setTriggerField,
} from '../../../../src/workflow/core/inputs.js'
import { useProblemsStore } from '../../stores/problems.js'
import type { ProblemItem } from '../../stores/problems.js'
import { useDocumentsStore } from '../../stores/documents.js'
import { useStatusStore } from '../../stores/status.js'
import { defaultScriptPath, prepareChangeScriptIo, prepareCreateScriptAndBind } from '../../../../src/workflow/core/script-commands.js'
import type { ScriptIoField } from '../../../../src/workflow/core/script-commands.js'
import {
  prepareAddStep,
  prepareConnectDependency,
  prepareCreateWorkflow,
  prepareDisconnectDependency,
  prepareRemoveStep,
  prepareRenameStep,
  prepareSetInput,
} from '../../../../src/workflow/core/step-commands.js'
import { summarizeBindings } from '../../../../src/workflow/core/binding-status.js'
import type { NodeBindingStatus } from '../../../../src/workflow/core/binding-status.js'
import { parseManifest } from '../../../../src/workflow/core/script-manifest.js'
import type { ActionCatalog, ActionField, ScriptSpec } from '../../../../src/workflow/core/catalog.js'
import { SaveCoordinator } from '../../editor/save-coordinator.js'
import { ideApi } from '../../api/client.js'
import { useWorkflowResources } from './resources.js'
import type { WorkflowCanvas } from './canvas/workflow-canvas.js'
import { projectNodePresentations } from './canvas/semantic-role.js'
import { buildContext, constString, validateSemantics } from './semantics.js'
import { WorkflowSession } from './session.js'
import type { DispatchOutcome } from './session.js'
import { bindWorkflowDocument } from './document-binding.js'
import type { SemanticContext, SemanticIssue } from './semantics.js'
import { createWorkflowScripts } from './scripts.js'

/**
 * 拖拽时塞进 dataTransfer 的类型标记，避免把外部文件拖进来也被当成建节点。
 * - PALETTE_MIME：条目对应的 action（如 dispatch_mission）。
 * - SCRIPT_MIME：拖的是业务功能条目时的功能 ID（P1-1 拖拽即选，不弹选择框）。
 */
export const PALETTE_MIME = 'application/x-fh2-workflow-action'
export const SCRIPT_MIME = 'application/x-fh2-workflow-script'

type JsonRecord = Record<string, unknown>

/**
 * 启动方式的任务语言（P1-3）：主文案用业务词汇，机器值进技术详情。
 * store 持有这份映射供菜单与确认框共享，界面组件不再各写一份。
 */
export const TRIGGER_AXIS_LABELS: Readonly<Record<string, { readonly label: string; readonly machine: string }>> = {
  api: { label: '接口调用', machine: 'trigger.api' },
  schedule: { label: '定时执行', machine: 'trigger.schedule' },
  stream: { label: '事件消息', machine: 'trigger.stream' },
  bizNotify: { label: '业务通知', machine: 'trigger.bizNotify' },
  job: { label: '插件内部启动', machine: 'trigger.job' },
}

function isRecord (value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeError (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 工作流低代码视图的状态与编排（契约 §9）。
 *
 * WorkflowCanvas（SVG 交互）与 ScriptSourceEditor（Monaco）是命令式控件，
 * 像主编辑器的 DocumentStore 一样放在 setup 闭包里，外部只见状态与方法。
 * 文档对象按 workflow/model.ts 的约定「原地改写」——放进 ref 后经 reactive
 * 代理改写，键序与未知字段保留，且模板能感知变化。
 */
/**
 * 从**内存里的**清单对象取 scripts[]，形状与 `/api/actions` 的那一段一致。
 *
 * ⓘ 与服务端 `readWorkspaceScripts` 是两份实现，但**形状由同一个 ScriptSpec 约束**。
 * 两边都只是「把 scripts[] 摊平」，没有判断逻辑；真要收敛的话得让 core 出一个
 * 共享函数 —— 那需要 core 认识清单结构，而清单归属在 plugin 侧，本轮不动它。
 *
 * ⚠️ 解析不出来（半截 JSON）时回 null 而不是空数组：空数组会让面板显示「本工程
 * 还没有业务功能」，而事实是「这一刻读不出来」—— 两者要给用户的反应完全不同。
 */
export function readManifestScripts (raw: unknown, manifestPath: string): readonly ScriptSpec[] | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const scripts = (raw as Record<string, unknown>).scripts
  if (!Array.isArray(scripts)) return null
  const directory = manifestPath.includes('/') ? manifestPath.slice(0, manifestPath.lastIndexOf('/')) : ''

  const out: ScriptSpec[] = []
  for (const entry of scripts) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const id = typeof record.name === 'string' ? record.name : ''
    if (id === '') continue
    const path = typeof record.path === 'string' ? record.path : undefined
    const io = typeof record.io === 'object' && record.io !== null ? record.io as Record<string, unknown> : {}
    out.push({
      id,
      ...(typeof record.entry === 'string' ? { entry: record.entry } : {}),
      ...(path === undefined
        ? {}
        : { path, filePath: directory === '' ? path : `${directory}/${path}` }),
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      allowlist: Array.isArray(record.allowlist)
        ? record.allowlist.filter((item): item is string => typeof item === 'string')
        : [],
      inputs: toIoFields(io.inputs),
      outputs: toIoFields(io.outputs),
    })
  }
  return out
}

/**
 * 清单里的一组 I/O 声明 → ScriptSpec 的字段数组。
 *
 * ⚠️ **必须递归**。`fields`（object 的成员 / array 的元素形状）在清单里是合法且常见的，
 * 平铺读进来的话画布就看不见这一层；而看不见的东西，检查器里一保存就没了 ——
 * 没了之后 worker 的 projectValue 把整块原样放行，声明还在、约束消失，哪一侧都不会红。
 */
function toIoFields (value: unknown): readonly ActionField[] {
  if (!Array.isArray(value)) return []
  const fields: ActionField[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record.name !== 'string' || record.name === '' || typeof record.type !== 'string') continue
    const nested = toIoFields(record.fields)
    fields.push({
      name: record.name,
      type: record.type,
      ...(record.required === true ? { required: true } : {}),
      ...(nested.length > 0 ? { fields: nested } : {}),
    })
  }
  return fields
}

export const useWorkflowStore = defineStore('workflow', () => {
  const status = useStatusStore()
  const problems = useProblemsStore()
  const documents = useDocumentsStore()
  const workspace = useWorkflowResources()

  const document = ref<WorkflowDocument | null>(null)
  /**
   * 文档按 workflow/model.ts 的约定原地改写，多数深层变更不改引用；
   * 检查器等深度读取方靠 revision 重新求值（同 documents store 的模式）。
   */
  const revision = ref(0)
  const path = ref<string | null>(null)
  /** 换文档或重置工作区后，检查器旧输入不得再提交。 */
  const draftEpoch = ref(0)
  const dirty = computed(() => path.value !== null && documents.isDirty(path.value))
  /** 顶部下拉当前选中的候选路径。 */
  const selectedCandidate = ref('')
  const candidates = ref<readonly string[]>([])
  const selectedId = ref<string | null>(null)
  const model = ref<WorkflowGraph | null>(null)
  const context = ref<SemanticContext | null>(null)
  const semanticIssues = ref<readonly SemanticIssue[]>([])

  /**
   * 每个节点的绑定完整度（计划 §E5）。
   *
   * ★★ 由**本 store 已经算好的** semanticIssues 归纳，而不是再调一次
   * `session.bindingStatuses()`：后者会重新解析 + 重新校验一遍，于是
   *   ① 每次按键多跑一遍全量校验
   *   ② 两份结果可能不一致（画布按 A 画、检查器按 B 说）
   * 归纳规则只有 `summarizeBindings` 一处，两条路径共用它，所以不会漂。
   */
  /**
   * 文档层变更计数。
   *
   * ★ `revision` 只在**工作流**重算时推进，而清单是另一个文档 —— 用户在清单里
   *   加一个功能不会推 revision，于是「内存里的 scripts[]」这个 computed 不会重算，
   *   面板就看不到刚新建的功能。故另立一个计数，订阅文档层的所有变更。
   */
  const documentsRevision = ref(0)

  const bindingStatuses = ref<readonly NodeBindingStatus[]>([])

  /**
   * P2-2：Problems 点击 → 画布节点/入参的定位请求。
   * Inspector watch 这个 ref（对象身份变化即触发），滚动并高亮对应输入行。
   */
  const focusRequest = ref<{ readonly nodeId: string; readonly inputKey?: string } | null>(null)
  const bindingStateOf = computed(() => {
    const map = new Map<string, NodeBindingStatus>()
    for (const status of bindingStatuses.value) map.set(status.nodeId, status)
    return map
  })

  /**
   * 画布用的 Catalog：平台契约来自知识包，**业务功能来自当前编辑缓冲区**。
   *
   * ★★ 方案 §2.3 的那条纪律：「项目脚本必须读取**当前编辑版本的清单**，
   * 不能一边显示未保存源码，一边用磁盘旧清单生成 I/O」。
   * `/api/actions` 的 scripts[] 是服务端从**磁盘**读的 —— 新建的功能还没保存时
   * 它看不到，于是面板里没有、命令校验说「清单里没有这个功能」，
   * 而用户明明刚建完。这里用内存里的清单文本覆盖那一段。
   *
   * ⓘ 清单没打开 / 解析不出来时退回服务端那份：那时内存里没有更新的版本，
   *   磁盘那份就是当前事实。
   */
  /**
   * 文档服务句柄。声明提到这里（而不是紧挨着 bindDocuments）是因为
   * `catalog` 这个 computed 要读它 —— 它在本文件里是最早的使用点。
   */
  let documentService: DocumentService | undefined

  const catalog = computed<ActionCatalog>(() => {
    // ⚠️⚠️ 依赖必须在**任何提前 return 之前**读到。
    // 写在下面那几个 return 后面的话：首次求值时 documentService 还没绑定，
    // 于是这个 computed 的依赖集合里**压根没有 documentsRevision** ——
    // 之后清单再怎么改它都不会重算，面板永远看不到新建的功能。
    // （真踩过：新建业务功能成功了、节点也建了，就是面板里不出现。）
    void documentsRevision.value
    const base = workspace.catalog
    const manifestPath = base.pluginManifestPath
    if (manifestPath === '' || documentService === undefined) return base
    const text = documentService.contentOf(manifestPath)
    if (text === null) return base
    const parsed = parseManifest(text, manifestPath)
    if (!parsed.ok) return base
    const scripts = readManifestScripts(parsed.document.raw, manifestPath)
    return scripts === null ? base : { ...base, scripts }
  })
  const schema = computed(() => workspace.workflowSchema)
  const loaded = computed(() => document.value !== null)

  // ── 命令式控件（闭包持有，不做响应式代理） ──

  let canvas: WorkflowCanvas | null = null
  function attachCanvas (instance: WorkflowCanvas): void {
    canvas = instance
  }

  function fitCanvas (): void {
    canvas?.fit()
  }

  function zoomCanvas (factor: number): void {
    canvas?.zoomBy(factor)
  }

  function resetZoomCanvas (): void {
    canvas?.resetZoom()
  }

  // ── 派生视图状态 ──

  const selectedNode = computed<WorkflowNode | null>(() => {
    const id = selectedId.value
    if (id === null) return null
    return model.value?.nodes.find(node => node.id === id) ?? null
  })

  const stepCount = computed(() => model.value?.nodes.filter(node => node.kind === 'step').length ?? 0)
  const needsEdgeCount = computed(() =>
    model.value?.edges.filter(edge => edge.origin === 'needs').length ?? 0)
  const errorIssueCount = computed(() => semanticIssues.value.filter(issue => issue.level === 'error').length)
  const warningIssueCount = computed(() => semanticIssues.value.filter(issue => issue.level === 'warning').length)

  /** 通知栏常驻消息（文档结构与语义汇总 + 检查边界一句）。 */
  const noticeMessages = computed(() => {
    const messages: { readonly text: string; readonly level: 'error' | 'warning' | 'info'; readonly kind?: 'lossless' }[] = []

    /**
     * 检查边界的常驻一句话（P1-7 渐进披露：主文案只说清边界）。
     *
     * ★★ 它**恒在**而不是只在异常时出现。理由是这一栏回答的问题是
     * 「我现在看到的红点/绿灯，凭据是什么」—— 那个问题在一切正常时同样要有答案。
     * 只在出错时才说，等于默认状态下用户会把本地预检读成「已验证」。
     *
     * ⚠️ 这句文案【刻意不出现】「已验证 / 可部署 / 校验通过」这类词，连在否定句里
     *    也不出现 —— e2e 用朴素子串检查守「不宣称结论」这件事，而子串检查分不清
     *    「已验证」和「不证明已验证」。让文案回避这些词，那道门禁才靠得住。
     *    完整的来源与 revision 在「检查依据」里展开（noticeEvidence）。
     */
    if (workspace.catalog.available) {
      messages.push({
        text: '当前仅执行本地快速检查；完整的工程检查暂不可用。',
        level: 'info',
      })
    }

    const current = document.value
    if (current !== null && !current.lossless) {
      messages.push({
        text: '保存时会重新排版，内容不会改变。',
        level: 'warning',
        kind: 'lossless',
      })
    }
    const structuralIssues = model.value?.issues ?? []
    for (const issue of structuralIssues) {
      messages.push({ text: issue.message, level: 'error' })
    }
    // 汇总行与语义层对齐：逐条消息是给「点到节点看详情」的人读的，
    // 汇总行必须带「错误」字样——只扫一眼通知栏的人和自动化检查
    // 都靠它确认结构问题属于错误而不是提示。
    if (structuralIssues.length > 0) {
      messages.push({ text: `结构错误：${structuralIssues.length} 个，工作流结构无法执行。点击对应节点查看详情。`, level: 'error' })
    }
    // 语义问题在通知栏只给汇总：逐条展示会把通知栏撑爆，详情在检查器里按节点看。
    if (errorIssueCount.value > 0) {
      const nodes = [...new Set(semanticIssues.value
        .filter(issue => issue.level === 'error')
        .map(issue => issue.nodeId === TRIGGER_NODE_ID ? '触发器' : issue.nodeId))]
      messages.push({
        text: `工作流检查：${errorIssueCount.value} 个错误（${nodes.join('、')}）。点击对应节点查看详情。`,
        level: 'error',
      })
    }
    if (warningIssueCount.value > 0) {
      messages.push({ text: `工作流检查：${warningIssueCount.value} 个警告。`, level: 'warning' })
    }
    return messages
  })

  /**
   * 「检查依据」的展开内容（P1-7：知识来源、版本与 checker 状态不占主视觉）。
   *
   * ⓘ e2e 靠「平台契约来自知识包 / 内建手抄快照」的子串守来源披露 ——
   *    这段文字在 <details> 里仍然渲染进 DOM，那道门禁继续有效。
   */
  const noticeEvidence = computed(() => {
    const catalog = workspace.catalog
    if (!catalog.available) {
      return [`动作目录来源：未加载（${catalog.source.reason ?? '平台动作目录请求失败'}）`]
    }
    if (catalog.source.kind === 'knowledge') {
      return [
        `动作目录来源：知识库（版本 ${catalog.source.revision}）`,
        '检查器：当前没有与项目版本匹配的官方检查器。',
        '检查范围：只检查结构、引用和参数类型，不验证实际运行结果。',
        '规则编号：R1–R8，技术详情里可以查看字段路径。',
      ]
    }
    return [
      `动作目录来源：工具链内置快照（版本 ${catalog.source.revision}）`,
      `检查器：当前没有官方检查器；内置快照可能与目标执行器版本不一致。${catalog.source.reason ?? ''}`,
      '检查范围：只检查结构、引用和参数类型，不验证实际运行结果。',
      '规则编号：R1–R8，技术详情里可以查看字段路径。',
    ]
  })

  /** 载入失败 / 解析失败的覆盖消息（有值时顶替常规通知）。 */
  const noticeOverride = ref<string | null>(null)

  function nodeById (id: string): WorkflowNode | undefined {
    return model.value?.nodes.find(node => node.id === id)
  }

  /** 从原始文档里取一个 step 对象（检查器要直接读写它）。 */
  function rawStepById (id: string): JsonRecord | undefined {
    const steps = document.value?.raw.steps
    if (!Array.isArray(steps)) return undefined
    return steps.find((step): step is JsonRecord =>
      isRecord(step) && step.id === id)
  }

  // ── 刷新与脏标记 ──

  /** 语义校验每次编辑都重算：它是纯函数，增量维护的收益抵不过「算漏一处红线」的代价。 */
  function refresh (): void {
    const current = document.value
    if (current === null) return
    model.value = toGraph(current)
    context.value = catalog.value.available ? buildContext(catalog.value, current) : null
    semanticIssues.value = validateSemantics(catalog.value, current)
    bindingStatuses.value = summarizeBindings(
      (model.value?.nodes ?? []).filter(node => node.kind !== 'trigger').map(node => node.id),
      semanticIssues.value,
    )
    revision.value += 1
    // 画布消费 projection/role 结果（DAG 正交连线 Plan §6.2）：
    // 语义角色由本 store 用「当前 catalog」投影 —— 词表降级时文档侧判据仍有效
    canvas?.render(
      model.value,
      projectNodePresentations(model.value, catalog.value),
      semanticIssues.value,
      bindingStatuses.value,
    )
    syncWorkflowProblems()
  }

  /**
   * 词表变了也要重算一遍语义。
   *
   * ★★ `refresh()` 原本只在**工作流文档**变化时跑，而语义校验的另一个输入是词表 ——
   * 其中「业务功能的 I/O」来自清单，清单是**另一个文档**。于是改完 I/O 声明之后：
   * 面板和契约编辑器（computed，跟着 catalog 走）都更新了，画布与检查器却还按旧声明算。
   *
   * ⚠️ 这个缺口在本轮之前是潜伏的（画布里没有改 I/O 的入口，只能手改 JSON）。
   * ChangeScriptIO 一落地它就变成主路径上的错：删掉一个被引用的出参时，
   * 命令刚列完「这 1 处接线会解不开」，画布转头还说「都解得开」——
   * **两句话里必然有一句在骗人**，而用户会信画布那一句。
   *
   * ⓘ 不会循环：catalog 只依赖 documentsRevision 与 workspace.catalog，
   *   refresh() 推的是 revision，两者不相干。
   */
  watch(catalog, () => {
    refresh()
  })

  /**
   * W2：源码 → 引用节点反查索引。
   * 返回当前画布上引用了该脚本文件的所有 step（跨工作流的全仓反查需要扫描，
   * P1 先覆盖「已载入画布」的范围 —— 检查器与 Problems 都从这里取）。
   */
  function referencingSteps (scriptFilePath: string): readonly { readonly stepId: string; readonly scriptId: string }[] {
    const current = document.value
    if (current === null) return []
    const result: { stepId: string; scriptId: string }[] = []
    const rawSteps = Array.isArray(current.raw.steps) ? current.raw.steps : []
    for (const step of rawSteps.filter((item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item))) {
      const id = typeof step.id === 'string' ? step.id : ''
      if (id === '') continue
      const scriptId = constString(step, 'script')
      if (scriptId === undefined) continue
      const script = catalog.value.scripts.find(item => item.id === scriptId)
      if (script?.filePath !== scriptFilePath) continue
      result.push({ stepId: id, scriptId })
    }
    return result
  }

  /**
   * W2：画布语义问题进入统一 Problems（workflow 源，与编辑器/Build/LSP 互不清除）。
   * path 用当前工作流文件；nodeId 挂 path#node 让点击定位有据可依。
   */
  function syncWorkflowProblems (): void {
    const workflowPath = path.value
    if (workflowPath === null) {
      problems.clearProblems('workflow')
      return
    }
    // 反查：当前编辑器正开着被画布引用的脚本时，附一条 info 级「引用节点」提示。
    const active = documents.active
    const referencing = active === null ? [] : referencingSteps(active)
    const workflowProblems: ProblemItem[] = [
      ...(referencing.length > 0
        ? [{
            origin: 'workflow' as const,
            severity: 'info' as const,
            path: active ?? '',
            line: 1,
            column: 1,
            code: 'WF_REFERENCED_BY',
            message: `该脚本被工作流 ${workflowPath} 的步骤引用：${referencing.map(item => item.stepId).join('、')}（可在画布中定位）`,
            source: 'workflow' as const,
          }]
        : []),
      ...(model.value?.issues ?? []).map(issue => ({
        origin: 'workflow' as const,
        severity: 'error' as const,
        path: workflowPath,
        line: 1,
        column: 1,
        code: issue.code as string,
        message: issue.message,
        source: 'workflow' as const,
      })),
      ...semanticIssues.value.map(issue => ({
        origin: 'workflow' as const,
        severity: issue.level === 'error' ? 'error' as const : 'warning' as const,
        path: workflowPath,
        line: 1,
        column: 1,
        code: issue.rule as string,
        message: issue.nodeId === '' ? issue.message : `[${issue.nodeId}] ${issue.message}`,
        source: 'workflow' as const,
        // P2-2：点击行 → 切到对应工作流、选中节点、聚焦具体输入/条件。
        target: {
          kind: 'workflow-node' as const,
          workflowPath,
          nodeId: issue.nodeId,
          ...(issue.inputKey === undefined ? {} : { inputKey: issue.inputKey }),
        },
      })),
    ]
    problems.setProblems('workflow', workflowProblems, path.value ?? '')
  }

  let binding: ReturnType<typeof bindWorkflowDocument> | undefined

  const { mountScriptEditor, disposeScriptEditor } = createWorkflowScripts({
    catalog,
    documents,
    status,
    readFile,
    openScriptSource,
  })

  /**
   * 结构化命令通道（计划 §E1）。
   *
   * ★★ 画布的每一次结构改动都经它：prepare（core 纯函数）→ applyPrepared（原子落内存）。
   * 从前是 store 直接改 `document.raw` 再整份重序列化 —— 那条路没有前置核验
   * （用户在 Monaco 里同时敲的内容会被覆盖），也没有最小编辑（手写排版被重排）。
   */
  let session: WorkflowSession | null = null

  /**
   * 多文件保存协调（计划 §C2）。
   *
   * ★★ 画布的保存**不能**只存当前那一个 workflow 文件：一次「新建业务功能」会同时
   * 产生 JS 源码（虚拟文件）与清单改动。只存 workflow 的话，保存完之后工程处在
   * 「流程引用了一个清单里没有的功能」的状态 —— 装载期拒掉整个插件包。
   */
  let saver: SaveCoordinator | null = null
  let unsubscribeDocuments: (() => void) | undefined

  /**
   * 检查器面板登记「保存前要把哪些输入草稿写进文档」。
   *
   * 组件卸载时注销；协调器每次重新绑定都要重新挂一遍，否则换工作区后草稿又会漏。
   */
  const draftFlushers = new Set<() => void | Promise<void>>()

  async function flushDrafts (): Promise<void> {
    for (const flush of draftFlushers) {
      try {
        await flush()
      } catch {
        // 单个面板的异常不该让整次保存不做；面板自己会把错误显示出来。
      }
    }
  }

  function registerDraftFlush (flush: () => void | Promise<void>): () => void {
    draftFlushers.add(flush)
    return () => {
      draftFlushers.delete(flush)
    }
  }

  function bindDocuments (service: DocumentService): void {
    draftEpoch.value += 1
    binding?.dispose()
    documentService = service
    unsubscribeDocuments?.()
    unsubscribeDocuments = service.subscribe((event) => {
      if (event?.reason === 'workspace') draftEpoch.value += 1
      documentsRevision.value += 1
    })
    saver = new SaveCoordinator({
      documents: service,
      epoch: () => draftEpoch.value,
      save: items => ideApi.save(items),
      readFile: path => ideApi.readFile(path),
    })
    saver.registerDraftFlush(flushDrafts)
    session = new WorkflowSession({
      // ⚠️ 传的是 service 本身（它背后就是那一个 DocumentStore）。
      //    另开一个实例 = 两套代号 = 前置核验形同虚设，见 SessionDocuments 的 ★★。
      documents: service,
      // ⚠️ 用本 store 的 catalog（含内存里的 scripts[]），不是 workspace 那份磁盘快照：
      //    否则「刚新建的功能」在命令校验里不存在，而它明明已经在清单缓冲区里了。
      catalog: () => catalog.value,
      knowledgeId: () => {
        const source = workspace.catalog.source
        return source.kind === 'knowledge' ? source.revision : undefined
      },
    })
    binding = bindWorkflowDocument(service, (parsed, currentPath) => {
      if (path.value !== currentPath) draftEpoch.value += 1
      path.value = currentPath
      // ⚠️ 必须同步给 session：它按自己的 currentPath 取快照。不同步的话
      //    workflowContext() 恒回 null，于是**每一条命令都静默什么都不做**。
      session?.setPath(currentPath)
      if (!parsed.ok) {
        document.value = null
        model.value = null
        semanticIssues.value = []
        bindingStatuses.value = []
        noticeOverride.value = `无法读取工作流：${parsed.message}`
        canvas?.render({ name: '', nodes: [], edges: [], issues: [] }, new Map())
        return
      }
      document.value = parsed.document
      noticeOverride.value = null
      refresh()
    })
  }

  /**
   * 统一处理一次命令分发的结果。
   *
   * ★ 三种结果给三种反馈，**不合成一句「操作失败」**：
   *   rejected 要把 reason（与 impacts）摊开 —— 用户得知道为什么、以及要不要确认后重来
   *   stale    要说「文档变了，请重试」—— 这是可重试的，与上一种完全不同
   *   applied  成功；有 advisories 时把「本次管不到的活儿」也说出来
   */
  function reportOutcome (outcome: DispatchOutcome, successMessage?: string): boolean {
    if (outcome.status === 'applied') {
      const advisory = outcome.advisories === undefined || outcome.advisories.length === 0
        ? ''
        : `（另有 ${outcome.advisories.length} 处需要你自己处理：${outcome.advisories.map(item => item.at).join('、')}）`
      if (successMessage !== undefined) status.set(`${successMessage}${advisory}`)
      else if (advisory !== '') status.set(advisory.slice(1, -1), true)
      return true
    }
    if (outcome.status === 'stale') {
      status.set(`${outcome.reason} 请重试。`, true)
      return false
    }
    const impacts = outcome.impacts === undefined || outcome.impacts.length === 0
      ? ''
      : ` 受影响：${outcome.impacts.map(item => `${item.stepId}.${item.at}`).join('、')}`
    status.set(`${outcome.reason}${impacts}`, true)
    return false
  }

  /**
   * 当前命令上下文；拿不到时**给一句话**再回 null。
   *
   * ⚠️ 静默返回是不行的：用户点了按钮、什么都没发生、也没有任何提示 ——
   * 那种「点了没反应」的缺陷最难报也最难查（真踩过：session 的 path 没同步，
   * 于是每条命令都走到这里静默返回，画布看起来完全没坏，只是不动）。
   */
  function commandContext () {
    if (session === null) {
      status.set('编辑器尚未就绪，请稍后重试。', true)
      return null
    }
    const context = session.workflowContext()
    if (context === null) status.set('先选一个工作流文件，再操作画布。', true)
    return context
  }

  function markDirty (): void {
    if (document.value === null) return
    if (!binding?.edit(document.value)) {
      noticeOverride.value = '文件已变化或存在冲突，请先处理后继续编辑。'
    }
  }

  /**
   * 读依赖文件（脚本源码等）：不激活 tab、不抢主编辑器当前文件（P2-3）。
   */
  async function readFile (filePath: string): Promise<string> {
    if (documentService === undefined) throw new Error('Workflow 尚未连接文档服务。')
    return await documentService.readDetached(filePath)
  }

  let loadGeneration = 0
  async function load (target: string): Promise<void> {
    try {
      if (!binding) return
      // P2-4：切换即清场 —— 旧文档的 selection、连线半途、焦点请求都不能带进新文档。
      const switching = target !== path.value
      if (switching) {
        draftEpoch.value += 1
        select(null)
        canvas?.cancelInteraction()
        focusRequest.value = null
      }
      const generation = ++loadGeneration
      if (!await binding.open(target) || generation !== loadGeneration) return
      selectedCandidate.value = target
      await workspace.refreshCatalog(target)
      if (generation !== loadGeneration) return
      // ★ 把后端清单一并打开：业务功能命令要它的快照，面板要它的**内存内容**。
      //   不打开的话 scriptContext() 恒为 null，新建/改功能全都用不了。
      await openManifestDocument()
      if (generation !== loadGeneration) return
      refresh()
      canvas?.fit()
      status.set(`画布已载入 ${target}`)
    } catch (error) {
      status.set(`读取 ${target} 失败：${describeError(error)}`, true)
    }
  }

  /**
   * 打开后端插件清单（不切视图、不抢焦点）。
   *
   * ⓘ 失败只记一句：清单读不出来时业务功能那一路不可用，但画布本身照旧能编排
   * 平台步骤 —— 不该因此让整个载入失败。
   */
  async function openManifestDocument (): Promise<void> {
    const manifestPath = catalog.value.pluginManifestPath
    if (manifestPath === '' || documentService === undefined) return
    try {
      await documentService.open(manifestPath)
    } catch (error) {
      status.set(`读取插件清单失败，业务功能相关操作不可用：${describeError(error)}`, true)
    }
  }

  /**
   * 与当前工作流**关联**的文件（P0-7「保存当前流程（含脚本与清单）」的范围）。
   *
   * ★ 只取「这一条流程」牵连的文件：工作流本身 + 它调用的脚本源码 + 后端清单。
   * 别的打开文档（别的流程、无关文件）不进来 —— 保存当前流程不能顺带把
   * 别的工作区改动一起落盘。
   */
  const relatedPaths = computed<readonly string[]>(() => {
    void documentsRevision.value
    const current = path.value
    const result: string[] = []
    if (current !== null) result.push(current)
    const manifestPath = catalog.value.pluginManifestPath
    if (manifestPath !== '') result.push(manifestPath)
    const raw = document.value?.raw
    const steps = raw != null && Array.isArray(raw.steps)
      ? raw.steps.filter((item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && !Array.isArray(item))
      : []
    for (const step of steps) {
      const scriptId = constString(step, 'script')
      if (scriptId === undefined) continue
      const script = catalog.value.scripts.find(item => item.id === scriptId)
      if (script?.filePath !== undefined && !result.includes(script.filePath)) result.push(script.filePath)
    }
    return result
  })

  /**
   * 关联文件里有没有脏的。
   *
   * ★ 修复的缺陷（P0-7）：只改脚本/清单时工作流文件本身不脏，旧判据会把
   *   「保存」按钮禁掉 —— 而那些改动恰恰属于这次编排会话、必须能保存。
   */
  const relatedDirty = computed(() => {
    void documentsRevision.value
    return relatedPaths.value.some(item => documents.isDirty(item))
  })

  /** 打开文档里脏文件的数量（「保存工作区全部改动（N）」的 N）。 */
  const dirtyDocumentCount = computed(() => {
    void documentsRevision.value
    return documents.openPaths.filter(item => documents.isDirty(item)).length
  })

  /**
   * 「检查当前配置」：只重算内存里的结构与语义（快速，不保存）。
   *
   * ★ P0-7 的硬边界：检查**绝不**碰磁盘 —— 与「校验」（能力层，先 Save All）
   *   是三个不同的动作，各自按钮各自名字。
   */
  function checkConfig (): void {
    refresh()
    const errors = errorIssueCount.value
    const warnings = warningIssueCount.value
    const structural = model.value?.issues.length ?? 0
    if (errors === 0 && warnings === 0 && structural === 0) {
      status.set('本地快速检查：未发现问题（不保存文件；不代表完整工程检查）。')
      return
    }
    status.set(
      `本地快速检查：${errors} 个错误 · ${warnings} 个警告 · ${structural} 个结构问题（不保存文件；点击画布节点查看详情）。`,
      errors > 0 || structural > 0,
    )
  }

  /**
   * 保存（可带范围）：走多文件有序计划（脚本 → 清单 → 工作流）。
   *
   * ⚠️ 结果有多档，**必须分开报**：
   *   ok            全部落盘
   *   partial       一部分落了 —— 基线只推进到落盘的那几份（SaveCoordinator 保证），
   *                 报「哪些没落、为什么」，让用户知道还有东西在内存里
   *   pending       服务端失败即停后**没轮到执行**的（P2-5）—— 单独报，不冒充失败
   *   nothingToSave 没有待保存内容（不是失败）
   * 合成一句「保存失败」会让用户重复点保存，而每点一次都在制造新的冲突。
   */
  async function save (only?: readonly string[], label = '保存'): Promise<void> {
    if (saver === null) return
    let outcome
    try {
      outcome = await saver.save(only)
    } catch (error) {
      status.set(`${label}失败：${describeError(error)}`, true)
      return
    }

    if (outcome.nothingToSave) {
      status.set('没有需要保存的改动。')
      return
    }
    if (outcome.ok) {
      status.set(`${label}完成，已保存 ${outcome.saved.length} 个文件：${outcome.saved.join('、')}`)
      await useIdeAfterSave()
      return
    }

    const failed = outcome.failed.map(item => `${item.path}（${item.message}）`).join('；')
    const pendingNote = outcome.pending.length === 0
      ? ''
      : ` 另有 ${outcome.pending.length} 个文件未执行：${outcome.pending.join('、')}。`
    if (outcome.partial) {
      status.set(
        `部分保存：已落盘 ${outcome.saved.join('、')}；未落盘 ${failed}。${pendingNote}`
        + '未落盘的内容仍在编辑器里，没有丢。',
        true,
      )
    } else {
      status.set(`${label}失败：${failed}${pendingNote}`, true)
    }
    // ⓘ 落了一部分时仍要跑一次校验：磁盘状态确实变了，问题面板得跟上。
    if (outcome.saved.length > 0) await useIdeAfterSave()
  }

  /** P0-7「保存当前流程（含脚本与清单）」：范围闸在 SaveCoordinator 的计划里。 */
  async function saveRelated (): Promise<void> {
    if (path.value === null) {
      status.set('先选一个工作流文件，再保存。', true)
      return
    }
    await save(relatedPaths.value, '保存工作流')
  }

  async function saveWhenDirty (): Promise<void> {
    if (relatedDirty.value) await saveRelated()
  }

  /** 落盘后跑能力层校验（由 use-ide 注入，避免 store 依赖编排层）。 */
  let afterSaveHook: (() => Promise<void>) | null = null
  /** W2：节点→源码跳转回调（use-ide 注入 jumpTo），检查器「在主编辑器打开」用。 */
  let openScriptInEditor: ((path: string) => Promise<void>) | null = null

  function setOpenScriptHook (hook: (path: string) => Promise<void>): void {
    openScriptInEditor = hook
  }

  async function openScriptSource (filePath: string): Promise<void> {
    if (openScriptInEditor === null || filePath === '') return
    await openScriptInEditor(filePath)
  }

  function setAfterSaveHook (hook: () => Promise<void>): void {
    afterSaveHook = hook
  }
  async function useIdeAfterSave (): Promise<void> {
    await afterSaveHook?.()
  }

  /** 切到本视图时调用：首次进入自动加载下拉里选中的文件。 */
  async function activate (): Promise<void> {
    if (document.value === null && selectedCandidate.value !== '') {
      await load(selectedCandidate.value)
      return
    }
    // 从编辑器切回来时容器尺寸可能变过，重新 fit 一次
    canvas?.fit()
  }

  /** 工作区切换：把画布彻底清干净，不留上个工作区的残影。 */
  function reset (): void {
    draftEpoch.value += 1
    ++loadGeneration
    binding?.reset()
    problems.clearProblems('workflow')
    disposeScriptEditor()
    workspace.reset()
    document.value = null
    model.value = null
    path.value = null
    session?.setPath(null)
    candidates.value = []
    selectedCandidate.value = ''
    selectedId.value = null
    noticeOverride.value = null
    focusRequest.value = null
    canvas?.cancelInteraction()
    canvas?.render({ name: '', nodes: [], edges: [], issues: [] }, new Map())
  }

  /** 磁盘上这个文件变了（SSE change）。画布不脏才回灌，脏了只提示。 */
  async function onExternalChange (changed: string): Promise<void> {
    // 磁盘更新由统一文档服务处理，订阅自动刷新画布。
    if (changed === path.value && documents.conflictOf(changed) !== null) {
      noticeOverride.value = '工作流与磁盘内容冲突，请在冲突处理面板中处理。'
    }
  }

  // ── P2-3：刷新画布 / 从磁盘重新载入 ──

  /**
   * 「刷新画布」：只按**内存里的**文档内容重算图与语义，不碰磁盘。
   * （旧名「重新载入」会让人以为它读盘 —— 那是另一个动作。）
   */
  function refreshCanvas (): void {
    if (document.value === null) return
    refresh()
    canvas?.fit()
    status.set('画布已按编辑器当前内容刷新（未读取磁盘）。')
  }

  /**
   * 「从磁盘重新载入」：当前工作流按磁盘内容重读。
   *
   * ★ 有未保存改动时**不静默覆盖**：经冲突面板提供比较 / 放弃本地 / 取消
   *   （enterConflict 走与外部修改同一条 UI，不另造对话框）。
   */
  async function reloadFromDisk (): Promise<void> {
    const target = path.value
    if (target === null) return
    try {
      const file = await ideApi.readFile(target)
      if (documents.isDirty(target)) {
        documents.enterConflict(target, { diskContent: file.content, diskRevision: file.revision ?? '' })
        status.set(`${target} 在磁盘上有新内容，本地改动仍在编辑器里 —— 请在冲突面板选择处理方式。`, true)
        return
      }
      documents.reloadFromDisk(target, file.content, file.revision)
      refresh()
      status.set(`已从磁盘重新载入 ${target}`)
    } catch (error) {
      status.set(`从磁盘重新载入 ${target} 失败：${describeError(error)}`, true)
    }
  }

  // ── P2-1：新建工作流向导 ──

  /**
   * 新建一份工作流文件（内存虚拟文档，保存时才落盘）。
   *
   * ★ 不猜启动方式：向导里让用户选，选了有必填字段的轴（schedule 的
   *   执行间隔、stream 的事件筛选、bizNotify 的订阅标识）当场收齐 ——
   *   造出 schema 过不了的文件再让用户修，不如一开始就不给。
   */
  async function promptCreateWorkflow (): Promise<void> {
    if (session === null) {
      status.set('编辑器尚未就绪，请稍后重试。', true)
      return
    }
    const result = await showDialog({
      title: '新建工作流',
      body: [
        '创建的是最小合法流程：名称 + 一个启动方式 + 空步骤，建好后直接进入启动方式配置。',
        '文件先存在于编辑器里，保存时才写入磁盘。',
      ],
      fields: [
        { kind: 'text', name: 'name', label: '工作流名称', required: true, placeholder: '违停巡逻' },
        { kind: 'text', name: 'path', label: '文件路径', required: true, placeholder: 'workflows/patrol.json', hint: '相对工作根；通常放在 workflows/ 目录。' },
        { kind: 'text', name: 'description', label: '说明（可选）' },
        {
          kind: 'select',
          name: 'axis',
          label: '启动方式',
          value: '',
          options: [
            { value: '', label: '（选择启动方式）' },
            ...Object.entries(TRIGGER_AXIS_LABELS).map(([value, item]) => ({ value, label: item.label })),
          ],
          hint: '至少一种，建好后还能再启用其它方式。定时执行/事件消息/业务通知需要再填几个必填项。',
        },
      ],
      confirmLabel: '下一步',
    })
    if (result === null) return
    const name = String(result.name ?? '').trim()
    const filePath = String(result.path ?? '').trim()
    const axis = String(result.axis ?? '')
    if (name === '' || filePath === '' || axis === '') {
      status.set('新建工作流需要名称、文件路径和启动方式。', true)
      return
    }
    if (candidates.value.includes(filePath)) {
      status.set(`文件 ${filePath} 已存在。`, true)
      return
    }

    // 轴的必填字段（schema 要求）在第二步收齐；api/job 没有必填字段，直接建。
    let axisSpec: Record<string, unknown> = {}
    if (axis === 'schedule') {
      const detail = await showDialog({
        title: `配置「${TRIGGER_AXIS_LABELS[axis]!.label}」`,
        body: ['平台不替业务猜周期 —— 执行间隔必须显式给出。'],
        fields: [
          { kind: 'text', name: 'intervalSec', label: '执行间隔（秒）', required: true, placeholder: '300' },
        ],
        confirmLabel: '创建',
      })
      if (detail === null) return
      const interval = Number(String(detail.intervalSec ?? '').trim())
      if (!Number.isInteger(interval) || interval <= 0) {
        status.set('执行间隔必须是正整数（秒）。', true)
        return
      }
      axisSpec = { intervalSec: interval }
    } else if (axis === 'stream') {
      const detail = await showDialog({
        title: `配置「${TRIGGER_AXIS_LABELS[axis]!.label}」`,
        body: ['match 为空会匹配到这条 stream 里的全部消息（包括状态变更），至少限定 status。'],
        fields: [
          { kind: 'pairs', name: 'match', label: '事件筛选条件', required: true, keyPlaceholder: 'event_type', valuePlaceholder: 'illegal_road', hint: '键用消息原样的 snake_case（如 event_type）。' },
        ],
        confirmLabel: '创建',
      })
      if (detail === null) return
      const match = detail.match
      const pairs = typeof match === 'object' && match !== null && !Array.isArray(match)
        ? match as Record<string, string>
        : {}
      if (Object.keys(pairs).length === 0) {
        status.set('事件筛选条件要至少一条 键=值。', true)
        return
      }
      axisSpec = { match: pairs }
    } else if (axis === 'bizNotify') {
      const detail = await showDialog({
        title: `配置「${TRIGGER_AXIS_LABELS[axis]!.label}」`,
        body: ['订阅标识是通知数据里标识「这条是发给本插件的」的键名，平台靠它判断这条通知发给谁。'],
        fields: [
          { kind: 'text', name: 'subscriber', label: '订阅标识', required: true, placeholder: 'traffic_capture' },
        ],
        confirmLabel: '创建',
      })
      if (detail === null) return
      const subscriber = String(detail.subscriber ?? '').trim()
      if (subscriber === '') {
        status.set('订阅标识不能为空。', true)
        return
      }
      axisSpec = { subscriber }
    }

    const description = String(result.description ?? '').trim()
    const outcome = await session.dispatch(() => prepareCreateWorkflow(
      session!.workspaceCommandContext(),
      {
        path: filePath,
        name,
        ...(description === '' ? {} : { description }),
        axis: axis as 'api' | 'schedule' | 'stream' | 'bizNotify' | 'job',
        axisSpec,
      },
    ))
    if (!reportOutcome(outcome, `已新建工作流 ${name}`)) return

    // 新文件进候选列表并打开；选中触发器 —— 下一步就是配置启动数据。
    if (!candidates.value.includes(filePath)) {
      candidates.value = [...candidates.value, filePath]
    }
    await load(filePath)
    select(TRIGGER_NODE_ID)
    status.set(`已新建工作流 ${name}（${filePath}）。请配置启动时带入流程的数据；保存后才会写入磁盘。`)
  }

  // ── P2-2：Problems → 画布节点定位 ──

  /**
   * 切到指定工作流并选中节点、聚焦具体输入。
   * ProblemsList 点击 workflow 源的行经 use-ide 走到这里。
   */
  async function revealWorkflowNode (workflowPath: string, nodeId: string, inputKey?: string): Promise<void> {
    if (path.value !== workflowPath) await load(workflowPath)
    if (nodeId === '') {
      select(TRIGGER_NODE_ID)
      return
    }
    select(nodeId)
    canvas?.revealNode(nodeId)
    focusRequest.value = { nodeId, ...(inputKey === undefined ? {} : { inputKey }) }
  }

  /** 工作区里所有 workflow 文件路径，驱动顶部下拉。 */
  function setCandidates (paths: readonly string[]): void {
    candidates.value = paths
    if (path.value !== null && !paths.includes(path.value)) {
      // 当前文件在新工作区里不存在了，整个状态已在 reset 里清过；这里只保证下拉不出死值
      selectedCandidate.value = ''
    } else if (path.value !== null) {
      selectedCandidate.value = path.value
    }
  }

  function select (nodeId: string | null): void {
    selectedId.value = nodeId
    canvas?.select(nodeId)
  }

  // ── 画布回调 ──

  function showNodeMenu (nodeId: string, x: number, y: number): void {
    const node = nodeById(nodeId)
    if (node === undefined) return
    if (node.kind === 'trigger') {
      showContextMenu(x, y, [
        ...addStepEntries(),
        'separator',
        { label: '改说明…', onSelect: () => void promptTriggerDescription() },
      ])
      return
    }
    showContextMenu(x, y, [
      ...addStepEntries(nodeId),
      'separator',
      { label: '重命名…', onSelect: () => void promptRename(nodeId) },
      { label: '改说明…', onSelect: () => void promptText(nodeId, 'description') },
      'separator',
      { label: '删除步骤…', danger: true, onSelect: () => void promptDelete(nodeId) },
    ])
  }

  /**
   * 「添加步骤」的任务化入口（P0-2）：只有三种明确的创建方式，
   * 自由文本 action 不进普通创建流程（改 action 在检查器里受词表约束地选）。
   */
  function addStepEntries (upstream?: string): MenuEntry[] {
    const ready = document.value !== null
    return [
      {
        label: upstream === undefined ? '调用已有业务功能…' : `调用已有业务功能（作为 ${upstream} 的下游）…`,
        disabled: !ready || catalog.value.scripts.length === 0,
        onSelect: () => void promptScriptStep(upstream),
      },
      { label: '使用平台动作…', disabled: !ready, onSelect: () => void promptPlatformStep(upstream) },
      { label: '添加等待步骤', disabled: !ready, onSelect: () => void createWaitStep(upstream) },
    ]
  }

  function showBlankMenu (x: number, y: number): void {
    const entries: MenuEntry[] = [
      ...addStepEntries(),
      'separator',
      { label: '缩放到适应', disabled: document.value === null, onSelect: () => canvas?.fit() },
      { label: '重置缩放 100%', disabled: document.value === null, onSelect: () => canvas?.resetZoom() },
    ]
    showContextMenu(x, y, entries)
  }

  function showEdgeMenu (from: string, to: string, x: number, y: number): void {
    const isImplicit = from === TRIGGER_NODE_ID
    showContextMenu(x, y, [
      {
        label: isImplicit ? '这是隐式依赖（无 needs），不可断开' : `断开 ${from} → ${to}`,
        danger: !isImplicit,
        disabled: isImplicit,
        onSelect: () => {
          void requestDisconnect(from, to)
        },
      },
    ])
  }

  /**
   * 断一条依赖。
   *
   * ⚠️ 第一次调用**不带 force**：命令会先把「还指着这个上游的取值」列出来。
   * 用户确认后才带 force 再来一次 —— 自动删那些接线等于替用户丢配置。
   */
  async function requestDisconnect (from: string, to: string): Promise<void> {
    const context = commandContext()
    if (context === null || session === null) return
    const first = await session.dispatch(() => prepareDisconnectDependency(context, { from, to }))
    if (first.status !== 'rejected' || first.impacts === undefined || first.impacts.length === 0) {
      reportOutcome(first, `已断开 ${from} → ${to}`)
      return
    }
    const confirmed = await showDialog({
      title: `断开 ${from} → ${to}`,
      body: [
        `${to} 还有 ${first.impacts.length} 处取值引用了 ${from} 的产出，断开后它们会无法解析：`,
        ...first.impacts.map(impact => `· ${impact.at} = ${impact.current}`),
        '这些取值不会被自动删除，断开后请自己修改。',
      ],
      confirmLabel: '仍要断开',
      danger: true,
    })
    if (confirmed === null) return
    const again = session.workflowContext()
    if (again === null) return
    reportOutcome(
      await session.dispatch(() => prepareDisconnectDependency(again, { from, to, force: true })),
      `已断开 ${from} → ${to}`,
    )
  }

  async function requestConnect (from: string, to: string): Promise<void> {
    const context = commandContext()
    if (context === null || session === null) return
    // ⓘ 环检查、自环、重复、触发器合成节点全在命令里判 —— 画布不自己再判一套
    //   （两套判据必然漂移，而漂移的表现是「画布允许连、命令拒绝」）。
    reportOutcome(
      await session.dispatch(() => prepareConnectDependency(context, { from, to })),
      `已连接 ${from} → ${to}（写入 ${to}.needs）`,
    )
  }

  /**
   * 从面板拖拽/点击创建一个步骤。
   *
   * 不弹对话框问 id：拖进来的那一刻用户要的是「先有个节点」，
   * 改名在检查器里一步就能做。id 由 action 派生并去重，比 step-1/step-2 可读。
   *
   * ⚠️ 脚本步必须**明确**是哪个业务功能（P0-2）：
   *   - 拖业务功能条目进来：scriptId 随拖拽携带，落成对它的调用；
   *   - 其它入口（点「调用已有业务功能」）：先让用户选，没选不建节点。
   * 从前这里默默取 scripts[0]，于是面板拖进来的节点绑到一个用户没选过的功能上 ——
   * 看起来成功了，实际调的是另一段代码。
   */
  async function createStep (action: string, upstream?: string, scriptId?: string): Promise<void> {
    const current = document.value
    if (current === null) {
      status.set('先选一个工作流文件，再从左侧拖节点进来。', true)
      return
    }
    const context = commandContext()
    if (context === null || session === null) return
    if (action === catalog.value.scriptAction) {
      if (scriptId === undefined || scriptId === '') {
        await promptScriptStep(upstream)
        return
      }
      await createScriptStep(scriptId, upstream)
      return
    }
    const id = uniqueStepId(action)
    const outcome = await session.dispatch(() => prepareAddStep(context, {
      id,
      action,
      ...(upstream === undefined ? {} : { upstream }),
    }))
    if (!reportOutcome(outcome)) return
    select(id)
    // 新节点在最底层，多半落在视口外；不滚过去用户会以为没生效
    canvas?.revealNode(id)
    status.set(
      upstream === undefined
        ? `已新增步骤 ${id}`
        : `已新增步骤 ${id}（依赖 ${upstream}）`,
    )
  }

  /**
   * 「使用平台动作」对话框（P0-2）：动作从受审词表里选，不提供自由输入。
   * 未知 action（包括插件自定义 plugin.*）经源码编辑，不进普通创建流程。
   */
  async function promptPlatformStep (upstream?: string): Promise<void> {
    const steps = catalog.value.fixedSteps
    if (steps.length === 0) {
      status.set('平台动作目录未加载，无法列出可用的平台动作。', true)
      return
    }
    const result = await showDialog({
      title: '使用平台动作',
      body: [
        upstream === undefined
          ? '动作来自平台动作目录；选中步骤后，在右侧检查器里配置参数取值。'
          : `将以 ${upstream} 作为前置步骤（写入 needs）。`,
      ],
      fields: [
        {
          kind: 'select',
          name: 'action',
          label: '平台动作',
          value: '',
          options: [
            { value: '', label: '（选择平台动作）' },
            ...steps.map(step => ({
              value: step.action,
              label: `${step.displayName ?? step.action} —— ${step.action}`,
            })),
          ],
          hint: '选项格式：中文名 —— 机器 action。',
        },
        { kind: 'text', name: 'id', label: '步骤标识', required: true, placeholder: 'dispatch', hint: '引用路径按点分段，只能用字母/数字/下划线/连字符。' },
      ],
      confirmLabel: '添加',
    })
    if (result === null) return
    const action = String(result.action ?? '')
    if (action === '') {
      status.set('未添加步骤：要先选择一个平台动作。', true)
      return
    }
    const context = commandContext()
    if (context === null || session === null) return
    const id = String(result.id)
    const outcome = await session.dispatch(() => prepareAddStep(context, {
      id,
      action,
      ...(upstream === undefined ? {} : { upstream }),
    }))
    if (!reportOutcome(outcome, `已新增步骤 ${id}（${action}）`)) return
    select(id)
    canvas?.revealNode(id)
  }

  /** 「添加等待步骤」：wait_signal 是唯一挂起动作，一步建成（P0-2）。 */
  async function createWaitStep (upstream?: string): Promise<void> {
    const wait = catalog.value.fixedSteps.find(step => step.kind === 'await_signal')
    if (wait === undefined) {
      status.set('平台动作目录里没有等待类动作，无法添加等待步骤。', true)
      return
    }
    const context = commandContext()
    if (context === null || session === null) return
    const id = uniqueStepId(wait.action)
    const outcome = await session.dispatch(() => prepareAddStep(context, {
      id,
      action: wait.action,
      ...(upstream === undefined ? {} : { upstream }),
    }))
    if (!reportOutcome(outcome, `已新增等待步骤 ${id}`)) return
    select(id)
    canvas?.revealNode(id)
  }

  /**
   * 建一个调用**已有业务功能**的节点（E4「复用已有功能」）。
   *
   * ★ 复用时**只建 FlowStep**：不复制脚本、不动清单。同一个功能被多个节点调用
   *   是正常用法（功能 ID 与节点 ID 是两回事，见方案 §3.1.1）。
   */
  async function createScriptStep (scriptId: string, upstream?: string): Promise<void> {
    const context = commandContext()
    if (context === null || session === null) return
    const id = uniqueStepId(scriptId)
    const outcome = await session.dispatch(() => prepareAddStep(context, {
      id,
      action: catalog.value.scriptAction,
      scriptId,
      ...(upstream === undefined ? {} : { upstream }),
    }))
    if (!reportOutcome(outcome, `已新增节点 ${id}（调用 ${scriptId}）`)) return
    select(id)
    canvas?.revealNode(id)
  }

  /**
   * 「调用已有业务功能」：让用户**明确**选一个功能（P0-2）。
   *
   * ★ 下拉不预选任何项 —— 哪怕只有一个功能。自动选第一项的旧默认
   *   会在多脚本项目里把调用绑到用户没选过的功能上。
   */
  async function promptScriptStep (upstream?: string): Promise<void> {
    const scripts = catalog.value.scripts
    if (scripts.length === 0) {
      await promptCreateScriptFunction(upstream === undefined ? {} : { upstream })
      return
    }
    const result = await showDialog({
      title: '调用已有业务功能',
      body: [
        '复用已有功能只会新建一个调用节点，不会复制脚本或清单条目。',
        '参数取值在选中步骤后于右侧检查器里配置。',
      ],
      fields: [{
        kind: 'select',
        name: 'scriptId',
        label: '业务功能',
        value: '',
        options: [
          { value: '', label: '（选择业务功能）' },
          ...scripts.map(script => ({
            value: script.id,
            label: script.description === undefined ? script.id : `${script.id} —— ${script.description}`,
          })),
        ],
      }],
      confirmLabel: '加入画布',
      cancelLabel: '改为新建功能…',
      // 只有主动点底部这个键才切分支；右上角 X / Esc 是关闭，结果仍为 null。
      cancelResult: { action: 'create' },
    })
    if (result === null) return
    if (result.action === 'create') {
      await promptCreateScriptFunction(upstream === undefined ? {} : { upstream })
      return
    }
    const scriptId = String(result.scriptId ?? '')
    if (scriptId === '') {
      status.set('未添加节点：要先选择一个业务功能。', true)
      return
    }
    await createScriptStep(scriptId, upstream)
  }

  /**
   * 新建业务功能（E4「新建功能」；P0-1/P0-5 重排）。
   *
   * ⚠️ 这是一条**跨三个文件**的命令：清单条目 + 源码文件 + 流程节点（或接线）。
   * 它要么整条成，要么一个字节都不写（applyPrepared 的前置核验保证）。
   *
   * ★ 脚本路径按工程语言档案派生：TypeScript 工程 → adapters/<id>.ts（命名导出），
   *   JavaScript 工程 → adapters/<id>.js（goja ES5.1）。对话框里可以改，留空即派生。
   *
   * ★ 检查器入口传 `bindStepId`：节点已经在了，命令只写 inputs.script.const，
   *   不再新建节点 —— 两条入口共用同一条原子命令，不再有服务端旁路（P0-5）。
   *
   * ⓘ I/O 声明不在这个对话框里填：对话框只支持文本/下拉/勾选，塞不下可增删的
   *   I/O 数组。新建后在检查器的「功能契约」页签里改（走 ChangeScriptIO 命令）。
   */
  async function promptCreateScriptFunction (options: { upstream?: string; bindStepId?: string } = {}): Promise<void> {
    if (session === null) return
    if (catalog.value.pluginManifestPath === '') {
      status.set('没找到后端插件清单（fh2-plugin.json），无法新建业务功能。', true)
      return
    }
    const language = catalog.value.scriptLanguage
    const bindMode = options.bindStepId !== undefined
    const result = await showDialog({
      title: bindMode ? `为节点 ${options.bindStepId} 新建业务功能` : '新建业务功能',
      body: [
        bindMode
          ? `会同时修改三处：清单 scripts[] 条目、源码文件、步骤 ${options.bindStepId} 的参数取值。`
          : '会同时写三处：清单 scripts[] 条目、源码文件、画布上的调用节点。',
        language === 'typescript'
          ? '当前工程是 TypeScript：源码生成命名导出的 .ts，构建器经 esbuild 打包。'
          : '当前工程是 JavaScript：源码按 goja（ES5.1）装载，不经打包。',
        '参数与返回结果的声明建好后在检查器的「参数与返回值」页签里改。',
      ],
      fields: [
        { kind: 'text', name: 'name', label: '功能 ID', required: true, placeholder: 'build_notice', hint: '写进 inputs.script.const，与文件路径解耦' },
        { kind: 'text', name: 'description', label: '说明', placeholder: '拼通知文案' },
        {
          kind: 'text',
          name: 'path',
          label: '脚本路径（留空自动派生）',
          placeholder: defaultScriptPath('功能ID', language),
          hint: `相对清单所在目录；留空按 ${language === 'typescript' ? 'adapters/<功能ID>.ts' : 'adapters/<功能ID>.js'} 派生`,
        },
        ...(bindMode
          ? []
          : [{ kind: 'text' as const, name: 'stepId', label: '节点 id', required: true, placeholder: 'notice' }]),
      ],
      confirmLabel: '新建',
    })
    if (result === null) return

    const context = session.scriptContext()
    if (context === null) {
      status.set('读不到插件清单，无法新建业务功能。', true)
      return
    }
    const name = String(result.name).trim()
    const pathText = String(result.path ?? '').trim()
    const outcome = await session.dispatch(() => prepareCreateScriptAndBind(context, {
      name,
      path: pathText === '' ? defaultScriptPath(name, language) : pathText,
      ...(String(result.description ?? '').trim() === '' ? {} : { description: String(result.description).trim() }),
      stepId: bindMode ? options.bindStepId! : String(result.stepId).trim(),
      ...(options.upstream === undefined || bindMode ? {} : { upstream: options.upstream }),
      ...(bindMode ? { bindExisting: true } : {}),
    }))
    if (!reportOutcome(outcome, bindMode
      ? `已新建业务功能 ${name} 并接到 ${options.bindStepId}`
      : `已新建业务功能 ${name} 并加入画布`)) {
      return
    }

    // 新建之后直接把源码打开：用户下一步就是去写实现。
    if (outcome.status === 'applied' && outcome.focus?.openPath !== undefined) {
      await openScriptSource(outcome.focus.openPath)
    }
    // 清单变了 → 功能目录要跟着刷新，否则新功能在面板里看不到。
    await workspace.refreshCatalog(path.value ?? undefined)
  }

  // ── 业务功能的 I/O 契约（检查器「功能契约」段） ──

  /**
   * 一份业务功能当前的 I/O 声明。
   *
   * ★ 取自**内存里的清单**（catalog 这个 computed 已从 documentService 派生），
   *   不取 `/api/actions` —— 后者读的是磁盘上那一份，用户还没保存的改动看不见，
   *   而看不见的后果是：编辑器里显示旧声明，一保存就把新改的覆盖回去。
   *
   * 回 null = 这个功能不在清单里（或清单这一刻读不出来）。两种都不该显示一个空表单
   * 让用户以为「它没有声明」。
   */
  function scriptContractOf (scriptId: string): {
    readonly inputs: readonly ActionField[];
    readonly outputs: readonly ActionField[];
  } | null {
    const script = catalog.value.scripts.find(item => item.id === scriptId)
    if (script === undefined) return null
    return { inputs: script.inputs, outputs: script.outputs }
  }

  /**
   * 保存一份业务功能的 I/O 声明（命令 13 ChangeScriptIO）。
   *
   * 拒绝时若带 impacts（删出参 / 从透传改成声明出参），先把受影响的接线摊给用户看，
   * 确认后再带 force 重发 —— 不自动改那些接线，也不替用户决定。
   */
  async function saveScriptContract (
    scriptId: string,
    io: { readonly inputs: readonly ScriptIoField[]; readonly outputs: readonly ScriptIoField[] },
  ): Promise<boolean> {
    if (session === null) {
      status.set('编辑器尚未就绪，请稍后重试。', true)
      return false
    }
    const context = session.scriptContext()
    if (context === null) {
      status.set('读不到插件清单，无法修改参数与返回值。', true)
      return false
    }

    const send = async (force: boolean): Promise<DispatchOutcome> =>
      session!.dispatch(() => prepareChangeScriptIo(context, { name: scriptId, ...io, ...(force ? { force: true } : {}) }))

    let outcome = await send(false)
    if (outcome.status === 'rejected' && outcome.impacts !== undefined && outcome.impacts.length > 0) {
      const confirmed = await showDialog({
        title: `${scriptId} 的出参声明会影响已有取值`,
        body: [
          outcome.reason,
          '以下取值在修改后取不到值。它们不会被自动修改，请自己决定是修改取值还是修改声明：',
          ...outcome.impacts.map(item => `· ${item.stepId} 的 ${item.at}（${item.current}）：${item.why}`),
        ],
        fields: [],
        confirmLabel: '仍要保存',
      })
      if (confirmed === null) return false
      outcome = await send(true)
    }
    if (!reportOutcome(outcome, `已更新 ${scriptId} 的 I/O 声明`)) return false
    // 清单变了 → 词表跟着刷新，否则别处（入参映射表）还按旧声明画。
    await workspace.refreshCatalog(path.value ?? undefined)
    return true
  }

  /** 由 action 派生一个不重名的 step id：`run_script` → `run-script`、`run-script-2`… */
  function uniqueStepId (action: string): string {
    const current = document.value
    if (current === null) return action
    const base = action.replace(/^plugin\./, '').replaceAll('_', '-')
    if (!hasStep(current, base)) return base
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base}-${index}`
      if (!hasStep(current, candidate)) return candidate
    }
    return `${base}-${Date.now()}`
  }

  // ── 检查器编辑入口 ──

  /**
   * 提交一条入参接线（P0-3：完整 InputSpec 命令，一次一档）。
   *
   * ★ 只在用户**确认了具体来源/固定值**之后调用：模式切换本身不写文档
   *   （草稿状态在 Inspector 组件里），这里的每一次调用都对应一次明确的确认。
   * 校验（引用路径、闭包、const 类型）走 SetInput 命令，被拒时如实报理由。
   */
  async function commitInput (stepId: string, key: string, mode: 'from' | 'const' | 'clear', value?: unknown): Promise<void> {
    const context = commandContext()
    if (context === null || session === null) return
    const outcome = await session.dispatch(() => prepareSetInput(context, {
      stepId,
      key,
      mode,
      ...(mode === 'clear' ? {} : { value }),
    }))
    reportOutcome(outcome)
  }

  function setInput (stepId: string, key: string, mode: 'from' | 'const', value: unknown): void {
    void commitInput(stepId, key, mode, value)
  }

  function clearInput (stepId: string, key: string): void {
    void commitInput(stepId, key, 'clear')
  }

  function setAction (stepId: string, action: string): void {
    const current = document.value
    if (current !== null && setStepText(current, stepId, 'action', action)) markDirty()
  }

  /**
   * 选择业务功能（P0-6：script 是步级元参数，专用控件生成 const）。
   * 空串 = 清除选择。
   */
  function setScript (stepId: string, scriptId: string): void {
    if (scriptId === '') {
      void commitInput(stepId, 'script', 'clear')
      return
    }
    void commitInput(stepId, 'script', 'const', scriptId)
  }

  /** 连接配置（P0-6：connectorId 同为元参数，专用控件生成 const）。 */
  function setConnector (stepId: string, connectorId: string): void {
    if (connectorId === '') {
      void commitInput(stepId, 'connectorId', 'clear')
      return
    }
    void commitInput(stepId, 'connectorId', 'const', connectorId)
  }

  // ── P1-5：执行策略（allSucceeded/allDone、延迟、超时、重试） ──

  function setStepTriggerValue (stepId: string, value: string): void {
    const current = document.value
    if (current !== null && setStepTrigger(current, stepId, value)) markDirty()
  }

  function setStepNumberValue (stepId: string, field: 'timeoutSec' | 'maxAttempts' | 'delaySec', value: number | null): void {
    const current = document.value
    if (current !== null && setStepNumber(current, stepId, field, value)) markDirty()
  }

  // ── 等待与回调（P1-2「等待与回调」页签；null = 删除该段） ──

  function setStepAwaitSpec (
    stepId: string,
    kind: 'await' | 'callback',
    spec: { readonly signal: string; readonly timeoutSec?: number } | null,
  ): void {
    const current = document.value
    if (current !== null && setStepAwait(current, stepId, kind, spec)) markDirty()
  }

  /**
   * 添加等待/回调段：显式收信号名与可选超时（P1-2）。
   *
   * ★ 不造空段：`{}` 的 await 过不了 schema（signal 必填），而「先建个空壳再填」
   *   正是 P0-4 要消灭的半成品路径。超时给 120 秒是有界默认（无界挂起是死等）。
   */
  async function promptAddAwait (stepId: string, section: 'await' | 'callback'): Promise<void> {
    const result = await showDialog({
      title: section === 'await' ? '添加等待' : '添加回调',
      body: [
        '信号名是这一步挂起等谁回话的标识。',
        section === 'callback' ? '回调段等外部系统异步完成后再继续。' : '等待段等人在环信号。',
      ],
      fields: [
        { kind: 'text', name: 'signal', label: '信号名', required: true, placeholder: 'operator_ack' },
        { kind: 'text', name: 'timeoutSec', label: '等待上限（秒；留空 = 无上限）', placeholder: '120' },
      ],
      confirmLabel: '添加',
    })
    if (result === null) return
    const signal = String(result.signal ?? '').trim()
    if (signal === '') {
      status.set('信号名不能为空。', true)
      return
    }
    const timeoutText = String(result.timeoutSec ?? '').trim()
    const timeout = Number(timeoutText)
    const spec = {
      signal,
      ...(timeoutText !== '' && Number.isFinite(timeout) && timeout > 0 ? { timeoutSec: Math.floor(timeout) } : {}),
    }
    const current = document.value
    if (current !== null && setStepAwait(current, stepId, section, spec)) markDirty()
  }

  /**
   * 改挂起段的单个字段（P1-2）。value 为 null/'' = 删字段；
   * provides/optional 的对象形态等未知写法由 core 原样保留（见 setStepSectionField ★）。
   */
  function setAwaitField (stepId: string, section: 'await' | 'callback', field: string, value: unknown): void {
    const current = document.value
    if (current !== null && setStepSectionField(current, stepId, section, field, value)) markDirty()
  }

  /** 改 when 叶子条件的单个字段（P1-5）；组合条件在 UI 里只读（源码编辑）。 */
  function setWhenField (stepId: string, field: 'field' | 'op' | 'value', value: unknown): void {
    const current = document.value
    if (current !== null && setStepWhenField(current, stepId, field, value)) markDirty()
  }

  /** 添加执行条件骨架（显式动作；缺 field 由语义校验标红，不写任何业务默认值）。 */
  function addCondition (stepId: string): void {
    const current = document.value
    if (current === null) return
    if (ensureStepWhen(current, stepId, catalog.value.conditionOps[0] ?? 'eq')) markDirty()
  }

  /** 删除执行条件（when 整段）：这一步恢复为总是执行（与添加条件同通道的显式动作）。 */
  function removeCondition (stepId: string): void {
    const current = document.value
    if (current !== null && removeStepWhen(current, stepId)) markDirty()
  }

  // ── P0-4：Trigger 轴的显式启用/停用 ──

  /**
   * 确认启用一条启动方式：**一次性**提交完整结构（草稿在 Inspector 里配好）。
   * 不写任何生产默认值 —— intervalSec 等必填字段缺着时由语义校验标红。
   */
  function applyTriggerAxis (axis: string, spec: Record<string, unknown>): void {
    const current = document.value
    if (current !== null && setTriggerAxis(current, axis, spec)) markDirty()
  }

  /**
   * 停用一条启动方式（P0-4）。
   *
   * ★ 非空配置先二次确认：把「将删除的字段」摊开 —— 取消勾选不该是
   *   一个悄悄丢配置的入口。可暂停的轴（schedule）优先提供「暂停」，
   *   不鼓励用删除表达临时停用。
   */
  async function disableTriggerAxis (axis: string): Promise<void> {
    const current = document.value
    if (current === null) return
    const trigger = current.raw.trigger
    const spec = typeof trigger === 'object' && trigger !== null && !Array.isArray(trigger)
      ? (trigger as Record<string, unknown>)[axis]
      : undefined
    const fields = typeof spec === 'object' && spec !== null && !Array.isArray(spec)
      ? Object.keys(spec as Record<string, unknown>)
      : []
    if (fields.length === 0) {
      if (setTriggerAxis(current, axis, null)) markDirty()
      return
    }
    const pausable = axis === 'schedule' && (spec as Record<string, unknown>).paused !== true
    const result = await showDialog({
      title: `停用「${TRIGGER_AXIS_LABELS[axis]?.label ?? axis}」`,
      body: [
        `将删除以下 ${fields.length} 项配置：${fields.join('、')}。`,
        ...(pausable
          ? ['临时不想让它跑的话，可以改为「暂停」：配置保留，平台只是跳过调度。']
          : []),
      ],
      fields: pausable
        ? [{ kind: 'checkbox', name: 'pause', label: '暂停此定时任务（保留配置）' }]
        : [],
      confirmLabel: '停用并删除配置',
      danger: true,
    })
    if (result === null) return
    if (pausable && result.pause === true) {
      const next = { ...(spec as Record<string, unknown>), paused: true }
      if (setTriggerAxis(current, axis, next)) markDirty()
      status.set(`已暂停「${TRIGGER_AXIS_LABELS[axis]?.label ?? axis}」（配置保留）。`)
      return
    }
    if (setTriggerAxis(current, axis, null)) markDirty()
  }

  function setTriggerFieldValue (axis: string, field: string, value: unknown): void {
    const current = document.value
    if (current !== null && setTriggerField(current, axis, field, value)) markDirty()
  }

  // ── 节点级弹窗编辑 ──

  async function promptRename (id: string): Promise<void> {
    const current = document.value
    if (current === null) return
    const result = await showDialog({
      title: `重命名步骤 ${id}`,
      body: ['其它步骤 needs 里对它的引用会同步改掉。'],
      fields: [{ kind: 'text', name: 'id', label: '新的 step id', required: true, value: id }],
      confirmLabel: '重命名',
    })
    if (result === null || current !== document.value) return
    const next = String(result.id)
    const context = commandContext()
    if (context === null || session === null) return
    // ★ 命令会把五种引用站点（needs / inputs.from / when.field / await+callback.timeoutSecFrom）
    //   一起改掉；从前这里只改 needs，漏掉的那几处会让接线静默指向旧 id。
    if (!reportOutcome(await session.dispatch(() => prepareRenameStep(context, { from: id, to: next })))) return
    select(next)
  }

  /** 改步骤说明；action 的修改走检查器的受审词表下拉（P0-2：不留自由文本入口）。 */
  async function promptText (id: string, field: 'description'): Promise<void> {
    const current = document.value
    const node = nodeById(id)
    if (current === null || node === undefined) return
    const result = await showDialog({
      title: `修改 ${id} 的说明`,
      body: ['留空表示删除该字段。'],
      fields: [{
        kind: 'text',
        name: 'value',
        label: '说明（description）',
        value: node.description ?? '',
      }],
    })
    if (result === null || current !== document.value) return
    if (setStepText(current, id, field, String(result.value))) markDirty()
  }

  async function promptTriggerDescription (): Promise<void> {
    const current = document.value
    if (current === null) return
    const node = nodeById(TRIGGER_NODE_ID)
    const result = await showDialog({
      title: '修改触发器 description',
      body: ['留空表示删除该字段。触发种类本身请在编辑器里改 —— 改种类会连带改 trigger 下整个子结构。'],
      fields: [{ kind: 'text', name: 'value', label: 'description', value: node?.description ?? '' }],
    })
    if (result === null || current !== document.value) return
    if (setTriggerDescription(current, String(result.value))) markDirty()
  }

  /**
   * 删一个步骤。
   *
   * ★★ 影响清单**由命令算**，不再由画布自己扫 edges：命令看的是全部五种引用站点，
   * 而 edges 只有 needs —— 从前这个对话框只提「下游 needs 会被摘除」，
   * 而 `inputs.*.from` / `when.field` 那几处引用它的地方一个字都没提，
   * 用户确认删除后那些接线就成了指向不存在步骤的悬空引用。
   *
   * ⚠️ 确认之后带 force 重来，且**不自动清理**那些引用（替用户删等于替他丢配置）。
   */
  async function promptDelete (id: string): Promise<void> {
    const context = commandContext()
    if (context === null || session === null) return
    const first = await session.dispatch(() => prepareRemoveStep(context, { id }))
    if (first.status !== 'rejected' || first.impacts === undefined || first.impacts.length === 0) {
      if (reportOutcome(first, `已删除步骤 ${id}`)) select(null)
      return
    }
    const result = await showDialog({
      title: `删除步骤 ${id}`,
      body: [
        `以下 ${first.impacts.length} 处配置引用了它，删除后会指向一个不存在的步骤：`,
        ...first.impacts.map(impact => `· ${impact.stepId} 的 ${impact.at} = ${impact.current}`),
        '它们不会被自动清理 —— 删除后请自己改。',
      ],
      confirmLabel: '仍要删除',
      danger: true,
    })
    if (result === null) return
    const again = session.workflowContext()
    if (again === null) return
    if (reportOutcome(await session.dispatch(() => prepareRemoveStep(again, { id, force: true })), `已删除步骤 ${id}`)) {
      select(null)
    }
  }

  return {
    bindDocuments,
    document,
    revision,
    path,
    dirty,
    candidates,
    selectedCandidate,
    selectedId,
    model,
    context,
    semanticIssues,
    bindingStatuses,
    bindingStateOf,
    catalog,
    schema,
    loaded,
    selectedNode,
    stepCount,
    needsEdgeCount,
    errorIssueCount,
    warningIssueCount,
    noticeMessages,
    noticeEvidence,
    noticeOverride,
    attachCanvas,
    fitCanvas,
    zoomCanvas,
    resetZoomCanvas,
    load,
    save,
    saveRelated,
    registerDraftFlush,
    draftEpoch,
    saveWhenDirty,
    relatedPaths,
    relatedDirty,
    dirtyDocumentCount,
    checkConfig,
    refreshCanvas,
    reloadFromDisk,
    promptCreateWorkflow,
    revealWorkflowNode,
    focusRequest,
    createScriptStep,
    promptScriptStep,
    promptPlatformStep,
    createWaitStep,
    promptCreateScriptFunction,
    scriptContractOf,
    saveScriptContract,
    setAfterSaveHook,
    setOpenScriptHook,
    openScriptSource,
    activate,
    reset,
    onExternalChange,
    setCandidates,
    select,
    showNodeMenu,
    showBlankMenu,
    showEdgeMenu,
    addStepEntries,
    requestConnect,
    createStep,
    commitInput,
    setInput,
    clearInput,
    setAction,
    setScript,
    setConnector,
    setStepTriggerValue,
    setStepNumberValue,
    promptAddAwait,
    setStepAwaitSpec,
    setAwaitField,
    setWhenField,
    addCondition,
    removeCondition,
    applyTriggerAxis,
    disableTriggerAxis,
    setTriggerFieldValue,
    mountScriptEditor,
    disposeScriptEditor,
    promptRename,
    promptText,
    promptTriggerDescription,
    promptDelete,
    nodeById,
    rawStepById,
  }
})
