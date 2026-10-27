// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { servePreviewHttpOriginProxy } from '../preview/http-origin-proxy.js'
import { startIdeServer } from '../serve/ide-server.js'
import { resolveIdeActionsWithKnowledge } from '../workflow/service/actions.js'
import { toCatalog } from '../workflow/core/catalog.js'
import { applyJsonEditOps } from '../workflow/core/json-edits.js'
import { defaultScriptPath, prepareCreateScriptAndBind } from '../workflow/core/script-commands.js'
import { CLI_CONTRACT, TOOLING_KNOWLEDGE_PROFILE } from './cli.js'
import { CLI_USAGE } from './usage.js'

const repository = resolve(import.meta.dirname, '../../../..')
const scenario = process.env.FH2_TOOLING_USAGE_SCENARIO
const fixture = process.env.FH2_TOOLING_USAGE_FIXTURE
const closes: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})

async function workspace (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-usage-regression-'))
  closes.push(() => rm(root, { recursive: true, force: true }))
  if (fixture && ['web-ide', 'workflow-dag'].includes(scenario ?? '')) {
    await cp(fixture, root, { recursive: true })
  } else {
    await mkdir(join(root, 'workflows'))
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({
      pluginId: 'exp_usage',
      scripts: [{ name: 'example', path: 'adapters/example.ts', io: { inputs: [{ name: 'value', type: 'string', required: true }], outputs: [] } }],
    }))
  }
  return root
}

