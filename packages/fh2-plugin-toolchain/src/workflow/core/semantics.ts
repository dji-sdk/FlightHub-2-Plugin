// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 画布的**语义校验**：把 worker 发布期校验（internal/flowcheck）的判据搬到编辑期。
 *
 * ★ 与 §2.5 的分工（这是本模块存在的边界，别越界）：
 *   本模块  = 编辑期的**即时反馈**，在用户拖线/填参的那一刻就红。
 *   §2.5    = 落盘后的**权威裁决**，以 worker/CLI 为准。
 * 两者规则同源（都照 flowcheck 的判据），但真相只有一个 —— 冲突时以 §2.5 为准。
 * 因此这里所有判据都遵循一条纪律：**宁可漏判，不可误报**。
 * 词表取不到、脚本没选、action 不认识时一律放行（`resolved: false` → 不校验），
 * 因为「画布说错了但 CLI 说对」比「画布漏了一条」更能摧毁用户对红线的信任。
 *
 * 规则编号对应 DAG画布技术方案 §1.3 的 R1–R8。
 */

import { SCRIPT_RESERVED_INPUT_KEYS, findFixedStep, isPluginAction, resolveStepIO } from './catalog.js'
import type { ActionCatalog, ActionField } from './catalog.js'

/**
 * trigger 节点的合成 id（与 IDE 画布 model.ts 的约定一致）。
 * 本模块只消费工作流原始 JSON（`{ raw }`），不依赖画布图模型 —— graph 层的
 * 结构问题（环/悬空 needs）由画布本地报，这里只补语义层。
 */
export const TRIGGER_NODE_ID = '$trigger'

/** 工作流原始文档的最小视图；IDE 的 WorkflowDocument 结构满足它。 */
export interface WorkflowRawDocument {
  readonly raw: Record<string, unknown>;
}

export type SemanticLevel = 'error' | 'warning'

/** 规则编号。与技术方案 §1.3 的表格一一对应，便于双向追溯。 */
export type SemanticRule =
  | 'R1_REQUIRED_INPUT_UNWIRED'
  | 'R2_UNDECLARED_INPUT'
  | 'R3_UNRESOLVABLE_REF'
  | 'R3_UNCERTAIN_REF'
  | 'R4_NEEDS_CLOSURE'
  | 'R5_RESERVED_OUTPUT'
  | 'R6_AWAIT_ORDER'
  | 'R7_ALLDONE_UNBOUNDED_AWAIT'
  | 'R8_BAD_CONDITION'
  | 'R9_REDUNDANT_NEEDS'
  | 'AWAIT_SIGNAL_MISSING'
  | 'AWAIT_TIMEOUT_UNRESOLVABLE'
  | 'SCRIPT_MISSING'
  | 'SCRIPT_META_NOT_CONST'
  | 'UNKNOWN_ACTION'
  | 'INPUT_TYPE_MISMATCH'

export interface SemanticIssue {
  readonly rule: SemanticRule;
  readonly level: SemanticLevel;
  /** 归属节点 id；流程级问题用 `''`。 */
  readonly nodeId: string;
  /** 具体到哪个入参（有则用于在面板里精确标红）。 */
  readonly inputKey?: string;
  readonly message: string;
}

type JsonRecord = Record<string, unknown>

function isRecord (value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray (value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stepsOf (raw: JsonRecord): JsonRecord[] {
  return Array.isArray(raw.steps) ? raw.steps.filter(isRecord) : []
}

function stepId (step: JsonRecord): string {
  return typeof step.id === 'string' ? step.id : ''
}

/** 取一步某个入参写死的字符串字面量（worker 的 FlowStep.ConstString）。 */
export function constString (step: JsonRecord, name: string): string | undefined {
  if (!isRecord(step.inputs)) return undefined
  const spec = step.inputs[name]
  if (!isRecord(spec) || !('const' in spec)) return undefined
  const value = spec.const
  return typeof value === 'string' ? value : undefined
}

/** worker 的 flow.TypeOK：词表外的类型名一律放行（恒真）。 */
function typeOk (want: string, value: unknown): boolean {
  switch (want) {
    case 'string': case 'id': case 'timestamp': case 'enum':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number'
    case 'bool':
      return typeof value === 'boolean'
    case 'object':
      return isRecord(value)
    case 'array':
      return Array.isArray(value)
    default:
      return true
  }
}

/** worker 的 flow.ParseRef：只拆语法、不取值。 */
export interface ParsedRef {
  readonly root: 'trigger' | 'steps' | 'run';
  readonly stepId: string;
  readonly rest: readonly string[];
}

export function parseRef (path: string): ParsedRef | null {
  const parts = path.split('.')
  // worker 的 flow.MaxDepth
  if (parts.length > 16) return null
  if (parts.length >= 2 && parts[0] === 'trigger') {
    return { root: 'trigger', stepId: '', rest: parts.slice(1) }
  }
  if (parts.length >= 3 && parts[0] === 'steps') {
    return { root: 'steps', stepId: parts[1]!, rest: parts.slice(2) }
  }
  if (parts.length >= 2 && parts[0] === 'run') {
    return { root: 'run', stepId: '', rest: parts.slice(1) }
  }
  return null
}

/**
 * worker 的 flowcheck.walkFields：按路径段在声明树上逐层往下走。
 * 数组下标段（纯数字，非首段）不消耗一层声明；走到没有 fields 的字段就放行剩下的段。
 */
/** 接到叶子字段的声明类型；走不到叶子（或类型未声明）返回 undefined。 */
function fieldTypeAt (fields: readonly ActionField[], segments: readonly string[]): string | undefined {
  if (segments.length === 0) return undefined
  let current = fields
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!
    if (i > 0 && /^\d+$/.test(segment)) continue
    const found = current.find(field => field.name === segment)
    if (found === undefined) return undefined
    if (i === segments.length - 1) return found.type
    if (found.fields === undefined || found.fields.length === 0) return undefined
    current = found.fields
  }
  return undefined
}

/**
 * 类型归组（from 接线的相容判据）。未知类型归 undefined：不参与判比——
 * 词表缺类型信息时宁可漏报，不制造误报。
 */
function typeGroup (type: string | undefined): string | undefined {
  switch (type) {
    case 'string': case 'id': case 'timestamp': case 'enum': return 'string'
    case 'number': case 'integer': return 'number'
    case 'bool': case 'boolean': return 'bool'
    case 'object': return 'object'
    case 'array': return 'array'
    default: return undefined
  }
}

function walkFields (fields: readonly ActionField[], segments: readonly string[]): boolean {
  if (segments.length === 0) return false
  let current = fields
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!
    if (i > 0 && /^\d+$/.test(segment)) continue
    const found = current.find(field => field.name === segment)
    if (found === undefined) return false
    if (i === segments.length - 1) return true
    if (found.fields === undefined || found.fields.length === 0) return true
    current = found.fields
  }
  return true
}

