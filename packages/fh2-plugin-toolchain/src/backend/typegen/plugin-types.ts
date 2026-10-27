// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { BACKEND_FORM_ROOTS as FORM_ROOTS } from '../../developer-runtime/types.js'
import type { DeveloperRuntimeBackend } from '../../developer-runtime/types.js'
import { loadBackendContractFacts } from '../contract-data.js'

/**
 * 后端注入面声明生成器：从 Host Contract、插件 allowlist 与源码 import 图产出 types/ 下的 ambient 声明。
 *
 * 世界的定义(spec §4.2):一个源文件可用的全局 = 会加载它的沙箱的注入面交集。
 *   handlers/**   只进 handler 沙箱(httpHandler)
 *   events/**     只进 event 沙箱(eventHandler,当前与 handler 同面)
 *   adapters/**   只进 adapter 沙箱(workflowAdapter)
 *   shared/**     按被哪些入口 import 计算可达根,取交集
 *
 * 产物(types/ 下,全部"生成勿手改"):
 *   shared-all.d.ts 三根交集的全局(HandlerCtx 也按世界给)
 *   call.d.ts       handler∩event 两根的世界(合并:两面当前同形)
 *   adapter.d.ts    adapter 独有的全局
 * 外层组装由 index.d.ts 的三份入口文件承担(handler/event/adapter 各一份,引用上面三份)。
 *
 * 手法:顶层无 import/export 语句,SDK 类型一律 import('…') 内联 → 保持 ambient,
 * declare const 进全局。
 */

/** 插件清单的最小读取面(只取 typegen 需要的字段)。 */
export interface PluginManifestInput {
  readonly allowlist?: readonly string[];
  readonly scripts?: ReadonlyArray<{
    readonly name?: string;
    readonly path?: string;
    readonly entry?: string;
    readonly io?: unknown;
  }>;
}

export interface PluginTypesResult {
  /** 文件名 → 源码(相对 types/ 目录)。 */
  readonly files: ReadonlyMap<string, string>;
  /** 世界表:源文件(相对插件根)→ 可用全局(交集后);给 check 命令复用。 */
  readonly worlds: ReadonlyMap<string, readonly string[]>;
  readonly warnings: readonly string[];
}

const SDK_IMPORT = (name: string): string => `import('fh2-plugin-sdk/backend').${name}`

/** 全局名 → SDK 接口名。ambient 只声明全局存在与否;方法面就是 SDK 接口面。 */
const GLOBAL_INTERFACE: Readonly<Record<string, string>> = {
  store: 'StoreApi',
  cache: 'CacheApi',
  media: 'MediaApi',
  flow: 'FlowApi',
  notify: 'NotifyApi',
  wayline: 'WaylineApi',
  screenshot: 'ScreenshotApi',
  objectTrack: 'ObjectTrackApi',
  video: 'VideoApi',
  log: 'LogApi',
  platform: 'PlatformApi',
  connector: 'ConnectorApi',
}