describe('exported developer usage', () => {
  it('exports complete topics with real repository-relative implementation/test sources', () => {
    expect(CLI_CONTRACT.knowledgeProfile).toBe(TOOLING_KNOWLEDGE_PROFILE)
    const topics = CLI_CONTRACT.commands.flatMap(command => (command.usage ?? []).map(usage => `${command.name}/${usage.id}`))
    expect(topics).toEqual(['dev/workbench', 'preview/http-preview', 'serve/web-ide', 'serve/workflow-dag'])
    for (const command of CLI_CONTRACT.commands) {
      for (const usage of command.usage ?? []) {
        for (const key of ['preconditions', 'steps', 'limits', 'sources'] as const) expect(usage[key].length).toBeGreaterThan(0)
        const prose = [usage.summary, ...usage.preconditions, ...usage.steps, ...usage.limits]
        for (const text of prose) expect(text).toMatch(/[\u4E00-\u9FFF]/)
        expect(prose.join('\n')).not.toMatch(/SaveCoordinator|markSaved|existsOnDisk|tabPaths|runSavePlan|runtime\.reload|Goja|\/api\/|serial lifecycle queue/)
        for (const source of usage.sources) {
          expect(source).toMatch(/^packages\/fh2-plugin-toolchain\//)
          expect(source).not.toMatch(/^(?:\/|[A-Z]:)|(?:^|\/)\.\.(?:\/|$)/)
          expect(existsSync(join(repository, source.split('#')[0]!)), source).toBe(true)
        }
      }
    }
    expect(JSON.stringify(CLI_CONTRACT.commands.flatMap(command => command.usage ?? [])))
      .not.toMatch(/\/Users\/|\/home\/|\b(?:10|192\.168)\.\d+\.|uranus-/)
  })

  it('projects current IDE/DAG save semantics without stale fixed-defect claims', () => {
    const guides = CLI_CONTRACT.commands.find(command => command.name === 'serve')?.usage ?? []
    expect(guides).toEqual(CLI_USAGE.serve?.map(guide => ({ ...guide, kind: 'manual-guide' as const })))
    expect(guides.map(guide => guide.id)).toEqual(['web-ide', 'workflow-dag'])

    const staleClaims = [
      '继续编辑再保存仍可能报 FH2_IDE_ALREADY_EXISTS',
      '出现在“失败”列表中',
      '后续被跳过的文件仍可能列为“失败”',
      '新文件再次保存也可能报“文件已存在”',
      '再次保存新文件冲突',
    ]
    for (const guide of guides) {
      const prose = [guide.summary, ...guide.preconditions, ...guide.steps, ...guide.limits].join('\n')
      for (const staleClaim of staleClaims) expect(prose, `${guide.id}: ${staleClaim}`).not.toContain(staleClaim)

      const newFile = guide.limits.find(limit => limit.includes('IDE_SAVE_NEW_FILE_STATE'))
      expect(newFile).toContain('继续编辑再保存走 write')
      expect(newFile).toContain('不应再次按 create 报 FH2_IDE_ALREADY_EXISTS')

      const taskBarrier = guide.limits.find(limit => limit.includes('IDE_SAVE_TASK_BARRIER'))
      expect(taskBarrier).toContain('不能保证新建文件和 DAG 草稿都已保存')
      expect(taskBarrier).toContain('检查器独占脚本漏存')

      const skipped = guide.limits.find(limit => limit.includes('IDE_SAVE_SKIPPED_RECEIPT'))
      expect(skipped).toContain('归入“未执行”（pending）')
      expect(skipped).toContain('不能当成“已经尝试写入但失败”')
      expect(prose).toContain('不要认为已经回滚')
    }
  })
})

describe.runIf(scenario === undefined || scenario === 'http-preview')('usage: restricted HTTP preview', () => {
  it('forwards only the selected local upstream, serves session assets, and rejects CONNECT', async () => {
    const root = await workspace()
    const dist = fixture ? join(fixture, 'dist') : join(root, 'dist')
    if (!fixture) {
      await mkdir(dist)
      await writeFile(join(dist, 'fh2-plugin.json'), '{"id":"exp_usage","entry":"./plugin.js"}')
      await writeFile(join(dist, 'plugin.js'), 'export default {}')
    }
    const manifest = JSON.parse(await readFile(join(dist, 'fh2-plugin.json'), 'utf8')) as { id: string; entry: string }
    const upstream = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ path: req.url, method: req.method }))
    })
    const origin = await listen(upstream)
    closes.push(() => closeServer(upstream))
    const proxy = await servePreviewHttpOriginProxy({ plugins: [{ pluginId: manifest.id, pluginsDir: dist }], targetOrigin: origin, port: 0 })
    closes.push(() => proxy.close())
    expect(proxy.sourceUrl).toMatch(new RegExp(`^${origin}/\\.fh2-plugin-preview/[a-f0-9]{32}/plugins$`))
    const pac = await (await fetch(proxy.pacUrl!)).text()
    const context = runInNewContext(`${pac}; ({ FindProxyForURL })`) as { FindProxyForURL: (url: string, host: string) => string }
    expect(context.FindProxyForURL(`${origin}/page`, '127.0.0.1')).toBe(`PROXY ${new URL(proxy.url).host}`)
    expect(context.FindProxyForURL('http://other.example.test/page', 'other.example.test')).toBe('DIRECT')
    expect(await proxyRequest(proxy.url, `${origin}/page`)).toMatchObject({ status: 200, body: '{"path":"/page","method":"GET"}' })
    expect(context.FindProxyForURL(`${origin.replace('http:', 'https:')}/page`, '127.0.0.1')).toBe('DIRECT')
    // The manually entered URL is the resource root, not an Entry or Manifest URL.
    const resourceRoot = new URL(`${proxy.sourceUrl}/`)
    expect(resourceRoot.search).toBe('')
    expect(resourceRoot.hash).toBe('')
    const metadata = await proxyRequest(proxy.url, new URL('__fh2_plugin_preview__.json', resourceRoot).href)
    expect(metadata.status).toBe(200)
    const plugin = JSON.parse(metadata.body).plugins[0] as { pluginId: string; manifestPath: string }
    expect(plugin.pluginId).toBe(manifest.id)
    const manifestUrl = new URL(plugin.manifestPath, resourceRoot)
    expect(manifestUrl.origin).toBe(origin)
    const servedManifest = await proxyRequest(proxy.url, manifestUrl.href)
    expect(servedManifest.status).toBe(200)
    expect(JSON.parse(servedManifest.body)).toEqual(manifest)
    const asset = await proxyRequest(proxy.url, new URL(manifest.entry, manifestUrl).href)
    expect(asset.status).toBe(200)
    expect(asset.body).toBe(await readFile(join(dist, manifest.entry), 'utf8'))
    expect((await proxyRequest(proxy.url, 'http://other.example.test/')).status).toBe(403)
    expect((await proxyRequest(proxy.url, origin, 'CONNECT')).status).toBe(405)
  })
})

