// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 入参映射与 trigger 段的编辑操作。
 *
 * 与 {@link ./model.js} 同一条纪律：**全程原地改 raw**，保住键序与未知字段。
 * 画布是生成器，产出必须与手写 JSON 同构 —— 重建对象会制造大片无意义 diff。
 */

import { parseRef } from './semantics.js'
import type { SemanticContext } from './semantics.js'
import type { ActionField } from './catalog.js'
import type { WorkflowDocument } from './model.js'

type JsonRecord = Record<string, unknown>

function isRecord (value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stepsOf (raw: JsonRecord): JsonRecord[] {
  return Array.isArray(raw.steps) ? raw.steps.filter(isRecord) : []
}

function findStep (raw: JsonRecord, id: string): JsonRecord | undefined {
  return stepsOf(raw).find(step => step.id === id)
}

/**
 * 写一条入参接线。`mode` 决定写成 `{from}` 还是 `{const}` ——
 * 二者互斥（worker 的 InputSpec.UnmarshalJSON 对「同时给」当场报错），
 * 所以这里一律整条替换，不做合并。
 */
export function setStepInput (
  document: WorkflowDocument,
  stepId: string,
  key: string,
  mode: 'from' | 'const',
  value: unknown,
): boolean {
  const step = findStep(document.raw, stepId)
  if (step === undefined) return false
  if (!isRecord(step.inputs)) step.inputs = {}
  const inputs = step.inputs as JsonRecord
  const next: JsonRecord = mode === 'from' ? { from: value } : { const: value }
  const current = inputs[key]
  if (isRecord(current)) {
    const sameFrom = mode === 'from' && current.from === value
    const sameConst = mode === 'const' && 'const' in current
      && JSON.stringify(current.const) === JSON.stringify(value)
    if (sameFrom || sameConst) return false
  }
  inputs[key] = next
  return true
}

/** 删一条入参接线；删空后连 `inputs` 字段一起摘掉（空对象是噪音）。 */
export function clearStepInput (document: WorkflowDocument, stepId: string, key: string): boolean {
  const step = findStep(document.raw, stepId)
  if (step === undefined || !isRecord(step.inputs)) return false
  const inputs = step.inputs as JsonRecord
  if (!(key in inputs)) return false
  delete inputs[key]
  if (Object.keys(inputs).length === 0) delete step.inputs
  return true
}

/** 改一步的 trigger（allSucceeded / allDone）。留空 = 删字段（默认就是 allSucceeded）。 */
export function setStepTrigger (document: WorkflowDocument, stepId: string, value: string): boolean {
  const step = findStep(document.raw, stepId)
  if (step === undefined) return false
  if (value === '' || value === 'allSucceeded') {
    if (!('trigger' in step)) return false
    delete step.trigger
    return true
  }
  if (step.trigger === value) return false
  step.trigger = value
  return true
}

/** 改一步的数值字段（timeoutSec / maxAttempts / delaySec）。0 或空 = 删字段（用平台默认值）。 */
export function setStepNumber (
  document: WorkflowDocument,
  stepId: string,
  field: 'timeoutSec' | 'maxAttempts' | 'delaySec',
  value: number | null,
): boolean {
  const step = findStep(document.raw, stepId)
  if (step === undefined) return false
  if (value === null || !Number.isFinite(value) || value <= 0) {
    if (!(field in step)) return false
    delete step[field]
    return true
  }
  const next = Math.floor(value)
  if (step[field] === next) return false
  step[field] = next
  return true
}

/**
 * 切换一步的挂起段（await / callback）。
 *
 * 开启时给一个**有界**的默认超时：无界挂起是「永久挂死点」，
 * 让它成为默认值等于给每条新流程埋一个不会醒的等待。
 */
export function setStepAwait (
  document: WorkflowDocument,
  stepId: string,
  kind: 'await' | 'callback',
  spec: { readonly signal: string; readonly timeoutSec?: number } | null,
): boolean {
  const step = findStep(document.raw, stepId)
  if (step === undefined) return false
  if (spec === null) {
    if (!(kind in step)) return false
    delete step[kind]
    return true
  }
  const signal = spec.signal.trim()
  if (signal === '') return false
  const existing = isRecord(step[kind]) ? step[kind] as JsonRecord : undefined
  if (existing !== undefined) {
    if (existing.signal === signal && spec.timeoutSec === undefined) return false
    existing.signal = signal
    if (spec.timeoutSec !== undefined) {
      if (spec.timeoutSec > 0) existing.timeoutSec = spec.timeoutSec
      else delete existing.timeoutSec
    }
    return true
  }
  const next: JsonRecord = { signal }
  if (spec.timeoutSec !== undefined && spec.timeoutSec > 0) next.timeoutSec = spec.timeoutSec
  step[kind] = next
  return true
}

/**
 * 改挂起段（await/callback）里的**单个字段**（P1-2「等待与回调」页签）。
 *
 * ★ 只动名字上的那一个字段，其余（含 provides/optional 的对象形态等未知写法）
 *   原样保留 —— 整段重建会把 `{key,type}` 形态拍平成字符串数组，那是静默丢配置。
 * value 为 null 或空串 = 删该字段。
 */
export function setStepSectionField (
  document: WorkflowDocument,
  stepId: string,
  section: 'await' | 'callback',
  field: string,
  value: unknown,
): boolean {
  const step = findStep(document.raw, stepId)
  if (step === undefined) return false
  if (!isRecord(step[section])) step[section] = { signal: field === 'signal' ? String(value) : '' }
  const spec = step[section] as JsonRecord
  if (value === null || value === '') {
    if (!(field in spec)) return false
    delete spec[field]
    return true
  }
  if (JSON.stringify(spec[field]) === JSON.stringify(value)) return false
  spec[field] = value
  return true
}

/**
 * 建一个「空叶子条件」骨架（field 留空、op 用第一个合法算子）。
 *
 * ★ 显式动作（用户点了「添加条件」）：缺 field 会被语义校验标红 ——
 *   红着比半配置的默认值诚实。已存在 when 时不动（返回 false）。
 */
export function ensureStepWhen (document: WorkflowDocument, stepId: string, firstOp: string): boolean {
  const step = findStep(document.raw, stepId)
  if (step === undefined) return false
  if (step.when !== undefined) return false
  step.when = { field: '', op: firstOp }
  return true
}

/**
 * 改 when 叶子条件里的单个字段（P1-5 执行条件编辑）。
 *
 * ★ 只在 when 是叶子（field/op 形态）时可用；and/or 组合条件返回 false ——
 *   组合条件的结构化编辑留给源码（UI 硬拆会把嵌套语义拆坏）。
 */
export function setStepWhenField (
  document: WorkflowDocument,
  stepId: string,
  field: 'field' | 'op' | 'value',
  value: unknown,
): boolean {
  const step = findStep(document.raw, stepId)
  if (step === undefined) return false
  if (!isRecord(step.when)) return false
  if (Array.isArray(step.when.and) || Array.isArray(step.when.or)) return false
  const when = step.when as JsonRecord
  if (field === 'value') {
    when.value = value
    return true
  }
  if (typeof value !== 'string' || value === '') {
    if (!(field in when)) return false
    delete when[field]
    return true
  }
  if (when[field] === value) return false
  when[field] = value
  return true
}

/**
 * 删除一步的 when 段（执行条件）：这一步恢复为「总是执行」。
 *
 * 与 setStepAwait(…, null) 同型 —— 显式动作、按位删除、返回是否真的改了文档。
 * 叶子/组合条件都可删（组合条件没有结构化编辑，但删除是安全的反向操作）。
 */
export function removeStepWhen (document: WorkflowDocument, stepId: string): boolean {
  const step = findStep(document.raw, stepId)
  if (step === undefined || !('when' in step)) return false
  delete step.when
  return true
}

/** 改 trigger 某一轴下的一个字段。轴不存在就建出来（作者刚勾上这一轴）。 */
export function setTriggerField (
  document: WorkflowDocument,
  axis: string,
  field: string,
  value: unknown,
): boolean {
  if (!isRecord(document.raw.trigger)) document.raw.trigger = {}
  const trigger = document.raw.trigger as JsonRecord
  if (!isRecord(trigger[axis])) trigger[axis] = {}
  const spec = trigger[axis] as JsonRecord
  if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
    if (!(field in spec)) return false
    delete spec[field]
    return true
  }
  if (JSON.stringify(spec[field]) === JSON.stringify(value)) return false
  spec[field] = value
  return true
}

