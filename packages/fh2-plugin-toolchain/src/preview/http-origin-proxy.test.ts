// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProxyPac, servePreviewHttpOriginProxy } from './http-origin-proxy.js'

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

describe('preview HTTP origin proxy', () => {
  it('pac 只代理目标 HTTP Origin', () => {
    const pac = createProxyPac('http://fh2-preview.example.com', '127.0.0.1:4317')
    expect(pac).toContain('url.indexOf(origin + "/") === 0')
    expect(pac).toContain('PROXY 127.0.0.1:4317')
    expect(pac).toContain('return "DIRECT"')
  })

  it('线上请求透明转发，Preview 保留路径读取本地产物', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-preview-proxy-'))
    closers.push(() => rm(root, { recursive: true, force: true }))
    const dist = join(root, 'dist')
    await mkdir(dist)
    await writeFile(join(dist, 'fh2-plugin.json'), '{"id":"exp_proxy"}')
    await writeFile(join(dist, 'plugin.js'), 'export default {}')

    const upstream = createServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': req.url === '/page' ? 'text/html; charset=utf-8' : 'application/json',
          'x-upstream-method': req.method ?? '',
        })
        res.end(req.url === '/page' ? '<main>online</main>' : JSON.stringify({ body, path: req.url }))
      })
    })
    const targetOrigin = await listen(upstream)
    closers.push(() => closeServer(upstream))

    const proxy = await servePreviewHttpOriginProxy({
      plugins: [{ pluginId: 'exp_proxy', pluginsDir: dist }],
      targetOrigin,
      port: 0,
      sessionToken: '0123456789abcdef0123456789abcdef',
    })
    closers.push(() => proxy.close())

    expect(proxy.sourceUrl).toBe(
      `${targetOrigin}/.fh2-plugin-preview/0123456789abcdef0123456789abcdef/plugins`,
    )
    expect(proxy.pacUrl).toContain('?session=0123456789abcdef0123456789abcdef')
    const pac = await fetch(proxy.pacUrl!)
    expect(pac.status).toBe(200)
    expect(pac.headers.get('content-type')).toContain('application/x-ns-proxy-autoconfig')

    const page = await proxyRequest(proxy.url, `${targetOrigin}/page`, {
      headers: { 'sec-fetch-dest': 'document' },
    })
    expect(page.status).toBe(200)
    expect(page.body).toBe('<main>online</main>')
    expect(page.headers['cache-control']).toBe('no-store')

    const forwarded = await proxyRequest(proxy.url, `${targetOrigin}/api?x=1`, {
      method: 'POST',
      body: '{"ok":true}',
      headers: { 'content-type': 'application/json' },
    })
    expect(forwarded.status).toBe(200)
    expect(forwarded.headers['x-upstream-method']).toBe('POST')
    expect(JSON.parse(forwarded.body)).toEqual({ body: '{"ok":true}', path: '/api?x=1' })

    const metadata = await proxyRequest(
      proxy.url,
      `${proxy.sourceUrl}/__fh2_plugin_preview__.json`,
    )
    expect(metadata.status).toBe(200)
    expect(JSON.parse(metadata.body)).toEqual({
      schemaVersion: 1,
      plugins: [{
        pluginId: 'exp_proxy',
        manifestPath: './exp_proxy/fh2-plugin.json',
      }],
    })
    const manifest = await proxyRequest(proxy.url, `${proxy.sourceUrl}/exp_proxy/fh2-plugin.json`)
    expect(manifest.status).toBe(200)
    expect(manifest.body).toBe('{"id":"exp_proxy"}')
  })

  it('拒绝非目标 Origin 和 CONNECT', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-preview-proxy-deny-'))
    closers.push(() => rm(root, { recursive: true, force: true }))
    const dist = join(root, 'dist')
    await mkdir(dist)
    await writeFile(join(dist, 'fh2-plugin.json'), '{"id":"exp_proxy"}')
    const upstream = createServer((_req, res) => res.end('online'))
    const targetOrigin = await listen(upstream)
    closers.push(() => closeServer(upstream))
    const proxy = await servePreviewHttpOriginProxy({
      plugins: [{ pluginId: 'exp_proxy', pluginsDir: dist }],
      targetOrigin,
      port: 0,
      sessionToken: '0123456789abcdef0123456789abcdef',
    })
    closers.push(() => proxy.close())

    expect((await proxyRequest(proxy.url, 'http://evil.example/')).status).toBe(403)
    expect((await proxyRequest(proxy.url, targetOrigin, { method: 'CONNECT' })).status).toBe(405)
  })

  it('关闭代理时终止尚未结束的上游响应', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-preview-proxy-close-'))
    closers.push(() => rm(root, { recursive: true, force: true }))
    const dist = join(root, 'dist')
    await mkdir(dist)
    await writeFile(join(dist, 'fh2-plugin.json'), '{"id":"exp_proxy"}')
    let closeUpstream!: () => void
    let markUpstreamRequested!: () => void
    const upstreamClosed = new Promise<void>((resolveClosed) => {
      closeUpstream = resolveClosed
    })
    const upstreamRequested = new Promise<void>((resolveRequested) => {
      markUpstreamRequested = resolveRequested
    })
    const upstream = createServer((_req, res) => {
      markUpstreamRequested()
      res.once('close', closeUpstream)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: ready\n\n')
    })
    const targetOrigin = await listen(upstream)
    closers.push(() => closeServer(upstream))
    const proxy = await servePreviewHttpOriginProxy({
      plugins: [{ pluginId: 'exp_proxy', pluginsDir: dist }],
      targetOrigin,
      port: 0,
      sessionToken: '0123456789abcdef0123456789abcdef',
    })

    const pendingRequest = proxyRequest(proxy.url, `${targetOrigin}/events`).catch(() => undefined)
    await upstreamRequested
    await proxy.close()
    await upstreamClosed
    await pendingRequest
  })
})

function listen (server: Server): Promise<string> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('测试上游端口不可用')
      resolveListen(`http://127.0.0.1:${address.port}`)
    })
  })
}

function closeServer (server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close(error => error === undefined ? resolveClose() : rejectClose(error))
    server.closeAllConnections()
  })
}

function proxyRequest (
  proxyUrl: string,
  targetUrl: string,
  options: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  } = {},
): Promise<{ readonly status: number; readonly headers: IncomingHttpHeaders; readonly body: string }> {
  const proxy = new URL(proxyUrl)
  return new Promise((resolveRequest, rejectRequest) => {
    const req = request({
      hostname: proxy.hostname,
      port: proxy.port,
      method: options.method ?? 'GET',
      path: targetUrl,
      headers: options.headers,
    })
    req.once('connect', (res, socket) => {
      socket.destroy()
      resolveRequest({ status: res.statusCode ?? 0, headers: res.headers, body: '' })
    })
    req.once('response', (res) => {
      res.setEncoding('utf8')
      let body = ''
      res.on('data', (chunk) => {
        body += chunk
      })
      res.once('aborted', () => rejectRequest(new Error('响应已中止')))
      res.once('error', rejectRequest)
      res.on('end', () => resolveRequest({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.once('error', rejectRequest)
    req.end(options.body)
  })
}
