// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 知识包 Catalog → 画布语义（`IdeActionsData`）的适配层。
 *
 * ★★ 本模块是计划 §B4 的落点。它存在的理由是两侧形状**刻意不同**：
 * 知识包按「worker 事实」组织（retry 三档、ioResolution、seedNotGuaranteed），
 * 画布按「要画什么」组织（nonIdempotent 徽标、notGuaranteed 黄标）。
 * 硬把画布类型改成知识包形状会让 Canvas/Inspector 全量返工；
 * 硬把知识包裁成画布形状会丢掉事实。故此处做一次显式翻译，并在翻译里说清每一处取舍。
 *
 * ⚠️ 翻译**只做映射，不补默认值**。知识包里没有的东西，这里也不能凭空生出来 ——
 * 那会让手抄快照的老毛病（画布多画/少画一条红线）以新形式回来。
 */

import type {
  KnowledgeAction,
  KnowledgeField,
  KnowledgeLanguage,
  KnowledgeTriggerAxis,
  PlatformCatalog,
} from '../../contracts/knowledge.js'
import type { ActionField, FixedStepSpec, TriggerSeedSpec } from './catalog.js'

/** 知识包的 I/O 字段 → 画布的 ActionField。 */
function toActionField (field: KnowledgeField, isOutput: boolean): ActionField {
  const nested = (field.fields ?? []).map(child => toActionField(child, isOutput))
  return {
    name: field.name,
    type: field.type,
    ...(field.required === true ? { required: true } : {}),
    // 出参的「不恒有」对应 worker 的 `From` 非空（dynamic / signal）。
    // 画布的 `from` 字段只判「空不空」，故这里回一个非空标记串即可。
    //
    // ★★ 判据是 `!== true` 而不是 `=== false`，这一条是有代价取向的：
    // 字段缺失时按「不恒有」处理 → 画布多画一个「需 when 守护」的黄标。
    // 反过来（缺失按恒有处理）会**少**画那个黄标，而少画的后果是那条流程
    // 在运行期取不到值，且发布前没有任何提示。宁可多提醒。
    //
    // ⓘ 正常情况下 worker 恒会输出这个字段（它刻意不带 omitempty）。
    // 这里的宽松只为兜住生产侧回退，不是默认路径。
    ...(isOutput && field.always !== true ? { from: 'dynamic' } : {}),
    // ⚠️ 入参不翻这一格：worker 侧入参的 always 恒为 true，翻过去会被误读成「入参必给」。
    ...(nested.length > 0 ? { fields: nested } : {}),
  }
}

/**
 * 哪些动作进画布的节点菜单。
 *
 * 排除 `run_script`：它的 I/O 因脚本而异，由 scripts[] 动态解引用（画布另给入口）。
 * ⓘ 判据用 `ioResolution === 'script-contract'` 而不是硬编码名字：
 * 将来再有一个「I/O 由脚本契约决定」的动作，它会自动走同一条路。
 */
function isMenuAction (action: KnowledgeAction): boolean {
  return action.ioResolution !== 'script-contract'
}

/** 知识包动作 → 画布固定步。 */
export function toFixedStep (action: KnowledgeAction): FixedStepSpec {
  return {
    action: action.name,
    // 知识包没给中文名就不硬造一个 —— 界面回落显示机器 action，
    // 比「翻译组自己的措辞」更可追溯。
    ...(action.displayName === undefined || action.displayName === '' ? {} : { displayName: action.displayName }),
    ...(action.capability === undefined || action.capability === '' ? {} : { capability: action.capability }),
    ...(action.isFlight === true ? { isFlight: true } : {}),
    // 画布只认 activity / await_signal 两档（与 worker 的 StepKind 同集合）。
    kind: action.kind === 'await_signal' ? 'await_signal' : 'activity',
    owner: action.owner === 'plugin' ? 'plugin' : 'platform',
    // ★ 只有 retry='none' 才是「非幂等故不重试」。'not-applicable'（wait_signal 不跑
    //   activity）绝不能翻成 nonIdempotent —— 那会让画布给它挂一个「重发有副作用」的
    //   徽标，而它压根没有副作用。
    ...(action.retry === 'none' ? { nonIdempotent: true } : {}),
    inputs: (action.inputs ?? []).map(field => toActionField(field, false)),
    outputs: (action.outputs ?? []).map(field => toActionField(field, true)),
    // 知识包的 notes 是逐条的边界说明；画布的 description 是一行摘要。
    // 取第一条而不是拼接：节点菜单里塞三行注意事项没人读。
    ...(action.notes !== undefined && action.notes.length > 0 ? { description: action.notes[0]! } : {}),
  }
}

