// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { readFileSync } from 'node:fs'
import type { Diagnostic } from '../../contracts/index.js'

/**
 * B4：运行时 stack → TypeScript Diagnostic 的 Sourcemap 消费接口（实施计划 §3.4）。
 *
 * - 只有运行错误携带的构建标识（artifact digest + sourceRevision）与本地缓存精确
 *   匹配时才映射回 TypeScript；不匹配的远端错误保留原始 stack 并说明限制；
 * - map 已在 compiler 侧按 wrapper 前缀平移（B3），这里直接消费；
 * - 生成代码没有原始位置时保留生成位置，不猜测源码行。
 */

export interface SourceMapIndexEntry {
  readonly artifactDigest: string;
  readonly sourceRevision: string;
  /** .map 文件绝对路径。 */
  readonly mapPath: string;
}

interface RawSourceMap {
  readonly version: number;
  readonly sources: readonly string[];
  readonly sourcesContent?: readonly (string | null)[];
  readonly mappings: string;
}

export class SourcemapCache {
  private readonly entries = new Map<string, SourceMapIndexEntry>()

  register (entry: SourceMapIndexEntry): void {
    this.entries.set(cacheKey(entry.artifactDigest, entry.sourceRevision), entry)
  }

  lookup (artifactDigest: string, sourceRevision: string): SourceMapIndexEntry | undefined {
    return this.entries.get(cacheKey(artifactDigest, sourceRevision))
  }

  get size (): number {
    return this.entries.size
  }
}

function cacheKey (artifactDigest: string, sourceRevision: string): string {
  return `${artifactDigest}\0${sourceRevision}`
}

export interface RuntimeStackFrame {
  readonly functionName: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface StackMappingResult {
  /** 精确匹配且映射成功。 */
  readonly mapped: boolean;
  readonly diagnostics: readonly Diagnostic[];
  /** 未映射原因（mapped=false 时给用户）。 */
  readonly reason?: string;
}

const GOJA_FRAME_PATTERN = /\s*at\s+([^\s(]+)?\s*\(?(.+?):(\d+):(\d+)\)?/

/** 解析 Goja/JS 风格 stack 文本为帧列表；解析不出的行跳过。 */
export function parseRuntimeStack (stack: string): readonly RuntimeStackFrame[] {
  const frames: RuntimeStackFrame[] = []
  for (const line of stack.split('\n')) {
    const match = GOJA_FRAME_PATTERN.exec(line.trim())
    if (match === null) continue
    const rawName = match[1] ?? '<anonymous>'
    const file = match[2]
    const rawLine = match[3]
    const rawColumn = match[4]
    if (file === undefined || rawLine === undefined || rawColumn === undefined) continue
    const lineNumber = Number.parseInt(rawLine, 10)
    const columnNumber = Number.parseInt(rawColumn, 10)
    if (!Number.isFinite(lineNumber) || !Number.isFinite(columnNumber)) continue
    frames.push({
      functionName: rawName,
      file,
      line: lineNumber,
      column: columnNumber,
    })
  }
  return frames
}

/**
 * 把运行时 stack 映射回 TypeScript 原始行列。
 * 未命中缓存/无法解析 map 时保留原始 stack 信息（file 保留生成位置）。
 */
export function mapRuntimeStack (stack: string, entry: SourceMapIndexEntry): StackMappingResult {
  let rawMap: RawSourceMap
  try {
    rawMap = JSON.parse(readFileSync(entry.mapPath, 'utf8')) as RawSourceMap
  } catch (error) {
    return {
      mapped: false,
      diagnostics: [rawFrameDiagnostic('无法读取 Sourcemap，保留原始 stack。', stack)],
      reason: `map unreadable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const frames = parseRuntimeStack(stack)
  if (frames.length === 0) {
    return {
      mapped: false,
      diagnostics: [rawFrameDiagnostic('运行错误无可用 stack 帧，无法定位。', stack)],
      reason: 'no frames',
    }
  }
  const diagnostics: Diagnostic[] = []
  for (const frame of frames) {
    const mapping = mapFrame(frame, rawMap)
    diagnostics.push({
      code: 'FH2_RUNTIME_STACK',
      phase: 'goja-verify',
      file: mapping.source,
      line: mapping.line,
      column: mapping.column,
      message: `运行时 ${frame.functionName}（${frame.file}:${frame.line}:${frame.column}）`,
      ...(mapping.mapped ? {} : { hint: '生成代码位置：无原始位置映射，不猜测源码行。' }),
      severity: 'error',
    })
  }
  return { mapped: true, diagnostics }
}

function mapFrame (frame: RuntimeStackFrame, rawMap: RawSourceMap): {
  readonly source: string;
  readonly line: number;
  readonly column: number;
  readonly mapped: boolean;
} {
  const decoded = decodeLine(rawMap.mappings, frame.line - 1)
  const segment = decoded.find(candidate => candidate.generatedColumn <= frame.column - 1)
  if (segment === undefined || segment.sourceIndex === undefined) {
    return { source: frame.file, line: frame.line, column: frame.column, mapped: false }
  }
  const source = rawMap.sources[segment.sourceIndex]
  return {
    source: source === undefined ? frame.file : source,
    line: (segment.sourceLine ?? 0) + 1,
    column: (segment.sourceColumn ?? 0) + 1,
    mapped: true,
  }
}

function rawFrameDiagnostic (message: string, stack: string): Diagnostic {
  return {
    code: 'FH2_RUNTIME_STACK',
    phase: 'goja-verify',
    file: '.',
    message: `${message} 原始 stack：${stack.trim()}`,
    severity: 'error',
  }
}

interface DecodedSegment {
  readonly generatedColumn: number;
  readonly sourceIndex?: number;
  readonly sourceLine?: number;
  readonly sourceColumn?: number;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_LOOKUP = new Map<string, number>([...BASE64_CHARS].map((char, index) => [char, index]))

/** 解码 sourcemappings 指定生成行的 segments（最小 VLQ 实现，不引入依赖）。 */
function decodeLine (mappings: string, generatedLine: number): readonly DecodedSegment[] {
  const lines = mappings.split(';')
  const target = lines[generatedLine]
  if (target === undefined) return []
  const segments: DecodedSegment[] = []
  let sourceIndex = 0
  let sourceLine = 0
  let sourceColumn = 0
  for (const rawSegment of target.split(',')) {
    if (rawSegment === '') continue
    const values = decodeVlq(rawSegment)
    if (values.length === 0 || values.length === 1) {
      if (values.length === 1) segments.push({ generatedColumn: values[0]! })
      continue
    }
    const [generatedColumn, sourceIndexDelta, sourceLineDelta, sourceColumnDelta] = values
    sourceIndex += sourceIndexDelta ?? 0
    sourceLine += sourceLineDelta ?? 0
    sourceColumn += sourceColumnDelta ?? 0
    segments.push({
      generatedColumn: generatedColumn ?? 0,
      sourceIndex,
      sourceLine,
      sourceColumn,
    })
  }
  return segments
}

function decodeVlq (segment: string): number[] {
  const values: number[] = []
  let shift = 0
  let value = 0
  for (const char of segment) {
    const digit = BASE64_LOOKUP.get(char)
    if (digit === undefined) return []
    const hasContinuation = (digit & 32) !== 0
    value += (digit & 31) << shift
    if (hasContinuation) {
      shift += 5
      continue
    }
    const negate = (value & 1) === 1
    value >>>= 1
    values.push(negate ? -value : value)
    value = 0
    shift = 0
  }
  return values
}
