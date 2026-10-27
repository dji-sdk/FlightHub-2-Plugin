// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { generatePluginTypes } from './plugin-types.js'

/**
 * 生成器②(ambient 分世界)的门禁测试族。
 *
 * fixture 是 official_traffic_capture_backend 的精缩版,覆盖 spec 附录 A 的
 * 全部世界形态:
 *   shared/store.js(三根可达 → 交集)
 *   shared/illegal-road.js(用 notify,只被 handler/event 可达)
 *   handlers/**(call 世界) / adapters/**(adapter 世界)
 * 以及 spec A4 的负向红线(handler 无 video、shared 交集无 notify/flow)。
 */

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rmSync(root, { recursive: true, force: true })))
})

describe('plugin-types 生成器②', () => {
  it('世界计算:三根交集 / call 世界 / adapter 世界(traffic_capture 形态)', () => {
    const root = createFixture()
    const result = generatePluginTypes(root)

    const world = (file: string): readonly string[] => result.worlds.get(file) ?? []

    // 1.2.0 三种形态的能力注入面一致，shared/store.ts 保留插件已申报的完整交集。
    expect(world('shared/store.ts')).toEqual(['flow', 'log', 'media', 'notify', 'objectTrack', 'store', 'video'])

    // shared/illegal-road.ts:只被 handler/event 可达，当前也得到同一注入面。
    expect(world('shared/illegal-road.ts')).toEqual(['flow', 'log', 'media', 'notify', 'objectTrack', 'store', 'video'])

    // handlers/lane-change/start-mode.ts:call 世界按 1.2.0 契约包含已申报能力。
    const handlerWorld = world('handlers/lane-change/start-mode.ts')
    expect(handlerWorld).toContain('flow')
    expect(handlerWorld).toContain('notify')
    expect(handlerWorld).toContain('video')
    expect(handlerWorld).toContain('objectTrack')

    // adapters/lane-change-postprocess.ts:adapter 世界同样按 allowlist 注入。
    const adapterWorld = world('adapters/lane-change-postprocess.ts')
    expect(adapterWorld).toContain('video')
    expect(adapterWorld).toContain('objectTrack')
    expect(adapterWorld).toContain('flow')
    expect(adapterWorld).toContain('notify')

    // 事件世界:与 handler 同面(本例)。
    expect(world('events/media-video-created.ts')).toContain('flow')

    // 声明文件落盘形态:ambient(import() 内联、顶层无 import 语句)。
    const call = result.files.get('handler.d.ts')!
    expect(call).toContain('declare const store: import(\'fh2-plugin-sdk/backend\').StoreApi')
    expect(call).toContain('declare const ctx: import(\'fh2-plugin-sdk/backend\').HandlerCtx')
    expect(call).toContain('declare const video')
    expect(call).toContain('declare const objectTrack')

    const adapter = result.files.get('adapter.d.ts')!
    expect(adapter).toContain('declare const video: import(\'fh2-plugin-sdk/backend\').VideoApi')
    expect(adapter).toContain('declare const flow')
    expect(adapter).toContain('declare const notify')

    // schema.sql 与 manifest.entities 不再投影为插件 TypeScript 类型或 runtime facade。
    expect(result.files.has('entities.d.ts')).toBe(false)
    expect(result.files.has('storage.ts')).toBe(false)

    // shared-all 世界文件:三种形态当前同面，保留完整 allowlist 交集。
    const sharedAll = result.files.get('shared-all.d.ts')
    if (sharedAll !== undefined) {
      expect(sharedAll).toContain('declare const flow')
      expect(sharedAll).toContain('declare const video')
      expect(sharedAll).toContain('declare const store')
    }
  })

  it('allowlist 收窄:未申报 data:read 的插件没有 store', () => {
    const root = createFixture({ allowlist: ['media:read'] })
    const result = generatePluginTypes(root)
    const handler = result.files.get('handler.d.ts')!
    expect(handler).toContain('declare const media')
    expect(handler).not.toContain('declare const store')
    expect(handler).not.toContain('declare const flow')

    // 方法粒度:只申报 data:read 时,store 世界只有 query/count。
    const root2 = createFixture({ allowlist: ['data:read'] })
    const result2 = generatePluginTypes(root2)
    // worlds 记录的是全局名;方法粒度体现在 ambient 里(类型上方法集由 SDK 接口保证,
    // ambient 只声明 store 存在 —— 方法粒度的收窄在 v2 的 per-method ambient 落地,
    // 这里验证生成不炸且 store 在)。
    expect(result2.files.get('handler.d.ts')).toContain('declare const store')
  })

  it('确定性:同一插件两次生成字节一致', () => {
    const root = createFixture()
    const first = generatePluginTypes(root)
    const second = generatePluginTypes(root)
    expect([...first.files.keys()].sort()).toEqual([...second.files.keys()].sort())
    for (const [file, source] of first.files) {
      expect(second.files.get(file)).toBe(source)
    }
  })

  it('schema.sql 变化不会改变 Host 注入面声明', () => {
    const root = createFixture()
    const before = generatePluginTypes(root)
    writeFileSync(join(root, 'schema.sql'), `CREATE TABLE plugin_db_from_schema (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  schema_title TEXT NOT NULL,
  happened_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
`)

    const after = generatePluginTypes(root)
    expect([...after.files]).toEqual([...before.files])
  })

  it('真实插件目录:official_traffic_capture_backend 生成成功', () => {
    const root = fileURLToPath(new URL('../../../../fh2-traffic-capabilities/official_capture/backend/official_traffic_capture_backend/', import.meta.url))
    expect(existsSync(join(root, 'fh2-plugin.json'))).toBe(true)
    const result = generatePluginTypes(root)
    expect(result.files.has('entities.d.ts')).toBe(false)
    expect(result.worlds.get('adapters/lane-change-postprocess.ts')).toContain('video')
  })
})

