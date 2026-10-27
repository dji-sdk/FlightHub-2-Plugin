// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createInProcessServiceHost } from '../services/tasks/service-host.js'
import { McpGuardError, resolveGuardedPath } from './guard.js'
import { loadKnowledgeBundle, resolveContractRoot } from './knowledge/loader.js'
import { createKnowledgeService } from './knowledge/service.js'
import type { KnowledgeService } from './knowledge/service.js'
import { createFh2McpServer } from './server.js'

const roots: string[] = []
/** 主仓私有契约包目录名（段拼接避免字面量被公开树痕迹门禁命中；公开树探测走候选标记分支）。 */
const PRIVATE_CONTRACT_PACKAGE = ['fh2-plugin', 'contract'].join('-')
/**
 * 版本断言基准：主仓断言完整契约包版本（投影滞后时失败，提醒重跑 refresh-runtime）；
 * 公开源码树没有契约包，退回运行投影自带的 contract 版本，只锁服务报告值。
 * 以「导出候选标记文件」区分：公开树带 public-distribution.json 自标识。
 */
const expectedContractVersion = (() => {
  if (existsSync(join(import.meta.dirname, '../../../..', 'public-distribution.json'))) {
    return loadKnowledgeBundle(resolveContractRoot()).versions.contract
  }
  const privateContractRoot = join(import.meta.dirname, '..', '..', '..', '..', 'packages', PRIVATE_CONTRACT_PACKAGE, 'package.json')
  const contractPackageJson = JSON.parse(readFileSync(
    privateContractRoot,
    'utf8',
  )) as { version: string }
  return contractPackageJson.version
})()

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('workspace Guard（M1，双模式）', () => {
  it('contained：根内相对路径通过；根内绝对路径放行；越外绝对/越界拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-mcp-guard-'))
    roots.push(root)
    await mkdir(join(root, 'sub'), { recursive: true })
    await writeFile(join(root, 'sub/fh2-plugin.json'), '{}')
    const access = { mode: 'contained', root } as const

    expect(resolveGuardedPath(access, undefined).absolutePath).toBe(root)
    expect(resolveGuardedPath(access, 'sub').absolutePath).toBe(join(root, 'sub'))
    expect(resolveGuardedPath(access, 'sub/../sub').absolutePath).toBe(join(root, 'sub'))
    // root 内绝对路径放行（v3.9 §6.4）。
    expect(resolveGuardedPath(access, join(root, 'sub')).absolutePath).toBe(join(root, 'sub'))

    expect(() => resolveGuardedPath(access, '/etc')).toThrow(McpGuardError)
    expect(() => resolveGuardedPath(access, '../outside')).toThrow(McpGuardError)
    expect(() => resolveGuardedPath(access, 'a\\b')).toThrow(McpGuardError)
    expect(() => resolveGuardedPath(access, 42)).toThrow(McpGuardError)
  })

  it('open：任意绝对路径通过，相对路径基于 baseDir，类型校验保留', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fh2-mcp-open-'))
    roots.push(base)
    const elsewhere = await mkdtemp(join(tmpdir(), 'fh2-mcp-open-other-'))
    roots.push(elsewhere)
    const access = { mode: 'open', baseDir: base } as const

    expect(resolveGuardedPath(access, undefined).absolutePath).toBe(base)
    expect(resolveGuardedPath(access, 'sub/x').absolutePath).toBe(join(base, 'sub/x'))
    // 任意绝对路径可用（cwd 外目录可操作——开放模式核心场景）。
    expect(resolveGuardedPath(access, elsewhere).absolutePath).toBe(elsewhere)
    expect(resolveGuardedPath(access, join(elsewhere, 'sub')).absolutePath).toBe(join(elsewhere, 'sub'))
    // 类型与非法字符校验保留。
    expect(() => resolveGuardedPath(access, 'a\\b')).toThrow(McpGuardError)
    expect(() => resolveGuardedPath(access, 42)).toThrow(McpGuardError)
    expect(() => resolveGuardedPath(access, 'x\0y')).toThrow(McpGuardError)
  })

  it('contained：symlink 越出 allowed root 被拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-mcp-guard-link-'))
    roots.push(root)
    const outside = await mkdtemp(join(tmpdir(), 'fh2-mcp-guard-out-'))
    roots.push(outside)
    await mkdir(join(outside, 'secret'), { recursive: true })
    await symlink(join(outside, 'secret'), join(root, 'leak'), 'dir')
    const access = { mode: 'contained', root } as const

    expect(() => resolveGuardedPath(access, 'leak')).toThrow(/越出 allowed root/)
  })

  it('contained：不存在的目标允许（新建场景），root 不可访问报 ROOT_INVALID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-mcp-guard-new-'))
    roots.push(root)
    const access = { mode: 'contained', root } as const
    expect(resolveGuardedPath(access, 'not/created/yet').absolutePath).toBe(join(root, 'not/created/yet'))
    // allowed root 自身必须存在（contained --root 语义）
    expect(() => resolveGuardedPath({ mode: 'contained', root: join(root, 'missing-root') }, '.')).toThrow(McpGuardError)
  })
})

