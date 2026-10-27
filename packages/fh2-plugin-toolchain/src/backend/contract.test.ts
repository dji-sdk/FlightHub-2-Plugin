// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateBackendPlugin } from './contract.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// fixtures 是 Toolchain 自己的校验测试输入（不是 Worker 契约事实）。
const fixturesRoot = join(packageRoot, 'src/backend/__fixtures__')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('worker backend contract', () => {
  it('接受完整的源码形态并发现两层 Handler', () => {
    const result = validateBackendPlugin(join(fixturesRoot, 'valid/full-plugin'))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.manifest.pluginId).toBe('exp_contract_backend')
      expect(result.manifest.entities?.[0]?.fields.title).toMatchObject({ type: 'string' })
    }
  })

  it('接受 Worker 的打包后 scripts 资产和脚本兜底', () => {
    const result = validateBackendPlugin(join(fixturesRoot, 'valid/packed-plugin'))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.runtimeKeys.scripts).toEqual(['packed-adapter'])
      expect(result.runtimeKeys.flows).toEqual(['packed-flow'])
    }
  })

  it.each([
    ['legacy-handlers', 'handlers'],
    ['entity-fields-array', 'fields'],
    ['event-single-handler', 'consumer'],
    ['workflow-without-trigger', 'trigger'],
    ['trigger-description-only', 'api'],
  ])('拒绝 %s fixture', (fixture, expected) => {
    const result = validateBackendPlugin(join(fixturesRoot, 'invalid', fixture))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.map(item => item.message).join('\n')).toContain(expected)
  })

  it('拒绝指向插件根外的 JavaScript 符号链接', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'fh2-backend-contract-'))
    roots.push(parent)
    const pluginRoot = join(parent, 'plugin')
    const outsideFile = join(parent, 'outside.js')
    await mkdir(join(pluginRoot, 'adapters'), { recursive: true })
    await writeFile(outsideFile, 'function handle() { return {} }\n')
    await symlink(outsideFile, join(pluginRoot, 'adapters/escape.js'))
    await writeFile(join(pluginRoot, 'plugin.json'), JSON.stringify({
      pluginId: 'exp_symlink_backend',
      name: '符号链接测试',
      version: '0.1.0',
      scripts: [{ name: 'escape', path: 'adapters/escape.js', entry: 'handle' }],
    }))

    const result = validateBackendPlugin(pluginRoot)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.map(item => item.message).join('\n')).toContain('路径不安全')
  })

  it('校验 Worker 的重复和规模限制', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-backend-contract-'))
    roots.push(root)
    await writeFile(join(root, 'plugin.json'), JSON.stringify({
      pluginId: 'exp_limits_backend',
      name: '限制测试',
      version: '0.1.0',
      eventStatuses: ['pending', 'pending'],
      connections: [{
        id: 'example',
        requires: [
          { name: 'token', type: 'string' },
          { name: 'token', type: 'string' },
        ],
      }],
      entities: Array.from({ length: 33 }, (_, index) => ({
        name: `entity_${index}`,
        fields: { value: { type: 'string' } },
      })),
    }))

    const result = validateBackendPlugin(root)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      const output = result.diagnostics.map(item => item.message).join('\n')
      expect(output).toContain('eventStatuses 重复')
      expect(output).toContain('requires.name 重复')
      expect(output).toContain('entities 最多声明 32 个')
    }
  })

  it('拒绝空 stream、空白脚本键和未引用的下划线资产', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-backend-contract-'))
    roots.push(root)
    await mkdir(join(root, 'workflows'), { recursive: true })
    await mkdir(join(root, 'adapters'), { recursive: true })
    await writeFile(join(root, 'plugin.json'), JSON.stringify({
      pluginId: 'exp_worker_rules',
      name: 'Worker 规则测试',
      version: '0.1.0',
      flows: ['workflows/stream.json'],
      scripts: [
        { name: 'same', path: 'adapters/one.js', entry: 'handle' },
        { name: ' same', path: 'adapters/two.js', entry: 'handle' },
      ],
    }))
    await writeFile(join(root, 'workflows/stream.json'), JSON.stringify({
      name: 'stream-flow',
      trigger: { stream: {} },
      steps: [],
    }))
    await writeFile(join(root, 'adapters/one.js'), 'function handle() { return {} }\n')
    await writeFile(join(root, 'adapters/two.js'), 'function handle() { return {} }\n')
    await writeFile(join(root, '_unreferenced.js'), 'function ignored() {}\n')

    const result = validateBackendPlugin(root)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      const output = result.diagnostics.map(item => item.message).join('\n')
      expect(output).toContain('match')
      expect(output).toContain('scripts 的寻址名重复')
      expect(output).toContain('以 _ 开头')
    }
  })

  it('拒绝不在全局对象上的 JavaScript 入口', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-backend-contract-'))
    roots.push(root)
    await mkdir(join(root, 'adapters'), { recursive: true })
    await writeFile(join(root, 'plugin.json'), JSON.stringify({
      pluginId: 'exp_nested_entry',
      name: '入口测试',
      version: '0.1.0',
      scripts: [{ name: 'nested', path: 'adapters/nested.js', entry: 'handle' }],
    }))
    await writeFile(join(root, 'adapters/nested.js'), 'function wrapper() { function handle() { return {} } }\n')

    const result = validateBackendPlugin(root)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.map(item => item.message).join('\n')).toContain('未声明入口函数 handle')
  })

  it('拒绝 Worker 严格解码不接受的 when 形状', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-backend-contract-'))
    roots.push(root)
    await mkdir(join(root, 'workflows'), { recursive: true })
    await writeFile(join(root, 'plugin.json'), JSON.stringify({
      pluginId: 'exp_invalid_when',
      name: '条件测试',
      version: '0.1.0',
      flows: ['workflows/invalid-when.json'],
    }))
    await writeFile(join(root, 'workflows/invalid-when.json'), JSON.stringify({
      name: 'invalid-when',
      trigger: { api: {} },
      steps: [{ id: 'noop', action: 'noop', when: { typo: true } }],
    }))

    const result = validateBackendPlugin(root)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.map(item => item.message).join('\n')).toContain('additional properties')
  })

  it('打包后资产只接受 Worker 可发现的顶层 function 入口', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-backend-contract-'))
    roots.push(root)
    await mkdir(join(root, 'scripts'), { recursive: true })
    await writeFile(join(root, 'plugin.json'), JSON.stringify({
      pluginId: 'exp_packed_var_entry',
      name: '打包入口测试',
      version: '0.1.0',
      events: [{
        type: 'example.event',
        consumer: [{ handler: 'events/missing.js', entry: 'onExampleEvent' }],
      }],
    }))
    await writeFile(join(root, 'scripts/events.js'), 'var onExampleEvent = function () { return {} }\n')

    const result = validateBackendPlugin(root)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.map(item => item.message).join('\n')).toContain('JavaScript 资产不存在')
  })

  it('打包脚本和事件认领的 h_ 入口不作为 HTTP Handler 重复判定', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-backend-contract-'))
    roots.push(root)
    await mkdir(join(root, 'scripts'), { recursive: true })
    await writeFile(join(root, 'plugin.json'), JSON.stringify({
      pluginId: 'exp_claimed_entries',
      name: '认领入口测试',
      version: '0.1.0',
      scripts: [
        { name: 'first', path: 'scripts/first.js', entry: 'h_shared' },
        { name: 'second', path: 'scripts/second.js', entry: 'h_shared' },
      ],
    }))
    await writeFile(join(root, 'scripts/first.js'), 'function h_shared() { return {} }\n')
    await writeFile(join(root, 'scripts/second.js'), 'function h_shared() { return {} }\n')

    const result = validateBackendPlugin(root)

    expect(result.ok).toBe(true)
  })

  it('拒绝只有空白的事件 match 键', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-backend-contract-'))
    roots.push(root)
    await mkdir(join(root, 'events'), { recursive: true })
    await writeFile(join(root, 'plugin.json'), JSON.stringify({
      pluginId: 'exp_invalid_event_match',
      name: '事件匹配测试',
      version: '0.1.0',
      events: [{
        type: 'example.event',
        match: { ' ': 'value' },
        consumer: [{ handler: 'events/example.js', entry: 'handle' }],
      }],
    }))
    await writeFile(join(root, 'events/example.js'), 'function handle() { return {} }\n')

    const result = validateBackendPlugin(root)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.map(item => item.message).join('\n')).toContain('空白键名')
  })

  it('拒绝不兼容 Windows 上传包的后端资产路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-backend-contract-'))
    roots.push(root)
    await mkdir(join(root, 'adapters'), { recursive: true })
    await writeFile(join(root, 'plugin.json'), JSON.stringify({
      pluginId: 'exp_windows_path',
      name: '路径兼容性测试',
      version: '0.1.0',
      scripts: [{ name: 'unsafe', path: 'adapters/a:stream.js', entry: 'handle' }],
    }))
    await writeFile(join(root, 'adapters/a:stream.js'), 'function handle() { return {} }\n')

    const result = validateBackendPlugin(root)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.map(item => item.message).join('\n')).toContain('JavaScript 资产路径不安全')
  })
})