export function generatePluginTypes (pluginRoot: string): PluginTypesResult {
  const { hostApi: surface, contractDigest } = loadBackendContractFacts()
  const manifest = readManifest(pluginRoot)
  const allowlist = new Set(manifest.allowlist ?? [])
  const warnings: string[] = []

  // ── 形态注入面 ∩ allowlist:每个形态可用的 全局 → 方法集 ────────────────────
  const formGlobals = new Map<string, string[]>()
  for (const form of new Set(FORM_ROOTS.map(r => r.form))) {
    const globals = formInjection(surface, form, allowlist)
    formGlobals.set(form, globals)
  }
  for (const global of new Set([...formGlobals.values()].flat().sort())) {
    if (!Object.hasOwn(GLOBAL_INTERFACE, global)) warnings.push(`全局 ${global} 缺少 SDK 类型映射，已生成 unknown 声明，请更新 typegen。`)
  }
  // handler 与 event 同面时合并声明(将来分岔再拆,见 spec)。
  const callKey = JSON.stringify([...formGlobals.get('httpHandler')!].sort())
  const eventKey = JSON.stringify([...formGlobals.get('eventHandler')!].sort())
  const callEqualsEvent = callKey === eventKey

  // ── import 可达图:每个源文件能从哪些入口根到达 ──────────────────────────────
  const sources = collectSourceFiles(pluginRoot)
  const reachable = new Map<string, Set<string>>() // 文件 → 形态集合
  for (const root of FORM_ROOTS) {
    if (!existsSync(join(pluginRoot, root.dir))) continue
    for (const entry of filesUnder(join(pluginRoot, root.dir), pluginRoot)) {
      markReachable(entry, root.form, reachable, sources)
    }
  }

  // ── 世界计算:全局 = 可达形态的注入面交集(再 ∩ allowlist)─────────────────────
  const worlds = new Map<string, string[]>()
  for (const file of sources.keys()) {
    const forms = reachable.get(file)
    if (forms === undefined || forms.size === 0) {
      // 不可达文件(没被任何入口 import):给空面 —— 它不会进任何 bundle。
      worlds.set(file, [])
      continue
    }
    let intersection: string[] | undefined
    for (const form of forms) {
      const globals = formGlobals.get(form)!
      intersection = intersection === undefined ? [...globals] : intersection.filter(g => globals.includes(g))
    }
    worlds.set(file, intersection ?? [])
  }
  // shared 文件被三根可达但事件面与 handler 同:交集已按面算,无需特判。

  // ── 世界分组 → 声明文件 ────────────────────────────────────────────────────
  // 文件与其世界的映射聚成"声明集":相同世界符号表的文件共用一份 d.ts。
  const declSets = new Map<string, { readonly globals: readonly string[]; readonly files: readonly string[] }>()

  const bucketOf = (forms: ReadonlySet<string>): string => {
    if (forms.size === 3) return 'shared-all'
    if (forms.size === 2) return 'shared-call' // handler+event
    const single = [...forms][0]!
    return single === 'workflowAdapter' ? 'shared-adapter' : 'shared-call'
  }
  const worldOfForm = (form: string): string =>
    form === 'workflowAdapter' ? 'adapter' : 'call'

  // 入口文件按自己的形态拿世界;shared 按交集。ctx 也随世界。
  for (const [file, forms] of reachable) {
    const isEntry = FORM_ROOTS.some(r => file.startsWith(`${r.dir}/`))
    const bucket = isEntry ? worldOfForm([...forms][0]!) : bucketOf(forms)
    const globals = isEntry ? formGlobals.get([...forms][0]!)! : worlds.get(file)!
    const key = bucket
    const existing = declSets.get(key)
    declSets.set(key, {
      globals,
      files: [...(existing?.files ?? []), file],
    })
  }

  const files = new Map<string, string>()
  // 来源锁:契约包 contractDigest(升级契约后未重生成的 types/ 在 --check 下过期)。
  const header = `// 本文件由 fh2-plugin types 生成,勿手改。\n// 世界规则:文件可用的全局 = 会加载它的沙箱注入面交集(∩ 本插件 allowlist)。\n// 来源契约: ${surface.contractsVersion} / ${contractDigest}\n\n`

  for (const [bucket, decl] of declSets) {
    if (decl.globals.length === 0) continue
    const source = renderAmbientDecls(decl.globals, bucket)
    files.set(`${bucket}.d.ts`, header + source)
  }

  // 入口声明文件:handler / event / adapter 各一份,引用世界文件 + ctx + entries。
  const handlerGlobals = formGlobals.get('httpHandler')!
  const adapterGlobals = formGlobals.get('workflowAdapter')!
  if (handlerGlobals.length > 0) {
    files.set('handler.d.ts', header + renderEntryDecls(handlerGlobals, 'HandlerCtx'))
  }
  if (callEqualsEvent && handlerGlobals.length > 0) {
    files.set('event.d.ts', header + renderEntryDecls(formGlobals.get('eventHandler')!, 'EventCtx'))
  } else if (formGlobals.get('eventHandler')!.length > 0) {
    files.set('event.d.ts', header + renderEntryDecls(formGlobals.get('eventHandler')!, 'EventCtx'))
  }
  if (adapterGlobals.length > 0) {
    files.set('adapter.d.ts', header + renderEntryDecls(adapterGlobals, 'AdapterCtx'))
  }

  return { files, worlds, warnings }
}

// ── 形态注入面计算 ─────────────────────────────────────────────────────────────

/** 形态注入面 ∩ 插件 allowlist(方法粒度:由 capabilityGating 累加,基线仅不受门控的全局)。 */
function formInjection (surface: DeveloperRuntimeBackend, form: string, allowlist: Set<string>): string[] {
  // 受能力门控的全局集(跨全部能力,不问申报):用来识别"基线"——
  // 形态面里不属于任何能力贡献的全局(如 log)才是无条件注入的。
  const gatedGlobals = new Set<string>()
  for (const decl of Object.values(surface.capabilityGating)) {
    if (!decl.forms.includes(form)) continue
    for (const g of Object.keys(decl.globals)) gatedGlobals.add(g)
  }

  const globals = new Map<string, Set<string>>()
  // 基线:形态面里不受门控的全局(方法集照抄)。
  for (const [g, methods] of Object.entries(surface.forms[form]!.globals)) {
    if (gatedGlobals.has(g)) continue
    if (!globals.has(g)) globals.set(g, new Set())
    for (const m of methods) globals.get(g)!.add(m)
  }
  // 能力贡献:申报了、且该能力在该形态产生注入,才并入(全局与方法都按该能力贡献)。
  for (const [cap, decl] of Object.entries(surface.capabilityGating)) {
    if (!allowlist.has(cap)) continue
    if (!decl.forms.includes(form)) continue
    for (const [g, methods] of Object.entries(decl.globals)) {
      if (!globals.has(g)) globals.set(g, new Set())
      for (const m of methods) globals.get(g)!.add(m)
    }
  }
  return [...globals.keys()].filter(g => (globals.get(g)?.size ?? 0) > 0).sort()
}