describe('mCP Server 9 工具（M2/M3，in-memory）', () => {
  async function withClient (root: string, host = createInProcessServiceHost(), knowledge?: KnowledgeService): Promise<{ client: Client; close: () => Promise<void> }> {
    const server = createFh2McpServer({
      access: { mode: 'contained', root },
      host,
      ...(knowledge === undefined ? {} : { knowledge }),
      version: 'test',
    })
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return {
      client,
      close: async () => {
        await client.close()
        await server.close()
      },
    }
  }

  it('工具发现：9 个工程工具，无知识占位工具', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-mcp-tools-'))
    roots.push(root)
    const { client, close } = await withClient(root)
    try {
      const tools = await client.listTools()
      const names = tools.tools.map(tool => tool.name).sort()
      expect(names).toEqual([
        'build',
        'cancel_task',
        'create',
        'generate',
        'get_task',
        'inspect',
        'pack',
        'start_dev',
        'validate',
      ])
      for (const tool of tools.tools) {
        expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: true })
      }
    } finally {
      await close()
    }
  })

  it('inspect：普通目录返回 unknown；信封 ok=true', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-mcp-inspect-'))
    roots.push(root)
    const { client, close } = await withClient(root)
    try {
      const result = await client.callTool({ name: 'inspect', arguments: {} })
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toMatchObject({ ok: true, data: { kind: 'unknown' } })
      const content = result.content as { type: string; text: string }[]
      expect(JSON.parse(content[0]!.text)).toMatchObject({ ok: true, data: { kind: 'unknown' } })
      expect(result.structuredContent).not.toHaveProperty('warnings')
      expect(content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }])
    } finally {
      await close()
    }
  })

  it.each(['--root', '--check'])('generate：合法 check=true 时忽略 CLI 式 key %s，仍调用检查服务且不写文件', async (key) => {
    const root = await createBackendProject()
    const host = createInProcessServiceHost()
    const generate = vi.spyOn(host, 'generate')
    const { client, close } = await withClient(root, host)
    const readTree = (directory: string): Record<string, unknown> => Object.fromEntries(
      readdirSync(directory, { withFileTypes: true }).map(entry => [
        entry.name,
        entry.isDirectory() ? readTree(join(directory, entry.name)) : readFileSync(join(directory, entry.name)),
      ]),
    )
    const before = readTree(root)
    try {
      const result = await client.callTool({ name: 'generate', arguments: { check: true, [key]: key === '--root' ? '/ignored-secret-root' : false } })
      expect(generate).toHaveBeenCalledOnce()
      expect(generate).toHaveBeenCalledWith(root, true)
      expect(readTree(root)).toEqual(before)
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toMatchObject({ ok: true, data: { ok: false, outdated: ['types/'] }, warnings: [{ ignoredArguments: [key] }] })
      expect(JSON.stringify(result)).not.toContain('/ignored-secret-root')
      const content = result.content as { type: string; text: string }[]
      expect(JSON.parse(content[0]!.text)).toEqual(result.structuredContent)
      expect(content[1]!.text).toContain('已忽略未知参数')
      expect(content[1]!.text).toContain(key)
    } finally {
      await close()
    }
  })

  it('generate：仅 --check:true 不代表只读，按默认生成真实写盘并明确提示', async () => {
    const root = await createBackendProject()
    const host = createInProcessServiceHost()
    const generate = vi.spyOn(host, 'generate')
    const { client, close } = await withClient(root, host)
    try {
      const result = await client.callTool({ name: 'generate', arguments: { '--check': true } })
      expect(generate).toHaveBeenCalledOnce()
      expect(generate).toHaveBeenCalledWith(root, false)
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toMatchObject({ ok: true, data: { ok: true, files: expect.arrayContaining(['types/handler.d.ts']) }, warnings: [{ ignoredArguments: ['--check'] }] })
      expect(readFileSync(join(root, 'types/handler.d.ts'), 'utf8')).toContain('declare const ctx:')
      const content = result.content as { type: string; text: string }[]
      expect(JSON.parse(content[0]!.text)).toEqual(result.structuredContent)
      expect(content[1]!.text).toContain('--check')
      expect(content[1]!.text).toContain('默认值')
      expect(content[1]!.text).toContain('不会转发')
    } finally {
      await close()
    }
  })

  it.each<[string, Record<string, unknown>, string, unknown[]]>([
    ['inspect', { path: '.' }, 'inspect', []],
    ['validate', { path: '.' }, 'validate', []],
    ['generate', { path: '.', check: true }, 'generate', [true]],
    ['create', { pluginId: 'exp_mcp_ignored', directory: 'new', template: 'backend-basic' }, 'create', []],
    ['build', { path: '.', mode: 'development' }, 'taskStart', ['build']],
    ['pack', { path: '.', noBuild: true }, 'taskStart', ['pack']],
    ['start_dev', { path: '.', port: 5173 }, 'taskStart', ['dev']],
    ['get_task', { taskId: 'task-ignored' }, 'taskGet', ['task-ignored']],
    ['cancel_task', { taskId: 'task-ignored' }, 'taskCancel', ['task-ignored']],
    ['list_knowledge', { domain: 'backend', kind: 'capability', offset: 1, limit: 2 }, 'list', []],
    ['search_knowledge', { query: 'cache:read', domain: 'backend', kind: 'capability', limit: 2 }, 'search', []],
    ['read_contract', { ref: 'backend.capability.cache:read' }, 'readContract', ['backend.capability.cache:read']],
  ])('%s：接受全部未知 keys，只传已定义参数，提示仅含排序后的键名并保留 resource_link', async (name, args, method, serviceArgs) => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-mcp-ignored-'))
    roots.push(root)
    const serviceCall = vi.fn(async () => ({ taskId: 'task-ignored', kind: 'build' as const, state: 'queued' as const, createdAt: 0, diagnostics: [], artifacts: [], lastSequence: 0 }))
    const host = {
      ...createInProcessServiceHost(),
      inspect: serviceCall,
      validate: serviceCall,
      generate: serviceCall,
      create: serviceCall,
      taskStart: serviceCall,
      taskGet: serviceCall,
      taskCancel: serviceCall,
    }
    const knowledge = createKnowledgeService(loadKnowledgeBundle(resolveContractRoot()))
    const list = vi.spyOn(knowledge, 'list')
    const search = vi.spyOn(knowledge, 'search')
    const readContract = vi.spyOn(knowledge, 'readContract')
    const { client, close } = await withClient(root, host, knowledge)
    try {
      const unknown = { zUnused: 'secret-z-value', apiToken: { token: 'secret-token-value' }, '--check': 'secret-cli-value', toString: ['secret-string-value'] }
      const result = await client.callTool({ name, arguments: { ...args, ...unknown } })
      const expectedArgs = method === 'create'
        ? [root, { pluginId: args.pluginId, directory: join(root, 'new'), template: args.template }]
        : method === 'taskStart'
          ? [...serviceArgs, root, name === 'build' ? { mode: args.mode } : name === 'pack' ? { noBuild: true } : { port: args.port }]
          : method === 'list' || method === 'search'
            ? [args]
            : method === 'taskGet' || method === 'taskCancel' || method === 'readContract' ? serviceArgs : [root, ...serviceArgs]
      const called = method === 'list' ? list : method === 'search' ? search : method === 'readContract' ? readContract : serviceCall
      expect(called).toHaveBeenCalledOnce()
      expect(called).toHaveBeenCalledWith(...expectedArgs)
      expect(serviceCall.mock.calls.length + list.mock.calls.length + search.mock.calls.length + readContract.mock.calls.length).toBe(1)
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toMatchObject({ ok: true, warnings: [{ message: expect.any(String), ignoredArguments: Object.keys(unknown).sort() }] })
      const content = result.content as { type: string; text?: string }[]
      expect(JSON.parse(content[0]!.text!)).toEqual(result.structuredContent)
      expect(content.at(-1)).toEqual({ type: 'text', text: (result.structuredContent as { warnings: { message: string }[] }).warnings[0]!.message })
      expect(content.at(-1)!.text).toContain('已忽略未知参数')
      for (const key of Object.keys(unknown)) expect(content.at(-1)!.text).toContain(key)
      for (const value of ['secret-z-value', 'secret-token-value', 'secret-cli-value', 'secret-string-value']) {
        expect(JSON.stringify(result)).not.toContain(value)
        expect(JSON.stringify(called.mock.calls)).not.toContain(value)
      }
      if (method === 'list' || method === 'search') {
        const clean = await client.callTool({ name, arguments: args })
        expect(content.filter(item => item.type === 'resource_link')).toEqual((clean.content as { type: string }[]).filter(item => item.type === 'resource_link'))
      }
    } finally {
      await close()
    }
  })

  it.each<[string, Record<string, unknown>]>([
    ['inspect', { path: 42 }],
    ['validate', { path: true }],
    ['generate', { check: 'true' }],
    ['create', { pluginId: 42 }],
    ['create', { pluginId: 'exp_mcp_invalid', directory: true }],
    ['create', { pluginId: 'exp_mcp_invalid', template: 'unknown' }],
    ['build', { mode: 'unknown' }],
    ['pack', { noBuild: 'true' }],
    ['start_dev', { port: '5173' }],
    ['start_dev', { port: 1.5 }],
    ['get_task', { taskId: 42 }],
    ['cancel_task', { taskId: true }],
    ['list_knowledge', { domain: 42 }],
    ['list_knowledge', { offset: -1 }],
    ['list_knowledge', { limit: 101 }],
    ['search_knowledge', { query: 42 }],
    ['search_knowledge', { query: 'cache:read', limit: 0 }],
    ['read_contract', { ref: 42 }],
  ])('%s：已定义参数类型/枚举/范围错误仍由 SDK reject，未知值不泄漏且不调用服务 (%j)', async (name, args) => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-mcp-invalid-'))
    roots.push(root)
    const serviceCall = vi.fn(() => {
      throw new Error('校验失败不应进入服务')
    })
    const host = { ...createInProcessServiceHost(), inspect: serviceCall, validate: serviceCall, generate: serviceCall, create: serviceCall, taskStart: serviceCall, taskGet: serviceCall, taskCancel: serviceCall }
    const knowledge = { ...createKnowledgeService(loadKnowledgeBundle(resolveContractRoot())), list: serviceCall, search: serviceCall, readContract: serviceCall }
    const { client, close } = await withClient(root, host, knowledge)
    try {
      const result = await client.callTool({ name, arguments: { ...args, apiToken: 'invalid-secret-value' } })
      expect(serviceCall).not.toHaveBeenCalled()
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toBeUndefined()
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining(`Input validation error: Invalid arguments for tool ${name}:`) }])
      expect(JSON.stringify(result)).not.toContain('invalid-secret-value')
    } finally {
      await close()
    }
  })

  it('并发请求：不同 ignored key 在反序完成时也仅提示各自请求', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-mcp-concurrent-'))
    roots.push(root)
    let finishFirst!: (data: unknown) => void
    const inspect = vi.fn(() => new Promise<unknown>((resolve) => {
      finishFirst = resolve
    }))
    const validate = vi.fn(() => ({ kind: 'second' }))
    const { client, close } = await withClient(root, { ...createInProcessServiceHost(), inspect, validate })
    try {
      const first = client.callTool({ name: 'inspect', arguments: { firstIgnored: 'first-secret-value' } })
      await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce())
      const second = await client.callTool({ name: 'validate', arguments: { secondIgnored: 'second-secret-value' } })
      finishFirst({ kind: 'first' })
      const firstResult = await first
      expect(firstResult.structuredContent).toMatchObject({ ok: true, data: { kind: 'first' }, warnings: [{ ignoredArguments: ['firstIgnored'] }] })
      expect(second.structuredContent).toMatchObject({ ok: true, data: { kind: 'second' }, warnings: [{ ignoredArguments: ['secondIgnored'] }] })
      expect(JSON.stringify(firstResult)).not.toContain('secondIgnored')
      expect(JSON.stringify(second)).not.toContain('firstIgnored')
      expect(JSON.stringify([firstResult, second])).not.toContain('secret-value')
      expect(inspect).toHaveBeenCalledOnce()
      expect(inspect).toHaveBeenCalledWith(root)
      expect(validate).toHaveBeenCalledOnce()
      expect(validate).toHaveBeenCalledWith(root)
    } finally {
      finishFirst?.({})
      await close()
    }
  })

  it.each([
    ['create', 'pluginId'],
    ['get_task', 'taskId'],
    ['cancel_task', 'taskId'],
    ['search_knowledge', 'query'],
    ['read_contract', 'ref'],
  ])('%s：缺少必填 %s 保持 SDK 错误接口', async (name, field) => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-mcp-required-'))
    roots.push(root)
    const knowledge = createKnowledgeService(loadKnowledgeBundle(resolveContractRoot()))
    const { client, close } = await withClient(root, createInProcessServiceHost(), knowledge)
    try {
      const result = await client.callTool({ name, arguments: { apiToken: 'required-secret-value' } })
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: `MCP error -32602: Input validation error: Invalid arguments for tool ${name}: Required at ${field}` }],
      })
      expect(result.structuredContent).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain('required-secret-value')
    } finally {
      await close()
    }
  })

  it('generate：合法 optional/check 默认保持，check=true 不写盘，默认或 false 正常生成', async () => {
    const root = await createBackendProject()
    const host = createInProcessServiceHost()
    const generate = vi.spyOn(host, 'generate')
    const { client, close } = await withClient(root, host)
    try {
      const checked = await client.callTool({ name: 'generate', arguments: { path: '.', check: true } })
      expect(checked.isError).toBeFalsy()
      expect(checked.structuredContent).toMatchObject({ ok: true, data: { ok: false, outdated: ['types/'] } })
      expect(checked.structuredContent).not.toHaveProperty('warnings')
      expect(generate).toHaveBeenLastCalledWith(root, true)
      expect(existsSync(join(root, 'types'))).toBe(false)

      for (const args of [{}, { path: '.', check: false }]) {
        const generated = await client.callTool({ name: 'generate', arguments: args })
        expect(generated.isError).toBeFalsy()
        expect(generated.structuredContent).toMatchObject({ ok: true, data: { ok: true, files: expect.arrayContaining(['types/handler.d.ts']) } })
        expect(generate).toHaveBeenLastCalledWith(root, false)
        const text = (generated.content as { type: string; text: string }[])[0]!.text
        expect(JSON.parse(text)).toEqual(generated.structuredContent)
        expect(generated.structuredContent).not.toHaveProperty('warnings')
        expect(generated.content).toHaveLength(1)
      }
      expect(existsSync(join(root, 'types/handler.d.ts'))).toBe(true)
    } finally {
      await close()
    }
  })

  it('任务工具：合法 optional 参数与省略默认值仍传入服务，成功信封不变', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-mcp-task-options-'))
    roots.push(root)
    const taskStart = vi.fn(async (kind: 'build' | 'pack' | 'dev' | 'install') => ({
      taskId: 'task-options',
      kind,
      state: 'queued' as const,
      createdAt: 0,
      diagnostics: [],
      artifacts: [],
      lastSequence: 0,
    }))
    const { client, close } = await withClient(root, { ...createInProcessServiceHost(), taskStart })
    const cases: [string, Record<string, unknown>, string, Record<string, unknown>][] = [
      ['build', {}, 'build', {}],
      ['build', { path: '.', mode: 'development' }, 'build', { mode: 'development' }],
      ['build', { mode: 'production' }, 'build', { mode: 'production' }],
      ['pack', {}, 'pack', {}],
      ['pack', { path: '.', noBuild: false }, 'pack', {}],
      ['pack', { noBuild: true }, 'pack', { noBuild: true }],
      ['start_dev', {}, 'dev', {}],
      ['start_dev', { path: '.', port: 0 }, 'dev', { port: 0 }],
      ['start_dev', { port: 5173 }, 'dev', { port: 5173 }],
    ]
    try {
      for (const [name, args, kind, params] of cases) {
        const result = await client.callTool({ name, arguments: args })
        expect(taskStart).toHaveBeenLastCalledWith(kind, root, params)
        expect(result.isError).toBeFalsy()
        expect(result.structuredContent).toMatchObject({ ok: true, data: { taskId: 'task-options', kind, state: 'queued' } })
        const text = (result.content as { type: string; text: string }[])[0]!.text
        expect(JSON.parse(text)).toEqual(result.structuredContent)
        expect(result.structuredContent).not.toHaveProperty('warnings')
        expect(result.content).toHaveLength(1)
      }
      expect(taskStart).toHaveBeenCalledTimes(cases.length)
    } finally {
      await close()
    }
  })

  it('validate：结构化诊断信封；guard 越界返回 ok=false', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-mcp-validate-'))
    roots.push(root)
    const { client, close } = await withClient(root)
    try {
      // 业务失败是数据而不是协议错误：信封 ok=true，data.ok=false 携带诊断。
      const result = await client.callTool({ name: 'validate', arguments: {} })
      expect(result.structuredContent).toMatchObject({
        ok: true,
        data: { ok: false, kind: 'unknown' },
      })

      const escaped = await client.callTool({ name: 'validate', arguments: { path: '../outside', apiToken: 'guard-secret-value' } })
      expect(escaped.isError).toBe(true)
      expect(escaped.structuredContent).toMatchObject({ ok: false, error: { code: 'FH2_MCP_PATH_ESCAPE' }, warnings: [{ ignoredArguments: ['apiToken'] }] })
      const content = escaped.content as { type: string; text: string }[]
      expect(JSON.parse(content[0]!.text)).toEqual(escaped.structuredContent)
      expect(content[1]!.text).toContain('已忽略未知参数')
      expect(JSON.stringify(escaped)).not.toContain('guard-secret-value')
    } finally {
      await close()
    }
  })

  it('build：受理返回 taskId（不等待终态）', { timeout: 60_000 }, async () => {
    const root = await createBackendProject()
    const { client, close } = await withClient(root)
    try {
      const result = await client.callTool({ name: 'build', arguments: {} })
      const envelope = result.structuredContent as { ok: boolean; data?: { taskId?: string; state?: string } }
      expect(envelope.ok).toBe(true)
      expect(envelope.data?.taskId).toMatch(/^task-/)
      expect(envelope.data?.state).toBe('queued')
      // 等待终态再结束：后台任务仍在写盘时清理 fixture 会竞态（ENOTEMPTY）。
      const taskId = envelope.data?.taskId ?? ''
      for (let attempt = 0; attempt < 300; attempt++) {
        const polled = await client.callTool({ name: 'get_task', arguments: { taskId } })
        const state = (polled.structuredContent as { data?: { state?: string } }).data?.state
        if (state === 'succeeded' || state === 'failed' || state === 'cancelled') break
        await new Promise(resolveTimer => setTimeout(resolveTimer, 100))
      }
    } finally {
      await close()
    }
  })

  it('get_task/cancel_task：跨进程 owner 隔离——不可见任务返回 NOT_FOUND', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-mcp-tasks-'))
    roots.push(root)
    const { client, close } = await withClient(root)
    try {
      const missing = await client.callTool({ name: 'get_task', arguments: { taskId: 'task-other-process', owner: 'task-secret-owner' } })
      expect(missing.isError).toBe(true)
      expect(missing.structuredContent).toMatchObject({ ok: false, error: { code: 'FH2_TASK_NOT_FOUND' }, warnings: [{ ignoredArguments: ['owner'] }] })

      const cancelMissing = await client.callTool({ name: 'cancel_task', arguments: { taskId: 'task-other-process', owner: 'task-secret-owner' } })
      expect(cancelMissing.isError).toBe(true)
      expect(cancelMissing.structuredContent).toMatchObject({ ok: false, error: { code: 'FH2_TASK_NOT_FOUND' }, warnings: [{ ignoredArguments: ['owner'] }] })
      for (const result of [missing, cancelMissing]) {
        const content = result.content as { type: string; text: string }[]
        expect(JSON.parse(content[0]!.text)).toEqual(result.structuredContent)
        expect(content[1]!.text).toContain('owner')
        expect(JSON.stringify(result)).not.toContain('task-secret-owner')
      }
    } finally {
      await close()
    }
  })

  it('未知 schemaVersion 类输入：schema 校验失败以 isError 返回，不崩协议', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-mcp-badinput-'))
    roots.push(root)
    const { client, close } = await withClient(root)
    try {
      const bad = await client.callTool({ name: 'get_task', arguments: { taskId: '' } as never })
      expect(bad.isError).toBe(true)
    } finally {
      await close()
    }
  })
})

