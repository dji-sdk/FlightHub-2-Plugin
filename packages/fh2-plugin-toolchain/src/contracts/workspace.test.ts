// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_CAPABILITIES,
  parseWorkspaceKind,
  supportsWorkspaceOperation,
} from './workspace.js'

describe('parseWorkspaceKind', () => {
  it('接受全部冻结 kind（含迁移后的 capability-project 与行业工作区）', () => {
    expect(parseWorkspaceKind('capability-project')).toBe('capability-project')
    expect(parseWorkspaceKind('industry-capability-workspace')).toBe('industry-capability-workspace')
    expect(parseWorkspaceKind('frontend-plugin')).toBe('frontend-plugin')
    expect(parseWorkspaceKind('backend-plugin')).toBe('backend-plugin')
  })

  it('未知值宽容落到 unknown（与 schemaVersion 的严格失败不同）', () => {
    expect(parseWorkspaceKind('capability')).toBe('unknown')
    expect(parseWorkspaceKind(42)).toBe('unknown')
    expect(parseWorkspaceKind(undefined)).toBe('unknown')
  })
})

describe('工作区能力矩阵（§3.2）', () => {
  it('行业工作区首版不支持 Dev/Preview', () => {
    const industry = WORKSPACE_CAPABILITIES['industry-capability-workspace']
    expect(industry).toEqual({
      inspect: true,
      validate: true,
      generate: true,
      build: true,
      pack: true,
      dev: false,
      preview: false,
    })
  })

  it('capability 工程与插件根支持全部操作（backend 不支持 Dev/Preview）', () => {
    expect(supportsWorkspaceOperation('capability-project', 'dev')).toBe(true)
    expect(supportsWorkspaceOperation('capability-project', 'preview')).toBe(true)
    expect(supportsWorkspaceOperation('frontend-plugin', 'dev')).toBe(true)
    expect(supportsWorkspaceOperation('backend-plugin', 'dev')).toBe(false)
    expect(supportsWorkspaceOperation('backend-plugin', 'preview')).toBe(false)
  })

  it('unknown 根只允许 Inspect', () => {
    expect(supportsWorkspaceOperation('unknown', 'inspect')).toBe(true)
    expect(supportsWorkspaceOperation('unknown', 'validate')).toBe(false)
    expect(supportsWorkspaceOperation('unknown', 'build')).toBe(false)
  })
})
