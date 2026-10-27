// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildBackendAssets } from '../backend/manifest.js'
import { BackendRuntimeError, LocalBackendRuntime } from './backend-runtime.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('local backend runtime', () => {
  it('执行 Handler、保持 Data Store 状态并按幂等键复用结果', async () => {
    const root = await fixture()
    const runtime = new LocalBackendRuntime(root)
    const created = await runtime.invoke({
      pluginId: 'exp_runtime_test',
      handler: 'issue.create',
      input: { title: '第一次上报' },
    }, 'create-1') as { id: string; title: string }
    const duplicate = await runtime.invoke({
      pluginId: 'exp_runtime_test',
      handler: 'issue.create',
      input: { title: '不同内容也不会重复执行' },
    }, 'create-1') as { id: string; title: string }
    expect(duplicate).toEqual(created)
    const list = await runtime.invoke({ pluginId: 'exp_runtime_test', handler: 'issue.list', input: {} }) as { total: number }
    expect(list.total).toBe(2)
    runtime.close()
  })

  it('执行至少一次 Event Handler 并可 reset fixture', async () => {
    const root = await fixture()
    const runtime = new LocalBackendRuntime(root)
    expect(await runtime.dispatchEvent({
      id: 'event-1',
      type: 'media.photo_created',
      data: { file_id: 'photo-1' },
    })).toEqual({ matched: true })
    expect(runtime.snapshot().entities.issue?.[0]).toMatchObject({ evidence_file_id: 'photo-1' })
    expect(runtime.reset().entities.issue?.[0]).toMatchObject({ evidence_file_id: '' })
  })

  it('拒绝未知 Handler', async () => {
    const root = await fixture()
    const runtime = new LocalBackendRuntime(root)
    await expect(runtime.invoke({ pluginId: 'exp_runtime_test', handler: 'unknown', input: {} }))
      .rejects.toBeInstanceOf(BackendRuntimeError)
  })

  it.each([
    ['demo-001', 'session:DOCK-7', '340c92a5de6e012cd79e60d3422ec917'],
    ['a:b', 'c', 'f1bb0ca6c7ffab359b80aba12b97054d'],
    ['a', 'b:c', 'f458898b5e7b5d3b5e20ee9b8b2d0af8'],
    ['任务-一', '会话:机场七号', 'b7141866bc4532e4e77c9632a9d5a2f9'],
  ])('stableId 对齐 Worker 固定向量 %s / %s', async (key, scope, expected) => {
    const runtime = new LocalBackendRuntime(await fixture())
    try {
      const request = { pluginId: 'exp_runtime_test', handler: 'stable.id', input: { scope } }
      expect(await runtime.invoke(request, key)).toEqual({ id: expected })
      runtime.reset()
      expect(await runtime.invoke(request, key)).toEqual({ id: expected })
    } finally {
      runtime.close()
    }
  })

  it('相同 key/scope 跨插件得到相同 stableId，不把 pluginId 放入哈希', async () => {
    const first = new LocalBackendRuntime(await fixture())
    const second = new LocalBackendRuntime(await fixture('exp_runtime_other'))
    try {
      const request = { handler: 'stable.id', input: { scope: 'session:DOCK-7' } }
      const expected = { id: '340c92a5de6e012cd79e60d3422ec917' }
      expect(await first.invoke({ ...request, pluginId: 'exp_runtime_test' }, 'demo-001')).toEqual(expected)
      expect(await second.invoke({ ...request, pluginId: 'exp_runtime_other' }, 'demo-001')).toEqual(expected)
    } finally {
      first.close()
      second.close()
    }
  })

  it('stableId 的空 key 保持原有明确失败与字符串错误码', async () => {
    const runtime = new LocalBackendRuntime(await fixture())
    try {
      await expect(runtime.invoke({ pluginId: 'exp_runtime_test', handler: 'stable.id', input: { scope: 'session' } }))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED', status: 400, message: 'stableId 需要 Idempotency-Key。' })
    } finally {
      runtime.close()
    }
  })
})

async function fixture (pluginId = 'exp_runtime_test'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-backend-runtime-'))
  roots.push(root)
  await mkdir(join(root, 'backend/handlers'), { recursive: true })
  await mkdir(join(root, 'backend/events'), { recursive: true })
  await mkdir(join(root, 'mock/fixtures'), { recursive: true })
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(join(root, 'backend/fh2-plugin.json'), JSON.stringify({
    pluginId,
    name: 'Runtime 测试',
    version: '0.1.0',
    handlers: [
      { name: 'issue.create', path: 'handlers/issue.js', entry: 'createIssue', allowlist: ['data:write'] },
      { name: 'issue.list', path: 'handlers/issue.js', entry: 'listIssues', allowlist: ['data:read'] },
      { name: 'stable.id', path: 'handlers/issue.js', entry: 'stableId' },
    ],
    events: [{ type: 'media.photo_created', handler: 'events/photo-created.js', allowlist: ['data:read', 'data:write'] }],
    entities: [{ name: 'issue', fields: [
      { name: 'title', type: 'string', required: true },
      { name: 'evidence_file_id', type: 'string' },
    ] }],
  }))
  await writeFile(join(root, 'backend/handlers/issue.js'), `
function createIssue(input, ctx) {
  var result = ctx.hostCapability('data-store').put('issue', {
    id: ctx.stableId('issue'), title: input.title, evidence_file_id: ''
  }, { upsert: false })
  if (!result.ok) throw result.error
  return result.data
}
function listIssues(_input, ctx) {
  var result = ctx.hostCapability('data-store').query('issue', { limit: 100, offset: 0 })
  if (!result.ok) throw result.error
  return result.data
}
function stableId(input, ctx) {
  return { id: ctx.stableId(input.scope) }
}
`)
  await writeFile(join(root, 'backend/events/photo-created.js'), `
function handle(event, ctx) {
  var store = ctx.hostCapability('data-store')
  var rows = store.query('issue', { limit: 1, offset: 0 }).data
  var issue = rows.list[0]
  issue.evidence_file_id = event.data.file_id
  store.put('issue', issue)
  return { matched: true }
}
`)
  await writeFile(join(root, 'mock/fixtures/default.json'), JSON.stringify({
    entities: { issue: [{ id: 'seed', title: '初始问题', evidence_file_id: '' }] },
  }))
  buildBackendAssets({ projectRoot: root, candidateRoot: join(root, 'dist'), frontendPluginId: pluginId })
  return root
}
