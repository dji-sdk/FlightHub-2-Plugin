// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import type { BackendContractDiagnostic } from '../backend/contract.js'
import { hasModuleSyntax, validateModuleSyntax } from '../backend/source-contract.js'
import { SOURCE_BUILD_RULES, forbiddenNodeModules } from '../source-build-rules.js'
import { classifyDiagnostic } from './diagnostics.js'
import {
  SOURCE_RESTRICTIONS_CONTRACT,
  restrictionDescriptor,
  serializeSourceRestrictionsContract,
} from './restrictions.js'

/**
 * 诊断码 → 抛出模块（相对 src/）。守卫用 classifyDiagnostic 证明契约引用的每个码
 * 都能被诊断注册表分类（fail closed：未登记模块会抛错）。
 */
const MODULE_BY_CODE: Readonly<Record<string, string>> = {
  FH2_BACKEND_NODE_IMPORT_FORBIDDEN: 'backend/source-contract.ts',
  FH2_BACKEND_BARE_IMPORT_FORBIDDEN: 'backend/source-contract.ts',
  FH2_BACKEND_DYNAMIC_IMPORT_FORBIDDEN: 'backend/source-contract.ts',
  FH2_BACKEND_REQUIRE_FORBIDDEN: 'backend/source-contract.ts',
  FH2_BACKEND_IMPORT_META_FORBIDDEN: 'backend/source-contract.ts',
  FH2_BACKEND_EVAL_FORBIDDEN: 'backend/source-contract.ts',
  FH2_BACKEND_TIMER_FORBIDDEN: 'backend/source-contract.ts',
  FH2_BACKEND_ASYNC_FORBIDDEN: 'backend/source-contract.ts',
  FH2_BACKEND_EVALUATOR_ESM_UNSUPPORTED: 'backend/source-contract.ts',
  FH2_PLUGIN_VUE_FORBIDDEN: 'build/products.ts',
  FH2_PLUGIN_VIEW_IMPORT_FORBIDDEN: 'build/products.ts',
  FH2_PLUGIN_ASSET_FORBIDDEN: 'build/products.ts',
  FH2_PLUGIN_CSS_FORBIDDEN: 'build/products.ts',
  FH2_SOURCE_TRUST_FIELD: 'validate/index.ts',
  FH2_SOURCE_BUILD_FIELD: 'validate/semantic-validator.ts',
}

/** 对单份源码执行 validateModuleSyntax 并返回触发的诊断码（真实行为探针）。 */
function codesFor (source: string): string[] {
  const diagnostics: BackendContractDiagnostic[] = []
  validateModuleSyntax('/plugin-root', 'f.ts', source, diagnostics)
  return diagnostics.map(diagnostic => diagnostic.code)
}

