// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { BACKEND_SOURCE_DIRECTORIES } from '../project-policy.js'
import { HANDLER_NAME_PATTERNS } from './policy.js'

/**
 * 后端 Handler 的公开名称约定。
 *
 * Bundle 只能暴露合法的 JavaScript 标识符，因此 Worker 继续以 h_ 名作为真实入口；
 * HTTP 可读名称在 Worker 装载期作为别名指向该入口。
 */

/**
 * 为不带 h_ 的源码 export 生成 Bundle 中的稳定入口名。
 *
 * handlers/lane-change/start-mode.js + startMode
 *   -> h_laneChange_startMode
 */
export function wrapperNameForHandlerExport (sourcePath: string, exportName: string): string | undefined {
  if (exportName.startsWith('h_')) return exportName
  if (!HANDLER_NAME_PATTERNS.exportName.test(exportName)) return undefined

  const parts = sourcePath.split('/')
  if (parts[0] !== BACKEND_SOURCE_DIRECTORIES.handlers || parts.length !== 3) return undefined

  const domain = toLowerCamelDirectory(parts[1]!)
  if (domain === undefined) return undefined

  return `h_${domain}_${exportName}`
}

/**
 * 从真实 h_ 入口派生兼容 HTTP 名称。
 *
 * 不能从任意 h_ 名瞎猜：只有 h_<lowerCamel domain>_<lowerCamel action>
 * 这个由 Toolchain 生成的受限形状才拥有别名。其他历史 h_ 入口照旧可调，
 * 但不额外暴露猜测出来的名称。
 */
export function aliasesForHandlerEntry (entry: string): readonly string[] {
  const match = HANDLER_NAME_PATTERNS.alias.exec(entry)
  if (match === null) return []

  const [, domain, action] = match
  return Object.freeze([
    `${domain}_${action}`,
    `${lowerCamelToKebab(domain!)}.${lowerCamelToKebab(action!)}`,
  ])
}

function toLowerCamelDirectory (value: string): string | undefined {
  if (!HANDLER_NAME_PATTERNS.domain.test(value)) return undefined
  return value.replace(/-([a-z0-9])/g, (_, character: string) => character.toUpperCase())
}

function lowerCamelToKebab (value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}
