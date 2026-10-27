// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { expect, it, vi } from 'vitest'
import { WorkspaceGitIgnore } from './gitignore.js'

vi.mock('node:fs/promises', () => ({ lstat: vi.fn(async () => ({ isFile: () => true })), readFile: vi.fn(async () => {
  throw new Error('permission denied')
}) }))

it('规则读取失败仅提示具体路径，单次请求不重复读取，不妨碍浏览文件', async () => {
  const rules = new WorkspaceGitIgnore('/test')
  expect(await rules.ignores('file.log', false)).toBe(false)
  expect(await rules.ignores('other.log', false)).toBe(false)
  expect(rules.warnings).toHaveLength(1)
  expect(rules.warnings[0]).toContain('.gitignore')
  expect(rules.warnings[0]).toContain('permission denied')
})
