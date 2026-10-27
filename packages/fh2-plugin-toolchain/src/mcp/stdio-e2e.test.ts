// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { loadKnowledgeBundle } from './knowledge/loader.js'

/**
 * E4 核心（M2/M4 真实纵切）：spawn `node dist/cli.js mcp --root <fixture>`，
 * 真实 stdio Client 完成 9 工具发现、inspect、build 任务受理与终态轮询。
 * stdout 纯净由协议往返本身验证（任何业务输出混入都会让 Client 解析失败）。
 */
const roots: string[] = []
let projectRoot = ''
let cliEntry = ''

beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'fh2-mcp-e2e-'))
  roots.push(projectRoot)
  await mkdir(join(projectRoot, 'handlers'), { recursive: true })
  await writeFile(join(projectRoot, 'fh2-plugin.json'), JSON.stringify({
    pluginId: 'exp_mcp_e2e',
    name: 'MCP E2E',
    version: '0.1.0',
    contractsRange: '>=1.0.0 <2.0.0',
  }))
  await writeFile(join(projectRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'ES2022', lib: ['ES2022'], types: [], module: 'ESNext', moduleResolution: 'Bundler' },
    include: ['handlers/**/*.ts'],
  }))
  await writeFile(join(projectRoot, 'handlers/issue.ts'), 'export function h_createIssue(): number {\n  return 42\n}\n')

  // dist/cli.js（本测试要求先完成 build:dist；mcp 是它的惰性子命令入口）
  cliEntry = resolve(fileURLToPath(new URL('../../dist/cli.js', import.meta.url)))
  if (!existsSync(cliEntry)) throw new Error(`缺少 ${cliEntry}；请先 pnpm --filter fh2-plugin-toolchain build:dist`)
})

afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('mCP 真实 stdio 纵切（E4 核心）', () => {
  it('工具发现 + inspect + validate + build/get_task + 知识工具 + stdout 纯净', { timeout: 120_000 }, async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliEntry, 'mcp', '--root', projectRoot],
    })
    const client = new Client({ name: 'e2e-client', version: '0.0.0' })
    const protocolErrors: Error[] = []
    client.onerror = error => protocolErrors.push(error)
    await client.connect(transport)
    try {
      // 1. 12 工具发现（9 工程 + list/search/read_contract）
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
      for (const tool of tools.tools) {
        expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: true })
      }

      // 2. inspect：真实工程识别
      const inspected = await client.callTool({ name: 'inspect', arguments: {} })
      expect(inspected.structuredContent).toMatchObject({ ok: true, data: { kind: 'backend-plugin' } })

      // 3. validate：合法工程通过
      const validated = await client.callTool({ name: 'validate', arguments: {} })
      expect(validated.structuredContent).toMatchObject({ ok: true, data: { ok: true } })

      // 4. build 受理 → get_task 轮询到终态
      const started = await client.callTool({ name: 'build', arguments: {} })
      const startEnvelope = started.structuredContent as { ok: boolean; data?: { taskId?: string } }
      expect(startEnvelope.ok).toBe(true)
      const taskId = startEnvelope.data?.taskId
      expect(taskId).toMatch(/^task-/)

      let final: { state?: string } | undefined
      for (let attempt = 0; attempt < 200; attempt++) {
        const polled = await client.callTool({ name: 'get_task', arguments: { taskId: taskId! } })
        const snapshot = (polled.structuredContent as { data?: { state?: string } }).data
        final = snapshot
        if (snapshot?.state === 'succeeded' || snapshot?.state === 'failed' || snapshot?.state === 'cancelled') break
        await new Promise(resolveTimer => setTimeout(resolveTimer, 200))
      }
      expect(final?.state).toBe('succeeded')

      // 5. guard：越界路径拒绝
      const escaped = await client.callTool({ name: 'inspect', arguments: { path: '../outside' } })
      expect(escaped.structuredContent).toMatchObject({ ok: false, error: { code: 'FH2_MCP_PATH_ESCAPE' } })

      // 6. 知识工具纵切（同包公共运行投影经 CLI 子命令进程内加载）。
      // 2026-10-15 知识再生成后 cache:read 摘要英文术语化，查询词随之对齐（质量债见 search-quality.test.ts）。
      const searched = await client.callTool({ name: 'search_knowledge', arguments: { query: '插件 cache', domain: 'backend', limit: 3 } })
      const searchEnvelope = searched.structuredContent as { ok: boolean; data?: { items?: Array<{ targetId: string }>; total?: number; versions?: { approvedEntries?: number; projection?: { publishedEntries?: number } } } }
      const bundle = loadKnowledgeBundle()
      expect(searchEnvelope.ok).toBe(true)
      expect(searchEnvelope.data?.items?.map(item => item.targetId)).toContain('backend.capability.cache:read')
      expect(searchEnvelope.data?.versions).toMatchObject({ ...bundle.versions, projection: bundle.projection })

      const listed = await client.callTool({ name: 'list_knowledge', arguments: { domain: 'backend', kind: 'capability' } })
      expect(listed.structuredContent).toMatchObject({ ok: true, data: { total: 19 } })

      const invalidPair = await client.callTool({ name: 'list_knowledge', arguments: { domain: 'backend', kind: 'point' } })
      expect(invalidPair.structuredContent).toMatchObject({
        ok: false,
        error: { code: 'FH2_MCP_INVALID_ARGUMENT', message: expect.stringContaining('backend 可用 kind') },
      })

      const read = await client.callTool({ name: 'read_contract', arguments: { ref: 'backend.capability.cache:read' } })
      const readEnvelope = read.structuredContent as { ok: boolean; data?: { value?: { content?: { developerAction?: string } } } }
      expect(readEnvelope.ok).toBe(true)
      expect(readEnvelope.data?.value?.content?.developerAction).toContain('cache:read')

      const fact = await client.callTool({ name: 'read_contract', arguments: { ref: 'backend/catalog/host-api.json#methods/cache.get' } })
      expect(fact.structuredContent).toMatchObject({ ok: true, data: { resolved: true } })
      const unresolved = await client.callTool({ name: 'read_contract', arguments: { ref: 'backend/runtime-readiness.json#capability/cache:read' } })
      expect(unresolved.structuredContent).toMatchObject({ ok: true, data: { resolved: false, value: null, warning: expect.any(String) } })
      const unpublished = await client.callTool({ name: 'read_contract', arguments: { ref: 'approval/final.approval.json' } })
      expect(unpublished.structuredContent).toMatchObject({ ok: false, error: { code: 'FH2_MCP_INVALID_ARGUMENT' } })

      const resources = await client.listResources()
      const publishedEntries = searchEnvelope.data?.versions?.projection?.publishedEntries
      expect(publishedEntries).toEqual(expect.any(Number))
      expect(resources.resources).toHaveLength(publishedEntries! + 3)
      expect(resources.resources.map(resource => resource.uri)).toContain('fh2-contract://meta')
      const meta = await client.readResource({ uri: 'fh2-contract://meta' })
      const metaValue = JSON.parse((meta.contents[0] as { text: string }).text) as { kindsByDomain?: Record<string, string[]> }
      expect(metaValue).toMatchObject({ ...bundle.versions, projection: bundle.projection })
      expect(metaValue.kindsByDomain?.frontend).toContain('point')
      expect(metaValue.kindsByDomain?.backend).not.toContain('point')
      expect(protocolErrors).toEqual([])
    } finally {
      await client.close()
    }
  })

  it('generate：接受 CLI 式未知 keys 并警告；check=true 不写，仅 --check:true 按默认真实写盘；stdout 纯协议', { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-mcp-ignored-e2e-'))
    roots.push(root)
    await mkdir(join(root, 'handlers'))
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({
      pluginId: 'exp_mcp_ignored_e2e',
      name: 'MCP Ignored Arguments E2E',
      version: '0.1.0',
      contractsRange: '>=1.0.0 <2.0.0',
    }))
    await writeFile(join(root, 'handlers/issue.ts'), 'export function h_createIssue(): number { return 42 }\n')
    const readTree = (directory: string): Record<string, unknown> => Object.fromEntries(
      readdirSync(directory, { withFileTypes: true }).map(entry => [
        entry.name,
        entry.isDirectory() ? readTree(join(directory, entry.name)) : readFileSync(join(directory, entry.name)),
      ]),
    )
    const before = readTree(root)
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliEntry, 'mcp', '--root', root],
      stderr: 'pipe',
    })
    const stderr: string[] = []
    transport.stderr?.on('data', chunk => stderr.push(String(chunk)))
    const client = new Client({ name: 'e2e-ignored-input', version: '0.0.0' })
    const protocolErrors: Error[] = []
    client.onerror = error => protocolErrors.push(error)
    await client.connect(transport)
    try {
      const inspected = await client.callTool({ name: 'inspect', arguments: { path: '.' } })
      expect(inspected.structuredContent).toMatchObject({ ok: true, data: { kind: 'backend-plugin' } })
      const checked = await client.callTool({ name: 'generate', arguments: { path: '.', check: true, '--check': false, '--root': '/ignored-secret-root', apiToken: { token: 'stdio-secret-value' } } })
      expect(checked.isError).toBeFalsy()
      expect(checked.structuredContent).toMatchObject({ ok: true, data: { ok: false, outdated: ['types/'] }, warnings: [{ ignoredArguments: ['--check', '--root', 'apiToken'] }] })
      expect(readTree(root)).toEqual(before)
      const invalid = await client.callTool({ name: 'generate', arguments: { check: 'true', apiToken: 'stdio-secret-value' } })
      expect(invalid.isError).toBe(true)
      expect(invalid.structuredContent).toBeUndefined()
      expect(invalid.content).toEqual([{ type: 'text', text: expect.stringContaining('Expected boolean, received string at check') }])
      expect(readTree(root)).toEqual(before)

      const generated = await client.callTool({ name: 'generate', arguments: { '--check': true } })
      expect(generated.isError).toBeFalsy()
      expect(generated.structuredContent).toMatchObject({ ok: true, data: { ok: true, files: expect.arrayContaining(['types/handler.d.ts']) }, warnings: [{ ignoredArguments: ['--check'] }] })
      expect(readTree(root)).not.toEqual(before)
      expect(readFileSync(join(root, 'types/handler.d.ts'), 'utf8')).toContain('declare const ctx:')
      for (const result of [checked, generated]) {
        const content = result.content as { type: string; text: string }[]
        expect(JSON.parse(content[0]!.text)).toEqual(result.structuredContent)
        expect(content[1]).toEqual({ type: 'text', text: (result.structuredContent as { warnings: { message: string }[] }).warnings[0]!.message })
        expect(content[1]!.text).toContain('已忽略未知参数')
        expect(content[1]!.text).toContain('--check')
        expect(content[1]!.text).toContain('默认值')
        expect(content[1]!.text).toContain('不会转发')
        expect(JSON.stringify(result)).not.toContain('/ignored-secret-root')
        expect(JSON.stringify(result)).not.toContain('stdio-secret-value')
      }
      expect(JSON.stringify(invalid)).not.toContain('stdio-secret-value')
      expect(protocolErrors).toEqual([])
      expect(stderr.join('')).not.toContain('/ignored-secret-root')
      expect(stderr.join('')).not.toContain('stdio-secret-value')
    } finally {
      await client.close()
    }
  })

  it('不存在的 --root 快速失败（退出码 2）', async () => {
    const child = spawn(process.execPath, [cliEntry, 'mcp', '--root', 'relative/path'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const stderr: string[] = []
    child.stderr?.on('data', chunk => stderr.push(String(chunk)))
    const code = await new Promise<number | null>(resolveExit => child.on('exit', resolveExit))
    expect(code).toBe(2)
    expect(stderr.join('')).toContain('--root')
  })

  it('相对 --root 按进程 cwd 解析并正常启动', { timeout: 60_000 }, async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliEntry, 'mcp', '--root', '.'],
      cwd: projectRoot,
    })
    const client = new Client({ name: 'e2e-relative-root', version: '0.0.0' })
    await client.connect(transport)
    try {
      const tools = await client.listTools()
      expect(tools.tools).toHaveLength(12)
      const inspected = await client.callTool({ name: 'inspect', arguments: {} })
      expect(inspected.structuredContent).toMatchObject({ ok: true, data: { kind: 'backend-plugin' } })
    } finally {
      await client.close()
    }
  })

  it('省略 --root 时默认取进程 cwd', { timeout: 60_000 }, async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliEntry, 'mcp'],
      cwd: projectRoot,
    })
    const client = new Client({ name: 'e2e-default-root', version: '0.0.0' })
    await client.connect(transport)
    try {
      const tools = await client.listTools()
      expect(tools.tools).toHaveLength(12)
      const inspected = await client.callTool({ name: 'inspect', arguments: {} })
      expect(inspected.structuredContent).toMatchObject({ ok: true, data: { kind: 'backend-plugin' } })
    } finally {
      await client.close()
    }
  })

  it('--root=<dir> 等号形式与分离形式等价（canonicalize 到真实路径）', { timeout: 60_000 }, async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliEntry, 'mcp', `--root=${projectRoot}`],
    })
    const client = new Client({ name: 'e2e-eq-root', version: '0.0.0' })
    await client.connect(transport)
    try {
      const tools = await client.listTools()
      expect(tools.tools).toHaveLength(12)
      const inspected = await client.callTool({ name: 'inspect', arguments: {} })
      expect(inspected.structuredContent).toMatchObject({ ok: true, data: { kind: 'backend-plugin' } })
    } finally {
      await client.close()
    }
  })

  it('未知参数以退出码 2 拒绝（不再静默回退 cwd）', { timeout: 30_000 }, async () => {
    const child = spawn(process.execPath, [cliEntry, 'mcp', '--foo'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const stderr: string[] = []
    child.stderr?.on('data', chunk => stderr.push(String(chunk)))
    const code = await new Promise<number | null>(resolveExit => child.on('exit', resolveExit))
    expect(code).toBe(2)
    expect(stderr.join('')).toContain('--foo')
  })

  it('symlink --root canonicalize 为真实路径后工程工具可用', { timeout: 60_000 }, async () => {
    const linkParent = await mkdtemp(join(tmpdir(), 'fh2-mcp-link-'))
    roots.push(linkParent)
    const link = join(linkParent, 'project-link')
    await symlink(projectRoot, link, 'dir')
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliEntry, 'mcp', '--root', link],
    })
    const client = new Client({ name: 'e2e-symlink-root', version: '0.0.0' })
    await client.connect(transport)
    try {
      // 启动 ready 且 inspect 不再 ROOT_INVALID（此前启动接受、工具全失败的漂移）。
      const inspected = await client.callTool({ name: 'inspect', arguments: {} })
      expect(inspected.structuredContent).toMatchObject({ ok: true, data: { kind: 'backend-plugin' } })
    } finally {
      await client.close()
    }
  })

  it('开放模式（无 --root）：cwd 外绝对路径可操作，create 落盘到任意目录', { timeout: 120_000 }, async () => {
    // MCP 启动于 projectRoot（cwd），目标目录在别处——用户在任意目录 spawn、
    // 在其他任意目录生成插件的核心场景。
    const elsewhere = await mkdtemp(join(tmpdir(), 'fh2-mcp-anywhere-'))
    roots.push(elsewhere)
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliEntry, 'mcp'],
      cwd: projectRoot,
      // 与 scripts/check-release-artifacts.mjs 同款受控放行：本测试在仓内跑本地
      // 源码基线（未发布），worker cwd 在 tmp 找不到平台仓，守卫只拦仓外误用。
      env: { ...process.env, FH2_CREATE_ALLOW_UNPUBLISHED_BASELINE: '1' },
    })
    const client = new Client({ name: 'e2e-open-mode', version: '0.0.0' })
    await client.connect(transport)
    try {
      // cwd 外绝对路径 inspect 可用。
      const inspected = await client.callTool({ name: 'inspect', arguments: { path: elsewhere } })
      expect(inspected.structuredContent).toMatchObject({ ok: true, data: { kind: 'unknown', root: elsewhere } })

      // create 到 cwd 外绝对目录（受控模板参数；默认模板会尝试装依赖——create 是
      // 同步只生成文件，exp 后缀 + 显式 backend-basic 最小化）。
      const created = await client.callTool({
        name: 'create',
        arguments: { pluginId: 'exp_anywhere_e2e', directory: elsewhere, template: 'backend-basic' },
      })
      expect(created.structuredContent).toMatchObject({ ok: true, data: { ok: true, projectRoot: elsewhere } })
      // directory 即目标目录：工程直接生成在 cwd 外绝对路径下。
      expect(existsSync(join(elsewhere, 'fh2-plugin.json'))).toBe(true)
    } finally {
      await client.close()
    }
  })
})
