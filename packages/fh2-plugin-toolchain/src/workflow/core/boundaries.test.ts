// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

/**
 * `workflow/core` 的依赖边界（计划 §2.4）。
 *
 * 允许三类：
 *   ① 同目录的 `./x.js` —— core 的内部模块
 *   ② `../../contracts/*.js` 的**纯类型**导入 —— 计划 §2.2 的依赖方向图里
 *      `src/contracts` 就在 `workflow/core` 之上，且 contracts 自带 browser-safe 门禁
 *      （见 contracts/browser-safe.test.ts：禁 node: 与 require）。
 *   ③ `jsonc-parser` —— 计划 §D1 把 `json-edits.ts` 放在 core 里，而它就是这个库的封装。
 *      它是纯解析器（VS Code 在浏览器里也用它），无 Node 依赖、无 DOM 依赖。
 *
 * ★★ 第 ② 类**必须是 `import type`**。这一条不是洁癖：值导入会在打包产物里
 * 真的拉进那个模块，于是「core 是纯浏览器安全层」这件事就依赖 contracts 永远不长出
 * 运行时代码 —— 那是一条没人守的假设。`import type` 编译后整条消失，约束才是结构性的。
 *
 * ⚠️ 第 ③ 类是**白名单单点例外**，不是「允许第三方库」。再要加一个库必须写在这里，
 * 并说明它为什么是浏览器安全的 —— 这道门禁的价值全在「加一个依赖要过一次评审」。
 *
 * ⚠️ 仍然禁止：Vue / Pinia / Monaco / DOM / node: / serve / services / ide。
 * 它们一条都不在白名单里，写进来这条用例当场红。
 *
 * ⓘ 取 specifier 用 `from\s+['"]`（**至少一个空格**）。写成 `\s*` 会把
 * `mode: 'from' | 'const'` 这种普通代码当成 import —— 它会把 ` | ` 报成越界依赖。
 */
const CONTRACTS_SPECIFIER = /^\.\.\/\.\.\/contracts\/[^/]+\.js$/
/** 允许值导入的第三方库白名单（见头注释第 ③ 条）。 */
const ALLOWED_PACKAGES: ReadonlySet<string> = new Set(['jsonc-parser'])

function escapeForRegExp (value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

it('workflow Core 只依赖本层纯模块与 contracts 纯类型，不反向依赖 IDE、服务或 Node', () => {
  for (const file of readdirSync(import.meta.dirname).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
    const source = readFileSync(join(import.meta.dirname, file), 'utf8')

    const specifiers = new Set<string>()
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) specifiers.add(match[1]!)
    // 动态 import 单独收：它绕过下面的 type-only 判据（运行期才解析）。
    for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) {
      expect(match[1], `${file} 用了动态 import，它绕过 type-only 约束`).toMatch(/^\.\/[^/]+\.js$/)
    }

    for (const specifier of specifiers) {
      if (/^\.\/[^/]+\.js$/.test(specifier)) continue
      if (ALLOWED_PACKAGES.has(specifier)) continue
      expect(CONTRACTS_SPECIFIER.test(specifier), `${file} 的依赖越界：${specifier}`).toBe(true)

      // contracts 只许 type-only。判据是「存在 type 形式」且「不存在值形式」：
      // 同一个模块被两种形式各导一次时，值形式那条才是真的会进产物的。
      const escaped = escapeForRegExp(specifier)
      const valueImport = new RegExp(`(?:^|\\n)\\s*(?:import|export)\\s+(?!type\\b)[^;]*?from\\s+['"]${escaped}['"]`)
      expect(
        valueImport.test(source),
        `${file} 从 ${specifier} 做了值导入（必须 import type，否则 core 不再是纯类型层）`,
      ).toBe(false)
    }
  }
})
