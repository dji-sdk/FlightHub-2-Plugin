// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 业务功能命令（计划 §D2 的后 6 条）：改 `plugin.json` 的 `scripts[]`，
 * 有的还要同时建/删 JS 文件、同时改 workflow。
 *
 * ★★ 这几条是**跨文件**命令，也是「前置失效时零修改」这条性质真正要紧的地方：
 * 写了脚本文件没登记进清单，那份 JS 谁也调不到；登记了清单但文件没建，装载期直接报错。
 * 两种中间态用户都只会看到「保存成功但画布报错」。
 *
 * ── 三个 id 不能混（方案 §3.1.1）────────────────────────────────
 *   功能 ID   `scripts[].name`  与源文件路径解耦，是 `inputs.script.const` 的取值
 *   实现入口  `path` + `entry`   一个文件可以放多个入口
 *   节点 ID   `steps[].id`       一次调用，同一功能可被调多次
 * 改任何一个都不该顺手改另一个 —— 本模块每条命令只动它名义上那一个。
 */

import type { ActionCatalog } from './catalog.js'
import { findScript } from './catalog.js'
import type { CommandImpact, PrepareResult, PreparedCommand, PreparedFileEdit } from './commands.js'
import type { JsonEditOp } from './json-edits.js'
import { canEditJson, parseJsonValue } from './json-edits.js'
import { collectReferences } from './references.js'

type JsonRecord = Record<string, unknown>

/** prepare 的上下文：清单必给；要同时改流程或建文件时把那几项一起给。 */
export interface ScriptCommandContext {
  readonly workspaceEpoch: number;
  readonly knowledgeId?: string;
  readonly manifest: {
    readonly path: string;
    readonly text: string;
    readonly generation: number;
  };
  /** 同时要改流程时给（CreateScriptAndBind / RenameScriptId）。 */
  readonly workflow?: {
    readonly path: string;
    readonly text: string;
    readonly generation: number;
  };
  readonly catalog: ActionCatalog;
  /**
   * 后端工程的语言档案（Runtime Profile 的 backend.sourceLanguage）。
   *
   * ★ 决定新建脚本的扩展名与源码形态：TypeScript 工程生成命名导出的
   * `.ts`（构建器经 esbuild 打包）；JavaScript 工程生成 goja 能直接跑的
   * ES5.1 `.js`。缺省按 JavaScript —— 老 IDE 未带该字段时不因此拒命令。
   */
  readonly scriptLanguage?: 'typescript' | 'javascript';
}

function reject (reason: string): PrepareResult {
  return { ok: false, reason }
}

