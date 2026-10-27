// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DIAGNOSTIC_EXCEPTIONS,
  DIAGNOSTIC_FAMILY_BY_MODULE,
  DIAGNOSTIC_SUPPLEMENTARY,
  type DiagnosticModuleRuleTable,
  classifyDiagnostic,
  matchDiagnosticModuleRule,
  scanDiagnosticSources,
  serializeDiagnosticRegistry,
} from './diagnostics.js'

const packageRoot = resolve(import.meta.dirname, '../..')
const scanned = scanDiagnosticSources(resolve(packageRoot, 'src')).map(({ code, occurrences }) => ({ code, files: [...new Set(occurrences.map(item => item.module))] }))
const scannedCodes = new Set(scanned.map(item => item.code))

describe('diagnostics registry guard', () => {
  it('扫描出的每个诊断码在所有出现文件中都能分类（不抛）', () => {
    // 守卫下限：注册表覆盖的码量级（防止扫描器退化为空结果仍绿）。
    expect(scanned.length).toBeGreaterThan(150)
    for (const { code, files } of scanned) {
      for (const file of files) {
        expect(() => classifyDiagnostic(code, file), `无法分类 ${code} @ ${file}`).not.toThrow()
      }
    }
  })

  it('exceptions 里的每个码都真实出现在扫描结果中', () => {
    for (const code of Object.keys(DIAGNOSTIC_EXCEPTIONS)) {
      expect(scannedCodes.has(code), `exception 码已不在源码中：${code}`).toBe(true)
    }
  })

  it('supplementary 只登记扫描盲区码（与扫描结果互斥）', () => {
    for (const code of Object.keys(DIAGNOSTIC_SUPPLEMENTARY)) {
      expect(scannedCodes.has(code), `supplementary 码已出现为字面量，应迁移到 exceptions：${code}`).toBe(false)
      // 盲区码也必须可分类（module 标记为 supplementary）。
      expect(classifyDiagnostic(code, 'any/module.ts').module).toBe('supplementary')
    }
    expect(Object.keys(DIAGNOSTIC_SUPPLEMENTARY)).toEqual([])
  })

  it('模块键支持目录前缀且精确文件路径优先', () => {
    const table: DiagnosticModuleRuleTable = {
      'a/': { family: 'build', commands: ['build'], phase: 'compile', classification: 'validation' },
      'a/b/': { family: 'pack', commands: ['pack'], phase: 'pack', classification: 'validation' },
      'a/b/c.ts': { family: 'manifest', commands: ['validate'], phase: 'schema', classification: 'validation' },
    }
    expect(matchDiagnosticModuleRule(table, 'a/b/c.ts')?.family).toBe('manifest')
    expect(matchDiagnosticModuleRule(table, 'a/b/d.ts')?.family).toBe('pack')
    expect(matchDiagnosticModuleRule(table, 'a/e.ts')?.family).toBe('build')
    expect(matchDiagnosticModuleRule(table, 'src/a/e.ts')?.family).toBe('build')
    expect(matchDiagnosticModuleRule(table, 'x/y.ts')).toBeUndefined()
  })

  it('exception 命中优先于模块匹配', () => {
    const record = classifyDiagnostic('FH2_SCHEMA_SQL_INVALID', 'backend/build.ts')
    expect(record.family).toBe('manifest')
    expect(record.module).toBe('exception')
    // 非例外码按模块归类。
    const moduleRecord = classifyDiagnostic('FH2_DIST_MANIFEST_READ_FAILED', 'build/verify.ts')
    expect(moduleRecord.family).toBe('dist-verify')
    expect(moduleRecord.module).toBe('build/verify.ts')
  })

  it('注册表序列化双跑字节一致且对象冻结', () => {
    expect(serializeDiagnosticRegistry()).toBe(serializeDiagnosticRegistry())
    expect(Object.isFrozen(DIAGNOSTIC_FAMILY_BY_MODULE)).toBe(true)
    expect(Object.isFrozen(DIAGNOSTIC_EXCEPTIONS)).toBe(true)
  })
})