describe('source restrictions contract', () => {
  it('覆盖全部限制条目且 ID 唯一、source 非空', () => {
    expect(SOURCE_RESTRICTIONS_CONTRACT.restrictions.map(item => item.id)).toEqual([
      'backend-imports',
      'backend-bare-imports',
      'backend-dynamic-import',
      'backend-require',
      'backend-import-meta',
      'backend-eval',
      'backend-timers',
      'backend-async',
      'backend-evaluator-esm',
      'frontend-entry-purity',
      'frontend-manifest-source-trust',
      'import-type-exception',
    ])
    for (const restriction of SOURCE_RESTRICTIONS_CONTRACT.restrictions) {
      expect(restriction.source.trim().length, `${restriction.id} 缺少 source`).toBeGreaterThan(0)
      expect(restriction.alternatives).toBeDefined()
      expect(restriction.reason === null || restriction.reason.trim().length > 0).toBe(true)
      for (const code of restriction.diagnosticCodes) expect(code.startsWith('FH2_')).toBe(true)
    }
    for (const id of SOURCE_RESTRICTIONS_CONTRACT.restrictions.map(item => item.id)) {
      expect(restrictionDescriptor(SOURCE_RESTRICTIONS_CONTRACT, id).id).toBe(id)
    }
  })

  it('诊断码引用与诊断注册表一致（每个码都能分类）', () => {
    for (const restriction of SOURCE_RESTRICTIONS_CONTRACT.restrictions) {
      for (const code of restriction.diagnosticCodes) {
        const sourceModule = MODULE_BY_CODE[code]
        expect(sourceModule !== undefined, `守卫缺少 ${code} 的来源模块映射`).toBe(true)
        expect(() => classifyDiagnostic(code, sourceModule!), `${code} 无法分类`).not.toThrow()
      }
    }
    // import-type-exception 是放行说明：不允许携带诊断码。
    expect(restrictionDescriptor(SOURCE_RESTRICTIONS_CONTRACT, 'import-type-exception').diagnosticCodes).toEqual([])
  })

  it('backend 限制与 validateModuleSyntax 真实行为一致（逐码探针）', () => {
    expect(codesFor('import fs from \'node:fs\'\n')).toContain('FH2_BACKEND_NODE_IMPORT_FORBIDDEN')
    expect(codesFor('import fs from \'fs\'\n')).toContain('FH2_BACKEND_NODE_IMPORT_FORBIDDEN')
    expect(codesFor('import x from \'lodash\'\n')).toContain('FH2_BACKEND_BARE_IMPORT_FORBIDDEN')
    expect(codesFor('import x from \'https://example.com/x.js\'\n')).toContain('FH2_BACKEND_BARE_IMPORT_FORBIDDEN')
    expect(codesFor('const p = import(\'./x\')\n')).toContain('FH2_BACKEND_DYNAMIC_IMPORT_FORBIDDEN')
    expect(codesFor('require(\'fs\')\n')).toContain('FH2_BACKEND_REQUIRE_FORBIDDEN')
    expect(codesFor('console.log(import.meta.url)\n')).toContain('FH2_BACKEND_IMPORT_META_FORBIDDEN')
    expect(codesFor('eval(\'1\')\n')).toContain('FH2_BACKEND_EVAL_FORBIDDEN')
    expect(codesFor('new Function(\'return 1\')\n')).toContain('FH2_BACKEND_EVAL_FORBIDDEN')
    expect(codesFor('setTimeout(() => {}, 1)\n')).toContain('FH2_BACKEND_TIMER_FORBIDDEN')
    expect(codesFor('setInterval(() => {}, 1)\n')).toContain('FH2_BACKEND_TIMER_FORBIDDEN')
    expect(codesFor('setImmediate(() => {})\n')).toContain('FH2_BACKEND_TIMER_FORBIDDEN')
    expect(codesFor('async function f() {}\n')).toContain('FH2_BACKEND_ASYNC_FORBIDDEN')
    expect(codesFor('const f = async () => {}\n')).toContain('FH2_BACKEND_ASYNC_FORBIDDEN')
    expect(codesFor('const x = await g()\n')).toContain('FH2_BACKEND_ASYNC_FORBIDDEN')
    // 合法源码不触发任何诊断。
    expect(codesFor('import { helper } from \'./helper.js\'\nexport function h_run() { return helper() }\n')).toEqual([])
    // 字符串字面量中的关键字不误报（notes 声明的剥离行为）。
    expect(codesFor('const s = \'eval(1) setTimeout(2)\'\n')).toEqual([])
  })

  it('import type 裸包放行（allowedExceptions 的行为验证）', () => {
    // import type 的类型导入不触发裸包诊断（负向前瞻排除）。
    expect(codesFor('import type { X } from \'lodash\'\n')).toEqual([])
    // 运行时 import 的裸包照旧禁止。
    expect(codesFor('import { X } from \'lodash\'\n')).toContain('FH2_BACKEND_BARE_IMPORT_FORBIDDEN')
    const exception = restrictionDescriptor(SOURCE_RESTRICTIONS_CONTRACT, 'import-type-exception')
    expect(exception.forbidden).toEqual([])
    expect(exception.allowedExceptions?.length).toBeGreaterThan(0)
  })

  it('backend-imports 引用 forbiddenNodeModules(SOURCE_BUILD_RULES) 且不复制清单', () => {
    const imports = restrictionDescriptor(SOURCE_RESTRICTIONS_CONTRACT, 'backend-imports')
    expect(imports.forbidden.some(item => item.includes('forbiddenNodeModules(SOURCE_BUILD_RULES)'))).toBe(true)
    // 访问器关键成员抽查（对照 source-build-rules.ts 写死）：
    const modules = forbiddenNodeModules(SOURCE_BUILD_RULES)
    for (const member of ['fs', 'path', 'crypto', 'http', 'timers', 'zlib']) {
      expect(modules, `Node 禁入清单应含 ${member}`).toContain(member)
    }
    // node:* 是哨兵值，不进入访问器结果。
    expect(modules.includes('node:*')).toBe(false)
  })

  it('backend-timers 的 reason/alternatives 来自诊断 message 原文', () => {
    const timers = restrictionDescriptor(SOURCE_RESTRICTIONS_CONTRACT, 'backend-timers')
    expect(timers.reason).toContain('Goja 沙箱没有 Event Loop')
    expect(timers.alternatives).toEqual(['flow.start', 'Workflow Timer'])
    const async = restrictionDescriptor(SOURCE_RESTRICTIONS_CONTRACT, 'backend-async')
    expect(async.reason).toContain('Goja 沙箱按同步语义执行')
  })

  it('frontend-entry-purity 逐码列出四个诊断码', () => {
    const purity = restrictionDescriptor(SOURCE_RESTRICTIONS_CONTRACT, 'frontend-entry-purity')
    expect(purity.diagnosticCodes).toEqual([
      'FH2_PLUGIN_VUE_FORBIDDEN',
      'FH2_PLUGIN_VIEW_IMPORT_FORBIDDEN',
      'FH2_PLUGIN_ASSET_FORBIDDEN',
      'FH2_PLUGIN_CSS_FORBIDDEN',
    ])
  })

  it('hasModuleSyntax 与 backend-evaluator-esm / 动态 import 判定一致（探针）', () => {
    expect(hasModuleSyntax('import x from \'./y\'\n')).toBe(true)
    expect(hasModuleSyntax('export const a = 1\n')).toBe(true)
    expect(hasModuleSyntax('const p = import(\'./y\')\n')).toBe(true)
    expect(hasModuleSyntax('const a = 1\n')).toBe(false)
  })

  it('序列化双跑字节一致且契约对象冻结', () => {
    expect(serializeSourceRestrictionsContract()).toBe(serializeSourceRestrictionsContract())
    expect(Object.isFrozen(SOURCE_RESTRICTIONS_CONTRACT)).toBe(true)
    expect(Object.isFrozen(SOURCE_RESTRICTIONS_CONTRACT.restrictions)).toBe(true)
    for (const restriction of SOURCE_RESTRICTIONS_CONTRACT.restrictions) {
      expect(Object.isFrozen(restriction)).toBe(true)
      expect(Object.isFrozen(restriction.forbidden)).toBe(true)
      expect(Object.isFrozen(restriction.diagnosticCodes)).toBe(true)
    }
  })
})
