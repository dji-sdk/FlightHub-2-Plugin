// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 工作流 JSON ↔ 图模型的双向转换。
 *
 * 画布是**生成器不是运行时**（契约 §9）：产出必须与手写 `workflows/*.json` 同构。
 * 因此这里全程围着「原始解析对象」做原地改写，而不是从图模型重建一个新对象 ——
 * 重建会丢掉未知字段、打乱键序，产生大片无意义 diff。
 * 排版（缩进 / 内联容器）由 {@link ./json-layout.js} 记录并复现。
 */

import { parseJsonWithLayout, stringifyWithLayout } from './json-layout.js'
import type { JsonLayout } from './json-layout.js'
import { TRIGGER_NODE_ID } from './projection.js'
import type { WorkflowGraph } from './projection.js'

/**
 * 图投影（toGraph / 图形状 / 只读语义字段）在 {@link ./projection.js}；
 * 这里 re-export 保持既有 import 路径不破坏（拆分见 projection.ts 的说明）。
 */
export * from './projection.js'

type JsonRecord = Record<string, unknown>

export interface WorkflowDocument {
  /** 解析后的原始对象，**可变**：所有编辑都原地改它，以保住键序与未知字段。 */
  readonly raw: JsonRecord;
  /** 原文排版（缩进、结尾换行、哪些容器是内联写法）。 */
  readonly layout: JsonLayout;
  /**
   * 「原文能否被本模块无损复现」。
   * false 说明源文件有本模块表达不出的排版，一旦落盘就会整体重排 ——
   * UI 必须在写盘前把这件事告诉用户。
   */
  readonly lossless: boolean;
}

export type WorkflowParseResult =
  | { readonly ok: true; readonly document: WorkflowDocument }
  | { readonly ok: false; readonly message: string }