/** 知识包触发轴 → 画布的 seed 候选。 */
export function toTriggerSeed (axis: KnowledgeTriggerAxis): TriggerSeedSpec {
  return {
    available: [...(axis.seedKeys ?? [])],
    notGuaranteed: [...(axis.seedNotGuaranteed ?? [])],
    // 知识包还没带 seedTypes 时没有这张表 —— 界面显示不带类型，不猜（见 TriggerSeedSpec.types ★）。
    ...(axis.seedTypes === undefined ? {} : { types: { ...axis.seedTypes } }),
  }
}

/** 从 language.json 取画布要的那几张词表。 */
export interface LanguageVocabulary {
  readonly runRoot: readonly string[];
  readonly stepStates: readonly string[];
  readonly conditionOps: readonly string[];
  readonly stepTriggers: readonly string[];
  readonly pluginActionPrefix: string;
  /**
   * 一个 I/O 字段的 `type` 能取哪些值（清单 `scripts[].io.*[].type`）。
   *
   * ★★ 必须从知识包来，不能在画布里硬编码一份：worker 的 `flow.TypeOK` 对**词表外的
   * 类型名恒真**（见 flow.go 的 `// 词表外的类型名:不判`）。也就是说拼错一个
   * `bolean` 不会有任何报错，只会让那个字段**从此不做类型校验** —— 而画布若自带一份
   * 过时的枚举，就会把这种静默降级亲手发给用户。
   *
   * ⓘ 取 `providedTypes`：它就是 worker 的 `flow.Type*` 那一张表，
   *   `scriptField.type` 的 enum 与它同源（见知识包 schemas/plugin.schema.json）。
   */
  readonly ioFieldTypes: readonly string[];
}

export function toVocabulary (language: KnowledgeLanguage): LanguageVocabulary {
  return {
    runRoot: language.runRoot.map(field => field.name),
    stepStates: [...language.stepStates],
    conditionOps: [...language.conditionOps],
    stepTriggers: [...language.triggerModes],
    pluginActionPrefix: language.pluginActionPrefix,
    ioFieldTypes: [...language.providedTypes],
  }
}

/** 把整份知识 Catalog 翻成画布要的三块。 */
export interface AdaptedCatalog {
  readonly fixedSteps: readonly FixedStepSpec[];
  readonly triggerSeeds: Readonly<Record<string, TriggerSeedSpec>>;
  readonly vocabulary: LanguageVocabulary;
  readonly grantableCaps: readonly string[];
  /** 动态脚本步的 action 名，从知识包里认出来而不是硬编码。 */
  readonly scriptAction: string;
}

export function adaptPlatformCatalog (catalog: PlatformCatalog): AdaptedCatalog {
  const scriptAction = catalog.actions.find(action => action.ioResolution === 'script-contract')?.name
  if (scriptAction === undefined) {
    // 整个 JS-first 模型都靠这一步。知识包里没有它，说明这份 Catalog 不是后端插件的。
    throw new Error('知识 Catalog 里没有「I/O 由脚本契约决定」的动作（run_script）：这份 Catalog 不可用于工作流画布')
  }
  const triggerSeeds: Record<string, TriggerSeedSpec> = {}
  for (const axis of catalog.triggers) triggerSeeds[axis.name] = toTriggerSeed(axis)

  return {
    fixedSteps: catalog.actions.filter(isMenuAction).map(toFixedStep),
    triggerSeeds,
    vocabulary: toVocabulary(catalog.language),
    grantableCaps: [...catalog.hostApi.grantableCapabilities],
    scriptAction,
  }
}
