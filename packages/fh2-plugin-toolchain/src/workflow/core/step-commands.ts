// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 工作流结构命令（计划 §D2 的前 7 条）：只改 workflow JSON，不碰清单与脚本。
 *
 * ★★ 每个 `prepare*` 都遵守同一条形状：**先把能拒的全拒掉，再产出编辑**。
 * 拒绝时给一句用户能看懂的理由（`PrepareResult.reason`），需要用户先做决定的
 * 给影响清单（`impacts`）而不是自动改 —— 后者会替用户丢配置或悄悄改变接线语义。
 *
 * ⚠️ 本模块**不写文档**：它只算出 `PreparedCommand`。落地、前置核验与原子性
 * 都在 `DocumentStore.applyPrepared`。这条分工是 C/D 的边界，不要在这里调文件 API。
 */

import type { ActionCatalog } from './catalog.js'
import { SCRIPT_META_INPUTS, findFixedStep, findScript, isPluginAction } from './catalog.js'
import type { PrepareResult, PreparedCommand } from './commands.js'
import type { JsonEditOp } from './json-edits.js'
import { applyJsonEditOps, canEditJson, hasJsonDuplicateKeys, parseJsonValue } from './json-edits.js'
import {
  findCycle,
  impactsOfDisconnect,
  impactsOfRemovingStep,
  isSyntheticTriggerId,
  reachableAncestors,
  renameStepEdits,
} from './references.js'
import { parseRef } from './semantics.js'

type JsonRecord = Record<string, unknown>

/** prepare 阶段要的上下文：一次固定的输入字节集 + 版本身份。 */
export interface WorkflowCommandContext {
  readonly workspaceEpoch: number;
  /** 依赖知识包的命令要带上它；纯结构操作可缺省。 */
  readonly knowledgeId?: string;
  readonly workflow: {
    readonly path: string;
    readonly text: string;
    readonly generation: number;
  };
  readonly catalog: ActionCatalog;
}

function reject (reason: string): PrepareResult {
  return { ok: false, reason }
}