/**
 * 增删一条触发轴。
 *
 * ⚠️ 删最后一轴是允许的（作者可能正要换一轴），但语义校验会立刻报
 * 「一项都没声明」—— 那条红线比直接拒绝更有解释力。
 * ⚠️ 启用 schedule 时**不写任何默认值**（P0-4）：intervalSec 由用户显式给，
 * 缺着它语义校验会立刻红（平台不替业务猜周期）。
 * ⚠️ 已存在的轴上「再启用」是无操作 —— 绝不覆盖既有配置。
 */
export function toggleTriggerAxis (document: WorkflowDocument, axis: string, enabled: boolean): boolean {
  if (!isRecord(document.raw.trigger)) document.raw.trigger = {}
  const trigger = document.raw.trigger as JsonRecord
  if (enabled) {
    if (axis in trigger) return false
    return setTriggerAxis(document, axis, {})
  }
  return setTriggerAxis(document, axis, null)
}

/**
 * 整体替换（或创建）一条触发轴的配置。
 *
 * ★ UI 的「新增启动方式」先在草稿里配好字段，确认后经这里**一次性**提交完整
 * 结构 —— 不再走「先建空壳再逐字段补」，那会在中途留下必填字段缺失的半成品。
 * `spec` 为 null 时删除该轴；空对象 = 建出待配置的轴（缺字段的红线交给语义校验）。
 */