// ── ambient 渲染 ──────────────────────────────────────────────────────────────

function renderAmbientDecls (globals: readonly string[], bucket: string): string {
  const lines: string[] = [`// 世界 ${bucket}:可用全局 ${globals.join(', ')}\n`]
  for (const global of globals) {
    lines.push(declareGlobal(global))
  }
  return lines.join('\n')
}

function renderEntryDecls (globals: readonly string[], ctxType: string): string {
  const lines: string[] = []
  for (const global of globals) {
    lines.push(declareGlobal(global))
  }
  lines.push(`declare const ctx: ${SDK_IMPORT(ctxType)}\n`)
  return lines.join('\n')
}

function declareGlobal (global: string): string {
  const interfaceName = Object.hasOwn(GLOBAL_INTERFACE, global) ? GLOBAL_INTERFACE[global] : undefined
  if (interfaceName === undefined) {
    return `declare const ${global}: unknown // 契约里没有该全局的模板映射(typegen 需补)\n`
  }
  return `declare const ${global}: ${SDK_IMPORT(interfaceName)}\n`
}

// ── 源码收集与 import 图 ───────────────────────────────────────────────────────

function collectSourceFiles (pluginRoot: string): Map<string, string> {
  const sources = new Map<string, string>()
  for (const dir of ['handlers', 'events', 'adapters', 'shared']) {
    const abs = join(pluginRoot, dir)
    if (!existsSync(abs)) continue
    for (const file of filesUnder(abs, pluginRoot)) {
      sources.set(file, readFileSync(join(pluginRoot, file), 'utf8'))
    }
  }
  return sources
}

/** 递归列出目录下 .ts/.js(相对根,POSIX 分隔)。 */
function filesUnder (absDir: string, pluginRoot: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(abs)
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) && !entry.name.endsWith('.d.ts')) {
        out.push(relative(pluginRoot, abs).split('\\').join('/'))
      }
    }
  }
  visit(absDir)
  return out.sort()
}

/** 从 file 出发把 form 沿相对 import 传播(可达根闭包)。 */
function markReachable (file: string, form: string, reachable: Map<string, Set<string>>, sources: Map<string, string>): void {
  const visit = (current: string): void => {
    let forms = reachable.get(current)
    if (forms === undefined) {
      forms = new Set<string>()
      reachable.set(current, forms)
    }
    if (forms.has(form)) return // 已传播过这条形态
    forms.add(form)
    const source = sources.get(current)
    if (source === undefined) return
    for (const dep of resolveImports(current, source)) {
      if (sources.has(dep)) visit(dep)
    }
  }
  visit(file)
}

/** 解析一个源文件里的静态相对 import(规范化为根相对路径,含扩展名推断)。 */
function resolveImports (file: string, source: string): string[] {
  const deps: string[] = []
  const patterns = [
    /\bimport\s+(?:type\s+)?[^'"]*?from\s+['"](\.[^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^'"]*?from\s+['"](\.[^'"]+)['"]/g,
    /\bimport\s+['"](\.[^'"]+)['"]/g,
  ]
  const seen = new Set<string>()
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1]!
      for (const resolved of resolveSpecifier(file, spec)) {
        if (!seen.has(resolved)) {
          seen.add(resolved)
          deps.push(resolved)
        }
      }
    }
  }
  return deps
}

/** './x' → ['shared/x.ts', 'shared/x.js', 'shared/x/index.ts', …] 里真实存在的。 */
function resolveSpecifier (fromFile: string, spec: string): string[] {
  const base = join('.', fromFile, '..', spec).split('\\').join('/')
  const baseNoExt = base.replace(/\.(ts|js)$/, '')
  const candidates = [
    `${baseNoExt}.ts`,
    `${baseNoExt}.js`,
    `${baseNoExt}.d.ts`,
    `${baseNoExt}/index.ts`,
    `${baseNoExt}/index.js`,
  ]
  // 存在性检查在这里做不了(没有 pluginRoot);由调用方 sources.has 过滤。
  return candidates
}

// ── 清单读取 ──────────────────────────────────────────────────────────────────

function readManifest (pluginRoot: string): PluginManifestInput {
  const raw = readFileSync(join(pluginRoot, 'fh2-plugin.json'), 'utf8')
  return JSON.parse(raw) as PluginManifestInput
}

/** 供 check 复用:列出插件全部源文件及其世界。 */
export function pluginWorlds (pluginRoot: string): ReadonlyMap<string, readonly string[]> {
  return generatePluginTypes(pluginRoot).worlds
}