/** `steps.<id>.$state` 的保留段（worker 的 flow.StateKey）。 */
const STATE_KEY = '$state'

/**
 * 一步的出参声明，含三个来源的合成（worker 的 flowcheck.recordOutputs）：
 * 词表/脚本 outputs + await/callback 的 provides/optional + 引擎留痕键。
 */
export interface StepOutputs {
  readonly fields: readonly ActionField[];
  /** 不是每次都产出的键名（下游引用需 when 守护）。 */
  readonly uncertain: ReadonlySet<string>;
}

function awaitSpecOf (step: JsonRecord, key: 'await' | 'callback'): JsonRecord | undefined {
  const spec = step[key]
  return isRecord(spec) ? spec : undefined
}

/** provides / optional 两种写法：`["k"]` 与 `[{key,type}]`（worker 的 flow.Provided）。 */
function providedKeys (value: unknown): { readonly key: string; readonly type: string }[] {
  if (!Array.isArray(value)) return []
  const keys: { key: string; type: string }[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      keys.push({ key: item, type: '' })
    } else if (isRecord(item) && typeof item.key === 'string') {
      keys.push({ key: item.key, type: typeof item.type === 'string' ? item.type : '' })
    }
  }
  return keys
}

/** 一个挂起段是否「有界」（写了 timeoutSec>0 或 timeoutSecFrom）。 */
function isBounded (spec: JsonRecord): boolean {
  const sec = spec.timeoutSec
  const from = spec.timeoutSecFrom
  return (typeof sec === 'number' && sec > 0) || (typeof from === 'string' && from !== '')
}

/**
 * 合成一步的全部出参。挂起段的留痕键由引擎写入，不在任何声明里 ——
 * 少了它们，`{"from":"steps.ack.timedOut"}` 会被误判成断链。
 */
export function collectStepOutputs (
  catalog: ActionCatalog,
  step: JsonRecord,
): StepOutputs {
  const action = typeof step.action === 'string' ? step.action : ''
  const io = resolveStepIO(catalog, action, constString(step, 'script'))
  const fields: ActionField[] = [...io.outputs]
  const uncertain = new Set<string>()
  for (const output of io.outputs) {
    if (output.from === 'dynamic' || output.from === 'signal') uncertain.add(output.name)
  }

  const addSignalKeys = (spec: JsonRecord, sure: boolean): void => {
    for (const { key, type } of providedKeys(spec.provides)) {
      fields.push({ name: key, type, from: 'signal' })
      if (!sure) uncertain.add(key)
    }
    // optional 的定义就是「命中才有」，一律不确定。
    for (const { key, type } of providedKeys(spec.optional)) {
      fields.push({ name: key, type, from: 'signal' })
      uncertain.add(key)
    }
  }

  const awaitSpec = awaitSpecOf(step, 'await')
  if (awaitSpec !== undefined) {
    const signal = typeof awaitSpec.signal === 'string' ? awaitSpec.signal : ''
    // 无限等 = 必然收到（或被中断，那时这一步之后都不跑了）
    const sure = !isBounded(awaitSpec)
    fields.push({ name: `signal_${signal}`, type: 'string', from: 'signal' })
    fields.push({ name: 'by', type: 'string', from: 'signal' })
    if (!sure) {
      uncertain.add(`signal_${signal}`)
      uncertain.add('by')
      fields.push({ name: 'timedOut', type: 'bool', from: 'signal' })
      uncertain.add('timedOut')
    }
    addSignalKeys(awaitSpec, sure)
  }

  const callbackSpec = awaitSpecOf(step, 'callback')
  if (callbackSpec !== undefined) {
    const signal = typeof callbackSpec.signal === 'string' ? callbackSpec.signal : ''
    const sure = !isBounded(callbackSpec)
    fields.push({ name: `callback_${signal}`, type: 'string', from: 'signal' })
    if (!sure) {
      uncertain.add(`callback_${signal}`)
      fields.push({ name: 'callbackTimedOut', type: 'bool', from: 'signal' })
      uncertain.add('callbackTimedOut')
    }
    addSignalKeys(callbackSpec, sure)
  }

  return { fields, uncertain }
}

