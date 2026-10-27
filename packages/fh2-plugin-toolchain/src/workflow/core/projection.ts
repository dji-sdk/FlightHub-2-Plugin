// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 工作流 JSON → 图模型的投影（toGraph）。
 *
 * 从 model.ts 拆出（DAG 画布正交连线 Plan §6.2）：model 只留解析/序列化与
 * 编辑操作，图形状与只读语义字段集中在这里，供画布布局、语义角色和聚焦
 * 索引消费。字段只描述**实际 Workflow 的事实**，不包含颜色、坐标等 UI 决策。
 *
 * 依赖方向：本模块不 runtime 依赖 model.ts（只用它的类型），model.ts 反向
 * re-export 这里的导出，既有 import 路径不破坏。
 */

import { collectReferences } from './references.js'
import type { ReferenceSite } from './references.js'

/** 契约 §9：画布不自创节点类型，trigger 种类由 workflow schema 给出，这里只做结构承载。 */
export type WorkflowNodeKind = 'trigger' | 'step'

export interface WorkflowRef {
  /** inputs 的键名。 */
  readonly key: string;
  /** `from` 引用另一处的输出，`const` 是字面量。 */
  readonly kind: 'from' | 'const';
  readonly value: string;
}

export interface WorkflowNode {
  /** trigger 节点固定为 TRIGGER_NODE_ID；step 节点为 `step.id`。 */
  readonly id: string;
  readonly kind: WorkflowNodeKind;
  /** step 是 `action`；trigger 是触发种类（api / schedule / …），未知时为空串。 */
  readonly action: string;
  readonly description: string | undefined;
  readonly needs: readonly string[];
  readonly refs: readonly WorkflowRef[];
  /** step 在 `steps[]` 里的下标；trigger 为 -1。 */
  readonly index: number;
  /** `steps[].trigger` 的只读投影；缺省（= allSucceeded）不写。未知值不在此处裁决。 */
  readonly triggerMode?: 'allSucceeded' | 'allDone';
  /** step 是否声明了 `when` 条件。 */
  readonly hasWhen: boolean;
  /** step 是否声明了 `await` 挂起段。 */
  readonly hasAwait: boolean;
  /** step 是否声明了 `callback` 挂起段。 */
  readonly hasCallback: boolean;
}

/**
 * 一条边承载的引用站点种类。
 * 空 refKinds = 这条 needs 不取对方任何产出（纯顺序边）。
 * ⚠️ 与 worker 仓 internal/flowviz 的三类边判定逐条对齐
 *   （ordering-edge-semantics plan §7：两边各写一份判定必然漂移）。
 */
export type EdgeRefKind = 'input' | 'when' | 'awaitTimeout' | 'callbackTimeout'

/** 引用站点种类 → EdgeRefKind（needs 站点不构成引用事实）。 */
const REF_KIND_OF_SITE: Readonly<Record<Exclude<ReferenceSite['kind'], 'needs'>, EdgeRefKind>> = {
  input: 'input',
  when: 'when',
  awaitTimeout: 'awaitTimeout',
  callbackTimeout: 'callbackTimeout',
}

/** refKinds 的稳定排列序（枚举声明序；Set 迭代序不稳定，输出必须定序）。 */
const ORDERED_REF_KINDS: readonly EdgeRefKind[] = ['input', 'when', 'awaitTimeout', 'callbackTimeout']

export interface WorkflowEdge {
  readonly from: string;
  readonly to: string;
  /** `needs` 是显式声明；`implicit` 是「没有 needs 的 step 挂在 trigger 下」。 */
  readonly origin: 'needs' | 'implicit';
  /**
   * `to` 对 `from` 的直接引用站点种类（去重、按枚举序稳定排列）。
   * ⚠️ 只统计**直接**引用 `steps.<from>.…` 的站点：引用落在传递祖先上时，
   * 那是祖先那条边的事实，不是本条边的（plan §3.1）。
   * `implicit` 边恒为空数组 —— 下游必须先判 origin 再判 refKinds。
   */
  readonly refKinds: readonly EdgeRefKind[];
}

export type WorkflowIssueCode =
  | 'CYCLE'
  | 'DANGLING_NEEDS'
  | 'DUPLICATE_NEEDS'
  | 'DUPLICATE_STEP_ID'
  | 'EMPTY_STEPS'
  | 'MISSING_STEP_ID'
  | 'RESERVED_STEP_ID'
  | 'SELF_LOOP'

