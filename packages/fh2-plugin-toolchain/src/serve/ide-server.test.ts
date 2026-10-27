// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import open from 'open'
import revealFile from 'reveal-file'
import type {
  IdeFileData,
  IdeFsCopyData,
  IdeFsCreateData,
  IdeFsDeleteData,
  IdeFsRenameData,
  IdeRecentData,
  IdeRunLogsData,
  IdeRunStartData,
  IdeRunStatusData,
  IdeRunStopData,
  IdeRunTargetsData,
  IdeTreeChildrenData,
  IdeTreeData,
  IdeTreeNode,
  IdeValidateData,
  IdeWorkspaceData,
  IdeWriteData,
} from '../contracts/ide.js'
import { isWatchIgnored, sanitizeTaskParams, startIdeServer } from './ide-server.js'
import type { IdeServer } from './ide-server.js'

vi.mock('open', () => ({ default: vi.fn() }))
vi.mock('reveal-file', () => ({ default: vi.fn() }))

describe('文件树系统菜单HTTP与会话', () => {
  const base = mkdtempSync(join(tmpdir(), 'fh2-system-menu-http-'))
  const root = join(base, 'workspace')
  const nextRoot = join(base, 'next')
  const webRoot = join(base, 'web')
  let server: IdeServer
  const api = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, {
    ...init,
    headers: { 'x-fh2-ide-token': server.token, ...init.headers },
  })
  beforeAll(async () => {
    for (const dir of [root, nextRoot, webRoot]) mkdirSync(dir)
    for (const dir of [root, nextRoot]) writeFileSync(join(dir, 'fh2-plugin.json'), '{"id":"exp_system_menu"}')
    writeFileSync(join(root, '中文 file.ts'), '')
    writeFileSync(join(base, 'outside.ts'), '')
    // Windows 文件 symlink 需要开发者模式/管理员（EPERM）；逃逸 fixture 仅在 POSIX 创建
    if (process.platform !== 'win32') symlinkSync(join(base, 'outside.ts'), join(root, 'escape.ts'))
    writeFileSync(join(webRoot, 'index.html'), '<html><head></head><body></body></html>')
    server = await startIdeServer({ root, webRoot, port: 0, watch: false })
  })
  afterAll(async () => {
    await server?.close()
    rmSync(base, { recursive: true, force: true })
  })

  it('路径回包与文件定位、目录打开遵循工作区路径', async () => {
    expect(await (await api('/api/fs/path?path=.')).json()).toMatchObject({ ok: true, data: { absolutePath: root, relativePath: '.' } })
    const file = await api('/api/fs/reveal', { method: 'POST', body: JSON.stringify({ path: '中文 file.ts' }) })
    expect(file.status).toBe(200)
    expect(revealFile).toHaveBeenCalledWith(join(root, '中文 file.ts'))
    const directory = await api('/api/fs/reveal', { method: 'POST', body: '{"path":"."}' })
    expect(directory.status).toBe(200)
    expect(open).toHaveBeenCalledWith(root)
  })

  it('两个接口都鉴权并拒绝路径逃逸，打开不存在的文件失败', async () => {
    vi.mocked(open).mockClear()
    vi.mocked(revealFile).mockClear()
    for (const endpoint of ['/api/fs/path?path=.', '/api/fs/reveal']) {
      const response = await fetch(`${server.url}${endpoint}`, endpoint.endsWith('reveal') ? { method: 'POST', body: '{"path":"."}' } : {})
      expect(response.status).toBe(401)
    }
    for (const path of ['../outside.ts', '/absolute', ...(process.platform === 'win32' ? [] : ['escape.ts'])]) {
      expect((await api(`/api/fs/path?path=${encodeURIComponent(path)}`)).status).toBe(400)
      expect((await api('/api/fs/reveal', { method: 'POST', body: JSON.stringify({ path }) })).status).toBe(400)
    }
    expect((await api('/api/fs/reveal', { method: 'POST', body: '{"path":"missing.ts"}' })).status).toBe(404)
    expect(open).not.toHaveBeenCalled()
    expect(revealFile).not.toHaveBeenCalled()
  })

  it('切换等待已受理系统操作完成，旧会话不能打开或复制新根路径', async () => {
    const workspace = await (await api('/api/workspace')).json() as IdeEnvelope<IdeWorkspaceData>
    const headers = { 'x-fh2-ide-session': workspace.data!.sessionId }
    let release!: () => void
    vi.mocked(revealFile).mockImplementationOnce(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    const opening = api('/api/fs/reveal', { method: 'POST', headers, body: '{"path":"中文 file.ts"}' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const switching = api('/api/workspace/open', { method: 'POST', body: JSON.stringify({ root: nextRoot }) })
    // 接口往返确认switching已进入服务端，不依赖固定时延。
    try {
      await vi.waitFor(async () => {
        const blocked = await api('/api/fs/reveal', { method: 'POST', headers, body: '{"path":"."}' })
        expect(blocked.status).toBe(409)
      })
      expect(server.root).toBe(root)
    } finally {
      release()
    }
    expect((await opening).status).toBe(200)
    expect((await switching).status).toBe(200)
    vi.mocked(open).mockClear()
    const expired = await api('/api/fs/reveal', { method: 'POST', headers, body: '{"path":"."}' })
    expect(expired.status).toBe(409)
    expect(await expired.json()).toMatchObject({ error: { code: 'FH2_IDE_SESSION_EXPIRED' } })
    expect((await api('/api/fs/path?path=.', { headers })).status).toBe(409)
    expect(open).not.toHaveBeenCalled()
    expect(server.root).toBe(nextRoot)
  })
})

interface IdeEnvelope<T> {
  readonly schemaVersion: number;
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message: string };
}

describe('web ide server', () => {
  const base = mkdtempSync(join(tmpdir(), 'fh2-ide-test-'))
  const workspace = join(base, 'workspace')
  const webRoot = join(base, 'web')
  let server: IdeServer
  let token: string

  const api = async (path: string, init: RequestInit = {}): Promise<Response> =>
    await fetch(`${server.url}${path}`, {
      ...init,
      headers: { 'x-fh2-ide-token': token, ...init.headers },
    })

  beforeAll(async () => {
    mkdirSync(join(workspace, 'src/views'), { recursive: true })
    mkdirSync(join(workspace, 'node_modules/left-pad'), { recursive: true })
    mkdirSync(join(workspace, 'dist'), { recursive: true })
    mkdirSync(join(workspace, '.git'), { recursive: true })
    writeFileSync(join(workspace, 'fh2-plugin.json'), '{"id":"exp_ide_demo"}')
    writeFileSync(join(workspace, '.npmrc'), 'registry=https://example.com\n')
    writeFileSync(join(workspace, 'src/plugin.ts'), 'export const plugin = 1\n')
    writeFileSync(join(workspace, 'src/views/panel.ts'), 'export default {}\n')
    writeFileSync(join(workspace, 'src/binary.bin'), Buffer.from([0x01, 0x00, 0x02]))
    writeFileSync(join(workspace, 'node_modules/left-pad/index.js'), 'module.exports = 1\n')
    writeFileSync(join(workspace, 'dist/bundle.js'), 'console.log(1)\n')

    // 工作根外的文件 + 指向它的 symlink：用于验证 realpath 复核确实拦截逃逸。
    writeFileSync(join(base, 'outside-secret.txt'), 'SECRET')
    // Windows 文件 symlink 需要开发者模式/管理员；逃逸 fixture 仅在 POSIX 创建
    if (process.platform !== 'win32') symlinkSync(join(base, 'outside-secret.txt'), join(workspace, 'escape-link.txt'))

    mkdirSync(join(webRoot, 'assets'), { recursive: true })
    writeFileSync(join(webRoot, 'index.html'), '<html><head><title>ide</title></head><body>ide</body></html>')
    writeFileSync(join(webRoot, 'assets/main.js'), 'console.log("ide")')

    server = await startIdeServer({ root: workspace, webRoot, port: 0, watch: false })
    token = server.token
  })

  afterAll(async () => server?.close())

  it('只监听 loopback 并生成 32 字节 hex token', () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(server.token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('缺失或错误的 token 一律 401 且返回契约错误结构', async () => {
    for (const headers of [{}, { 'x-fh2-ide-token': 'wrong' }, { 'x-fh2-ide-token': 'a'.repeat(64) }]) {
      const response = await fetch(`${server.url}/api/workspace`, { headers })
      expect(response.status).toBe(401)
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
      expect(await response.json()).toEqual({
        schemaVersion: 1,
        ok: false,
        error: { code: 'FH2_IDE_UNAUTHORIZED', message: expect.stringContaining('token') },
      })
    }
  })

  it('sSE 用 query token 而非请求头鉴权', async () => {
    const rejected = await fetch(`${server.url}/api/events`)
    expect(rejected.status).toBe(401)
    expect((await rejected.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_UNAUTHORIZED')

    // 带正确 token 时应拿到 event-stream；读到首个 chunk 后立即断开。
    const controller = new AbortController()
    const accepted = await fetch(`${server.url}/api/events?token=${token}`, { signal: controller.signal })
    expect(accepted.status).toBe(200)
    expect(accepted.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    controller.abort()
  })

  it('gET /api/workspace 返回工作根与上下文类型', async () => {
    const body = await (await api('/api/workspace')).json() as IdeEnvelope<{
      root: string;
      name: string;
      kind: string;
      toolchainVersion: string;
      diagnostics: unknown[];
    }>
    expect(body.schemaVersion).toBe(1)
    expect(body.ok).toBe(true)
    expect(body.data).toMatchObject({ root: workspace, name: 'workspace', kind: 'frontend-plugin' })
    expect(body.data?.diagnostics).toEqual([])
    expect(body.data?.toolchainVersion).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('gET /api/tree 过滤忽略项、目录在前、路径为 POSIX 相对路径', async () => {
    const body = await (await api('/api/tree')).json() as IdeEnvelope<IdeTreeData>
    const tree = body.data!.tree
    expect(body.data!.truncated).toBe(false)

    const names = tree.map(node => node.name)
    // .git 仍然隐藏；node_modules/dist 可见但置灰（generated + 空 children，不递归）
    expect(names).not.toContain('.git')
    expect(names).toContain('.npmrc')
    const nodeModules = tree.find(node => node.name === 'node_modules') as Extract<IdeTreeNode, { kind: 'dir' }>
    expect(nodeModules.generated).toBe(true)
    expect(nodeModules.children).toEqual([])
    const distDir = tree.find(node => node.name === 'dist') as Extract<IdeTreeNode, { kind: 'dir' }>
    expect(distDir.generated).toBe(true)
    expect(distDir.children).toEqual([])
    // 目录在前、文件在后
    expect(tree.findIndex(node => node.kind === 'file')).toBeGreaterThan(tree.findIndex(node => node.kind === 'dir'))

    const src = tree.find(node => node.name === 'src') as Extract<IdeTreeNode, { kind: 'dir' }>
    expect(src.path).toBe('src')
    expect(src.children.map(child => child.path)).toContain('src/plugin.ts')
    const views = src.children.find(child => child.name === 'views') as Extract<IdeTreeNode, { kind: 'dir' }>
    expect(views.children[0]?.path).toBe('src/views/panel.ts')
    const pluginFile = src.children.find(child => child.name === 'plugin.ts')
    expect(pluginFile).toMatchObject({ kind: 'file', size: 'export const plugin = 1\n'.length })
  })

  it('gET /api/tree/children 惰性拉取单层子树（生成目录展开）', async () => {
    const body = await (await api('/api/tree/children?path=node_modules')).json() as IdeEnvelope<IdeTreeChildrenData>
    expect(body.ok).toBe(true)
    expect(body.data?.path).toBe('node_modules')
    // fixture: node_modules/left-pad/index.js —— 单层只出 left-pad 目录（不递归）
    const leftPad = body.data?.children.find(child => child.name === 'left-pad') as Extract<IdeTreeNode, { kind: 'dir' }>
    expect(leftPad?.path).toBe('node_modules/left-pad')
    expect(leftPad?.children).toEqual([])

    const bundle = await (await api('/api/tree/children?path=dist')).json() as IdeEnvelope<IdeTreeChildrenData>
    expect(bundle.data?.children.map(child => child.path)).toEqual(['dist/bundle.js'])

    // 非目录 / 不存在 / 逃逸一律拒绝
    const notDir = await api('/api/tree/children?path=fh2-plugin.json')
    expect(notDir.status).toBe(404)
    const missing = await api('/api/tree/children?path=no-such-dir')
    expect(missing.status).toBe(404)
    const escape = await api('/api/tree/children?path=../outside')
    expect(escape.status).toBe(400)
  })

  it.each([
    ['绝对路径', '/etc/passwd'],
    ['父目录逃逸', '../outside-secret.txt'],
    ['深层逃逸', 'src/../../outside-secret.txt'],
    // Windows 文件 symlink 需要开发者模式，逃逸 fixture 不存在，跳过该行
    ...(process.platform === 'win32' ? [] : [['symlink 逃逸', 'escape-link.txt']]),
  ])('gET /api/file 拒绝%s', async (_name, path) => {
    const response = await api(`/api/file?path=${encodeURIComponent(path)}`)
    expect(response.status).toBe(400)
    const body = await response.json() as IdeEnvelope<never>
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe('FH2_IDE_PATH_ESCAPE')
    // 逃逸请求绝不能泄漏工作根外内容
    expect(JSON.stringify(body)).not.toContain('SECRET')
  })

  it('gET /api/file 读文本（附内容 revision）、拒绝二进制与不存在的文件', async () => {
    const ok = await (await api('/api/file?path=src/plugin.ts')).json() as IdeEnvelope<IdeFileData>
    expect(ok.data).toMatchObject({ path: 'src/plugin.ts', content: 'export const plugin = 1\n', encoding: 'utf-8' })
    // F2：revision 是内容 sha256，保存时回传为 expectedRevision。
    expect(ok.data?.revision).toMatch(/^[0-9a-f]{64}$/)

    const binary = await api('/api/file?path=src/binary.bin')
    expect(binary.status).toBe(400)
    expect((await binary.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_NOT_A_FILE')

    const missing = await api('/api/file?path=src/nope.ts')
    expect(missing.status).toBe(404)
    expect((await missing.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_NOT_FOUND')

    const noParam = await api('/api/file')
    expect(noParam.status).toBe(400)
    expect((await noParam.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_BAD_REQUEST')
  })

  it('pUT /api/file 校验 expectedRevision 后原子写入，冲突返回磁盘快照', async () => {
    // F2：先读取拿 revision，再带 expectedRevision 写入。
    const before = await (await api('/api/file?path=src/plugin.ts')).json() as IdeEnvelope<IdeFileData>
    const content = 'export const plugin = 2\n'
    const written = await (await api('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/plugin.ts', content, expectedRevision: before.data!.revision }),
    })).json() as IdeEnvelope<IdeWriteData>

    expect(written.ok).toBe(true)
    expect(written.data).toMatchObject({ path: 'src/plugin.ts', bytesWritten: Buffer.byteLength(content) })
    expect(written.data?.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(join(workspace, 'src/plugin.ts'), 'utf8')).toBe(content)

    const roundtrip = await (await api('/api/file?path=src/plugin.ts')).json() as IdeEnvelope<IdeFileData>
    expect(roundtrip.data?.content).toBe(content)

    // 外部修改后用旧 revision 写入 → 409 + 当前磁盘快照。
    writeFileSync(join(workspace, 'src/plugin.ts'), 'export const plugin = 999\n')
    const conflictResponse = await api('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/plugin.ts', content: 'export const plugin = 3\n', expectedRevision: written.data!.revision }),
    })
    expect(conflictResponse.status).toBe(409)
    const conflict = await conflictResponse.json() as IdeEnvelope<never> & { conflict?: { disk: { content: string } } }
    expect(conflict.error?.code).toBe('FH2_FILE_CONFLICT')
    expect(conflict.conflict?.disk.content).toBe('export const plugin = 999\n')

    const tree = await (await api('/api/tree')).json() as IdeEnvelope<IdeTreeData>
    const src = tree.data!.tree.find(node => node.name === 'src') as Extract<IdeTreeNode, { kind: 'dir' }>
    expect(src.children.some(child => child.name.endsWith('.fh2-ide-tmp'))).toBe(false)
  })

  it('pUT /api/file 拒绝逃逸、非法 body 与不存在的父目录', async () => {
    const escape = await api('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '../escaped.txt', content: 'x' }),
    })
    expect(escape.status).toBe(400)
    expect((await escape.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_PATH_ESCAPE')

    const badContent = await api('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/plugin.ts', content: 42 }),
    })
    expect(badContent.status).toBe(400)
    expect((await badContent.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_BAD_REQUEST')

    const badJson = await api('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(badJson.status).toBe(400)
    expect((await badJson.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_BAD_REQUEST')

    const missingParent = await api('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'no/such/dir/file.ts', content: 'x' }),
    })
    expect(missingParent.status).toBe(404)
    expect((await missingParent.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_NOT_FOUND')
  })

  it('pOST /api/validate 外层 ok 恒为 true，校验结论在 data.ok', async () => {
    const response = await api('/api/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as IdeEnvelope<IdeValidateData>
    expect(body.schemaVersion).toBe(1)
    // 接口成功 ≠ 校验通过：fixture 的 Manifest 是残缺的，data.ok 必须为 false。
    expect(body.ok).toBe(true)
    expect(body.data!.ok).toBe(false)
    expect(typeof body.data!.durationMs).toBe('number')
    expect(body.data!.diagnostics.length).toBeGreaterThan(0)
    for (const diagnostic of body.data!.diagnostics) {
      expect(diagnostic).toMatchObject({
        code: expect.stringMatching(/^FH2_/),
        phase: expect.stringMatching(/^(?:parse|schema|semantic|contract|code)$/),
        file: expect.any(String),
        message: expect.any(String),
        severity: expect.stringMatching(/^(?:error|warning)$/),
      })
    }
  })

  it('pOST /api/validate 的 path 参数同样受路径安全约束', async () => {
    const response = await api('/api/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '../..' }),
    })
    expect(response.status).toBe(400)
    expect((await response.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_PATH_ESCAPE')
  })

  it('gET /api/schemas 内联返回真实 Schema 与 fileMatch', async () => {
    const body = await (await api('/api/schemas')).json() as IdeEnvelope<{
      schemas: { uri: string; fileMatch: string[]; schema: Record<string, unknown> }[];
    }>
    const schemas = body.data!.schemas
    expect(schemas.map(entry => entry.uri)).toEqual([
      'fh2://schema/manifest',
      'fh2://schema/backend-plugin',
      'fh2://schema/workflow',
      'fh2://schema/capability-metadata',
    ])
    expect(schemas[0]!.fileMatch).toEqual([`${workspace}/fh2-plugin.json`])
    expect(schemas[1]!.fileMatch).toEqual([])
    // 当前 fixture 是纯前端插件：Workflow Schema 只绑定真实后端成员，不能把
    // 前端目录里偶然出现的 workflows/ 误认成 Worker Workflow。
    expect(schemas[2]!.fileMatch).toEqual([])
    expect(schemas[3]!.fileMatch).toEqual([])
    // 内联的必须是真 Schema，不是占位符
    for (const entry of schemas) expect(entry.schema).toHaveProperty('type')
    expect(schemas[0]!.schema).toHaveProperty('properties.id')
  })

  it('gET /api/actions 返回受审词表与本工程脚本（契约 §9 的节点菜单）', async () => {
    const body = await (await api('/api/actions')).json() as IdeEnvelope<{
      fixedSteps: { action: string; inputs: { name: string; required?: boolean }[] }[];
      scripts: { id: string }[];
      runRoot: string[];
      scriptAction: string;
      stepStates: string[];
      pluginManifestFound: boolean;
    }>
    const data = body.data!
    // 节点菜单的骨架：固定步骤 + 三个根 + 五终态
    expect(data.fixedSteps.map(step => step.action)).toContain('dispatch_mission')
    expect(data.runRoot).toEqual(['now', 'idempotencyKey', 'intervalSec'])
    expect(data.stepStates).toContain('timedOut')
    expect(data.scriptAction).toBe('run_script')
    // 必填信息必须过得来，否则画布画不出「必填未接线」的红点
    const dispatch = data.fixedSteps.find(step => step.action === 'dispatch_mission')
    expect(dispatch?.inputs.some(field => field.name === 'waylineUuid' && field.required === true)).toBe(true)
  })

  it('pOST /api/fs/create 新建文件与目录，父目录缺失 404、已存在 409', async () => {
    const created = await api('/api/fs/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/views/new-panel.ts', kind: 'file', content: 'export default 1\n' }),
    })
    expect(created.status).toBe(200)
    expect((await created.json() as IdeEnvelope<IdeFsCreateData>).data)
      .toEqual({ path: 'src/views/new-panel.ts', kind: 'file' })
    expect(readFileSync(join(workspace, 'src/views/new-panel.ts'), 'utf8')).toBe('export default 1\n')

    // content 缺省 = 空文件
    const empty = await api('/api/fs/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/views/empty.ts', kind: 'file' }),
    })
    expect(empty.status).toBe(200)
    expect(readFileSync(join(workspace, 'src/views/empty.ts'), 'utf8')).toBe('')

    const directory = await api('/api/fs/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/widgets', kind: 'dir' }),
    })
    expect((await directory.json() as IdeEnvelope<IdeFsCreateData>).data)
      .toEqual({ path: 'src/widgets', kind: 'dir' })

    // 不自动创建多级目录
    const missingParent = await api('/api/fs/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'no/such/dir/file.ts', kind: 'file' }),
    })
    expect(missingParent.status).toBe(404)
    expect((await missingParent.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_NOT_FOUND')

    for (const path of ['src/views/new-panel.ts', 'src/widgets']) {
      const conflict = await api('/api/fs/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, kind: 'file' }),
      })
      expect(conflict.status).toBe(409)
      expect((await conflict.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_ALREADY_EXISTS')
    }

    const badKind = await api('/api/fs/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/x.ts', kind: 'symlink' }),
    })
    expect(badKind.status).toBe(400)
    expect((await badKind.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_BAD_REQUEST')
  })

  it('pOST /api/fs/delete 删文件与空目录，非空目录需显式 recursive', async () => {
    mkdirSync(join(workspace, 'scratch/nested'), { recursive: true })
    writeFileSync(join(workspace, 'scratch/nested/keep.ts'), 'x\n')
    writeFileSync(join(workspace, 'scratch/lonely.ts'), 'y\n')

    const file = await api('/api/fs/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'scratch/lonely.ts' }),
    })
    expect((await file.json() as IdeEnvelope<IdeFsDeleteData>).data)
      .toEqual({ path: 'scratch/lonely.ts', kind: 'file' })
    expect(existsSync(join(workspace, 'scratch/lonely.ts'))).toBe(false)

    // 非空目录不带 recursive → 409，且必须没有删掉任何东西
    const notEmpty = await api('/api/fs/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'scratch' }),
    })
    expect(notEmpty.status).toBe(409)
    expect((await notEmpty.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_NOT_EMPTY')
    expect(existsSync(join(workspace, 'scratch/nested/keep.ts'))).toBe(true)

    // recursive: false 与缺省同义，不能被当成「随便删」
    const explicitFalse = await api('/api/fs/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'scratch', recursive: false }),
    })
    expect(explicitFalse.status).toBe(409)
    expect(existsSync(join(workspace, 'scratch'))).toBe(true)

    const recursive = await api('/api/fs/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'scratch', recursive: true }),
    })
    expect((await recursive.json() as IdeEnvelope<IdeFsDeleteData>).data)
      .toEqual({ path: 'scratch', kind: 'dir' })
    expect(existsSync(join(workspace, 'scratch'))).toBe(false)

    const missing = await api('/api/fs/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'scratch' }),
    })
    expect(missing.status).toBe(404)
    expect((await missing.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_NOT_FOUND')

    // 工作根自身不可删
    const rootItself = await api('/api/fs/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '.' }),
    })
    expect(rootItself.status).toBe(400)
    expect((await rootItself.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_BAD_REQUEST')
  })

  it('pOST /api/fs/rename 支持跨目录移动，目标已存在需显式 overwrite', async () => {
    mkdirSync(join(workspace, 'moves/to'), { recursive: true })
    writeFileSync(join(workspace, 'moves/a.ts'), 'A\n')
    writeFileSync(join(workspace, 'moves/occupied.ts'), 'OCCUPIED\n')

    const renamed = await api('/api/fs/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'moves/a.ts', to: 'moves/to/b.ts' }),
    })
    expect((await renamed.json() as IdeEnvelope<IdeFsRenameData>).data)
      .toEqual({ from: 'moves/a.ts', to: 'moves/to/b.ts' })
    expect(existsSync(join(workspace, 'moves/a.ts'))).toBe(false)
    expect(readFileSync(join(workspace, 'moves/to/b.ts'), 'utf8')).toBe('A\n')

    const conflict = await api('/api/fs/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'moves/to/b.ts', to: 'moves/occupied.ts' }),
    })
    expect(conflict.status).toBe(409)
    expect((await conflict.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_ALREADY_EXISTS')
    // 409 之后源与目标都必须原样保留
    expect(readFileSync(join(workspace, 'moves/occupied.ts'), 'utf8')).toBe('OCCUPIED\n')
    expect(existsSync(join(workspace, 'moves/to/b.ts'))).toBe(true)

    const overwritten = await api('/api/fs/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'moves/to/b.ts', to: 'moves/occupied.ts', overwrite: true }),
    })
    expect(overwritten.status).toBe(200)
    expect(readFileSync(join(workspace, 'moves/occupied.ts'), 'utf8')).toBe('A\n')

    const missingSource = await api('/api/fs/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'moves/nope.ts', to: 'moves/other.ts' }),
    })
    expect(missingSource.status).toBe(404)
    expect((await missingSource.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_NOT_FOUND')

    // to 的父目录必须已存在
    const missingParent = await api('/api/fs/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'moves/occupied.ts', to: 'moves/absent/dir/c.ts' }),
    })
    expect(missingParent.status).toBe(404)
    expect((await missingParent.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_NOT_FOUND')
  })

  it('pOST /api/fs/copy 复制文件与目录、拒绝覆盖与自身嵌套', async () => {
    mkdirSync(join(workspace, 'copies/nested'), { recursive: true })
    writeFileSync(join(workspace, 'copies/a.ts'), 'A\n')
    writeFileSync(join(workspace, 'copies/nested/b.bin'), Buffer.from([0x00, 0x01, 0xFF]))
    writeFileSync(join(workspace, 'copies/occupied.ts'), 'OCCUPIED\n')

    // 文件复制：源保留、内容一致
    const fileCopy = await api('/api/fs/copy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'copies/a.ts', to: 'copies/a-copy.ts' }),
    })
    expect((await fileCopy.json() as IdeEnvelope<IdeFsCopyData>).data)
      .toEqual({ from: 'copies/a.ts', to: 'copies/a-copy.ts' })
    expect(readFileSync(join(workspace, 'copies/a-copy.ts'), 'utf8')).toBe('A\n')
    expect(readFileSync(join(workspace, 'copies/a.ts'), 'utf8')).toBe('A\n')

    // 目录递归复制：二进制字节保真（读写通道走 fs.cp，不经 UTF-8 文本层）
    const dirCopy = await api('/api/fs/copy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'copies/nested', to: 'copies/nested-copy' }),
    })
    expect((await dirCopy.json() as IdeEnvelope<IdeFsCopyData>).data)
      .toEqual({ from: 'copies/nested', to: 'copies/nested-copy' })
    expect(readFileSync(join(workspace, 'copies/nested-copy/b.bin')))
      .toEqual(Buffer.from([0x00, 0x01, 0xFF]))

    // 目标已存在：409，双方原样保留（重名策略由前端决定）
    const conflict = await api('/api/fs/copy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'copies/a.ts', to: 'copies/occupied.ts' }),
    })
    expect(conflict.status).toBe(409)
    expect((await conflict.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_ALREADY_EXISTS')
    expect(readFileSync(join(workspace, 'copies/occupied.ts'), 'utf8')).toBe('OCCUPIED\n')
    expect(readFileSync(join(workspace, 'copies/a.ts'), 'utf8')).toBe('A\n')

    // 目录复制进自身：400
    const selfNest = await api('/api/fs/copy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'copies/nested', to: 'copies/nested/inner' }),
    })
    expect(selfNest.status).toBe(400)
    expect((await selfNest.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_BAD_REQUEST')

    // 源不存在：404
    const missing = await api('/api/fs/copy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'copies/nope.ts', to: 'copies/other.ts' }),
    })
    expect(missing.status).toBe(404)
    expect((await missing.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_NOT_FOUND')

    // 工作根自身不可复制
    const rootItself = await api('/api/fs/copy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: '.', to: 'copies/root-clone' }),
    })
    expect(rootItself.status).toBe(400)
    expect((await rootItself.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_BAD_REQUEST')
  })

  it.each([
    ['create', '/api/fs/create', (path: string) => ({ path, kind: 'file' })],
    ['delete', '/api/fs/delete', (path: string) => ({ path })],
  ])('pOST /api/fs/%s 同样拒绝路径逃逸', async (_name, endpoint, makeBody) => {
    for (const path of ['/etc/passwd', '../outside-secret.txt', 'src/../../outside-secret.txt', ...(process.platform === 'win32' ? [] : ['escape-link.txt'])]) {
      const response = await api(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(makeBody(path)),
      })
      expect(response.status).toBe(400)
      const body = await response.json() as IdeEnvelope<never>
      expect(body.error?.code).toBe('FH2_IDE_PATH_ESCAPE')
      expect(JSON.stringify(body)).not.toContain('SECRET')
    }
    // 工作根外的文件绝不能被这些操作改到
    expect(readFileSync(join(base, 'outside-secret.txt'), 'utf8')).toBe('SECRET')
  })

  it('pOST /api/fs/rename 对 from 与 to 各自独立做路径安全校验', async () => {
    writeFileSync(join(workspace, 'renamable.ts'), 'R\n')

    const escapingFrom = await api('/api/fs/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: '../outside-secret.txt', to: 'stolen.txt' }),
    })
    expect(escapingFrom.status).toBe(400)
    expect((await escapingFrom.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_PATH_ESCAPE')
    expect(existsSync(join(workspace, 'stolen.txt'))).toBe(false)

    // from 合法、to 逃逸：只校验一侧就会把工作根内的文件搬到根外
    const escapingTo = await api('/api/fs/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'renamable.ts', to: '../escaped.ts' }),
    })
    expect(escapingTo.status).toBe(400)
    expect((await escapingTo.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_PATH_ESCAPE')
    expect(existsSync(join(workspace, 'renamable.ts'))).toBe(true)
    expect(existsSync(join(base, 'escaped.ts'))).toBe(false)

    const absoluteTo = await api('/api/fs/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'renamable.ts', to: '/tmp/fh2-ide-escaped.ts' }),
    })
    expect(absoluteTo.status).toBe(400)
    expect((await absoluteTo.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_PATH_ESCAPE')

    const missingTo = await api('/api/fs/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'renamable.ts' }),
    })
    expect(missingTo.status).toBe(400)
    const missingBody = await missingTo.json() as IdeEnvelope<never>
    expect(missingBody.error?.code).toBe('FH2_IDE_BAD_REQUEST')
    // 报错文案要指向真实入参名，而不是 v1 的 path
    expect(missingBody.error?.message).toContain('to')
  })

  it('gET /api/workspace/recent 启动即包含当前工作根', async () => {
    const body = await (await api('/api/workspace/recent')).json() as IdeEnvelope<IdeRecentData>
    expect(body.ok).toBe(true)
    expect(body.data!.roots[0]).toEqual({ root: workspace, name: 'workspace', kind: 'frontend-plugin' })
  })

  it('未知接口与错误方法返回契约错误结构', async () => {
    const unknown = await api('/api/nope')
    expect(unknown.status).toBe(404)
    expect((await unknown.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_NOT_FOUND')

    const wrongMethod = await api('/api/tree', { method: 'POST' })
    expect(wrongMethod.status).toBe(404)
    expect((await wrongMethod.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_NOT_FOUND')

    // v2 端点的方法同样严格：fs/create 只收 POST
    const wrongFsMethod = await api('/api/fs/create')
    expect(wrongFsMethod.status).toBe(404)
    expect((await wrongFsMethod.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_NOT_FOUND')
  })

  it('静态资源不需要 token，首页注入 token 与 base', async () => {
    const index = await fetch(`${server.url}/`)
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const html = await index.text()
    expect(html).toContain(`window.__FH2_IDE_TOKEN__="${token}"`)
    expect(html).toContain('window.__FH2_IDE_BASE__="/"')
    // 注入必须在 </head> 之前，早于任何 bundle script
    expect(html.indexOf('__FH2_IDE_TOKEN__')).toBeLessThan(html.indexOf('</head>'))

    const asset = await fetch(`${server.url}/assets/main.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await asset.text()).toBe('console.log("ide")')
  })

  it('未命中的路径回落 index.html（SPA fallback），且不泄漏 web 根外文件', async () => {
    const fallback = await fetch(`${server.url}/editor/some/deep/route`)
    expect(fallback.status).toBe(200)
    expect(await fallback.text()).toContain('__FH2_IDE_TOKEN__')

    // 逃逸的静态请求同样回落首页，绝不返回工作根外内容
    const escape = await fetch(`${server.url}/../../outside-secret.txt`)
    expect(await escape.text()).not.toContain('SECRET')
  })

  it('sanitizeTaskParams：只放行 string/number/boolean，其余类型丢弃', () => {
    expect(sanitizeTaskParams(undefined)).toEqual({})
    expect(sanitizeTaskParams(null)).toEqual({})
    expect(sanitizeTaskParams([1, 2])).toEqual({})
    expect(sanitizeTaskParams('members=a')).toEqual({})
    expect(sanitizeTaskParams({
      members: 'alpha,alpha/frontend',
      retries: 2,
      noBuild: true,
      nested: { evil: true },
      list: ['a'],
      nil: null,
    })).toEqual({ members: 'alpha,alpha/frontend', retries: 2, noBuild: true })
  })
})

describe('web ide server 工作区切换（契约 7）', () => {
  const base = mkdtempSync(join(tmpdir(), 'fh2-ide-switch-'))
  const first = join(base, 'first-plugin')
  const second = join(base, 'second-capability')
  const damaged = join(base, 'damaged-industry-workspace')
  const plain = join(base, 'not-a-plugin')
  const webRoot = join(base, 'web')
  let server: IdeServer
  let token: string

  const api = async (path: string, init: RequestInit = {}): Promise<Response> =>
    await fetch(`${server.url}${path}`, {
      ...init,
      headers: { 'x-fh2-ide-token': token, ...init.headers },
    })

  const open = async (root: unknown): Promise<Response> =>
    await api('/api/workspace/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root }),
    })

  beforeAll(async () => {
    mkdirSync(join(first, 'src'), { recursive: true })
    writeFileSync(join(first, 'fh2-plugin.json'), '{"id":"exp_first"}')
    writeFileSync(join(first, 'src/first.ts'), 'export const first = 1\n')

    mkdirSync(join(second, 'frontend/exp_second_panel'), { recursive: true })
    writeFileSync(join(second, 'capabilities.json'), '{"name":"second","description":"second capability"}')
    writeFileSync(join(second, 'frontend/exp_second_panel/fh2-plugin.json'), '{"id":"exp_second_panel"}')
    writeFileSync(join(second, 'second-only.ts'), 'export const second = 2\n')

    mkdirSync(join(damaged, 'exp_broken'), { recursive: true })
    writeFileSync(join(damaged, 'packages.json'), JSON.stringify([{
      packageId: 'exp_damaged_package',
      name: 'Damaged',
      capabilityIds: ['exp_broken'],
    }]))
    writeFileSync(join(damaged, 'exp_broken/capabilities.json'), JSON.stringify({
      name: '损坏能力',
      description2: '未知字段',
    }))

    mkdirSync(plain, { recursive: true })
    writeFileSync(join(plain, 'README.md'), 'not a plugin\n')

    mkdirSync(webRoot, { recursive: true })
    writeFileSync(join(webRoot, 'index.html'), '<html><head></head><body>ide</body></html>')

    // watch 开着才能验「切换重建了监听」；close() 里会收掉。
    server = await startIdeServer({ root: first, webRoot, port: 0 })
    token = server.token
  })

  afterAll(async () => server?.close())

  it('切换工作根后 workspace、tree 与 file 全部落在新工程上', async () => {
    const before = await (await api('/api/workspace')).json() as IdeEnvelope<IdeWorkspaceData>
    expect(before.data).toMatchObject({ root: first, kind: 'frontend-plugin' })

    const switched = await open(second)
    expect(switched.status).toBe(200)
    const body = await switched.json() as IdeEnvelope<IdeWorkspaceData>
    // 回包结构与 GET /api/workspace 完全一致（契约 7.1）
    expect(body.data).toMatchObject({ root: second, name: 'second-capability', kind: 'capability-project' })
    expect(body.data?.toolchainVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(server.root).toBe(second)

    const after = await (await api('/api/workspace')).json() as IdeEnvelope<IdeWorkspaceData>
    expect(after.data).toMatchObject({ root: second, kind: 'capability-project' })

    const tree = await (await api('/api/tree')).json() as IdeEnvelope<IdeTreeData>
    const names = tree.data!.tree.map(node => node.name)
    expect(names).toContain('second-only.ts')
    expect(names).not.toContain('src')

    // 旧工程的相对路径在新工作根下应当不存在，而不是照旧读到旧文件
    const stale = await api('/api/file?path=src/first.ts')
    expect(stale.status).toBe(404)

    const fresh = await (await api('/api/file?path=second-only.ts')).json() as IdeEnvelope<IdeFileData>
    expect(fresh.data?.content).toBe('export const second = 2\n')
  })

  it('f5：旧会话的写入被拒绝（FH2_IDE_SESSION_EXPIRED），新会话正常', async () => {
    // 前序用例已切到 second；这里先切回 first 再切到 second，制造两个会话。
    await open(first)
    const firstWorkspace = await (await api('/api/workspace')).json() as IdeEnvelope<{ sessionId: string }>
    const staleSession = firstWorkspace.data!.sessionId

    const switched = await open(second)
    expect(switched.status).toBe(200)
    const secondWorkspace = await (await api('/api/workspace')).json() as IdeEnvelope<{ sessionId: string }>
    expect(secondWorkspace.data!.sessionId).not.toBe(staleSession)

    // 迟到写入（旧会话 id）被拒绝，不落在新工程上。
    const staleWrite = await api('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-fh2-ide-session': staleSession },
      body: JSON.stringify({ path: 'second-only.ts', content: 'stale\n', expectedRevision: '' }),
    })
    expect(staleWrite.status).toBe(409)
    expect((await staleWrite.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_SESSION_EXPIRED')
    expect(readFileSync(join(second, 'second-only.ts'), 'utf8')).not.toBe('stale\n')

    // 新会话的写入正常（新文件不需要 expectedRevision）。
    const freshWrite = await api('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-fh2-ide-session': secondWorkspace.data!.sessionId },
      body: JSON.stringify({ path: 'created-by-new-session.ts', content: 'ok\n' }),
    })
    expect(freshWrite.status).toBe(200)
  })

  it('切换会重建文件监听：新工作根的变更能推到 SSE，旧工作根的不会', async () => {
    const events = await openSseEvents(`${server.url}/api/events?token=${token}`)
    try {
      // chokidar 重建后要先扫一遍目录才开始报事件，写一次可能落在 ready 之前；
      // 反复写到事件到达为止，比 sleep 一个魔法值稳。
      const fsEvent = await events.waitFor(entry => entry.event === 'fs'
        && (entry.data as { path?: string }).path === 'watched.ts', 20_000, () => {
        writeFileSync(join(first, 'src/first.ts'), `export const first = ${Date.now()}\n`)
        writeFileSync(join(second, 'watched.ts'), `export const watched = ${Date.now()}\n`)
      })
      expect(fsEvent.data).toMatchObject({ schemaVersion: 1, path: 'watched.ts' })
      // 旧工作根的 watcher 必须已经关掉，不能继续推 src/first.ts
      expect(events.all().some(entry => JSON.stringify(entry.data).includes('src/first.ts'))).toBe(false)
    } finally {
      events.close()
    }
  }, 30_000)

  it('切换时广播 SSE event: workspace', async () => {
    const events = await openSseEvents(`${server.url}/api/events?token=${token}`)
    try {
      expect((await open(first)).status).toBe(200)
      const event = await events.waitFor(entry => entry.event === 'workspace', 5000)
      expect(event.data).toEqual({ schemaVersion: 1, root: first, name: 'first-plugin', kind: 'frontend-plugin' })
    } finally {
      events.close()
    }
  })

  it('gET /api/workspace/recent 按最近打开顺序去重，只在进程内维护', async () => {
    const body = await (await api('/api/workspace/recent')).json() as IdeEnvelope<IdeRecentData>
    expect(body.data!.roots.map(entry => entry.root)).toEqual([first, second])
    expect(body.data!.roots[0]).toEqual({ root: first, name: 'first-plugin', kind: 'frontend-plugin' })
    expect(body.data!.roots[1]).toEqual({ root: second, name: 'second-capability', kind: 'capability-project' })
    // 落盘会让不同 serve 进程互相污染；契约 7.2 明确只要进程内。
    expect(existsSync(join(first, '.fh2-ide-recent.json'))).toBe(false)
  })

  it('配置损坏但有工程标志的工作区仍可打开并返回诊断', async () => {
    const response = await open(damaged)
    expect(response.status).toBe(200)
    const body = await response.json() as IdeEnvelope<IdeWorkspaceData>
    expect(body.data).toMatchObject({
      root: damaged,
      kind: 'industry-capability-workspace',
    })
    expect(body.data?.diagnostics[0]).toMatchObject({
      file: 'exp_broken/capabilities.json',
      severity: 'error',
    })
    expect((await open(first)).status).toBe(200)
  })

  it.each([
    ['不存在的目录', () => join(base, 'nowhere')],
    ['不是插件工程的目录', () => plain],
    ['指向文件而非目录', () => join(plain, 'README.md')],
  ])('切到%s返回 FH2_IDE_ROOT_INVALID 且不动当前工作根', async (_name, target) => {
    const response = await open(target())
    expect(response.status).toBe(400)
    expect((await response.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_ROOT_INVALID')
    expect(server.root).toBe(first)
  })

  it.each([
    ['相对路径', 'second-capability'],
    ['缺参数', undefined],
    ['非字符串', 42],
  ])('root 为%s时返回 FH2_IDE_BAD_REQUEST', async (_name, value) => {
    const response = await open(value)
    expect(response.status).toBe(400)
    expect((await response.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_BAD_REQUEST')
    expect(server.root).toBe(first)
  })
})

describe('web ide server 运行/预览（契约 8）', () => {
  // realpath：macOS 的 /var 是指向 /private/var 的 symlink，子进程 process.cwd()
  // 回来的是真实路径，不折算就对不上。
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'fh2-ide-run-')))
  const workspace = join(base, 'workspace')
  const webRoot = join(base, 'web')
  // 冒充 dist/cli.js：打印 dev 命令的地址行，然后挂住等信号，用于验证真实的
  // spawn → 管道 → kill 链路，而不是把 child_process 整个换成 mock。
  const fakeCli = join(base, 'fake-cli.mjs')
  const failingCli = join(base, 'failing-cli.mjs')
  let server: IdeServer
  let token: string
  let runPort: number

  const api = async (path: string, init: RequestInit = {}): Promise<Response> =>
    await fetch(`${server.url}${path}`, {
      ...init,
      headers: { 'x-fh2-ide-token': token, ...init.headers },
    })

  const post = async <T> (path: string, body: unknown): Promise<IdeEnvelope<T>> =>
    await (await api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })).json() as IdeEnvelope<T>

  beforeAll(async () => {
    runPort = await new Promise<number>((resolvePort, reject) => {
      const listener = createServer()
      listener.once('error', reject)
      listener.listen(0, '127.0.0.1', () => {
        const address = listener.address() as { port: number }
        listener.close(() => resolvePort(address.port))
      })
    })
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'fh2-plugin.json'), '{"id":"exp_run_demo"}')
    mkdirSync(webRoot, { recursive: true })
    writeFileSync(join(webRoot, 'index.html'), '<html><head></head><body>ide</body></html>')
    writeFileSync(
      fakeCli,
      `process.on('message', input => { process.stdout.write('input=' + JSON.stringify(input) + '\\n'); process.send({ type: 'ready', url: 'http://127.0.0.1:5175' }) })\n`
      + `process.stdout.write('cwd=' + process.cwd() + '\\n')\n`
      + `process.stdout.write('\\u2713 Workbench 已启动：http://127.0.0.1:5175\\n')\n`
      + `process.stderr.write('warn: fake stderr line\\n')\n`
      + `setInterval(() => undefined, 1000)\n`,
    )
    writeFileSync(failingCli, `process.stderr.write('startup boom\\n'); process.exit(7)\n`)

    server = await startIdeServer({
      root: workspace,
      webRoot,
      port: 0,
      watch: false,
      run: { workerEntry: fakeCli, killGraceMs: 1000 },
    })
    token = server.token
  })

  afterAll(async () => server?.close())

  it('gET /api/run/status 初始为空列表', async () => {
    const body = await (await api('/api/run/status')).json() as IdeEnvelope<IdeRunStatusData>
    expect(body.ok).toBe(true)
    expect(body.data).toEqual({ processes: [] })
  })

  it('gET /api/run/targets 返回当前可运行根', async () => {
    const body = await (await api('/api/run/targets')).json() as IdeEnvelope<IdeRunTargetsData>
    expect(body.data?.targets).toEqual([{
      projectPath: '.',
      label: 'workspace',
      kind: 'frontend-plugin',
      modes: ['dev', 'preview'],
    }])
  })

  it('start → running → stop 的完整生命周期，日志走 run-log', async () => {
    const events = await openSseEvents(`${server.url}/api/events?token=${token}`)
    try {
      const started = await post<IdeRunStartData>('/api/run/start', { mode: 'dev', port: runPort })
      expect(started.ok).toBe(true)
      // start 只表示已受理；dev 的端口由我们指定，所以地址可以立刻回
      expect(started.data).toEqual({ mode: 'dev', status: 'starting', projectPath: '.' })

      const running = await events.waitFor(
        entry => entry.event === 'run' && (entry.data as { status: string }).status === 'running',
        5000,
      )
      expect(running.data).toEqual({
        schemaVersion: 1,
        mode: 'dev',
        status: 'running',
        url: 'http://127.0.0.1:5175',
        projectPath: '.',
      })

      const status = await (await api('/api/run/status')).json() as IdeEnvelope<IdeRunStatusData>
      expect(status.data!.processes).toHaveLength(1)
      expect(status.data!.processes[0]).toMatchObject({
        mode: 'dev',
        status: 'running',
        url: 'http://127.0.0.1:5175',
      })
      expect(typeof status.data!.processes[0]!.since).toBe('number')

      // 子进程输出按行推成 run-log，stdout / stderr 都要有
      const logs = events.all().filter(entry => entry.event === 'run-log')
        .map(entry => entry.data as { mode: string; stream: string; line: string })
      expect(logs.some(log => log.stream === 'stdout' && log.line.includes('input='))).toBe(true)
      expect(logs.some(log => log.stream === 'stdout' && log.line.includes(`cwd=${workspace}`))).toBe(true)
      expect(logs.some(log => log.stream === 'stderr' && log.line.includes('fake stderr line'))).toBe(true)
      for (const log of logs) expect(log.mode).toBe('dev')

      const tail = await (await api('/api/run/logs?mode=dev')).json() as IdeEnvelope<IdeRunLogsData>
      expect(tail.data?.lines.some(line => line.line.includes('启动目标：.'))).toBe(true)
      expect(tail.data?.lines.every(line => typeof line.sequence === 'number')).toBe(true)

      const stopped = await post<IdeRunStopData>('/api/run/stop', { mode: 'dev' })
      expect(stopped.data).toEqual({ mode: 'dev', status: 'stopped' })

      await events.waitFor(entry => entry.event === 'run' && (entry.data as { status: string }).status === 'stopped', 5000)
      // 主动 stop 不该被报成 failed
      const runEvents = events.all().filter(entry => entry.event === 'run')
        .map(entry => (entry.data as { status: string }).status)
      expect(runEvents).toContain('stopped')
      expect(runEvents).not.toContain('failed')

      const afterStop = await (await api('/api/run/status')).json() as IdeEnvelope<IdeRunStatusData>
      expect(afterStop.data).toEqual({ processes: [] })
    } finally {
      events.close()
    }
  })

  it('同 mode 重复 start 返回 FH2_IDE_PROCESS_RUNNING，stop 后可再 start', async () => {
    try {
      expect((await post<IdeRunStartData>('/api/run/start', { mode: 'dev', port: runPort })).ok).toBe(true)

      const conflict = await api('/api/run/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'dev', port: runPort }),
      })
      expect(conflict.status).toBe(409)
      expect((await conflict.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_PROCESS_RUNNING')

      expect((await post<IdeRunStopData>('/api/run/stop', { mode: 'dev' })).ok).toBe(true)
      expect((await post<IdeRunStartData>('/api/run/start', { mode: 'dev', port: runPort })).data?.status).toBe('starting')
    } finally {
      await post<IdeRunStopData>('/api/run/stop', { mode: 'dev' })
    }
  })

  it('stop 对没在跑的 mode 是幂等的', async () => {
    const first = await post<IdeRunStopData>('/api/run/stop', { mode: 'preview' })
    expect(first.data).toEqual({ mode: 'preview', status: 'stopped' })
    const again = await post<IdeRunStopData>('/api/run/stop', { mode: 'preview' })
    expect(again.data).toEqual({ mode: 'preview', status: 'stopped' })
  })

  it('外层工程只有一个 Capability 时自动选择实际执行根', async () => {
    const outer = join(base, 'outer-workspace')
    const capability = join(outer, 'exp_nested')
    mkdirSync(capability, { recursive: true })
    writeFileSync(join(capability, 'capabilities.json'), JSON.stringify({ name: 'Nested', description: 'Nested test' }))
    mkdirSync(join(capability, 'frontend', 'exp_nested_ui'), { recursive: true })
    writeFileSync(join(capability, 'frontend', 'exp_nested_ui', 'fh2-plugin.json'), JSON.stringify({ id: 'exp_nested_ui', entry: './src/plugin.ts', extensions: [] }))
    const scoped = await startIdeServer({ root: outer, webRoot, port: 0, watch: false, run: { workerEntry: fakeCli, killGraceMs: 1000 } })
    const scopedApi = async (path: string, init: RequestInit = {}): Promise<Response> => await fetch(`${scoped.url}${path}`, {
      ...init,
      headers: { 'x-fh2-ide-token': scoped.token, 'content-type': 'application/json', ...init.headers },
    })
    try {
      const targets = await (await scopedApi('/api/run/targets')).json() as IdeEnvelope<IdeRunTargetsData>
      expect(targets.data?.targets.map(target => target.projectPath)).toEqual(['exp_nested'])
      const started = await (await scopedApi('/api/run/start', { method: 'POST', body: JSON.stringify({ mode: 'dev', port: runPort }) })).json() as IdeEnvelope<IdeRunStartData>
      expect(started.data).toMatchObject({ status: 'starting', projectPath: 'exp_nested' })
      await waitForValue(async () => {
        const status = await (await scopedApi('/api/run/status')).json() as IdeEnvelope<IdeRunStatusData>
        return status.data?.processes[0]?.status === 'running' ? status.data.processes[0] : undefined
      }, 5000)
    } finally {
      await scopedApi('/api/run/stop', { method: 'POST', body: JSON.stringify({ mode: 'dev' }) })
      await scoped.close()
    }
  })

  it('worker 快速失败时 diagnostic、stderr 与失败详情都可见', async () => {
    const scoped = await startIdeServer({ root: workspace, webRoot, port: 0, watch: false, run: { workerEntry: failingCli } })
    const scopedApi = async (path: string, init: RequestInit = {}): Promise<Response> => await fetch(`${scoped.url}${path}`, {
      ...init,
      headers: { 'x-fh2-ide-token': scoped.token, 'content-type': 'application/json', ...init.headers },
    })
    try {
      const started = await (await scopedApi('/api/run/start', { method: 'POST', body: JSON.stringify({ mode: 'dev', port: runPort }) })).json() as IdeEnvelope<IdeRunStartData>
      expect(started.ok).toBe(true)
      await waitForValue(async () => {
        const status = await (await scopedApi('/api/run/status')).json() as IdeEnvelope<IdeRunStatusData>
        return status.data?.processes[0]?.status === 'failed' ? status.data.processes[0] : undefined
      }, 5000)
      const status = await (await scopedApi('/api/run/status')).json() as IdeEnvelope<IdeRunStatusData>
      expect(status.data?.processes[0]).toMatchObject({ status: 'failed', detail: expect.stringContaining('异常退出') })
      const logs = await (await scopedApi('/api/run/logs')).json() as IdeEnvelope<IdeRunLogsData>
      expect(logs.data?.lines.some(line => line.stream === 'stderr' && line.line.includes('startup boom'))).toBe(true)
      expect(logs.data?.lines.some(line => line.line.includes('FH2_TASK_EXECUTOR_FAILED'))).toBe(true)
    } finally {
      await scoped.close()
    }
  })

  it('preview 必须显式带完整 HTTP target，HTTPS 和不完整 URL 不调度本地任务', async () => {
    const start = vi.spyOn((await import('./task-bridge.js')).IdeTaskBridge.prototype, 'start')
    try {
      for (const body of [
        { mode: 'preview' },
        { mode: 'preview', target: '' },
        { mode: 'preview', target: 'not-a-url' },
        { mode: 'preview', target: 'file:///etc/passwd' },
        { mode: 'preview', target: 'https://user:pass@fh2.example.com' },
        { mode: 'preview', target: 'https://fh2.example.com/project?org=1' },
        { mode: 'preview', target: 'http:fh2.example.com' },
        { mode: 'preview', target: 'http:///fh2.example.com/project' },
        { mode: 'preview', target: 'http://user:pass@fh2.example.com' },
      ]) {
        const response = await api('/api/run/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        expect(response.status).toBe(400)
        expect((await response.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_BAD_REQUEST')
      }
      expect(start).not.toHaveBeenCalled()
      const status = await (await api('/api/run/status')).json() as IdeEnvelope<IdeRunStatusData>
      expect(status.data!.processes.some(entry => entry.mode === 'preview')).toBe(false)
    } finally {
      start.mockRestore()
      await post<IdeRunStopData>('/api/run/stop', { mode: 'preview' })
    }
  })

  it('preview 只透传前端预览参数，不含任何发布后端资产的开关', async () => {
    const events = await openSseEvents(`${server.url}/api/events?token=${token}`)
    try {
      // 请求体里塞进「看起来能发后端」的字段，服务端必须一概忽略
      const started = await post<IdeRunStartData>('/api/run/start', {
        mode: 'preview',
        target: 'http://fh2.example.com/project?org=1#/team',
        publishBackend: true,
        includeBackend: true,
        backend: true,
      })
      expect(started.data?.mode).toBe('preview')

      const argv = await events.waitFor(
        entry => entry.event === 'run-log' && (entry.data as { line: string }).line.startsWith('input='),
        5000,
      )
      const line = (argv.data as { line: string }).line
      expect(JSON.parse(line.slice('input='.length))).toMatchObject({ kind: 'preview', params: { target: 'http://fh2.example.com/project?org=1#/team' } })
      for (const forbidden of ['--backend', '--publish', 'includeBackend', 'publishBackend']) {
        expect(line).not.toContain(forbidden)
      }
    } finally {
      events.close()
      await post<IdeRunStopData>('/api/run/stop', { mode: 'preview' })
    }
  })

  it.each([
    ['缺 mode', {}],
    ['未知 mode', { mode: 'build' }],
    ['非法 port', { mode: 'dev', port: -1 }],
    ['非整数 port', { mode: 'dev', port: 'auto' }],
  ])('start 参数%s时返回 FH2_IDE_BAD_REQUEST', async (_name, body) => {
    const response = await api('/api/run/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(400)
    expect((await response.json() as IdeEnvelope<never>).error?.code).toBe('FH2_IDE_BAD_REQUEST')
  })

  it('serve 关闭时杀掉仍在运行的子进程', { timeout: 15_000 }, async () => {
    const scoped = await startIdeServer({
      root: workspace,
      webRoot,
      port: 0,
      watch: false,
      run: { workerEntry: fakeCli, killGraceMs: 1000 },
    })
    try {
      const started = await (await fetch(`${scoped.url}/api/run/start`, {
        method: 'POST',
        headers: { 'x-fh2-ide-token': scoped.token, 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'dev', port: runPort }),
      })).json() as IdeEnvelope<IdeRunStartData>
      expect(started.ok).toBe(true)
      const pid = await waitForChildPid(scoped, workspace)
      expect(isProcessAlive(pid)).toBe(true)

      await scoped.close()
      // close() 必须等到子进程真的走完，不能留孤儿继续占端口
      expect(isProcessAlive(pid)).toBe(false)
    } finally {
      await scoped.close()
    }
  })
})

/** 从 run-log 里捞子进程 pid：fake cli 没打印 pid，用进程表反查更可靠。 */
async function waitForChildPid (server: IdeServer, cwd: string): Promise<number> {
  const deadline = Date.now() + 5000
  for (;;) {
    const found = findFakeCliPid(cwd)
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error(`未在 5s 内发现 ${server.url} 启动的子进程`)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
}

function findFakeCliPid (cwd: string): number | undefined {
  // Windows 无 ps 命令；用 PowerShell 枚举 node 进程，输出与 ps 相同的「pid 命令行」行格式
  const output = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'], { encoding: 'utf8' }).stdout ?? ''
    : spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).stdout ?? ''
  for (const line of output.split('\n')) {
    if (!line.includes('fake-cli.mjs') || !line.includes(join(cwd, '..', 'fake-cli.mjs'))) continue
    const pid = Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10)
    if (Number.isInteger(pid)) return pid
  }
  return undefined
}

function isProcessAlive (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForValue<T> (predicate: () => T | undefined | Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
}

interface SseEntry {
  readonly event: string;
  readonly data: unknown;
}

/**
 * 读 SSE 流并累积事件。
 *
 * 断言不能假设「事件已经到了」——SSE 是异步推送，所以提供 waitFor 轮询已收到的
 * 队列，而不是读一次就下结论。
 */
async function openSseEvents (url: string): Promise<{
  all: () => readonly SseEntry[];
  waitFor: (
    predicate: (entry: SseEntry) => boolean,
    timeoutMs: number,
    poke?: () => void,
  ) => Promise<SseEntry>;
  close: () => void;
}> {
  const controller = new AbortController()
  const entries: SseEntry[] = []
  const response = await fetch(url, { signal: controller.signal })
  if (response.body === null) throw new Error('SSE 响应没有 body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const event = /^event: (.+)$/m.exec(frame)?.[1]
          const data = /^data: (.+)$/m.exec(frame)?.[1]
          if (event !== undefined && data !== undefined) entries.push({ event, data: JSON.parse(data) })
          boundary = buffer.indexOf('\n\n')
        }
      }
    } catch {
      // abort 或服务端断开：累积到的事件已经够用了。
    }
  })()

  return {
    all: () => [...entries],
    async waitFor (predicate, timeoutMs, poke) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = entries.find(predicate)
        if (found !== undefined) return found
        if (Date.now() > deadline) {
          throw new Error(`等待 SSE 事件超时；已收到：${entries.map(entry => entry.event).join(', ')}`)
        }
        poke?.()
        await new Promise(resolveWait => setTimeout(resolveWait, 100))
      }
    },
    close: () => controller.abort(),
  }
}

describe('dns rebinding 防护：Host 头校验', () => {
  const base = mkdtempSync(join(tmpdir(), 'fh2-ide-host-'))
  const root = join(base, 'workspace')
  const webRoot = join(base, 'web')
  let server: IdeServer
  beforeAll(async () => {
    mkdirSync(root)
    mkdirSync(webRoot)
    writeFileSync(join(webRoot, 'index.html'), '<html><head></head><body>ok</body></html>')
    server = await startIdeServer({ root, webRoot, port: 0, watch: false })
  })
  afterAll(async () => {
    await server?.close()
    rmSync(base, { recursive: true, force: true })
  })

  function send (path: string, host: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: server.port, path, method: 'GET', headers: { host } }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  it('拒绝非回环 Host，且不回显 token', async () => {
    const response = await send('/', 'evil.example')
    expect(response.status).toBe(403)
    expect(response.body).toContain('FH2_IDE_FORBIDDEN_HOST')
    expect(response.body).not.toContain(server.token)
  })

  it('拒绝端口不一致的 Host', async () => {
    expect((await send('/', `127.0.0.1:${server.port + 1}`)).status).toBe(403)
  })

  it('接受 127.0.0.1 与 localhost 并正常注入 token', async () => {
    for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`]) {
      const response = await send('/', host)
      expect(response.status).toBe(200)
      expect(response.body).toContain(server.token)
    }
  })

  it('api 在 Host 校验阶段就被拒绝（即使请求带合法 token）', async () => {
    expect((await send('/api/workspace', 'evil.example')).status).toBe(403)
  })

  it('websocket upgrade 同样拒绝非回环 Host', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const socket = connect(server.port, '127.0.0.1', () => {
        socket.write('GET /lsp HTTP/1.1\r\nHost: evil.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
      })
      let data = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => {
        data += chunk
      })
      socket.on('close', () => {
        const match = /^HTTP\/1\.1 (\d{3})/.exec(data)
        resolve(match ? Number(match[1]) : 0)
      })
      socket.on('error', reject)
      setTimeout(() => {
        socket.destroy()
        resolve(0)
      }, 3000).unref()
    })
    expect(status).toBe(403)
  })
})

describe('workspace watcher 忽略规则', () => {
  it('忽略 build/pack 的候选与输出目录（.dist.fh2-*、release、dist、.fh2、node_modules）', () => {
    const root = mkdtempSync(join(tmpdir(), 'fh2-watch-ignore-'))
    try {
      writeFileSync(join(root, 'fh2-plugin.json'), '{"id":"exp_watch_ignore"}')
      expect(isWatchIgnored(root, join(root, '.dist.fh2-next-abc123/plugin.js'))).toBe(true)
      expect(isWatchIgnored(root, join(root, '.dist.fh2-backup-abc123/plugin.js'))).toBe(true)
      expect(isWatchIgnored(root, join(root, 'release/exp_package/plugin.zip'))).toBe(true)
      expect(isWatchIgnored(root, join(root, 'frontend/a/dist/plugin.js'))).toBe(true)
      expect(isWatchIgnored(root, join(root, '.fh2/artifacts/task-1/x.zip'))).toBe(true)
      expect(isWatchIgnored(root, join(root, 'node_modules/vue/index.js'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('普通源码路径与同名前缀文件不被误伤', () => {
    const root = process.platform === 'win32' ? 'D:\\proj' : '/proj'
    const at = (relativePath: string) => (process.platform === 'win32' ? `D:\\proj\\${relativePath.replaceAll('/', '\\')}` : `/proj/${relativePath}`)
    expect(isWatchIgnored(root, at('src/views/HelloPanel.vue'))).toBe(false)
    expect(isWatchIgnored(root, at('frontend/a/src/plugin.ts'))).toBe(false)
    expect(isWatchIgnored(root, at('release.md'))).toBe(false)
    expect(isWatchIgnored(root, at('backend/a/workflows/example-flow.json'))).toBe(false)
  })

  it('工作根之外的路径被忽略', () => {
    const root = process.platform === 'win32' ? 'D:\\proj' : '/proj'
    const outside = process.platform === 'win32' ? 'D:\\other\\src\\a.ts' : '/other/src/a.ts'
    expect(isWatchIgnored(root, outside)).toBe(true)
  })
})
