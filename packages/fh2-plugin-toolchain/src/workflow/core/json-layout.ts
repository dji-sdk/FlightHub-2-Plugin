// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 保留原始排版的 JSON 读写。
 *
 * 手写的 `workflows/*.json` 大量使用紧凑内联写法（`{ "const": "x" }`、`["title"]`），
 * 而 `JSON.stringify(v, null, 2)` 会把它们全部摊开成多行 —— 画布上点一下就会产生
 * 几十行无意义 diff。契约 §9 要求画布产出与手写完全同构，所以必须把「哪些容器原本是
 * 单行的」记下来，落盘时原样复现。
 *
 * 记录方式用 WeakSet 按对象身份索引，而不是 JSON Pointer：
 * 增删 step 会让 `/steps/2` 这类指针整体错位，对象身份则不受影响。
 */

export interface JsonLayout {
  /** 原文中被写成单行的容器（对象/数组）。 */
  readonly inline: WeakSet<object>;
  /**
   * 原文中被写成多行的容器。
   * 必须与 {@link inline} 分开记 —— 两个集合都不命中才说明容器是画布新建的，
   * 这时才轮到启发式决定内联与否。只记 inline 的话，源文件刻意摊开的
   * `"trigger": {\n  "api": {}\n}` 会被启发式误收成单行。
   */
  readonly block: WeakSet<object>;
  readonly indent: string;
  readonly trailingNewline: boolean;
}

export interface ParsedJson {
  readonly value: unknown;
  readonly layout: JsonLayout;
}

/** 新建容器走启发式内联时的宽度上限，超过就摊开，避免出现超长单行。 */
const INLINE_WIDTH_LIMIT = 76

export function detectIndent (text: string): string {
  const match = /\n([ \t]+)\S/.exec(text)
  const indent = match?.[1] ?? '  '
  return indent.startsWith('\t') ? '\t' : indent
}

class JsonLayoutParser {
  private readonly text: string
  private index = 0
  readonly inline = new WeakSet<object>()
  readonly block = new WeakSet<object>()

  constructor (text: string) {
    this.text = text
  }

  parse (): unknown {
    this.skipWhitespace()
    const value = this.parseValue()
    this.skipWhitespace()
    if (this.index !== this.text.length) throw new SyntaxError('尾部有多余内容')
    return value
  }

  private skipWhitespace (): void {
    while (this.index < this.text.length && ' \t\n\r'.includes(this.text[this.index]!)) this.index += 1
  }

  private expect (character: string): void {
    if (this.text[this.index] !== character) {
      throw new SyntaxError(`位置 ${this.index} 期望 ${character}`)
    }
    this.index += 1
  }

  private parseValue (): unknown {
    const character = this.text[this.index]
    if (character === '{') return this.parseObject()
    if (character === '[') return this.parseArray()
    if (character === '"') return this.parseString()
    return this.parseLiteral()
  }

  private parseObject (): Record<string, unknown> {
    const start = this.index
    this.expect('{')
    const result: Record<string, unknown> = {}
    this.skipWhitespace()
    if (this.text[this.index] === '}') {
      this.index += 1
      this.record(result, start)
      return result
    }
    for (;;) {
      this.skipWhitespace()
      const key = this.parseString()
      this.skipWhitespace()
      this.expect(':')
      this.skipWhitespace()
      result[key] = this.parseValue()
      this.skipWhitespace()
      if (this.text[this.index] === ',') {
        this.index += 1
        continue
      }
      this.expect('}')
      break
    }
    this.record(result, start)
    return result
  }

  private parseArray (): unknown[] {
    const start = this.index
    this.expect('[')
    const result: unknown[] = []
    this.skipWhitespace()
    if (this.text[this.index] === ']') {
      this.index += 1
      this.record(result, start)
      return result
    }
    for (;;) {
      this.skipWhitespace()
      result.push(this.parseValue())
      this.skipWhitespace()
      if (this.text[this.index] === ',') {
        this.index += 1
        continue
      }
      this.expect(']')
      break
    }
    this.record(result, start)
    return result
  }