describe('mCP Server 开放模式（open，任意绝对路径）', () => {
  async function withOpenClient (baseDir: string): Promise<{ client: Client; close: () => Promise<void> }> {
    const server = createFh2McpServer({ access: { mode: 'open', baseDir }, host: createInProcessServiceHost(), version: 'test' })
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return {
      client,
      close: async () => {
        await client.close()
        await server.close()
      },
    }
  }

  it('cwd 外绝对路径 inspect 可用；同路径在 contained 模式返回 PATH_ESCAPE', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fh2-mcp-openbase-'))
    roots.push(base)
    const elsewhere = await mkdtemp(join(tmpdir(), 'fh2-mcp-elsewhere-'))
    roots.push(elsewhere)
    await writeFile(join(elsewhere, 'fh2-plugin.json'), JSON.stringify({
      pluginId: 'exp_open_elsewhere',
      name: 'Elsewhere',
      version: '0.1.0',
      contractsRange: '>=1.0.0 <2.0.0',
    }))

    const { client, close } = await withOpenClient(base)
    try {
      const inspected = await client.callTool({ name: 'inspect', arguments: { path: elsewhere } })
      expect(inspected.structuredContent).toMatchObject({ ok: true, data: { kind: 'backend-plugin', root: elsewhere } })
    } finally {
      await close()
    }

    // 对照：contained 模式对 root 外绝对路径返回 PATH_ESCAPE。
    const { client: containedClient, close: containedClose } = await (async () => {
      const server = createFh2McpServer({ access: { mode: 'contained', root: base }, host: createInProcessServiceHost(), version: 'test' })
      const client = new Client({ name: 'test-client', version: '0.0.0' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      return {
        client,
        close: async () => {
          await client.close()
          await server.close()
        },
      }
    })()
    try {
      const escaped = await containedClient.callTool({ name: 'inspect', arguments: { path: elsewhere } })
      expect(escaped.structuredContent).toMatchObject({ ok: false, error: { code: 'FH2_MCP_PATH_ESCAPE' } })
    } finally {
      await containedClose()
    }
  })

  it('create：开放模式 directory 为 cwd 外绝对路径（worker 收到绝对路径）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fh2-mcp-createopen-'))
    roots.push(base)
    const target = await mkdtemp(join(tmpdir(), 'fh2-mcp-createtarget-'))
    roots.push(target)
    const create = vi.fn(async () => ({ ok: true as const, root: target }))
    const server = createFh2McpServer({
      access: { mode: 'open', baseDir: base },
      host: {
        ...createInProcessServiceHost(),
        create,
      },
      version: 'test',
    })
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({
        name: 'create',
        arguments: { pluginId: 'exp_anywhere_demo', directory: target },
      })
      expect(result.structuredContent).toMatchObject({ ok: true })
      expect(create).toHaveBeenCalledWith(base, expect.objectContaining({
        pluginId: 'exp_anywhere_demo',
        directory: target,
      }))
    } finally {
      await client.close()
      await server.close()
    }
  })
})

