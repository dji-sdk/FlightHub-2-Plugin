// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as createRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKBENCH_SCOPE_PATH, resolveLoopbackServerAddress, serveStatic } from './static-server.js'
import type { DevStaticServer } from './static-server.js'

describe('dev static server', () => {
  const base = mkdtempSync(join(tmpdir(), 'fh2-dev-test-'))
  const shell = join(base, 'shell')
  const vue3 = join(base, 'vue3')
  const vue2 = join(base, 'vue2')
  const plugins = join(base, 'plugins')
  let server: DevStaticServer

  beforeAll(async () => {
    for (const directory of [shell, vue3, vue2, plugins]) mkdirSync(directory, { recursive: true })
    mkdirSync(join(shell, 'static/css'), { recursive: true })
    mkdirSync(join(shell, 'static/fonts'), { recursive: true })
    mkdirSync(join(vue3, 'static/js'), { recursive: true })
    writeFileSync(join(shell, 'index.html'), '<html><head></head><body>shell</body></html>')
    writeFileSync(join(shell, 'static/css/shell.css'), 'body{}')
    writeFileSync(join(shell, 'static/fonts/shell.woff2'), 'font')
    writeFileSync(join(vue3, 'container.html'), '<script defer src="./static/js/index.js"></script>')
    writeFileSync(join(vue3, 'static/js/index.js'), 'console.log("vue3")')
    writeFileSync(join(vue2, 'container.html'), '<h1>vue2</h1>')
    writeFileSync(join(plugins, 'fh2-plugin.json'), '{"id":"exp_test_dev"}')
    mkdirSync(join(plugins, 'hello-plugin/dist'), { recursive: true })
    writeFileSync(join(plugins, 'hello-plugin/dist/fh2-plugin.json'), '{"id":"exp_test_nested"}')
    writeFileSync(join(base, 'outside.txt'), 'outside')
    // Windows 文件 symlink 需要开发者模式/管理员（EPERM）；逃逸 fixture 仅在 POSIX 创建
    if (process.platform !== 'win32') symlinkSync(join(base, 'outside.txt'), join(plugins, 'outside-link.txt'))
    server = await serveStatic({
      shellDist: shell,
      vue3Dist: vue3,
      vue2Dist: vue2,
      pluginsDir: plugins,
      port: 0,
      watch: true,
    })
  })

  afterAll(async () => server?.close())

  it('只监听 loopback，并提供 Shell、子应用、插件和 MIME', async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(await (await fetch(`${server.url}${WORKBENCH_SCOPE_PATH}`)).text()).toContain('shell')
    expect((await fetch(`${server.url}/apps/mock-host-vue3/container.html`)).status).toBe(200)
    expect((await fetch(`${server.url}/apps/mock-host-vue2/container.html`)).status).toBe(200)
    expect(await (await fetch(`${server.url}/plugins/fh2-plugin.json`)).json()).toEqual({ id: 'exp_test_dev' })
    expect((await fetch(`${server.url}/static/css/shell.css`)).headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect((await fetch(`${server.url}/static/fonts/shell.woff2`)).headers.get('content-type')).toBe('font/woff2')
  })

  it.each(['GET', 'HEAD'])('favicon 存在于 Shell 时 %s 返回 200 和 ico MIME', async (method) => {
    const paths = createMinimalAssets(mkdtempSync(join(tmpdir(), 'fh2-dev-favicon-')))
    writeFileSync(join(paths.shellDist, 'favicon.ico'), 'favicon content')
    const faviconServer = await serveStatic({ ...paths, port: 0 })
    try {
      const response = await requestServer(`${faviconServer.url}/favicon.ico`, { method, headers: {}, body: '' })
      expect(response.status).toBe(200)
      expect(response.headers['content-type']).toBe('image/x-icon')
      expect(response.body).toBe(method === 'GET' ? 'favicon content' : '')
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    } finally {
      await faviconServer.close()
    }
  })

  it.each(['GET', 'HEAD'])('favicon 缺失时 %s 返回空 204', async (method) => {
    const response = await requestServer(`${server.url}/favicon.ico`, { method, headers: {}, body: '' })
    expect(response.status).toBe(204)
    expect(response.body).toBe('')
    expect(response.headers['content-type']).toBeUndefined()
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  // Windows 文件 symlink 需要开发者模式/管理员；本场景由 POSIX CI 覆盖
  it.skipIf(process.platform === 'win32')('favicon symlink 越界时返回空 204，不泄漏文件', async () => {
    const faviconBase = mkdtempSync(join(tmpdir(), 'fh2-dev-favicon-symlink-'))
    const paths = createMinimalAssets(faviconBase)
    const outside = join(faviconBase, 'outside.ico')
    writeFileSync(outside, 'outside favicon')
    symlinkSync(outside, join(paths.shellDist, 'favicon.ico'))
    const faviconServer = await serveStatic({ ...paths, port: 0 })
    try {
      const response = await fetch(`${faviconServer.url}/favicon.ico`)
      expect(response.status).toBe(204)
      expect(await response.text()).toBe('')
    } finally {
      await faviconServer.close()
    }
  })

  it('根路径 302 重定向到固定 scope 路径（保留 search）；scope 路径 history fallback 回 Shell index', async () => {
    const root = await requestServer(`${server.url}/?droneSn=MOCK-DRONE-009`, { method: 'GET', headers: {}, body: '' })
    expect(root.status).toBe(302)
    expect(root.headers.location).toBe(`${WORKBENCH_SCOPE_PATH}?droneSn=MOCK-DRONE-009#/team`)

    // 任意 org/project 组合都回 Shell index（hash 路由由前端处理）
    const scoped = await fetch(`${server.url}/organization/any-org/project/any-project#/cockpit`)
    expect(scoped.status).toBe(200)
    expect(await scoped.text()).toContain('shell')
    expect((await fetch(`${server.url}/organization/only`)).status).toBe(404)
    expect((await fetch(`${server.url}/organization/a/project/b/unknown-asset.js`)).status).toBe(404)
  })

  it('只给 /plugins 资源 CORS，并对全部插件 Manifest 与 Dev config 禁用缓存', async () => {
    const shellResponse = await fetch(`${server.url}/`)
    const pluginResponse = await fetch(`${server.url}/plugins/fh2-plugin.json`)
    const configResponse = await fetch(`${server.url}/__fh2_dev_config__`)
    const nestedManifest = await fetch(`${server.url}/plugins/hello-plugin/dist/fh2-plugin.json`)
    expect(shellResponse.headers.get('access-control-allow-origin')).toBeNull()
    expect(pluginResponse.headers.get('access-control-allow-origin')).toBe('*')
    expect(pluginResponse.headers.get('cache-control')).toBe('no-store')
    expect(nestedManifest.headers.get('cache-control')).toBe('no-store')
    expect(configResponse.headers.get('access-control-allow-origin')).toBeNull()
    expect(configResponse.headers.get('cache-control')).toBe('no-store')
    expect(await configResponse.json()).toEqual({ apiMode: 'mock', workbenchMode: 'all', backendMode: 'frontend' })
  })

  it('插件资源响应 Private Network Access 预检，非插件路径不开放', async () => {
    const headers = {
      origin: 'http://fh2-preview.example.com',
      'access-control-request-method': 'GET',
      'access-control-request-private-network': 'true',
    }
    const pluginPreflight = await requestServer(`${server.url}/plugins/hello-plugin/dist/fh2-plugin.json`, {
      method: 'OPTIONS',
      headers,
      body: '',
    })
    expect(pluginPreflight.status).toBe(204)
    expect(pluginPreflight.headers['access-control-allow-origin']).toBe('*')
    expect(pluginPreflight.headers['access-control-allow-private-network']).toBe('true')
    expect(pluginPreflight.headers.vary).toContain('Access-Control-Request-Private-Network')

    const shellPreflight = await requestServer(`${server.url}/`, { method: 'OPTIONS', headers, body: '' })
    expect(shellPreflight.headers['access-control-allow-private-network']).toBeUndefined()
  })

  it('向 Shell 下发 Cockpit Workbench profile', async () => {
    const cockpit = await serveStatic({
      shellDist: shell,
      vue3Dist: vue3,
      vue2Dist: vue2,
      pluginsDir: plugins,
      workbenchMode: 'cockpit',
      port: 0,
    })
    try {
      expect(await (await fetch(`${cockpit.url}/__fh2_dev_config__`)).json()).toEqual({
        apiMode: 'mock',
        workbenchMode: 'cockpit',
        backendMode: 'frontend',
      })
    } finally {
      await cockpit.close()
    }
  })

  it('为 Capability Dev 暴露多前端插件目录和 catalog', async () => {
    const alpha = join(base, 'capability-alpha')
    const beta = join(base, 'capability-beta')
    mkdirSync(alpha)
    mkdirSync(beta)
    writeFileSync(join(alpha, 'fh2-plugin.json'), '{"id":"exp_alpha"}')
    writeFileSync(join(beta, 'fh2-plugin.json'), '{"id":"exp_beta"}')
    const capability = await serveStatic({
      shellDist: shell,
      vue3Dist: vue3,
      vue2Dist: vue2,
      pluginsDir: [alpha, beta],
      pluginCatalog: [
        { pluginId: 'exp_alpha', root: alpha },
        { pluginId: 'exp_beta', root: beta },
      ],
      port: 0,
    })
    try {
      expect(await (await fetch(`${capability.url}/__fh2_plugin_catalog__`)).json()).toEqual({
        plugins: [
          { pluginId: 'exp_alpha', baseUrl: '/plugins/exp_alpha/' },
          { pluginId: 'exp_beta', baseUrl: '/plugins/exp_beta/' },
        ],
      })
      expect(await (await fetch(`${capability.url}/plugins/exp_alpha/fh2-plugin.json`)).json())
        .toEqual({ id: 'exp_alpha' })
      expect(await (await fetch(`${capability.url}/plugins/exp_beta/fh2-plugin.json`)).json())
        .toEqual({ id: 'exp_beta' })
      expect((await fetch(`${server.url}/__fh2_plugin_catalog__`)).headers.get('cache-control')).toBe('no-store')
    } finally {
      await capability.close()
    }
  })

  it('credentialed Gateway 路由要求精确 Host 和浏览器同源证据', async () => {
    const tokenPath = '/plugin-gateway/token/issue?svc=manage'
    const body = JSON.stringify({ login_token: 'mock-login-token' })
    const acceptedByOrigin = await fetch(`${server.url}${tokenPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body,
    })
    expect(acceptedByOrigin.status).toBe(200)

    const acceptedByFetchMetadata = await fetch(`${server.url}${tokenPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body,
    })
    expect(acceptedByFetchMetadata.status).toBe(200)

    for (const headers of [
      { 'content-type': 'application/json' },
      { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      { 'content-type': 'application/json', origin: server.url, 'sec-fetch-site': 'cross-site' },
      { 'content-type': 'application/json', host: 'localhost:5175', origin: server.url },
    ]) {
      const rejected = await requestServer(`${server.url}${tokenPath}`, { method: 'POST', headers, body })
      expect(rejected.status).toBe(403)
      expect(rejected.headers['access-control-allow-origin']).toBeUndefined()
      expect(JSON.parse(rejected.body)).toEqual({ code: 40300, msg: 'Forbidden', data: null })
    }

    const apiResponse = await fetch(`${server.url}/plugin-api/mock/hello/status`, {
      headers: {
        'sec-fetch-site': 'same-origin',
        'x-plugin-token': 'mock-plugin-token',
      },
    })
    expect(apiResponse.status).toBe(200)
  })

  it('拒绝编码错误、路径越界和 symlink 越界', async () => {
    expect((await fetch(`${server.url}/plugins/%E0%A4%A`)).status).toBe(400)
    expect((await fetch(`${server.url}/apps/mock-host-vue3/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404)
    expect((await fetch(`${server.url}/plugins/outside-link.txt`)).status).toBe(404)
    expect((await fetch(`${server.url}/unknown-thing`)).status).toBe(404)
  })

  it('根 Manifest 缺失时只对固定探测返回无缓存 204', async () => {
    const examples = join(base, 'examples')
    mkdirSync(examples)
    const fallback = await serveStatic({
      shellDist: shell,
      vue3Dist: vue3,
      vue2Dist: vue2,
      pluginsDir: examples,
      port: 0,
    })
    try {
      const response = await fetch(`${fallback.url}/plugins/fh2-plugin.json`)
      expect(response.status).toBe(204)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
    } finally {
      await fallback.close()
    }
  })

  it('watch 模式注入异步 hook 和固定 5 秒超时，no-watch 不注入且无 SSE', async () => {
    const html = await (await fetch(`${server.url}${WORKBENCH_SCOPE_PATH}`)).text()
    expect(html).toContain('__FH2_DEV_RELOAD__')
    expect(html).toContain('FH2_DEV_RELOAD_TIMEOUT')
    expect(html).toContain('5000')

    const noWatch = await serveStatic({
      shellDist: shell,
      vue3Dist: vue3,
      vue2Dist: vue2,
      pluginsDir: plugins,
      port: 0,
    })
    try {
      expect(await (await fetch(`${noWatch.url}${WORKBENCH_SCOPE_PATH}`)).text()).not.toContain('__FH2_DEV_RELOAD__')
      expect((await fetch(`${noWatch.url}/__live_reload__`)).status).toBe(404)
    } finally {
      await noWatch.close()
    }
  })

  it('sse 发送结构化 build event、去重且重连不重放', async () => {
    const first = await openSse(`${server.url}/__live_reload__`)
    server.publishBuildEvent({ schemaVersion: 1, type: 'reload', buildId: 2 })
    server.publishBuildEvent({ schemaVersion: 1, type: 'reload', buildId: 2 })
    server.publishBuildEvent({ schemaVersion: 1, type: 'error', buildId: 3, diagnosticCode: 'FH2_COMPILE' })
    server.publishBuildEvent({ schemaVersion: 1, type: 'error', buildId: 4, diagnosticCode: '/project/source secret' })
    const firstText = await readUntil(first.reader, text => text.includes('"buildId":4'))
    expect(firstText.match(/"buildId":2/g)).toHaveLength(1)
    expect(firstText).toContain('event: build')
    expect(firstText).toContain('"type":"error"')
    expect(firstText).toContain('FH2_COMPILE：插件构建失败，请查看终端诊断。')
    expect(firstText).toContain('FH2_BUILD_FAILED：插件构建失败，请查看终端诊断。')
    expect(firstText).not.toContain('compile failed')
    expect(firstText).not.toContain('/project/source')
    await first.reader.cancel()

    const second = await openSse(`${server.url}/__live_reload__`)
    server.publishBuildEvent({ schemaVersion: 1, type: 'reload', buildId: 5 })
    const secondText = await readUntil(second.reader, text => text.includes('"buildId":5'))
    expect(secondText).not.toContain('"buildId":2')
    expect(secondText).not.toContain('"buildId":3')
    expect(secondText).not.toContain('"buildId":4')
    await second.reader.cancel()
  })

  it('workbench 资源缺失时 preflight 硬失败', async () => {
    await expect(serveStatic({
      shellDist: join(base, 'missing-shell'),
      vue3Dist: vue3,
      vue2Dist: vue2,
      pluginsDir: plugins,
      port: 0,
    })).rejects.toThrow('Workbench 发布资源缺失')
  })

  it('端口冲突不接管其他进程', async () => {
    const port = Number(new URL(server.url).port)
    await expect(serveStatic({
      shellDist: shell,
      vue3Dist: vue3,
      vue2Dist: vue2,
      pluginsDir: plugins,
      port,
    })).rejects.toThrow(`端口 ${port} 被占用`)
  })
})

describe('dev static server close', () => {
  it('close 缓存同一 Promise，并结束 SSE', async () => {
    const base = mkdtempSync(join(tmpdir(), 'fh2-dev-close-'))
    const paths = createMinimalAssets(base)
    const server = await serveStatic({ ...paths, port: 0, watch: true })
    const connection = await openSse(`${server.url}/__live_reload__`)
    const first = server.close()
    const second = server.close()
    expect(first).toBe(second)
    await first
    let done = false
    while (!done) done = (await connection.reader.read()).done
    expect(done).toBe(true)
  })

  it('拒绝慢速 chunked Gateway request 后关闭连接，shutdown 也强制结束剩余连接', async () => {
    const base = mkdtempSync(join(tmpdir(), 'fh2-dev-rejected-close-'))
    const paths = createMinimalAssets(base)
    const server = await serveStatic({ ...paths, port: 0 })
    const rejected = openSlowServerRequest(`${server.url}/plugin-gateway/token/issue?svc=manage`, {
      origin: 'https://evil.example.com',
    })
    rejected.request.write('{"partial":')
    expect((await expectWithin(rejected.response.promise, 1_000, 'admission rejection response missing')).status).toBe(403)
    await expectWithin(rejected.closed.promise, 1_000, 'admission rejected connection remained open')

    const acceptedSlow = openSlowServerRequest(`${server.url}/plugin-gateway/token/issue?svc=manage`, {
      origin: server.url,
    })
    acceptedSlow.request.write('{"partial":')
    await new Promise(resolve => setTimeout(resolve, 10))
    await expectWithin(server.close(), 1_000, 'server.close hung on slow request body')
    await expectWithin(acceptedSlow.closed.promise, 1_000, 'server shutdown left HTTP connection open')
  })
})

describe('loopback server address', () => {
  it('通过 URL 语义统一默认端口的 origin 与 Host', () => {
    expect(resolveLoopbackServerAddress(80)).toEqual({
      host: '127.0.0.1',
      origin: 'http://127.0.0.1',
    })
    expect(resolveLoopbackServerAddress(5175)).toEqual({
      host: '127.0.0.1:5175',
      origin: 'http://127.0.0.1:5175',
    })
  })
})

function createMinimalAssets (base: string): {
  shellDist: string;
  vue3Dist: string;
  vue2Dist: string;
  pluginsDir: string;
} {
  const shellDist = join(base, 'shell')
  const vue3Dist = join(base, 'vue3')
  const vue2Dist = join(base, 'vue2')
  const pluginsDir = join(base, 'plugins')
  for (const directory of [shellDist, vue3Dist, vue2Dist, pluginsDir]) mkdirSync(directory, { recursive: true })
  writeFileSync(join(shellDist, 'index.html'), '<html><head></head></html>')
  writeFileSync(join(vue3Dist, 'container.html'), 'vue3')
  writeFileSync(join(vue2Dist, 'container.html'), 'vue2')
  return { shellDist, vue3Dist, vue2Dist, pluginsDir }
}

async function openSse (url: string): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const response = await fetch(url)
  expect(response.status).toBe(200)
  return { reader: response.body!.getReader() }
}

async function readUntil (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  for (let reads = 0; reads < 10; reads += 1) {
    const item = await reader.read()
    if (item.done) break
    text += decoder.decode(item.value, { stream: true })
    if (predicate(text)) return text
  }
  throw new Error(`未收到预期 SSE：${text}`)
}

async function requestServer (
  url: string,
  options: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body: string },
): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }> {
  return new Promise((resolveResponse, rejectResponse) => {
    const request = createRequest(url, { method: options.method, headers: options.headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.once('end', () => resolveResponse({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.once('error', rejectResponse)
    request.end(options.body)
  })
}

function openSlowServerRequest (url: string, headers: Readonly<Record<string, string>>): {
  readonly request: ReturnType<typeof createRequest>;
  readonly closed: ReturnType<typeof deferred<void>>;
  readonly response: ReturnType<typeof deferred<{ readonly status: number; readonly body: string }>>;
} {
  const closed = deferred<void>()
  const response = deferred<{ readonly status: number; readonly body: string }>()
  const request = createRequest(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
  }, (incoming) => {
    const chunks: Buffer[] = []
    incoming.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    incoming.once('end', () => response.resolve({
      status: incoming.statusCode ?? 0,
      body: Buffer.concat(chunks).toString('utf8'),
    }))
  })
  request.on('error', () => {})
  request.once('close', () => closed.resolve())
  return { request, closed, response }
}

async function expectWithin<T> (promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
  ])
}

function deferred<T> (): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}
