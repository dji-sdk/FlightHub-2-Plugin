<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { TRIGGER_AXIS_LABELS, useWorkflowStore } from '../store.js'
import { constString } from '../../workflow/semantics'
import { resolveStepIO } from '../../workflow/catalog'
import { SCRIPT_META_INPUT_NAMES } from '../../../../../src/workflow/core/step-commands.js'
import { describeBindingState } from '../../../../../src/workflow/core/binding-status.js'
import { refCandidates } from '../../../../../src/workflow/core/inputs.js'
import type { RefCandidate } from '../../../../../src/workflow/core/inputs.js'
import PairRowsField from '../../../components/common/PairRowsField.vue'
import KeyListField from './KeyListField.vue'
import SeedField from './SeedField.vue'
import ScriptContractEditor from './ScriptContractEditor.vue'
import { createConstInputDrafts } from './input-draft'

/**
 * 节点检查器（P1-2 拆成任务页签）：节点调用 / 功能契约 / JS 实现 / 执行条件 /
 * 等待与回调 / 技术详情。
 *
 * 页签标题明确作用范围：「共享业务功能（影响 N 个调用方）」这类句子回答的是
 * 「我在这里改的东西影响谁」—— 不说清，用户会在以为只改本节点的地方改了契约。
 *
 * P0-3：入参「暂不设置 / 引用上游数据 / 填写固定值」三态是**草稿**——
 * 切换模式不写文档，确认具体来源/固定值后才产生一次命令提交。
 */

type JsonRecord = Record<string, unknown>

const workflow = useWorkflowStore()

