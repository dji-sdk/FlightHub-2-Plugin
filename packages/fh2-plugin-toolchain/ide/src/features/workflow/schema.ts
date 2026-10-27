// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 从 `GET /api/schemas` 的 workflow schema 里提取画布需要的约束。
 *
 * 契约 §9：「节点类型与连线合法性由知识层约束，画布不自创规则」。
 * 因此这里只做**读取**：schema 里没写的东西，画布一律不假设（例如 `action` 在 schema 里
 * 就是 `string minLength 1`，画布就不给 action 下拉框，只给自由输入）。
 */

import type { SchemaEntry } from '../../api/types.js'

export interface WorkflowSchemaInfo {
  /** 触发种类（api / schedule / stream / bizNotify / job），顺序照 schema。 */
  readonly triggerKinds: readonly string[];
  /** step 的必填字段。 */
  readonly requiredStepFields: readonly string[];
  /** step 允许出现的字段全集（`additionalProperties: false` 时才有意义）。 */
  readonly stepFields: readonly string[];
  /** `action` 若被 schema 枚举则给出候选；当前 schema 未枚举，为空数组。 */
  readonly actionEnum: readonly string[];
  /** schema 是否真的取到了。取不到时上面各项是保守的空值，UI 要相应降级。 */
  readonly available: boolean;
}

const EMPTY: WorkflowSchemaInfo = {
  triggerKinds: [],
  requiredStepFields: [],
  stepFields: [],
  actionEnum: [],
  available: false,
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray (value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export const WORKFLOW_SCHEMA_URI = 'fh2://schema/workflow'

/** schema 取不到时的兜底：契约 §2.7 明文列出的三个 glob。 */
const DEFAULT_WORKFLOW_GLOBS: readonly string[] = ['workflows/*.json', 'flows/*.json', '*.flow.json']

/** 契约 §2.7 的 fileMatch 就是判定依据；靠 uri 猜会在后端换 uri 时失效。 */
export function isWorkflowPath (path: string, schemas: readonly SchemaEntry[]): boolean {
  const entry = schemas.find(candidate => candidate.uri === WORKFLOW_SCHEMA_URI)
  const patterns = entry === undefined ? DEFAULT_WORKFLOW_GLOBS : entry.fileMatch
  return patterns.some(pattern => globMatches(pattern, path))
}

/**
 * Monaco fileMatch 风格的 glob：`*` 不跨 `/`，`**` 跨任意层级。
 * 不带 `/` 的 pattern（如 `*.flow.json`）按「任意目录下的文件名」匹配，与 Monaco 一致。
 */
export function globMatches (pattern: string, path: string): boolean {
  const target = pattern.includes('/') ? path : (path.split('/').pop() ?? path)
  const source = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === '**/') return '(?:[^/]*/)*'
      if (part === '**') return '.*'
      if (part === '*') return '[^/]*'
      if (part === '?') return '[^/]'
      return part.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  return new RegExp(`^${source}$`).test(target)
}

export function readWorkflowSchema (schemas: readonly SchemaEntry[]): WorkflowSchemaInfo {
  const entry = schemas.find(candidate => candidate.uri === WORKFLOW_SCHEMA_URI)
  if (entry === undefined || !isRecord(entry.schema)) return EMPTY
  const schema = entry.schema

  // 契约包 workflow schema（backend/schemas/workflow.schema.json）为全内联结构：
  // trigger 与 step 约束在 properties.trigger / properties.steps.items；
  // 旧版 definitions.* 结构已随 backend-plugin-contract/ 删除。
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const trigger = isRecord(properties.trigger) ? properties.trigger : undefined
  const triggerProperties = trigger !== undefined && isRecord(trigger.properties) ? trigger.properties : {}
  const triggerKinds = Object.keys(triggerProperties).filter(key => key !== 'description')

  const steps = isRecord(properties.steps) ? properties.steps : {}
  const step = isRecord(steps.items) ? steps.items : undefined
  const stepProperties = step !== undefined && isRecord(step.properties) ? step.properties : {}
  const action = isRecord(stepProperties.action) ? stepProperties.action : {}

  return {
    triggerKinds,
    requiredStepFields: step === undefined ? [] : stringArray(step.required),
    stepFields: Object.keys(stepProperties),
    // 新 schema 的 action 枚举在 anyOf 分支里（平台 7 个动作 + plugin.* pattern），
    // 顶层 action.enum 不存在 → 不给候选；画布保持自由输入，不自创下拉。
    actionEnum: stringArray(action.enum),
    available: triggerKinds.length > 0 || Object.keys(stepProperties).length > 0,
  }
}
