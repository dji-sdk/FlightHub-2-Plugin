// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 引用站点的**唯一枚举点**：谁在引用谁、改一个 step id 要动哪几处、删一步会波及什么。
 *
 * ★★ 为什么必须集中在一处：引用出现在**五个**互不相邻的位置 ——
 *   `needs[]`、`inputs.<键>.from`、`when`（含 and/or 递归）里的 `field`、
 *   `await.timeoutSecFrom`、`callback.timeoutSecFrom`
 * 每加一个消费者（重命名、删除影响、悬空检查、候选计算）就各自遍历一遍的话，
 * 必然有人漏掉其中一两处 —— 而漏掉的表现是**静默的**：
 * 重命名漏了 `when.field`，那条 when 从此恒假，收尾节点再也不跑，日志里一行异常都没有。
 *
 * ⚠️ 本模块只**读**文档并产出编辑意图，不自己改文档：改动一律经 PreparedCommand
 * 走 applyPrepared（那里才有前置核验与原子性）。
 */

import type { CommandImpact } from './commands.js'
import type { JsonEditOp } from './json-edits.js'
import { TRIGGER_NODE_ID, parseRef } from './semantics.js'

/**
 * 工作流 JSON 的一个对象节点。
 *
 * ⓘ 与 model.ts / semantics.ts 里的同名局部别名同义。三处各自声明一个
 * `Record<string, unknown>` 别名不构成「第二事实源」—— 它没有内容，只是可读性。
 */
type JsonRecord = Record<string, unknown>

/** 一处引用站点。 */
export interface ReferenceSite {
  /** 引用方步骤 id。 */
  readonly stepId: string;
  /** 站点种类。 */
  readonly kind: 'needs' | 'input' | 'when' | 'awaitTimeout' | 'callbackTimeout';
  /**
   * 人读的位置描述（`inputs.decision.from` / `needs[1]` / `when.and[0].field`）。
   * 用于影响清单与诊断，不参与寻址。
   */
  readonly at: string;
  /** JSON 路径（相对文档根），可直接给 json-edits 用来改写。 */
  readonly path: readonly (string | number)[];
  /** 当前字面值。 */
  readonly value: string;
  /**
   * 引用指向的步骤 id；引用的是 `trigger.*` / `run.*` 根时为 undefined。
   * ⚠️ `needs` 站点这一格恒等于 value（它本身就是一个步骤 id）。
   */
  readonly targetStepId?: string;
}