function isRecord (value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray (value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function serializeWorkflow (document: WorkflowDocument): string {
  return stringifyWithLayout(document.raw, document.layout)
}

export function parseWorkflowDocument (text: string): WorkflowParseResult {
  let parsed: { readonly value: unknown; readonly layout: JsonLayout }
  try {
    parsed = parseJsonWithLayout(text)
  } catch (error) {
    return { ok: false, message: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isRecord(parsed.value)) return { ok: false, message: '工作流文件的顶层必须是对象。' }

  const document: WorkflowDocument = { raw: parsed.value, layout: parsed.layout, lossless: false }
  return { ok: true, document: { ...document, lossless: serializeWorkflow(document) === text } }
}

// ── 编辑操作：一律原地改 raw，保住键序与未知字段 ─────────────

function stepsOf (raw: JsonRecord): JsonRecord[] {
  return Array.isArray(raw.steps) ? raw.steps.filter(isRecord) : []
}

function mutableSteps (raw: JsonRecord): JsonRecord[] {
  if (!Array.isArray(raw.steps)) raw.steps = []
  return raw.steps as JsonRecord[]
}

function findStep (raw: JsonRecord, id: string): JsonRecord | undefined {
  return stepsOf(raw).find(step => step.id === id)
}

export function hasStep (document: WorkflowDocument, id: string): boolean {
  return findStep(document.raw, id) !== undefined
}

/**
 * 改 step 的可选字符串字段（description / action）。
 * 空串等于「删掉这个字段」——schema 对 action 要求 minLength 1，留空串反而造出非法文档。
 */
export function setStepText (
  document: WorkflowDocument,
  id: string,
  field: 'action' | 'description',
  value: string,
): boolean {
  const step = findStep(document.raw, id)
  if (step === undefined) return false
  const next = value.trim()
  if (next === '') {
    if (!(field in step)) return false
    delete step[field]
    return true
  }
  if (step[field] === next) return false
  step[field] = next
  return true
}

/** 改 trigger.description，语义同 {@link setStepText}。 */
export function setTriggerDescription (document: WorkflowDocument, value: string): boolean {
  const trigger = document.raw.trigger
  if (!isRecord(trigger)) return false
  const next = value.trim()
  if (next === '') {
    if (!('description' in trigger)) return false
    delete trigger.description
    return true
  }
  if (trigger.description === next) return false
  trigger.description = next
  return true
}

/**
 * 重命名 step id，并把其它 step 的 `needs` 一并改掉。
 * 直接赋值而不是删键重建，键序才不会动。
 */
export function renameStep (document: WorkflowDocument, from: string, to: string): boolean {
  const next = to.trim()
  if (next === '' || next === from) return false
  if (findStep(document.raw, next) !== undefined) return false
  const step = findStep(document.raw, from)
  if (step === undefined) return false
  step.id = next
  for (const other of stepsOf(document.raw)) {
    if (!Array.isArray(other.needs)) continue
    other.needs = other.needs.map(need => (need === from ? next : need))
  }
  return true
}

/** 新增一个 step，追加到末尾。`needs` 为空时不写该字段（隐式挂在 trigger 下）。 */
export function addStep (
  document: WorkflowDocument,
  spec: { readonly id: string; readonly action: string; readonly needs?: readonly string[] },
): boolean {
  const id = spec.id.trim()
  const action = spec.action.trim()
  if (id === '' || action === '') return false
  if (findStep(document.raw, id) !== undefined) return false
  const step: JsonRecord = { id }
  const needs = (spec.needs ?? []).filter(need => need !== TRIGGER_NODE_ID && need !== id)
  // 键序照 schema 的自然顺序：id → needs → action，与手写文件一致
  if (needs.length > 0) step.needs = [...needs]
  step.action = action
  mutableSteps(document.raw).push(step)
  return true
}

/** 删除 step，并把其它 step 对它的 `needs` 引用一并摘掉（不做「接续上游」这种猜测）。 */
export function removeStep (document: WorkflowDocument, id: string): boolean {
  const steps = document.raw.steps
  if (!Array.isArray(steps)) return false
  const index = steps.findIndex(step => isRecord(step) && step.id === id)
  if (index === -1) return false
  steps.splice(index, 1)
  for (const other of stepsOf(document.raw)) {
    if (!Array.isArray(other.needs)) continue
    const filtered = other.needs.filter(need => need !== id)
    if (filtered.length === other.needs.length) continue
    if (filtered.length === 0) delete other.needs
    else other.needs = filtered
  }
  return true
}

/**
 * 连边 = 往 target 的 `needs` 里加 source。
 * 从 trigger 连出去是「无 needs」的隐式形态，所以不写字段，直接返回 false（无改动）。
 */
export function connect (document: WorkflowDocument, from: string, to: string): boolean {
  if (from === to || from === TRIGGER_NODE_ID) return false
  const target = findStep(document.raw, to)
  if (target === undefined) return false
  if (findStep(document.raw, from) === undefined) return false
  const needs = stringArray(target.needs)
  if (needs.includes(from)) return false
  target.needs = [...needs, from]
  return true
}

/** 断边 = 从 target 的 `needs` 里摘掉 source；摘空了就删字段，回到隐式挂 trigger。 */
export function disconnect (document: WorkflowDocument, from: string, to: string): boolean {
  const target = findStep(document.raw, to)
  if (target === undefined || !Array.isArray(target.needs)) return false
  const filtered = stringArray(target.needs).filter(need => need !== from)
  if (filtered.length === stringArray(target.needs).length) return false
  if (filtered.length === 0) delete target.needs
  else target.needs = filtered
  return true
}

/**
 * 连边是否会成环。schema 没给这条规则，但 `needs` 的语义（等待上游完成）决定了
 * 成环的工作流永远跑不起来 —— 这不是画布自创的样式约束，是 DAG 本身的定义。
 */
export function wouldCreateCycle (graph: WorkflowGraph, from: string, to: string): boolean {
  if (from === to) return true
  const downstream = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const list = downstream.get(edge.from)
    if (list === undefined) downstream.set(edge.from, [edge.to])
    else list.push(edge.to)
  }
  // 从 to 出发能否走回 from：能，则这条 from→to 会闭环
  const stack = [to]
  const visited = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === from) return true
    if (visited.has(current)) continue
    visited.add(current)
    stack.push(...(downstream.get(current) ?? []))
  }
  return false
}