/** 每一步的 needs 传递闭包（决定它能读谁的出参）。 */
export function buildClosures (raw: JsonRecord): Map<string, Set<string>> {
  const steps = stepsOf(raw)
  const byId = new Map<string, JsonRecord>()
  for (const step of steps) {
    const id = stepId(step)
    if (id !== '') byId.set(id, step)
  }

  const closures = new Map<string, Set<string>>()
  const resolving = new Set<string>()
  const compute = (id: string): Set<string> => {
    const cached = closures.get(id)
    if (cached !== undefined) return cached
    // 有环时直接回空集：环本身由 R4 单独报，这里不能无限递归。
    if (resolving.has(id)) return new Set()
    resolving.add(id)
    const closure = new Set<string>()
    for (const need of stringArray(byId.get(id)?.needs)) {
      if (need === id) continue
      closure.add(need)
      for (const inherited of compute(need)) closure.add(inherited)
    }
    resolving.delete(id)
    closures.set(id, closure)
    return closure
  }
  for (const id of byId.keys()) compute(id)
  return closures
}

/** 这条流程声明的触发轴（trigger 段下除 description 外的键）。 */
function triggerAxes (raw: JsonRecord): string[] {
  if (!isRecord(raw.trigger)) return []
  return Object.keys(raw.trigger).filter(key => key !== 'description')
}

/**
 * trigger.* 根上「有人提过」的键与「恒有」的键。
 *
 * worker 的语义：Trigger 是各轴声明键的**并集**（服务深路径下钻），
 * Guaranteed 是每条入口都恒播的**交集**（只有它算恒有）。
 */
export interface TriggerEnv {
  readonly declared: ReadonlySet<string>;
  readonly guaranteed: ReadonlySet<string>;
  /** api / job 两轴的 seed 由作者自定义键名，无法枚举 —— 此时 trigger.* 一律不判。 */
  readonly openEnded: boolean;
}

export function buildTriggerEnv (catalog: ActionCatalog, raw: JsonRecord): TriggerEnv {
  const axes = triggerAxes(raw)
  const trigger = isRecord(raw.trigger) ? raw.trigger : {}
  const declared = new Set<string>()
  const perAxis: Set<string>[] = []
  let openEnded = axes.length === 0

  for (const axis of axes) {
    const spec = isRecord(trigger[axis]) ? trigger[axis] as JsonRecord : {}
    const seed = new Set(stringArray(spec.seed))
    // bizNotify 的 params 也落黑板（键名可经 as 改写）。
    if (axis === 'bizNotify' && isRecord(spec.params)) {
      for (const [key, param] of Object.entries(spec.params)) {
        const as = isRecord(param) && typeof param.as === 'string' && param.as !== '' ? param.as : key
        seed.add(as)
      }
    }
    // schedule 不播业务键；它只决定 run.intervalSec 恒不恒有。
    if (axis === 'schedule') {
      perAxis.push(new Set())
      continue
    }
    // api / job：seed 键名由作者自定，声明里写了什么就是什么。
    // 若这两轴没写 seed，则无从判断作者会播什么 —— 整个 trigger.* 放开。
    if ((axis === 'api' || axis === 'job') && seed.size === 0) openEnded = true
    for (const key of seed) declared.add(key)

    const axisSeeds = catalog.triggerSeeds[axis]
    const notGuaranteed = new Set(axisSeeds?.notGuaranteed ?? [])
    perAxis.push(new Set([...seed].filter(key => !notGuaranteed.has(key))))
  }

  // 恒有 = 每条入口都恒播的交集
  let guaranteed = new Set<string>()
  if (perAxis.length > 0) {
    guaranteed = new Set(perAxis[0])
    for (const axis of perAxis.slice(1)) {
      guaranteed = new Set([...guaranteed].filter(key => axis.has(key)))
    }
  }
  return { declared, guaranteed, openEnded }
}

/** 一条接线在声明树上的解析档位（worker 的 flowcheck.certainty）。 */
type Certainty = 'certain' | 'maybe' | 'broken'

interface RefResolution {
  readonly certainty: Certainty;
  readonly why: string;
  /** 接线源头的声明类型（steps 开头的引用可解时才有；trigger 与 run 暂不带）。 */
  readonly sourceType?: string;
}

export interface SemanticContext {
  readonly catalog: ActionCatalog;
  readonly raw: JsonRecord;
  readonly closures: Map<string, Set<string>>;
  readonly outputsByStep: Map<string, StepOutputs>;
  readonly env: TriggerEnv;
  readonly scheduled: boolean;
}

export function buildContext (catalog: ActionCatalog, document: WorkflowRawDocument): SemanticContext {
  const raw = document.raw
  const outputsByStep = new Map<string, StepOutputs>()
  for (const step of stepsOf(raw)) {
    const id = stepId(step)
    if (id !== '') outputsByStep.set(id, collectStepOutputs(catalog, step))
  }
  return {
    catalog,
    raw,
    closures: buildClosures(raw),
    outputsByStep,
    env: buildTriggerEnv(catalog, raw),
    scheduled: triggerAxes(raw).includes('schedule'),
  }
}

