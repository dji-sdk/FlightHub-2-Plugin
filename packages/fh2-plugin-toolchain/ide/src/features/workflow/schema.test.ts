// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { loadDeveloperRuntime } from '../../../../src/developer-runtime/loader.js'
import type { SchemaEntry } from '../../api/types.js'
import { WORKFLOW_SCHEMA_URI, globMatches, isWorkflowPath, readWorkflowSchema } from './schema.js'

const realSchema: unknown = loadDeveloperRuntime().schemas.workflow

const entries: readonly SchemaEntry[] = [
  { uri: 'fh2://schema/manifest', fileMatch: ['fh2-plugin.json'], schema: {} },
  { uri: WORKFLOW_SCHEMA_URI, fileMatch: ['workflows/*.json', 'flows/*.json', '*.flow.json'], schema: realSchema },
]

describe('workflow schema 读取（契约 §9：规则来自知识层，画布不自创）', () => {
  it('从真实 schema 提取出 5 种 trigger 种类，顺序照 schema', () => {
    expect(readWorkflowSchema(entries).triggerKinds).toEqual(['api', 'bizNotify', 'job', 'schedule', 'stream'])
  })

  it('提取 step 的必填字段与字段全集', () => {
    const info = readWorkflowSchema(entries)
    expect(info.requiredStepFields).toEqual(['action', 'id'])
    expect(info.stepFields).toContain('needs')
    expect(info.stepFields).toContain('inputs')
    expect(info.available).toBe(true)
  })

  it('当前 schema 未枚举 action，因此不给候选 —— 画布不得自己编一份', () => {
    expect(readWorkflowSchema(entries).actionEnum).toEqual([])
  })

  it('schema 缺失时降级成全空且 available=false', () => {
    const info = readWorkflowSchema([])
    expect(info.available).toBe(false)
    expect(info.triggerKinds).toEqual([])
  })

  it('schema 不是对象时不抛异常', () => {
    expect(readWorkflowSchema([{ uri: WORKFLOW_SCHEMA_URI, fileMatch: [], schema: 'oops' }]).available).toBe(false)
    expect(readWorkflowSchema([{ uri: WORKFLOW_SCHEMA_URI, fileMatch: [], schema: null }]).available).toBe(false)
  })
})

describe('fileMatch glob 判定', () => {
  it('* 不跨目录分隔符', () => {
    expect(globMatches('workflows/*.json', 'workflows/a.json')).toBe(true)
    expect(globMatches('workflows/*.json', 'workflows/sub/a.json')).toBe(false)
  })

  it('不含 / 的 pattern 按文件名匹配任意目录（与 Monaco 一致）', () => {
    expect(globMatches('*.flow.json', 'deep/dir/order.flow.json')).toBe(true)
    expect(globMatches('*.flow.json', 'order.json')).toBe(false)
  })

  it('**/ 跨任意层级，且可匹配零层（与 VS Code glob 语义一致）', () => {
    expect(globMatches('a/**/c.json', 'a/b/x/c.json')).toBe(true)
    expect(globMatches('a/**/c.json', 'a/c.json')).toBe(true)
    expect(globMatches('a/**/c.json', 'b/c.json')).toBe(false)
  })

  it('isWorkflowPath 用契约返回的 fileMatch，而不是靠扩展名猜', () => {
    expect(isWorkflowPath('workflows/daily-report.json', entries)).toBe(true)
    expect(isWorkflowPath('flows/x.json', entries)).toBe(true)
    expect(isWorkflowPath('order.flow.json', entries)).toBe(true)
    expect(isWorkflowPath('fh2-plugin.json', entries)).toBe(false)
    expect(isWorkflowPath('src/plugin.ts', entries)).toBe(false)
  })

  it('行业工作区的精确后端成员 glob 能识别嵌套 Workflow，且不误匹配其他成员', () => {
    const nested: readonly SchemaEntry[] = [{
      uri: WORKFLOW_SCHEMA_URI,
      fileMatch: [
        '**/official_accident/backend/official_accident_plugin/workflows/*.json',
        '**/official_accident/backend/official_accident_plugin/flows/*.json',
        '**/official_accident/backend/official_accident_plugin/*.flow.json',
      ],
      schema: realSchema,
    }]
    expect(isWorkflowPath(
      'official_accident/backend/official_accident_plugin/workflows/accident-response.json',
      nested,
    )).toBe(true)
    expect(isWorkflowPath(
      'official_parking/backend/official_parking_plugin/workflows/patrol.json',
      nested,
    )).toBe(false)
    expect(isWorkflowPath(
      'official_accident/frontend/official_accident_ui/workflows/demo.json',
      nested,
    )).toBe(false)
  })

  it('schemas 里没有 workflow 条目时回落到契约 §2.7 明文列出的三个 glob', () => {
    expect(isWorkflowPath('workflows/a.json', [])).toBe(true)
    expect(isWorkflowPath('src/a.json', [])).toBe(false)
  })
})