export interface WorkflowIssue {
  readonly code: WorkflowIssueCode;
  readonly nodeId: string;
  readonly message: string;
}

export interface WorkflowGraph {
  readonly name: string;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  /** 画布本地发现的结构问题。**不替代** §2.5 校验，只是让画布上能立刻看见。 */
  readonly issues: readonly WorkflowIssue[];
}

/** trigger 节点的合成 id。step 的 id 由 schema 约束 minLength≥1，不会撞上这个前缀。 */
export const TRIGGER_NODE_ID = '$trigger'

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

/** trigger 下除 `description` 外的第一个键就是触发种类（schema 的 anyOf 保证只会有一个）。 */
export function triggerKindOf (raw: JsonRecord): string {
  if (!isRecord(raw.trigger)) return ''
  return Object.keys(raw.trigger).find(key => key !== 'description') ?? ''
}

function refsOf (step: JsonRecord): WorkflowRef[] {
  if (!isRecord(step.inputs)) return []
  const refs: WorkflowRef[] = []
  for (const [key, value] of Object.entries(step.inputs)) {
    if (!isRecord(value)) continue
    if (typeof value.from === 'string') refs.push({ key, kind: 'from', value: value.from })
    else if ('const' in value) refs.push({ key, kind: 'const', value: JSON.stringify(value.const) ?? 'null' })
  }
  return refs
}

function stepTriggerMode (step: JsonRecord): 'allSucceeded' | 'allDone' | undefined {
  // 只投影已知的两档；词表外的值留给语义层裁决，这里不猜。
  if (step.trigger === 'allDone' || step.trigger === 'allSucceeded') return step.trigger
  return undefined
}

/** WorkflowDocument 的最小结构视图（raw + 排版由 model.ts 定义，这里只读 raw）。 */
export interface WorkflowRawDocument {
  readonly raw: JsonRecord;
}

/**
 * 图模型 = 一个合成 trigger 节点 + 每个 step 一个节点。
 * 边来自 `needs`；没有 `needs` 的 step 隐式挂在 trigger 下，这样画布上不会出现游离节点。
 * 每条边的引用事实来自 {@link collectReferences} 的唯一枚举（plan §3.2：不另写
 * 一份 when/inputs 遍历 —— 引用散在五处，各写一遍必然漏，漏掉是静默的）。
 */