/**
 * 解一条 `from` 路径（worker 的 flowcheck.resolveFrom）。
 *
 * 三个根的严格度**刻意不同**，这是整个校验器最要紧的判据：
 *   trigger.* 是开放根 —— 解不开只判 maybe（触发侧承诺的是「至少有这些」）
 *   steps.* / run.* 是闭合根 —— 解不开就是拼错，一律 broken
 */
export function resolveRef (
  context: SemanticContext,
  currentStepId: string,
  path: string,
  currentIsAllDone: boolean,
): RefResolution {
  const parsed = parseRef(path)
  if (parsed === null) {
    return { certainty: 'broken', why: '路径语法不对（只认 trigger.<路径> / steps.<id>.<路径> / run.<键>）' }
  }

  if (parsed.root === 'trigger') {
    if (context.env.openEnded) return { certainty: 'maybe', why: '' }
    const head = parsed.rest[0]!
    if (!context.env.declared.has(head)) {
      return {
        certainty: 'maybe',
        why: `这条流程声明的触发方式里没有 ${head}（恒播的是 ${[...context.env.guaranteed].join('、') || '（无）'}）`,
      }
    }
    if (context.env.guaranteed.has(head)) return { certainty: 'certain', why: '' }
    return { certainty: 'maybe', why: `${head} 声明了但不保证每次都播` }
  }

  if (parsed.root === 'run') {
    const head = parsed.rest[0]!
    if (!context.catalog.runRoot.includes(head)) {
      return { certainty: 'broken', why: `run.* 根上没有 ${head}（引擎播的只有 ${context.catalog.runRoot.join('、')}）` }
    }
    if (head === 'intervalSec' && !context.scheduled) {
      return { certainty: 'maybe', why: 'run.intervalSec 只有定时触发才播，而这条流程没声明 schedule' }
    }
    return { certainty: 'certain', why: '' }
  }

  // steps.*
  const closure = context.closures.get(currentStepId)
  if (closure === undefined || !closure.has(parsed.stepId)) {
    return {
      certainty: 'broken',
      why: `${parsed.stepId} 不在本步 needs 的传递闭包里（要读一步的产出就得先依赖它）`,
    }
  }
  // $state 在出参表之前判：被跳过的步没有出参，而「它被跳过了」正是此时要读的事实。
  if (parsed.rest.length === 1 && parsed.rest[0] === STATE_KEY) {
    return { certainty: 'certain', why: '' }
  }
  if (parsed.rest[0] === STATE_KEY) {
    return { certainty: 'broken', why: `${STATE_KEY} 是一个字符串终态，底下没有字段` }
  }

  const outputs = context.outputsByStep.get(parsed.stepId)
  if (outputs === undefined) return { certainty: 'maybe', why: '' }
  // 这一步的 I/O 解不出来（未选脚本 / 未知 action）时不判：宁可漏，不可误报。
  const producing = stepsOf(context.raw).find(step => stepId(step) === parsed.stepId)
  const producerAction = typeof producing?.action === 'string' ? producing.action : ''
  const producerIO = resolveStepIO(context.catalog, producerAction, constString(producing ?? {}, 'script'))
  if (!producerIO.resolved && outputs.fields.length === 0) return { certainty: 'maybe', why: '' }

  if (!walkFields(outputs.fields, parsed.rest)) {
    const names = outputs.fields.map(field => field.name)
    return {
      certainty: 'broken',
      why: `步骤 ${parsed.stepId} 不产出 ${parsed.rest.join('.')}（它声明的出参是 ${names.join('、') || '（无）'}；要读终态请写 steps.${parsed.stepId}.${STATE_KEY}）`,
    }
  }
  const sourceType = fieldTypeAt(outputs.fields, parsed.rest)
  if (currentIsAllDone) {
    return {
      certainty: 'maybe',
      why: `本步 trigger 是 allDone（上游没成功也照跑），那时 ${parsed.stepId} 可能被跳过或失败，没有出参`,
      ...(sourceType === undefined ? {} : { sourceType }),
    }
  }
  if (outputs.uncertain.has(parsed.rest[0]!)) {
    return {
      certainty: 'maybe',
      why: `步骤 ${parsed.stepId} 的 ${parsed.rest[0]} 不是每次都产出`,
      ...(sourceType === undefined ? {} : { sourceType }),
    }
  }
  return { certainty: 'certain', why: '', ...(sourceType === undefined ? {} : { sourceType }) }
}

