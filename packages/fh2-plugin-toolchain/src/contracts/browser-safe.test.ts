// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * browser-safe 守护：src 内除 *.test.ts 外禁止 Node API 与依赖导入。
 * 本包依赖方向固定为被单向消费，出现 node: 导入即破坏 Web 侧可用性。
 */
describe('browser-safe', () => {
  const sourceDir = fileURLToPath(new URL('.', import.meta.url))
  const files = readdirSync(sourceDir).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))

  it('src 存在源文件', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('不导入 node: 内置模块', () => {
    for (const file of files) {
      const content = readFileSync(join(sourceDir, file), 'utf8')
      expect(content, `${file} 导入了 node: 模块`).not.toMatch(/from\s+['"]node:/)
      expect(content, `${file} 使用了 require`).not.toMatch(/require\(/)
    }
  })

  it('契约只引用本目录模块', () => {
    for (const file of files) {
      const content = readFileSync(join(sourceDir, file), 'utf8')
      const imports = [...content.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1])
      expect(imports.every(specifier => specifier?.startsWith('./'))).toBe(true)
    }
  })
})
