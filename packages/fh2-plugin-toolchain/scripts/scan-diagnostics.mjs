#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 扫描 Toolchain src 内的 FH2_* 诊断码字符串字面量。
 *
 * 用法（直接执行，输出规范化 JSON）：
 *   node scripts/scan-diagnostics.mjs [packageRoot]
 *
 * 规则：
 * - 只扫描 src 目录下全部 .ts 文件；
 * - 排除 *.test.ts、文件名以 template 开头的文件、template-variants 目录与
 *   tooling-contract 目录（B2b 起 tooling-contract 下的契约模块只"引用"既有诊断码
 *   作为机器事实，不抛出诊断；被引用的码仍以其抛出模块的字面量被扫描登记，
 *   排除该目录不减少扫描到的码集合，但保持 fail closed：新抛出模块仍必须登记）；
 * - 只匹配单引号字符串字面量 'FH2_[A-Z0-9_]+'（模板字符串内嵌的提示文本不算）；
 * - 纯函数：只读文件系统，不写、不依赖 dist、不在 import 时执行任何逻辑。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const DIAGNOSTIC_CODE_PATTERN = /'FH2_[A-Z0-9_]+'/g
const EXCLUDED_DIRECTORY_NAMES = new Set(['template-variants', 'tooling-contract'])

/**
 * 扫描 packageRoot/src 下的诊断码字面量。
 *
 * @returns 去重后按 code 排序的列表；files 为该码出现的源文件（相对 src/，排序去重），
 *          与诊断注册表的模块键（相对 src/）同格式。
 */
export function scanDiagnosticCodes (packageRoot) {
  const root = resolve(packageRoot)
  const files = collectSourceFiles(join(root, 'src'))
    .map(file => relative(join(root, 'src'), file))
    .sort()
  const codesByFile = new Map()
  for (const file of files) {
    const source = readFileSync(join(root, 'src', file), 'utf8')
    for (const match of source.matchAll(DIAGNOSTIC_CODE_PATTERN)) {
      const code = match[0].slice(1, -1)
      if (!codesByFile.has(code)) codesByFile.set(code, new Set())
      codesByFile.get(code).add(file)
    }
  }
  return [...codesByFile.entries()]
    .map(([code, files2]) => ({ code, files: [...files2].sort() }))
    .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0))
}

function collectSourceFiles (directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue
      collectSourceFiles(join(directory, entry.name), out)
      continue
    }
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.test.ts')) continue
    if (entry.name.startsWith('template')) continue
    out.push(join(directory, entry.name))
  }
  return out
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageRoot = process.argv[2] ?? resolve(import.meta.dirname, '..')
  process.stdout.write(`${JSON.stringify(scanDiagnosticCodes(packageRoot), null, 2)}\n`)
}
