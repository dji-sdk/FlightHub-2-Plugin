// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 基于 jsonc-parser 的**最小文本编辑**：只改该改的那几个字节，其余原样不动。
 *
 * ★★ 为什么必须是最小编辑，而不是「解析 → 改对象 → 整份重新序列化」（自研
 * json-layout.ts 的老做法）：
 *   ① 手写的 workflow/plugin JSON 大量用紧凑内联写法，整份重排会产生几十行无意义 diff；
 *   ② 重排会丢掉注释、未知字段的排版、作者刻意的分组空行；
 *   ③ 最重要的一条：整份替换会**清空 Monaco 的 undo 栈并让光标跳走** ——
 *      画布点一下就让用户在源码页签里丢掉撤销历史，那是不可接受的。
 *
 * ⓘ 自研那版连**零编辑 round-trip 都做不到**：像
 *      { "id": "a", "action": "x",
 *        "inputs": { … } }
 *   这种「紧凑但跨行」的手写排版，它的 inline/block 二元判据会判成 block，
 *   于是零改动也会被摊平成一属性一行（正是 `lossless=false` 那条警告的来源）。
 *
 * ⚠️⚠️ jsonc-parser 的 `modify` 有一个**必须绕开的坑**（实测 3.3.1）：
 *   传 formattingOptions  → 插入点缩进正确，但它会把**被结构性修改的那个容器整个重排**；
 *   不传 formattingOptions → 既有字节一个不动，但插入的内容不带换行、缩进和逗号后空格。
 *
 * 本模块的做法：**一律不传 formattingOptions**（换取「既有字节一个不动」这条硬保证），
 * 插入/替换的文本**自己渲染** —— 缩进照目标容器现有的孩子取，风格照目标容器是否内联取。
 * 于是三件事同时成立：零编辑逐字节不变、未触及区域逐字节不变、被改容器也不被重排。
 */

import type { Edit, JSONPath, Node, ParseError } from 'jsonc-parser'
import { applyEdits, findNodeAtLocation, modify, parseTree, visit } from 'jsonc-parser'

/**
 * 这份文本能不能安全地做结构化编辑。
 *
 * ★★ 调用方**必须先问这一句**再去构造跨文件命令。原因很具体：`modify` 对一份
 * 解析不出来的文本会**回空编辑列表而不报错** —— 于是「脚本文件改了、清单没改」
 * 这种中间态会静默发生，而两边的返回值都是成功。
 *
 * ⓘ 允许注释与尾随逗号（jsonc），只拒真正的语法错误。
 */
export function canEditJson (text: string): boolean {
  const errors: ParseError[] = []
  const root = parseTree(text, errors)
  return root !== undefined && errors.length === 0
}

/**
 * 这份文本里有没有重复键。重复键是合法 JSON 语法（解析时静默取后值），但结构化
 * 编辑重建后原文信息必然丢失——DAG-014-05/07 的不变量：非法/重复 RAW 永远
 * 不允许被结构化操作改动，宁可拒绝也不「顺手洗白」。
 * ⓘ 只查键重复，不管注释/尾随逗号（那类由 canEditJson 的 jsonc 容错另行处理）。
 */
export function hasJsonDuplicateKeys (text: string): boolean {
  const seenStack: Set<string>[] = []
  let duplicate = false
  visit(text, {
    onObjectBegin: () => {
      seenStack.push(new Set())
    },
    onObjectProperty: (property) => {
      const seen = seenStack[seenStack.length - 1]
      if (seen !== undefined) {
        if (seen.has(property)) duplicate = true
        else seen.add(property)
      }
    },
    onObjectEnd: () => {
      seenStack.pop()
    },
  })
  return duplicate
}

/** 一次编辑操作。`value === undefined` = 删除该路径。 */
export interface JsonEditOp {
  readonly path: JSONPath;
  /** 目标值；`undefined` 表示删除。 */
  readonly value: unknown;
  /**
   * true = 往数组里**插入**一个新元素（而不是替换第 index 个）。
   * ⚠️ 不给这一格时 `path` 末段是数组下标会被当成**替换**，把已有元素覆盖掉。
   */
  readonly insert?: boolean;
}

/** 新建容器走内联渲染时的宽度上限，超过就摊开，避免出现超长单行。 */
const INLINE_WIDTH_LIMIT = 76

/** 从原文推断缩进单位（一层缩进用几个空格 / 一个 tab）。 */
export function detectIndentUnit (text: string): string {
  const match = /\n([ \t]+)\S/.exec(text)
  const sample = match?.[1] ?? '  '
  return sample.startsWith('\t') ? '\t' : ' '.repeat(sample.length)
}