describe.runIf(scenario === undefined || scenario === 'web-ide' || scenario === 'workflow-dag')('usage: IDE/DAG local APIs', () => {
  it('prechecks disk/catalog references without saving, then saves a real ordered plan with CAS', async () => {
    const root = await workspace()
    const webRoot = await mkdtemp(join(tmpdir(), 'fh2-usage-web-assets-'))
    closes.push(() => rm(webRoot, { recursive: true, force: true }))
    // Minimal HTTP page fixture, not a claim that packaged browser UI has been exercised.
    await writeFile(join(webRoot, 'index.html'), '<html><head></head><body>local API test</body></html>')
    const server = await startIdeServer({ root, webRoot, port: 0, watch: false })
    closes.push(() => server.close())
    const api = async (url: string, body?: unknown) => await fetch(`${server.url}${url}`, {
      headers: { 'x-fh2-ide-token': server.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    })
    expect((await fetch(`${server.url}/api/workspace`)).status).toBe(401)
    const actions = await resolveIdeActionsWithKnowledge({ root })
    expect(actions.catalogSource.kind).toBe('builtin-snapshot')
    if (actions.catalogSource.kind === 'builtin-snapshot') expect(actions.catalogSource.reason).toBeTruthy()
    const catalog = toCatalog(actions)
    const source = await readFile(join(root, 'fh2-plugin.json'), 'utf8')
    const flow = '{"name":"usage","trigger":{"api":{}},"steps":[]}'
    const prepared = prepareCreateScriptAndBind({
      workspaceEpoch: 1,
      manifest: { path: 'fh2-plugin.json', text: source, generation: 1 },
      workflow: { path: 'workflows/usage.json', text: flow, generation: 1 },
      catalog,
      scriptLanguage: actions.scriptLanguage,
    }, { name: 'usage_function', path: defaultScriptPath('usage-function', actions.scriptLanguage), stepId: 'usage_call' })
    if (!prepared.ok) throw new Error(prepared.reason)
    const script = prepared.command.edits.find(edit => edit.kind === 'create')!
    if (script.kind !== 'create') throw new Error('missing script creation')
    expect(script.content).toContain('throw new Error(\'TODO: implement business logic\')')
    const modified = (file: string, text: string): string => {
      const edit = prepared.command.edits.find(edit => edit.path === file)
      if (edit?.kind !== 'modify') throw new Error(`missing edit for ${file}`)
      return applyJsonEditOps(text, edit.ops)
    }
    const nextFlow = modified('workflows/usage.json', flow)
    const before = await (await api('/api/workflow/validate', { path: 'workflows/usage.json', workflow: JSON.parse(nextFlow) })).json()
    expect(before.ok).toBe(true)
    expect(before.data.ok).toBe(false) // Function not yet registered on disk; this endpoint is only a precheck.
    expect(await readFile(join(root, 'fh2-plugin.json'), 'utf8')).toBe(source)
    expect(existsSync(join(root, script.path))).toBe(false)
    const file = await (await api('/api/file?path=fh2-plugin.json')).json()
    const saved = await (await api('/api/save', { items: [
      { path: 'workflows/usage.json', kind: 'create', content: nextFlow },
      { path: 'fh2-plugin.json', kind: 'write', content: modified('fh2-plugin.json', source), expectedDiskHash: file.data.revision },
      { path: script.path, kind: 'create', content: script.content },
    ] })).json()
    expect(saved.data.ok).toBe(true)
    expect(saved.data.items.map((item: { path: string }) => item.path)).toEqual([script.path, 'fh2-plugin.json', 'workflows/usage.json'])
    const after = await (await api('/api/workflow/validate', { path: 'workflows/usage.json', workflow: JSON.parse(nextFlow) })).json()
    expect(after.data.ok).toBe(true) // Local reference completeness only; the TODO has not been executed.
    const conflict = await (await api('/api/save', { items: [
      { path: 'fh2-plugin.json', kind: 'write', content: source, expectedDiskHash: file.data.revision },
    ] })).json()
    expect(conflict.data).toMatchObject({ ok: false, partial: false, items: [{ errorCode: 'FH2_FILE_CONFLICT' }] })
  })
})

async function listen (server: Server): Promise<string> {
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing local test port')
  return `http://127.0.0.1:${address.port}`
}

async function closeServer (server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose())
    server.closeAllConnections()
  })
}

async function proxyRequest (proxy: string, target: string, method = 'GET'): Promise<{ status: number; body: string }> {
  const url = new URL(proxy)
  return await new Promise((resolveRequest, rejectRequest) => {
    const req = request({ hostname: url.hostname, port: url.port, path: target, method }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolveRequest({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }))
      res.on('error', rejectRequest)
    })
    req.on('connect', (res, socket) => {
      socket.destroy()
      resolveRequest({ status: res.statusCode!, body: '' })
    })
    req.on('error', rejectRequest)
    req.end()
  })
}
