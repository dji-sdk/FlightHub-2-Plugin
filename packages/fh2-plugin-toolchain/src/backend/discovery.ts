// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  SOURCE_BUILD_RULES,
  type SourceBuildRules,
  isDiscoveryExcluded,
  sourceDirectoryOf,
} from '../source-build-rules.js'

export interface BackendHandlerFile {
  readonly path: string;
  readonly kind: 'source' | 'packed';
  readonly name?: string;
}

/** 复现 Worker 对 handlers/ 与打包后 scripts/ 的 Handler 发现范围（目录与排除规则来自结构化规则对象）。 */
export function discoverBackendHandlerFiles (pluginRoot: string, rules: SourceBuildRules = SOURCE_BUILD_RULES): readonly BackendHandlerFile[] {
  const root = resolve(pluginRoot)
  const source = discoverSourceHandlers(root, rules)
  const packed = discoverPackedScripts(root, rules)
  return [...source, ...packed].sort((left, right) => compareText(left.path, right.path))
}

function discoverSourceHandlers (root: string, rules: SourceBuildRules): readonly BackendHandlerFile[] {
  const handlersRoot = resolve(root, sourceDirectoryOf(rules, 'backend-handlers'))
  if (!existsSync(handlersRoot)) return []
  const paths: string[] = []
  const prefix = sourceDirectoryOf(rules, 'backend-handlers')
  collectJavaScriptFiles(handlersRoot, prefix, paths, rules, 'backend-handlers')
  return paths.map((path) => {
    const name = handlerName(path, prefix)
    if (name === undefined) throw new Error(`Handler 路径非法：${path}`)
    return Object.freeze({ path, kind: 'source' as const, name })
  })
}

function discoverPackedScripts (root: string, rules: SourceBuildRules): readonly BackendHandlerFile[] {
  const scriptsRoot = resolve(root, sourceDirectoryOf(rules, 'backend-packed-scripts'))
  if (!existsSync(scriptsRoot)) return []
  const paths: string[] = []
  const prefix = sourceDirectoryOf(rules, 'backend-packed-scripts')
  collectJavaScriptFiles(scriptsRoot, prefix, paths, rules, 'backend-packed-scripts')
  return paths.map(path => Object.freeze({ path, kind: 'packed' as const }))
}

function collectJavaScriptFiles (directory: string, prefix: string, paths: string[], rules: SourceBuildRules, ruleId: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue
    const relativePath = `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      collectJavaScriptFiles(join(directory, entry.name), relativePath, paths, rules, ruleId)
      continue
    }
    // 排除模式（**/*.d.ts）来自结构化规则对象；.ts 是 TS 源码(handler 名从路径派生,
    // 扩展名不参与);.d.ts 是类型声明,不是入口。
    if (isDiscoveryExcluded(rules, ruleId, relativePath)) continue
    if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.ts'))) paths.push(relativePath)
  }
}

function handlerName (path: string, prefix: string): string | undefined {
  const relativePath = path.replace(new RegExp(`^${prefix}/`), '').replace(/\.(js|ts)$/, '')
  const segments = relativePath.split('/')
  if (relativePath === '' || segments.some(segment => segment === '' || segment.startsWith('_') || segment.includes('.')))
    return undefined
  return segments.join('.')
}

function compareText (left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