function isRecord (value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stepsOf (raw: JsonRecord): JsonRecord[] {
  return Array.isArray(raw.steps) ? raw.steps.filter(isRecord) : []
}

function stepIndexOf (raw: JsonRecord, id: string): number {
  return stepsOf(raw).findIndex(step => step.id === id)
}

function stringArray (value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * 读出文档并做**两项前置**：能不能结构化编辑、有没有 steps 数组。
 *
 * ⚠️ 「能不能编辑」必须先问：jsonc-parser 对解析不开的文本回空编辑而不报错，
 * 于是命令会「成功」但什么都没改（见 json-edits 的 canEditJson）。
 */
function readWorkflow (context: WorkflowCommandContext): { raw: JsonRecord } | { error: string } {
  if (!canEditJson(context.workflow.text)) {
    return { error: `${context.workflow.path} 当前不是合法 JSON，请先修好语法错误再用画布编辑。` }
  }
  // 重复键是合法语法但解析取后值：结构化命令会把它「洗白」成单键，原文静默丢失
  // （DAG-014-05/07）。宁可在这里拒绝，让用户先在编辑器里修好。
  if (hasJsonDuplicateKeys(context.workflow.text)) {
    return { error: `${context.workflow.path} 存在重复键，画布结构化编辑会丢失原文；请先在编辑器里改为唯一键。` }
  }
  const raw = parseJsonValue(context.workflow.text)
  if (!isRecord(raw)) return { error: `${context.workflow.path} 顶层不是对象。` }
  return { raw }
}

/** 把编辑序列包成一条命令。 */
function command (
  context: WorkflowCommandContext,
  kind: string,
  label: string,
  ops: readonly JsonEditOp[],
  focus?: PreparedCommand['focus'],
): PreparedCommand {
  return {
    kind,
    label,
    edits: [{ path: context.workflow.path, kind: 'modify', ops }],
    expected: {
      workspaceEpoch: context.workspaceEpoch,
      documents: [{ path: context.workflow.path, generation: context.workflow.generation }],
      ...(context.knowledgeId === undefined ? {} : { knowledgeId: context.knowledgeId }),
    },
    ...(focus === undefined ? {} : { focus }),
  }
}

/** 步骤 id 的合法字符集：`steps.<id>.<键>` 按点分段解析，id 里有点会把路径切错。 */
const STEP_ID_PATTERN = /^[A-Za-z_][\w-]*$/

function checkStepId (raw: JsonRecord, id: string): string | null {
  if (!STEP_ID_PATTERN.test(id)) {
    return `步骤 id ${JSON.stringify(id)} 不合法：只能用字母/数字/下划线/连字符，且不能以数字开头（引用路径按点分段，id 里有点会把路径切错）。`
  }
  if (isSyntheticTriggerId(id)) return `${id} 是触发器合成节点的保留 id，不能用作步骤 id。`
  if (stepIndexOf(raw, id) >= 0) return `步骤 id ${id} 已存在。`
  return null
}

// ── 1. AddStep ────────────────────────────────────────────────────────────

export interface AddStepInput {
  readonly id: string;
  readonly action: string;
  /** 可选的初始上游（画布上从某个节点拖出来新建时给）。 */
  readonly upstream?: string;
  /** action 是脚本步时要绑定的脚本 id（写进 `inputs.script.const`）。 */
  readonly scriptId?: string;
}

export function prepareAddStep (context: WorkflowCommandContext, input: AddStepInput): PrepareResult {
  const read = readWorkflow(context)
  if ('error' in read) return reject(read.error)
  const { raw } = read

  const idProblem = checkStepId(raw, input.id)
  if (idProblem !== null) return reject(idProblem)

  const catalog = context.catalog
  const isScriptStep = input.action === catalog.scriptAction
  if (!isScriptStep && findFixedStep(catalog, input.action) === undefined && !isPluginAction(catalog, input.action)) {
    return reject(
      `动作 ${input.action} 不在平台动作目录里，也不是插件自定义能力（${catalog.pluginActionPrefix}<名>）。${
        catalog.available ? '' : ' ⓘ 平台动作目录未加载，无法按知识包校验动作名。'}`,
    )
  }
  if (isScriptStep) {
    if (input.scriptId === undefined || input.scriptId === '') {
      return reject('脚本步必须指定要调用的业务功能（它会写进 inputs.script 的 const）。')
    }
    if (findScript(catalog, input.scriptId) === undefined) {
      return reject(`本工程的清单里没有业务功能 ${input.scriptId}。`)
    }
  }
  if (input.upstream !== undefined) {
    if (isSyntheticTriggerId(input.upstream)) {
      return reject('触发器不是步骤，不能作为 needs 的上游（它只表示启动关系）。')
    }
    if (stepIndexOf(raw, input.upstream) < 0) return reject(`上游步骤 ${input.upstream} 不存在。`)
  }

  const step: JsonRecord = {
    id: input.id,
    action: input.action,
    ...(input.upstream === undefined ? {} : { needs: [input.upstream] }),
    ...(isScriptStep ? { inputs: { script: { const: input.scriptId } } } : {}),
  }
  const ops: JsonEditOp[] = [{ path: ['steps', stepsOf(raw).length], value: step, insert: true }]
  // steps 数组可能压根不存在（空流程），那时先建一个。
  if (!Array.isArray(raw.steps)) ops.unshift({ path: ['steps'], value: [] })

  return {
    ok: true,
    command: command(context, 'AddStep', `新增步骤 ${input.id}`, ops, { stepId: input.id }),
  }
}

// ── 2. RemoveStep ─────────────────────────────────────────────────────────

export interface RemoveStepInput {
  readonly id: string;
  /**
   * true = 用户已看过影响清单并确认继续。
   * ⚠️ 默认 false 且**不自动清理**引用：替用户删接线等于替他丢配置。
   */
  readonly force?: boolean;
}

export function prepareRemoveStep (context: WorkflowCommandContext, input: RemoveStepInput): PrepareResult {
  const read = readWorkflow(context)
  if ('error' in read) return reject(read.error)
  const { raw } = read

  const index = stepIndexOf(raw, input.id)
  if (index < 0) return reject(`步骤 ${input.id} 不存在。`)

  const impacts = impactsOfRemovingStep(raw, input.id)
  if (impacts.length > 0 && input.force !== true) {
    return {
      ok: false,
      reason: `删除 ${input.id} 会让 ${impacts.length} 处配置指向一个不存在的步骤。确认后这些地方需要你自己改。`,
      impacts,
    }
  }
  return {
    ok: true,
    command: command(context, 'RemoveStep', `删除步骤 ${input.id}`, [
      { path: ['steps', index], value: undefined },
    ]),
  }
}

// ── 3. RenameStep ─────────────────────────────────────────────────────────

export function prepareRenameStep (
  context: WorkflowCommandContext,
  input: { readonly from: string; readonly to: string },
): PrepareResult {
  const read = readWorkflow(context)
  if ('error' in read) return reject(read.error)
  const { raw } = read

  if (stepIndexOf(raw, input.from) < 0) return reject(`步骤 ${input.from} 不存在。`)
  if (input.from === input.to) return reject('新旧 id 相同。')
  const idProblem = checkStepId(raw, input.to)
  if (idProblem !== null) return reject(idProblem)

  const ops = renameStepEdits(raw, input.from, input.to)
  return {
    ok: true,
    command: command(
      context,
      'RenameStep',
      `重命名步骤 ${input.from} → ${input.to}（同时改 ${ops.length - 1} 处引用）`,
      ops,
      { stepId: input.to },
    ),
  }
}

// ── 4. ConnectDependency ──────────────────────────────────────────────────

export function prepareConnectDependency (
  context: WorkflowCommandContext,
  input: { readonly from: string; readonly to: string },
): PrepareResult {
  const read = readWorkflow(context)
  if ('error' in read) return reject(read.error)
  const { raw } = read

  if (isSyntheticTriggerId(input.from) || isSyntheticTriggerId(input.to)) {
    return reject('触发器是合成视图节点，不进 steps[] 也不进 needs：它连到没有 needs 的根步骤只表示启动关系。')
  }
  if (input.from === input.to) return reject('一个步骤不能依赖自己。')
  const toIndex = stepIndexOf(raw, input.to)
  if (toIndex < 0) return reject(`步骤 ${input.to} 不存在。`)
  if (stepIndexOf(raw, input.from) < 0) return reject(`步骤 ${input.from} 不存在。`)

  const target = stepsOf(raw)[toIndex]!
  const existing = stringArray(target.needs)
  if (existing.includes(input.from)) return reject(`${input.to} 已经依赖 ${input.from}。`)

  const ops: JsonEditOp[] = Array.isArray(target.needs)
    ? [{ path: ['steps', toIndex, 'needs', existing.length], value: input.from, insert: true }]
    : [{ path: ['steps', toIndex, 'needs'], value: [input.from] }]

  // ★ 环检查跑在**应用之后的完整图**上，不是「这条新边是否指回祖先」：
  //   后者对「一次加两条边」这类操作会漏判（见 references.test.ts 的对应用例）。
  const nextRaw = parseJsonValue(applyJsonEditOps(context.workflow.text, ops))
  if (isRecord(nextRaw)) {
    const cycle = findCycle(nextRaw)
    if (cycle !== null) {
      return reject(`这条依赖会形成环：${cycle.join(' → ')}。`)
    }
  }

  return {
    ok: true,
    command: command(context, 'ConnectDependency', `${input.to} 依赖 ${input.from}`, ops, { stepId: input.to }),
  }
}

// ── 5. DisconnectDependency ───────────────────────────────────────────────

export function prepareDisconnectDependency (
  context: WorkflowCommandContext,
  input: { readonly from: string; readonly to: string; readonly force?: boolean },
): PrepareResult {
  const read = readWorkflow(context)
  if ('error' in read) return reject(read.error)
  const { raw } = read

  const toIndex = stepIndexOf(raw, input.to)
  if (toIndex < 0) return reject(`步骤 ${input.to} 不存在。`)
  const existing = stringArray(stepsOf(raw)[toIndex]!.needs)
  const needIndex = existing.indexOf(input.from)
  if (needIndex < 0) return reject(`${input.to} 并没有依赖 ${input.from}。`)

  // 数据依赖不随控制依赖自动消失：先把还指着它的取值摊开给用户看。
  const impacts = impactsOfDisconnect(raw, input.from, input.to)
  if (impacts.length > 0 && input.force !== true) {
    return {
      ok: false,
      reason: `断开这条依赖后，${input.to} 还有 ${impacts.length} 处取值引用 ${input.from} 的产出，它们会解不开。`,
      impacts,
    }
  }
  return {
    ok: true,
    command: command(context, 'DisconnectDependency', `${input.to} 不再依赖 ${input.from}`, [
      { path: ['steps', toIndex, 'needs', needIndex], value: undefined },
    ], { stepId: input.to }),
  }
}

// ── 6. SetInput ───────────────────────────────────────────────────────────

export interface SetInputInput {
  readonly stepId: string;
  readonly key: string;
  /** `from` = 接一条引用；`const` = 写一个字面量；`clear` = 删掉这条接线。 */
  readonly mode: 'from' | 'const' | 'clear';
  readonly value?: unknown;
}

export function prepareSetInput (context: WorkflowCommandContext, input: SetInputInput): PrepareResult {
  const read = readWorkflow(context)
  if ('error' in read) return reject(read.error)
  const { raw } = read

  const index = stepIndexOf(raw, input.stepId)
  if (index < 0) return reject(`步骤 ${input.stepId} 不存在。`)
  if (input.key === '') return reject('入参名不能为空。')

  if (input.mode === 'clear') {
    const step = stepsOf(raw)[index]!
    if (!isRecord(step.inputs) || !(input.key in step.inputs)) {
      return reject(`${input.stepId} 没有入参 ${input.key}。`)
    }
    return {
      ok: true,
      command: command(context, 'SetInput', `清除 ${input.stepId}.${input.key} 的取值`, [
        { path: ['steps', index, 'inputs', input.key], value: undefined },
      ], { stepId: input.stepId }),
    }
  }

  if (input.mode === 'from') {
    const reference = typeof input.value === 'string' ? input.value : ''
    const parsed = parseRef(reference)
    if (parsed === null) {
      return reject(`引用路径 ${JSON.stringify(reference)} 不合法：只能是 trigger.<路径> / steps.<id>.<路径> / run.<键>。`)
    }
    if (parsed.root === 'steps') {
      if (stepIndexOf(raw, parsed.stepId) < 0) return reject(`引用的步骤 ${parsed.stepId} 不存在。`)
      // ★ from 候选只来自 needs 传递闭包（计划 §D3）。不在闭包里时**不自动加依赖** ——
      //   那会同时改掉控制依赖与数据依赖两个语义（方案 §2.4）。
      const closure = reachableAncestors(raw).get(input.stepId)
      if (closure?.has(parsed.stepId) !== true) {
        return reject(
          `${parsed.stepId} 不在 ${input.stepId} 的依赖闭包里，这条取值运行期解不开。`
          + `请先把 ${parsed.stepId} 加进依赖（连线），再接这个参数。`,
        )
      }
    }
    return {
      ok: true,
      command: command(context, 'SetInput', `${input.stepId}.${input.key} ← ${reference}`, [
        { path: ['steps', index, 'inputs', input.key], value: { from: reference } },
      ], { stepId: input.stepId }),
    }
  }

  // const：null / false / 0 都是**有意义的显式绑定**，不能因为 falsy 就当成没填。
  if (input.value === undefined) return reject('常量值不能是 undefined（要清除请用 clear）。')
  return {
    ok: true,
    command: command(context, 'SetInput', `${input.stepId}.${input.key} = ${JSON.stringify(input.value)}`, [
      { path: ['steps', index, 'inputs', input.key], value: { const: input.value } },
    ], { stepId: input.stepId }),
  }
}

// ── 7. SetCondition ───────────────────────────────────────────────────────

export interface SetConditionInput {
  readonly stepId: string;
  /** undefined = 删掉 when 段。 */
  readonly condition?: JsonRecord;
}

export function prepareSetCondition (
  context: WorkflowCommandContext,
  input: SetConditionInput,
): PrepareResult {
  const read = readWorkflow(context)
  if ('error' in read) return reject(read.error)
  const { raw } = read

  const index = stepIndexOf(raw, input.stepId)
  if (index < 0) return reject(`步骤 ${input.stepId} 不存在。`)

  if (input.condition === undefined) {
    return {
      ok: true,
      command: command(context, 'SetCondition', `清除 ${input.stepId} 的 when`, [
        { path: ['steps', index, 'when'], value: undefined },
      ], { stepId: input.stepId }),
    }
  }

  const problem = checkCondition(input.condition, context.catalog)
  if (problem !== null) return reject(problem)

  return {
    ok: true,
    command: command(context, 'SetCondition', `设置 ${input.stepId} 的 when`, [
      { path: ['steps', index, 'when'], value: input.condition },
    ], { stepId: input.stepId }),
  }
}

/**
 * 校验一条 when 条件：叶子/and/or **三选一**，算子取自知识词表。
 *
 * ⚠️ 算子拼错的后果不是报错，而是那条 when **恒为假** —— 被它守护的步骤再也不跑，
 * 而平台工作流执行历史里一行异常都没有。故算子必须对着词表判，不能放过未知值。
 */
function checkCondition (condition: JsonRecord, catalog: ActionCatalog): string | null {
  const hasLeaf = typeof condition.field === 'string' && condition.field !== ''
  const hasAnd = Array.isArray(condition.and)
  const hasOr = Array.isArray(condition.or)
  const forms = [hasLeaf, hasAnd, hasOr].filter(Boolean).length
  if (forms === 0) return 'when 条件要么写 field/op（叶子），要么写 and/or（组合）。'
  if (forms > 1) return 'when 条件的叶子形态与 and/or 组合形态三选一，不能同时写。'

  if (hasLeaf) {
    const op = condition.op
    if (typeof op !== 'string' || op === '') return 'when 叶子条件缺少 op。'
    if (catalog.available && !catalog.conditionOps.includes(op)) {
      return `算子 ${op} 不在支持的集合里（${catalog.conditionOps.join(' / ')}）。`
        + '⚠️ 未知算子不会报错，它会让这条 when 恒为假。'
    }
    if (parseRef(condition.field as string) === null) {
      return `when 的 field ${JSON.stringify(condition.field)} 不是合法引用路径。`
    }
    return null
  }

  const branch = (hasAnd ? condition.and : condition.or) as unknown[]
  if (branch.length === 0) return '空的 and/or 是写坏了（运行期按数学惯例：and 空为真、or 空为假）。'
  for (const child of branch) {
    if (!isRecord(child)) return 'and/or 的成员必须是条件对象。'
    const problem = checkCondition(child, catalog)
    if (problem !== null) return problem
  }
  return null
}

/** `run_script` 的步级元入参名（画布建脚本步时要一起写上，否则会被判成「声明之外的入参」）。 */
export const SCRIPT_META_INPUT_NAMES: readonly string[] = SCRIPT_META_INPUTS.map(field => field.name)

// ── 8. CreateWorkflow（P2-1 新建工作流向导） ───────────────────────────────

/** 新建工作流命令的上下文：不依赖任何已打开文档（它建的是新文件）。 */
export interface CreateWorkflowContext {
  readonly workspaceEpoch: number;
  readonly knowledgeId?: string;
}

export interface CreateWorkflowInput {
  /** 工作区相对路径（如 workflows/patrol.json）。 */
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  /** 首个启动方式；schema 要求 trigger 至少声明一轴，故向导必须让用户选。 */
  readonly axis: 'api' | 'schedule' | 'stream' | 'bizNotify' | 'job';
  /** 该轴的完整配置（必填字段由向导收齐，如 schedule 的 intervalSec）。 */
  readonly axisSpec: JsonRecord;
}

/**
 * 新建一份最小合法的工作流文件（内存虚拟文档，保存时才落盘）。
 *
 * ★ 内容是 schema 的最小合法形态：name + trigger(一轴) + steps:[]。
 * 轴的必填字段在向导里收齐 —— 造出「schema 过不了」的文件再让用户修，
 * 不如一开始就不给。
 */
export function prepareCreateWorkflow (
  context: CreateWorkflowContext,
  input: CreateWorkflowInput,
): PrepareResult {
  if (input.name.trim() === '') return reject('工作流名称不能为空。')
  if (input.path === '' || input.path.startsWith('/') || input.path.includes('\\')
    || input.path.split('/').some(segment => segment === '..' || segment === '.' || segment === '')) {
    return reject(`文件路径 ${JSON.stringify(input.path)} 必须是相对工作根的 POSIX 路径，且不含 . / .. 段。`)
  }
  if (!input.path.endsWith('.json')) return reject('文件路径必须以 .json 结尾。')
  if (!['api', 'schedule', 'stream', 'bizNotify', 'job'].includes(input.axis)) {
    return reject(`未知启动方式 ${input.axis}。`)
  }
  if (!isRecord(input.axisSpec)) return reject('启动方式配置必须是对象。')

  const document: JsonRecord = {
    name: input.name.trim(),
    ...(input.description === undefined || input.description.trim() === '' ? {} : { description: input.description.trim() }),
    trigger: { [input.axis]: input.axisSpec },
    steps: [],
  }
  return {
    ok: true,
    command: {
      kind: 'CreateWorkflow',
      label: `新建工作流 ${input.name}`,
      edits: [{ path: input.path, kind: 'create', content: `${JSON.stringify(document, null, 2)}\n` }],
      expected: {
        workspaceEpoch: context.workspaceEpoch,
        documents: [],
        ...(context.knowledgeId === undefined ? {} : { knowledgeId: context.knowledgeId }),
      },
      focus: { openPath: input.path },
    },
  }
}