export function toGraph (document: WorkflowRawDocument): WorkflowGraph {
  const raw = document.raw
  const steps = stepsOf(raw)
  const issues: WorkflowIssue[] = []

  // 空 steps 与悬空/成环一样属于「图立不住」：声明了触发器却没有任何可执行步骤。
  // 文案带「没有步骤」，让通知栏与 CLI 输出靠可读词而不是错误码传达。
  if (steps.length === 0) {
    issues.push({ code: 'EMPTY_STEPS', nodeId: TRIGGER_NODE_ID, message: '没有步骤：这条流程什么都不会执行。' })
  }

  const triggerDescription = isRecord(raw.trigger) && typeof raw.trigger.description === 'string'
    ? raw.trigger.description
    : undefined
  const triggerNode: WorkflowNode = {
    id: TRIGGER_NODE_ID,
    kind: 'trigger',
    action: triggerKindOf(raw),
    description: triggerDescription,
    needs: [],
    refs: [],
    index: -1,
    hasWhen: false,
    hasAwait: false,
    hasCallback: false,
  }

  const nodes: WorkflowNode[] = [triggerNode]
  const seen = new Set<string>()
  for (const [index, step] of steps.entries()) {
    const id = typeof step.id === 'string' && step.id !== '' ? step.id : `«未命名 #${index + 1}»`
    if (typeof step.id !== 'string' || step.id === '') {
      issues.push({ code: 'MISSING_STEP_ID', nodeId: id, message: `第 ${index + 1} 个 step 缺少 id。` })
    } else if (id === TRIGGER_NODE_ID) {
      issues.push({ code: 'RESERVED_STEP_ID', nodeId: id, message: `step id 不能用 ${TRIGGER_NODE_ID}（保留给触发器节点）。` })
    } else if (seen.has(id)) {
      issues.push({ code: 'DUPLICATE_STEP_ID', nodeId: id, message: `step id 重复：${id}。` })
    }
    seen.add(id)
    const triggerMode = stepTriggerMode(step)
    nodes.push({
      id,
      kind: 'step',
      action: typeof step.action === 'string' ? step.action : '',
      description: typeof step.description === 'string' ? step.description : undefined,
      needs: stringArray(step.needs),
      refs: refsOf(step),
      index,
      // exactOptionalPropertyTypes：缺省档不写显式 undefined
      ...(triggerMode === undefined ? {} : { triggerMode }),
      hasWhen: step.when !== undefined,
      hasAwait: isRecord(step.await),
      hasCallback: isRecord(step.callback),
    })
  }

  const known = new Set(nodes.map(node => node.id))
  // (stepId, targetStepId) → 引用种类集合：边的 refKinds 由站点表一次查表得出。
  const refKindsByPair = new Map<string, Set<EdgeRefKind>>()
  for (const site of collectReferences(raw)) {
    if (site.kind === 'needs' || site.targetStepId === undefined) continue
    const key = `${site.stepId}\0${site.targetStepId}`
    const kinds = refKindsByPair.get(key) ?? new Set<EdgeRefKind>()
    kinds.add(REF_KIND_OF_SITE[site.kind])
    refKindsByPair.set(key, kinds)
  }
  const refKindsOf = (stepId: string, targetStepId: string): readonly EdgeRefKind[] => {
    const kinds = refKindsByPair.get(`${stepId}\0${targetStepId}`)
    return kinds === undefined ? [] : ORDERED_REF_KINDS.filter(kind => kinds.has(kind))
  }

  const edges: WorkflowEdge[] = []
  const emitted = new Set<string>()
  for (const node of nodes) {
    if (node.kind === 'trigger') continue
    if (node.needs.length === 0) {
      edges.push({ from: TRIGGER_NODE_ID, to: node.id, origin: 'implicit', refKinds: [] })
      continue
    }
    // 同一条 needs 写两遍只画一条线，但重复本身就是错误：画布看着正常、
    // 源 JSON 却有冗余，交付门必须拦下而不是静默去重。
    if (new Set(node.needs).size !== node.needs.length) {
      const duplicated = [...new Set(node.needs.filter((need, index) => node.needs.indexOf(need) !== index))]
      issues.push({ code: 'DUPLICATE_NEEDS', nodeId: node.id, message: `step ${node.id} 的 needs 里重复列了 ${duplicated.join('、')}。` })
    }
    for (const need of node.needs) {
      if (need === node.id) {
        issues.push({ code: 'SELF_LOOP', nodeId: node.id, message: `step ${node.id} 的 needs 指向自己。` })
        continue
      }
      if (!known.has(need)) {
        issues.push({ code: 'DANGLING_NEEDS', nodeId: node.id, message: `step ${node.id} 的 needs 引用了不存在的 ${need}。` })
        continue
      }
      // 同一条 needs 写两遍只画一条线，否则 sugiyama 会算出重叠的平行边
      const key = `${need}\0${node.id}`
      if (emitted.has(key)) continue
      emitted.add(key)
      edges.push({ from: need, to: node.id, origin: 'needs', refKinds: refKindsOf(node.id, need) })
    }
  }

  // needs 成环：环上的步骤互相等待「上游完成」，永远等不到。自环已由 SELF_LOOP
  // 单独报告，这里只查两个及以上节点构成的环。DFS 三色标记 + 环签名去重，
  // 同一个环从哪个入口进都只报一次。
  const stepNeeds = new Map<string, readonly string[]>()
  for (const node of nodes) {
    if (node.kind === 'step') {
      stepNeeds.set(node.id, node.needs.filter(need => known.has(need) && need !== node.id))
    }
  }
  const cycleState = new Map<string, 'visiting' | 'done'>()
  const reportedCycles = new Set<string>()
  const visit = (id: string, trail: readonly string[]): void => {
    const state = cycleState.get(id)
    if (state === 'done') return
    if (state === 'visiting') {
      const cycleIds = [...new Set(trail.slice(trail.indexOf(id)))]
      const signature = [...cycleIds].sort().join(',')
      if (!reportedCycles.has(signature)) {
        reportedCycles.add(signature)
        issues.push({
          code: 'CYCLE',
          nodeId: cycleIds[cycleIds.length - 1]!,
          message: `needs 成环：${[...cycleIds, cycleIds[0]].join(' → ')}（环上的步骤互相等待，永远开始不了）。`,
        })
      }
      return
    }
    cycleState.set(id, 'visiting')
    for (const need of stepNeeds.get(id) ?? []) visit(need, [...trail, id])
    cycleState.set(id, 'done')
  }
  for (const node of nodes) {
    if (node.kind === 'step') visit(node.id, [])
  }

  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    nodes,
    edges,
    issues,
  }
}
