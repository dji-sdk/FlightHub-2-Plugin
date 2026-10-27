// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 节点绑定完整度（计划 §E5）：把语义问题**归纳**成一个节点级状态。
 *
 * ★★ 它不新造判据，只把 `validateSemantics` 已经报出来的问题分档。
 * 单独一层的理由是：检查器与画布要的不是「12 条 issue」，而是一句
 * 「这个节点现在能不能算配好了」—— 而那个归纳规则必须**只有一处**，
 * 否则画布的徽标与检查器的结论会不一致（用户看到绿点点进去却是红字）。
 *
 * ── 五档的顺序有意义（严重度从高到低）─────────────────────────────
 *   unresolved-contract       契约本身解不开（功能不存在、action 未知）→ 别的都无从谈起
 *   invalid-binding           接了，但这条接线是错的（路径解不开、类型不符、闭包外）
 *   incomplete-binding        必填入参没接
 *   complete-with-uncertainty 接齐了，但有说不准的地方（引用的键不恒有）
 *   locally-complete          浏览器侧能查的都通过了
 *
 * ⚠️⚠️ 最高档 `locally-complete` 的名字里有 **locally** 是刻意的：
 * 本轮没有同版本权威 checker（knowledge.json 的 checkers 恒为空），
 * 所以**不存在** `worker-check-valid` 这一档。界面不得把 locally-complete
 * 显示成「校验通过 / 可部署」—— 它只说明「结构与引用在当前词表下解得开」。
 */

import type { SemanticIssue, SemanticRule } from './semantics.js'
import { TRIGGER_NODE_ID } from './semantics.js'

/** 节点绑定状态。顺序即严重度（下标越小越严重）。 */
export const BINDING_STATES = [
  'unresolved-contract',
  'invalid-binding',
  'incomplete-binding',
  'complete-with-uncertainty',
  'locally-complete',
] as const

export type BindingState = typeof BINDING_STATES[number]

/**
 * 规则 → 状态的映射。
 *
 * ⓘ 没列进来的规则一律落到 `invalid-binding`（见 stateOfRule 的 default）——
 * 宁可把一条没归类的新规则报得偏重，也不要让它静默落到 locally-complete。
 */
const RULE_STATE: Partial<Record<SemanticRule, BindingState>> = {
  // 契约解不开：这个节点指的功能/动作压根不存在。
  SCRIPT_MISSING: 'unresolved-contract',
  UNKNOWN_ACTION: 'unresolved-contract',
  SCRIPT_META_NOT_CONST: 'unresolved-contract',

  // 接了但错了。
  R2_UNDECLARED_INPUT: 'invalid-binding',
  R3_UNRESOLVABLE_REF: 'invalid-binding',
  R4_NEEDS_CLOSURE: 'invalid-binding',
  R5_RESERVED_OUTPUT: 'invalid-binding',
  R6_AWAIT_ORDER: 'invalid-binding',
  R7_ALLDONE_UNBOUNDED_AWAIT: 'invalid-binding',
  R8_BAD_CONDITION: 'invalid-binding',
  INPUT_TYPE_MISMATCH: 'invalid-binding',

  // 必填没接。
  R1_REQUIRED_INPUT_UNWIRED: 'incomplete-binding',

  // 说不准：引用的键「声明了也可能不播」/ 出参不恒有。
  R3_UNCERTAIN_REF: 'complete-with-uncertainty',
}

function stateOfRule (rule: SemanticRule): BindingState {
  return RULE_STATE[rule] ?? 'invalid-binding'
}

function severityOf (state: BindingState): number {
  return BINDING_STATES.indexOf(state)
}

/** 一个节点的绑定完整度结论。 */
export interface NodeBindingStatus {
  readonly nodeId: string;
  readonly state: BindingState;
  /** 造成这个状态的那些问题（按严重度，最严重的在前）。 */
  readonly issues: readonly SemanticIssue[];
  /**
   * 具体到哪几个入参有问题（检查器据此精确标红）。
   * ⓘ 只含 issue 明确指到入参的那些；节点级问题不在这里。
   */
  readonly inputKeys: readonly string[];
}

/**
 * 按节点归纳绑定状态。
 *
 * ⚠️ `nodeIds` 必须由调用方给全 —— 一个**没有任何 issue** 的节点也要出现在结果里
 * （它是 locally-complete）。只遍历 issue 会让干净的节点在结果里缺席，
 * 而缺席在 UI 上的表现是「没有状态」，用户分不清是没问题还是没算。
 */
export function summarizeBindings (
  nodeIds: readonly string[],
  issues: readonly SemanticIssue[],
): readonly NodeBindingStatus[] {
  const byNode = new Map<string, SemanticIssue[]>()
  for (const id of nodeIds) byNode.set(id, [])
  for (const issue of issues) {
    // 流程级问题（nodeId 为空）不归任何节点：它们由通知栏承载。
    if (issue.nodeId === '') continue
    const bucket = byNode.get(issue.nodeId)
    if (bucket === undefined) {
      // issue 指到一个不在 nodeIds 里的节点：多半是触发器合成节点。
      byNode.set(issue.nodeId, [issue])
      continue
    }
    bucket.push(issue)
  }

  return [...byNode.entries()].map(([nodeId, bucket]) => {
    const sorted = [...bucket].sort(
      (left, right) => severityOf(stateOfRule(left.rule)) - severityOf(stateOfRule(right.rule)),
    )
    const state = sorted.length === 0 ? 'locally-complete' : stateOfRule(sorted[0]!.rule)
    return {
      nodeId,
      state,
      issues: sorted,
      inputKeys: [...new Set(sorted
        .map(issue => issue.inputKey)
        .filter((key): key is string => key !== undefined))],
    }
  })
}

/** 整条流程的结论 = 最严重的那个节点状态。 */
export function overallBindingState (statuses: readonly NodeBindingStatus[]): BindingState {
  if (statuses.length === 0) return 'locally-complete'
  return statuses.reduce<BindingState>(
    (worst, status) => (severityOf(status.state) < severityOf(worst) ? status.state : worst),
    'locally-complete',
  )
}

/** 给人看的一句话。 */
export function describeBindingState (state: BindingState): string {
  switch (state) {
    case 'unresolved-contract':
      return '契约未解析：这个节点指向的业务功能或动作找不到'
    case 'invalid-binding':
      return '参数取值有误：有参数接到了无法解析或类型不匹配的来源'
    case 'incomplete-binding':
      return '必填参数未接齐'
    case 'complete-with-uncertainty':
      return '已接齐，但有来源「声明了也可能不播」——运行期可能取不到值'
    case 'locally-complete':
      // ⚠️ 措辞不得出现「通过 / 可部署 / 已验证」：本轮没有权威 checker。
      return '浏览器侧能查的都解得开（不含真实运行验证）'
  }
}

/** 这个状态该不该拦住「提交给远端验证」一类的后续动作。 */
export function blocksHandoff (state: BindingState): boolean {
  return state === 'unresolved-contract' || state === 'invalid-binding' || state === 'incomplete-binding'
}

/** 触发器合成节点的状态也走同一套归纳（它有自己的 seed 声明问题）。 */
export function triggerNodeId (): string {
  return TRIGGER_NODE_ID
}
