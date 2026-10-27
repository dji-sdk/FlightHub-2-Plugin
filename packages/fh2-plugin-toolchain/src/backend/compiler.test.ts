// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginBuildError } from '../build/types.js'
import { compileBackendPlugin, extractHandlerExports } from './compiler.js'
import { validateBackendSourcePlugin } from './source-contract.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('extractHandlerExports', () => {
  it('提取 export function h_*', () => {
    const source = [
      'import { db } from "../shared/db.js"',
      'export function h_get(input) { return db(input) }',
      'function helper() { return 1 }',
    ].join('\n')
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual(['h_get'])
    expect(result.other).toEqual([])
  })

  it('提取 export { h_x } 语法', () => {
    const source = 'function h_a() {}\nfunction h_b() {}\nexport { h_a, h_b }'
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual(['h_a', 'h_b'])
    expect(result.other).toEqual([])
  })

  it('忽略非 h_ 前缀导出（归入 other）', () => {
    const source = 'export function normal() {}\nexport function h_ok() {}'
    const result = extractHandlerExports(source)
    expect(result.hPrefixed).toEqual(['h_ok'])
    expect(result.other).toEqual(['normal'])
  })
})

describe('compileBackendPlugin', () => {
  it('完整 Bundle：handlers + events + adapter 生成三份产物和 Runtime Manifest', async () => {
    const root = await createEsmFixture()
    const source = validateBackendSourcePlugin(root)
    expect(source.ok).toBe(true)

    const candidate = join(root, '.dist-next')
    await mkdir(candidate, { recursive: true })
    const result = await compileBackendPlugin({
      pluginRoot: root,
      candidateRoot: candidate,
      source,
    })

    // 三份 Bundle 均产出。
    expect(existsSync(join(candidate, 'scripts/handlers.js'))).toBe(true)
    expect(existsSync(join(candidate, 'scripts/events.js'))).toBe(true)
    expect(existsSync(join(candidate, 'scripts/adapter.js'))).toBe(true)

    // Bundle 内容无 import/export/require。
    const handlersJs = await readFile(join(candidate, 'scripts/handlers.js'), 'utf8')
    expect(handlersJs).not.toMatch(/\bimport\s/)
    expect(handlersJs).not.toMatch(/\bexport\s/)
    expect(handlersJs).not.toMatch(/\brequire\s*\(/)

    // 顶层 h_ Wrapper 在 IIFE 之前。
    const wrapperIndex = handlersJs.indexOf('function h_getEvent(')
    const iifeIndex = handlersJs.indexOf('var __fh2_handlers')
    expect(wrapperIndex).toBeGreaterThan(-1)
    expect(iifeIndex).toBeGreaterThan(wrapperIndex)

    // Wrapper 使用 detached call。
    expect(handlersJs).toContain('(0, __fh2_handlers.h_getEvent)(input, ctx)')

    // 不注入 "use strict"。
    expect(handlersJs.startsWith('"use strict"')).toBe(false)

    // Runtime Manifest 改写正确。
    const runtimeManifest = result.runtimeManifest as Record<string, unknown>
    const events = runtimeManifest.events as Array<Record<string, unknown>>
    expect(events[0]!.consumer).toEqual([
      { handler: 'scripts/events.js', entry: 'fh2_event_0_0' },
    ])

    const scripts = runtimeManifest.scripts as Array<Record<string, unknown>>
    expect(scripts[0]!.path).toBe('scripts/adapter.js')
    // DAG-020-03：runtime entry 沿用源声明的入口名（包根可解析）；冲突才退序号
    expect(scripts[0]!.entry).toBe('handle')
    // io 字段保留（值级改写，不重建）。
    expect(scripts[0]!.io).toBeDefined()

    // entry mappings。
    expect(result.entryMappings).toContainEqual({
      kind: 'handler',
      sourcePath: 'handlers/lane-change/get-event.js',
      sourceEntry: 'h_getEvent',
      runtimePath: 'scripts/handlers.js',
      runtimeEntry: 'h_getEvent',
    })

    // 资产摘要存在。
    expect(result.assets.length).toBe(3)
    for (const asset of result.assets) {
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(asset.bytes).toBeGreaterThan(0)
    }

    // shared helper 只被包含一次。
    const dbQueryCount = handlersJs.split('function dbQuery').length - 1
    expect(dbQueryCount).toBe(1)
  })

  it('以 source 的 schema.sql 有效 manifest 为基础写入 runtime manifest', async () => {
    const root = await createEsmFixture()
    await useSchemaEntities(root)
    const source = validateBackendSourcePlugin(root)
    expect(source.ok, source.ok ? '' : source.diagnostics.map(diagnostic => diagnostic.message).join('; ')).toBe(true)
    expect(source.generatedEntities).toBe(true)

    const candidate = join(root, '.dist-next')
    await mkdir(candidate, { recursive: true })
    const result = await compileBackendPlugin({
      pluginRoot: root,
      candidateRoot: candidate,
      source,
    })

    expect((result.runtimeManifest as Record<string, unknown>).entities).toEqual([
      {
        name: 'schema_record',
        fields: {
          record_key: { type: 'string', unique: true },
          happened_at: { type: 'datetime', indexed: true },
        },
      },
    ])
    expect(result.watchDependencies).toContain(join(root, 'schema.sql'))
  })

  it('标准写法：不带 h_ 的 export 按目录生成稳定 h_ Wrapper', async () => {
    const root = await createAutoModeFixture()
    const source = validateBackendSourcePlugin(root)
    expect(source.ok).toBe(true)

    const candidate = join(root, '.dist-next')
    await mkdir(candidate, { recursive: true })
    const result = await compileBackendPlugin({
      pluginRoot: root,
      candidateRoot: candidate,
      source,
    })

    const handlersJs = await readFile(join(candidate, 'scripts/handlers.js'), 'utf8')

    // 无 import/export/require。
    expect(handlersJs).not.toMatch(/\bimport\s/)
    expect(handlersJs).not.toMatch(/\bexport\s/)
    expect(handlersJs).not.toMatch(/\brequire\s*\(/)

    // 普通 export 生成旧 Worker 也认得出的稳定 h_ Wrapper。
    expect(handlersJs).toContain('function h_laneChange_getEvent(')
    expect(handlersJs).toContain('function h_laneChange_listEvents(')
    expect(handlersJs).toContain('function h_laneChange_createEvent(')
    expect(handlersJs).not.toContain('function fh2_handler_')

    // Wrapper 转发到 IIFE 内部。
    expect(handlersJs).toContain('(0, __fh2_handlers.h_laneChange_getEvent)(input, ctx)')

    // entry mapping 记录 sourceExport 和 runtimeEntry 的对应。
    const handlerMappings = result.entryMappings.filter(m => m.kind === 'handler')
    expect(handlerMappings.length).toBe(3)
    const getEventMapping = handlerMappings.find(m => m.sourceEntry === 'getEvent')
    expect(getEventMapping).toBeDefined()
    expect(getEventMapping!.runtimeEntry).toBe('h_laneChange_getEvent')
  })

  it('混合模式：h_ 保留原名 + 普通 export 按目录派生', async () => {
    const root = await createMixedModeFixture()
    const source = validateBackendSourcePlugin(root)
    expect(source.ok).toBe(true)

    const candidate = join(root, '.dist-next')
    await mkdir(candidate, { recursive: true })
    const result = await compileBackendPlugin({
      pluginRoot: root,
      candidateRoot: candidate,
      source,
    })

    const handlersJs = await readFile(join(candidate, 'scripts/handlers.js'), 'utf8')

    // h_ 模式的保留原名。
    expect(handlersJs).toContain('function h_legacyEvent(')
    // 普通 export 的目录派生名。
    expect(handlersJs).toContain('function h_newStyle_getEvent(')

    // 两种 Wrapper 都在 IIFE 之前。
    const legacyWrapper = handlersJs.indexOf('function h_legacyEvent(')
    const derivedWrapper = handlersJs.indexOf('function h_newStyle_getEvent(')
    const iife = handlersJs.indexOf('var __fh2_handlers')
    expect(legacyWrapper).toBeGreaterThan(-1)
    expect(derivedWrapper).toBeGreaterThan(-1)
    expect(iife).toBeGreaterThan(legacyWrapper)
    expect(iife).toBeGreaterThan(derivedWrapper)

    // entry mapping 包含历史与目录派生两种入口。
    const handlerMappings = result.entryMappings.filter(m => m.kind === 'handler')
    expect(handlerMappings.some(m => m.runtimeEntry === 'h_legacyEvent')).toBe(true)
    expect(handlerMappings.some(m => m.runtimeEntry === 'h_newStyle_getEvent')).toBe(true)
  })

  it('同一源码文件的多个 export 分别生成稳定入口', async () => {
    const root = await createEsmFixture({
      handlerOverrides: {
        'handlers/lane-change/get-event.js': [
          'export function startMode() { return { action: "start" } }',
          'export function stopMode() { return { action: "stop" } }',
        ].join('\n'),
      },
    })
    const source = validateBackendSourcePlugin(root)
    expect(source.ok).toBe(true)
    const candidate = join(root, '.dist-next')
    await mkdir(candidate, { recursive: true })
    await compileBackendPlugin({ pluginRoot: root, candidateRoot: candidate, source })

    const handlersJs = await readFile(join(candidate, 'scripts/handlers.js'), 'utf8')
    expect(handlersJs).toContain('function h_laneChange_startMode(')
    expect(handlersJs).toContain('function h_laneChange_stopMode(')
  })

  it('export const 箭头函数也能成为 Handler', async () => {
    const root = await createEsmFixture({
      handlerOverrides: {
        'handlers/lane-change/get-event.js': [
          'import { dbQuery } from "../../shared/db.js"',
          '',
          'export const h_getEvent = (input) => {',
          '  return dbQuery("lane_change_event", { id: { eq: input.event_id } })',
          '}',
        ].join('\n'),
      },
    })
    const source = validateBackendSourcePlugin(root)
    expect(source.ok).toBe(true)

    const candidate = join(root, '.dist-next')
    await mkdir(candidate, { recursive: true })
    await compileBackendPlugin({ pluginRoot: root, candidateRoot: candidate, source })

    const handlersJs = await readFile(join(candidate, 'scripts/handlers.js'), 'utf8')
    expect(handlersJs).toContain('function h_getEvent(input, ctx)')
    expect(handlersJs).not.toMatch(/\bimport\s/)
    expect(handlersJs).not.toMatch(/\bexport\s/)
  })

  it('export { xxx as h_yyy } alias 也能成为 Handler', async () => {
    const root = await createEsmFixture({
      handlerOverrides: {
        'handlers/lane-change/get-event.js': [
          'import { dbQuery } from "../../shared/db.js"',
          '',
          'function fetchEvent(input) {',
          '  return dbQuery("lane_change_event", { id: { eq: input.event_id } })',
          '}',
          '',
          'export { fetchEvent as h_getEvent }',
        ].join('\n'),
      },
    })
    const source = validateBackendSourcePlugin(root)
    expect(source.ok).toBe(true)

    const candidate = join(root, '.dist-next')
    await mkdir(candidate, { recursive: true })
    await compileBackendPlugin({ pluginRoot: root, candidateRoot: candidate, source })

    const handlersJs = await readFile(join(candidate, 'scripts/handlers.js'), 'utf8')
    expect(handlersJs).toContain('function h_getEvent(input, ctx)')
  })

  it('无 handlers 时仍可只打 events/adapter', async () => {
    const root = await createEsmFixture({ skipHandlers: true })
    const source = validateBackendSourcePlugin(root)
    expect(source.ok).toBe(true)

    const candidate = join(root, '.dist-next')
    await mkdir(candidate, { recursive: true })
    const result = await compileBackendPlugin({
      pluginRoot: root,
      candidateRoot: candidate,
      source,
    })
    expect(existsSync(join(candidate, 'scripts/handlers.js'))).toBe(false)
    expect(existsSync(join(candidate, 'scripts/events.js'))).toBe(true)
    expect(result.assets.length).toBe(2)
  })

  it('两个 Handler 引用同一 shared helper 时 Bundle 内只有一份实现', async () => {
    const root = await createEsmFixture()
    const source = validateBackendSourcePlugin(root)
    const candidate = join(root, '.dist-next')
    await mkdir(candidate, { recursive: true })
    await compileBackendPlugin({ pluginRoot: root, candidateRoot: candidate, source })

    const handlersJs = await readFile(join(candidate, 'scripts/handlers.js'), 'utf8')
    // requireText 在 shared/validation.js 中定义一次，被两个 Handler import。
    const requireTextCount = handlersJs.split('function requireText').length - 1
    expect(requireTextCount).toBe(1)
  })

  it('esbuild 拒绝裸 npm import（构建失败）', async () => {
    const root = await createEsmFixture({
      handlerOverrides: {
        'handlers/lane-change/get-event.js':
          'import _ from "lodash"\nexport function h_getEvent(input) { return _ }\n',
      },
    })
    const source = validateBackendSourcePlugin(root)
    // Source 层已拦截裸 import。
    expect(source.ok).toBe(false)
    expect(source.diagnostics.some(d => d.code === 'FH2_BACKEND_BARE_IMPORT_FORBIDDEN')).toBe(true)
  })

  it('esbuild 模块策略同源拒绝 Node 内置 import（消费 SOURCE_BUILD_RULES 的唯一清单）', async () => {
    const root = await createEsmFixture()
    const source = await validateBackendSourcePlugin(root)
    expect(source.ok).toBe(true)
    // Source 静态层已通过后再注入 node:fs，验证 Bundler 防线同样拒绝：
    // compiler 的 Node 内置清单必须来自 source-build-rules（不允许第二份硬编码）。
    await writeFile(
      join(root, 'handlers/lane-change/get-event.js'),
      'import { readFile } from "node:fs"\nexport function h_getEvent(input) { return readFile }\n',
    )
    const candidate = join(root, '.dist-next')
    await mkdir(candidate, { recursive: true })
    const failure = await compileBackendPlugin({ pluginRoot: root, candidateRoot: candidate, source }).catch(error => error)
    expect(failure).toBeInstanceOf(PluginBuildError)
    expect(failure.diagnostics.some((d: { code: string }) => d.code === 'FH2_BACKEND_NODE_IMPORT_FORBIDDEN')).toBe(true)
  })

  it('确定性：同一输入连续构建两次产生相同摘要', async () => {
    const root = await createEsmFixture()
    const source = validateBackendSourcePlugin(root)

    const candidate1 = join(root, '.dist-1')
    const candidate2 = join(root, '.dist-2')
    await mkdir(candidate1, { recursive: true })
    await mkdir(candidate2, { recursive: true })

    const result1 = await compileBackendPlugin({ pluginRoot: root, candidateRoot: candidate1, source })
    const result2 = await compileBackendPlugin({ pluginRoot: root, candidateRoot: candidate2, source })

    expect(result1.assets.map(a => a.sha256)).toEqual(result2.assets.map(a => a.sha256))
    expect(JSON.stringify(result1.runtimeManifest)).toBe(JSON.stringify(result2.runtimeManifest))
  })

  it('bundle 中的正则字面量花括号不干扰 Wrapper 顶层识别', async () => {
    const root = await createEsmFixture({
      sharedOverrides: {
        'shared/regex.js': 'export const pattern = /a{2,3}/g\n',
      },
      handlerOverrides: {
        'handlers/lane-change/get-event.js': [
          'import { dbQuery } from "../../shared/db.js"',
          'import { pattern } from "../../shared/regex.js"',
          'export function h_getEvent(input) { return { match: pattern.test("aa"), data: dbQuery(input) } }',
        ].join('\n'),
      },
    })
    const source = validateBackendSourcePlugin(root)
    expect(source.ok).toBe(true)
    const candidate = join(root, '.dist-next')
    await mkdir(candidate, { recursive: true })
    await compileBackendPlugin({ pluginRoot: root, candidateRoot: candidate, source })

    const handlersJs = await readFile(join(candidate, 'scripts/handlers.js'), 'utf8')
    // Wrapper 在 IIFE 之前，IIFE 内正则花括号不影响 Wrapper 的顶层位置。
    expect(handlersJs.indexOf('function h_getEvent(')).toBeLessThan(handlersJs.indexOf('var __fh2_handlers'))
  })
})

// ─── Fixture ─────────────────────────────────────────────────────────

interface FixtureOptions {
  readonly skipHandlers?: boolean;
  readonly handlerOverrides?: Record<string, string>;
  readonly sharedOverrides?: Record<string, string>;
}

async function useSchemaEntities (root: string): Promise<void> {
  const manifestPath = join(root, 'fh2-plugin.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  delete manifest.entities
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  await writeFile(join(root, 'schema.sql'), [
    'CREATE TABLE plugin_db_schema_record (',
    '  id TEXT PRIMARY KEY,',
    '  created_at TIMESTAMPTZ NOT NULL,',
    '  updated_at TIMESTAMPTZ NOT NULL,',
    '  tenant_id TEXT NULL,',
    '  record_key TEXT NOT NULL,',
    '  happened_at TIMESTAMPTZ NULL',
    ');',
    'CREATE UNIQUE INDEX uq_schema_record_key ON plugin_db_schema_record (record_key);',
    'CREATE INDEX ix_schema_record_happened_at ON plugin_db_schema_record (happened_at);',
  ].join('\n'))
}

async function createEsmFixture (options: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-backend-compile-'))
  roots.push(root)

  const defaultHandlers: Record<string, string> = {
    'handlers/lane-change/get-event.js': [
      'import { dbQuery } from "../../shared/db.js"',
      'import { requireText } from "../../shared/validation.js"',
      '',
      'export function h_getEvent(input) {',
      '  const eventId = requireText(input, "event_id")',
      '  return dbQuery("lane_change_event", { id: { eq: eventId } })',
      '}',
    ].join('\n'),
    'handlers/lane-change/list-events.js': [
      'import { dbQuery } from "../../shared/db.js"',
      '',
      'export function h_listEvents(input) {',
      '  return dbQuery("lane_change_event", {}, { limit: 20 })',
      '}',
    ].join('\n'),
  }

  const shared: Record<string, string> = {
    'shared/db.js': [
      'export function dbQuery(entity, filter, options) {',
      '  const result = store.query(entity, filter || {}, options || {})',
      '  if (!result.ok) throw result.error',
      '  return result.data',
      '}',
    ].join('\n'),
    'shared/validation.js': [
      'export function requireText(input, key) {',
      '  const v = String(input[key] === undefined || input[key] === null ? "" : input[key]).trim()',
      '  if (!v) throw { code: "INVALID_ARGUMENT", message: key + " 不能为空" }',
      '  return v',
      '}',
    ].join('\n'),
    ...options.sharedOverrides,
  }

  const files: Record<string, string> = {
    'fh2-plugin.json': JSON.stringify({
      pluginId: 'exp_backend_bundle',
      name: 'Bundle 测试',
      version: '0.1.0',
      contractsRange: '>=1.1.0 <2.0.0',
      scripts: [
        {
          name: 'postprocess',
          path: 'adapters/postprocess.js',
          entry: 'handle',
          io: {
            inputs: [{ name: 'event_id', type: 'string', required: true }],
            outputs: [{ name: 'post_status', type: 'string' }],
          },
        },
      ],
      events: [
        {
          type: 'media.video_created',
          consumer: [{ handler: 'events/on-video.js', entry: 'onVideo' }],
        },
      ],
      entities: [
        { name: 'lane_change_event', fields: { event_key: { type: 'string', unique: true } } },
      ],
      allowlist: ['data:read', 'data:write'],
    }, null, 2),
    'adapters/postprocess.js': [
      'import { dbQuery } from "../shared/db.js"',
      '',
      'export function handle(input) {',
      '  return dbQuery("lane_change_event", { id: { eq: input.event_id } })',
      '}',
    ].join('\n'),
    'events/on-video.js': [
      'import { dbQuery } from "../shared/db.js"',
      '',
      'export function onVideo(input) {',
      '  return { ok: true, data: dbQuery("lane_change_event", {}) }',
      '}',
    ].join('\n'),
    ...shared,
  }

  if (!options.skipHandlers) {
    Object.assign(files, defaultHandlers, options.handlerOverrides)
  }

  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

/** 标准写法 fixture：所有 Handler 都是普通 export。 */
async function createAutoModeFixture (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-auto-mode-'))
  roots.push(root)

  const files: Record<string, string> = {
    'fh2-plugin.json': JSON.stringify({
      pluginId: 'exp_auto_mode',
      name: '目录派生 Handler 测试',
      version: '0.1.0',
      contractsRange: '>=1.1.0 <2.0.0',
      entities: [
        { name: 'lane_change_event', fields: { event_key: { type: 'string', unique: true } } },
      ],
      allowlist: ['data:read'],
    }, null, 2),
    'handlers/lane-change/get-event.js': [
      'import { dbQuery } from "../../shared/db.js"',
      '',
      'export function getEvent(input) {',
      '  return dbQuery("lane_change_event", { id: { eq: input.event_id } })',
      '}',
    ].join('\n'),
    'handlers/lane-change/list-events.js': [
      'import { dbQuery } from "../../shared/db.js"',
      '',
      'export function listEvents(input) {',
      '  return dbQuery("lane_change_event", {}, { limit: 20 })',
      '}',
    ].join('\n'),
    'handlers/lane-change/create-event.js': [
      'import { dbQuery } from "../../shared/db.js"',
      '',
      'export function createEvent(input) {',
      '  return dbQuery("lane_change_event", { event_key: { eq: input.event_key } })',
      '}',
    ].join('\n'),
    'shared/db.js': [
      'export function dbQuery(entity, filter, options) {',
      '  const result = store.query(entity, filter || {}, options || {})',
      '  if (!result.ok) throw result.error',
      '  return result.data',
      '}',
    ].join('\n'),
  }

  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

/** 混合模式 fixture：部分 h_ 前缀 + 部分无前缀。 */
async function createMixedModeFixture (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-mixed-mode-'))
  roots.push(root)

  const files: Record<string, string> = {
    'fh2-plugin.json': JSON.stringify({
      pluginId: 'exp_mixed_mode',
      name: '混合模式测试',
      version: '0.1.0',
      contractsRange: '>=1.1.0 <2.0.0',
      entities: [
        { name: 'lane_change_event', fields: { event_key: { type: 'string', unique: true } } },
      ],
      allowlist: ['data:read'],
    }, null, 2),
    'handlers/legacy/old-style.js': [
      'import { dbQuery } from "../../shared/db.js"',
      '',
      'export function h_legacyEvent(input) {',
      '  return dbQuery("lane_change_event", {})',
      '}',
    ].join('\n'),
    'handlers/new-style/new-style.js': [
      'import { dbQuery } from "../../shared/db.js"',
      '',
      'export function getEvent(input) {',
      '  return dbQuery("lane_change_event", { id: { eq: input.event_id } })',
      '}',
    ].join('\n'),
    'shared/db.js': [
      'export function dbQuery(entity, filter, options) {',
      '  const result = store.query(entity, filter || {}, options || {})',
      '  if (!result.ok) throw result.error',
      '  return result.data',
      '}',
    ].join('\n'),
  }

  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  return root
}