/** 从原文推断行尾。混用时以首个换行为准，不做全局归一化（那会改一整份文件）。 */
export function detectEol (text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function isContainer (value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

/** 内联渲染：`{ "a": 1, "b": [1, 2] }` —— 与手写文件的观感一致（逗号后有空格）。 */
function renderInline (value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(renderInline).join(', ')}]`
  if (isContainer(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
    if (entries.length === 0) return '{}'
    return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${renderInline(item)}`).join(', ')} }`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 孩子全是标量或空容器 → 适合内联（与手写风格一致）。 */
function fitsInline (value: unknown, indentWidth: number): boolean {
  if (!isContainer(value)) return true
  const children = Array.isArray(value) ? value : Object.values(value)
  const simple = children.every(child =>
    !isContainer(child) || (Array.isArray(child) ? child.length === 0 : Object.keys(child).length === 0))
  if (!simple) return false
  return renderInline(value).length + indentWidth <= INLINE_WIDTH_LIMIT
}

/** 多行渲染：容器摊开，简单的孩子仍内联。`baseIndent` 是本值所在行的缩进。 */
function renderBlock (value: unknown, baseIndent: string, unit: string, eol: string): string {
  if (!isContainer(value)) return JSON.stringify(value) ?? 'null'
  const entries = Array.isArray(value)
    ? value.map(item => ({ key: undefined as string | undefined, item }))
    : Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => ({ key, item }))
  if (entries.length === 0) return Array.isArray(value) ? '[]' : '{}'
  if (fitsInline(value, baseIndent.length)) return renderInline(value)

  const childIndent = baseIndent + unit
  const lines = entries.map(({ key, item }) => {
    const rendered = renderBlock(item, childIndent, unit, eol)
    return key === undefined ? `${childIndent}${rendered}` : `${childIndent}${JSON.stringify(key)}: ${rendered}`
  })
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
  return `${open}${eol}${lines.join(`,${eol}`)}${eol}${baseIndent}${close}`
}

/** 某个节点在原文里是不是写成单行的。 */
function isInlineNode (text: string, node: Node | undefined): boolean {
  if (node === undefined) return false
  return !text.slice(node.offset, node.offset + node.length).includes('\n')
}

/**
 * 目标容器是不是「紧凑收尾」的 —— 即**在末尾追加一条时该不该换行**。
 *
 * ★★ 判据是「最后一个孩子与收尾括号之间有没有换行」，**不是**「容器整体是否跨行」。
 * 这一条是本模块最关键的启发式，因为手写 JSON 有三种形态而不是两种：
 *
 *   ① 纯单行   `{ "a": 1, "b": 2 }`                    → 追加要留在本行
 *   ② 紧凑跨行  `{ "id": "a", "action": "x",
 *                 "inputs": { … } }`                   → 追加也要留在本行（收尾括号跟在后面）
 *   ③ 常规多行  `{\n  "id": "a",\n  "action": "x"\n }`  → 追加要另起一行
 *
 * 只按「整体是否跨行」分的话，② 会被误判成 ③ —— 于是给一个手写紧凑 step 加一个字段，
 * 会在它中间插进一行缩进对不上的属性（真踩过，见本模块的测试用例）。
 */
function closesCompactly (text: string, container: Node): boolean {
  const children = container.children ?? []
  const last = children[children.length - 1]
  // 空容器没有孩子可参照，退回「整体是否跨行」。
  if (last === undefined) return isInlineNode(text, container)
  const tail = text.slice(last.offset + last.length, container.offset + container.length)
  return !tail.includes('\n')
}

/** 取某个偏移所在行的前导空白（= 那一行的缩进）。 */
function indentAtOffset (text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  const match = /^[ \t]*/.exec(text.slice(lineStart, offset))
  return match?.[0] ?? ''
}

/**
 * 目标容器里「孩子该用什么缩进」。
 *
 * 取**最后一个孩子那一行的缩进**而不是「容器缩进 + 一个单位」：手写文件里容器与孩子的
 * 相对缩进不总是一个单位（对齐到括号后、多加一层的都有），照抄现有孩子才不会突兀。
 * 容器为空时没有孩子可抄，退回「容器行缩进 + 一个单位」。
 */
function childIndentOf (text: string, container: Node, unit: string): string {
  const children = container.children ?? []
  const last = children[children.length - 1]
  if (last !== undefined) return indentAtOffset(text, last.offset)
  return indentAtOffset(text, container.offset) + unit
}

/** 一次编辑的渲染上下文。 */
interface RenderContext {
  readonly inline: boolean;
  readonly childIndent: string;
  readonly unit: string;
  readonly eol: string;
}

/** 把一条 payload（属性条目或数组元素）渲染成目标风格。 */
function renderPayload (path: JSONPath, value: unknown, context: RenderContext): string {
  const last = path[path.length - 1]
  const rendered = context.inline
    ? renderInline(value)
    : renderBlock(value, context.childIndent, context.unit, context.eol)
  return typeof last === 'string' ? `${JSON.stringify(last)}: ${rendered}` : rendered
}

/** 算出一次编辑对应的文本编辑列表（不落盘、不改入参）。 */
export function computeJsonEdits (text: string, op: JsonEditOp): Edit[] {
  // 一律不传 formattingOptions：换取「既有字节一个不动」。格式由本模块自己补。
  const raw = modify(text, op.path, op.value, op.insert === true ? { isArrayInsertion: true } : {})
  if (raw.length === 0) return raw
  // 删除：modify 给出的就是纯删除区间，已经最小，不需要重渲染。
  if (op.value === undefined) return raw

  const root = parseTree(text)
  const container = root === undefined ? undefined : findNodeAtLocation(root, op.path.slice(0, -1))
  if (container === undefined) return raw

  const unit = detectIndentUnit(text)
  const eol = detectEol(text)
  // 追加是否留在本行，按「容器收尾紧不紧凑」判（见 closesCompactly 的 ★★）。
  const inline = closesCompactly(text, container)
  const context: RenderContext = {
    inline,
    childIndent: childIndentOf(text, container, unit),
    unit,
    eol,
  }
  const payload = renderPayload(op.path, op.value, context)
  const empty = (container.children?.length ?? 0) === 0

  return raw.map((edit) => {
    // 纯替换（覆盖一段既有文本，且 modify 没有插入分隔符）：直接换成渲染结果。
    // ⚠️ 替换时的缩进基准是**被替换节点所在行**，不是容器的孩子缩进 ——
    //    深层嵌套值替换时两者可能差好几层。
    if (edit.length > 0) {
      const target = root === undefined ? undefined : findNodeAtLocation(root, op.path)
      const base = target === undefined ? context.childIndent : indentAtOffset(text, target.offset)
      const targetInline = target === undefined ? inline : isInlineNode(text, target)
      const rendered = targetInline || isSmall(op.value, base.length)
        ? renderInline(op.value)
        : renderBlock(op.value, base, unit, eol)
      const last = op.path[op.path.length - 1]
      // modify 的替换区间可能只覆盖值、也可能覆盖 "键": 值 整条，照它给的形状回填。
      const covered = text.slice(edit.offset, edit.offset + edit.length)
      const replacesEntry = typeof last === 'string' && covered.trimStart().startsWith('"')
        && covered.includes(':')
      return { ...edit, content: replacesEntry ? `${JSON.stringify(last)}: ${rendered}` : rendered }
    }

    // 插入：容器非空时 modify 会带一个前导逗号，本模块据此补分隔与缩进。
    if (empty) {
      return inline
        ? { ...edit, content: payload }
        : { ...edit, content: `${eol}${context.childIndent}${payload}${eol}${indentAtOffset(text, container.offset)}` }
    }
    return inline
      ? { ...edit, content: `, ${payload}` }
      : { ...edit, content: `,${eol}${context.childIndent}${payload}` }
  })
}

function isSmall (value: unknown, indentWidth: number): boolean {
  return fitsInline(value, indentWidth)
}

/**
 * 应用一次编辑，回新文本。
 *
 * ⚠️ 多次编辑必须**逐次**调用（每次都基于上一次的结果）：`modify` 算出的 offset 是
 * 针对传入那份文本的，一批编辑里前一条会让后面的 offset 全部错位。
 * 批量入口见 {@link applyJsonEditOps}。
 */
export function applyJsonEditOp (text: string, op: JsonEditOp): string {
  const edits = computeJsonEdits(text, op)
  return edits.length === 0 ? text : applyEdits(text, edits)
}

/** 顺序应用一批编辑，回新文本（逐条重算 offset，见上面那条 ⚠️）。 */
export function applyJsonEditOps (text: string, ops: readonly JsonEditOp[]): string {
  let current = text
  for (const op of ops) current = applyJsonEditOp(current, op)
  return current
}

/**
 * 读一份 JSON 的值（容忍注释与尾随逗号，与编辑侧同一个解析器）。
 *
 * ⚠️ 刻意不用 `JSON.parse`：两个解析器对同一份文本的接受域不同，
 * 会出现「读得出来但编辑不了」或反之的错配。
 */
export function parseJsonValue (text: string): unknown {
  const root = parseTree(text)
  if (root === undefined) return undefined
  return nodeValue(root)
}

function nodeValue (node: Node): unknown {
  switch (node.type) {
    case 'object': {
      const result: Record<string, unknown> = {}
      for (const child of node.children ?? []) {
        const [keyNode, valueNode] = child.children ?? []
        if (keyNode === undefined || typeof keyNode.value !== 'string') continue
        result[keyNode.value] = valueNode === undefined ? undefined : nodeValue(valueNode)
      }
      return result
    }
    case 'array':
      return (node.children ?? []).map(nodeValue)
    default:
      return node.value
  }
}
