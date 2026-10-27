// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { compileBackendPlugin } from './compiler.js'
import { validateBackendSourcePlugin } from './source-contract.js'

/**
 * M4 门禁:TS 源码全链(Source 校验 → esbuild Bundle → manifest 改写)。
 *
 * 覆盖:
 *   入口名派生   handlers/<kebab>/<kebab>.ts + export function camel → h_<camel>_<camel>
 *   类型剥离     bundle 产物零 TS 残留、零模块语法
 *   禁令         async / await → 诊断
 *   manifest     scripts[].path/entry、events[].consumer 值级改写与 JS 版同构
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('tS 源码编译链(M4)', () => {
  it('tS handler 派生稳定 h_ 入口,bundle 无模块语法,manifest 值级改写', async () => {
    const root = createTsPlugin()
    const source = validateBackendSourcePlugin(root)
    expect(source.ok, source.ok ? '' : source.diagnostics.map(d => d.message).join('; ')).toBe(true)

    const result = await compileBackendPlugin({ pluginRoot: root, candidateRoot: join(root, 'dist'), source: source as never })

    const handlerEntries = result.entryMappings.filter(m => m.kind === 'handler')
    expect(handlerEntries.map(e => e.runtimeEntry).sort()).toEqual(['h_demo_create'])

    for (const asset of result.assets) {
      const content = readFileSync(join(root, 'dist', asset.path), 'utf8')
      expect(content).not.toMatch(/\bimport\b|\bexport\b/)
      expect(content).not.toMatch(/\basync\b/)
      expect(content).toContain(`function ${asset.entries[0]}(input, ctx)`)
    }

    const manifest = result.runtimeManifest as Record<string, unknown>
    expect((manifest.scripts as Array<Record<string, string>>)[0]!.path).toBe('scripts/adapter.js')
    // DAG-020-03：runtime entry 沿用源声明的入口名
    expect((manifest.scripts as Array<Record<string, string>>)[0]!.entry).toBe('handle')
    const event = (manifest.events as Array<{ consumer: Array<Record<string, string>> }>)[0]!
    expect(event.consumer[0]!.handler).toBe('scripts/events.js')
    expect(event.consumer[0]!.entry).toBe('fh2_event_0_0')
  })

  it('async 函数被 Source 阶段拒绝', () => {
    const root = createTsPlugin()
    writeFileSync(join(root, 'handlers/demo/create.ts'), 'export async function create (input: unknown) { return input }\n')
    const result = validateBackendSourcePlugin(root)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some(d => d.code === 'FH2_BACKEND_ASYNC_FORBIDDEN')).toBe(true)
  })

  it('enum、namespace 与 decorator 可编译，且只收集函数 Handler 导出', async () => {
    const root = createTsPlugin()
    writeFileSync(join(root, 'handlers/demo/create.ts'), `import type { DemoInput } from '../../shared/helper'
function decorate (_target: unknown) {}
@decorate
class Decorated {}
export enum Status { Ready = 'ready' }
export const enum InternalCode { Ready = 'ready' }
export namespace Metadata { export const prefix = Status.Ready }
export type Result = { title: string }
export interface Request extends DemoInput {}
export const data = { status: Status.Ready } as const
export const arrow = (input: Request): Result => ({ title: input.title })
export const expression = function (input: Request): Result { return { title: input.title } }
export function create (input: Request): Result {
  return { title: new Decorated() ? Metadata.prefix + InternalCode.Ready + input.title : data.status }
}
`)
    const source = validateBackendSourcePlugin(root)
    expect(source.ok, source.ok ? '' : source.diagnostics.map(d => d.message).join('; ')).toBe(true)

    const result = await compileBackendPlugin({ pluginRoot: root, candidateRoot: join(root, 'dist'), source: source as never })
    expect(result.entryMappings.filter(mapping => mapping.kind === 'handler').map(mapping => mapping.runtimeEntry)).toEqual([
      'h_demo_arrow',
      'h_demo_create',
      'h_demo_expression',
    ])

    const handlers = readFileSync(join(root, 'dist/scripts/handlers.js'), 'utf8')
    expect(handlers).not.toContain('function h_demo_data(')
  })

  it('类型语法(type/interface/泛型)不误报为 handler 入口', async () => {
    const root = createTsPlugin()
    writeFileSync(join(root, 'handlers/demo/create.ts'), `import type { DemoInput } from '../../shared/helper'
export type Result = { title: string }
export interface Baz { a: string }
export const Statuses = ['a', 'b'] as const
export function create (input: DemoInput): { title: string } { return { title: String(input.title) } }
`)
    const source = validateBackendSourcePlugin(root)
    expect(source.ok, source.ok ? '' : source.diagnostics.map(d => d.message).join('; ')).toBe(true)
    const result = await compileBackendPlugin({ pluginRoot: root, candidateRoot: join(root, 'dist'), source: source as never })
    expect(result.entryMappings.filter(m => m.kind === 'handler').map(e => e.runtimeEntry)).toEqual(['h_demo_create'])
  })
})

function createTsPlugin (): string {
  const root = mkdtempSync(join(tmpdir(), 'fh2-ts-compile-'))
  roots.push(root)
  for (const dir of ['handlers/demo', 'shared', 'adapters', 'events']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  writeFileSync(join(root, 'fh2-plugin.json'), JSON.stringify({
    pluginId: 'ts_smoke',
    name: 'TS 冒烟',
    version: '0.1.0',
    contractsRange: '>=1.1.0 <2.0.0',
    allowlist: ['data:read'],
    entities: [{ name: 'demo_record', fields: { title: { type: 'string' } } }],
    scripts: [{ name: 'demo-adapter', path: 'adapters/demo.ts', entry: 'handle' }],
    events: [{ type: 'demo.created', consumer: [{ handler: 'events/on-created.ts', entry: 'onCreated' }] }],
  }))
  writeFileSync(join(root, 'shared/helper.ts'), `export interface DemoInput { title: string }
export function requireTitle (input: DemoInput): string { return String(input.title ?? '').trim() }
`)
  writeFileSync(join(root, 'handlers/demo/create.ts'), `import { requireTitle } from '../../shared/helper'
import type { DemoInput } from '../../shared/helper'
export function create (input: DemoInput): { title: string } { return { title: requireTitle(input) } }
`)
  writeFileSync(join(root, 'events/on-created.ts'), `import { requireTitle } from '../shared/helper'
export function onCreated (input: { title: string }): string { return requireTitle(input) }
`)
  writeFileSync(join(root, 'adapters/demo.ts'), `import { requireTitle } from '../shared/helper'
export function handle (input: { title: string }): string { return requireTitle(input) }
`)
  return root
}