function isRecord (value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scriptsOf (manifest: JsonRecord): JsonRecord[] {
  return Array.isArray(manifest.scripts) ? manifest.scripts.filter(isRecord) : []
}

function scriptIndexOf (manifest: JsonRecord, name: string): number {
  return scriptsOf(manifest).findIndex(script => script.name === name)
}

function readManifest (context: ScriptCommandContext): { raw: JsonRecord } | { error: string } {
  if (!canEditJson(context.manifest.text)) {
    return { error: `${context.manifest.path} 当前不是合法 JSON，请先修好语法错误。` }
  }
  const raw = parseJsonValue(context.manifest.text)
  if (!isRecord(raw)) return { error: `${context.manifest.path} 顶层不是对象。` }
  return { raw }
}

/**
 * 功能 ID 的合法字符集。
 * ⚠️ 不许有点：它会作为 `inputs.script.const` 的值，而引用路径按点分段 —— 虽然
 * const 不是引用路径，但同一个串出现在两种上下文里时，带点的名字会让人写错。
 */
const SCRIPT_NAME_PATTERN = /^[A-Za-z_][\w-]*$/

function checkScriptName (manifest: JsonRecord, name: string): string | null {
  if (!SCRIPT_NAME_PATTERN.test(name)) {
    return `功能 ID ${JSON.stringify(name)} 不合法：只能用字母/数字/下划线/连字符，且不能以数字开头。`
  }
  if (scriptIndexOf(manifest, name) >= 0) return `功能 ID ${name} 已存在。`
  return null
}

/** 清单里的 `path` 相对清单所在目录；文件接口要的是工作区相对路径。 */
function manifestDirOf (manifestPath: string): string {
  return manifestPath.includes('/') ? manifestPath.slice(0, manifestPath.lastIndexOf('/')) : ''
}

function toWorkspacePath (manifestPath: string, scriptPath: string): string {
  const directory = manifestDirOf(manifestPath)
  return directory === '' ? scriptPath : `${directory}/${scriptPath}`
}

function checkScriptPath (path: string, language: 'typescript' | 'javascript'): string | null {
  if (path === '' || path.startsWith('/') || path.includes('\\')) {
    return `脚本路径 ${JSON.stringify(path)} 必须是相对清单目录的 POSIX 相对路径。`
  }
  if (path.split('/').some(segment => segment === '..' || segment === '.' || segment === '')) {
    return `脚本路径 ${JSON.stringify(path)} 不能含 . / .. 或空段。`
  }
  const expected = language === 'typescript' ? '.ts' : '.js'
  if (!path.endsWith(expected)) {
    return language === 'typescript'
      ? `脚本路径必须以 .ts 结尾：当前后端是 TypeScript 工程，构建器经 esbuild 打包 adapters/**/*.ts。`
      : `脚本路径必须以 .js 结尾：当前后端是 JavaScript 工程，脚本按清单 path 原样装载（不经打包）。`
  }
  return null
}

/** 由脚本名派生默认文件路径（语言档案决定扩展名）。 */
export function defaultScriptPath (name: string, language: 'typescript' | 'javascript' = 'javascript'): string {
  const safe = name
    .trim()
    .replace(/[^\w-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `adapters/${safe === '' ? 'script' : safe}.${language === 'typescript' ? 'ts' : 'js'}`
}

// ── 新建脚本的源码模板（P0-1：与工程构建方式对齐） ────────────────────────

/** io 声明的类型名 → TypeScript 类型。词表外的类型名放行为 unknown。 */
const TS_TYPES: Readonly<Record<string, string>> = {
  string: 'string',
  id: 'string',
  timestamp: 'string',
  enum: 'string',
  number: 'number',
  bool: 'boolean',
  object: 'Record<string, unknown>',
  array: 'unknown[]',
}

function tsTypeOf (type: string): string {
  return TS_TYPES[type] ?? 'unknown'
}

/**
 * 一组 I/O 声明 → TypeScript 入参/返回类型。
 *
 * 嵌套 object 的成员摊成嵌套字面量类型、array 的 fields 摊成元素形状 ——
 * 与清单声明同构，写错键名编译期就红。声明为空 = 整块放行。
 */
function tsShapeOf (fields: readonly ScriptIoField[]): string {
  if (fields.length === 0) return 'Record<string, unknown>'
  const members = fields.map((field) => {
    const nested = field.fields ?? []
    const type = nested.length > 0
      ? field.type === 'array'
        ? `${tsShapeOf(nested).replace(/\[\]$/, '')}[]`
        : tsShapeOf(nested)
      : tsTypeOf(field.type)
    return `${JSON.stringify(field.name)}: ${type}`
  })
  return `{ ${members.join(', ')} }`
}

/**
 * 一份新建脚本的默认源码。
 *
 * ★★ 两形态共用一条纪律：**明确未实现**。模板不生成假的成功返回值 ——
 * `return {}` 会让「还没写逻辑」的这一步在画布上亮绿灯、在运行期静默空转；
 * 抛错把 TODO 顶到第一次调用，也顶到构建器的类型检查（TS 形态）。
 *
 * ⚠️ 不生成日志调用：当前知识包没有声明可靠的日志 API，模板里引用一个
 * 不存在的 `ctx.log` 是把运行期错误种进新代码（旧模板踩过）。
 * ⓘ TS 形态不引用 AdapterCtx —— 模板不依赖任何 SDK 类型，用到的字段
 *    类型由清单 io 声明摊出来；需要 ctx 的作者自己补 import。
 */
export function scriptTemplate (input: CreateScriptInput, language: 'typescript' | 'javascript'): string {
  const entry = input.entry === undefined || input.entry === '' ? 'handle' : input.entry
  const summary = input.description === undefined || input.description === ''
    ? input.name
    : `${input.name} —— ${input.description}`

  if (language === 'typescript') {
    return `/**
 * ${summary}
 *
 * 构建期经 esbuild 打包（可 import 共享模块）；运行时没有事件循环 ——
 * Promise / async / setTimeout 不会回调，Map / Set / ES2015 语法可用。
 *
 * 入参 input：只有清单 io.inputs 声明过的键会递进来（未声明 = 整块递进来）。
 * 返回值  ：声明了 io.outputs 时只有声明过的键会交给下游（未声明 = 整块交给下游）。
 */
export function ${entry} (input: ${tsShapeOf(input.inputs ?? [])}): ${tsShapeOf(input.outputs ?? [])} {
  throw new Error('TODO: implement business logic')
}
`
  }

  return `/**
 * ${summary}
 *
 * ⚠️ 后端是 JavaScript 工程：这份脚本按清单 path 原样装载（goja 运行时：
 * ES2015 语法可用 —— 箭头 / 模板串 / class / Map / Set 都行；但没有事件循环，
 * Promise / async / setTimeout 不会回调），不经打包。
 *
 * 入参 input：只有清单 io.inputs 声明过的键会递进来（未声明 = 整块递进来）。
 * 返回值  ：必须是对象；声明了 io.outputs 时只有声明过的键会交给下游（未声明 = 整块交给下游）。
 */
function ${entry} (input) {
  throw new Error('TODO: implement business logic')
}
`
}

/** 拼一条命令（可跨文件）。 */
function command (
  context: ScriptCommandContext,
  kind: string,
  label: string,
  edits: readonly PreparedFileEdit[],
  documents: readonly { readonly path: string; readonly generation: number }[],
  focus?: PreparedCommand['focus'],
): PreparedCommand {
  return {
    kind,
    label,
    edits,
    expected: {
      workspaceEpoch: context.workspaceEpoch,
      documents,
      ...(context.knowledgeId === undefined ? {} : { knowledgeId: context.knowledgeId }),
    },
    ...(focus === undefined ? {} : { focus }),
  }
}

function manifestDoc (context: ScriptCommandContext): { path: string; generation: number } {
  return { path: context.manifest.path, generation: context.manifest.generation }
}

// ── 8. CreateScriptFunction ───────────────────────────────────────────────

export interface ScriptIoField {
  readonly name: string;
  readonly type: string;
  /**
   * 只服务入参。
   *
   * ⚠️ 出参**不读**它：worker 侧「声明即必产」（见 script.Field.Required 的注释），
   * 少产一个声明过的出参是运行期契约错，不是「可选没给」。故写值时会把出参上的
   * required 剥掉 —— 留着它等于在清单里写一句平台不看的话。
   */
  readonly required?: boolean;
  /**
   * 嵌套成员：`object` 是本对象的成员，`array` 是每个元素的形状。不写 = 整个放行。
   *
   * ★★ 这一层**必须原样保留**。它是手写清单里最容易被工具抹掉的东西：
   * 画布只要用一个 `{name,type,required}` 的平铺模型读进来再写回去，
   * 别人写的嵌套声明就没了，而没了之后 `projectValue` 会把整块原样放行 ——
   * 声明还在、约束消失，看不出任何异常。
   */
  readonly fields?: readonly ScriptIoField[];
}

export interface CreateScriptInput {
  readonly name: string;
  readonly path: string;
  readonly entry?: string;
  readonly description?: string;
  readonly allowlist?: readonly string[];
  readonly inputs?: readonly ScriptIoField[];
  readonly outputs?: readonly ScriptIoField[];
}

function checkAllowlist (catalog: ActionCatalog, allowlist: readonly string[]): string | null {
  if (!catalog.available) return null
  const unknown = allowlist.filter(capability => !catalog.grantableCaps.includes(capability))
  if (unknown.length === 0) return null
  return `这些能力平台授不出：${unknown.join(' / ')}。`
    + '⚠️ 申报一个不存在的能力不会报错，它会让装载期拒掉整个插件包。'
}

// ── I/O 声明的写值与校验 ──────────────────────────────────────────────────

/** 平台内部约定的键，不许当业务 I/O（worker 的 `script.addressingKeys`）。 */
const RESERVED_IO_NAMES: readonly string[] = ['script', 'now', 'idempotencyKey']

/** 能带嵌套成员的类型：object 是成员，array 是元素形状。 */
const NESTABLE_TYPES: readonly string[] = ['object', 'array']

/**
 * 一条 I/O 声明 → 写进清单的对象。
 *
 * ⚠️ 键序固定 name → type → required → fields：清单是手写文件，
 * 每次写回都换一种键序会让 diff 变成噪声（最小编辑那条纪律在这里也算数）。
 */
function toIoField (field: ScriptIoField, isOutput: boolean): JsonRecord {
  const nested = (field.fields ?? []).map(child => toIoField(child, isOutput))
  return {
    name: field.name,
    type: field.type,
    // 出参的 required 在这里被剥掉 —— 调用方会拿到一条 advisory 说明原因，不静默丢。
    ...(!isOutput && field.required === true ? { required: true } : {}),
    ...(nested.length > 0 ? { fields: nested } : {}),
  }
}

function toIoSection (
  inputs: readonly ScriptIoField[],
  outputs: readonly ScriptIoField[],
): JsonRecord {
  return {
    inputs: inputs.map(field => toIoField(field, false)),
    outputs: outputs.map(field => toIoField(field, true)),
  }
}

/**
 * 递归校验一组 I/O 声明。
 *
 * 每一条都对应一种**不会报错的**失真，注释里写清是哪一种 ——
 * 这些东西写错了 worker 不拒，只是悄悄少做一件事。
 */
function checkIoFields (
  catalog: ActionCatalog,
  fields: readonly ScriptIoField[],
  isOutput: boolean,
  at: string,
): string | null {
  const names = fields.map(field => field.name)
  const where = at === '' ? (isOutput ? '出参' : '入参') : `${at} 的嵌套成员`
  if (names.some(name => name.trim() === '')) return `${where}里有空的字段名。`
  const duplicate = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicate !== undefined) return `${where}里有重名字段 ${duplicate}。`
  const reserved = names.filter(name => RESERVED_IO_NAMES.includes(name))
  if (reserved.length > 0) {
    return `${reserved.join(' / ')} 是平台保留键（脚本寻址键与解释器播的种子），不能当业务 I/O：`
      + '它们经 ctx 给脚本，在 input 里再出现一份会互相覆盖。'
  }

  for (const field of fields) {
    const path = at === '' ? field.name : `${at}.${field.name}`
    // 词表为空 = 这一刻没有可依的类型表，一律不判（见 ActionCatalog.ioFieldTypes ★★）。
    if (catalog.ioFieldTypes.length > 0 && !catalog.ioFieldTypes.includes(field.type)) {
      return `${path} 的类型 ${JSON.stringify(field.type)} 不在类型列表里（${catalog.ioFieldTypes.join(' / ')}）。`
        + '⚠️ 平台不会拦截未知类型名，写错不会报错 —— 只会让这个字段不再做类型检查。'
    }
    const nested = field.fields ?? []
    if (nested.length > 0) {
      if (!NESTABLE_TYPES.includes(field.type)) {
        return `${path} 是 ${field.type}，不能带嵌套成员（只有 ${NESTABLE_TYPES.join(' / ')} 能）。`
          + '⚠️ 平台对标量上的 fields 是静默忽略，留着它只会让人以为这里有约束。'
      }
      const problem = checkIoFields(catalog, nested, isOutput, path)
      if (problem !== null) return problem
    }
  }
  return null
}

/** 出参上写了 required 的那些字段名（含嵌套）—— 要作为 advisory 交回去。 */
function outputsWithRequired (fields: readonly ScriptIoField[], at = ''): string[] {
  const found: string[] = []
  for (const field of fields) {
    const path = at === '' ? field.name : `${at}.${field.name}`
    if (field.required === true) found.push(path)
    found.push(...outputsWithRequired(field.fields ?? [], path))
  }
  return found
}

function buildScriptEntry (input: CreateScriptInput): JsonRecord {
  const entry = input.entry === undefined || input.entry === '' ? 'handle' : input.entry
  return {
    name: input.name,
    ...(input.description === undefined || input.description === '' ? {} : { description: input.description }),
    path: input.path,
    ...(entry === 'handle' ? {} : { entry }),
    allowlist: [...(input.allowlist ?? [])],
    io: toIoSection(input.inputs ?? [], input.outputs ?? []),
  }
}

/** 只建功能（JS + 清单条目），不建节点。 */
export function prepareCreateScriptFunction (
  context: ScriptCommandContext,
  input: CreateScriptInput,
): PrepareResult {
  const read = readManifest(context)
  if ('error' in read) return reject(read.error)
  const { raw } = read

  const language = context.scriptLanguage ?? 'javascript'
  const nameProblem = checkScriptName(raw, input.name)
  if (nameProblem !== null) return reject(nameProblem)
  const pathProblem = checkScriptPath(input.path, language)
  if (pathProblem !== null) return reject(pathProblem)
  const allowlistProblem = checkAllowlist(context.catalog, input.allowlist ?? [])
  if (allowlistProblem !== null) return reject(allowlistProblem)
  // 新建时也要判 I/O：从画布建出来的功能同样可以带声明，
  // 让「建的时候不判、改的时候才判」是两套规则。
  const inputProblem = checkIoFields(context.catalog, input.inputs ?? [], false, '')
  if (inputProblem !== null) return reject(inputProblem)
  const outputProblem = checkIoFields(context.catalog, input.outputs ?? [], true, '')
  if (outputProblem !== null) return reject(outputProblem)

  // 同一份源码放多个入口是**受支持**的用法（goja 没有模块系统，这是唯一的复用机制）。
  // 故 path 撞了不拒；但 path+entry 都撞就是真重复。
  const entry = input.entry === undefined || input.entry === '' ? 'handle' : input.entry
  const duplicate = scriptsOf(raw).find(script =>
    script.path === input.path && (script.entry ?? 'handle') === entry)
  if (duplicate !== undefined) {
    return reject(`已有功能 ${String(duplicate.name)} 用了同一个 path + entry（${input.path} / ${entry}）。`)
  }

  const scriptWorkspacePath = toWorkspacePath(context.manifest.path, input.path)
  const reusesExistingFile = scriptsOf(raw).some(script => script.path === input.path)

  const edits: PreparedFileEdit[] = [
    {
      path: context.manifest.path,
      kind: 'modify',
      ops: [
        ...(Array.isArray(raw.scripts) ? [] : [{ path: ['scripts'], value: [] } satisfies JsonEditOp]),
        { path: ['scripts', scriptsOf(raw).length], value: buildScriptEntry(input), insert: true },
      ],
    },
    // 复用已有文件时**不要**再建一次：那会用模板盖掉别人的实现。
    ...(reusesExistingFile
      ? []
      : [{ path: scriptWorkspacePath, kind: 'create' as const, content: scriptTemplate(input, language) }]),
  ]

  return {
    ok: true,
    command: command(context, 'CreateScriptFunction', `新建业务功能 ${input.name}`, edits, [manifestDoc(context)], {
      openPath: scriptWorkspacePath,
    }),
  }
}

// ── 9. CreateScriptAndBind ────────────────────────────────────────────────

export interface CreateScriptAndBindInput extends CreateScriptInput {
  readonly stepId: string;
  readonly upstream?: string;
  /**
   * stepId 已存在时改为把功能**绑定到该步骤**（不新建节点）。
   *
   * ★ 检查器里「新建业务功能」走的就是这一路：节点已经在了，缺的只是
   * `inputs.script.const`。与「新建节点」共用同一条命令 —— 仍然是
   * 「清单 + 源码 + 接线」要么全成、要么一个字节都不写的原子操作。
   */
  readonly bindExisting?: boolean;
}

/** 建功能，并在流程里建一个调用它的节点；或绑定到已有节点。 */
export function prepareCreateScriptAndBind (
  context: ScriptCommandContext,
  input: CreateScriptAndBindInput,
): PrepareResult {
  if (context.workflow === undefined) return reject('要同时建节点，必须提供当前工作流文档。')
  const base = prepareCreateScriptFunction(context, input)
  if (!base.ok) return base

  if (!canEditJson(context.workflow.text)) {
    return reject(`${context.workflow.path} 当前不是合法 JSON，请先修好语法错误。`)
  }
  const flow = parseJsonValue(context.workflow.text)
  if (!isRecord(flow)) return reject(`${context.workflow.path} 顶层不是对象。`)
  const steps = Array.isArray(flow.steps) ? flow.steps.filter(isRecord) : []
  const stepIndex = steps.findIndex(step => step.id === input.stepId)
  if (stepIndex >= 0 && input.bindExisting !== true) return reject(`步骤 id ${input.stepId} 已存在。`)
  if (stepIndex < 0 && input.bindExisting === true) return reject(`步骤 ${input.stepId} 不存在，无法绑定。`)
  if (input.upstream !== undefined && !steps.some(step => step.id === input.upstream)) {
    return reject(`上游步骤 ${input.upstream} 不存在。`)
  }

  // 绑定到已有节点：只写 inputs.script.const，不碰这一步的其它配置。
  if (stepIndex >= 0) {
    const existing = steps[stepIndex]!
    if (existing.action !== context.catalog.scriptAction) {
      return reject(`步骤 ${input.stepId} 的 action 不是 ${context.catalog.scriptAction}，不能绑定业务功能。`)
    }
    return {
      ok: true,
      command: command(
        context,
        'CreateScriptAndBind',
        `新建业务功能 ${input.name} 并绑定到 ${input.stepId}`,
        [
          ...base.command.edits,
          { path: context.workflow.path, kind: 'modify', ops: [
            { path: ['steps', stepIndex, 'inputs', 'script'], value: { const: input.name } },
          ] },
        ],
        [manifestDoc(context), { path: context.workflow.path, generation: context.workflow.generation }],
        { stepId: input.stepId, openPath: toWorkspacePath(context.manifest.path, input.path) },
      ),
    }
  }

  const step: JsonRecord = {
    id: input.stepId,
    action: context.catalog.scriptAction,
    ...(input.upstream === undefined ? {} : { needs: [input.upstream] }),
    inputs: { script: { const: input.name } },
  }
  const flowOps: JsonEditOp[] = [
    ...(Array.isArray(flow.steps) ? [] : [{ path: ['steps'], value: [] } satisfies JsonEditOp]),
    { path: ['steps', steps.length], value: step, insert: true },
  ]

  return {
    ok: true,
    command: command(
      context,
      'CreateScriptAndBind',
      `新建业务功能 ${input.name} 并加入节点 ${input.stepId}`,
      [
        ...base.command.edits,
        { path: context.workflow.path, kind: 'modify', ops: flowOps },
      ],
      [manifestDoc(context), { path: context.workflow.path, generation: context.workflow.generation }],
      { stepId: input.stepId, openPath: toWorkspacePath(context.manifest.path, input.path) },
    ),
  }
}

// ── 10. RenameScriptId ────────────────────────────────────────────────────

/**
 * 改功能 ID。
 *
 * ★★ 它会波及**所有**流程里 `inputs.script.const` 等于旧名的地方。
 * 本命令只看得到当前打开的那一份流程 —— 其他流程文件里的引用要用影响清单告诉用户，
 * 而不是假装已经全改好了（那是最坏的一种：用户以为改完了，另一条流程运行期报「脚本未注册」）。
 */
export function prepareRenameScriptId (
  context: ScriptCommandContext,
  input: { readonly from: string; readonly to: string; readonly otherFlows?: readonly string[] },
): PrepareResult {
  const read = readManifest(context)
  if ('error' in read) return reject(read.error)
  const { raw } = read

  const index = scriptIndexOf(raw, input.from)
  if (index < 0) return reject(`清单里没有功能 ${input.from}。`)
  if (input.from === input.to) return reject('新旧功能 ID 相同。')
  const nameProblem = checkScriptName(raw, input.to)
  if (nameProblem !== null) return reject(nameProblem)

  const edits: PreparedFileEdit[] = [
    { path: context.manifest.path, kind: 'modify', ops: [{ path: ['scripts', index, 'name'], value: input.to }] },
  ]
  const documents = [manifestDoc(context)]

  // 当前打开的这份流程里的 inputs.script.const 一起改。
  if (context.workflow !== undefined && canEditJson(context.workflow.text)) {
    const flow = parseJsonValue(context.workflow.text)
    if (isRecord(flow)) {
      const flowSteps = Array.isArray(flow.steps) ? flow.steps.filter(isRecord) : []
      const ops: JsonEditOp[] = []
      flowSteps.forEach((step, stepIndex) => {
        if (!isRecord(step.inputs)) return
        const script = step.inputs.script
        if (isRecord(script) && script.const === input.from) {
          ops.push({ path: ['steps', stepIndex, 'inputs', 'script', 'const'], value: input.to })
        }
      })
      if (ops.length > 0) {
        edits.push({ path: context.workflow.path, kind: 'modify', ops })
        documents.push({ path: context.workflow.path, generation: context.workflow.generation })
      }
    }
  }

  const impacts: CommandImpact[] = (input.otherFlows ?? []).map(path => ({
    stepId: '(其他流程)',
    at: path,
    current: input.from,
    why: '这份流程没有在编辑器里打开，本次不会自动改；请手动把它的 inputs.script.const 一起改掉',
  }))

  return {
    ok: true,
    command: command(context, 'RenameScriptId', `功能 ID ${input.from} → ${input.to}`, edits, documents),
    // 没打开的流程文件本次改不到 —— 必须交出去，不能丢（见 PrepareResult.advisories 的 ★★）。
    ...(impacts.length > 0 ? { advisories: impacts } : {}),
  }
}

// ── 11. MoveScriptFile ───────────────────────────────────────────────────

/** 改实现文件路径：清单 path 改 + 建新文件 + 删旧文件。 */
export function prepareMoveScriptFile (
  context: ScriptCommandContext,
  input: {
    readonly name: string;
    readonly toPath: string;
    /** 旧文件此刻的内容（要原样搬到新路径去）。 */
    readonly currentSource: string;
    /**
     * 旧文件此刻的 generation。
     * ⚠️ 必须给：少了它，用户在搬动过程中对旧文件的编辑会被静默丢掉
     * （我们把「搬之前读到的那份」写到新路径，然后把旧文件删了）。
     */
    readonly sourceGeneration: number;
  },
): PrepareResult {
  const read = readManifest(context)
  if ('error' in read) return reject(read.error)
  const { raw } = read

  const index = scriptIndexOf(raw, input.name)
  if (index < 0) return reject(`清单里没有功能 ${input.name}。`)
  const pathProblem = checkScriptPath(input.toPath, context.scriptLanguage ?? 'javascript')
  if (pathProblem !== null) return reject(pathProblem)

  const current = scriptsOf(raw)[index]!
  const fromPath = typeof current.path === 'string' ? current.path : ''
  if (fromPath === input.toPath) return reject('新旧路径相同。')

  // ⚠️ 同一份文件被多个功能共用时不能删旧文件：那会让另外那几条功能失去实现。
  const sharedBy = scriptsOf(raw).filter(script => script.path === fromPath && script.name !== input.name)
  const oldWorkspacePath = toWorkspacePath(context.manifest.path, fromPath)
  const newWorkspacePath = toWorkspacePath(context.manifest.path, input.toPath)

  const edits: PreparedFileEdit[] = [
    { path: context.manifest.path, kind: 'modify', ops: [{ path: ['scripts', index, 'path'], value: input.toPath }] },
    { path: newWorkspacePath, kind: 'create', content: input.currentSource },
    ...(sharedBy.length > 0 ? [] : [{ path: oldWorkspacePath, kind: 'delete' as const }]),
  ]

  return {
    ok: true,
    command: command(
      context,
      'MoveScriptFile',
      sharedBy.length > 0
        ? `移动 ${input.name} 的实现到 ${input.toPath}（旧文件仍被 ${sharedBy.length} 个功能共用，保留）`
        : `移动 ${input.name} 的实现到 ${input.toPath}`,
      edits,
      [manifestDoc(context), { path: oldWorkspacePath, generation: input.sourceGeneration }],
      { openPath: newWorkspacePath },
    ),
  }
}

// ── 12. RenameScriptEntry ────────────────────────────────────────────────

/**
 * 改入口函数名。
 *
 * ⚠️ 只改清单里的 `entry`，**不改 JS 源码里的函数名** —— 改源码要做真正的标识符
 * 重写（字符串里、注释里的同名不能动），那不是 JSON 编辑能安全做的事。
 * 故本命令把「源码里也要改」作为一条提示交回给用户。
 */
export function prepareRenameScriptEntry (
  context: ScriptCommandContext,
  input: { readonly name: string; readonly entry: string },
): PrepareResult {
  const read = readManifest(context)
  if ('error' in read) return reject(read.error)
  const { raw } = read

  const index = scriptIndexOf(raw, input.name)
  if (index < 0) return reject(`清单里没有功能 ${input.name}。`)
  if (!/^[A-Za-z_$][\w$]*$/.test(input.entry)) {
    return reject(`入口名 ${JSON.stringify(input.entry)} 不是合法的 JS 标识符。`)
  }

  const current = scriptsOf(raw)[index]!
  if ((current.entry ?? 'handle') === input.entry) return reject('入口名没有变化。')

  // path+entry 组合不能与别的功能撞（那两条会指向同一个函数）。
  const clash = scriptsOf(raw).find((script, position) =>
    position !== index && script.path === current.path && (script.entry ?? 'handle') === input.entry)
  if (clash !== undefined) {
    return reject(`功能 ${String(clash.name)} 已经用了 ${String(current.path)} 的 ${input.entry} 入口。`)
  }

  return {
    ok: true,
    command: command(
      context,
      'RenameScriptEntry',
      `${input.name} 的入口改为 ${input.entry}（⚠️ JS 源码里的函数名要你自己改）`,
      [{
        path: context.manifest.path,
        kind: 'modify',
        ops: [{ path: ['scripts', index, 'entry'], value: input.entry }],
      }],
      [manifestDoc(context)],
    ),
  }
}

// ── 13. ChangeScriptIO ───────────────────────────────────────────────────

/**
 * 出参声明的三种迁移，各自意味着什么。
 *
 * ★★ 关键事实：**`outputs` 为空 = 透传，不是「什么都不产出」**。
 * worker 的 `ProjectOutputs` 在 `len(outputs)==0` 时把脚本 return 的整块原样交出去；
 * 只要声明了哪怕一个键，就翻成「只有声明过的交给下游，其余一律丢掉」。
 *
 *   非空 → 非空   删掉的键若被引用 → 那些接线解不开
 *   空   → 非空   **整条脚本从透传翻成投影**：下游引用的任何不在新声明里的键，
 *                 这一下全部解不开。⚠️ 这一格最早是漏的 —— 按「删掉的键」去算，
 *                 空集减去新集恒为空，于是一条影响都不报，用户点完保存什么都没发生，
 *                 而下游那几条接线已经死了。
 *   非空 → 空     翻回透传，是**放宽**：原先声明过的键仍然会被 return 出来。
 *                 不拦，但要说一声（脚本多 return 的东西也会一起交给下游了）。
 */
type OutputsMigration = 'narrow' | 'to-projection' | 'to-passthrough'

function classifyOutputs (before: readonly string[], after: readonly string[]): OutputsMigration {
  if (before.length === 0 && after.length > 0) return 'to-projection'
  if (before.length > 0 && after.length === 0) return 'to-passthrough'
  return 'narrow'
}

/** 流程里「调用了这个功能」的节点 id。 */
function callersOf (flow: JsonRecord, scriptName: string): Set<string> {
  const steps = Array.isArray(flow.steps) ? flow.steps.filter(isRecord) : []
  return new Set(steps
    .filter(step => isRecord(step.inputs) && isRecord(step.inputs.script)
      && (step.inputs.script as JsonRecord).const === scriptName)
    .map(step => String(step.id)))
}

/**
 * 改功能的 I/O 声明。
 *
 * ★★ 出参声明的改动会波及**流程文件里的接线**，而那些接线不在本命令直接改的范围内。
 * 故这里先算影响、报给用户，由用户决定 —— 不自动改指、也不自动删（见 references.ts 的纪律）。
 */
export function prepareChangeScriptIo (
  context: ScriptCommandContext,
  input: {
    readonly name: string;
    readonly inputs: readonly ScriptIoField[];
    readonly outputs: readonly ScriptIoField[];
    readonly force?: boolean;
  },
): PrepareResult {
  const read = readManifest(context)
  if ('error' in read) return reject(read.error)
  const { raw } = read

  const index = scriptIndexOf(raw, input.name)
  if (index < 0) return reject(`清单里没有功能 ${input.name}。`)

  const inputProblem = checkIoFields(context.catalog, input.inputs, false, '')
  if (inputProblem !== null) return reject(inputProblem)
  const outputProblem = checkIoFields(context.catalog, input.outputs, true, '')
  if (outputProblem !== null) return reject(outputProblem)

  const script = findScript(context.catalog, input.name)
  // 「改之前是什么」以**清单原文**为准，不以词表为准：词表可能来自上一次落盘，
  // 而本命令的前置核验对的是这一刻的清单文本。两者不一致时按词表算会算错迁移方向。
  const current = scriptsOf(raw)[index]
  const currentIo = isRecord(current?.io) ? current.io : undefined
  const before = currentIo === undefined
    ? (script?.outputs ?? []).map(field => field.name)
    : (Array.isArray(currentIo.outputs) ? currentIo.outputs : [])
        .filter(isRecord)
        .map(field => String(field.name))
  const after = input.outputs.map(field => field.name)
  const migration = classifyOutputs(before, after)

  // 哪些键在改完之后取不到。narrow 看「删掉的」；to-projection 时整块收窄，
  // 「不在新声明里的」全部取不到；to-passthrough 是放宽，一个都不坏。
  const broken = (key: string): boolean => {
    switch (migration) {
      case 'narrow':
        return before.includes(key) && !after.includes(key)
      case 'to-projection':
        return !after.includes(key)
      case 'to-passthrough':
        return false
    }
  }

  const impacts: CommandImpact[] = []
  if (migration !== 'to-passthrough' && context.workflow !== undefined && canEditJson(context.workflow.text)) {
    const flow = parseJsonValue(context.workflow.text)
    if (isRecord(flow)) {
      const callerIds = callersOf(flow, input.name)
      for (const site of collectReferences(flow)) {
        if (site.targetStepId === undefined || !callerIds.has(site.targetStepId)) continue
        // `steps.<id>.<key>…` —— 第三段就是取的那个出参键。
        const key = site.value.split('.')[2]
        if (key === undefined || key.startsWith('$') || !broken(key)) continue
        impacts.push({
          stepId: site.stepId,
          at: site.at,
          current: site.value,
          why: migration === 'to-projection'
            ? `${input.name} 原先没有出参声明（整块原样输出），声明之后 ${key} 不在其中，这个取值会取不到值`
            : `引用了 ${input.name} 即将删除的出参 ${key}`,
        })
      }
    }
  }
  if (impacts.length > 0 && input.force !== true) {
    const lost = before.filter(key => !after.includes(key)).join(' / ')
    const projectionReason = `${input.name} 原先没有出参声明（脚本 return 什么都交给下游）。`
      + `声明出参之后只有 ${after.join(' / ')} 会交给下游，其余一律丢掉 —— `
      + `这会让 ${impacts.length} 处取值取不到值。`
    return {
      ok: false,
      reason: migration === 'to-projection'
        ? projectionReason
        : `删除出参会让 ${impacts.length} 处取值无法解析（${lost}）。`,
      impacts,
    }
  }

  // 出参上的 required 平台不读，写值时剥掉 —— 但必须说一声，不静默丢。
  const strippedRequired = outputsWithRequired(input.outputs)
  const advisories: CommandImpact[] = strippedRequired.map(path => ({
    stepId: input.name,
    at: `io.outputs.${path}`,
    current: 'required: true',
    why: '出参上的 required 平台不读（声明即必产），已从写入的清单里去掉',
  }))
  if (migration === 'to-passthrough') {
    advisories.push({
      stepId: input.name,
      at: 'io.outputs',
      current: `原有 ${before.join(' / ')}`,
      why: '出参声明清空 = 回到原样输出：脚本 return 的所有键都会交给下游，包括你没打算公开的那些',
    })
  }

  return {
    ok: true,
    command: command(
      context,
      'ChangeScriptIO',
      `修改 ${input.name} 的 I/O 声明`,
      [{
        path: context.manifest.path,
        kind: 'modify',
        ops: [{
          path: ['scripts', index, 'io'],
          value: toIoSection(input.inputs, input.outputs),
        }],
      }],
      [manifestDoc(context)],
    ),
    ...(advisories.length > 0 ? { advisories } : {}),
  }
}