export function setTriggerAxis (
  document: WorkflowDocument,
  axis: string,
  spec: JsonRecord | null,
): boolean {
  if (!isRecord(document.raw.trigger)) document.raw.trigger = {}
  const trigger = document.raw.trigger as JsonRecord
  if (spec === null) {
    if (!(axis in trigger)) return false
    delete trigger[axis]
    return true
  }
  if (JSON.stringify(trigger[axis]) === JSON.stringify(spec)) return false
  trigger[axis] = spec
  return true
}

// ── from 路径钻取器的候选计算 ──────────────────────

export interface RefCandidate {
  /** 完整路径，可直接写进 `{"from": …}`。 */
  readonly path: string;
  /** 展示用的分组：来源根。 */
  readonly group: 'trigger' | 'steps' | 'run';
  /** 这个键是不是「恒有」；false 的在 UI 上标黄。 */
  readonly guaranteed: boolean;
  /** 为什么不恒有（标黄时的 tooltip）。 */
  readonly note?: string;
  readonly type?: string;
}

/** 把一个字段声明摊成候选路径（含嵌套，深度上限防病态声明）。 */
function expandField (prefix: string, field: ActionField, depth: number): string[] {
  const path = `${prefix}.${field.name}`
  if (depth >= 4 || field.fields === undefined || field.fields.length === 0) return [path]
  const paths = [path]
  for (const child of field.fields) paths.push(...expandField(path, child, depth + 1))
  return paths
}

/**
 * 算出某一步能用的全部 `from` 候选。
 *
 * ★ `steps.*` 只列**本步 needs 传递闭包里**的节点 —— 闭包外的从源头就不出现，
 * 这样 R3 的「解析不开」在 UI 上根本没机会发生（点选式构造器的价值所在）。
 */
export function refCandidates (context: SemanticContext, stepId: string): readonly RefCandidate[] {
  const candidates: RefCandidate[] = []

  // trigger.*
  for (const key of [...context.env.declared].sort()) {
    candidates.push({
      path: `trigger.${key}`,
      group: 'trigger',
      guaranteed: context.env.guaranteed.has(key),
      ...(context.env.guaranteed.has(key) ? {} : { note: '这个键声明了但不保证每次都播' }),
    })
  }

  // run.*
  for (const key of context.catalog.runRoot) {
    const guaranteed = key !== 'intervalSec' || context.scheduled
    candidates.push({
      path: `run.${key}`,
      group: 'run',
      guaranteed,
      ...(guaranteed ? {} : { note: 'run.intervalSec 只有定时触发才播，而这条流程没声明 schedule' }),
    })
  }

  // steps.*（仅闭包内）
  const closure = context.closures.get(stepId) ?? new Set<string>()
  for (const upstream of [...closure].sort()) {
    const outputs = context.outputsByStep.get(upstream)
    // $state 对闭包里的每一步恒有，且在出参表之前解析
    candidates.push({
      path: `steps.${upstream}.$state`,
      group: 'steps',
      guaranteed: true,
      type: 'string',
    })
    if (outputs === undefined) continue
    const seen = new Set<string>()
    for (const field of outputs.fields) {
      for (const path of expandField(`steps.${upstream}`, field, 0)) {
        if (seen.has(path)) continue
        seen.add(path)
        const uncertain = outputs.uncertain.has(field.name)
        candidates.push({
          path,
          group: 'steps',
          guaranteed: !uncertain,
          ...(uncertain ? { note: `${upstream} 的 ${field.name} 不是每次都产出，下游需 when 守护` } : {}),
          ...(field.type === '' ? {} : { type: field.type }),
        })
      }
    }
  }

  return candidates
}

/** 一条 from 路径当前是否还指得通（用于在面板上标出「已失效的接线」）。 */
export function isRefShapeValid (path: string): boolean {
  return parseRef(path) !== null
}
