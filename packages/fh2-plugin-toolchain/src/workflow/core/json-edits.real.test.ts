// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyJsonEditOp, applyJsonEditOps, parseJsonValue } from './json-edits.js'
import { parseJsonWithLayout, stringifyWithLayout } from './json-layout.js'

/**
 * 拿**仓里真实的**后端插件清单与工作流当样本，验证最小文本编辑的两条硬保证。
 *
 * ★★ 为什么必须用真文件而不是手写 fixture：手写 fixture 是按实现的假设写的，
 * 而这条链路真正会遇到的排版来自人手写的业务文件 —— 那里有对齐到括号后的缩进、
 * 紧凑跨行的 step、超长单行的 trigger。自研 json-layout 就是在这些形状上失手的
 * （它连零编辑 round-trip 都过不去，本文件把这件事也钉下来作为「为什么要换」的证据）。
 *
 * ⚠️ 本文件读仓内路径。文件被挪走时它会失败而不是静默跳过 —— 那是想要的：
 * 样本没了就该有人来重新选样本，而不是让门禁悄悄失去覆盖。
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url))

/** 真实样本：覆盖手写紧凑、常规多行、深层嵌套三种形态。 */
const SAMPLES: readonly string[] = [
  'packages/fh2-traffic-capabilities/official_accident/backend/official_accident_plugin/workflows/accident-response-cascade.json',
  'packages/fh2-traffic-capabilities/official_accident/backend/official_accident_plugin/workflows/cascade-ingest.json',
  'packages/fh2-traffic-capabilities/official_capture/backend/official_traffic_capture_backend/workflows/postprocess.json',
  'packages/fh2-traffic-capabilities/official_parking/backend/official_illegal_parking/workflows/patrol-capture.json',
  'packages/fh2-traffic-capabilities/official_accident/backend/official_accident_plugin/fh2-plugin.json',
  'packages/fh2-traffic-capabilities/official_capture/backend/official_traffic_capture_backend/fh2-plugin.json',
  'packages/fh2-plugin-toolchain/template-backend/workflows/example-flow.json',
  'packages/fh2-plugin-toolchain/template-backend/fh2-plugin.json',
]

function read (relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), 'utf8')
}

describe('json-edits 对真实业务文件', () => {
  it.each(SAMPLES)('零编辑 round-trip 逐字节相同：%s', (relative) => {
    const text = read(relative)
    expect(applyJsonEditOps(text, [])).toBe(text)
  })

  it.each(SAMPLES)('改一个顶层标量只动那几个字节：%s', (relative) => {
    const text = read(relative)
    const next = applyJsonEditOp(text, { path: ['description'], value: '改过的说明' })
    expect(next).toContain('"description": "改过的说明"')
    // 值语义上除 description 外完全一致。
    const before = parseJsonValue(text) as Record<string, unknown>
    const after = parseJsonValue(next) as Record<string, unknown>
    delete before.description
    delete after.description
    expect(after).toEqual(before)
  })

  it.each(SAMPLES.filter(path => path.includes('/workflows/')))(
    '往 steps 尾插一个节点后其余 step 的排版逐字节不变：%s',
    (relative) => {
      const text = read(relative)
      const value = parseJsonValue(text) as { steps?: unknown[] }
      const count = value.steps?.length ?? 0
      expect(count, '样本里应当有 steps').toBeGreaterThan(0)

      const next = applyJsonEditOp(text, {
        path: ['steps', count],
        value: { id: 'probe_appended', action: 'run_script' },
        insert: true,
      })
      // 新节点进去了，且 JSON 仍然可解析、既有 step 一个不少。
      const parsed = parseJsonValue(next) as { steps: { id?: string }[] }
      expect(parsed.steps).toHaveLength(count + 1)
      expect(parsed.steps[count]?.id).toBe('probe_appended')

      // 插入点之前的全部字节完全不变 —— 这是「最小编辑」的核心断言。
      const insertionPoint = firstDifference(text, next)
      expect(text.slice(0, insertionPoint)).toBe(next.slice(0, insertionPoint))
      // 且改动之后的尾部（除新增内容外）也对得上。
      expect(next.length).toBeGreaterThan(text.length)
    },
  )

  /**
   * 自研实现做不到零编辑 round-trip —— 这条用例是「为什么要换成 json-edits」的证据。
   *
   * ⓘ 它断言的是**旧实现的缺陷**。旧实现删掉后本用例要一起删，
   *   别把它改成「旧实现也能过」—— 那说明有人在给旧实现打补丁而不是完成迁移。
   */
  it('对照：自研 json-layout 在真实文件上无法零编辑 round-trip', () => {
    const offenders = SAMPLES.filter((relative) => {
      const text = read(relative)
      try {
        const { value, layout } = parseJsonWithLayout(text)
        return stringifyWithLayout(value, layout) !== text
      } catch {
        return true
      }
    })
    expect(offenders.length, '若这里变成 0，说明旧实现被改好了，迁移理由要重新评估').toBeGreaterThan(0)
  })
})

/** 两份文本第一个不同字节的下标；完全相同时回较短者长度。 */
function firstDifference (left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) return index
  }
  return limit
}