/** 校验一条 when 条件（R8）。 */
function checkCondition (
  context: SemanticContext,
  nodeId: string,
  condition: unknown,
  where: string,
  issues: SemanticIssue[],
): void {
  if (!isRecord(condition)) {
    issues.push({ rule: 'R8_BAD_CONDITION', level: 'error', nodeId, message: `${where} 不是一个条件对象。` })
    return
  }
  const hasLeaf = typeof condition.field === 'string' || typeof condition.op === 'string'
  const and = Array.isArray(condition.and) ? condition.and : []
  const or = Array.isArray(condition.or) ? condition.or : []
  const kinds = (hasLeaf ? 1 : 0) + (and.length > 0 ? 1 : 0) + (or.length > 0 ? 1 : 0)
  if (kinds === 0) {
    issues.push({
      rule: 'R8_BAD_CONDITION',
      level: 'error',
      nodeId,
      message: `${where} 是空条件：运行期它恒为真，这一步的守护形同虚设。`,
    })
    return
  }
  if (kinds > 1) {
    issues.push({
      rule: 'R8_BAD_CONDITION',
      level: 'error',
      nodeId,
      message: `${where} 同时写了叶子条件与 and/or：运行期 and/or 先判，field 会被安静忽略。`,
    })
    return
  }
  if (and.length > 0) {
    and.forEach((sub, index) => checkCondition(context, nodeId, sub, `${where}.and[${index}]`, issues))
    return
  }
  if (or.length > 0) {
    or.forEach((sub, index) => checkCondition(context, nodeId, sub, `${where}.or[${index}]`, issues))
    return
  }

  const op = typeof condition.op === 'string' ? condition.op : ''
  if (context.catalog.conditionOps.length > 0 && !context.catalog.conditionOps.includes(op)) {
    issues.push({
      rule: 'R8_BAD_CONDITION',
      level: 'error',
      nodeId,
      message: `${where} 的算子 ${op === '' ? '（空）' : op} 非法，合法的是 ${context.catalog.conditionOps.join(' / ')}。`,
    })
  }
  const field = typeof condition.field === 'string' ? condition.field : ''
  if (field === '') {
    issues.push({ rule: 'R8_BAD_CONDITION', level: 'error', nodeId, message: `${where} 缺 field。` })
    return
  }
  const parsed = parseRef(field)
  if (parsed === null) {
    issues.push({
      rule: 'R8_BAD_CONDITION',
      level: 'error',
      nodeId,
      message: `${where} 的 field ${field} 不是合法路径：要写成 trigger.<路径> / steps.<id>.<路径> / run.<键>（裸键名会永远取不到值，那一步再也不跑）。`,
    })
    return
  }
  // 拿 $state 比的值必须是真终态，拦 eq "timeout" 这类恒假拼错
  if (parsed.root === 'steps' && parsed.rest.length === 1 && parsed.rest[0] === STATE_KEY) {
    const states = context.catalog.stepStates
    if (states.length === 0) return
    const bad = (): void => {
      issues.push({
        rule: 'R8_BAD_CONDITION',
        level: 'error',
        nodeId,
        message: `${where} 拿 ${STATE_KEY} 比的值不是一个终态，合法取值只有 ${states.join(' / ')}。`,
      })
    }
    if (op === 'eq' || op === 'ne') {
      if (typeof condition.value !== 'string' || !states.includes(condition.value)) bad()
    } else if (op === 'in') {
      const values = Array.isArray(condition.value) ? condition.value : []
      if (values.length === 0 || values.some(item => typeof item !== 'string' || !states.includes(item))) bad()
    }
  }
}

