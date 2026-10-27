// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { ADAPTER_OUTPUT, EVENTS_OUTPUT, HANDLERS_OUTPUT } from '../backend/compiler.js'
import { aliasesForHandlerEntry, wrapperNameForHandlerExport } from '../backend/handler-names.js'
import { PLATFORM_COLUMN_NAMES } from '../backend/schema-facts.js'
import { hasModuleSyntax } from '../backend/source-contract.js'
import { CONTEXT_DISCOVERY_CONTRACT } from './context.js'
import {
  TRANSFORMS_CONTRACT,
  serializeTransformsContract,
  transformDescriptor,
} from './transforms.js'

describe('transforms contract', () => {
  it('覆盖全部转换条目且 ID 唯一、source 非空', () => {
    expect(TRANSFORMS_CONTRACT.transforms.map(item => item.id)).toEqual([
      'backend-bundle-mode',
      'backend-handlers-bundle',
      'backend-events-bundle',
      'backend-adapters-bundle',
      'backend-entry-naming',
      'backend-manifest-rewrite',
      'backend-schema-entities',
      'frontend-entry-shaping',
    ])
    for (const transform of TRANSFORMS_CONTRACT.transforms) {
      expect(transform.source.trim().length, `${transform.id} 缺少 source`).toBeGreaterThan(0)
      expect(transform.inputs.length, `${transform.id} 缺少 inputs`).toBeGreaterThan(0)
      expect(transform.outputs.length, `${transform.id} 缺少 outputs`).toBeGreaterThan(0)
      expect(transform.behavior.length, `${transform.id} 缺少 behavior`).toBeGreaterThan(0)
      expect(['frontend', 'backend']).toContain(transform.side)
    }
    for (const id of TRANSFORMS_CONTRACT.transforms.map(item => item.id)) {
      expect(transformDescriptor(TRANSFORMS_CONTRACT, id).id).toBe(id)
    }
  })

  it('三份 Bundle 输出路径与 compiler.ts 导出常量相等（写死对照）', () => {
    // 常量本体（对照 src/backend/compiler.ts 写死）：
    expect(HANDLERS_OUTPUT).toBe('scripts/handlers.js')
    expect(EVENTS_OUTPUT).toBe('scripts/events.js')
    expect(ADAPTER_OUTPUT).toBe('scripts/adapter.js')
    // 契约 outputs 与常量一致：
    const handlers = transformDescriptor(TRANSFORMS_CONTRACT, 'backend-handlers-bundle')
    expect(handlers.outputs.some(item => item.includes(`dist/${HANDLERS_OUTPUT}`))).toBe(true)
    const events = transformDescriptor(TRANSFORMS_CONTRACT, 'backend-events-bundle')
    expect(events.outputs.some(item => item.includes(`dist/${EVENTS_OUTPUT}`))).toBe(true)
    const adapters = transformDescriptor(TRANSFORMS_CONTRACT, 'backend-adapters-bundle')
    expect(adapters.outputs.some(item => item.includes(`dist/${ADAPTER_OUTPUT}`))).toBe(true)
  })

  it('backend-entry-naming 与 handler-names.ts 派生行为一致（探针）', () => {
    // 源码 docstring 原例：handlers/lane-change/start-mode.js + startMode → h_laneChange_startMode。
    expect(wrapperNameForHandlerExport('handlers/lane-change/start-mode.js', 'startMode')).toBe('h_laneChange_startMode')
    expect(wrapperNameForHandlerExport('handlers/a/b.js', 'x')).toBe('h_a_x')
    // h_ 前缀导出保留原名。
    expect(wrapperNameForHandlerExport('handlers/a/b.js', 'h_x')).toBe('h_x')
    // 两层目录之外的文件无法派生（契约 behavior 的 FH2_BACKEND_HANDLER_NAME_INVALID 分支）。
    expect(wrapperNameForHandlerExport('handlers/a.js', 'x')).toBeUndefined()
    expect(wrapperNameForHandlerExport('src/a/b.js', 'x')).toBeUndefined()
    // export 名必须 lowerCamelCase。
    expect(wrapperNameForHandlerExport('handlers/a/b.js', 'BadName')).toBeUndefined()
    // HTTP 别名派生（Worker 装载期）：h_<domain>_<action> 形状才有别名。
    expect(aliasesForHandlerEntry('h_laneChange_startMode')).toEqual([
      'laneChange_startMode',
      'lane-change.start-mode',
    ])
    expect(aliasesForHandlerEntry('h_custom')).toEqual([])
    // 契约 behavior 覆盖派生示例与别名事实。
    const naming = transformDescriptor(TRANSFORMS_CONTRACT, 'backend-entry-naming')
    expect(naming.behavior.some(item => item.includes('h_laneChange_startMode'))).toBe(true)
    expect(naming.behavior.some(item => item.includes('fh2_event_<eventIndex>_<consumerIndex>'))).toBe(true)
    expect(naming.behavior.some(item => item.includes('fh2_adapter_<scriptIndex>'))).toBe(true)
    expect(naming.behavior.some(item => item.includes('aliasesForHandlerEntry'))).toBe(true)
  })

  it('backend-manifest-rewrite 覆盖值级改写目标（与 Bundle 输出常量一致）', () => {
    const rewrite = transformDescriptor(TRANSFORMS_CONTRACT, 'backend-manifest-rewrite')
    expect(rewrite.behavior.some(item => item.includes(EVENTS_OUTPUT) && item.includes('fh2_event_<i>_<j>'))).toBe(true)
    expect(rewrite.behavior.some(item => item.includes(ADAPTER_OUTPUT) && item.includes('fh2_adapter_<i>'))).toBe(true)
    expect(rewrite.behavior.some(item => item.includes('structuredClone'))).toBe(true)
    expect(rewrite.outputs).toContain('dist/plugin.json（Runtime Manifest，Worker 装载格式）')
  })

  it('backend-schema-entities 平台列与 PLATFORM_COLUMN_NAMES 常量相等（写死对照）', () => {
    expect(PLATFORM_COLUMN_NAMES).toEqual(['id', 'created_at', 'updated_at', 'tenant_id'])
    const entities = transformDescriptor(TRANSFORMS_CONTRACT, 'backend-schema-entities')
    const platformLine = entities.behavior.find(item => item.includes('PLATFORM_COLUMN_NAMES'))
    expect(platformLine).toBeDefined()
    for (const column of PLATFORM_COLUMN_NAMES) {
      expect(platformLine).toContain(column)
    }
    expect(entities.behavior.some(item => item.includes('plugin_db_'))).toBe(true)
    expect(entities.behavior.some(item => item.includes('63'))).toBe(true)
    expect(entities.behavior.some(item => item.includes('TEXT'))).toBe(true)
    expect(entities.behavior.some(item => item.includes('TIMESTAMPTZ'))).toBe(true)
  })

  it('backend-bundle-mode 模式选择条件与 hasModuleSyntax 行为一致（探针）', () => {
    const mode = transformDescriptor(TRANSFORMS_CONTRACT, 'backend-bundle-mode')
    expect(mode.conditions?.some(item => item.includes('hasAnyEsm()'))).toBe(true)
    expect(mode.conditions?.some(item => item.includes('.ts 是 Bundle 模式的充分条件'))).toBe(true)
    // hasModuleSyntax 是 hasAnyEsm 的模块语法判定基础（source-contract.ts 同一实现导出）。
    expect(hasModuleSyntax('import x from \'./y\'\n')).toBe(true)
    expect(hasModuleSyntax('const p = import(\'./y\')\n')).toBe(true)
    expect(hasModuleSyntax('const a = 1\n')).toBe(false)
    expect(mode.behavior.some(item => item.includes('es2015'))).toBe(true)
  })

  it('frontend-entry-shaping 与上下文契约一致并覆盖关键行为', () => {
    const shaping = transformDescriptor(TRANSFORMS_CONTRACT, 'frontend-entry-shaping')
    expect(shaping.behavior.some(item => item.includes('all-in-one'))).toBe(true)
    expect(shaping.behavior.some(item => item.includes('asyncChunks:false'))).toBe(true)
    expect(shaping.behavior.some(item => item.includes('[name].[contenthash:8].js'))).toBe(true)
    expect(shaping.behavior.some(item => item.includes('manifestVersion'))).toBe(true)
    expect(shaping.conditions?.some(item => item.includes('plugin + views'))).toBe(true)
    // 前端插件上下文存在于 CONTEXT_DISCOVERY_CONTRACT（side 一致性）。
    expect(CONTEXT_DISCOVERY_CONTRACT.contexts.some(context => context.id === 'frontend-plugin')).toBe(true)
  })

  it('序列化双跑字节一致且契约对象冻结', () => {
    expect(serializeTransformsContract()).toBe(serializeTransformsContract())
    expect(Object.isFrozen(TRANSFORMS_CONTRACT)).toBe(true)
    expect(Object.isFrozen(TRANSFORMS_CONTRACT.transforms)).toBe(true)
    for (const transform of TRANSFORMS_CONTRACT.transforms) {
      expect(Object.isFrozen(transform)).toBe(true)
      expect(Object.isFrozen(transform.behavior)).toBe(true)
    }
  })
})