function isRecord (value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray (value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stepsOf (raw: JsonRecord): JsonRecord[] {
  return Array.isArray(raw.steps) ? raw.steps.filter(isRecord) : []
}

function stepIdOf (step: JsonRecord): string {
  return typeof step.id === 'string' ? step.id : ''
}

/** 从一条引用路径里取出它指向的步骤 id（不是 steps.* 根就回 undefined）。 */
function targetOf (reference: string): string | undefined {
  const parsed = parseRef(reference)
  return parsed?.root === 'steps' ? parsed.stepId : undefined
}

/**
 * 递归收集 `when` 里的所有 `field`。
 *
 * ⚠️ 必须递归 and/or：条件是可嵌套的组合形态，只看顶层 `field` 会漏掉
 * `{"and":[{"field":"steps.x.y","op":"present"}]}` 这种最常见的写法。
 */
function collectWhenFields (
  condition: unknown,
  basePath: readonly (string | number)[],
  baseAt: string,
  out: { path: (string | number)[]; at: string; value: string }[],
): void {
  if (!isRecord(condition)) return
  if (typeof condition.field === 'string' && condition.field !== '') {
    out.push({ path: [...basePath, 'field'], at: `${baseAt}.field`, value: condition.field })
  }
  for (const key of ['and', 'or'] as const) {
    const branch = condition[key]
    if (!Array.isArray(branch)) continue
    branch.forEach((child, index) => {
      collectWhenFields(child, [...basePath, key, index], `${baseAt}.${key}[${index}]`, out)
    })
  }
}

/** 枚举整份文档里的全部引用站点（按步骤书写顺序，稳定输出）。 */
export function collectReferences (raw: JsonRecord): readonly ReferenceSite[] {
  const sites: ReferenceSite[] = []
  stepsOf(raw).forEach((step, stepIndex) => {
    const stepId = stepIdOf(step)

    // ① needs：控制依赖。
    stringArray(step.needs).forEach((need, needIndex) => {
      sites.push({
        stepId,
        kind: 'needs',
        at: `needs[${needIndex}]`,
        path: ['steps', stepIndex, 'needs', needIndex],
        value: need,
        targetStepId: need,
      })
    })

    // ② inputs.<键>.from：数据依赖。
    if (isRecord(step.inputs)) {
      for (const [key, spec] of Object.entries(step.inputs)) {
        if (!isRecord(spec) || typeof spec.from !== 'string' || spec.from === '') continue
        const target = targetOf(spec.from)
        sites.push({
          stepId,
          kind: 'input',
          at: `inputs.${key}.from`,
          path: ['steps', stepIndex, 'inputs', key, 'from'],
          value: spec.from,
          ...(target === undefined ? {} : { targetStepId: target }),
        })
      }
    }

    // ③ when.field（含 and/or 递归）。
    const whenFields: { path: (string | number)[]; at: string; value: string }[] = []
    collectWhenFields(step.when, ['steps', stepIndex, 'when'], 'when', whenFields)
    for (const field of whenFields) {
      const target = targetOf(field.value)
      sites.push({
        stepId,
        kind: 'when',
        at: field.at,
        path: field.path,
        value: field.value,
        ...(target === undefined ? {} : { targetStepId: target }),
      })
    }

    // ④⑤ await / callback 的 timeoutSecFrom：等多久是业务参数，也是一条引用。
    for (const key of ['await', 'callback'] as const) {
      const spec = step[key]
      if (!isRecord(spec) || typeof spec.timeoutSecFrom !== 'string' || spec.timeoutSecFrom === '') continue
      const target = targetOf(spec.timeoutSecFrom)
      sites.push({
        stepId,
        kind: key === 'await' ? 'awaitTimeout' : 'callbackTimeout',
        at: `${key}.timeoutSecFrom`,
        path: ['steps', stepIndex, key, 'timeoutSecFrom'],
        value: spec.timeoutSecFrom,
        ...(target === undefined ? {} : { targetStepId: target }),
      })
    }
  })
  return sites
}

/**
 * 把一条引用路径里的 step id 段换掉。
 *
 * ★★ **只换那一段**，不做字符串整体替换。`steps.pick.pickedId` 里 `pick` 出现两次，
 * 整体 replace 会把 `pickedId` 也改成 `chosenId`ed —— 那是一个仍然合法、
 * 但指向一个不存在的键的路径，发布期才报，报的位置离真正的操作很远。
 */
export function renameRefStepId (reference: string, from: string, to: string): string {
  const parsed = parseRef(reference)
  if (parsed === null || parsed.root !== 'steps' || parsed.stepId !== from) return reference
  const rest = parsed.rest.length === 0 ? '' : `.${parsed.rest.join('.')}`
  return `steps.${to}${rest}`
}

/** 重命名一个步骤 id 要产生的全部编辑（含步骤自身的 `id` 字段）。 */
export function renameStepEdits (raw: JsonRecord, from: string, to: string): readonly JsonEditOp[] {
  const ops: JsonEditOp[] = []
  stepsOf(raw).forEach((step, index) => {
    if (stepIdOf(step) === from) ops.push({ path: ['steps', index, 'id'], value: to })
  })
  for (const site of collectReferences(raw)) {
    if (site.targetStepId !== from) continue
    const next = site.kind === 'needs' ? to : renameRefStepId(site.value, from, to)
    if (next === site.value) continue
    ops.push({ path: [...site.path], value: next })
  }
  return ops
}

/**
 * 删一个步骤会波及哪些既有配置。
 *
 * ★★ 只**报告**，不自动改（计划 §D3：删除和断边先展示影响，不自动重接或删除业务接线）。
 * 自动删掉引用它的那些 `inputs.*.from` 等于替用户丢配置；自动重接更糟 ——
 * 它会把一条接线悄悄指到另一个步骤，而那条线的语义完全变了。
 */
export function impactsOfRemovingStep (raw: JsonRecord, stepId: string): readonly CommandImpact[] {
  return collectReferences(raw)
    .filter(site => site.targetStepId === stepId && site.stepId !== stepId)
    .map(site => ({
      stepId: site.stepId,
      at: site.at,
      current: site.value,
      why: site.kind === 'needs'
        ? `依赖 ${stepId}，删除后这条依赖会指向一个不存在的步骤`
        : `引用了 ${stepId} 的产出，删除后这条接线解不开`,
    }))
}

/** 断一条依赖边会波及哪些**取值**（数据依赖不随控制依赖自动消失）。 */
export function impactsOfDisconnect (
  raw: JsonRecord,
  from: string,
  to: string,
): readonly CommandImpact[] {
  const closures = reachableAncestors(raw)
  // DAG-005-11：断开 from → to 后，from 若仍经其它路径传递可达 to（如
  // to → middle → from），取值接线依旧解得开 —— 不算 broken impact。
  // 只认直接 needs 的「断引用审批」会把合法的传递可达配置误拦下来。
  const after = reachableAncestors(raw, { withoutEdge: { from, to } })
  return collectReferences(raw)
    .filter(site => site.stepId === to && site.kind !== 'needs' && site.targetStepId === from)
    .filter(_site => after.get(to)?.has(from) !== true)
    .map(site => ({
      stepId: site.stepId,
      at: site.at,
      current: site.value,
      why: closures.get(to)?.has(from) === true
        ? `断开 ${from} → ${to} 后，${from} 不再在依赖闭包里，这条接线会解不开`
        : `引用了 ${from} 的产出`,
    }))
}

/**
 * 每个步骤的**依赖闭包**（可达祖先集合）。
 *
 * ⚠️ 与 `needs` 的直接上游不是一回事：参数可以来自闭包里的任意祖先（方案 §2.4），
 * 只认直接上游会把大量合法配置误判成断链。
 *
 * `withoutEdge`：在计算前先从图里摘掉一条边（评估"断开后闭包还剩什么"），
 * 不修改传入的 raw。
 */
export function reachableAncestors (
  raw: JsonRecord,
  options?: { readonly withoutEdge?: { readonly from: string; readonly to: string } },
): Map<string, Set<string>> {
  const ignore = options?.withoutEdge
  const steps = stepsOf(raw)
  const needsOf = new Map<string, string[]>()
  for (const step of steps) {
    const id = stepIdOf(step)
    let needs = stringArray(step.needs)
    if (ignore !== undefined && id === ignore.to) needs = needs.filter(item => item !== ignore.from)
    needsOf.set(id, needs)
  }

  const cache = new Map<string, Set<string>>()
  const visiting = new Set<string>()
  const walk = (id: string): Set<string> => {
    const cached = cache.get(id)
    if (cached !== undefined) return cached
    // 有环时不死循环：环上的节点先占位空集，环本身由 findCycle 报。
    if (visiting.has(id)) return new Set()
    visiting.add(id)
    const result = new Set<string>()
    for (const parent of needsOf.get(id) ?? []) {
      result.add(parent)
      for (const ancestor of walk(parent)) result.add(ancestor)
    }
    visiting.delete(id)
    cache.set(id, result)
    return result
  }
  for (const id of needsOf.keys()) walk(id)
  return cache
}

/**
 * 在**完整结果图**上找有向环，回环上的节点序列；无环回 null。
 *
 * ★ 「完整结果图」的意思是：判据要跑在**这条命令应用之后**的图上，而不是
 * 「新加的这条边是否指回祖先」。后者对「同时加两条边」这类操作会漏判。
 */
export function findCycle (raw: JsonRecord): readonly string[] | null {
  const steps = stepsOf(raw)
  const needsOf = new Map<string, string[]>()
  for (const step of steps) needsOf.set(stepIdOf(step), stringArray(step.needs))

  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const walk = (id: string): readonly string[] | null => {
    const current = state.get(id)
    if (current === 'done') return null
    if (current === 'visiting') {
      // 找到环：从栈里第一次出现 id 的位置切到末尾。
      const start = stack.indexOf(id)
      return [...stack.slice(start), id]
    }
    state.set(id, 'visiting')
    stack.push(id)
    for (const parent of needsOf.get(id) ?? []) {
      // 指向不存在的步骤不是环，交给悬空引用检查报。
      if (!needsOf.has(parent)) continue
      const found = walk(parent)
      if (found !== null) return found
    }
    stack.pop()
    state.set(id, 'done')
    return null
  }

  for (const id of needsOf.keys()) {
    const found = walk(id)
    if (found !== null) return found
  }
  return null
}

/**
 * 合成触发器节点**不是** `steps[]` 成员，也不许进任何 `needs`。
 *
 * ⓘ 这条判据单独导出而不是内联进校验：画布的连线合法性、命令的前置、语义校验
 * 三处都要用它，抄三遍必然有一处忘记（而忘记的那处会让用户连出一条写不进 JSON 的边）。
 */
export function isSyntheticTriggerId (id: string): boolean {
  return id === TRIGGER_NODE_ID
}