/** 校验一步的入参接线（R1 / R2 / R3 / 类型 / 脚本元入参）。 */
function checkInputs (
  context: SemanticContext,
  step: JsonRecord,
  id: string,
  issues: SemanticIssue[],
): void {
  const action = typeof step.action === 'string' ? step.action : ''
  const scriptId = constString(step, 'script')
  const io = resolveStepIO(context.catalog, action, scriptId)

  if (io.isScript) {
    // 元入参必须是 const：装载期与发布期都要拿它的值对账插件清单。
    const inputs = isRecord(step.inputs) ? step.inputs : {}
    for (const meta of ['script', 'connectorId']) {
      const spec = inputs[meta]
      if (spec === undefined) continue
      if (isRecord(spec) && typeof spec.from === 'string') {
        issues.push({
          rule: 'SCRIPT_META_NOT_CONST',
          level: 'error',
          nodeId: id,
          inputKey: meta,
          message: `inputs.${meta} 使用了取值引用，但它必须是 {"const": …}：装载期与发布期都要拿它的值去对账插件清单。`,
        })
      }
    }
    if (scriptId === undefined || scriptId === '') {
      issues.push({
        rule: 'SCRIPT_META_NOT_CONST',
        level: 'error',
        nodeId: id,
        inputKey: 'script',
        message: 'run_script 没给 inputs.script（要写成 {"const": "<脚本 id>"}）。',
      })
    } else if (io.scriptMissing === true) {
      issues.push({
        rule: 'SCRIPT_MISSING',
        level: 'error',
        nodeId: id,
        inputKey: 'script',
        message: `引用的脚本 ${scriptId} 不在 plugin.json 的 scripts[] 里（拼错了？还是脚本改名/升版了？）。`,
      })
    }
  }

  if (!io.resolved) {
    // 未知 action：插件自定义能力是合法的（运行期可分派），只是不受审。
    if (action !== '' && context.catalog.available) {
      issues.push({
        rule: 'UNKNOWN_ACTION',
        level: isPluginAction(context.catalog, action) ? 'warning' : 'error',
        nodeId: id,
        message: isPluginAction(context.catalog, action)
          ? `插件自定义能力 ${action} 不在平台动作目录内：画布无法校验它的入参，发布期需插件随能力提交词条。`
          : `未知动作 ${action}（不在平台动作目录内；插件自定义能力要写成 ${context.catalog.pluginActionPrefix}<名>）。`,
      })
    }
    return
  }

  const declared = new Set(io.inputs.map(field => field.name))
  const wired = isRecord(step.inputs) ? step.inputs : {}
  const guarded = step.when !== undefined
  const isAllDone = step.trigger === 'allDone'

  for (const field of io.inputs) {
    const spec = wired[field.name]
    if (spec === undefined) {
      // R1：必填没接线
      if (field.required === true) {
        issues.push({
          rule: 'R1_REQUIRED_INPUT_UNWIRED',
          level: 'error',
          nodeId: id,
          inputKey: field.name,
          message: `必填入参 ${field.name} 没有设置取值：给它写一条 {"from": …} 或 {"const": …}。`,
        })
      }
      continue
    }
    if (!isRecord(spec)) continue
    if ('const' in spec) {
      if (!typeOk(field.type, spec.const)) {
        issues.push({
          rule: 'INPUT_TYPE_MISMATCH',
          level: 'error',
          nodeId: id,
          inputKey: field.name,
          message: `入参 ${field.name} 声明为 ${field.type}，但 const 给的类型对不上。`,
        })
      }
      continue
    }
    if (typeof spec.from !== 'string') continue
    // R3：接线在声明树上解不解得开
    const resolution = resolveRef(context, id, spec.from, isAllDone)
    if (resolution.certainty === 'broken') {
      issues.push({
        rule: 'R3_UNRESOLVABLE_REF',
        level: 'error',
        nodeId: id,
        inputKey: field.name,
        message: `入参 ${field.name} 的取值 ${spec.from} 无法解析：${resolution.why}`,
      })
    } else if (resolution.certainty === 'maybe' && field.required === true && !guarded && resolution.why !== '') {
      issues.push({
        rule: 'R3_UNCERTAIN_REF',
        level: 'warning',
        nodeId: id,
        inputKey: field.name,
        message: `必填入参 ${field.name} 接的 ${spec.from} 不是恒有的（${resolution.why}），需 when 守护。`,
      })
    }
    // 类型相容（DAG-008-10）：接线解得开≠类型对得上。声明类型两边都拿得到时
    // 判组；任一边类型未知就不判（词表缺信息时宁可漏报，不误报）。
    if (resolution.certainty !== 'broken') {
      const wantGroup = typeGroup(field.type)
      const sourceGroup = typeGroup(resolution.sourceType)
      if (wantGroup !== undefined && sourceGroup !== undefined && wantGroup !== sourceGroup) {
        issues.push({
          rule: 'INPUT_TYPE_MISMATCH',
          level: 'error',
          nodeId: id,
          inputKey: field.name,
          message: `入参 ${field.name} 声明为 ${field.type}，但接的 ${spec.from} 是 ${resolution.sourceType}。`,
        })
      }
    }
  }

  // R2：声明之外的入参名（拼错的接线既不报错也不生效）
  for (const name of Object.keys(wired)) {
    if (declared.has(name)) continue
    issues.push({
      rule: 'R2_UNDECLARED_INPUT',
      level: 'error',
      nodeId: id,
      inputKey: name,
      message: `入参 ${name} 不在 ${action} 的声明里（拼错了？这一步声明的入参是 ${[...declared].join('、') || '（无）'}）。`,
    })
  }

  // 脚本保留键不许当业务入参
  if (io.isScript) {
    for (const name of Object.keys(wired)) {
      if (name === 'script' || name === 'connectorId') continue
      if (!SCRIPT_RESERVED_INPUT_KEYS.includes(name)) continue
      issues.push({
        rule: 'R2_UNDECLARED_INPUT',
        level: 'error',
        nodeId: id,
        inputKey: name,
        message: `${name} 是平台保留键，不能当业务入参递给脚本（它经 ctx 给脚本，这里再写一份会互相覆盖）。`,
      })
    }
  }
}

/**
 * 跑一遍画布的语义校验。
 *
 * `graph` 提供结构层已发现的问题（环 / 悬空 needs），本函数只补语义层，
 * 两者在 UI 上合并展示。
 */
/**
 * 一步是否**直接**引用了某个上游的产出（R9 的「取不取值」判据）。
 * 站点与 references.ts 的五处枚举对齐：inputs.*.from、when（含 and/or 递归）、
 * await/callback.timeoutSecFrom。⚠️ 不能 import references.ts（它依赖本模块，
 * 会成环）—— 判据漂移由 model.test.ts 的 refKinds 期望表与 R9 用例共同钉住。
 */
function referencesStep (step: JsonRecord, targetId: string): boolean {
  if (isRecord(step.inputs)) {
    for (const spec of Object.values(step.inputs)) {
      if (!isRecord(spec) || typeof spec.from !== 'string') continue
      if (parseRef(spec.from)?.root === 'steps' && parseRef(spec.from)!.stepId === targetId) return true
    }
  }
  if (whenReferencesStep(step.when, targetId)) return true
  for (const key of ['await', 'callback'] as const) {
    const spec = step[key]
    if (!isRecord(spec) || typeof spec.timeoutSecFrom !== 'string') continue
    const parsed = parseRef(spec.timeoutSecFrom)
    if (parsed?.root === 'steps' && parsed.stepId === targetId) return true
  }
  return false
}

function whenReferencesStep (condition: unknown, targetId: string): boolean {
  if (!isRecord(condition)) return false
  if (typeof condition.field === 'string') {
    const parsed = parseRef(condition.field)
    if (parsed?.root === 'steps' && parsed.stepId === targetId) return true
  }
  for (const key of ['and', 'or'] as const) {
    if (!Array.isArray(condition[key])) continue
    for (const child of condition[key]) {
      if (whenReferencesStep(child, targetId)) return true
    }
  }
  return false
}

