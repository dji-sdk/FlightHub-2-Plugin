// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/**
 * S5：`computeSourceRevision()` —— 文件一致性契约（实施计划 §3.3）。
 *
 * 按项目源码集合取相对 POSIX 路径，排除 `.git`、`node_modules`、`dist`、`release`、
 * `.fh2` 状态/缓存与构建候选/临时目录（`.dist.fh2-*`、`.build-report.*.tmp`），按路径排序后
 * 对「路径、字节长度、原始字节」做 SHA-256。
 *
 * - 项目自有 `.d.ts` 属于源码输入，不排除；
 * - 写 build-report / 构建缓存不改变 hash（排除项覆盖）；
 * - 与 Build Report 的 sourceDigest 共享「目录扫描 + 排序 + 逐文件摘要」发现思路；
 * - 起止 hash 只做变更检测，不证明构建读取了不可变快照。
 */
export function computeSourceRevision (rawRoot: string): string {
  const root = resolve(rawRoot)
  const files = collectSourceFiles(root, root)
  files.sort(compareText)
  const digest = createHash('sha256')
  for (const file of files) {
    const bytes = readFileSync(join(root, file))
    digest.update(file)
    digest.update('\0')
    digest.update(`${bytes.byteLength}`)
    digest.update('\0')
    digest.update(bytes)
    digest.update('\n')
  }
  return digest.digest('hex')
}

const IGNORED_EVERYWHERE = new Set(['.git', 'node_modules', 'dist', 'release', '.fh2'])
const IGNORED_PREFIXES = ['.dist.fh2-', '.build-report.']

function collectSourceFiles (root: string, directory: string, files: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (IGNORED_EVERYWHERE.has(entry.name)) continue
    if (IGNORED_PREFIXES.some(prefix => entry.name.startsWith(prefix))) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      collectSourceFiles(root, path, files)
      continue
    }
    if (!entry.isFile() || !statSync(path).isFile()) continue
    files.push(relative(root, path).split(sep).join('/'))
  }
  return files
}

function compareText (left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
