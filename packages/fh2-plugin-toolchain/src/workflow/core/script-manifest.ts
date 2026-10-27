// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 后端清单（plugin.json）的 `scripts[]` 读写。
 *
 * ★ 为什么画布里「写 JS」必须落到真实文件 + 清单登记：
 * worker 装载脚本是按 `scripts[].path` 去找真实 `.js` 文件的（见 plugin.Load），
 * 流程 JSON 里 `inputs.script` 填的是 `scripts[].name`（寻址键）。
 * 只在画布里存一段游离的源码，发布期必然是「脚本未注册」——
 * 所以本模块做的是「建文件 + 登记清单」两件事，缺一不可。
 *
 * 与 workflow 文档同一条纪律：原地改 raw，保住键序与未知字段。
 */

import { parseJsonWithLayout, stringifyWithLayout } from './json-layout.js'
import type { JsonLayout } from './json-layout.js'

type JsonRecord = Record<string, unknown>

function isRecord (value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface ManifestDocument {
  readonly raw: JsonRecord;
  readonly layout: JsonLayout;
  /** 原文能否被无损复现；false 时写回会整体重排。 */
  readonly lossless: boolean;
  /** 这份清单在工作区里的路径（backend/plugin.json 或 plugin.json）。 */
  readonly path: string;
}

export type ManifestParseResult =
  | { readonly ok: true; readonly document: ManifestDocument }
  | { readonly ok: false; readonly message: string }

export function parseManifest (text: string, path: string): ManifestParseResult {
  let parsed: { readonly value: unknown; readonly layout: JsonLayout }
  try {
    parsed = parseJsonWithLayout(text)
  } catch (error) {
    return { ok: false, message: `plugin.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isRecord(parsed.value)) return { ok: false, message: 'plugin.json 顶层必须是对象。' }
  const document: ManifestDocument = { raw: parsed.value, layout: parsed.layout, lossless: false, path }
  return {
    ok: true,
    document: { ...document, lossless: serializeManifest(document) === text },
  }
}

export function serializeManifest (document: ManifestDocument): string {
  return stringifyWithLayout(document.raw, document.layout)
}

function scriptsOf (raw: JsonRecord): JsonRecord[] {
  return Array.isArray(raw.scripts) ? raw.scripts.filter(isRecord) : []
}

export function findScriptEntry (document: ManifestDocument, name: string): JsonRecord | undefined {
  return scriptsOf(document.raw).find(entry => entry.name === name)
}

export interface IoFieldDraft {
  readonly name: string;
  readonly type: string;
  readonly required?: boolean;
}

export interface ScriptDraft {
  readonly name: string;
  readonly path: string;
  readonly entry: string;
  readonly description?: string;
  readonly allowlist: readonly string[];
  readonly inputs: readonly IoFieldDraft[];
  readonly outputs: readonly IoFieldDraft[];
}

/**
 * 往清单里登记一份新脚本。
 *
 * 键序照手写清单的自然顺序（description → name → path → entry → allowlist → io），
 * 与 `examples/demo-plugin` 里那份保持一致。
 */
export function addScriptEntry (document: ManifestDocument, draft: ScriptDraft): boolean {
  if (draft.name.trim() === '' || draft.path.trim() === '') return false
  if (findScriptEntry(document, draft.name) !== undefined) return false
  if (!Array.isArray(document.raw.scripts)) document.raw.scripts = []
  const scripts = document.raw.scripts as JsonRecord[]

  const entry: JsonRecord = {}
  if (draft.description !== undefined && draft.description !== '') entry.description = draft.description
  entry.name = draft.name
  entry.path = draft.path
  entry.entry = draft.entry
  entry.allowlist = [...draft.allowlist]
  entry.io = {
    inputs: draft.inputs.map(toIoField),
    outputs: draft.outputs.map(toIoField),
  }
  scripts.push(entry)
  return true
}

function toIoField (field: IoFieldDraft): JsonRecord {
  const out: JsonRecord = { name: field.name, type: field.type }
  if (field.required === true) out.required = true
  return out
}

/** 改一份已登记脚本的 I/O 契约（画布里改完入参/出参要同步回清单）。 */
export function setScriptIo (
  document: ManifestDocument,
  name: string,
  io: { readonly inputs: readonly IoFieldDraft[]; readonly outputs: readonly IoFieldDraft[] },
): boolean {
  const entry = findScriptEntry(document, name)
  if (entry === undefined) return false
  const next = {
    inputs: io.inputs.map(toIoField),
    outputs: io.outputs.map(toIoField),
  }
  if (JSON.stringify(entry.io) === JSON.stringify(next)) return false
  entry.io = next
  return true
}

/** 改一份已登记脚本的 allowlist。 */
export function setScriptAllowlist (
  document: ManifestDocument,
  name: string,
  allowlist: readonly string[],
): boolean {
  const entry = findScriptEntry(document, name)
  if (entry === undefined) return false
  if (JSON.stringify(entry.allowlist) === JSON.stringify(allowlist)) return false
  entry.allowlist = [...allowlist]
  return true
}

/**
 * 新脚本的默认源码。
 *
 * ⚠️ 必须是 ES5.1：worker 侧跑 goja，没有 Promise / async / 箭头函数 / let-const 之外的现代语法
 * （模板串、解构在 goja 里可用，但这里保守到 ES5 更安全）。
 * 入口函数名与 `entry` 字段一致，两处对不上是「入口函数不存在」那条契约错。
 */
export function defaultScriptSource (entry: string): string {
  return `// 动态脚本（worker 侧跑 goja，ES5.1 —— 没有 Promise / async / Map）
//
// 入参 input：流程 JSON 里这一步 inputs 接线解出来的那几个键，
//            且只有清单 io.inputs 声明过的会递进来。
// 上下文 ctx：now / idempotencyKey / stableId(scope) 等平台事实。
// 返回值    ：必须是对象，且只有清单 io.outputs 声明过的键会进黑板。
function ${entry} (input, ctx) {
  return {
    ok: true,
  }
}
`
}

/**
 * 由脚本名派生一个默认文件路径。
 *
 * ⚠️ 要把 `.` 也收掉：`../escape` 若只换斜杠会剩下 `..-escape`，
 * 而带 `..` 的路径正是契约 §0 要拦的逃逸形状。服务端有 realpath 复核兜底，
 * 但客户端就不该生成这种路径 —— 它只会换来一个看不懂的 400。
 */
export function defaultScriptPath (name: string): string {
  const safe = name
    .trim()
    .replace(/[^\w-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `adapters/${safe === '' ? 'script' : safe}.js`
}