/**
 * `targetId` 是否已被其余 needs 的传递闭包包含，且**每条可达路径的中间步**
 * 都是 allSucceeded（R9 的不能省的前置条件）。
 *
 * ⚠️ 中间某步是 allDone 时「它有终态」并不蕴含它的上游「成功」—— 删边会
 * 真的改变跳过传染语义。判据写松了，这条 warn 会诱导用户删出一个 bug。
 * 实现按「allSucceeded-only 可达」闭包：从各 needs 出发，只经过
 * trigger 缺省（= allSucceeded）的中间步向上走。
 */
function redundantUnder (others: readonly string[], targetId: string, stepById: Map<string, JsonRecord>): boolean {
  const reachable = new Set<string>()
  const queue = [...others]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (reachable.has(current)) continue
    reachable.add(current)
    if (current === targetId) return true
    // 中间步必须 allSucceeded（trigger 缺省即 allSucceeded）才允许继续向上传染
    const step = stepById.get(current)
    if (step === undefined || step.trigger === 'allDone') continue
    queue.push(...stringArray(step.needs))
  }
  return false
}

export function validateSemantics (
  catalog: ActionCatalog,
  document: WorkflowRawDocument,
): readonly SemanticIssue[] {
  const issues: SemanticIssue[] = []
  // 词表取不到时整体降级：不判任何语义，避免把环境问题渲染成用户的错误。
  if (!catalog.available) return issues

  const context = buildContext(catalog, document)
  const raw = document.raw
  const steps = stepsOf(raw)
  const stepById = new Map(steps.map(step => [stepId(step), step]))

  // 流程级：trigger 段至少声明一轴
  if (triggerAxes(raw).length === 0) {
    issues.push({
      rule: 'R8_BAD_CONDITION',
      level: 'error',
      nodeId: TRIGGER_NODE_ID,
      message: '触发器一项都没声明（api / schedule / stream / bizNotify / job 至少给一个，否则这条流程谁也启不动）。',
    })
  }
  // schedule 必须给 intervalSec
  const trigger = isRecord(raw.trigger) ? raw.trigger : {}
  if (isRecord(trigger.schedule)) {
    const interval = trigger.schedule.intervalSec
    if (typeof interval !== 'number' || interval <= 0) {
      issues.push({
        rule: 'R8_BAD_CONDITION',
        level: 'error',
        nodeId: TRIGGER_NODE_ID,
        message: '声明了 schedule 但没给正整数 intervalSec（平台不替业务猜周期）。',
      })
    }
  }
  // stream 的 match 不能为空，否则会匹配到全部消息（含状态变更）
  if (isRecord(trigger.stream)) {
    const match = trigger.stream.match
    if (!isRecord(match) || Object.keys(match).length === 0) {
      issues.push({
        rule: 'R8_BAD_CONDITION',
        level: 'error',
        nodeId: TRIGGER_NODE_ID,
        message: 'stream 触发的 match 为空：那会匹配到这条 stream 里的全部消息（包括状态变更那些），至少限定 status。',
      })
    }
  }
  // bizNotify 必须给 subscriber
  if (isRecord(trigger.bizNotify)) {
    const subscriber = trigger.bizNotify.subscriber
    if (typeof subscriber !== 'string' || subscriber.trim() === '') {
      issues.push({
        rule: 'R8_BAD_CONDITION',
        level: 'error',
        nodeId: TRIGGER_NODE_ID,
        message: 'bizNotify 触发缺 subscriber（它是 biz_ext 里的顶层 key，没有它就没有「这条是不是给我的」的判据）。',
      })
    }
  }

  for (const step of steps) {
    const id = stepId(step)
    if (id === '') continue

    checkInputs(context, step, id, issues)

    if (step.when !== undefined) checkCondition(context, id, step.when, 'when', issues)

    // R7：allDone 的步不许声明无界的 await/callback
    if (step.trigger === 'allDone') {
      for (const key of ['await', 'callback'] as const) {
        const spec = awaitSpecOf(step, key)
        if (spec === undefined || isBounded(spec)) continue
        issues.push({
          rule: 'R7_ALLDONE_UNBOUNDED_AWAIT',
          level: 'error',
          nodeId: id,
          message: `trigger 是 allDone 的步声明了没有超时的 ${key}：这类步跑在断开的 ctx 上，挂在那上面的等待不会被取消唤醒 —— 补一个 timeoutSec，否则这条运行永远醒不来。`,
        })
      }
    }

    // await_signal 类的步（wait_signal）必须声明挂起段：没有 await 段它既不挂起也
    // 不执行任何动作，是一条什么都不做的裸指令（DAG-019 bare-wait 在三道门放行的缺口）。
    // ⚠️ StepIO 不带 kind，直接查受审词表词条判定。
    const fixedEntry = findFixedStep(context.catalog, typeof step.action === 'string' ? step.action : '')
    if (fixedEntry?.kind === 'await_signal' && awaitSpecOf(step, 'await') === undefined) {
      issues.push({
        rule: 'AWAIT_SIGNAL_MISSING',
        level: 'error',
        nodeId: id,
        message: '等待信号的步骤必须声明 await 段（要等哪个信号、超时多久）：没有它这一步什么都不做。',
      })
    }

    // R3 对挂起段接线同样生效（DAG-019 timeout-from 放行的缺口）：timeoutSecFrom
    // 接到不在 needs 闭包里的步骤，运行期取不到值，等待永远不触发超时。
    for (const key of ['await', 'callback'] as const) {
      const spec = awaitSpecOf(step, key)
      if (spec === undefined) continue
      if (typeof spec.timeoutSecFrom === 'string' && spec.timeoutSecFrom !== '') {
        const resolution = resolveRef(context, id, spec.timeoutSecFrom, step.trigger === 'allDone')
        if (resolution.certainty === 'broken') {
          issues.push({
            rule: 'AWAIT_TIMEOUT_UNRESOLVABLE',
            level: 'error',
            nodeId: id,
            message: `${key}.timeoutSecFrom 的取值 ${spec.timeoutSecFrom} 无法解析：${resolution.why}`,
          })
        }
      }
    }

    // 同时写 timeoutSec 与 timeoutSecFrom：运行期只认后者，被忽略的数字会误导读者
    for (const key of ['await', 'callback'] as const) {
      const spec = awaitSpecOf(step, key)
      if (spec === undefined) continue
      const hasFrom = typeof spec.timeoutSecFrom === 'string' && spec.timeoutSecFrom !== ''
      const hasSec = typeof spec.timeoutSec === 'number' && spec.timeoutSec !== 0
      if (hasFrom && hasSec) {
        issues.push({
          rule: 'R7_ALLDONE_UNBOUNDED_AWAIT',
          level: 'error',
          nodeId: id,
          message: `${key} 段同时写了 timeoutSec 与 timeoutSecFrom：两者二选一，运行期只认后者。`,
        })
      }
      // provides 与 optional 同时声明一个键 = 两处说同一件事而档位不一样
      const provides = new Set(providedKeys(spec.provides).map(item => item.key))
      for (const { key: optionalKey } of providedKeys(spec.optional)) {
        if (!provides.has(optionalKey)) continue
        issues.push({
          rule: 'R5_RESERVED_OUTPUT',
          level: 'error',
          nodeId: id,
          message: `${key} 的键 ${optionalKey} 在 provides 与 optional 里各声明了一次（必带与可选只能选一个）。`,
        })
      }
      // R5：$ 是引擎保留前缀，这样声明的键运行期永远读不到
      for (const { key: signalKey } of [...providedKeys(spec.provides), ...providedKeys(spec.optional)]) {
        if (!signalKey.startsWith('$')) continue
        issues.push({
          rule: 'R5_RESERVED_OUTPUT',
          level: 'error',
          nodeId: id,
          message: `${key} 里的键 ${signalKey} 以 $ 开头：$ 是引擎保留前缀（如 ${STATE_KEY}），这样声明的键运行期永远读不到。`,
        })
      }
    }

    // 上游带 when 而本步默认 allSucceeded：跳过会顺着 needs 传染（连坐跳过）
    if (step.when === undefined && step.trigger !== 'allDone') {
      for (const need of stringArray(step.needs)) {
        const upstream = steps.find(candidate => stepId(candidate) === need)
        if (upstream?.when === undefined) continue
        issues.push({
          rule: 'R3_UNCERTAIN_REF',
          level: 'warning',
          nodeId: id,
          message: `needs 里的 ${need} 自己带 when（可能整步不跑），而本步默认 allSucceeded —— 那时本步会被连坐跳过。要的是顺序就把 trigger 写成 allDone，要的是守护就给本步也写上同一个 when。`,
        })
      }
    }
  }

  // R9：冗余 needs（ordering plan §6）。一条 needs 边如果本步不引用它任何产出，
  // 且其它 needs 的传递闭包（路径上全部 allSucceeded）已包含它，则它对顺序与
  // 跳过传染都是冗余的。
  for (const step of steps) {
    const id = stepId(step)
    if (id === '') continue
    const needs = stringArray(step.needs)
    if (needs.length < 2) continue
    for (const need of needs) {
      if (!stepById.has(need)) continue
      if (referencesStep(step, need)) continue
      if (!redundantUnder(needs.filter(other => other !== need), need, stepById)) continue
      issues.push({
        rule: 'R9_REDUNDANT_NEEDS',
        level: 'warning',
        nodeId: id,
        message: `needs 里的 ${need} 是冗余的：本步不取它任何产出，而其它前置的传递闭包已经把它排在前面。这条边删掉不会改变顺序和跳过传染。`,
      })
    }
  }

  // R6：任意两个挂起步在图上必须有先后关系
  const suspendIds = steps
    .filter(step => awaitSpecOf(step, 'await') !== undefined || awaitSpecOf(step, 'callback') !== undefined)
    .map(stepId)
    .filter(id => id !== '')
  for (let i = 0; i < suspendIds.length; i += 1) {
    for (let j = i + 1; j < suspendIds.length; j += 1) {
      const a = suspendIds[i]!
      const b = suspendIds[j]!
      if (context.closures.get(a)?.has(b) === true || context.closures.get(b)?.has(a) === true) continue
      issues.push({
        rule: 'R6_AWAIT_ORDER',
        level: 'error',
        nodeId: b,
        message: `挂起步 ${b} 与 ${a} 在图上没有先后关系：解释器按拓扑序逐个跑节点，并列的两个等待实际是一前一后，后面那个在前面那个收到信号之前压根不在等 —— 给它们之间补一条 needs。`,
      })
    }
  }

  return issues
}