  private parseString (): string {
    const start = this.index
    this.expect('"')
    while (this.index < this.text.length) {
      const character = this.text[this.index]!
      if (character === '\\') {
        this.index += 2
        continue
      }
      this.index += 1
      if (character === '"') return JSON.parse(this.text.slice(start, this.index)) as string
    }
    throw new SyntaxError('字符串未闭合')
  }

  private parseLiteral (): unknown {
    const start = this.index
    while (this.index < this.text.length && /[^\s,\]}]/.test(this.text[this.index]!)) this.index += 1
    if (this.index === start) throw new SyntaxError(`位置 ${start} 无法解析`)
    return JSON.parse(this.text.slice(start, this.index)) as unknown
  }

  /** 容器文本跨行 → 原文是展开写法；不跨行 → 内联写法。 */
  private record (container: object, start: number): void {
    if (this.text.slice(start, this.index).includes('\n')) this.block.add(container)
    else this.inline.add(container)
  }
}

export function parseJsonWithLayout (text: string): ParsedJson {
  // 先用原生 JSON.parse 定对错，错误信息也更可读
  const reference: unknown = JSON.parse(text)
  const fallback = (): ParsedJson => ({
    value: reference,
    layout: {
      inline: new WeakSet(),
      block: new WeakSet(),
      indent: detectIndent(text),
      trailingNewline: text.endsWith('\n'),
    },
  })

  const parser = new JsonLayoutParser(text)
  let value: unknown
  try {
    value = parser.parse()
  } catch {
    // 自研 parser 与原生不一致时一律退回原生结果，只是丢掉排版信息
    return fallback()
  }
  if (JSON.stringify(value) !== JSON.stringify(reference)) return fallback()
  return {
    value,
    layout: {
      inline: parser.inline,
      block: parser.block,
      indent: detectIndent(text),
      trailingNewline: text.endsWith('\n'),
    },
  }
}

function isContainer (value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

/** 新建容器的内联判据：孩子全是标量或空容器 —— 与手写文件的观感一致。 */
function shouldInlineNew (value: object): boolean {
  const children = Array.isArray(value) ? value : Object.values(value)
  return children.every(child =>
    !isContainer(child) || (Array.isArray(child) ? child.length === 0 : Object.keys(child).length === 0))
}

function renderInline (value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(renderInline).join(', ')}]`
  if (isContainer(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
    if (entries.length === 0) return '{}'
    return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${renderInline(item)}`).join(', ')} }`
  }
  return JSON.stringify(value) ?? 'null'
}

function render (value: unknown, layout: JsonLayout, depth: number): string {
  if (!isContainer(value)) return JSON.stringify(value) ?? 'null'

  const isEmpty = Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0
  if (isEmpty) return Array.isArray(value) ? '[]' : '{}'

  if (layout.inline.has(value)) return renderInline(value)
  if (!layout.block.has(value) && shouldInlineNew(value)) {
    const candidate = renderInline(value)
    if (candidate.length + depth * layout.indent.length <= INLINE_WIDTH_LIMIT) return candidate
  }

  const pad = layout.indent.repeat(depth + 1)
  const closePad = layout.indent.repeat(depth)
  if (Array.isArray(value)) {
    const items = value.map(item => `${pad}${render(item, layout, depth + 1)}`)
    return `[\n${items.join(',\n')}\n${closePad}]`
  }
  const items = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => `${pad}${JSON.stringify(key)}: ${render(item, layout, depth + 1)}`)
  return `{\n${items.join(',\n')}\n${closePad}}`
}

export function stringifyWithLayout (value: unknown, layout: JsonLayout): string {
  const body = render(value, layout, 0)
  return layout.trailingNewline ? `${body}\n` : body
}