// ── fixture ──────────────────────────────────────────────────────────────────

function createFixture (overrides?: { readonly allowlist?: readonly string[] }): string {
  const root = mkdtempSync(join(tmpdir(), 'fh2-plugin-types-'))
  roots.push(root)
  for (const dir of ['handlers/lane-change', 'handlers/illegal-road', 'events', 'adapters', 'shared']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  const manifest = {
    pluginId: 'fixture_plugin',
    name: 'fixture',
    version: '0.1.0',
    contractsRange: '>=1.1.0 <2.0.0',
    allowlist: overrides?.allowlist ?? ['data:read', 'data:write', 'media:read', 'media:write', 'flow:start', 'track:read', 'video:process', 'notify:publish'],
    entities: [
      { name: 'lane_change_mode', fields: { mode_key: { type: 'string', unique: true }, project_id: { type: 'string' } } },
    ],
    scripts: [{ name: 'postprocess', path: 'adapters/lane-change-postprocess.js', entry: 'handle' }],
    events: [{ type: 'media.video_created', consumer: [{ handler: 'events/media-video-created.js', entry: 'onVideoCreated' }] }],
  }
  writeFileSync(join(root, 'fh2-plugin.json'), JSON.stringify(manifest, null, 2))

  writeFileSync(join(root, 'shared/store.ts'), `export function dbQuery (entity: string) { return store.query(entity, {}) }\n`)
  writeFileSync(join(root, 'shared/illegal-road.ts'), `import { dbQuery } from './store'\nexport function f () { notify.publish({}); return dbQuery('x') }\n`)
  writeFileSync(join(root, 'handlers/lane-change/start-mode.ts'), `import { dbQuery } from '../../shared/store'\nexport function startMode (input: unknown, ctx: unknown) { return dbQuery('x') }\n`)
  writeFileSync(join(root, 'handlers/illegal-road/get-status.ts'), `import { f } from '../../shared/illegal-road'\nexport function getStatus () { return f() }\n`)
  writeFileSync(join(root, 'events/media-video-created.ts'), `import { dbQuery } from '../shared/store'\nexport function onVideoCreated () { return dbQuery('x') }\n`)
  writeFileSync(join(root, 'adapters/lane-change-postprocess.ts'), `import { dbQuery } from '../shared/store'\nexport function handle () { video.probe({ fileId: 'f', objectKey: 'k' }); return dbQuery('x') }\n`)
  return root
}
