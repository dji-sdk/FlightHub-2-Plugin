// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BackendRuntimeError } from './backend-runtime.js'
import { CapabilityBackendRuntime } from './capability-backend-runtime.js'
import { createMockGateway } from './gateway.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('capability backend runtime', () => {
  it('公开 store 返回平台列、支持对象排序和分页，不把物理列透传给插件', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.projects[0]!.root, 'dist/handlers/items/public-store.js'), `
function handle(input) {
  if (input.op === 'insert') return store.insert('item_alpha', input.record);
  if (input.op === 'create') return store.createIfAbsent('item_alpha', input.record, input.uniqueBy || ['title']);
  if (input.op === 'update') return store.update('item_alpha', input.filter || {}, input.patch);
  if (input.op === 'delete') return store.delete('item_alpha', input.filter || {});
  return store.query('item_alpha', input.filter || {}, input.options || {});
}
`)
    const runtime = new CapabilityBackendRuntime(fixture.root, fixture.projects)
    const invoke = (input: Record<string, unknown>) => runtime.invoke({
      pluginId: 'exp_backend_alpha',
      handler: 'items.public-store',
      input,
    }) as Promise<{ ok: boolean; data: any; error?: { code: string } }>
    try {
      const inserted = await invoke({ op: 'insert', record: { id: 'b', title: 'beta' } })
      expect(inserted.data).toMatchObject({ id: 'b', title: 'beta', createdAt: expect.any(String), updatedAt: expect.any(String) })
      expect(inserted.data).not.toHaveProperty('created_at')
      expect(inserted.data).not.toHaveProperty('updated_at')
      expect(inserted.data).not.toHaveProperty('tenant_id')
      await invoke({ op: 'insert', record: { id: 'a', title: 'alpha' } })
      await invoke({ op: 'insert', record: { id: 'c', title: 'gamma' } })
      const page = await invoke({ options: { orderBy: [{ field: 'title', dir: 'desc' }], limit: 1, offset: 1 } })
      expect(page.data).toMatchObject({ list: [{ id: 'b' }], total: 3, limit: 1, offset: 1 })
      const keyed = await invoke({ options: { orderBy: [{ title: 'asc' }], limit: 1 } })
      expect(keyed.data.list[0].id).toBe('a')
      const duplicate = await invoke({ op: 'create', record: { title: 'beta' } })
      expect(duplicate.data).toMatchObject({ created: false, record: { id: 'b', createdAt: inserted.data.createdAt } })
      await invoke({ op: 'insert', record: { id: 'same-id', title: 'same-title' } })
      const sameIdSameUnique = await invoke({ op: 'create', record: { id: 'same-id', title: 'same-title' } })
      expect(sameIdSameUnique.data).toMatchObject({ created: false, record: { id: 'same-id', title: 'same-title' } })
      const differentIdSameUnique = await invoke({ op: 'create', record: { id: 'different-id', title: 'same-title' } })
      expect(differentIdSameUnique.data).toMatchObject({ created: false, record: { id: 'same-id', title: 'same-title' } })
      expect(await invoke({
        op: 'create',
        record: { id: 'same-id', routeId: 'route-id-conflict', seq: '2' },
        uniqueBy: ['routeId', 'seq'],
      })).toMatchObject({ ok: false, error: { code: 'DUPLICATE' } })
      const compositeFirst = await invoke({ op: 'create', record: { routeId: 'route-1', seq: '1' }, uniqueBy: ['routeId', 'seq'] })
      expect(compositeFirst.data).toMatchObject({ created: true, record: { routeId: 'route-1', seq: '1' } })
      const compositeSecond = await invoke({ op: 'create', record: { routeId: 'route-1', seq: '1' }, uniqueBy: ['routeId', 'seq'] })
      expect(compositeSecond.data).toMatchObject({ created: false, record: { routeId: 'route-1', seq: '1' } })
      const filtered = await invoke({ filter: { createdAt: { eq: inserted.data.createdAt } } })
      expect(filtered.data.list.some((record: { id: string }) => record.id === 'b')).toBe(true)
      expect(await invoke({ options: { orderBy: ['title desc'] } })).toMatchObject({ ok: false, error: { code: 'INVALID_FILTER' } })
      expect(await invoke({ options: { orderBy: [{ field: 'not_declared' }] } })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_FIELD' } })
      expect(await invoke({ options: { orderBy: [{ field: 'title' }, { field: 'routeId' }, { field: 'seq' }, { field: 'status' }] } }))
        .toMatchObject({ ok: false, error: { code: 'INVALID_FILTER' } })
      expect(await invoke({ options: { limit: 0 } })).toMatchObject({ ok: false, error: { code: 'INVALID_FILTER' } })
      expect(await invoke({ filter: { title: { eql: 'beta' } } })).toMatchObject({ ok: false, error: { code: 'INVALID_FILTER' } })
      expect(await invoke({ filter: { title: Array.from({ length: 257 }, () => ({ eq: 'beta' })) } }))
        .toMatchObject({ ok: false, error: { code: 'LIMIT_EXCEEDED' } })
      expect(await invoke({ op: 'insert', record: { id: 'b', title: 'replacement' } })).toMatchObject({ ok: false, error: { code: 'DUPLICATE' } })
      expect(await invoke({ options: { offset: -1 } })).toMatchObject({ ok: false, error: { code: 'INVALID_FILTER' } })
      const range = await invoke({ filter: { createdAt: [{ gte: inserted.data.createdAt }, { lte: inserted.data.createdAt }] } })
      expect(range.data.list.some((record: { id: string }) => record.id === 'b')).toBe(true)
      const nullIgnored = await invoke({ filter: { status: { isNull: false } } })
      expect(nullIgnored.data.list.some((record: { id: string }) => record.id === 'b')).toBe(true)
      const notNullIgnored = await invoke({ filter: { status: { isNotNull: false } } })
      expect(notNullIgnored.data.list.some((record: { id: string }) => record.id === 'b')).toBe(false)
      expect(await invoke({ op: 'update', patch: { title: 'wrong' } })).toMatchObject({ ok: false, error: { code: 'EMPTY_FILTER' } })
      expect(await invoke({ op: 'delete' })).toMatchObject({ ok: false, error: { code: 'EMPTY_FILTER' } })
      expect(await invoke({ op: 'update', filter: { id: { eq: 'b' } }, patch: { createdAt: 'wrong' } }))
        .toMatchObject({ ok: false, error: { code: 'UNKNOWN_FIELD' } })
      expect(await invoke({ op: 'update', filter: { id: { eq: 'missing' } }, patch: { not_declared: 'wrong' } }))
        .toMatchObject({ ok: false, error: { code: 'UNKNOWN_FIELD' } })
      expect(await invoke({ op: 'create', record: { title: 'beta', not_declared: 'wrong' } }))
        .toMatchObject({ ok: false, error: { code: 'UNKNOWN_FIELD' } })
      expect(await invoke({ op: 'create', record: { status: 'new' }, uniqueBy: ['status'] }))
        .toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } })
      expect(await invoke({ op: 'create', record: { title: 'beta' }, uniqueBy: ['not_declared'] }))
        .toMatchObject({ ok: false, error: { code: 'UNKNOWN_FIELD' } })
      expect(await invoke({ op: 'create', record: { title: null }, uniqueBy: ['title'] }))
        .toMatchObject({ ok: false, error: { code: 'INVALID_FILTER' } })
      expect(await invoke({ op: 'create', record: { title: 'beta' }, uniqueBy: ['title', 'title'] }))
        .toMatchObject({ ok: false, error: { code: 'UNKNOWN_FIELD' } })
      expect(await invoke({ op: 'create', record: { title: 'beta' }, uniqueBy: Array.from({ length: 33 }, () => 'title') }))
        .toMatchObject({ ok: false, error: { code: 'LIMIT_EXCEEDED' } })
    } finally {
      runtime.close()
    }
  })

  it('按 pluginId 路由 Handler、隔离 Store，并向多个 Consumer 广播 Event', async () => {
    const fixture = await createFixture()
    const runtime = new CapabilityBackendRuntime(fixture.root, fixture.projects)

    const first = await runtime.invoke({
      pluginId: 'exp_backend_alpha',
      handler: 'items.create',
      input: { title: 'alpha' },
    }, 'alpha-1') as { title: string }
    const second = await runtime.invoke({
      pluginId: 'exp_backend_beta',
      handler: 'items.create',
      input: { title: 'beta' },
    }, 'beta-1') as { title: string }

    expect(first.title).toBe('alpha')
    expect(second.title).toBe('beta')
    const snapshot = runtime.snapshot()
    expect(snapshot.entities['exp_backend_alpha:item_alpha']).toHaveLength(1)
    expect(snapshot.entities['exp_backend_beta:item_beta']).toHaveLength(1)

    expect(await runtime.invoke({ pluginId: 'exp_backend_alpha', handler: 'items.connection' }))
      .toEqual({ endpoint: 'mock://connection' })

    expect(await runtime.dispatchEvent({ type: 'shared.event', data: { value: 'event' } }))
      .toEqual({ results: [{ pluginId: 'exp_backend_alpha', value: 'event' }, { pluginId: 'exp_backend_beta', value: 'event' }] })
    await expect(runtime.invoke({ pluginId: 'missing', handler: 'items.create' }))
      .rejects.toBeInstanceOf(BackendRuntimeError)
    await expect(runtime.dispatchMockEvents()).resolves.toBeUndefined()
  })

  it('指定 pluginId 的 Event 只分发给该后端', async () => {
    const fixture = await createFixture()
    const runtime = new CapabilityBackendRuntime(fixture.root, fixture.projects)

    expect(await runtime.dispatchEvent({ pluginId: 'exp_backend_beta', type: 'shared.event', data: { value: 'event' } }))
      .toEqual({ pluginId: 'exp_backend_beta', value: 'event' })
  })

  it('脚本不能通过宿主回调原型访问 Node process', async () => {
    const fixture = await createFixture()
    const runtime = new CapabilityBackendRuntime(fixture.root, fixture.projects)

    await expect(runtime.invoke({ pluginId: 'exp_backend_alpha', handler: 'items.escape' }))
      .rejects.toBeInstanceOf(BackendRuntimeError)
  })

  it('异步 Handler 的微任务死循环受 VM 超时约束', async () => {
    const fixture = await createFixture()
    const runtime = new CapabilityBackendRuntime(fixture.root, fixture.projects)

    await expect(runtime.invoke({ pluginId: 'exp_backend_alpha', handler: 'items.async' }))
      .rejects.toBeInstanceOf(BackendRuntimeError)
  }, 3_000)

  it('正常异步 Handler 在 VM 内完成并返回结果', async () => {
    const fixture = await createFixture()
    const runtime = new CapabilityBackendRuntime(fixture.root, fixture.projects)

    await expect(runtime.invoke({ pluginId: 'exp_backend_alpha', handler: 'items.async-ok' }))
      .resolves.toEqual({ ok: true })
  })

  it('选择后端子集时跳过指向未加载插件的 mock event', async () => {
    const fixture = await createFixture()
    const runtime = new CapabilityBackendRuntime(fixture.root, [fixture.projects[0]!])

    await expect(runtime.dispatchMockEvents()).resolves.toBeUndefined()
  })

  it.each([
    ['demo-001', 'session:DOCK-7', '340c92a5de6e012cd79e60d3422ec917'],
    ['a:b', 'c', 'f1bb0ca6c7ffab359b80aba12b97054d'],
    ['a', 'b:c', 'f458898b5e7b5d3b5e20ee9b8b2d0af8'],
    ['任务-一', '会话:机场七号', 'b7141866bc4532e4e77c9632a9d5a2f9'],
  ])('stableId 对齐 Worker 固定向量 %s / %s', async (key, scope, expected) => {
    const fixture = await createFixture()
    const runtime = new CapabilityBackendRuntime(fixture.root, fixture.projects)
    try {
      const request = { pluginId: 'exp_backend_alpha', handler: 'items.stable-id', input: { scope } }
      expect(await runtime.invoke(request, key)).toEqual({ id: expected })
      runtime.reset()
      expect(await runtime.invoke(request, key)).toEqual({ id: expected })
    } finally {
      runtime.close()
    }
  })

  it('相同 key/scope 跨插件得到相同 stableId，Store 仍按插件隔离', async () => {
    const fixture = await createFixture()
    const runtime = new CapabilityBackendRuntime(fixture.root, fixture.projects)
    try {
      const request = { handler: 'items.stable-id', input: { scope: 'session:DOCK-7' } }
      const expected = { id: '340c92a5de6e012cd79e60d3422ec917' }
      expect(await runtime.invoke({ ...request, pluginId: 'exp_backend_alpha' }, 'demo-001')).toEqual(expected)
      expect(await runtime.invoke({ ...request, pluginId: 'exp_backend_beta' }, 'demo-001')).toEqual(expected)
      const first = await runtime.invoke({ pluginId: 'exp_backend_alpha', handler: 'items.create', input: { title: 'alpha' } }, 'shared-key')
      const second = await runtime.invoke({ pluginId: 'exp_backend_beta', handler: 'items.create', input: { title: 'beta' } }, 'shared-key')
      expect(first).toMatchObject({ id: (second as { id: string }).id, title: 'alpha' })
      expect(second).toMatchObject({ title: 'beta' })
      expect(runtime.snapshot().entities['exp_backend_alpha:item_alpha']).toHaveLength(1)
      expect(runtime.snapshot().entities['exp_backend_beta:item_beta']).toHaveLength(1)
    } finally {
      runtime.close()
    }
  })

  it('stableId 的空 key 保持原有明确失败与字符串错误码', async () => {
    const fixture = await createFixture()
    const runtime = new CapabilityBackendRuntime(fixture.root, fixture.projects)
    try {
      await expect(runtime.invoke({ pluginId: 'exp_backend_alpha', handler: 'items.stable-id', input: { scope: 'session' } }))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED', status: 400, message: 'stableId 需要 Idempotency-Key。' })
    } finally {
      runtime.close()
    }
  })

  it('真实 Runtime 接入 Gateway 后 stableId 缺 key 返回 HTTP 400 和契约码 40006', async () => {
    const fixture = await createFixture()
    const runtime = new CapabilityBackendRuntime(fixture.root, fixture.projects)
    const gateway = createMockGateway({ backendRuntime: runtime })
    const server = createServer((req, res) => {
      void gateway.handle(req, res, new URL(req.url ?? '/', 'http://local.test'))
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('server address missing')
      const response = await fetch(`http://127.0.0.1:${address.port}/plugin-api/plugin/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-plugin-token': 'mock-plugin-token' },
        body: JSON.stringify({ pluginId: 'exp_backend_alpha', handler: 'items.stable-id', input: { scope: 'session' } }),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        code: 40006,
        message: 'IDEMPOTENCY_KEY_REQUIRED: stableId 需要 Idempotency-Key。',
        data: null,
      })
    } finally {
      await gateway.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

async function createFixture (): Promise<{
  readonly root: string;
  readonly projects: readonly {
    readonly id: string;
    readonly root: string;
    readonly manifestPath: string;
  }[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-capability-runtime-'))
  roots.push(root)
  await mkdir(join(root, 'mock/fixtures'), { recursive: true })
  await mkdir(join(root, 'mock/providers'), { recursive: true })
  await mkdir(join(root, 'mock/events'), { recursive: true })
  await writeFile(join(root, 'mock/fixtures/default.json'), JSON.stringify({ entities: {} }))
  await writeFile(join(root, 'mock/connections.json'), JSON.stringify({ connections: { example: { endpoint: 'mock://connection' } } }))
  await writeFile(join(root, 'mock/providers/default.json'), JSON.stringify({ provider: 'mock' }))
  await writeFile(join(root, 'mock/events/shared.json'), JSON.stringify({ type: 'shared.event', data: { value: 'fixture' } }))
  await writeFile(join(root, 'mock/events/excluded.json'), JSON.stringify({ pluginId: 'exp_backend_beta', type: 'shared.event', data: { value: 'excluded' } }))
  const projects = await Promise.all(['alpha', 'beta'].map(async (suffix) => {
    const pluginId = `exp_backend_${suffix}`
    const entityName = `item_${suffix}`
    const pluginRoot = join(root, 'backend', pluginId)
    const distRoot = join(pluginRoot, 'dist')
    await mkdir(join(distRoot, 'handlers/items'), { recursive: true })
    await mkdir(join(distRoot, 'events'), { recursive: true })
    await writeFile(join(distRoot, 'schema.sql'), `
BEGIN;
CREATE TABLE plugin_db_${entityName} (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  tenant_id TEXT NULL,
  title TEXT NULL,
  route_id TEXT NULL,
  seq TEXT NULL,
  status TEXT NULL
);
CREATE UNIQUE INDEX uniq_${entityName}_title ON plugin_db_${entityName} (title);
CREATE UNIQUE INDEX uniq_${entityName}_route_seq ON plugin_db_${entityName} (route_id, seq);
COMMIT;
`)
    await writeFile(join(distRoot, 'plugin.json'), JSON.stringify({
      pluginId,
      name: pluginId,
      version: '0.1.0',
      allowlist: ['data:read', 'data:write'],
      entities: [{
        name: entityName,
        fields: {
          title: { type: 'string' },
          routeId: { type: 'string' },
          seq: { type: 'string' },
          status: { type: 'string' },
        },
      }],
      events: [{
        type: 'shared.event',
        consumer: [{ handler: 'events/shared.js', entry: 'onSharedEvent' }],
      }],
    }))
    await writeFile(join(distRoot, 'handlers/items/create.js'), `
function handle(input, ctx) {
  var store = ctx.hostCapability('data-store')
  var result = store.put('${entityName}', { id: ctx.stableId('item'), title: String(input.title || '') }, { upsert: false })
  if (!result.ok) throw result.error
  return result.data
}
`)
    await writeFile(join(distRoot, 'handlers/items/connection.js'), `
function handle(_input, ctx) {
  return ctx.hostCapability('connection').get('example')
}
`)
    await writeFile(join(distRoot, 'handlers/items/stable-id.js'), `
function handle(input, ctx) {
  return { id: ctx.stableId(input.scope) }
}
`)
    await writeFile(join(distRoot, 'handlers/items/escape.js'), `
function handle(_input, ctx) {
  return ctx.stableId.constructor.constructor('return process')().cwd()
}
`)
    await writeFile(join(distRoot, 'handlers/items/async.js'), `
async function handle() {
  await Promise.resolve()
  while (true) {}
}
`)
    await writeFile(join(distRoot, 'handlers/items/async-ok.js'), `
async function handle() {
  await Promise.resolve()
  return { ok: true }
}
`)
    await writeFile(join(distRoot, 'events/shared.js'), `
function onSharedEvent(event) {
  return { pluginId: '${pluginId}', value: String(event.data.value || '') }
}
`)
    return { id: pluginId, root: pluginRoot, manifestPath: join(pluginRoot, 'fh2-plugin.json') }
  }))
  return { root, projects }
}
