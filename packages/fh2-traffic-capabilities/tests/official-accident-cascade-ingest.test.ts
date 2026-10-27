// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCtx } from 'fh2-plugin-sdk/backend'
import { toCatalog } from '../../fh2-plugin-toolchain/src/workflow/core/catalog.js'
import { validateSemantics } from '../../fh2-plugin-toolchain/src/workflow/core/semantics.js'
import { resolveIdeActions } from '../../fh2-plugin-toolchain/src/workflow/service/catalog.js'
import { handle } from '../official_accident/backend/official_accident_plugin/adapters/cascade-ingest'

const PLUGIN_ROOT = join(
  import.meta.dirname,
  '../official_accident/backend/official_accident_plugin',
)
const WORKFLOW_PATH = 'workflows/cascade-ingest.json'

function realWorkflow (): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PLUGIN_ROOT, WORKFLOW_PATH), 'utf8')) as Record<string, unknown>
}

function semanticIssues (workflow: Record<string, unknown>) {
  const catalog = toCatalog(resolveIdeActions({ root: PLUGIN_ROOT, workflowPath: WORKFLOW_PATH }))
  return validateSemantics(catalog, { raw: workflow })
}

function ctxAt (now: string): AdapterCtx {
  return { now, idempotencyKey: '' }
}

function jsonResponse (data: unknown): { status: number; body: string } {
  return { status: 200, body: JSON.stringify({ code: 1, data }) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('official_accident cascade-ingest', () => {
  it('真实工作流用 windowTo 接 run.now，不修改平台保留键契约', () => {
    const workflow = realWorkflow()
    const step = (workflow.steps as Array<Record<string, unknown>>)[0]!
    const inputs = step.inputs as Record<string, unknown>

    expect(inputs).not.toHaveProperty('now')
    expect(inputs.windowTo).toEqual({ from: 'run.now' })
    expect(inputs).toHaveProperty('intervalSec')

    const issues = semanticIssues(workflow)
    expect(issues.filter(issue => issue.level === 'error')).toEqual([])
  })

  it('windowTo 漏接仍报告必填入参错误，不靠 ctx.now 或本机时间补值', () => {
    const workflow = realWorkflow()
    const step = (workflow.steps as Array<Record<string, unknown>>)[0]!
    delete (step.inputs as Record<string, unknown>).windowTo
    expect(semanticIssues(workflow)).toContainEqual(expect.objectContaining({
      rule: 'R1_REQUIRED_INPUT_UNWIRED',
      inputKey: 'windowTo',
    }))
  })

  it('语义校验仍会拦截重新加回工作流的 now 保留键', () => {
    const workflow = realWorkflow()
    const step = (workflow.steps as Array<Record<string, unknown>>)[0]!
    const inputs = step.inputs as Record<string, unknown>
    inputs.now = { from: 'run.now' }

    const issues = semanticIssues(workflow)
    expect(issues).toContainEqual(expect.objectContaining({
      rule: 'R2_UNDECLARED_INPUT',
      inputKey: 'now',
    }))
  })

  it.each(['', 'not-a-time'])('windowTo=%j 时明确报错，不取本机时间也不访问上游', (windowTo) => {
    const fetch = vi.fn()
    vi.stubGlobal('platform', {
      getConfig: () => ({
        baseUrl: 'https://cascade.example',
        loginName: 'user',
        password: 'secret',
        source: 1,
      }),
    })
    vi.stubGlobal('connector', { fetch })
    expect(() => handle({ windowTo, intervalSec: 30 }, ctxAt('2026-10-22T10:00:00.000Z')))
      .toThrow('无法解析时刻')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['', '2000-01-01T00:00:00.000Z'])('ctx.now=%j 时采集窗口与事件时间仍来自 windowTo', (ctxNow) => {
    const now = '2026-10-22T10:00:00.000Z'
    const fetch = vi.fn((request: { url: string }) => {
      if (request.url.endsWith('/api/sso/login')) return jsonResponse('sso-token')
      if (request.url.endsWith('/api/sso/redirectUrl')) return jsonResponse('https://video.example/sso/redirect')
      if (request.url === 'https://video.example/sso/redirect') return jsonResponse('video-token')
      if (request.url.endsWith('/api/v-case-jj/platform/pull/jq')) return jsonResponse([{ jqbh: 'JQ-1' }])
      throw new Error(`unexpected request: ${request.url}`)
    })
    const insertEvent = vi.fn(() => true)
    vi.stubGlobal('platform', {
      getConfig: () => ({
        baseUrl: 'https://cascade.example',
        loginName: 'user',
        password: 'secret',
        source: 1,
      }),
      insertEvent,
    })
    vi.stubGlobal('connector', { fetch })

    const result = handle({ windowTo: now, intervalSec: 30 }, ctxAt(ctxNow))

    expect(result.windowTo).toBe(now)
    expect(result.windowFrom).toBe('2026-10-22T09:55:00.000Z')
    expect(result.inserted).toBe(1)
    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({ occurredAt: now }))
    const pull = fetch.mock.calls.find(([request]) => request.url.endsWith('/pull/jq'))?.[0]
    expect(pull).toMatchObject({
      body: { startTime: '2026-10-22 17:55:00', endTime: '2026-10-22 18:00:00' },
    })
  })
})
