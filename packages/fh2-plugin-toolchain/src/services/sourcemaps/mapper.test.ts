// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SourcemapCache, mapRuntimeStack, parseRuntimeStack } from './mapper.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * 最小 sourcemap fixture：mappings 只有一行（生成行 0 无映射、生成行 N 指回源码）。
 * 使用真实 VLQ 编码：构造「生成列 8 → source 0, line 3(0-based), column 9(0-based)」。
 * 编码工具函数直接内联 base64-vlq，保证 fixture 与规范一致。
 */
function encodeVlq (value: number): string {
  let vlq = value < 0 ? ((-value) << 1) | 1 : value << 1
  let out = ''
  do {
    let digit = vlq & 31
    vlq >>>= 5
    if (vlq > 0) digit |= 32
    out += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charAt(digit)
  } while (vlq > 0)
  return out
}

function segment (generatedColumn: number, sourceIndex: number, sourceLine: number, sourceColumn: number): string {
  // 相对前一 segment 的增量编码；这里只有一个 segment，直接给绝对值。
  return [generatedColumn, sourceIndex, sourceLine, sourceColumn].map(encodeVlq).join('')
}

describe('parseRuntimeStack', () => {
  it('解析 Goja 风格 stack 帧', () => {
    const frames = parseRuntimeStack('at h_createIssue (scripts/handlers.js:14:9)\n    at <anonymous> (scripts/events.js:3:1)')
    expect(frames).toEqual([
      { functionName: 'h_createIssue', file: 'scripts/handlers.js', line: 14, column: 9 },
      { functionName: '<anonymous>', file: 'scripts/events.js', line: 3, column: 1 },
    ])
  })
})

describe('sourcemapCache + mapRuntimeStack（B4）', () => {
  it('按 digest+sourceRevision 精确匹配；未命中不映射', async () => {
    const cache = new SourcemapCache()
    cache.register({ artifactDigest: 'd1', sourceRevision: 'r1', mapPath: '/nonexistent.map' })

    expect(cache.lookup('d1', 'r1')).toBeDefined()
    expect(cache.lookup('d1', 'r2')).toBeUndefined()
    expect(cache.lookup('d2', 'r1')).toBeUndefined()
  })

  it('wrapper 偏移后的 map 仍定位真实 TS 行（B3+B4 纵切）', async () => {
    // 生成文件：wrapper 占 2 行（函数 + 空行），IIFE 从第 3 行开始。
    // map 已按 wrapper 平移：生成行 3（0-based 2）列 9（0-based 8）→ src/issue.ts 行 4 列 10（1-based）。
    const root = await mkdtemp(join(tmpdir(), 'fh2-sourcemap-'))
    roots.push(root)
    const mapPath = join(root, 'handlers.js.map')
    // mappings：第 3 行（index 2）一个 segment；source line/column 用 0-based（3, 9）。
    await writeFile(mapPath, JSON.stringify({
      version: 3,
      sources: ['../src/issue.ts'],
      mappings: `;;${segment(8, 0, 3, 9)}`,
    }))

    const result = mapRuntimeStack(
      'at h_createIssue (scripts/handlers.js:3:9)',
      { artifactDigest: 'd1', sourceRevision: 'r1', mapPath },
    )

    expect(result.mapped).toBe(true)
    expect(result.diagnostics[0]).toMatchObject({
      code: 'FH2_RUNTIME_STACK',
      file: '../src/issue.ts',
      line: 4,
      column: 10,
      severity: 'error',
    })
  })

  it('生成位置无映射时保留生成位置，不猜测源码行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-sourcemap-empty-'))
    roots.push(root)
    const mapPath = join(root, 'handlers.js.map')
    await writeFile(mapPath, JSON.stringify({ version: 3, sources: ['../src/issue.ts'], mappings: ';;' }))

    const result = mapRuntimeStack(
      'at h_createIssue (scripts/handlers.js:5:20)',
      { artifactDigest: 'd1', sourceRevision: 'r1', mapPath },
    )

    expect(result.mapped).toBe(true)
    expect(result.diagnostics[0]).toMatchObject({
      file: 'scripts/handlers.js',
      line: 5,
      column: 20,
    })
    expect(result.diagnostics[0]!.hint).toContain('不猜测源码行')
  })

  it('map 不可读时保留原始 stack 并说明限制', () => {
    const result = mapRuntimeStack(
      'at h_createIssue (scripts/handlers.js:3:9)',
      { artifactDigest: 'd1', sourceRevision: 'r1', mapPath: '/nonexistent.map' },
    )

    expect(result.mapped).toBe(false)
    expect(result.diagnostics[0]!.message).toContain('原始 stack')
  })
})