function isRecord (value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const selected = computed(() => {
  void workflow.revision
  return workflow.selectedNode
})

const step = computed<JsonRecord | undefined>(() => {
  void workflow.revision
  const id = selected.value?.kind === 'step' ? selected.value.id : null
  return id === null ? undefined : workflow.rawStepById(id)
})

const stepId = computed(() => selected.value?.kind === 'step' ? selected.value.id : null)

const triggerSpec = computed<JsonRecord>(() => {
  void workflow.revision
  const raw = workflow.document?.raw
  return isRecord(raw?.trigger) ? raw.trigger as JsonRecord : {}
})

const nodeIssues = computed(() => {
  const id = selected.value?.id
  if (id === undefined) return []
  return workflow.semanticIssues.filter(issue => issue.nodeId === id)
})

/**
 * 当前节点的绑定完整度（计划 §E5）。
 *
 * ⚠️ 文案取自 `describeBindingState` 而不是在模板里另写一套：
 * 那句话里**刻意不出现**「通过 / 可部署 / 已验证」——本轮没有同版本权威 checker，
 * 而检查器是用户最容易把「绿了」读成「能上线」的地方。
 */
const bindingStatus = computed(() => {
  void workflow.revision
  const id = selected.value?.id
  if (id === undefined) return null
  return workflow.bindingStateOf.get(id) ?? null
})

const bindingText = computed(() =>
  bindingStatus.value === null ? '' : describeBindingState(bindingStatus.value.state))

const action = computed(() =>
  selected.value?.kind === 'step' && typeof step.value?.action === 'string' ? step.value.action : '')

const scriptId = computed(() => {
  const id = selected.value?.id
  return id === undefined ? undefined : constString(step.value ?? {}, 'script')
})

const connectorId = computed(() => {
  const id = selected.value?.id
  return id === undefined ? undefined : constString(step.value ?? {}, 'connectorId')
})

const io = computed(() => resolveStepIO(workflow.catalog, action.value, scriptId.value))

/** P0-6：元参数不进普通业务参数列表 —— 由专用控件（功能选择器/连接配置）负责。 */
const businessInputs = computed(() =>
  io.value.inputs.filter(field => !SCRIPT_META_INPUT_NAMES.includes(field.name)))

const candidates = computed<readonly RefCandidate[]>(() => {
  const context = workflow.context
  const id = selected.value?.id
  if (context === null || id === undefined) return []
  return refCandidates(context, id)
})

/** P1-4：来源按业务分组 —— 启动时带入的数据 / 前置步骤的结果 / 本次运行信息。 */
const SOURCE_GROUPS: Readonly<Record<RefCandidate['group'], string>> = {
  trigger: '启动时带入的数据',
  steps: '前置步骤的结果',
  run: '本次运行信息',
}

/** 该功能的调用方数量（P1-2：契约页签的作用范围说明）。 */
const callerCount = computed(() => {
  void workflow.revision
  const raw = workflow.document?.raw
  const current = scriptId.value
  if (raw == null || current === undefined || current === '') return 0
  const steps = Array.isArray(raw.steps)
    ? raw.steps.filter((item): item is JsonRecord => isRecord(item))
    : []
  return steps.filter(item =>
    isRecord(item.inputs) && isRecord(item.inputs.script)
    && (item.inputs.script as JsonRecord).const === current).length
})

// ── 页签（P1-2） ──

const STEP_TABS = [
  { key: 'invoke', label: '步骤设置' },
  { key: 'contract', label: '参数与返回值' },
  { key: 'source', label: '脚本实现' },
  { key: 'condition', label: '执行条件' },
  { key: 'await', label: '等待与回调' },
  { key: 'tech', label: '技术详情' },
] as const

const activeTab = ref<(typeof STEP_TABS)[number]['key']>('invoke')

/**
 * 挂起能力判据（tab 按节点能力裁剪）：平台契约里唯一的挂起专属动作是
 * await_signal（wait_signal ——「等信号，不跑 activity」），真实流程的
 * await/callback 也只落在这类步上。已声明挂起段的步（手工 JSON / 历史
 * 文档）必须保留页签 —— 否则已有配置失去编辑与删除的入口。
 */
const canSuspend = computed(() => {
  const current = step.value
  if (current === undefined) return false
  if (isRecord(current.await) || isRecord(current.callback)) return true
  return workflow.catalog.fixedSteps.find(item => item.action === action.value)?.kind === 'await_signal'
})

/** 脚本专属页签只在 run_script 步上有意义；等待与回调查挂起能力。 */
const visibleTabs = computed(() => STEP_TABS.filter(tab =>
  tab.key === 'invoke' || tab.key === 'condition' || tab.key === 'tech'
  || (io.value.isScript && (tab.key === 'contract' || tab.key === 'source'))
  || (canSuspend.value && tab.key === 'await')))

const focusInputKey = ref<string | null>(null)

/** P2-2：Problems 定位请求 → 滚动/高亮对应输入行 + 切到对应页签。 */
function applyFocusRequest (request: { readonly nodeId: string, readonly inputKey?: string } | null): void {
  if (request === null || request.nodeId !== stepId.value) return
  activeTab.value = 'invoke'
  focusInputKey.value = request.inputKey ?? null
  if (focusInputKey.value !== null) {
    void nextTick(() => {
      const row = document.querySelector(`.wf-input-row[data-input-key="${CSS.escape(focusInputKey.value ?? '')}"]`)
      row?.scrollIntoView({ block: 'center' })
    })
  }
}

// ── 入参行三态（P0-3：草稿 + 显式确认） ──

interface WiredInput {
  readonly mode: 'from' | 'const' | 'none'
  readonly from?: string
  readonly constValue?: unknown
}

function readWired (target: JsonRecord, key: string): WiredInput {
  if (!isRecord(target.inputs)) return { mode: 'none' }
  const spec = (target.inputs as JsonRecord)[key]
  if (!isRecord(spec)) return { mode: 'none' }
  if (typeof spec.from === 'string') return { mode: 'from', from: spec.from }
  if ('const' in spec) return { mode: 'const', constValue: spec.const }
  return { mode: 'none' }
}

/** 模板里 step 已在非空分支，但 TS 收窄不跨 v-if；经此入口统一兜底。 */
function wiredOf (key: string): WiredInput {
  const current = step.value
  return current === undefined ? { mode: 'none' } : readWired(current, key)
}

/**
 * 每行的草稿模式：`from` / `const`。
 * ★ 只改**草稿**，不写文档 —— 模式切换、关弹窗、按 ESC 都不产生任何变更；
 *   用户选定具体来源或输入固定值后才走一次命令提交。
 */
const inputDrafts = ref(new Map<string, 'from' | 'const'>())

function draftOf (key: string): 'from' | 'const' | null {
  return inputDrafts.value.get(`${stepId.value ?? ''}.${key}`) ?? null
}

/** 行的模式下拉当前值：已接线按文档；否则按草稿；都没有 = 暂不设置。 */
function rowMode (key: string): string {
  const wired = wiredOf(key)
  if (wired.mode !== 'none') return wired.mode
  return draftOf(key) ?? 'none'
}

function switchMode (field: { readonly name: string }, mode: string): void {
  const key = `${stepId.value ?? ''}.${field.name}`
  if (mode === 'none') {
    inputDrafts.value.delete(key)
    // 暂不设置 = 显式请求移除接线（一次明确的命令提交），没有接线时零变更。
    if (wiredOf(field.name).mode !== 'none' && stepId.value !== null) {
      void workflow.clearInput(stepId.value, field.name)
    }
    return
  }
  inputDrafts.value.set(key, mode as 'from' | 'const')
}

/** const 值按声明类型解析。类型对不上时原样回字符串，让语义校验去红（此处不吞错）。 */
function parseConstInput (raw: string, type: string): unknown {
  const text = raw.trim()
  switch (type) {
    case 'number': {
      const value = Number(text)
      return text === '' || Number.isNaN(value) ? text : value
    }
    case 'bool':
      if (text === 'true') return true
      if (text === 'false') return false
      return text
    case 'array':
    case 'object':
      try {
        return JSON.parse(text) as unknown
      } catch {
        return text
      }
    default:
      return text
  }
}

/** 光标还在输入框里就按保存时，先把它写进文档，再算保存计划。 */
const constDrafts = createConstInputDrafts(
  draft => commitConst({ name: draft.field, type: draft.type }, draft.raw, draft.stepId),
  () => workflow.draftEpoch,
)
let offDraftFlush: (() => void) | null = null
onMounted(() => {
  offDraftFlush = workflow.registerDraftFlush(() => constDrafts.flush())
})
onBeforeUnmount(() => {
  offDraftFlush?.()
  offDraftFlush = null
})

/**
 * 确认固定值（change/blur 时）。
 * ★ 空输入不提交：把「还没填」误写成 const '' 是最常见的一类意外写入；
 *   null/false/0 这些有意义的显式值照常提交（P0-3 的另一半要求）。
 */
async function commitConst (field: { readonly name: string, readonly type: string }, raw: string, stepIdOverride?: string): Promise<void> {
  const id = stepIdOverride ?? stepId.value
  if (id === null) return
  constDrafts.released(id, field.name)
  if (raw === '') return
  await workflow.commitInput(id, field.name, 'const', parseConstInput(raw, field.type))
}

/** 失焦事件可能晚于节点切换，只提交输入框所属节点的值。 */
function commitConstEvent (field: { readonly name: string, readonly type: string }, event: Event): void {
  const input = event.target as HTMLInputElement
  const id = input.dataset.stepId
  if (Number(input.dataset.draftEpoch) !== workflow.draftEpoch || id !== stepId.value) return
  void commitConst(field, input.value, id)
}

function commitFrom (field: { readonly name: string }, value: string): void {
  const id = stepId.value
  if (id === null || value === '') return
  void workflow.commitInput(id, field.name, 'from', value)
}

/** 秒数字段：空/非法 → null（= 删字段，用平台默认值）。 */
function parseSec (text: string): number | null {
  const value = Number(text.trim())
  return text.trim() === '' || !Number.isFinite(value) || value <= 0 ? null : Math.floor(value)
}

function formatConst (value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? ''
}

function rowIssues (key: string): { readonly level: string, readonly message: string }[] {
  return nodeIssues.value.filter(issue => issue.inputKey === key)
}

/** 未声明的入参（R2）：词表里没有但 JSON 里写了，必须让用户看得见才能删。 */
const extraInputs = computed(() => {
  void workflow.revision
  if (!io.value.resolved || step.value === undefined || !isRecord(step.value.inputs)) return []
  const declared = new Set(businessInputs.value.map(field => field.name))
  return Object.keys(step.value.inputs as JsonRecord)
    .filter(key => !declared.has(key) && !SCRIPT_META_INPUT_NAMES.includes(key))
})

// ── P0-4：trigger 轴的启用草稿 ──

/**
 * 新启用的轴先落在草稿里（不写文档）；字段配好后点「启用」一次性提交完整结构。
 * 取消勾选（或切走）= 草稿丢弃，文档零修改。
 */
const triggerDraft = ref<{ readonly axis: string, readonly fields: Record<string, unknown> } | null>(null)

/** 草稿里缺必填项时的提示（P0-4：不给合法生产默认值，缺了就拦下）。 */
const draftHint = ref<string | null>(null)

watch([stepId, () => workflow.draftEpoch], () => {
  // P2-4：切节点即清草稿与页签（回到默认页），不把上一个节点的编辑状态带过来。
  inputDrafts.value.clear()
  constDrafts.discard()
  triggerDraft.value = null
  activeTab.value = 'invoke'
  applyFocusRequest(workflow.focusRequest)
}, { flush: 'sync' })

// 当前页签被能力裁剪隐藏（如把执行动作从等待动作改成平台动作）时回到默认页，
// 避免 activeTab 指向不可见页签而照常渲染其内容。
watch(visibleTabs, (tabs) => {
  if (!tabs.some(tab => tab.key === activeTab.value)) activeTab.value = 'invoke'
})

watch(() => workflow.focusRequest, (request) => {
  applyFocusRequest(request)
}, { immediate: true })

function draftFieldLabels (axis: string): readonly { readonly key: string, readonly label: string, readonly required: boolean, readonly hint?: string }[] {
  switch (axis) {
    case 'schedule':
      return [
        { key: 'intervalSec', label: '执行间隔（秒）', required: true, hint: '必须显式给：采集一轮几十秒与人在环流程差几个量级，猜错就是白飞或漏飞。' },
        { key: 'executionTimeoutSec', label: '单次运行最长时间（秒）', required: false },
        { key: 'paused', label: '暂停此定时任务', required: false },
      ]
    case 'stream':
      return [
        { key: 'match', label: '事件筛选条件', required: true, hint: '键用消息原样的 snake_case（如 event_type）；一条不填会匹配到这条 stream 里的全部消息。' },
        { key: 'seed', label: '启动时带入流程的数据', required: false },
      ]
    case 'bizNotify':
      return [
        { key: 'subscriber', label: '订阅标识', required: true, hint: '通知数据里标识「这条是发给本插件的」的键名。' },
        { key: 'eventKind', label: '通知类型', required: false, hint: '留空 = dispatched。' },
        { key: 'seed', label: '启动时带入流程的数据', required: false },
      ]
    default:
      return [
        { key: 'seed', label: '启动时带入流程的数据', required: false, hint: '带什么数据进来由你的代码决定：键名自己起，平台没有固定清单。' },
      ]
  }
}

function onAxisCheckbox (axis: string, checked: boolean): void {
  if (checked) {
    // 轴已存在 = 普通“取消暂停”类开关？不 —— 已存在的轴不会出现未勾选态；
    // 这里只处理“新启用”：进入草稿，不写文档（P0-4）。
    if (!(axis in triggerSpec.value)) {
      triggerDraft.value = { axis, fields: {} }
    }
    return
  }
  // 停用已有轴：二次确认 + 暂停优先（store 里做确认）。
  void workflow.disableTriggerAxis(axis)
}

function cancelTriggerDraft (): void {
  triggerDraft.value = null
}

/** 确认启用：把草稿字段拼成完整结构一次性提交（P0-4）。 */
function commitTriggerDraft (): void {
  const draft = triggerDraft.value
  if (draft === null) return
  // DAG-018-05：词表未取到 = 禁用态。启用操作必须显式拒绝并给出原因，
  // 不能静默写入 manifest（禁用态下的每个编辑尝试都要能被单独评审）。
  if (workflow.context === null) {
    draftHint.value = '平台动作目录未取到（/api/actions 不可用），已拒绝启用此启动方式。'
    return
  }
  const labels = draftFieldLabels(draft.axis)
  const spec: JsonRecord = {}
  for (const field of labels) {
    const raw = draft.fields[field.key]
    // match（键=值 对象）与 seed（键列表）由行式编辑器直接产出结构化值。
    if (field.key === 'match') {
      const pairs = isRecord(raw) ? raw as Record<string, string> : {}
      if (Object.keys(pairs).length > 0) spec.match = pairs
      continue
    }
    if (field.key === 'seed') {
      if (Array.isArray(raw) && raw.length > 0) spec.seed = raw
      continue
    }
    const text = String(raw ?? '').trim()
    if (text === '') continue
    if (field.key === 'intervalSec' || field.key === 'executionTimeoutSec') {
      const value = Number(text)
      if (Number.isFinite(value) && value > 0) spec[field.key] = Math.floor(value)
      continue
    }
    if (field.key === 'paused') {
      if (text === 'true') spec.paused = true
      continue
    }
    spec[field.key] = text
  }
  const missing = labels.filter(field => field.required && spec[field.key] === undefined)
  if (missing.length > 0) {
    // 不给合法生产默认值（P0-4）：缺必填时如实拦下，字段留在草稿里。
    draftHint.value = `还缺必填项：${missing.map(field => field.label).join('、')}。`
    return
  }
  draftHint.value = null
  workflow.applyTriggerAxis(draft.axis, spec)
  triggerDraft.value = null
}

// ── trigger 已启用轴的字段编辑（P1-3 任务语言标签） ──

const AXIS_HINTS: Readonly<Record<string, string>> = {
  api: '允许经接口调用启动（前端手动发起）。启动时带入流程的数据，键名由你自定。',
  schedule: '平台维护一条定时调度；执行间隔必须显式给出。',
  stream: '由事件消息触发。筛选条件用消息原样的 snake_case 字段名。',
  bizNotify: '计划库下发飞行任务后的回调通知启动；平台按订阅标识判断这条通知发给谁。',
  job: '由插件自己的代码在合适时机启动（handler 调 flow.start）；没有外部启动入口，可与其它启动方式同时启用。',
}

function axisSpec (axis: string): JsonRecord {
  void workflow.revision
  const value = triggerSpec.value[axis]
  return isRecord(value) ? value : {}
}

function seedOf (axis: string): readonly string[] {
  void workflow.revision
  const spec = axisSpec(axis)
  return Array.isArray(spec.seed) ? spec.seed.filter((item): item is string => typeof item === 'string') : []
}

/** stream 筛选条件行提交：一条没有 = 删字段（schema 必填，语义校验会标红）。 */
function commitMatchRows (pairs: Record<string, string>): void {
  workflow.setTriggerFieldValue('stream', 'match', Object.keys(pairs).length === 0 ? null : pairs)
}

/** 草稿字段写入（模板事件回调里访问 triggerDraft 会丢 v-if 收窄，收进 script）。 */
function setDraftMatch (value: Record<string, string>): void {
  const draft = triggerDraft.value
  if (draft !== null) draft.fields.match = value
}

function setDraftSeed (rows: readonly unknown[]): void {
  const draft = triggerDraft.value
  if (draft !== null) draft.fields.seed = rows
}

function seedAvailable (axis: string): readonly string[] {
  return workflow.catalog.triggerSeeds[axis]?.available ?? []
}

// ── JS 源码编辑器挂载（P2-4：切走即释放） ──

const scriptHost = ref<HTMLElement | null>(null)
const mountedScriptId = computed(() => {
  if (!io.value.isScript) return null
  const id = scriptId.value
  if (id === undefined || id === '') return null
  const chosen = workflow.catalog.scripts.find(script => script.id === id)
  return chosen !== undefined && chosen.path !== undefined ? id : null
})

watch([mountedScriptId, scriptHost], async ([scriptId]) => {
  // P2-4：切到非脚本节点 / 功能为空 / 切走「JS 实现」页签（host 元素随页签卸载）
  // → 显式释放编辑器与 model 引用。
  if (scriptId === null || scriptHost.value === null) {
    workflow.disposeScriptEditor()
    return
  }
  // 挂载要等 DOM 进文档树后再做（Monaco 要量宽高）。
  // ★ 必须把 host 也盯上（DAG-016-01）：scriptId 在别的页签下就位时 host 还是
  //   null，这次挂载会静默跳过；用户随后切进「JS 实现」host 才出现，但只盯
  //   scriptId 的 watch 不会再触发——编辑器永远不出现。flush:'post' 保证
  //   回调看到的 host 已是渲染后的新元素。
  await nextTick()
  if (scriptHost.value !== null) workflow.mountScriptEditor(scriptHost.value, scriptId)
}, { immediate: true, flush: 'post' })

/**
 * 哪个功能的契约可以在这里改。
 *
 * ⚠️ 判据是「它在**本工程清单**里」，不是「这一步填了个脚本名」：
 * 填了清单里没有的名字时（typo、或引用了别的包），这里若照样给一个编辑器，
 * 用户一保存就会拿到「清单里没有 X」的拒绝 —— 更糟的是他可能以为自己把它建出来了。
 */
const contractScriptId = computed(() => {
  void workflow.revision
  if (!io.value.isScript || !workflow.catalog.available) return null
  const id = scriptId.value
  if (id === undefined || id === '') return null
  return workflow.catalog.scripts.some(script => script.id === id) ? id : null
})

// ── 执行条件（P1-5） ──

const whenSpec = computed<JsonRecord | undefined>(() => {
  void workflow.revision
  const value = step.value?.when
  return isRecord(value) ? value : undefined
})

/** when 是否为叶子形态（field/op）；组合形态在 UI 只读（源码编辑）。 */
const whenIsLeaf = computed(() => {
  const when = whenSpec.value
  if (when === undefined) return false
  return !Array.isArray(when.and) && !Array.isArray(when.or)
})

const CONDITION_OP_LABELS: Readonly<Record<string, string>> = {
  eq: '等于',
  ne: '不等于',
  in: '属于（任一）',
  exists: '键存在',
  blank: '值为空/缺失',
  present: '值存在',
}

const noValueOps: readonly string[] = ['exists', 'blank', 'present']

/** when 叶子的当前 field（模板里做类型收窄不可靠，收进 script）。 */
const whenFieldText = computed(() => {
  const field = whenSpec.value?.field
  return typeof field === 'string' ? field : ''
})

const whenOpText = computed(() => {
  const op = whenSpec.value?.op
  return typeof op === 'string' ? op : ''
})

function conditionValueText (): string {
  const value = whenSpec.value?.value
  if (value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value) ?? ''
}

/** 确认条件值：按 JSON 解析（失败按字符串提交，语义校验会继续判）。 */
function commitConditionValue (text: string): void {
  const id = stepId.value
  if (id === null) return
  if (text === '') {
    workflow.setWhenField(id, 'value', null)
    return
  }
  let value: unknown = text
  try {
    value = JSON.parse(text) as unknown
  } catch {
    // 字符串字面量是最常见写法，解析失败不视为错误。
  }
  workflow.setWhenField(id, 'value', value)
}

// ── 等待与回调（P1-2） ──

function awaitSpecOf (section: 'await' | 'callback'): JsonRecord | undefined {
  void workflow.revision
  const value = step.value?.[section]
  return isRecord(value) ? value : undefined
}

/** 挂起段键列表字段（provides/optional/interruptedBy）的当前值：只认数组形态。 */
function listValueOf (section: 'await' | 'callback', field: string): readonly unknown[] {
  const value = awaitSpecOf(section)?.[field]
  return Array.isArray(value) ? value : []
}

/**
 * 键列表行提交：空 → 删字段（null），否则原样交给 core。
 * provides/optional 可能是 `{key,type}` 对象形态（KeyListField 的类型列产物），
 * core 的 setStepSectionField 整字段替换，不做形态改写。
 */
function commitAwaitKeys (section: 'await' | 'callback', field: string, rows: readonly unknown[]): void {
  const id = stepId.value
  if (id === null) return
  workflow.setAwaitField(id, section, field, rows.length === 0 ? null : rows)
}

// ── 技术详情（P1-2/P6.5：机器字段可追溯但不占主视觉） ──

const stepJson = computed(() => {
  void workflow.revision
  return step.value === undefined ? '' : JSON.stringify(step.value, null, 2)
})

const techLines = computed(() => {
  void workflow.revision
  const lines: string[] = []
  if (action.value !== '') lines.push(`action = ${action.value}`)
  const needs = selected.value?.kind === 'step' ? selected.value.needs : []
  lines.push(`needs = ${needs.length === 0 ? '（无 → 隐式挂在触发器下）' : needs.join(', ')}`)
  if (io.value.isScript) {
    lines.push(`inputs.script.const = ${scriptId.value ?? '（未选择）'}`)
    if (connectorId.value !== undefined) lines.push(`inputs.connectorId.const = ${connectorId.value}`)
  }
  return lines
})
</script>

<template>
  <div id="wf-inspector" class="wf-inspector">
    <!-- 空态：总览 -->
    <template v-if="selected === null">
      <div class="wf-inspector-empty">
        {{ workflow.document === null
          ? '选择一个工作流文件开始。'
          : '点击画布上的节点编辑它；从节点底部的圆点拖到另一个节点即可建立前置依赖。' }}
      </div>
      <div v-if="workflow.model !== null" class="wf-inspector-overview">
        <div class="wf-row">
          <span class="wf-row-key">工作流名称</span>
          <span class="wf-row-value">{{ workflow.model.name === '' ? '（未命名）' : workflow.model.name }}</span>
        </div>
        <div class="wf-row">
          <span class="wf-row-key">步骤数</span><span class="wf-row-value">{{ workflow.stepCount }}</span>
        </div>
        <div class="wf-row">
          <span class="wf-row-key">依赖边数</span><span class="wf-row-value">{{ workflow.needsEdgeCount }}</span>
        </div>
        <div class="wf-row">
          <span class="wf-row-key">本地检查</span>
          <span class="wf-row-value">{{ workflow.catalog.available ? `${workflow.errorIssueCount} 错误 · ${workflow.warningIssueCount} 警告` : '平台动作目录未加载，未检查' }}</span>
        </div>
        <div v-if="workflow.schema?.available === true" class="wf-row wrap">
          <span class="wf-row-key">可用启动方式</span>
          <span class="wf-row-value">{{ workflow.schema.triggerKinds.map(kind => TRIGGER_AXIS_LABELS[kind]?.label ?? kind).join('、') }}</span>
        </div>
      </div>
    </template>

    <!-- trigger 节点：启动方式面板（P1-3 任务语言） -->
    <template v-else-if="selected.kind === 'trigger'">
      <div class="wf-inspector-heading">
        启动方式
      </div>
      <div class="wf-inspector-body">
        <div class="wf-section">
          <div class="wf-section-hint">
            至少选择一种启动方式，可以同时启用多种。
            选择启动时带入流程的数据。
          </div>
        </div>
        <div v-for="axis of Object.keys(TRIGGER_AXIS_LABELS)" :key="axis" class="wf-axis" :class="[{ enabled: axis in triggerSpec }]">
          <label class="wf-axis-head">
            <input
              type="checkbox"
              :checked="axis in triggerSpec || triggerDraft?.axis === axis"
              @change="onAxisCheckbox(axis, ($event.target as HTMLInputElement).checked)"
            >
            <span class="wf-axis-name">{{ TRIGGER_AXIS_LABELS[axis]?.label ?? axis }}</span>
            <span class="wf-axis-machine">{{ TRIGGER_AXIS_LABELS[axis]?.machine }}</span>
          </label>
          <div class="wf-section-hint">
            {{ AXIS_HINTS[axis] }}
          </div>

          <!-- 新启用：先配草稿，确认后一次性提交完整结构（P0-4） -->
          <div v-if="triggerDraft?.axis === axis" class="wf-axis-body wf-axis-draft">
            <div
              v-for="field of draftFieldLabels(axis)"
              :key="field.key"
              class="wf-axis-field"
            >
              <span class="wf-axis-field-label">{{ field.label }}<span v-if="field.required" class="wf-input-required">*</span></span>
              <PairRowsField
                v-if="field.key === 'match'"
                :value="isRecord(triggerDraft.fields.match) ? triggerDraft.fields.match : {}"
                key-placeholder="event_type"
                value-placeholder="illegal_road"
                add-label="添加条件"
                @commit="setDraftMatch"
              />
              <KeyListField
                v-else-if="field.key === 'seed'"
                :value="Array.isArray(triggerDraft.fields.seed) ? triggerDraft.fields.seed : []"
                key-placeholder="eventKey"
                @commit="setDraftSeed"
              />
              <input
                v-else
                class="wf-input-value"
                :type="field.key === 'intervalSec' || field.key === 'executionTimeoutSec' ? 'number' : 'text'"
                :value="String(triggerDraft.fields[field.key] ?? '')"
                :placeholder="field.key === 'paused' ? 'false' : ''"
                @input="triggerDraft.fields[field.key] = ($event.target as HTMLInputElement).value"
              >
              <div v-if="field.hint !== undefined" class="wf-section-hint">
                {{ field.hint }}
              </div>
            </div>
            <div v-if="draftHint !== null" class="wf-input-issue error">
              {{ draftHint }}
            </div>
            <div class="wf-axis-draft-actions">
              <button type="button" class="small" @click="commitTriggerDraft()">
                启用此启动方式
              </button>
              <button type="button" class="small ghost" @click="cancelTriggerDraft()">
                取消
              </button>
            </div>
          </div>

          <!-- 已启用：字段编辑（P1-3 任务语言标签） -->
          <div v-else-if="axis in triggerSpec" class="wf-axis-body">
            <!-- schedule：执行间隔 / 最长时间 / 暂停 -->
            <template v-if="axis === 'schedule'">
              <div class="wf-axis-field">
                <span class="wf-axis-field-label">执行间隔（秒）<span class="wf-input-required">*</span></span>
                <input
                  class="wf-input-value" type="number"
                  :value="typeof axisSpec(axis).intervalSec === 'number' ? String(axisSpec(axis).intervalSec) : ''"
                  @change="workflow.setTriggerFieldValue(axis, 'intervalSec', ($event.target as HTMLInputElement).value.trim() === '' ? null : Number(($event.target as HTMLInputElement).value))"
                >
                <div class="wf-section-hint">
                  平台不替业务猜周期 —— 缺了它本地检查会一直红。
                </div>
              </div>
              <div class="wf-axis-field">
                <span class="wf-axis-field-label">单次运行最长时间（秒）</span>
                <input
                  class="wf-input-value" type="number"
                  :value="typeof axisSpec(axis).executionTimeoutSec === 'number' ? String(axisSpec(axis).executionTimeoutSec) : ''"
                  @change="workflow.setTriggerFieldValue(axis, 'executionTimeoutSec', ($event.target as HTMLInputElement).value.trim() === '' ? null : Number(($event.target as HTMLInputElement).value))"
                >
              </div>
              <label class="wf-axis-field wf-axis-field-inline">
                <input type="checkbox" :checked="axisSpec(axis).paused === true" @change="workflow.setTriggerFieldValue(axis, 'paused', ($event.target as HTMLInputElement).checked ? true : null)">
                <span>暂停此定时任务（保留配置，平台跳过调度）</span>
              </label>
            </template>

            <!-- stream：事件筛选 + 启动数据 -->
            <template v-else-if="axis === 'stream'">
              <div class="wf-axis-field">
                <span class="wf-axis-field-label">事件筛选条件<span class="wf-input-required">*</span></span>
                <PairRowsField
                  :value="axisSpec('stream').match"
                  key-placeholder="event_type"
                  value-placeholder="illegal_road"
                  add-label="添加条件"
                  @commit="commitMatchRows"
                />
                <div class="wf-section-hint">
                  键用消息原样的 snake_case（如 event_type）；一条不填会匹配到全部消息。
                </div>
              </div>
              <SeedField
                :axis="axis"
                :available="seedAvailable(axis)"
                :not-guaranteed="workflow.catalog.triggerSeeds[axis]?.notGuaranteed ?? []"
                :types="workflow.catalog.triggerSeeds[axis]?.types"
                :current="seedOf(axis)"
                @commit="value => workflow.setTriggerFieldValue(axis, 'seed', value)"
              />
            </template>

            <!-- bizNotify：订阅标识 / 通知类型 + 启动数据 -->
            <template v-else-if="axis === 'bizNotify'">
              <div class="wf-axis-field">
                <span class="wf-axis-field-label">订阅标识<span class="wf-input-required">*</span></span>
                <input
                  class="wf-input-value" type="text"
                  :value="typeof axisSpec(axis).subscriber === 'string' ? axisSpec(axis).subscriber : ''"
                  placeholder="traffic_capture"
                  @change="workflow.setTriggerFieldValue(axis, 'subscriber', ($event.target as HTMLInputElement).value.trim())"
                >
              </div>
              <div class="wf-axis-field">
                <span class="wf-axis-field-label">通知类型</span>
                <input
                  class="wf-input-value" type="text"
                  :value="typeof axisSpec(axis).eventKind === 'string' ? axisSpec(axis).eventKind : ''"
                  placeholder="留空 = dispatched"
                  @change="workflow.setTriggerFieldValue(axis, 'eventKind', ($event.target as HTMLInputElement).value.trim())"
                >
              </div>
              <SeedField
                :axis="axis"
                :available="seedAvailable(axis)"
                :not-guaranteed="workflow.catalog.triggerSeeds[axis]?.notGuaranteed ?? []"
                :types="workflow.catalog.triggerSeeds[axis]?.types"
                :current="seedOf(axis)"
                @commit="value => workflow.setTriggerFieldValue(axis, 'seed', value)"
              />
            </template>

            <!-- api / job：自由键名的启动数据 -->
            <template v-else>
              <SeedField
                :axis="axis"
                :available="seedAvailable(axis)"
                :not-guaranteed="workflow.catalog.triggerSeeds[axis]?.notGuaranteed ?? []"
                :types="workflow.catalog.triggerSeeds[axis]?.types"
                :current="seedOf(axis)"
                @commit="value => workflow.setTriggerFieldValue(axis, 'seed', value)"
              />
            </template>
          </div>
        </div>
        <div v-if="workflow.semanticIssues.some(issue => issue.nodeId === '$trigger')" class="wf-section">
          <div class="wf-section-title">
            启动方式的问题
          </div>
          <div
            v-for="(issue, index) of workflow.semanticIssues.filter(issue => issue.nodeId === '$trigger')"
            :key="index"
            class="wf-input-issue" :class="[issue.level]"
          >
            {{ issue.message }}
          </div>
        </div>
      </div>
    </template>

    <!-- step 节点：任务页签（P1-2） -->
    <template v-else>
      <div class="wf-inspector-heading">
        {{ selected.id }}
      </div>

      <!-- 绑定完整度放页签之外：无论词表是否可用、step 能否解析，
           选中一个节点都该看得到「它现在算不算配好了」。 -->
      <div
        v-if="bindingStatus !== null"
        class="wf-binding-state" :class="[bindingStatus.state]"
        :data-binding-state="bindingStatus.state"
      >
        {{ bindingText }}
      </div>

      <!-- 词表没到 / 文档结构异常：只读摘要，不让面板空着 -->
      <template v-if="step === undefined || workflow.context === null">
        <!-- DAG-018-05：只读必须给原因 —— 禁用态的每次查看/编辑尝试都要能被单独评审，
             静默只读等于不可诊断。一句话同时覆盖词表缺失与步骤未解析两种降级。 -->
        <div class="wf-input-issue error">
          {{ workflow.context === null
            ? '平台动作目录未取到（/api/actions 不可用）：节点未解析，面板只读，编辑入口已停用。'
            : `找不到步骤「${selected.id}」：节点未解析，面板只读。` }}
        </div>
        <div class="wf-inspector-body">
          <div class="wf-row">
            <span class="wf-row-key">执行动作</span><span class="wf-row-value">{{ selected.action === '' ? '（未设置）' : selected.action }}</span>
          </div>
          <div v-if="selected.description !== undefined" class="wf-row">
            <span class="wf-row-key">说明</span><span class="wf-row-value">{{ selected.description }}</span>
          </div>
          <div class="wf-row">
            <span class="wf-row-key">前置步骤</span><span class="wf-row-value">{{ selected.needs.length === 0 ? '（无，隐式挂在触发器下）' : selected.needs.join('、') }}</span>
          </div>
          <div v-for="reference of selected.refs" :key="reference.key" class="wf-row mono">
            <span class="wf-row-key">{{ reference.key }}</span>
            <span class="wf-row-value">{{ reference.kind === 'from' ? '← ' : '= ' }}{{ reference.value }}</span>
          </div>
        </div>
        <div v-for="(issue, index) of nodeIssues" :key="index" class="wf-input-issue" :class="[issue.level]">
          {{ issue.message }}
        </div>
      </template>

      <template v-else>
        <!-- 页签栏 -->
        <div class="wf-tabs">
          <button
            v-for="tab of visibleTabs"
            :key="tab.key"
            type="button"
            class="wf-tab" :class="[{ active: activeTab === tab.key }]"
            @click="activeTab = tab.key"
          >
            {{ tab.label }}
          </button>
        </div>

        <div class="wf-inspector-body">
          <!-- ═══ 节点调用：执行动作 + 前置步骤 + 输入来源 ═══ -->
          <template v-if="activeTab === 'invoke'">
            <div class="wf-section">
              <div class="wf-section-title">
                执行动作
              </div>
              <select
                v-if="workflow.catalog.available"
                class="wf-field-select"
                :value="action"
                @change="workflow.setAction(selected.id, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">
                  （未设置）
                </option>
                <optgroup label="平台动作">
                  <option v-for="fixed of workflow.catalog.fixedSteps" :key="fixed.action" :value="fixed.action" :title="fixed.description">
                    {{ fixed.displayName ?? fixed.action }} —— {{ fixed.action }}
                  </option>
                </optgroup>
                <optgroup label="业务功能">
                  <!-- 任何步骤都能切换成业务功能调用：切完后由下方「业务功能」选择器
                       指定调用哪份脚本（P0-2：仍然没有自由文本 action 入口）。 -->
                  <option :value="workflow.catalog.scriptAction">
                    调用业务功能 —— {{ workflow.catalog.scriptAction }}
                  </option>
                </optgroup>
                <!-- 当前值不在词表里：显式列出，不静默改掉 -->
                <option
                  v-if="action !== '' && action !== workflow.catalog.scriptAction && !workflow.catalog.fixedSteps.some(fixed => fixed.action === action)"
                  :value="action"
                >
                  {{ action }}（不在平台动作目录内）
                </option>
              </select>
              <template v-else>
                <div class="wf-field-readonly">
                  {{ action === '' ? '（未设置）' : action }}
                </div>
                <div class="wf-section-hint">
                  平台动作目录未加载（/api/actions 不可用），已降级为只读。
                </div>
              </template>
              <div v-if="workflow.catalog.fixedSteps.find(item => item.action === action) !== undefined" class="wf-badges">
                <span v-if="workflow.catalog.fixedSteps.find(item => item.action === action)?.capability !== undefined" class="wf-badge">
                  {{ workflow.catalog.fixedSteps.find(item => item.action === action)?.capability }}
                </span>
                <span v-if="workflow.catalog.fixedSteps.find(item => item.action === action)?.isFlight === true" class="wf-badge danger">飞行操作</span>
                <span v-if="workflow.catalog.fixedSteps.find(item => item.action === action)?.nonIdempotent === true" class="wf-badge warn">非幂等·不重试</span>
                <span v-if="workflow.catalog.fixedSteps.find(item => item.action === action)?.kind === 'await_signal'" class="wf-badge">挂起等信号</span>
              </div>
              <div v-if="workflow.catalog.fixedSteps.find(item => item.action === action)?.description !== undefined" class="wf-section-hint">
                {{ workflow.catalog.fixedSteps.find(item => item.action === action)?.description }}
              </div>
            </div>

            <!-- 业务功能选择（P0-6 专用控件；元参数不进普通参数列表） -->
            <div v-if="io.isScript && workflow.catalog.available" class="wf-section">
              <div class="wf-section-title">
                业务功能
              </div>
              <div class="wf-section-hint">
                选定后参数与返回结果的声明随之生效；下方输入来源按声明重绘。
              </div>
              <div class="wf-script-picker">
                <div v-if="workflow.catalog.scripts.length === 0" class="wf-field-readonly">
                  {{ workflow.catalog.pluginManifestFound
                    ? '本工程的清单里还没有业务功能。'
                    : '没找到后端清单（fh2-plugin.json）。' }}
                </div>
                <select
                  v-else
                  class="wf-field-select"
                  :value="scriptId ?? ''"
                  @change="workflow.setScript(selected.id, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">
                    （未选择）
                  </option>
                  <option v-for="script of workflow.catalog.scripts" :key="script.id" :value="script.id" :title="script.description">
                    {{ script.description === undefined ? script.id : `${script.description}（${script.id}）` }}
                  </option>
                  <option
                    v-if="scriptId !== undefined && scriptId !== '' && !workflow.catalog.scripts.some(s => s.id === scriptId)"
                    :value="scriptId"
                  >
                    {{ scriptId }}（清单里没有）
                  </option>
                </select>
                <button type="button" class="small" @click="void workflow.promptCreateScriptFunction({ bindStepId: selected.id })">
                  新建业务功能
                </button>
              </div>
              <div v-if="workflow.catalog.scripts.find(s => s.id === scriptId) !== undefined" class="wf-badges">
                <span v-for="cap of workflow.catalog.scripts.find(s => s.id === scriptId)?.allowlist ?? []" :key="cap" class="wf-badge">{{ cap }}</span>
              </div>
              <div v-if="workflow.catalog.scripts.find(s => s.id === scriptId)?.allowlist.length" class="wf-section-hint">
                ↑ 这份功能需要的平台权限。
              </div>
              <div v-if="workflow.catalog.scripts.find(s => s.id === scriptId)?.path !== undefined" class="wf-script-path">
                实现文件：{{ workflow.catalog.scripts.find(s => s.id === scriptId)?.path }}
              </div>
            </div>

            <!-- 连接配置（P0-6：connectorId 专用控件） -->
            <div v-if="io.isScript" class="wf-section">
              <div class="wf-section-title">
                连接配置
              </div>
              <div class="wf-section-hint">
                指定这一步使用的连接配置 ID（可留空）。固定写入 const。
              </div>
              <input
                class="wf-input-value"
                type="text"
                :value="connectorId ?? ''"
                placeholder="（未设置）"
                @change="workflow.setConnector(selected.id, ($event.target as HTMLInputElement).value.trim())"
              >
            </div>

            <!-- 输入来源（P0-3 三态草稿 + P1-4 业务分组） -->
            <div v-if="io.resolved && businessInputs.length > 0" class="wf-section">
              <div class="wf-section-title">
                输入来源
              </div>
              <div class="wf-section-hint">
                「引用上游数据」从启动数据或前置步骤的输出取值；「填写固定值」写编排自己的字面量。切换选项不会改文件 —— 选定具体来源或输入固定值后才提交。
              </div>
              <div
                v-for="field of businessInputs"
                :key="`${workflow.draftEpoch}:${stepId}:${field.name}`"
                class="wf-input-row" :class="[{
                  'has-error': rowIssues(field.name).some(issue => issue.level === 'error'),
                  'has-warning': rowIssues(field.name).some(issue => issue.level === 'warning'),
                  'focused': focusInputKey === field.name,
                }]"
                :data-input-key="field.name"
              >
                <div class="wf-input-head">
                  <span class="wf-input-name">
                    {{ field.name }}
                    <span v-if="field.required === true" class="wf-input-required" title="必填参数：没有设置取值就无法执行，发布时会报错">*</span>
                  </span>
                  <span class="wf-input-type">{{ field.type }}</span>
                  <select
                    class="wf-input-mode"
                    :value="rowMode(field.name)"
                    @change="switchMode(field, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="none">
                      暂不设置
                    </option>
                    <option value="from">
                      引用上游数据
                    </option>
                    <option value="const">
                      填写固定值
                    </option>
                  </select>
                </div>

                <template v-if="rowMode(field.name) === 'from'">
                  <select
                    class="wf-input-value"
                    :value="wiredOf(field.name).from ?? ''"
                    @change="commitFrom(field, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="" class="wf-input-placeholder">
                      （选择数据来源）
                    </option>
                    <!-- 当前值可能已不在候选里（上游改名/闭包变了）—— 必须显式列出，否则会被静默改掉 -->
                    <option
                      v-if="(wiredOf(field.name).from ?? '') !== '' && !candidates.some(item => item.path === wiredOf(field.name).from)"
                      :value="wiredOf(field.name).from"
                    >
                      ⚠ {{ wiredOf(field.name).from }}（已失效）
                    </option>
                    <optgroup
                      v-for="group of (['trigger', 'steps', 'run'] as const)"
                      :key="group"
                      :label="SOURCE_GROUPS[group]"
                    >
                      <option
                        v-for="candidate of candidates.filter(item => item.group === group)"
                        :key="candidate.path"
                        :value="candidate.path"
                        :title="candidate.note"
                      >
                        {{ candidate.guaranteed ? candidate.path : `${candidate.path}（可能没有值）` }}
                      </option>
                    </optgroup>
                  </select>
                </template>
                <input
                  v-else-if="rowMode(field.name) === 'const'"
                  class="wf-input-value"
                  :data-step-id="stepId"
                  :data-draft-epoch="workflow.draftEpoch"
                  :type="field.type === 'number' ? 'number' : 'text'"
                  :value="formatConst(wiredOf(field.name).constValue)"
                  :placeholder="field.type === 'array' ? '[&quot;a&quot;,&quot;b&quot;]' : field.type === 'object' ? '{&quot;k&quot;:1}' : field.type === 'bool' ? 'true / false' : ''"
                  @input="stepId !== null && constDrafts.track({ epoch: workflow.draftEpoch, stepId, field: field.name, type: field.type, raw: ($event.target as HTMLInputElement).value })"
                  @change="commitConstEvent(field, $event)"
                  @blur="commitConstEvent(field, $event)"
                >

                <div v-for="(issue, index) of rowIssues(field.name)" :key="index" class="wf-input-issue" :class="[issue.level]">
                  {{ issue.message }}
                </div>
              </div>
            </div>
            <div v-else-if="io.resolved" class="wf-section">
              <div class="wf-section-title">
                输入来源
              </div>
              <div class="wf-section-hint">
                这个动作没有声明任何业务入参。
              </div>
            </div>

            <!-- 未声明的入参（R2） -->
            <div v-if="extraInputs.length > 0" class="wf-section">
              <div class="wf-section-title">
                未声明的入参
              </div>
              <div class="wf-section-hint">
                这些键不在动作的声明里：运行时不会报错也不会生效，发布时会报错。
              </div>
              <div v-for="key of extraInputs" :key="key" class="wf-input-row has-error">
                <div class="wf-input-head">
                  <span class="wf-input-name">{{ key }}</span>
                  <button type="button" class="small danger" @click="workflow.clearInput(selected.id, key)">
                    删除
                  </button>
                </div>
              </div>
            </div>

            <!-- 节点级问题 -->
            <div v-if="nodeIssues.some(issue => issue.inputKey === undefined)" class="wf-section">
              <div class="wf-section-title">
                本步骤的问题
              </div>
              <div v-for="(issue, index) of nodeIssues.filter(issue => issue.inputKey === undefined)" :key="index" class="wf-input-issue" :class="[issue.level]">
                {{ issue.message }}
              </div>
            </div>
          </template>

          <!-- ═══ 功能契约：共享 scripts[] I/O（P1-6 去 Worker 化） ═══ -->
          <template v-else-if="activeTab === 'contract'">
            <div class="wf-section-hint wf-scope-note">
              共享业务功能（影响 {{ callerCount }} 个调用方）—— 改的是清单里的共享声明，不是只改这个步骤。
            </div>
            <ScriptContractEditor
              v-if="contractScriptId !== null"
              :key="contractScriptId"
              :script-id="contractScriptId"
            />
            <div v-else-if="io.isScript" class="wf-section-hint">
              先在「步骤设置」页签选定一个清单里的业务功能，才能编辑它的契约。
            </div>
          </template>

          <!-- ═══ JS 实现：共享源码文件 ═══ -->
          <template v-else-if="activeTab === 'source'">
            <div class="wf-section-hint wf-scope-note">
              共享实现文件（可能包含多个入口）—— 文件路径见「参数与返回值」页签。
            </div>
            <div v-if="mountedScriptId === null" class="wf-section-hint">
              <template v-if="!io.isScript">
                这个步骤不是业务功能调用，没有脚本实现。
              </template>
              <template v-else>
                先在「步骤设置」页签选定业务功能，这里会打开它的源码。
              </template>
            </div>
            <div v-else class="wf-section">
              <div class="wf-section-title">
                脚本实现
              </div>
              <div class="wf-section-hint">
                {{ workflow.catalog.scriptLanguage === 'typescript'
                  ? 'TypeScript：构建器经 esbuild 打包（命名导出）。'
                  : '这份 JS 按 goja（ES5.1）装载：没有 Promise / async / Map。写错的语法当场红线。' }}
              </div>
              <button
                type="button"
                class="small ghost wf-open-in-editor"
                @click="void workflow.openScriptSource(workflow.catalog.scripts.find(s => s.id === mountedScriptId)?.filePath ?? '')"
              >
                在主编辑器打开
              </button>
              <div ref="scriptHost" class="wf-script-editor" />
            </div>
          </template>

          <!-- ═══ 执行条件：when + 执行策略（P1-5） ═══ -->
          <template v-else-if="activeTab === 'condition'">
            <div class="wf-section">
              <div class="wf-section-title">
                执行时机
              </div>
              <select
                class="wf-field-select"
                :value="step.trigger === 'allDone' ? 'allDone' : 'allSucceeded'"
                @change="workflow.setStepTriggerValue(selected.id, ($event.target as HTMLSelectElement).value)"
              >
                <option value="allSucceeded">
                  前置步骤全部成功才执行（默认）
                </option>
                <option value="allDone">
                  前置步骤无论成败都执行（收尾）
                </option>
              </select>
              <div class="wf-section-hint">
                {{ step.trigger === 'allDone'
                  ? '前置步骤只要结束就执行 —— 成功、失败、被跳过都算。适合回写最终状态、清理资源这类收尾动作。'
                  : '任一前置步骤失败或被跳过，这一步就不执行，下游也会跟着跳过（常规依赖）。' }}
              </div>
            </div>

            <div class="wf-section">
              <div class="wf-section-title">
                执行条件（when）
              </div>
              <div class="wf-section-hint">
                条件不满足时这一步被跳过（跳过会顺着依赖传染给下游）。
              </div>
              <template v-if="whenSpec === undefined">
                <div class="wf-section-hint">
                  当前没有条件（总是执行）。
                </div>
                <button
                  type="button"
                  class="small"
                  @click="workflow.addCondition(selected.id)"
                >
                  添加条件
                </button>
              </template>
              <template v-else-if="whenIsLeaf">
                <div class="wf-axis-field">
                  <span class="wf-axis-field-label">判断的数据</span>
                  <select
                    class="wf-input-value"
                    :value="whenFieldText"
                    @change="workflow.setWhenField(selected.id, 'field', ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">
                      （选择数据来源）
                    </option>
                    <option
                      v-if="whenFieldText !== '' && !candidates.some(item => item.path === whenFieldText)"
                      :value="whenFieldText"
                    >
                      ⚠ {{ whenFieldText }}（已失效）
                    </option>
                    <optgroup
                      v-for="group of (['trigger', 'steps', 'run'] as const)"
                      :key="group"
                      :label="SOURCE_GROUPS[group]"
                    >
                      <option
                        v-for="candidate of candidates.filter(item => item.group === group)"
                        :key="candidate.path"
                        :value="candidate.path"
                      >
                        {{ candidate.path }}
                      </option>
                    </optgroup>
                  </select>
                </div>
                <div class="wf-axis-field">
                  <span class="wf-axis-field-label">判断方式</span>
                  <select
                    class="wf-input-value"
                    :value="whenOpText"
                    @change="workflow.setWhenField(selected.id, 'op', ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">
                      （选择判断方式）
                    </option>
                    <option v-for="op of workflow.catalog.conditionOps" :key="op" :value="op">
                      {{ CONDITION_OP_LABELS[op] ?? op }}（{{ op }}）
                    </option>
                  </select>
                </div>
                <div v-if="whenOpText !== '' && !noValueOps.includes(whenOpText)" class="wf-axis-field">
                  <span class="wf-axis-field-label">比较值</span>
                  <input
                    class="wf-input-value" type="text"
                    :value="conditionValueText()"
                    :placeholder="whenSpec.op === 'in' ? '[a, b]（JSON 数组）' : '文本或 JSON 字面量'"
                    @change="commitConditionValue(($event.target as HTMLInputElement).value)"
                  >
                </div>
              </template>
              <template v-else>
                <div class="wf-section-hint">
                  这是一条组合条件（and / or）—— 结构化编辑组合条件容易拆坏嵌套语义，
                  请在源码里改（技术详情页签可看当前 JSON）。
                </div>
              </template>
              <!-- 有条件就必须有关闭入口：点错/不要了不能只剩「删节点」一条路。 -->
              <template v-if="whenSpec !== undefined">
                <div class="wf-axis-draft-actions">
                  <button
                    type="button"
                    class="small danger"
                    @click="workflow.removeCondition(selected.id)"
                  >
                    删除条件
                  </button>
                  <div class="wf-section-hint">
                    删除后这一步恢复为总是执行。
                  </div>
                </div>
              </template>
            </div>

            <div class="wf-section">
              <div class="wf-section-title">
                重试与时长
              </div>
              <div class="wf-axis-field">
                <span class="wf-axis-field-label">延迟执行（秒）</span>
                <input
                  class="wf-input-value" type="number"
                  :value="typeof step.delaySec === 'number' ? String(step.delaySec) : ''"
                  placeholder="不延迟"
                  @change="workflow.setStepNumberValue(selected.id, 'delaySec', parseSec(($event.target as HTMLInputElement).value))"
                >
              </div>
              <div class="wf-axis-field">
                <span class="wf-axis-field-label">单次执行最长时间（秒）</span>
                <input
                  class="wf-input-value" type="number"
                  :value="typeof step.timeoutSec === 'number' ? String(step.timeoutSec) : ''"
                  placeholder="平台默认"
                  @change="workflow.setStepNumberValue(selected.id, 'timeoutSec', parseSec(($event.target as HTMLInputElement).value))"
                >
              </div>
              <div class="wf-axis-field">
                <span class="wf-axis-field-label">最多尝试次数</span>
                <input
                  class="wf-input-value" type="number"
                  :value="typeof step.maxAttempts === 'number' ? String(step.maxAttempts) : ''"
                  placeholder="平台默认"
                  @change="workflow.setStepNumberValue(selected.id, 'maxAttempts', parseSec(($event.target as HTMLInputElement).value))"
                >
              </div>
            </div>
          </template>

          <!-- ═══ 等待与回调（P1-2） ═══ -->
          <template v-else-if="activeTab === 'await'">
            <div v-for="section of (['await', 'callback'] as const)" :key="section" class="wf-section">
              <div class="wf-section-title">
                {{ section === 'await' ? '等待（人在环暂停）' : '回调（外部异步完成）' }}
              </div>
              <template v-if="awaitSpecOf(section) === undefined">
                <div class="wf-section-hint">
                  {{ section === 'await' ? '没有等待段：这一步跑完就结束。' : '没有回调段。' }}
                </div>
                <button
                  type="button"
                  class="small"
                  @click="void workflow.promptAddAwait(selected.id, section)"
                >
                  添加{{ section === 'await' ? '等待' : '回调' }}
                </button>
              </template>
              <template v-else>
                <div class="wf-axis-field">
                  <span class="wf-axis-field-label">信号名<span class="wf-input-required">*</span></span>
                  <input
                    class="wf-input-value" type="text"
                    :value="typeof awaitSpecOf(section)?.signal === 'string' ? awaitSpecOf(section)?.signal : ''"
                    @change="workflow.setAwaitField(selected.id, section, 'signal', ($event.target as HTMLInputElement).value.trim())"
                  >
                </div>
                <div class="wf-axis-field">
                  <span class="wf-axis-field-label">等待上限（秒）</span>
                  <input
                    class="wf-input-value" type="number"
                    :value="typeof awaitSpecOf(section)?.timeoutSec === 'number' ? String(awaitSpecOf(section)?.timeoutSec) : ''"
                    placeholder="无上限（等待外部信号的步骤慎用）"
                    @change="workflow.setAwaitField(selected.id, section, 'timeoutSec', ($event.target as HTMLInputElement).value.trim() === '' ? null : Number(($event.target as HTMLInputElement).value))"
                  >
                </div>
                <div class="wf-axis-field">
                  <span class="wf-axis-field-label">超时上限取自数据（timeoutSecFrom）</span>
                  <input
                    class="wf-input-value" type="text"
                    :value="typeof awaitSpecOf(section)?.timeoutSecFrom === 'string' ? awaitSpecOf(section)?.timeoutSecFrom : ''"
                    placeholder="如 trigger.timeoutSec"
                    @change="workflow.setAwaitField(selected.id, section, 'timeoutSecFrom', ($event.target as HTMLInputElement).value.trim())"
                  >
                  <div class="wf-section-hint">
                    与「等待上限（秒）」二选一，运行期只认这里。
                  </div>
                </div>
                <div class="wf-axis-field">
                  <span class="wf-axis-field-label">一定会产出的键</span>
                  <KeyListField
                    :value="listValueOf(section, 'provides')"
                    :types="workflow.catalog.ioFieldTypes"
                    key-placeholder="decision"
                    @commit="rows => commitAwaitKeys(section, 'provides', rows)"
                  />
                  <div class="wf-section-hint">
                    挂起结束后一定会提供给下游步骤的键；类型选「（未声明）」= 不做类型约束。
                  </div>
                </div>
                <div class="wf-axis-field">
                  <span class="wf-axis-field-label">可能产出、不保证有的键</span>
                  <KeyListField
                    :value="listValueOf(section, 'optional')"
                    :types="workflow.catalog.ioFieldTypes"
                    key-placeholder="remark"
                    @commit="rows => commitAwaitKeys(section, 'optional', rows)"
                  />
                  <div class="wf-section-hint">
                    命中才有、不保证出现的键；引用它的下游入参按「可能缺失」对待。
                  </div>
                </div>
                <div class="wf-axis-field">
                  <span class="wf-axis-field-label">可以中断等待的信号</span>
                  <KeyListField
                    :value="listValueOf(section, 'interruptedBy')"
                    key-placeholder="user_cancel"
                    @commit="rows => commitAwaitKeys(section, 'interruptedBy', rows)"
                  />
                </div>
                <button
                  type="button"
                  class="small danger"
                  @click="workflow.setStepAwaitSpec(selected.id, section, null)"
                >
                  删除{{ section === 'await' ? '等待' : '回调' }}段
                </button>
              </template>
            </div>
          </template>

          <!-- ═══ 技术详情（P6.5：机器字段可追溯但不占主视觉） ═══ -->
          <template v-else-if="activeTab === 'tech'">
            <div class="wf-section">
              <div class="wf-section-title">
                技术详情
              </div>
              <div class="wf-section-hint">
                执行器字段与真实 JSON 路径都在这里；上面的页签是它的业务视图。
              </div>
              <div v-for="line of techLines" :key="line" class="wf-row mono">
                <span class="wf-row-value">{{ line }}</span>
              </div>
              <div v-for="(issue, index) of nodeIssues" :key="index" class="wf-row mono">
                <span class="wf-row-value">{{ issue.rule }} → {{ issue.message }}</span>
              </div>
              <pre class="wf-tech-json">{{ stepJson }}</pre>
            </div>
          </template>
        </div>
      </template>

      <div class="wf-inspector-actions">
        <button type="button" class="small ghost" @click="void workflow.promptRename(selected.id)">
          重命名
        </button>
        <button type="button" class="small ghost" @click="void workflow.promptText(selected.id, 'description')">
          改说明
        </button>
        <button type="button" class="small danger" @click="void workflow.promptDelete(selected.id)">
          删除
        </button>
      </div>
    </template>
  </div>
</template>
