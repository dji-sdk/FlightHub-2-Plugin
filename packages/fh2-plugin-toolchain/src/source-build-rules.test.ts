// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverBackendHandlerFiles } from './backend/discovery.js'
import {
  SOURCE_BUILD_RULES,
  type SourceBuildRules,
  buildOutputDirectory,
  buildPathRewriteRulesDocument,
  forbiddenNodeModules,
  isDiscoveryExcluded,
  serializeSourceBuildRules,
  sourceDirectoryOf,
} from './source-build-rules.js'

function temporaryDirectory (): string {
  return mkdtempSync(path.join(os.tmpdir(), 'fh2-source-build-rules-'))
}

function replaceHandlerDirectory (directory: string): SourceBuildRules {
  return {
    ...SOURCE_BUILD_RULES,
    sourceDiscovery: SOURCE_BUILD_RULES.sourceDiscovery.map(rule =>
      rule.id === 'backend-handlers'
        ? { ...rule, include: [`${directory}/**`] }
        : rule,
    ),
  }
}

describe('source build rules', () => {
  it('规则对象提供现有 Toolchain 的缺省路径与模块限制', () => {
    expect(sourceDirectoryOf(SOURCE_BUILD_RULES, 'backend-handlers')).toBe('handlers')
    expect(sourceDirectoryOf(SOURCE_BUILD_RULES, 'frontend-views')).toBe('src/views')
    expect(buildOutputDirectory(SOURCE_BUILD_RULES, 'backend', 'backend-dist')).toBe('dist')
    expect(forbiddenNodeModules(SOURCE_BUILD_RULES)).toContain('fs')
    expect(isDiscoveryExcluded(SOURCE_BUILD_RULES, 'backend-handlers', 'handlers/types.d.ts')).toBe(true)
  })

  it('修改结构化规则 fixture 时，实际发现行为与导出 JSON 同时变化', () => {
    const root = temporaryDirectory()
    try {
      mkdirSync(path.join(root, 'handlers'), { recursive: true })
      mkdirSync(path.join(root, 'handlers-next'), { recursive: true })
      writeFileSync(path.join(root, 'handlers', 'legacy.ts'), 'export const legacy = true\n')
      writeFileSync(path.join(root, 'handlers-next', 'current.ts'), 'export const current = true\n')
      writeFileSync(path.join(root, 'handlers-next', 'types.d.ts'), 'export type T = string\n')

      const modified = replaceHandlerDirectory('handlers-next')
      const discovered = discoverBackendHandlerFiles(root, modified)

      expect(discovered).toEqual([{
        kind: 'source',
        name: 'current',
        path: 'handlers-next/current.ts',
      }])
      expect(serializeSourceBuildRules(modified)).toContain('handlers-next/**')
      expect(serializeSourceBuildRules(modified)).not.toBe(serializeSourceBuildRules(SOURCE_BUILD_RULES))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('规则序列化与路径映射派生稳定', () => {
    expect(serializeSourceBuildRules()).toBe(serializeSourceBuildRules())
    expect(buildPathRewriteRulesDocument().rewrites).toContainEqual({
      from: 'handlers',
      to: 'dist/scripts',
    })
  })
})