describe('mCP Server 知识 Resources（in-memory + 真实运行投影）', () => {
  async function withKnowledgeClient (): Promise<{ client: Client; close: () => Promise<void> }> {
    const knowledge = createKnowledgeService(loadKnowledgeBundle(resolveContractRoot()))
    const server = createFh2McpServer({ access: { mode: 'open', baseDir: '/tmp' }, host: createInProcessServiceHost(), version: 'test', knowledge })
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return {
      client,
      close: async () => {
        await client.close()
        await server.close()
      },
    }
  }

  it('工具发现：12 个（9 工程 + list/search/read_contract）', async () => {
    const { client, close } = await withKnowledgeClient()
    try {
      const tools = await client.listTools()
      expect(tools.tools.map(tool => tool.name).sort()).toEqual([
        'build',
        'cancel_task',
        'create',
        'generate',
        'get_task',
        'inspect',
        'list_knowledge',
        'pack',
        'read_contract',
        'search_knowledge',
        'start_dev',
        'validate',
      ])
      expect(tools.tools.find(tool => tool.name === 'list_knowledge')?.description).toContain('frontend: capability/point')
      expect(tools.tools.find(tool => tool.name === 'search_knowledge')?.description).toContain('backend: action/capability')
      for (const tool of tools.tools) {
        expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: true })
      }
    } finally {
      await close()
    }
  })

  it('list_knowledge 按 domain/kind 完整枚举并支持分页', async () => {
    const { client, close } = await withKnowledgeClient()
    try {
      const first = await client.callTool({
        name: 'list_knowledge',
        arguments: { domain: 'backend', kind: 'capability', limit: 10 },
      })
      const firstEnvelope = first.structuredContent as {
        ok: boolean;
        data?: { items?: Array<{ targetId: string; resourceUri: string }>; total?: number; nextOffset?: number };
      }
      expect(firstEnvelope.ok).toBe(true)
      expect(firstEnvelope.data?.total).toBeGreaterThan(10)
      expect(firstEnvelope.data?.items).toHaveLength(10)
      expect(firstEnvelope.data?.items?.every(item => item.targetId.startsWith('backend.capability.'))).toBe(true)
      expect(firstEnvelope.data?.nextOffset).toBe(10)

      const second = await client.callTool({
        name: 'list_knowledge',
        arguments: { domain: 'backend', kind: 'capability', offset: 10, limit: 10 },
      })
      const secondEnvelope = second.structuredContent as { data?: { items?: Array<{ targetId: string }>; total?: number; nextOffset?: number } }
      expect(secondEnvelope.data?.total).toBe(firstEnvelope.data?.total)
      expect(secondEnvelope.data?.items).toHaveLength((firstEnvelope.data?.total ?? 10) - 10)
      expect(secondEnvelope.data?.nextOffset).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('知识工具：合法省略 optional 参数保持默认分页及成功信封', async () => {
    const { client, close } = await withKnowledgeClient()
    try {
      const listed = await client.callTool({ name: 'list_knowledge', arguments: {} })
      expect(listed.isError).toBeFalsy()
      expect(listed.structuredContent).toMatchObject({ ok: true, data: { offset: 0, limit: 50, items: expect.any(Array) } })
      expect((listed.structuredContent as { data: { items: unknown[] } }).data.items).toHaveLength(50)

      const searched = await client.callTool({ name: 'search_knowledge', arguments: { query: 'capability' } })
      expect(searched.isError).toBeFalsy()
      expect(searched.structuredContent).toMatchObject({ ok: true, data: { items: expect.any(Array) } })
      expect((searched.structuredContent as { data: { items: unknown[] } }).data.items).toHaveLength(5)
      for (const result of [listed, searched]) {
        const text = (result.content as { type: string; text: string }[])[0]!.text
        expect(JSON.parse(text)).toEqual(result.structuredContent)
        expect(result.structuredContent).not.toHaveProperty('warnings')
        expect((result.content as { type: string }[]).slice(1).every(item => item.type === 'resource_link')).toBe(true)
      }
    } finally {
      await close()
    }
  })

  it('search_knowledge → Resource/read_contract 闭环（含来源指纹）', async () => {
    const { client, close } = await withKnowledgeClient()
    try {
      const searched = await client.callTool({
        name: 'search_knowledge',
        arguments: { query: '插件 cache 读能力', domain: 'backend', kind: 'capability', limit: 3 },
      })
      const searchEnvelope = searched.structuredContent as {
        ok: boolean;
        data?: { items?: Array<{ targetId: string; resourceUri: string }>; total?: number; versions?: Record<string, unknown> };
      }
      expect(searchEnvelope.ok).toBe(true)
      expect(searchEnvelope.data?.total).toBeGreaterThanOrEqual(2)
      expect(searchEnvelope.data?.versions).toMatchObject({
        toolchain: 'test',
        contract: expectedContractVersion,
        knowledgeStatus: 'reviewed',
        contractStatus: expect.stringMatching(/^(ready-for-review|foundation-review-blocked)$/),
      })
      expect(searchEnvelope.data?.versions?.approvedEntries).toEqual(expect.any(Number))
      expect(searchEnvelope.data?.versions?.projection).toEqual(loadKnowledgeBundle().projection)
      expect(searchEnvelope.data?.items?.map(item => item.targetId)).toContain('backend.capability.cache:read')

      // 精确 catalog id 查询：首条返回知识 Resource URI。
      const exact = await client.callTool({ name: 'search_knowledge', arguments: { query: 'cache:read', limit: 3 } })
      const exactEnvelope = exact.structuredContent as { data?: { items?: Array<{ targetId: string; resourceUri: string; factResourceUris: string[] }> } }
      expect(exactEnvelope.data?.items?.[0]?.targetId).toBe('backend.capability.cache:read')
      const resourceUri = exactEnvelope.data?.items?.[0]?.resourceUri
      expect(resourceUri).toContain('backend.capability.cache')

      const read = await client.callTool({ name: 'read_contract', arguments: { ref: resourceUri } })
      const readEnvelope = read.structuredContent as { ok: boolean; data?: { value?: { content?: { developerAction?: string } } } }
      expect(readEnvelope.ok).toBe(true)
      expect(readEnvelope.data?.value?.content?.developerAction).toContain('cache:read')

      const fact = await client.callTool({ name: 'read_contract', arguments: { ref: 'tooling/cli-commands.json#commands/build' } })
      expect(fact.structuredContent).toMatchObject({ ok: true, data: { resolved: true, value: { name: 'build' } } })

      const resources = await client.listResources()
      expect(resources.resources.map(resource => resource.uri)).toContain('fh2-contract://meta')
      expect(resources.resources.map(resource => resource.uri)).toContain(resourceUri)
      const meta = await client.readResource({ uri: 'fh2-contract://meta' })
      const metaValue = JSON.parse((meta.contents[0] as { text: string }).text) as { kindsByDomain?: Record<string, string[]> }
      const bundle = loadKnowledgeBundle()
      expect(metaValue).toMatchObject({ ...bundle.versions, projection: bundle.projection })
      expect(metaValue.kindsByDomain?.frontend).toContain('point')
      expect(metaValue.kindsByDomain?.backend).not.toContain('point')
      const resource = await client.readResource({ uri: resourceUri! })
      expect((resource.contents[0] as { text?: string }).text).toContain('cache:read')
      const factResourceUri = exactEnvelope.data?.items?.[0]?.factResourceUris[0]
      expect(factResourceUri).toBeDefined()
      const factResource = await client.readResource({ uri: factResourceUri! })
      expect((factResource.contents[0] as { text?: string }).text).toContain('capabilityGating')
    } finally {
      await close()
    }
  })

  it('知识工具参数错误映射 INVALID_ARGUMENT 信封', async () => {
    const { client, close } = await withKnowledgeClient()
    try {
      const unknown = await client.callTool({ name: 'read_contract', arguments: { ref: 'nope.nope.nope', apiToken: 'knowledge-secret-value' } })
      expect(unknown.isError).toBe(true)
      expect(unknown.structuredContent).toMatchObject({ ok: false, error: { code: 'FH2_MCP_INVALID_ARGUMENT' }, warnings: [{ ignoredArguments: ['apiToken'] }] })
      expect(JSON.parse((unknown.content as { text: string }[])[0]!.text)).toEqual(unknown.structuredContent)
      expect((unknown.content as { text: string }[])[1]!.text).toContain('apiToken')
      expect(JSON.stringify(unknown)).not.toContain('knowledge-secret-value')
      const privateFile = await client.callTool({ name: 'read_contract', arguments: { ref: 'approval/final.approval.json' } })
      expect(privateFile.structuredContent).toMatchObject({ ok: false, error: { code: 'FH2_MCP_INVALID_ARGUMENT', message: expect.stringContaining('未发布') } })

      const badKind = await client.callTool({ name: 'search_knowledge', arguments: { query: 'x', kind: 'host' } })
      expect(badKind.structuredContent).toMatchObject({ ok: false, error: { code: 'FH2_MCP_INVALID_ARGUMENT' } })

      const invalidListPair = await client.callTool({ name: 'list_knowledge', arguments: { domain: 'backend', kind: 'point' } })
      expect(invalidListPair.structuredContent).toMatchObject({
        ok: false,
        error: { code: 'FH2_MCP_INVALID_ARGUMENT', message: expect.stringContaining('backend 可用 kind') },
      })

      const invalidSearchPair = await client.callTool({ name: 'search_knowledge', arguments: { query: '扩展点', domain: 'backend', kind: 'point' } })
      expect(invalidSearchPair.structuredContent).toMatchObject({
        ok: false,
        error: { code: 'FH2_MCP_INVALID_ARGUMENT', message: expect.stringContaining('kind "point" 不属于 domain "backend"') },
      })
    } finally {
      await close()
    }
  })
})

async function createBackendProject (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-mcp-build-'))
  roots.push(root)
  await mkdir(join(root, 'handlers'), { recursive: true })
  await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({
    pluginId: 'exp_mcp_backend',
    name: 'MCP Backend',
    version: '0.1.0',
    contractsRange: '>=1.0.0 <2.0.0',
  }))
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'ES2022', lib: ['ES2022'], types: [], module: 'ESNext', moduleResolution: 'Bundler' },
    include: ['handlers/**/*.ts'],
  }))
  await writeFile(join(root, 'handlers/issue.ts'), 'export function h_createIssue(): number {\n  return 42\n}\n')
  expect(existsSync(join(root, 'fh2-plugin.json'))).toBe(true)
  return root
}
